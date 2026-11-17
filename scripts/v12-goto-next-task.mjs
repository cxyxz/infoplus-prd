/**
 * InfoPlus PRD Skill V1.2 — 从已完成节点切到下一真实待办（通用）
 *
 * 当动作已真实提交成功、当前页面 status=2 但调度脚本误判时，
 * 不重复提交；按页面实际待办链接导航，并通过明确的 DEBUG 身份窗口切换。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { chooseDebugIdentity } from '../src/debug-runtime.mjs';
import { scanFormState, captureNodeBundle } from '../src/form-autofill.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['instance', 'evidence']) if (!args[k]) { console.error(`MISSING --${k}`); process.exit(2); }
fs.mkdirSync(args.evidence, { recursive: true });

const browser = await chromium.connectOverCDP(process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/', { timeout: 25000 });
const context = browser.contexts()[0];
const pages = context.pages().filter(p => /one\.zju\.edu\.cn\/infoplus\/form\/\d+\/render/.test(p.url()));
let current = null;
for (const p of pages) {
  const hit = await p.evaluate(iid => window.$$?.entity?.step?.instanceId === iid, args.instance).catch(() => false);
  if (hit) { current = p; break; }
}
if (!current) { console.log('NO_CURRENT_PAGE'); await browser.close(); process.exit(3); }

const tasks = await current.evaluate(() => [...document.querySelectorAll('a[href]')].map(a => {
  const href = a.getAttribute('href');
  const m = href && href.match(/\/infoplus\/form\/(\d+)\/render/);
  if (!m || !href.includes('entrust=true')) return null;
  return { step: Number(m[1]), name: a.innerText.replace(/\s+/g, ' ').trim(), url: new URL(href, location.href).href };
}).filter(Boolean));
fs.writeFileSync(path.join(args.evidence, 'available-tasks.json'), JSON.stringify(tasks, null, 2), 'utf-8');
if (!tasks.length) { console.log('NO_PENDING_TASKS'); await browser.close(); process.exit(4); }

const target = args.step ? tasks.find(t => t.step === Number(args.step)) || tasks[0] : tasks[0];
console.log('GOTO', JSON.stringify(target));
await current.goto(target.url, { waitUntil: 'domcontentloaded', timeout: Number(process.env.INFOPLUS_NAV_TIMEOUT || 30000) });
await current.waitForFunction(() => !!document.querySelector('input[name=chooseEntrustee]') || !!window.$$?.entity?.step,
  undefined, { polling: 100, timeout: 20000 }).catch(() => {});
const identity = await chooseDebugIdentity(current, { preferCandidate: true, allowCurrentLoginInterstitial: true });
await current.waitForFunction(() => !!window.$$?.entity?.step, undefined, { polling: 100, timeout: 20000 }).catch(() => {});
const state = await scanFormState(current);
const slug = `node${state.step?.stepId}-${String(state.step?.name || 'unknown').replace(/[^\w\u4e00-\u9fa5]/g, '')}`;
const bundle = await captureNodeBundle(current, args.evidence, slug);
const result = { target, identity, allTasks: tasks,
  state: { step: state.step, identity: state.identity, fieldCount: state.fieldCount,
    commandButtons: state.commandButtons.map(b => ({ text: b.text, actionId: b.actionId, kill: b.kill, tip: b.tip })),
    entityActions: state.entityActions, screenshot: bundle.summary.screenshot } };
fs.writeFileSync(path.join(args.evidence, 'goto-result.json'), JSON.stringify(result, null, 2), 'utf-8');
console.log('GOTO_RESULT', JSON.stringify({ step: state.step, identity: identity.switched, buttons: result.state.commandButtons.filter(b => b.text).map(b => b.text) }));
await browser.close();
