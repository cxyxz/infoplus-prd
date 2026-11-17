import { bindProgress, reconcileProgress } from '../src/debug-progress.mjs';
/**
 * InfoPlus PRD Skill V1.2 — 通用 Debug 逐节点完整走查循环
 *
 * 固化循环：进入节点 → 识别身份 → 采集全部字段 → 采集全部按钮 → 分析业务条件
 *          → 填写测试数据 → 处理校验 → 提交 → 核对真实待办与流转 → 保存证据 → 进入下一节点
 *
 * 每步真实流转后立即写 flow-progress.json，支持中断后从当前节点继续执行。
 * 不含任何流程硬编码；动作选择依据 Workflow 连线 + 通用正向/负向语义。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { scanFormState, captureNodeBundle } from '../src/form-autofill.mjs';
import { chooseDebugIdentity } from '../src/debug-runtime.mjs';
import { parseWorkflowMermaid, buildButtonMap } from '../src/node-button-map.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['dir', 'instance', 'scope', 'workflow', 'evidence']) {
  if (!args[k]) { console.error(`MISSING --${k}`); process.exit(2); }
}
const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repairScript = path.join(toolRoot, 'scripts', 'v12-repair-and-submit.mjs');
const maxSteps = Number(args['max-steps'] || 25);
const evidenceDir = args.evidence;
fs.mkdirSync(evidenceDir, { recursive: true });
const write = (name, data) => fs.writeFileSync(path.join(evidenceDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf-8');

const parsed = parseWorkflowMermaid(fs.readFileSync(args.workflow, 'utf-8'));
const nodeName = id => parsed.nodes.find(n => n.nodeId === Number(id))?.name || `节点${id}`;

// 正向动作优先（正常办理路径）；负向动作（退回/终止/重选/特殊转办）不在正常路径中自动点击
const NEGATIVE = /退回|重新选择|终止|撤销|否决|不通过|拒绝|return|reject|kill|select again|terminate|cancel/i;
const POSITIVE = [/报销已完成/, /提交并打印/, /申请人提交并打印/, /审核通过/, /^提交\/Submit$/, /^重新提交\/Submit again$/, /^确定$/, /^继续$/];
function chooseAction(actions) {
  const candidates = (actions || []).filter(a => a.visible !== false && !NEGATIVE.test(a.name || ''));
  for (const re of POSITIVE) {
    const hit = candidates.find(a => re.test(a.name || ''));
    if (hit) return hit;
  }
  return candidates[0] || null;
}

const progressPath = path.join(evidenceDir, 'flow-progress.json');
let progress = fs.existsSync(progressPath) ? JSON.parse(fs.readFileSync(progressPath, 'utf-8')) : { trace: [], visited: [] };
progress = bindProgress(progress, args.instance);

const CDP = process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/';
let browser = null;
const connect = async () => {
  if (!browser) browser = await chromium.connectOverCDP(CDP, { timeout: 25000 });
  return browser.contexts()[0];
};
const release = async () => { if (browser) { await browser.close().catch(() => {}); browser = null; } };
const findPage = async ctx => {
  for (const p of ctx.pages()) {
    if (!/one\.zju\.edu\.cn\/infoplus\/form\/\d+\/render/.test(p.url())) continue;
    const hit = await p.evaluate(iid => window.$$?.entity?.step?.instanceId === iid, args.instance).catch(() => false);
    if (hit) return p;
  }
  return null;
};

for (let step = 1; step <= maxSteps; step++) {
  const ctx = await connect();
  const page = await findPage(ctx);
  if (!page) {
    write('flow-blocked.json', { reason: 'instance-page-not-found', at: step, progress });
    console.log('BLOCKED: 未找到当前实例页面'); break;
  }
  await page.bringToFront().catch(() => {});
  let state = await scanFormState(page);
  reconcileProgress(progress, state.step);

  // V1.2 断点恢复：当前步骤已完成(status=2)时，动作其实已成功；按真实待办链接切到下一节点，绝不重复提交。
  if (state.step?.status === 2) {
    const tasks = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => {
      const href = a.getAttribute('href');
      const m = href && href.match(/\/infoplus\/form\/(\d+)\/render/);
      if (!m || !href.includes('entrust=true')) return null;
      return { step: Number(m[1]), name: a.innerText.replace(/\s+/g, ' ').trim(), url: new URL(href, location.href).href };
    }).filter(Boolean));
    write('pending-tasks.json', tasks);
    if (tasks.length) {
      const target = tasks[0];
      console.log('ADVANCE to pending task', target.name, target.step);
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: Number(process.env.INFOPLUS_NAV_TIMEOUT || 30000) });
      await page.waitForFunction(() => !!document.querySelector('input[name=chooseEntrustee]') || !!window.$$?.entity?.step,
        undefined, { polling: 100, timeout: 20000 }).catch(() => {});
      const identity = await chooseDebugIdentity(page, { preferCandidate: true, allowCurrentLoginInterstitial: true });
      await page.waitForFunction(() => !!window.$$?.entity?.step, undefined, { polling: 100, timeout: 20000 }).catch(() => {});
      progress.identitySwitches ||= [];
      progress.identitySwitches.push({ from: state.step?.name, to: target.name, identity, at: new Date().toISOString() });
      state = await scanFormState(page);
      write('flow-progress.json', progress);
    }
  }
  const nodeId = state.step?.stepId;
  const nodeNameCur = state.step?.name || '';

  // 结束判定：完成节点 / 状态已完成 / 无可办理动作
  if (!nodeId || state.step?.status === 2 || /完成|Finished|Completed/i.test(nodeNameCur)) {
    progress.awaitingVerification = { nodeId, name: nodeNameCur, status: state.step?.status, reason:'步骤完成或缺少待办不证明实例结束', at: new Date().toISOString() };
    write('flow-progress.json', progress);
    console.log('FINISHED', JSON.stringify(progress.awaitingVerification)); break;
  }
  // 断点恢复：若停在上次最后访问的同一节点，回退该未完成记录后继续，不视为死循环
  const lastVisited = progress.visited.at(-1);
  if (nodeId === lastVisited && progress.trace.at(-1)?.nodeId === nodeId) {
    // Preserve prior observations when resuming; never discard the interrupted evidence.
    progress.resumed = { nodeId, name: nodeNameCur, at: new Date().toISOString() };
    console.log('RESUME from', nodeId, nodeNameCur);
  } else if (progress.visited.includes(nodeId)) {
    write('flow-blocked.json', { reason: 'revisited-node', nodeId, name: nodeNameCur, trace: progress.trace });
    console.log('BLOCKED: 重复进入节点，避免死循环', nodeId, nodeNameCur); break;
  }

  const action = chooseAction(state.entityActions);
  if (!action) {
    write('flow-blocked.json', { reason: 'no-positive-action', nodeId, name: nodeNameCur, actions: state.entityActions });
    console.log('BLOCKED: 未找到可执行正向动作', nodeNameCur, state.entityActions); break;
  }

  // 节点级完整采集（进入时状态：字段/按钮/整页截图）
  const slug = `s${String(step).padStart(2, '0')}-node${nodeId}-${nodeNameCur.replace(/[^\w\u4e00-\u9fa5]/g, '')}`;
  const nodeDir = path.join(evidenceDir, slug);
  const bundle = await captureNodeBundle(page, nodeDir, slug);
  const prev = progress.trace.at(-1);
  const fieldDiff = prev?.fields ? {
    added: state.fields.filter(f => !prev.fields.some(x => x.id === f.id)).map(f => ({ id: f.id, label: f.label, type: f.type })),
    permissionChanged: state.fields.filter(f => prev.fields.some(x => x.id === f.id && x.permission !== f.permission))
      .map(f => ({ id: f.id, label: f.label, from: prev.fields.find(x => x.id === f.id).permission, to: f.permission })),
    valueChanged: state.fields.filter(f => prev.fields.some(x => x.id === f.id && x.value !== f.value))
      .map(f => ({ id: f.id, label: f.label, from: String(prev.fields.find(x => x.id === f.id).value).slice(0, 60), to: String(f.value).slice(0, 60) })),
  } : null;
  write(`${slug}-diff.json`, { from: prev ? { nodeId: prev.nodeId, name: prev.name } : null,
    to: { nodeId, name: nodeNameCur }, fieldDiff,
    buttons: state.commandButtons.map(b => ({ text: b.text, actionId: b.actionId, kill: b.kill, tip: b.tip, visible: b.visible })),
    entityActions: state.entityActions });

  progress.visited.push(nodeId);
  progress.trace.push({ step, nodeId, name: nodeNameCur, flowStepId: state.step?.flowStepId,
    identity: state.identity, commandButtons: state.commandButtons.map(b => ({ text: b.text, actionId: b.actionId, kill: b.kill, tip: b.tip })),
    entityActions: state.entityActions, fields: state.fields, fieldCount: state.fieldCount,
    screenshot: bundle.summary.screenshot, chosenAction: action, at: state.capturedAt });
  write('flow-progress.json', progress);
  console.log(`[step ${step}] node${nodeId} ${nodeNameCur} | actions=${state.entityActions.map(a => a.name).join(' / ')} | fields=${state.fieldCount}`);

  // 释放 CDP 后调用修复+提交脚本（其内部会再次核验 DEBUG、补填、提交、采集新节点）
  await release();
  const subDir = path.join(evidenceDir, `${slug}-transition`);
  const proc = spawnSync(process.execPath, [repairScript,
    '--url', String(state.step.flowStepId || ''), '--dir', args.dir, '--instance', args.instance,
    '--scope', args.scope, '--action', action.name,
    '--attachment', args.attachment || '', '--evidence', subDir, '--max-rounds', args['max-rounds'] || '10'],
    { cwd: toolRoot, encoding: 'utf8', timeout: 110000, maxBuffer: 32 * 1024 * 1024 });
  const out = (proc.stdout || '').trim();
  write(`${slug}-transition.log`, out + '\n' + (proc.stderr || ''));
  let result = {};
  try { result = JSON.parse(out.split('\n').filter(l => l.startsWith('OUTCOME')).at(-1)?.replace(/^OUTCOME\s*/, '') || '{}'); } catch (_) {}
  if (!result.success) {
    progress.blocked = { nodeId, name: nodeNameCur, reason: result.reason || 'submit-failed',
      detail: path.join(subDir, 'blocked.json'), at: new Date().toISOString() };
    write('flow-progress.json', progress);
    write('flow-blocked.json', progress.blocked);
    console.log('BLOCKED at', nodeNameCur, result.reason || 'submit-failed'); break;
  }
  let transition = {};
  try { transition = JSON.parse(fs.readFileSync(path.join(subDir, 'transition.json'), 'utf-8')); } catch (_) {}
  progress.trace.at(-1).transition = { to: transition.to, nextRender: transition.nextRender,
    nextTasks: transition.nextTasks, actualAction: action.name,
    buttonsAfter: (transition.newButtons || []).filter(b => b.visible).map(b => ({ text: b.text, actionId: b.actionId, kill: b.kill })) };
  write('flow-progress.json', progress);
  console.log(`  -> ${transition.to?.name || '?'} [${transition.to?.stepId || '?'}]`);
}

// 生成按钮-分支映射（叠加本轮实测）
const observedButtons = {};
const verifiedActions = [];
for (const t of progress.trace) {
  if (t.nodeId) observedButtons[t.nodeId] = (t.commandButtons || []).map(b => ({ text: b.text, actionId: b.actionId, kill: b.kill, tip: b.tip }));
  if (t.chosenAction && t.transition?.to) verifiedActions.push({
    nodeId: t.nodeId, label: t.chosenAction.name, instanceId: args.instance,
    actualTargetNodeId: t.transition.to.stepId, actualTargetName: t.transition.to.name,
  });
}
const map = buildButtonMap(parsed, { observedButtons, verifiedActions });
write('button-branch-map.json', map);
fs.writeFileSync(path.join(evidenceDir, 'button-branch-map.md'),
  `# 节点按钮与分支映射（实测叠加）\n\n节点数 ${map.nodeCount}，连线数 ${map.transitionCount}\n\n` +
  (await import('../src/node-button-map.mjs')).buttonMapToMarkdown(map) + '\n', 'utf-8');

await release();
console.log('FLOW_DONE', JSON.stringify({ visited: progress.visited, finished: progress.finished || null, blocked: progress.blocked || null }));
