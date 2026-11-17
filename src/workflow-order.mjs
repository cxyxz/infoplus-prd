// Forward topology determines document order; return paths remain separate evidence.
export function workflowOrder(workflow) {
  const nodes = workflow.nodes || [];
  const ids = new Set(nodes.map(n => String(n.id)));
  const byId = new Map(nodes.map(n => [String(n.id), n]));
  const returns = /退回|重新|刷新|return|again/i;
  const edges = (workflow.transitions || []).filter(e =>
    ids.has(String(e.source)) && ids.has(String(e.target)) &&
    String(e.source) !== String(e.target) && !returns.test(e.name || '') &&
    !(byId.get(String(e.target))?.type === '办理' && /退回|修改/.test(byId.get(String(e.target))?.name || '')));
  const incoming = new Map(nodes.map(n => [String(n.id), 0]));
  const outgoing = new Map(nodes.map(n => [String(n.id), []]));
  for (const e of edges) {
    incoming.set(String(e.target), incoming.get(String(e.target)) + 1);
    outgoing.get(String(e.source)).push(String(e.target));
  }
  const rank = new Map(nodes.map(n => [String(n.id), 0]));
  const queue = nodes.filter(n => !incoming.get(String(n.id))).map(n => String(n.id));
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);
    for (const target of outgoing.get(id)) {
      rank.set(target, Math.max(rank.get(target), rank.get(id) + 1));
      incoming.set(target, incoming.get(target) - 1);
      if (!incoming.get(target)) queue.push(target);
    }
  }
  // Unresolved cycles never silently masquerade as a verified normal path.
  return nodes.map(n => ({ ...n, topologyLevel: n.type === '办理' && /退回|修改/.test(n.name) ? Infinity : visited.has(String(n.id)) ? rank.get(String(n.id)) : Infinity }))
    .sort((a, b) => a.topologyLevel - b.topologyLevel || a.name.localeCompare(b.name, 'zh'));
}

export function businessControl(field) {
  const hints = [field.type, field.apiType, ...(field.usages || []).map(u => u.kind)];
  if (hints.includes('FileAttachment') || /附件|上传/.test(field.name || '')) return '附件上传';
  if (hints.includes('User')) return '成员选择';
  if (hints.includes('Organize')) return '部门选择';
  if (hints.some(t => /^(date|dateTime|DatePicker|DTPicker)$/.test(t))) return '日期选择';
  if (hints.includes('OptionButton')) return '单选';
  if (hints.some(t => ['Code', 'DropDown'].includes(t))) return '下拉选择';
  if (hints.some(t => ['boolean', 'CheckBox'].includes(t))) return '复选框';
  if (hints.some(t => ['int', 'integer', 'decimal', 'double'].includes(t))) return '数字';
  if (hints.includes('RichText')) return '多行文本';
  return '单行文本';
}
