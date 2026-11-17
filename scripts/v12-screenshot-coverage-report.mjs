/**
 * V1.2 截图覆盖报告：按节点连接真实截图索引、按钮映射与 Word 正文章节。
 */
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['index', 'button-map', 'markdown', 'output']) if (!args[k]) { console.error(`MISSING --${k}`); process.exit(2); }
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf-8'));
const index = readJson(args.index);
const map = readJson(args['button-map']);
const md = fs.readFileSync(args.markdown, 'utf-8');
const mdLines = md.split('\n');

function wordChapter(node) {
  const start = mdLines.findIndex(line => line.startsWith('### 节点：') && line.includes(`[${node.nodeId}]`));
  if (start < 0) return '未在正文找到节点章节';
  const next = mdLines.slice(start + 1).findIndex(line => line.startsWith('### 节点：'));
  const end = next < 0 ? mdLines.length : start + 1 + next;
  const captionCount = mdLines.slice(start + 1, end).filter(line => line.startsWith('### 图 N-')).length;
  return `${mdLines[start].replace(/^###\s+/, '')}（正文含图，总图注 ${captionCount} 个）`;
}
function status(node) {
  if (node.pageType === 'live-debug') return '实时 Debug 页面已访问';
  if (node.pageType === 'historical-snapshot') return '同一实例历史只读快照';
  return node.visited ? '已访问' : '未进入';
}
function yesNo(images, category) {
  const found = images.filter(i => i.category === category);
  if (!found.length) return '无';
  if (category === 'full-page') {
    const masked = found.filter(i => i.sourceVariant === 'masked');
    return `有（${masked.length} 张脱敏完整图）`;
  }
  return `有（${found.length} 张）`;
}

const buttonById = new Map(map.nodes.map(n => [Number(n.nodeId), n]));
const verifiedByNode = new Map([...buttonById.entries()].map(([id, n]) =>
  [id, (n.buttons || []).filter(b => b.verification === 'actual-verified').map(b => b.label)]));
const rows = index.nodes.map(node => {
  const specials = node.images.filter(i => i.category === 'special-field').map(i => i.fieldName || i.fieldId).filter(Boolean);
  const buttons = node.images.filter(i => i.category === 'action-buttons');
  const missing = [];
  if (!node.images.some(i => i.category === 'full-page' && i.sourceVariant === 'masked')) missing.push('无脱敏完整页面图');
  if (!buttons.length) missing.push(node.buttonDetectionNote || '未采集底部业务按钮图');
  if (!specials.length) missing.push('无特殊字段局部图（当前页面未暴露或规则不适用）');
  return {
    nodeId: node.nodeId, name: node.nodeName, status: status(node),
    fullPage: yesNo(node.images, 'full-page'),
    segments: node.images.filter(i => i.category === 'page-segment').length,
    actionButtons: yesNo(node.images, 'action-buttons'),
    specialFields: specials.length ? specials.join('、') : '无',
    verifiedButtons: (verifiedByNode.get(Number(node.nodeId)) || []).join(' / ') || '无',
    wordChapter: wordChapter(node),
    missing: missing.join('；') || '无',
  };
}).sort((a, b) => rowsOrder(a.nodeId) - rowsOrder(b.nodeId));
function rowsOrder(id) {
  const order = [27, 14, 32, 30, 37, 48, 42, 7, 24];
  const i = order.indexOf(Number(id)); return i < 0 ? 999 : i;
}

const visited = new Set(index.nodes.map(n => Number(n.nodeId)));
const unvisited = map.nodes.filter(n => !visited.has(Number(n.nodeId)))
  .map(n => `${n.name} [${n.nodeId}]`);
const lines = [
  '# Z1775 真实 Debug 截图覆盖报告', '',
  `生成时间：${new Date().toISOString()}`,
  `实例：\`${index.instanceId || '—'}\`；版本：${index.version || '—'}`, '',
  '## 一、按节点覆盖情况', '',
  '| 节点 | 实际访问状态 | 完整页面图 | 分段数 | 底部按钮图 | 特殊字段图 | 已实际验证按钮 | 对应 Word 章节 | 缺失原因 |',
  '|---|---|---|---:|---|---|---|---|---|',
  ...rows.map(r => `| ${r.name} [${r.nodeId}] | ${r.status} | ${r.fullPage} | ${r.segments} | ${r.actionButtons} | ${r.specialFields} | ${r.verifiedButtons} | ${r.wordChapter} | ${r.missing} |`),
  '', '## 二、统计', '',
  `- 实际进入并采集截图的节点：${index.nodes.length} 个。`,
  `- 脱敏完整页面图：${index.statistics.fullPage} 个；底部业务按钮图：${index.statistics.actionButtons} 个；特殊字段图：${index.statistics.specialFields} 张。`,
  `- 质量门禁：${JSON.parse(fs.readFileSync(path.join(path.dirname(args.index), 'screenshot-quality.json'), 'utf-8')).ok ? '通过' : '未通过'}。`,
  `- 29 个人工按钮 / 17 个自动网关分支中，8 个按钮经实际流转验证；未点击项保持「配置确认、实际未验证」。`,
  `- 未进入节点（仅有 Workflow/XSN 配置证据，无真实 Debug 截图）：${unvisited.join('、') || '无'}。`, '',
  '## 三、限制与来源说明', '',
  '- 历史只读快照只还原页面结构与字段布局，不增加新的提交或审批验证。',
  '- 实时截图与历史快照均来自专用 Chrome CDP；文档图已遮盖字段值与身份信息，原始图保存在各节点 `original/` 子目录。',
  '- node27 当前调试身份非申请人；调试控制台“模拟登录”候选仅返回参数缺失提示，未获得可用切换入口，因此未提交该节点动作。',
  '- 条件切换前后对比图未在本次采集中完整获得；动态必填链以提交响应、补填日志和字段差异证据说明，不伪造截图。',
];
fs.writeFileSync(args.output, lines.join('\n') + '\n', 'utf-8');
fs.writeFileSync(args.output.replace(/\.md$/, '.json'), JSON.stringify({ rows, unvisited, statistics: index.statistics }, null, 2), 'utf-8');
console.log(args.output);
