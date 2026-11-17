import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import { entity } from './infoplus.mjs';
import { permittedProbeRequest } from './live-options.mjs';
import { debugAvailability } from './debug-policy.mjs';

export const debugProbeFile = 'raw/debug-probe.json';
export const debugProbeVersion = 1;
const definitionApi = '/infoplus/internal/findWorkflowDefinition';
const identityPrompt = 'DEBUG with arbitrary user identity?';
const idPattern = /^[a-f0-9-]{36}$/i;

export function debugEntry(href, project) {
  if (!href || !idPattern.test(project.workflowDefinitionId ?? '')) return;
  const source = URL.parse(project.source);
  const url = source && URL.parse(href, source);
  if (!url || source.protocol !== 'https:' || url.origin !== source.origin || url.username || url.password || url.hash ||
      url.pathname !== `/infoplus/form/${project.workflowDefinitionId}/start`) return;
  const query = url.searchParams;
  if (query.getAll('release').length !== 1 || query.get('release') !== 'false' ||
      query.getAll('entrust').length !== 1 || query.get('entrust') !== 'true' || query.getAll('theme').length > 1 ||
      [...query.keys()].some(key => !['release', 'entrust', 'theme'].includes(key)) ||
      query.has('theme') && !/^[a-z0-9_-]+$/i.test(query.get('theme'))) return;
  return url;
}

export function debugBoundary(definition, project) {
  const xml = definition?.guiDefinition;
  if (definition?.success !== true || typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) {
    return { status: 'unverified', reason: '未取得可核对的当前工作流定义' };
  }
  let root;
  try { root = new DOMParser().parseFromString(xml, 'application/xml').documentElement; }
  catch { return { status: 'unverified', reason: '工作流定义无法解析' }; }
  if (root.tagName !== 'workflow' || !project.projectCode || root.getAttribute('code') !== project.projectCode) {
    return { status: 'unverified', reason: '工作流定义与目标项目不匹配' };
  }
  const events = Array.from(root.childNodes).find(node => node.nodeType === 1 && node.tagName === 'events');
  const enabled = Array.from(events?.childNodes ?? []).filter(node => node.nodeType === 1 && node.getAttribute('enabled') === 'true');
  const urls = enabled.map(node => [node.getAttribute('address')?.trim(), node.getAttribute('addressDev')?.trim()]);
  // A difference in URL or a test-like hostname is not evidence of isolated writes or notifications.
  const canonical = value => {
    const url = value && URL.parse(value);
    return url && ['http:', 'https:'].includes(url.protocol) ? url.origin + url.pathname.replace(/\/+$/, '') : value;
  };
  const sharedEndpoints = urls.filter(([prod, dev]) => prod && dev && canonical(prod) === canonical(dev)).length;
  const missingDebugEndpoints = urls.filter(([, dev]) => !dev).length;
  return {
    status: sharedEndpoints ? 'shared-callback' : 'unverified',
    reason: sharedEndpoints ? '启用的外部事件在测试和正式环境使用同一回调地址' :
      missingDebugEndpoints ? '启用的外部事件缺少测试回调配置' : '未取得数据、通知及外部服务的独立隔离证明',
    released: definition.released === true,
    callbacks: { enabled: enabled.length, sharedEndpoints, missingDebugEndpoints },
  };
}

async function readVersion(page, project) {
  const version = page.getByRole('link', { name: `V-${project.version}`, exact: true });
  await version.first().waitFor({ timeout: 8000 });
  const rows = page.locator('tr').filter({ has: version });
  if (await rows.count() !== 1) return;
  return rows.evaluate((row, { versionName, prompt }) => {
    const editor = [...row.querySelectorAll('a[href$="/editor"]')].find(a => a.textContent.trim() === versionName);
    const entry = [...row.querySelectorAll('a[data-confirm]')].filter(a => a.dataset.confirm === prompt);
    const labels = [...row.cells].map(cell => cell.innerText.trim());
    const status = labels.find(text => /^(?:可用|不可用|禁用)$/.test(text));
    const deployment = labels.includes('未部署') ? 'not-deployed'
      : labels.includes('已部署') ? 'ide-reports-deployed' : 'unverified';
    return { editor: editor?.href, href: entry.length === 1 ? entry[0].getAttribute('href') : undefined, status, deployment };
  }, { versionName: `V-${project.version}`, prompt: identityPrompt });
}

export async function resolveDebugLaunch(page, project) {
  const source=new URL(project.source);
  if(source.protocol!=='https:'||source.username||source.password||!/^\/infoplus\/ide\/project\/[\w-]+\/?$/.test(source.pathname))throw Error('IDE 项目地址不合法');
  await page.goto(source.href,{waitUntil:'domcontentloaded',timeout:Number(process.env.INFOPLUS_NAV_TIMEOUT||30000)});
  const landed=new URL(page.url());
  if(landed.origin!==source.origin||landed.pathname!==source.pathname)throw Error('未进入目标 IDE 项目');
  const row=await readVersion(page,project);
  const entry=debugEntry(row?.href,project);
  if(!entry||row.editor!==project.editor||row.deployment==='not-deployed')throw Error('未确认同版本非发布 Debug 入口');
  return entry;
}

async function loadDefinition(page, project) {
  const result = await page.evaluate(async ({ path, definitionId }) => {
    const url = new URL(path, location.origin);
    url.searchParams.set('workflowDefinitionId', definitionId);
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error',
      signal: AbortSignal.timeout(6500) });
    return response.ok ? response.json() : null;
  }, { path: definitionApi, definitionId: project.workflowDefinitionId });
  return entity(result);
}

async function probeEntry(context, entry) {
  const page = await context.newPage();
  try {
    const session = await context.newCDPSession(page);
    const top = (await session.send('Page.getFrameTree')).frameTree.frame.id;
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    await page.addInitScript(() => { window.open = () => null; });
    await page.routeWebSocket('**/*', socket => socket.close());
    let opened = false;
    let loginRedirect = false;
    session.on('Fetch.requestPaused', async ({ requestId, request, resourceType, frameId }) => {
      try {
        const url = new URL(request.url);
        const type = resourceType.toLowerCase();
        const document = type === 'document' && frameId === top;
        const initial = document && !opened && url.href === entry.href && request.method === 'GET';
        if (initial) opened = true;
        if (document && url.origin === entry.origin && /\/(?:login|authorize)\/?$/i.test(url.pathname)) loginRedirect = true;
        const asset = ['image', 'font', 'script', 'stylesheet'].includes(type) &&
          permittedProbeRequest(url, request.method, type, entry);
        if (initial || asset) return await session.send('Fetch.continueRequest', { requestId });
      } catch { /* deny when a request cannot be classified */ }
      await session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const response = await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 11000 }).catch(() => undefined);
    if (!response?.ok()) return { state: loginRedirect ? 'login-required' : 'unavailable', http: response?.status(), opened };
    await page.waitForFunction(() => {
      const text = document.body?.innerText ?? '';
      return document.querySelector('input[name="chooseEntrustee"]') ||
        /选择其它身份|选择其他身份|选择.*继续办理|not deployed|未部署|not enough permissions|无权限|服务器异常/i.test(text);
    }, null, { timeout: 6000 }).catch(() => {});
    const state = await page.evaluate(() => {
      const text = document.body?.innerText ?? '';
      if (/not deployed|未部署/i.test(text)) return 'not-deployed';
      if (/not enough permissions|无权限|权限不足/i.test(text)) return 'permission-denied';
      if (/服务器异常|服务不可用|service unavailable/i.test(text)) return 'unavailable';
      if (/Now you are going to debug this form as user|DEBUG with arbitrary user identity|正在调试模式/i.test(text)) return 'identity-ready';
      if (/本步支持委托办理/.test(text) && document.querySelector('input[name="chooseEntrustee"]')) return 'delegation-interstitial';
      return 'unverified';
    });
    return { state, http: response.status(), opened };
  } finally { await page.close(); }
}

export async function probeDebug(context, project, policy) {
  const report = { ...debugAvailability({ state: 'not-checked' }, policy), entry: { state: 'not-checked' }, deployment: 'unverified',
    boundary: { status: 'unverified' }, simulatedRoles: [], visitedNodes: [], verifiedPaths: [] };
  const source = URL.parse(project.source);
  const editor = URL.parse(project.editor);
  if (!source || source.protocol !== 'https:' || source.username || source.password ||
      !/^\/infoplus\/ide\/project\/[\w-]+\/?$/.test(source.pathname) ||
      editor?.origin !== source.origin || editor.pathname !== `/infoplus/ide/project/${project.workflowDefinitionId}/editor`) {
    return { ...report, reason: '缺少可核对的 IDE 项目或版本地址' };
  }
  const page = await context.newPage();
  try {
    await page.goto(source.href, { waitUntil: 'domcontentloaded', timeout: Number(process.env.INFOPLUS_NAV_TIMEOUT || 30000) });
    if (URL.parse(page.url())?.origin !== source.origin || URL.parse(page.url())?.pathname !== source.pathname) {
      if (/\/(?:login|authorize)\/?$/i.test(URL.parse(page.url())?.pathname ?? '')) {
        report.entry = { state: 'login-required' };
        Object.assign(report, debugAvailability(report.entry, policy));
      }
      return { ...report, reason: 'IDE 未返回目标项目' };
    }
    const row = await readVersion(page, project);
    if (row?.editor !== editor.href) return { ...report, reason: 'IDE 未返回与缓存匹配的版本' };
    report.ideVersionStatus = row.status;
    report.deployment = row.deployment;
    const definition = await loadDefinition(page, project).catch(() => undefined);
    report.boundary = debugBoundary(definition, project);
    const entry = debugEntry(row.href, project);
    if (!entry) return { ...report, reason: '未找到与该版本匹配的非发布 Debug 入口' };
    report.entry = await probeEntry(context, entry);
    report.entry.ideDebugEntry = true;
    if (report.entry.state === 'not-deployed') report.deployment = 'not-deployed';
    Object.assign(report, debugAvailability(report.entry, policy));
    report.reason = ['identity-ready', 'delegation-interstitial'].includes(report.entry.state) ? report.reason : ({
      'not-deployed': 'IDE 提示当前版本未部署', 'permission-denied': 'IDE 拒绝当前操作人的调试权限',
      'login-required': 'Debug 入口要求重新认证', 'unavailable': 'Debug 页面未能打开',
    })[report.entry.state] ?? '打开入口后未观察到身份选择窗口';
    return report;
  } catch {
    return { ...report, reason: '专用 Chrome 未能在时限内核对目标版本或 Debug 页面' };
  } finally { await page.close(); }
}

export async function saveDebugProbe(directory, project, result) {
  const path = join(directory, debugProbeFile);
  const tmp = `${path}.${randomUUID()}.tmp`;
  await mkdir(join(directory, 'raw'), { recursive: true });
  await writeFile(tmp, JSON.stringify({ format: debugProbeVersion, code: project.code, version: project.version,
    definitionId: project.workflowDefinitionId, checkedAt: new Date().toISOString(), ...result }, null, 2) + '\n', { flag: 'wx' });
  await rename(tmp, path);
}

export async function readDebugProbe(directory, project) {
  try {
    const value = JSON.parse(await readFile(join(directory, debugProbeFile), 'utf8'));
    if (value.format === debugProbeVersion && value.code === project.code && value.version === project.version &&
        value.definitionId === project.workflowDefinitionId) return value;
  } catch (error) {
    if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}
