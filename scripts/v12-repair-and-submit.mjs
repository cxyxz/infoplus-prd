import { readDebugStep, requireDebugAuthorization } from '../src/debug-session.mjs';
import { requireDebugPage, verifyDebugInstance } from '../src/debug-verification.mjs';
import { submissionOutcome } from '../src/dialog-classification.mjs';
/**
 * InfoPlus PRD Skill V1.2 — 通用「修复表单校验 → 提交 → 再校验」自动循环
 *
 * 用法（任意流程/节点通用，不含 Z1775 硬编码）：
 *   node scripts/v12-repair-and-submit.mjs \
 *     --url <页面URL关键字> --dir <项目目录> --instance <实例ID> --scope <版本scope> \
 *     --action "<按钮名称>" --attachment <测试附件> --evidence <证据目录> --max-rounds 10
 *
 * V1.2 要点：
 *  - 普通必填校验失败绝不终止任务；每轮按「控件真实状态」判定，忽略 InfoPlus 不即时清除的旧红字。
 *  - 提交会暴露新的动态必填字段（联动），循环自动补填后再提交，直到真正成功。
 *  - 提交前释放 CDP 连接，避免与 Skill CLI 进程并发争用导致导航超时。
 *  - 区分「业务校验失败」与「CLI 技术失败」，后者单独重试并明确记录，绝不伪装成已验证。
 *  - 每轮保存证据与 progress.json，支持断点恢复。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { scanFormState, repairPass, dismissDialogs, captureNodeBundle, errorFingerprint } from '../src/form-autofill.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['url', 'dir', 'instance', 'scope', 'action', 'evidence']) {
  if (!args[k]) { console.error(`MISSING --${k}`); process.exit(2); }
}

const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(toolRoot, 'src', 'cli.mjs');
const maxRounds = Math.min(10, Math.max(1, Number(args['max-rounds']) || 10));
const project = JSON.parse(fs.readFileSync(path.join(args.dir,'project.json'),'utf8'));
requireDebugAuthorization(project,args.scope);
const attachment = args.attachment || '';
const evidenceDir = args.evidence;
fs.mkdirSync(evidenceDir, { recursive: true });

const log = [];
const write = (name, data) => fs.writeFileSync(path.join(evidenceDir, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2), 'utf-8');

const CDP = process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/';
let browser = null;
const connect = async () => {
  if (!browser) browser = await chromium.connectOverCDP(CDP, { timeout: 25000 });
  return browser.contexts()[0];
};
const release = async () => {
  if (browser) { await browser.close().catch(() => {}); browser = null; }
};
/** 优先 URL 命中；流转后 URL 变化时按实例 ID 回退定位（通用） */
const findPage = async ctx => {
  const direct = ctx.pages().find(p => p.url().includes(args.url));
  if (direct && await direct.evaluate(iid=>window.$?.entity?.step?.instanceId===iid,args.instance).catch(()=>false)) return direct;
  for (const p of ctx.pages()) {
    if (!/one\.zju\.edu\.cn\/infoplus\/form\//.test(p.url())) continue;
    const ok = await p.evaluate(iid => window.$$?.entity?.step?.instanceId === iid, args.instance).catch(() => false);
    if (ok) return p;
  }
  return null;
};

let lastFingerprint = '';
let repeat = 0;
let technicalFailures = 0;
let outcome = { success: false };

for (let round = 1; round <= maxRounds; round++) {
  let ctx = await connect();
  let page = await findPage(ctx);
  if (!page) {
    outcome = { success: false, reason: 'page-not-found', round };
    write('blocked.json', outcome); break;
  }
  await page.bringToFront().catch(() => {});
  const verifiedState = await readDebugStep(page,project,args.instance);
  await verifyDebugInstance(page,project,verifiedState,{writable:true});
  requireDebugPage(await readDebugStep(page,project,args.instance),{writable:true});
  const before = await scanFormState(page);
  const unsatisfied = before.errors.filter(e => e.visible && e.msg && !e.satisfied);
  write(`round-${round}-pre-scan.json`, before);
  log.push({ round, phase: 'pre-scan', step: before.step, unsatisfied: unsatisfied.length,
    residualHints: before.errors.filter(e => e.visible && e.satisfied).length,
    commandButtons: before.commandButtons.map(b => b.text), dialogs: before.dialogs });

  write(`round-${round}-dialogs.json`, await dismissDialogs(page));

  if (unsatisfied.length) {
    const repair = await repairPass(page, before, {
      testAttachment: attachment,
      radioPreference: args['radio-preference'] || 'negative',
      valueOverrides: {
        ...(before.identity?.ownerPhone ? { fieldPhone: before.identity.ownerPhone } : {}),
        ...(before.identity?.ownerEmail ? { fieldEmail: before.identity.ownerEmail } : {}),
      },
    });
    write(`round-${round}-repair.json`, { fixed: repair.fixed, skipped: repair.skipped,
      afterUnsatisfied: repair.after.errors.filter(e => e.visible && !e.satisfied),
      afterButtons: repair.after.commandButtons });
    log.push({ round, phase: 'repair', fixed: repair.fixed, skipped: repair.skipped,
      remainingUnsatisfied: repair.after.errors.filter(e => e.visible && !e.satisfied).length });
    console.log(`[round ${round}] repaired ${repair.fixed.length}, skipped ${repair.skipped.length}`);
  }

  const checked = await scanFormState(page);
  if (checked.errors.some(e => e.visible && e.msg && !e.satisfied)) {
    const fingerprint = errorFingerprint(checked.errors);
    repeat = fingerprint === lastFingerprint ? repeat + 1 : 0; lastFingerprint = fingerprint;
    write('progress.json', {instanceId:args.instance,round,lastFingerprint,repeat});
    if (repeat < 2) continue;
    outcome = {success:false,reason:'repair-incomplete',round};
    write('blocked.json', { ...outcome, errors:checked.errors }); break;
  }
  // 提交前释放 CDP：Skill CLI 会独占导航到 IDE 核验页；并发连接会触发 12s 导航超时。
  await release();
  const proc = spawnSync(process.execPath,
    [cli, 'debug-session', args.dir, args.instance, 'act', args.action, args.scope],
    { cwd: toolRoot, encoding: 'utf8', timeout: 110000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, INFOPLUS_ACTION_WAIT_TIMEOUT: process.env.INFOPLUS_ACTION_WAIT_TIMEOUT || '20000',
        INFOPLUS_NAV_TIMEOUT: process.env.INFOPLUS_NAV_TIMEOUT || '30000',
        INFOPLUS_CHROME_CHECK_TIMEOUT: process.env.INFOPLUS_CHROME_CHECK_TIMEOUT || '25000' } });
  const stdout = (proc.stdout || '').trim();
  write(`round-${round}-act.log`, stdout + '\n' + (proc.stderr || ''));
  let act = null;
  const jsonLine = stdout.split('\n').map(s => s.trim()).filter(s => s.startsWith('{')).at(-1);
  try { act = jsonLine ? JSON.parse(jsonLine) : null; } catch (_) {}

  const resultKind = submissionOutcome(act);
  log.push({ round, phase: 'submit', resultKind, submitted: act?.submitted, http: act?.http });
  if (resultKind === 'accepted') { outcome = { success: true, round, act }; break; }
  // Never infer success from HTTP alone or repeat a request whose outcome is unknown.
  if (!['required-validation','format-validation'].includes(resultKind)) {
    ctx = await connect(); page = await findPage(ctx);
    const observed = page ? await scanFormState(page) : null;
    write('uncertain-state.json', { resultKind, before: before.step, current: observed?.step });
    await release();
    const verify = spawnSync(process.execPath,[cli,'debug-session',args.dir,args.instance,'verify'],
      {cwd:toolRoot,encoding:'utf8',timeout:110000});
    write('state-verification.log', (verify.stdout || '') + (verify.stderr || ''));
    outcome = {success:false, reason:resultKind, round, requiresStateReconciliation:resultKind==='unknown'};
    write('blocked.json',outcome); break;
  }

  // 提交未发出：重新连接、重新扫描，动态必填字段通常在本轮暴露
  ctx = await connect();
  page = await findPage(ctx);
  let after = { errors: [], step: null };
  if (page) { await dismissDialogs(page); after = await scanFormState(page); }
  write(`round-${round}-post-scan.json`, after);
  if (!after.errors.some(e=>e.visible && e.msg && !e.satisfied)) {
    outcome={success:false,reason:'validation-field-not-located',round};
    write('blocked.json',outcome); break;
  }
  const fp = errorFingerprint(after.errors);
  const stillUnsatisfied = after.errors.filter(e => e.visible && e.msg && !e.satisfied);
  log.push({ round, phase: 'post-scan', fingerprint: fp, unsatisfied: stillUnsatisfied.length,
    step: after.step, dialogs: after.dialogs, newFields: stillUnsatisfied.map(e => ({ key: e.key, label: e.label, kind: e.kind })) });
  if (fp && fp === lastFingerprint) repeat++; else repeat = 0;
  lastFingerprint = fp;
  write('progress.json', { round, outcome, lastFingerprint, repeat, updatedAt: new Date().toISOString() });
  if (repeat >= 2) {
    outcome = { success: false, reason: 'repeated-unresolved-errors', fingerprint: fp, round };
    write('blocked.json', { reason: outcome.reason, fingerprint: fp, errors: stillUnsatisfied, round });
    console.log('BLOCKED: repeated unresolved validation errors, evidence saved');
    break;
  }
}

if (!outcome.success && !outcome.reason) {
  outcome.reason = 'max-rounds-reached';
  write('blocked.json', { reason: outcome.reason, log });
}

// 成功后采集流转后的新节点证据（真实待办/字段/按钮/整页截图）
if (outcome.success) {
  const ctx = await connect();
  let page = await findPage(ctx);
  if (page) {
    await page.waitForFunction(() => !!window.$$?.entity?.step, undefined, { polling: 200, timeout: 20000 }).catch(() => {});
    const newState = await scanFormState(page);
    const slug = `node${newState.step?.stepId ?? 'unknown'}-${String(newState.step?.name ?? 'unknown').replace(/[^\w\u4e00-\u9fa5]/g, '')}`;
    const bundle = await captureNodeBundle(page, evidenceDir, slug);
    write('transition.json', { from: outcome.act?.before, to: newState.step,
      nextRender: outcome.act?.nextRender,
      nextTasks: (outcome.act?.responses || []).flatMap(r => r.nextTasks || []),
      newButtons: newState.commandButtons, entityActions: newState.entityActions,
      fields: newState.fieldCount, screenshot: bundle.summary.screenshot });
    console.log('TRANSITION', JSON.stringify({ to: newState.step, buttons: newState.commandButtons.map(b => b.text) }));
  }
}

write('run-log.json', { outcome, log, maxRounds, attachment, args });
write('progress.json', { outcome, lastRound: log.filter(x => x.phase === 'pre-scan').length,
  updatedAt: new Date().toISOString() });
console.log('OUTCOME', JSON.stringify(outcome.success ? { success: true, round: outcome.round, nextRender: outcome.act?.nextRender } : outcome));
await release();
process.exit(outcome.success ? 0 : 1);
