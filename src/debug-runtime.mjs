import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readDebugStep, requireDebugAuthorization, submitDebugAction } from './debug-session.mjs';
import { loadDebugPolicy, assertCallbacksAllowed } from './debug-policy.mjs';
import { readDebugProbe } from './debug-probe.mjs';
import { requireDebugPage, verifyDebugInstance } from './debug-verification.mjs';

export const debugRuntimeFile = 'raw/debug-runs.json';
export const debugRuntimeVersion = 1;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const idPattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;

export async function readDebugRuns(directory, project) {
  let data;
  try { data = JSON.parse(await readFile(join(directory, debugRuntimeFile), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (data.version !== project.version || data.definitionId !== project.workflowDefinitionId || data.code !== project.code ||
      !Array.isArray(data.runs) || data.runs.some(run => !idPattern.test(run.instanceId))) throw new Error('Debug 运行证据与当前版本不匹配');
  return data;
}

export async function appendDebugEvent(directory, project, instanceId, event) {
  if (!idPattern.test(instanceId)) throw new Error('无效的调试实例编号');
  const data = await readDebugRuns(directory, project) ?? { schemaVersion: debugRuntimeVersion, code: project.code,
    version: project.version, definitionId: project.workflowDefinitionId, runs: [] };
  let run = data.runs.find(run => run.instanceId === instanceId);
  if (!run) data.runs.push(run = { instanceId, origin: 'automatic-debug', events: [] });
  if (run.origin !== 'automatic-debug') throw new Error('不能将自动观察写入手动实例');
  run.events.push({ at: new Date().toISOString(), ...event });
  await mkdir(join(directory, 'raw'), { recursive: true });
  const path = join(directory, debugRuntimeFile), temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2));
  await rename(temp, path);
  return event;
}

export function memberScopeDescription(settings = {}) {
  const filter = settings.userFilters;
  if (!filter) return '未取得明确的候选范围配置，不能据此认定可选择任意人员。';
  if (filter === '*:FACULTY') return '配置教职工筛选及通配前缀；跨单位候选边界尚未实测，不能据此前缀认定全校可选。';
  if (filter === ':FACULTY') return '配置教职工筛选，组织前缀为空；尚不能确定是否按申请人或当前办理人的单位限制。';
  return '配置了特定角色或组织过滤；具体候选范围及空结果处理需结合当前阶段验证。';
}

export function safeMemberFilters(params) {
  let settings = {};
  try { settings = JSON.parse(params.get('settings') || '{}'); } catch { /* Keep malformed evidence unexpanded. */ }
  return Object.fromEntries(['userFilters','userTraversal'].flatMap(key => {
    const value = params.get(key) ?? settings?.[key];
    return typeof value === 'boolean' || typeof value === 'string' && /^[A-Za-z_*:,. -]{0,150}$/.test(value)
      ? [[key,value]] : [];
  }));
}

export async function captureDebugStep(page, directory, project, instanceId, role) {
  const state = await readDebugStep(page, project, instanceId);
  requireDebugPage(state);
  const detail = await page.evaluate(() => {
    const f = window.$$?.entity;
    const visible = e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    return Object.values(f.fields ?? {}).filter(field => field.bound).map(field => {
      const controls = [...document.querySelectorAll('[name]')].filter(e =>
        e.name === field.name || e.name === 'radioList-' + field.name || e.name?.startsWith(field.name + '_'));
      const display = controls.map(e => e.closest('.infoplus_labelControlContainer, .infoplus_fileControl') ?? e);
      const active = display.filter(visible);
      const displayOnly = active.length > 0 && active.every(e => e.classList.contains('infoplus_labelControlContainer'));
      const settings = field.settings && Object.fromEntries(Object.entries(field.settings)
        .filter(([k, v]) => ['userFilters', 'userTraversal'].includes(k) && ['string', 'boolean'].includes(typeof v)));
      return { id: field.name, name: field.label || field.description || field.name, type: field.type,
        required: field.notNull === true, permission: field.permission, visible: active.length > 0,
        readOnly: displayOnly || (field.permission ? !field.permission.includes('w') : null),
        displayOnly,
        fieldChanging: field.fieldChanging === true, group: field.groupName, repeatDepth: field.repeatDepth,
        settings, validation: field.regEx, validationMessage: field.prompt,
        // Existing instance values are never interpreted as default values.
        defaultValue: field.type !== 'User' && field.type !== 'Organize' && typeof field.initialValue === 'string' &&
          /^[-\d.]{1,4}$/.test(field.initialValue) ? field.initialValue : undefined };
    });
  });
  const event = { kind: 'stage', state, role: role || state.name.trim(), source: '后台 Debug 实际观察',
    fields: detail, memberScopes: detail.filter(f => f.type === 'User').map(f => ({
      fieldId: f.id, fieldName: f.name, settings: f.settings,
      description: memberScopeDescription(f.settings), source: 'runtime-field-configuration', verifiedCandidates: false,
    })) };
  const imagePath = `views/${state.viewId}/debug-${state.flowStepId}.png`;
  try {
    // Mask personal field values, identity banners, and instance history; preserve labels and layout.
    const masks = page.locator('input, textarea, select, .select2-selection__rendered, .infoplus_labelControlContainer, .infoplus_labelControl, #command_holder, .commandBar_helper, [id*=entrust], [id*=history], [id*=History], [id*=user], [id*=User], .form_remark_title, .color_b2');
    await page.screenshot({ path: join(directory, imagePath), fullPage: true, mask: [masks], maskColor: '#dce3eb', timeout: 12000 });
    event.screenshot = imagePath;
    event.screenshotNote = '后台 Debug 完整页面截图，字段值及身份信息已遮盖';
    event.keyScreenshots = [];
    for (const field of detail.filter(f => f.visible && (f.settings?.userFilters || f.fieldChanging)).slice(0, 6)) {
      if (!/^[\w]+$/.test(field.id)) continue;
      const control = page.locator(`[name="${field.id}"], [name^="${field.id}_"], [name="radioList-${field.id}"]`).filter({ visible: true }).first();
      if (!await control.count()) continue;
      const row = control.locator('xpath=ancestor::tr[1]');
      if (!await row.count()) continue;
      const folder = `debug-evidence/${state.nodeId}`;
      await mkdir(join(directory, folder), { recursive: true });
      const file = `${folder}/${state.flowStepId}-${field.id}.png`;
      try {
        await row.screenshot({ path: join(directory,file), mask:[masks], maskColor:'#dce3eb', timeout:4000 });
        event.keyScreenshots.push({ file, fieldId:field.id, nodeId:state.nodeId, instanceId,
          at:new Date().toISOString(), condition:'本次页面观测条件，未进行独立因果验证', note:'真实字段所在行截图；字段值已遮盖' });
      } catch { /* Full-page evidence remains available when a local capture cannot be obtained. */ }
    }
  } catch { event.screenshotIssue = '完整截图未成功，保留原有 XSN 阶段图，不将静态图标为实测'; }
  await appendDebugEvent(directory, project, instanceId, event);
  return event;
}

export async function debugTaskLinks(page, project, instanceId) {
  await readDebugStep(page, project, instanceId);
  return page.evaluate(() => [...document.querySelectorAll('a[href]')].flatMap(a => {
    const raw = a.getAttribute('href');
    if (!raw || raw.startsWith('#')) return [];
    const url = new URL(raw, location.href);
    const match = /^\/infoplus\/form\/(\d+)\/render\/?$/.exec(url.pathname);
    if (!match || url.origin !== location.origin || url.hash || url.searchParams.has('snapshot') ||
        url.searchParams.get('entrust') !== 'true' || !a.innerText.trim()) return [];
    return [{ step: Number(match[1]), name: a.innerText.trim(), url: url.href }];
  }));
}

export async function chooseDebugIdentity(page, { preferCandidate = true, waitForStep = true, allowCurrentLoginInterstitial = false } = {}) {
  // Only call after a same-instance task link has been verified by resumeDebugTask.
  const choice = await page.evaluate(({ prefer, allowCurrentLoginInterstitial }) => {
    const ds = [...document.querySelectorAll('.dialog')].filter(d => d.getClientRects().length &&
      d.querySelector('input[name="chooseEntrustee"]'));
    if (ds.length !== 1) return null;
    const text = ds[0].innerText;
    // V1.2：兼容平台中文 DEBUG 身份窗口（当前调试人 / 指定账号 / 切换输入 / 继续办理此业务）
    const explicit = /Now you are going to debug this form as user|DEBUG with arbitrary user identity|正在调试模式|您当前正在以.{0,80}身份进行调试办理|指定账号|切换输入|请点击继续办理此业务/i.test(text);
    if (!explicit && !(allowCurrentLoginInterstitial && !prefer && /本步支持委托办理/.test(text))) return null;
    const radios = [...ds[0].querySelectorAll('input[name="chooseEntrustee"]')];
    const candidate = prefer && radios.length > 2 ? radios[2] : radios[0];
    candidate?.click();
    return { dialog: ds[0].id, debugIdentityPrompt: explicit, candidateCount: Math.max(0, radios.length - 2),
      choice: prefer && radios.length > 2 ? 'platform-task-candidate' : 'current-login' };
  }, { prefer: preferCandidate, allowCurrentLoginInterstitial });
  if (!choice) return { switched: false, reason: '未出现平台身份选择窗口' };
  const clicked = await page.evaluate(id => {
    const d = document.getElementById(id);
    const buttons = [...d.querySelectorAll('button')].filter(e => /^(继续|切换|Continue|Switch)$/.test(e.innerText.trim()));
    if (buttons.length !== 1) return false;
    buttons[0].click(); return true;
  }, choice.dialog);
  if (clicked && waitForStep) await page.waitForFunction(() => !!window.$$?.entity?.step, undefined, { polling: 100, timeout: 15000 });
  return { ...choice, switched: clicked };
}

export async function resumeDebugTask(page, directory, project, { instanceId, scope, step }) {
  requireDebugAuthorization(project, scope);
  const before = await readDebugStep(page, project, instanceId);
  await verifyDebugInstance(page, project, before);
  const tasks = await debugTaskLinks(page, project, instanceId);
  const target = tasks.filter(t => t.step === Number(step));
  if (target.length !== 1) throw new Error('目标步骤未出现在当前实例的实际待办链接中');
  await page.goto(target[0].url, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await page.waitForFunction(() => !!document.querySelector('input[name="chooseEntrustee"]') || !!window.$$?.entity?.step,
    undefined, { polling: 100, timeout: 15000 });
  const identity = await chooseDebugIdentity(page);
  const after = await readDebugStep(page, project, instanceId);
  if (after.flowStepId !== target[0].step) throw new Error('身份切换后步骤与选定待办不一致');
  const modeEvidence = await verifyDebugInstance(page, project, after, { writable: after.executable });
  await appendDebugEvent(directory, project, instanceId, { kind: 'resume', before, after,
    modeEvidence,
    identity: { choice: identity.choice, candidateCount: identity.candidateCount, switched: identity.switched },
    permissionVerified: after.executable, role: target[0].name });
  return { state: after, identity, tasks: await debugTaskLinks(page, project, instanceId) };
}

export async function actDebugStep(page, directory, project, options) {
  const policy = loadDebugPolicy();
  if (!policy.allowExistingWorkflowCallbacks) {
    const probe = await readDebugProbe(directory, project);
    assertCallbacksAllowed(policy, probe?.boundary);
  }
  if (options.resumeConfirmation) {
    const data = await readDebugRuns(directory, project);
    const previous = data?.runs.find(r => r.instanceId === options.instanceId)?.events.filter(e => e.kind === 'action').at(-1);
    const current = await readDebugStep(page, project, options.instanceId);
    if (!previous || previous.submitted || previous.before.flowStepId !== current.flowStepId || previous.action.label !== options.label) {
      throw new Error('没有可恢复的同一步骤未发送办理确认');
    }
  }
  await captureDebugStep(page, directory, project, options.instanceId, options.role);
  const result = await submitDebugAction(page, project, options);
  await appendDebugEvent(directory, project, options.instanceId, { kind: 'action', ...result,
    success: result.submitted && result.http === 200 && result.errno === 0 });
  // Only refresh after the server has acknowledged a successful action, never to discard pending input.
  if (result.submitted && result.http === 200 && result.errno === 0) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForFunction(() => !!document.querySelector('input[name="chooseEntrustee"]') || !!window.$$?.entity?.step,
      undefined, { polling: 100, timeout: 15000 });
    await chooseDebugIdentity(page, { preferCandidate: false, allowCurrentLoginInterstitial: true });
    const after = await readDebugStep(page, project, options.instanceId);
    requireDebugPage(after);
    await pause(1200); // The history/progress read completes after the form render.
    const tasks = await debugTaskLinks(page, project, options.instanceId);
    await appendDebugEvent(directory, project, options.instanceId, { kind: 'after-action', before: result.before,
      action: result.action, after, tasks, completed: after.status === 2 });
    return { ...result, after, tasks };
  }
  return result;
}

export async function chooseDebugMember(page, directory, project, { scope, instanceId, fieldId }) {
  requireDebugAuthorization(project, scope);
  const state = await readDebugStep(page, project, instanceId);
  if (!/^[\w]+$/.test(fieldId)) throw new Error('成员选择需要已识别字段');
  await verifyDebugInstance(page, project, state, { writable: true });
  const requests = [];
  const listen = response => {
    const u = URL.parse(response.url());
    if (u?.origin !== new URL(project.source).origin || !/\/suggest$/.test(u.pathname)) return;
    const request = response.request();
    const params = new URLSearchParams(request.postData() || u.search);
    requests.push({ endpoint: u.pathname, http: response.status(), parameterNames: [...params.keys()],
      filters: safeMemberFilters(params) });
  };
  page.on('response', listen);
  try {
    const opened = await page.evaluate(fieldId => {
      const field = window.$$?.entity?.fields?.[fieldId];
      if (field?.type !== 'User' || !field.permission?.includes('w')) return false;
      const candidates = [...document.querySelectorAll('select')].filter(e => e.getClientRects().length &&
        (e.name === fieldId || e.name.startsWith(fieldId + '_')) && !e.disabled);
      if (candidates.length !== 1) return false;
      window.jQuery(candidates[0]).select2('open');return true;
    }, fieldId);
    if (!opened) throw new Error('未找到唯一可写成员控件');
    await pause(300);
    await page.evaluate(() => {
      const message = document.querySelector('.select2-results')?.innerText ?? '';
      const input = document.querySelector('.select2-container--open input.select2-search__field');
      if (input && /请输入/.test(message)) { input.value = '1'; window.jQuery(input).trigger('input'); }
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.select2-results__option')].some(e =>
      e.getAttribute('aria-selected') !== null && e.getAttribute('aria-disabled') !== 'true'), undefined, { polling: 100, timeout: 10000 });
    const selected = await page.evaluate(() => {
      const items = [...document.querySelectorAll('.select2-results__option')].filter(e =>
        e.getAttribute('aria-selected') !== null && e.getAttribute('aria-disabled') !== 'true');
      if (!items.length) return { count: 0, selected: false };
      window.jQuery(items[0]).trigger('mouseup');
      return { count: items.length, selected: true };
    });
    await pause(500);
    await appendDebugEvent(directory, project, instanceId, { kind: 'member-choice', state, fieldId,
      ...selected, requests, policy: '平台当前候选列表中的首个可选身份，仅用于授权 Debug 角色模拟；不导出人员名单',
      completeness: 'observed-page-only' });
    return { fieldId, ...selected, requests };
  } finally { page.off('response', listen); }
}

export function runtimeSummary(data) {
  const runs = data?.runs?.filter(r => r.origin === 'automatic-debug') ?? [];
  const stages = runs.flatMap(run => run.events.filter(e => e.kind === 'stage').map(e => ({ ...e, instanceId: run.instanceId })));
  const completed = runs.flatMap(run => run.events.filter(e => e.kind === 'after-action' && e.completed));
  return { instances: runs.length, observedNodes: [...new Set(stages.map(e => e.state.nodeId))],
    modeEvidence: runs.flatMap(run => run.events.flatMap(e => e.modeEvidence ? [e.modeEvidence] : [])),
    completedNodes: [...new Set(completed.map(e => e.before.nodeId))],
    roles: [...new Set(stages.filter(e => e.state.executable).map(e => e.role))],
    actions: runs.flatMap(run => run.events.filter(e => e.kind === 'action' && e.success).map(e => ({
      instanceId: run.instanceId, nodeId: e.before.nodeId, name: e.before.name, action: e.action.label }))),
    // No automatic claim of end-to-end coverage from an empty task list or an HTTP success alone.
    verifiedPaths: runs.flatMap(run => run.verifiedPaths ?? []), stages };
}
