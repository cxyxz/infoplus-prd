import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFieldIndex, parseViews } from './infoplus.mjs';

const kinds = [
  [/\/findWorkflowDefinition$/i, 'workflow'],
  [/\/findFormTemplate$/i, 'form'],
  [/\/ide\/project\/[^/]+\/fields$/i, 'fields'],
  [/\/views$/i, 'views'],
  [/\/ide\/interface\/template\/[^/]+\/json$/i, 'form'],
  [/\/ide\/interface\/template\/[^/]+\/xsn$/i, 'xsn'],
];
const secretKey = /^(?:cookie|cookies|set-cookie|authorization|authentication|credentials?|secret|client[-_]?secret|password|api[-_]?key|(?:access|refresh|session|csrf|xsrf|auth|id)?[-_]?token|(?:js)?sessionid|samlresponse|headers)$/i;
export const matchKind = path => kinds.find(([pattern]) => pattern.test(path))?.[1];

export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) =>
    [key, secretKey.test(key) ? '[已清除]' : redact(child)]));
}

export async function importHar(input, destination, project) {
  const parsed = JSON.parse((await readFile(input, 'utf8')).replace(/^\uFEFF/, ''));
  if (!Array.isArray(parsed.log?.entries)) throw new Error('HAR 缺少 log.entries');
  return importHarEntries(parsed.log.entries, destination, project);
}

export async function importHarEntries(entries, destination, project) {
  const expectedOrigin = new URL(project.source).origin;
  const indexPath = join(destination, 'raw', 'network', 'index.json');
  const captured = await readFile(indexPath, 'utf8')
    .then(text => JSON.parse(text).captured)
    .catch(error => { if (error.code !== 'ENOENT') throw error; return []; });
  const missingBodies = new Set();
  const forms = new Set((project.views ?? []).map(view => view.id));
  const raw = join(destination, 'raw', 'network');
  await mkdir(raw, { recursive: true });
  for (const entry of entries) {
    const url = new URL(entry.request.url);
    if (url.origin !== expectedOrigin || entry.response.status < 200 || entry.response.status >= 300) continue;
    const kind = matchKind(url.pathname);
    if (!kind) continue;
    const templateId = url.searchParams.get('templateId') ?? url.pathname.match(/\/template\/([^/]+)/i)?.[1];
    const workflowId = url.searchParams.get('workflowDefinitionId') ??
      (['fields', 'views'].includes(kind) ? url.pathname.match(/\/project\/([^/]+)\/(?:fields|views)$/)?.[1] : undefined);
    if (['workflow', 'views', 'fields'].includes(kind) && !workflowId) continue;
    if (workflowId && workflowId !== project.workflowDefinitionId) continue;
    if (templateId && forms.size && !forms.has(templateId)) continue;
    const content = entry.response.content ?? {};
    if (!content.text) {
      missingBodies.add(kind);
      continue;
    }
    const bytes = Buffer.from(content.text, content.encoding === 'base64' ? 'base64' : 'utf8');
    if (bytes.length > 32000000) {
      missingBodies.add(kind);
      continue;
    }
    let body;
    let extension;
    if (kind === 'xsn' && bytes.toString('ascii', 0, 4) === 'MSCF') {
      body = bytes;
      extension = 'xsn';
    } else if (kind === 'fields') {
      const fields = parseFieldIndex(bytes.toString('utf8'), expectedOrigin, forms);
      if (!fields.length) { missingBodies.add(kind); continue; }
      body = JSON.stringify({ fields }, null, 2);
      extension = 'json';
    } else if (kind === 'views') {
      const views = parseViews(bytes.toString('utf8'), expectedOrigin, workflowId);
      if (!views.length) {
        missingBodies.add(kind);
        continue;
      }
      body = JSON.stringify({ views }, null, 2);
      extension = 'json';
    } else {
      try {
        body = JSON.stringify(redact(JSON.parse(bytes.toString('utf8'))), null, 2);
        extension = 'json';
      } catch {
        missingBodies.add(kind);
        continue;
      }
    }
    const hash = createHash('sha256').update(body).digest('hex');
    const file = `${kind}-${hash.slice(0, 20)}.${extension}`;
    const resource = { kind, source: url.origin + url.pathname, method: entry.request.method, workflowId, templateId, hash, file };
    if (captured.some(item => item.file === file && item.source === resource.source &&
        item.templateId === templateId && item.workflowId === workflowId)) continue;
    await writeFile(join(raw, file), body);
    captured.push(resource);
  }
  const manifest = { captured, missingBodies: [...missingBodies] };
  await writeFile(indexPath, JSON.stringify(manifest, null, 2));
  return manifest;
}
