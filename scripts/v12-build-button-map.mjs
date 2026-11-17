/**
 * InfoPlus PRD Skill V1.2 — 生成「节点按钮 / Workflow 连线 / 分支」完整映射
 * 输入：workflow.mmd、逐节点采集证据目录、debug-runs.json
 * 输出：button-branch-map.json / .md（含验证状态：实际验证 vs 配置已确认）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseWorkflowMermaid, buildButtonMap, writeButtonMap } from '../src/node-button-map.mjs';

export function rebuildButtonMap(args) {
const workflowPath = args.workflow;
const evidenceDir = args.evidence || '';
const outputDir = args.output || path.dirname(workflowPath);
if (!workflowPath || !fs.existsSync(workflowPath)) { throw new Error('MISSING --workflow'); }

const parsed = parseWorkflowMermaid(fs.readFileSync(workflowPath, 'utf-8'));

// 递归收集节点证据（V1.2 证据目录按 run/step 分层，不能只扫顶层）
function collectNodeEvidenceFiles(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectNodeEvidenceFiles(full, out);
    else if (entry.name.endsWith('-node.json')) out.push(full);
  }
  return out;
}

// 1) 实测页面按钮（按 nodeId 汇总）
const observedButtons = {};
for (const f of collectNodeEvidenceFiles(evidenceDir)) {
  try {
    const d = JSON.parse(fs.readFileSync(f, 'utf-8'));
    const id = d.step?.stepId ?? d.step?.nodeId;
    if (!id) continue;
    (observedButtons[id] ||= []).push(...(d.commandButtons || []).map(b => ({
      text: b.text, actionId: b.actionId, kill: b.kill, tip: b.tip,
    })));
  } catch (_) {}
}

// 2) 实测动作与真实目标节点（来自 Skill 的 debug-runs 事件）
const verifiedActions = [];
function progressFiles(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) progressFiles(file, out);
    else if (entry.name === 'progress.json') out.push(file);
  }
  return out;
}
for (const file of progressFiles(evidenceDir)) {
  const progress = JSON.parse(fs.readFileSync(file, 'utf8'));
  const act = progress.outcome?.act;
  const next = act?.responses?.flatMap(r => r.nextTasks || []) || [];
  if (!progress.outcome?.success || !act?.before?.instanceId || !next.length) continue;
  for (const task of next) verifiedActions.push({
    nodeId: act.before.nodeId, actionId: act.action?.id, label: act.action?.label,
    instanceId: act.before.instanceId, at: progress.updatedAt,
    actualTargetNodeId: task.nodeId, actualTargetName: task.name, evidence: file,
  });
}
const runsPath = args['debug-runs'] || path.join(path.dirname(workflowPath), 'raw', 'debug-runs.json');
if (fs.existsSync(runsPath)) {
  try {
    const runs = JSON.parse(fs.readFileSync(runsPath, 'utf-8')).runs || [];
    for (const run of runs) {
      const events = run.events || [];
      for (let i = 0; i < events.length; i++) {
        const ev = events[i];
        if (ev.kind !== 'action' || !ev.success) continue;
        const next = events.slice(i + 1).find(x => x.kind === 'after-action');
        const tasks = ev.responses?.filter(r => r.errno === 0).flatMap(r => r.nextTasks || []) || [];
        if (verifiedActions.some(v => Number(v.nodeId) === Number(ev.before?.nodeId) && v.label === ev.action?.label)) continue;
        verifiedActions.push({
          nodeId: ev.before?.nodeId, label: ev.action?.label, actionId: ev.action?.id,
          accepted: ev.errno === 0,
          instanceId: run.instanceId, at: ev.at || null,
          actualTargetNodeId: next?.after?.nodeId ?? tasks[0]?.nodeId ?? null,
          actualTargetName: next?.after?.name ?? tasks[0]?.name ?? null,
          actualTargets: tasks.map(t => ({ nodeId: t.nodeId, name: t.name })),
        });
      }
    }
  } catch (_) {}
}

// V1.2 汇总证据记录了 CLI 超时但业务已成功的动作（如 24/7/42/14），
// 需要并入 verifiedActions，避免把实际成功误标为「配置已确认」。
const evidencePath = args.evidenceFile || path.join(path.dirname(workflowPath), 'raw', 'v12-debug-evidence.json');
if (fs.existsSync(evidencePath)) {
  try {
    const ev = JSON.parse(fs.readFileSync(evidencePath, 'utf-8'));
    for (const v of ev.verifiedNodes || []) {
      if (!v.success) continue;
      if (verifiedActions.some(x => Number(x.nodeId) === Number(v.nodeId) && x.label === v.action)) continue;
      verifiedActions.push({
        nodeId: v.nodeId, label: v.action,
        instanceId: ev.instanceId, at: ev.capturedAt || null,
        actualTargetNodeId: v.target ?? null, actualTargetName: null,
      });
    }
  } catch (_) {}
}

const map = buildButtonMap(parsed, { observedButtons, verifiedActions });
const files = writeButtonMap(map, outputDir);
const summary = {
  nodeCount: map.nodeCount, transitionCount: map.transitionCount,
  totalButtons: map.nodes.reduce((s, n) => s + n.buttons.length, 0),
  totalAutomaticBranches: map.nodes.reduce((s, n) => s + n.automaticBranches.length, 0),
  verifiedButtons: map.nodes.reduce((s, n) => s + n.buttons.filter(b => b.verification === 'actual-verified').length, 0),
  observedNodes: Object.keys(observedButtons).length,
  verifiedActions,
};
fs.writeFileSync(path.join(outputDir, 'button-map-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
return { ...summary, files };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
 const args = Object.fromEntries(process.argv.slice(2).flatMap((arg,i,a)=>arg.startsWith('--')?[[arg.slice(2),a[i+1]]]:[]));
 console.log(JSON.stringify(rebuildButtonMap(args),null,2));
}
