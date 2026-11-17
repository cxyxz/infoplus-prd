/**
 * InfoPlus PRD Skill V1.2 — 按节点批量采集真实 Debug 截图并建立索引
 *
 * 复用当前实例及历史只读快照，不新建实例、不触发保存/提交/开始动作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { scanFormState } from '../src/form-autofill.mjs';
import { readDebugStep } from '../src/debug-session.mjs';
import { captureNodeScreenshots, writeScreenshotIndex, qualityCheck } from '../src/screenshot-evidence.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['dir', 'instance', 'output']) if (!args[k]) { console.error(`MISSING --${k}`); process.exit(2); }
const directory = path.resolve(args.dir);
const output = path.resolve(args.output);
const project = JSON.parse(fs.readFileSync(path.join(directory, 'project.json'), 'utf-8'));
const order = args.order ? String(args.order).split(',').map(Number).filter(Boolean) : null;
const buttonMap = args['button-map'] && fs.existsSync(args['button-map'])
  ? JSON.parse(fs.readFileSync(args['button-map'], 'utf-8')) : null;
fs.mkdirSync(output, { recursive: true });

const browser = await chromium.connectOverCDP(process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/', { timeout: 25000 });
const context = browser.contexts()[0];
const source = context.pages().find(p => /one\.zju\.edu\.cn\/infoplus\/form\/\d+\/render/.test(p.url()) &&
  p.url().indexOf('snapshot') < 0 && p.url().includes('entrust=true'));
let livePage = null;
for (const p of context.pages()) {
  if (!/one\.zju\.edu\.cn\/infoplus\/form\/\d+\/render/.test(p.url()) || p.url().includes('snapshot')) continue;
  const hit = await p.evaluate(id => window.$$?.entity?.step?.instanceId === id, args.instance).catch(() => false);
  if (hit) { livePage = p; break; }
}
if (!source || !livePage) { console.log('NO_SOURCE_PAGE'); await browser.close(); process.exit(3); }
await readDebugStep(livePage, project, args.instance);

const historyLinks = await livePage.evaluate(() => [...document.querySelectorAll('a[href]')].flatMap(a => {
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || !/^\/infoplus\/form\/\d+\/render$/.test(u.pathname) || u.search !== '?snapshot=true') return [];
  return [{ name: (a.innerText || '').replace(/\s+/g, ' ').trim(), url: u.href }];
}));
const uniqueLinks = [...new Map(historyLinks.map(x => [x.url, x])).values()];
const pages = await context.newPage();
await pages.route('**/*', route => /\/interface\/(doAction|start|save)(?:\?|$)/i.test(route.request().url())
  ? route.abort() : route.continue());

const shots = [];
let index = 0;
async function capture(page, pageType, note) {
  const state = await scanFormState(page);
  if (!state.step?.stepId) return null;
  const nodeId = state.step.stepId;
  const nodeName = String(state.step.name || note || '节点').trim();
  const transitions = buttonMap?.nodes?.find(n => Number(n.nodeId) === nodeId)?.buttons ?? [];
  const meta = {
    index: ++index, nodeId, nodeName, flowStepId: state.step.flowStepId,
    instanceId: args.instance, url: page.url(), pageType,
    identity: { account: state.identity?.actionAccount || null, name: state.identity?.name || null },
    capturedAt: state.capturedAt,
    source: pageType === 'live-debug' ? 'IDE DEBUG 实时办理页面（只读截图）' : '同一 DEBUG 实例的历史只读快照',
    verificationNote: note,
    buttonTransitions: transitions.map(b => ({ label: b.label, targetNodeId: b.targetNodeId,
      targetName: b.targetName, verification: b.verification })),
    fieldCount: state.fieldCount,
  };
  const shot = await captureNodeScreenshots(page, meta, {
    root: output,
    maxSegments: Number(args.segments || 6),
    specialLimit: Number(args['special-limit'] || 6),
  });
  shots.push(shot);
  console.log(JSON.stringify({ nodeId, nodeName, pageType, images: shot.images.length, buttons: shot.buttonsDetected }));
  return shot;
}

try {
  if (args['skip-live'] !== 'true') await capture(livePage, 'live-debug', '当前实时节点；未在本轮重复提交动作');
  for (const link of uniqueLinks) {
    await pages.goto(link.url, { waitUntil: 'domcontentloaded', timeout: Number(process.env.INFOPLUS_NAV_TIMEOUT || 30000) });
    await pages.waitForFunction(() => !!window.$$?.entity?.step, undefined, { polling: 100, timeout: 20000 });
    await pages.waitForTimeout(500);
    await readDebugStep(pages, project, args.instance);
    const state = await scanFormState(pages);
    if (order && !order.includes(Number(state.step?.stepId))) continue;
    await capture(pages, 'historical-snapshot', `${link.name || state.step?.name || ''} 历史只读页面；证明页面结构，不证明新条件切换或新动作`);
  }
} finally {
  await pages.close().catch(() => {});
  await browser.close().catch(() => {});
}

const quality = qualityCheck(shots);
const indexFile = writeScreenshotIndex(output, shots, quality, {
  code: project.code, version: project.version, definitionId: project.workflowDefinitionId,
  instanceId: args.instance, source: '专用 Chrome CDP / 真实 InfoPlus Debug 页面与历史快照',
  notes: ['历史快照页面已拦截 doAction/start/save 写操作', '文档图按字段值与身份信息脱敏；原始图保存在 original/ 子目录', '未新建 Debug 实例，未重复提交已完成动作'],
});
console.log('SCREENSHOTS_DONE', JSON.stringify(indexFile.statistics));
console.log('QUALITY', JSON.stringify({ ok: quality.ok, issues: quality.issues.length }));
