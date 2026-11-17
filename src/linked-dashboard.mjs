import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { findCachedProject } from './project-input.mjs';
import { saveWorkflowInput } from './workflow-inputs.mjs';

const dashboard = '/dashboard/flow/index';
const monitor = '/dashboard/flow/im';
const query = '/dashboard/api/processes/query';
const fieldId = /^field\w+$/;

export function selectDashboardRecord(rows, criteria) {
  const matches = rows.filter(row => row.status === '已完成' && /^\d+$/.test(row.serial) &&
    (!criteria.serial || row.serial === criteria.serial) &&
    row.path === `/infoplus/form/e${row.serial}/render`);
  return matches.length === 1 ? { status: 'matched', row: matches[0] } :
    { status: matches.length ? 'ambiguous' : 'not-found' };
}

export function checkLinkedDetail(detail, predecessor, criteria, serial) {
  if (!detail || String(detail.serial) !== serial || detail.definitionId !== predecessor.workflowDefinitionId ||
      detail.release !== true || detail.status !== 4 || detail.account !== criteria.applicantAccount) return false;
  return typeof detail.value === 'string' && detail.value.trim() !== '' && detail.value !== serial;
}

export async function discoverDashboardValue(context, predecessor, criteria) {
  const origin = URL.parse(predecessor?.source ?? '')?.origin;
  if (!origin?.startsWith('https://') || !predecessor.workflowDefinitionId || !predecessor.projectCode ||
      criteria?.predecessorCode !== predecessor.code || !fieldId.test(criteria.fieldId ?? '') ||
      !fieldId.test(criteria.applicantFieldId ?? '') || typeof criteria.applicantAccount !== 'string' ||
      !criteria.applicantAccount.trim() || (criteria.serial !== undefined && !/^\d+$/.test(criteria.serial))) {
    return { status: 'needs-context' };
  }
  let detailPath;
  let phase = '打开办事中心';
  const page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      const asset = ['script', 'stylesheet', 'image', 'font'].includes(request.resourceType());
      const readable = url.pathname === query ||
        (detailPath && url.pathname === '/infoplus/interface/render');
      const document = [dashboard, monitor, detailPath].includes(url.pathname);
      if (url.origin === origin && (readable && ['GET','POST'].includes(request.method()) ||
          request.method() === 'GET' && (asset || document))) return route.continue();
      return route.abort();
    });
    await page.goto(origin + dashboard + '#im', { waitUntil: 'domcontentloaded', timeout: 15000 });
    phase = '读取已完成记录查询结果';
    const listed = await page.evaluate(async ({ route, keyword, app }) => {
      const url = new URL(route, location.origin);
      url.search = new URLSearchParams({ keyword, app, timestamps: '', milestones: '', statuses: 'done',
        draft: 'false', timestampStart: '', timestampEnd: '' }).toString();
      const result = await fetch(url, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(12000) });
      if (!result.ok) return null;
      const parsed = await result.json();
      if (!Array.isArray(parsed.data) || parsed.error) return null;
      const rows = parsed.data.flatMap(record => {
        const uri = URL.parse(record.uri, location.origin);
        if (record.app?.code !== app || record.status !== 'done' || uri?.origin !== location.origin || uri.search || uri.hash) return [];
        return [{ serial: String(record.entry), status: '已完成', path: uri.pathname }];
      });
      return { rows, complete: Number(parsed.recordsFiltered) === parsed.data.length };
    }, { route: query, keyword: criteria.serial ?? criteria.applicantAccount, app: predecessor.projectCode });
    if (!listed) return { status: 'query-unavailable' };
    if (!listed.complete && !criteria.serial) return { status: 'ambiguous' };
    const rows = listed.rows;
    const selected = selectDashboardRecord(rows, criteria);
    if (selected.status !== 'matched') return selected;
    detailPath = selected.row.path;
    phase = '读取原申请详情';
    const open = context.pages().find(candidate => candidate !== page && candidate.url() === origin + detailPath);
    const detailPage = open ?? page;
    if (!open) await page.goto(origin + detailPath, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (detailPage.url() !== origin + detailPath) return { status: 'detail-unavailable' };
    await detailPage.waitForFunction(() => Boolean(window.$$?.entity?.step && window.$$?.entity?.data), null, { timeout: 12000 });
    const detail = await detailPage.evaluate(({ field, account }) => {
      const form = window.$$?.entity, step = form?.step, data = form?.data;
      return { serial: step?.entryId, definitionId: step?.definitionId, release: step?.entryRelease,
        status: step?.entryStatus, account: data?.[account], value: form?.fields?.[field]?.bound ? data?.[field] : undefined };
    }, { field: criteria.fieldId, account: criteria.applicantFieldId });
    if (!checkLinkedDetail(detail, predecessor, criteria, selected.row.serial)) return { status: 'detail-mismatch' };
    return { status: 'found', value: detail.value, evidence: { source: '办事中心已完成历史申请详情',
      predecessorCode: predecessor.code, definitionId: detail.definitionId, serial: selected.row.serial,
      fieldId: criteria.fieldId, applicantFieldId: criteria.applicantFieldId, applicantMatched: true, verifiedAt: new Date().toISOString() } };
  } catch {
    return { status: 'unavailable', reason: `${phase}未完成` };
  } finally {
    await page.close();
  }
}

export function linkedFieldCandidates(bundle) {
  const candidates = new Map();
  for (const field of bundle.fields ?? []) {
    if (field.id && /团组编号|原申请编号|关联.*(?:流水号|编号)|前置.*编号|合同编号/.test(field.name ?? '')) {
      candidates.set(field.id, { fieldId: field.id, name: field.name, evidence: '字段名称提示，关联关系待核实' });
    }
  }
  return [...candidates.values()];
}
export async function recoverLinkedInput(context, project, configuredInputs) {
  if (!/^Z\d+$/.test(project.code)) return;
  let criteria;
  try { criteria = JSON.parse(await readFile(new URL(`../config/workflow-inputs/${project.code}-linked.json`, import.meta.url), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (configuredInputs.some(item => item.fieldId === criteria.targetFieldId)) return;
  if (criteria.targetVersion !== project.version || criteria.targetDefinitionId !== project.workflowDefinitionId ||
      !/^Z\d+$/.test(criteria.predecessorCode ?? '') || criteria.predecessorCode === project.code) return { status: 'needs-context' };
  const cache = await findCachedProject(criteria.predecessorCode);
  if (!cache) return { status: 'predecessor-unavailable' };
  const predecessor = JSON.parse(await readFile(join(cache, 'project.json'), 'utf8'));
  if (URL.parse(project.source)?.origin !== URL.parse(predecessor.source)?.origin) return { status: 'needs-context' };
  const result = await discoverDashboardValue(context, predecessor, criteria);
  if (result.status !== 'found') return result;
  const item = linkedTestInput(criteria, result);
  await saveWorkflowInput(project, item);
  return { status: 'found', item };
}

export function linkedTestInput(criteria, result) {
  return {
    fieldId: criteria.targetFieldId, fieldName: criteria.targetFieldName, nodeIds: criteria.nodeIds,
    value: result.value, source: '关联流程', validationStatus: '待验证',
    requiredApplicant: { account: criteria.applicantAccount, fieldId: criteria.targetApplicantFieldId },
    upstreamWorkflow: criteria.predecessorCode, predecessorSerial: result.evidence.serial, evidence: result.evidence,
  };
}
