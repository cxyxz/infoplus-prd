/**
 * Refresh screenshot-index statistics and the Markdown index from the
 * authoritative JSON after an evidence-reclassification pass.
 */
import fs from 'node:fs';
import path from 'node:path';

const indexFile = path.resolve(process.argv[2] || 'debug-evidence/screenshot-index.json');
const root = path.dirname(indexFile);
const index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));

index.generatedAt = new Date().toISOString();
index.statistics = {
  nodes: index.nodes.length,
  fullPage: index.nodes.filter(node => (node.images || [])
    .some(image => image.category === 'full-page' && image.sourceVariant === 'masked')).length,
  actionButtons: index.nodes.filter(node => (node.images || [])
    .some(image => image.category === 'action-buttons')).length,
  specialFields: index.nodes.reduce((count, node) => count + (node.images || [])
    .filter(image => image.category === 'special-field').length, 0),
  images: index.nodes.reduce((count, node) => count + (node.images || []).length, 0),
};

const lines = [
  '# 真实 Debug 截图索引',
  '',
  `实例：\`${index.instanceId || '—'}\`；来源：${index.source || '—'}`,
  '',
  `节点 ${index.statistics.nodes} 个；完整页面 ${index.statistics.fullPage} 个；底部按钮 ${index.statistics.actionButtons} 个；特殊字段 ${index.statistics.specialFields} 个；图片 ${index.statistics.images} 张。`,
  '',
  '| 节点 | 来源 | 完整页面 | 分段 | 底部按钮 | 特殊字段 | 实际按钮 | 文档目录 |',
  '|---|---|---|---:|---:|---:|---|---|',
];

for (const node of index.nodes) {
  const count = category => (node.images || []).filter(image => image.category === category).length;
  lines.push(`| ${node.nodeName} [${node.nodeId}] | ${node.pageType || '—'} | ${count('full-page') ? '有' : '无'} | ${count('page-segment')} | ${count('action-buttons') ? '有' : '无'} | ${count('special-field')} | ${(node.buttonsDetected || []).join(' / ') || '未暴露'} | ${node.folder || '—'} |`);
}

lines.push('', '完整页面原始图保存在各节点 `original/` 子目录；文档使用脱敏图。历史快照只证明页面结构，不增加新的已验证动作。');
fs.writeFileSync(indexFile, JSON.stringify(index, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(root, 'screenshot-index.md'), lines.join('\n') + '\n', 'utf8');
console.log(JSON.stringify(index.statistics));
