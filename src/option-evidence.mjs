import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isChoiceField, mergeOptions } from './field-options.mjs';

export const optionEvidence = 'raw/field-option-observations.json';
export const reviewedOptionEvidence = 'field-options-reviewed.json';
const fieldIdPattern = /^[\w.-]{1,128}$/u;
const endpoint = /^\/infoplus\/(?:[\w-]+\/)*suggest\/?$/i;
const fieldKeys = ['fieldName', 'field', 'fieldId', 'column', 'binding'];
const viewKeys = ['viewId', 'formViewId', 'templateId', 'formTemplateId'];
export const isSuggest = url => endpoint.test(url.pathname);

function parameters(request) {
  const params = Object.fromEntries(new URL(request.url).searchParams);
  const post = request.postData;
  if (!post?.text || post.text.length > 32768) return params;
  try {
    const type = post.mimeType?.split(';')[0].trim();
    const body = type === 'application/x-www-form-urlencoded' ? Object.fromEntries(new URLSearchParams(post.text)) :
      type === 'application/json' ? JSON.parse(post.text) : {};
    return { ...params, ...Object.fromEntries(Object.entries(body ?? {}).filter(([, v]) =>
      typeof v === 'string' || typeof v === 'number')) };
  } catch { return params; }
}

function validOptions(options, allowUnknownValue = false) {
  return Array.isArray(options) && options.length <= 500 && options.every(option => option &&
    (allowUnknownValue && option.value === null || ['string', 'number'].includes(typeof option.value)) &&
    typeof option.label === 'string' &&
    String(option.value).length <= 128 && option.label.trim().length > 0 && option.label.length <= 200 &&
    !/[\r\n\x00-\x1f]/.test(String(option.value) + option.label));
}

function suggestData(content) {
  if (!content?.text || content.text.length > 2000000) return;
  let data;
  try {
    const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
    data = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch { return; }
  if (data?.errno != null && ![0, '0'].includes(data.errno) || data?.success === false) return;
  const envelope = data?.entities?.length === 1 ? data.entities[0] : undefined;
  const [shape, rows] = [
    ['array', data], ['entities', data?.entities], ['items', data?.items], ['data', data?.data],
    ['data.items', data?.data?.items], ['entities[0].items', envelope?.items],
    ['entities[0].rows', envelope?.rows], ['entities[0].data', envelope?.data],
  ].find(([, items]) => Array.isArray(items) && items.length &&
    items.every(row => row?.codeId != null && row?.codeName != null)) ?? [];
  if (!rows || rows.length > 500) return;
  const options = rows.map(row => ({ value: row.codeId, label: row.codeName }));
  if (!validOptions(options)) return;
  const total = [data?.total, data?.data?.total, envelope?.total].find(value =>
    Number.isSafeInteger(value) && value >= rows.length);
  return { options: mergeOptions(options), shape, total };
}

export function parseSuggestResponse(content) {
  return suggestData(content)?.options;
}

async function optional(path) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function readFieldIndex(directory, network) {
  const item = network?.captured?.findLast(row => row.kind === 'fields');
  if (!item || basename(item.file) !== item.file) return { fields: [] };
  const source = `raw/network/${item.file}`;
  const data = await optional(join(directory, source));
  return { source, fields: (data?.fields ?? []).map(row => ({ ...row, source })) };
}

export async function readOptionEvidence(directory, project) {
  const results = [];
  for (const file of [optionEvidence, reviewedOptionEvidence]) {
    const data = await optional(join(directory, file));
    if (data?.definitionId !== project.workflowDefinitionId || data?.version !== project.version ||
        !Array.isArray(data?.observations)) continue;
    data.observations.forEach((item, index) => {
      if (!fieldIdPattern.test(item.fieldId) ||
          (item.options && !validOptions(item.options, file === reviewedOptionEvidence))) return;
      results.push({ ...item, file, source: `${file}#/observations/${index}` });
    });
  }
  return results;
}

export async function saveOptionEvidence(directory, project, observations) {
  if (!observations.length) return { added: 0 };
  const file = join(directory, optionEvidence);
  const previous = await optional(file);
  const matching = previous?.definitionId === project.workflowDefinitionId && previous?.version === project.version;
  const kept = matching ? previous.observations : [];
  const unique = new Map(kept.map(item => [JSON.stringify(item), item]));
  for (const item of observations) unique.set(JSON.stringify(item), item);
  const added = unique.size - kept.length;
  if (added) {
    await mkdir(join(directory, 'raw'), { recursive: true });
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temp, JSON.stringify({
        definitionId: project.workflowDefinitionId, version: project.version, observations: [...unique.values()],
      }, null, 2), { flag: 'wx' });
      await rename(temp, file);
    } finally { await rm(temp, { force: true }); }
  }
  return { added };
}

export function matchSuggest(entry, project, fields, interaction, pageBelongsToProject = false) {
  const url = new URL(entry.request.url);
  if (url.origin !== new URL(project.source).origin || !isSuggest(url) ||
      !['GET', 'POST'].includes(entry.request.method) || entry.response.status < 200 || entry.response.status >= 300) return;
  const params = parameters(entry.request);
  if (params.workflowDefinitionId && params.workflowDefinitionId !== project.workflowDefinitionId) return;
  const explicit = fieldKeys.map(key => params[key]).filter(value => typeof value === 'string');
  const field = fields.find(item => explicit.includes(item.id) || (item.uuid && explicit.includes(item.uuid)));
  if (explicit.length && !field || field && interaction && field.id !== interaction.fieldId) return;
  const fieldId = field?.id ?? interaction?.fieldId;
  if (!fieldId || !fields.some(item => item.id === fieldId)) return;
  const response = suggestData(entry.response.content);
  if (!response) return;
  const { options, shape, total } = response;
  // Responses lacking a binding must also match the choices rendered by the clicked control.
  if (!field && !options.every(option => interaction?.labels.includes(option.label))) return;
  const views = new Set((project.views ?? []).map(view => view.id));
  const viewParams = viewKeys.map(key => params[key]).filter(value => typeof value === 'string' && value);
  const candidates = viewParams.filter(value => views.has(value));
  const verified = params.workflowDefinitionId === project.workflowDefinitionId || !!field?.uuid && explicit.includes(field.uuid);
  if (!interaction && !pageBelongsToProject && !candidates.length &&
      !verified) return;
  if (viewParams.length && !candidates.length) return;
  const viewId = interaction?.viewId ?? candidates[0];
  if (interaction?.viewId && candidates.some(value => value !== interaction.viewId)) return;
  const names = Object.keys(params).filter(key => /^[\w.-]{1,64}$/u.test(key) &&
    !/token|auth|session|cookie|password|secret/i.test(key)).sort();
  const query = ['q', 'term', 'keyword', 'query', 'search', 'prefix'].some(key => String(params[key] ?? '').trim());
  const table = ['codeTableId', 'tableName', 'codeTable', 'dictionary', ...(params.type === 'Code' ? ['code'] : [])]
    .map(key => params[key])
    .find(value => typeof value === 'string' && fieldIdPattern.test(value));
  return {
    fieldId, viewId, when: interaction?.when ?? [], options, kind: 'suggest',
    versionVerified: verified || !!interaction?.versionVerified,
    completeness: 'partial',
    request: { source: url.origin + url.pathname, method: entry.request.method, parameterNames: names,
      table, searchFiltered: query, responseShape: shape, total },
  };
}

export async function importOptionHar(file, directory, project, bundle) {
  const data = await optional(file);
  if (!Array.isArray(data?.log?.entries)) throw new Error('HAR 缺少 log.entries');
  const network = await optional(join(directory, 'raw', 'network', 'index.json'));
  const index = await readFieldIndex(directory, network);
  const fields = [
    ...index.fields.filter(row => !['User', 'Organize'].includes(row.type) && (row.type === 'Code' || isChoiceField(row))),
    ...(bundle?.fields ?? []).filter(field => isChoiceField(field) && !['User', 'Organize'].includes(field.apiType)),
  ];
  const entries = data.log.entries.filter(item => isSuggest(new URL(item.request.url)));
  const projectPageRefs = new Set((data.log.pages ?? []).filter(page =>
    typeof page.title === 'string' && page.title.toLowerCase().split(/[^a-z0-9_]+/).includes(project.code.toLowerCase()))
    .map(page => page.id));
  const observations = entries.map(entry => matchSuggest(entry, project, fields, undefined, projectPageRefs.has(entry.pageref)))
    .filter(Boolean);
  return { seen: entries.length, matched: observations.length, ...await saveOptionEvidence(directory, project, observations) };
}
