/**
 * InfoPlus PRD Skill V1.2 — 节点按钮 / Workflow 连线 / 分支映射（通用）
 *
 * 不硬编码任何流程；输入 workflow.mmd 与（可选的）实测页面按钮清单，
 * 输出每个节点的完整按钮清单、目标节点、分支条件与验证状态。
 * 验证状态严格区分：actual-verified（真实点击并核对流转） / config-confirmed（配置已确认、实际未验证）。
 */
import fs from 'node:fs';

const AUTO_LABEL = /^(是|否|result|split\d*|true|false|yes|no)$/i;

export function parseWorkflowMermaid(text) {
  const nodes = new Map();
  const transitions = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    let m = line.match(/^(n\d+)\["(.+?)\s*\[(\d+)\]"\]\s*$/);
    if (m) {
      nodes.set(m[1], { key: m[1], nodeId: Number(m[3]), name: m[2].trim() });
      continue;
    }
    m = line.match(/^(n\d+)\s*-->\s*\|\s*"(.+?)\s*\[(\d+)\]"\s*\|\s*(n\d+)\s*$/);
    if (!m) m = line.match(/^(n\d+)\s*-->\s*\|\s*"(.+?)"\s*\|\s*(n\d+)\s*$/);
    if (m) {
      const transitionId = m.length === 5 ? Number(m[3]) : null;
      const label = m[2].trim();
      transitions.push({
        fromKey: m[1], toKey: m[4] ?? m[3], label, transitionId,
        automatic: AUTO_LABEL.test(label.replace(/\s*\[\d+\]\s*$/, '')),
      });
    }
  }
  return { nodes: [...nodes.values()], transitions, byKey: nodes };
}

/** 构建每节点按钮清单（含自动网关分支，单独标注） */
export function buildButtonMap(parsed, options = {}) {
  const byNodeId = new Map(parsed.nodes.map(n => [n.nodeId, n]));
  const map = new Map();
  for (const n of parsed.nodes) map.set(n.nodeId, {
    nodeId: n.nodeId, name: n.name, buttons: [], automaticBranches: [],
  });
  for (const t of parsed.transitions) {
    const from = parsed.byKey.get(t.fromKey);
    const to = parsed.byKey.get(t.toKey);
    if (!from || !to) continue;
    const entry = map.get(from.nodeId);
    if (!entry) continue;
    const item = {
      label: t.label.replace(/\s*\[\d+\]\s*$/, '').trim(),
      rawLabel: t.label, transitionId: t.transitionId,
      actionId: t.transitionId == null ? null : String(t.transitionId),
      targetNodeId: to.nodeId, targetName: to.name,
      condition: t.automatic ? t.label.replace(/\s*\[\d+\]\s*$/, '').trim() : '',
      verification: 'config-confirmed', verifiedAt: null, actualTargetNodeId: null,
    };
    if (t.automatic) entry.automaticBranches.push(item);
    else entry.buttons.push(item);
  }
  // 叠加实测页面按钮（含不在 Workflow 连线中的平台级按钮，如「终止」）
  for (const [nodeId, observed] of Object.entries(options.observedButtons || {})) {
    const entry = map.get(Number(nodeId));
    if (!entry) continue;
    for (const b of observed) {
      const rawActionId = b.actionId || null;
      const actionId = String(rawActionId || '').replace(/^.*action_(?:\d+_)?/, '');
      const label = b.kill ? '终止' : String(b.text || '').replace(b.tip || '\u0000', '').trim();
      const candidates = entry.buttons.filter(x => actionId
        ? String(x.actionId) === actionId : x.label === b.text);
      const found = candidates.length === 1 ? candidates[0] : null;
      if (found) { found.observedOnPage = true; found.rawActionId = rawActionId; if (b.tip) found.condition ||= b.tip; }
      else entry.buttons.push({
        label, rawLabel: b.text, rawActionId, transitionId: /^\d+$/.test(actionId) ? Number(actionId) : null,
        actionId: actionId || null,
        targetNodeId: null, targetName: null, condition: b.tip || '',
        pageLevel: true, kill: !!b.kill, observedOnPage: true,
        verification: 'config-confirmed', verifiedAt: null, actualTargetNodeId: null,
      });
    }
  }
  // 叠加实测流转（来自逐节点 Debug 记录）
  for (const v of options.verifiedActions || []) {
    const entry = map.get(Number(v.nodeId));
    if (!entry) continue;
    const candidates = entry.buttons.filter(x => v.actionId ? String(x.actionId) === String(v.actionId) : x.label === v.label);
    const btn = candidates.length === 1 ? candidates[0] : null;
    if (btn && v.instanceId && v.accepted && v.actualTargetNodeId == null) {
      btn.verification = 'actual-executed';
      btn.instanceId = v.instanceId;
      btn.actualResult = '提交响应成功，未返回新的办理节点；后续流转需结合汇合记录确认';
    }
    if (btn && v.instanceId && v.actualTargetNodeId != null) {
      btn.verification = 'actual-verified';
      btn.verifiedAt = v.at || null;
      btn.actualTargetNodeId = v.actualTargetNodeId ?? null;
      btn.actualTargetName = v.actualTargetName ?? null;
      btn.instanceId = v.instanceId || null;
      btn.actualTargets = v.actualTargets || [{ nodeId: v.actualTargetNodeId, name: v.actualTargetName }];
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    nodeCount: parsed.nodes.length,
    transitionCount: parsed.transitions.length,
    nodes: [...map.values()].sort((a, b) => a.nodeId - b.nodeId),
  };
}

export function buttonMapToMarkdown(map) {
  const lines = ['| 当前节点 | 操作按钮/分支 | 类型 | 目标节点 | 连线ID | 验证状态 |',
    '|---|---|---|---|---|---|'];
  for (const n of map.nodes) {
    for (const b of n.buttons) {
      lines.push(`| ${n.name} [${n.nodeId}] | ${b.label}${b.kill ? '（平台级）' : ''} | ${b.pageLevel ? '页面按钮' : '人工动作'} | ${b.targetName ? `${b.targetName} [${b.targetNodeId}]` : '—'} | ${b.transitionId ?? '—'} | ${b.verification === 'actual-verified' ? '实际验证' : '配置已确认、实际未验证'} |`);
    }
    for (const b of n.automaticBranches) {
      lines.push(`| ${n.name} [${n.nodeId}] | ${b.label} | 自动网关条件 | ${b.targetName} [${b.targetNodeId}] | ${b.transitionId ?? '—'} | 配置已确认（自动流转） |`);
    }
  }
  return lines.join('\n');
}

export function writeButtonMap(map, directory, basename = 'button-branch-map') {
  fs.mkdirSync(directory, { recursive: true });
  const json = `${directory}/${basename}.json`;
  const md = `${directory}/${basename}.md`;
  fs.writeFileSync(json, JSON.stringify(map, null, 2), 'utf-8');
  fs.writeFileSync(md, `# 节点按钮与分支映射\n\n生成时间：${map.generatedAt}\n节点数：${map.nodeCount}，连线数：${map.transitionCount}\n\n${buttonMapToMarkdown(map)}\n`, 'utf-8');
  return { json, md };
}
