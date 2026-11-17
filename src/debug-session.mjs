const stepPath = /^\/infoplus\/form\/(\d+)\/render\/?$/;
const instancePattern = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const actionPath = '/infoplus/interface/doAction';
import { assertOrdinaryDebugAction } from './debug-policy.mjs';
import { requireDebugPage, verifyDebugInstance } from './debug-verification.mjs';

import { classifyDialog } from './dialog-classification.mjs';
export function ordinaryConfirmation(text, action) {
 return ['information', 'submission-confirmation'].includes(classifyDialog(text, action));
}

export function redactDebugText(text) {
  return String(text ?? '').replace(/https?:\/\/[^\s,]+/g,'（服务地址已脱敏）').replace(/[\w.+-]+@[\w.-]+/g, '（邮箱已脱敏）')
    .replace(/\b\d{5,}\b/g, '（编号已脱敏）');
}

export function requireDebugAuthorization(project, scope) {
  const expected = `${project.code}@${project.version}`;
  if (!scope || scope !== expected) throw new Error('需要本次用户授权的流程编号和版本');
}

export function matchesDebugAction(request, origin, step, action) {
  const url = URL.parse(request.url);
  if (!url || url.origin !== origin || url.pathname !== actionPath || url.search || request.method !== 'POST') return false;
  const body = new URLSearchParams(request.body);
  return body.getAll('stepId').length === 1 && body.get('stepId') === String(step) &&
    body.getAll('actionId').length === 1 && body.get('actionId') === String(action);
}

export async function readDebugStep(page, project, instanceId) {
  const url = URL.parse(page.url());
  const origin = new URL(project.source).origin;
  const path = url && stepPath.exec(url.pathname);
  if (!path || url.origin !== origin || !instancePattern.test(instanceId ?? '')) throw new Error('目标不是已登记的 Debug 页面');
  const state = await page.evaluate(() => {
    const form = window.$$?.entity;
    const step = form?.step;
    const debugCommand = document.querySelector('#FormCommandDebug');
    const debugMarker = Boolean(debugCommand?.getClientRects().length &&
      /正在调试模式|debug mode/i.test(debugCommand.textContent));
    const user = form?.userId;
    const actionAccount = form?.data?._VAR_ACTION_ACCOUNT;
    const executionCodes = form?.data?._VAR_EXECUTE_USERCODES;
    const delegatedMatch = !step?.assignUser && !step?.users?.length &&
      typeof actionAccount === 'string' && actionAccount.length > 0 && executionCodes === actionAccount &&
      form?.permission?.executable === true;
    const identityMatched = typeof user === 'string' && user.length > 0 &&
      (step?.assignUser === user || (!step?.assignUser && Array.isArray(step?.users) && step.users.includes(user)) || delegatedMatch);
    return {
      definitionId: step?.definitionId, instanceId: step?.instanceId, release: step?.entryRelease,
      entryId: step?.entryId, debugMarker, identityMatched,
      flowStepId: step?.flowStepId, nodeId: step?.stepId, name: step?.name, status: step?.status, entryStatus: step?.entryStatus,
      executable: form?.permission?.executable === true, viewId: form?.viewId,
      actions: (form?.actions ?? []).filter(action => action.visible !== false).map(action => ({
        id: action.id, label: action.name, remarkRequired: action.remarkRequired === true,
      })),
    };
  });
  if (state.release !== false || state.definitionId !== project.workflowDefinitionId || state.instanceId !== instanceId ||
      String(state.flowStepId) !== path[1]) throw new Error('页面未证实为授权版本和实例的非发布步骤');
  return state;
}

export async function submitDebugAction(page, project, { scope, instanceId, label, resumeConfirmation = false }) {
  requireDebugAuthorization(project, scope);
  assertOrdinaryDebugAction(label);
  const state = await readDebugStep(page, project, instanceId);
  const modeEvidence = await verifyDebugInstance(page, project, state, { writable: true });
  const current = await readDebugStep(page, project, instanceId);
  requireDebugPage(current, { writable: true });
  if (current.flowStepId !== state.flowStepId || current.entryId !== state.entryId) throw new Error('核对 DEBUG 后页面步骤已变化');
  const actions = state.actions.filter(action => action.label === label);
  if (!state.executable || state.status !== 1 || actions.length !== 1 || !Number.isSafeInteger(actions[0].id)) {
    throw new Error('当前模拟身份无权限，或办理动作不唯一');
  }
  const action = actions[0];
  const origin = new URL(project.source).origin;
  const responses = [];
  const responseTasks = [];
  const confirmations = [];
  const seenDialogs = new Set();
  const onDialog = async dialog => {
    const accepted = ['alert', 'confirm'].includes(dialog.type()) && ordinaryConfirmation(dialog.message(), label);
    confirmations.push({ type: dialog.type(), trigger: label, text: redactDebugText(dialog.message()), classification: classifyDialog(dialog.message(), label), accepted });
    await (accepted ? dialog.accept() : dialog.dismiss()).catch(() => {});
  };
  let submitted = false;
  let rejected = false;
  const routePath = `**${actionPath}`;
  const guard = async route => {
    const request = route.request();
    if (submitted || !matchesDebugAction({ url: request.url(), method: request.method(), body: request.postData() },
      origin, state.flowStepId, action.id)) {
      rejected = true;
      return route.abort();
    }
    submitted = true;
    return route.continue();
  };
  const listen = response => {
    const url = URL.parse(response.url());
    if (url?.origin !== origin || !['/infoplus/interface/listNextStepsUsers', actionPath].includes(url.pathname)) return;
    const record = { endpoint: url.pathname, http: response.status() };
    responses.push(record);
    responseTasks.push(response.json().then(payload => {
      record.errno = payload.errno;
      if (payload.error) record.error = redactDebugText(payload.error);
      if (url.pathname.endsWith('listNextStepsUsers') && payload.errno === 0) {
        record.nextTasks = (payload.entities ?? []).map(task => ({ nodeId: task.stepId, name: task.name,
          parallel: task.parallel, release: task.entryRelease, candidateCount: task.users?.length,
          instantNotification: task.hasInstantNotification, carbonNotification: task.hasCarbonNotification }));
      }
    }).catch(() => {}));
  };
  await page.route(routePath, guard);
  page.on('response', listen);
  page.on('dialog', onDialog);
  try {
    const pending = page.waitForResponse(response => matchesDebugAction({ url: response.url(),
      method: response.request().method(), body: response.request().postData() }, origin, state.flowStepId, action.id),
      { timeout: Number(process.env.INFOPLUS_ACTION_WAIT_TIMEOUT || 95000) }).catch(() => undefined);
    const clicked = resumeConfirmation || await page.evaluate(({ id, label }) => {
      const visible = element => element.getClientRects().length && getComputedStyle(element).visibility === 'visible' &&
        !element.closest('[aria-disabled=true]');
      const candidates = [...document.querySelectorAll('a[name^="infoplus_action_"]')]
        .filter(element => element.getAttribute('name').endsWith(`_${id}`) && element.innerText.trim() === label && visible(element));
      if (candidates.length !== 1) return false;
      candidates[0].click();
      return true;
    }, action);
    if (!clicked) throw new Error('未找到唯一的可见办理按钮');
    // InfoPlus can open a page-level confirmation before issuing doAction.
    // Keep the exact-step request guard active throughout that confirmation.
    const deadline = Date.now() + 15000;
    while (!submitted && Date.now() < deadline) {
      const dialogs = await page.evaluate(() => [...document.querySelectorAll('.dialog, [role="dialog"]')]
        .filter(e => e.getClientRects().length).map(e => ({ id: e.id, text: e.innerText,
          buttons: [...e.querySelectorAll('a,button,input[type=button]')].map(b => b.innerText?.trim() || b.value) }))).catch(() => []);
      let handled = false;
      for (const dialog of dialogs) {
        const key = dialog.id + dialog.text;
        if (seenDialogs.has(key)) continue;
        if (!ordinaryConfirmation(dialog.text, label)) {
 confirmations.push({ type: 'page', trigger: label, text: redactDebugText(dialog.text), classification: classifyDialog(dialog.text, label), accepted: false });
 seenDialogs.add(key); continue;
}
        seenDialogs.add(key);
        const clickedConfirmation = await page.evaluate(({ text }) => {
          const ds = [...document.querySelectorAll('.dialog, [role="dialog"]')]
            .filter(e => e.getClientRects().length && e.innerText === text);
          if (ds.length !== 1) return false;
          const buttons = [...ds[0].querySelectorAll('a,button,input[type=button]')]
            .filter(e => /^(确定|确认|是|好|OK|Yes|Continue)$/i.test(e.innerText?.trim() || e.value));
          if (buttons.length !== 1) return false;
          buttons[0].click(); return true;
        }, dialog);
        confirmations.push({ type: 'page', trigger: label, text: redactDebugText(dialog.text), accepted: clickedConfirmation });
        handled ||= clickedConfirmation;
      }
      if (dialogs.length && !handled) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const response = await pending;
    const payload = await response?.json().catch(() => undefined);
    await Promise.allSettled(responseTasks);
    return { before: state, modeEvidence, action, submitted, rejected, http: response?.status(), errno: payload?.errno,
      nextRender: stepPath.exec(URL.parse(page.url())?.pathname ?? '')?.[1], responses, confirmations };
  } finally {
    page.off('response', listen);
    page.off('dialog', onDialog);
    await page.unroute(routePath, guard);
  }
}

