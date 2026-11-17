import { memberScopeDescription } from './debug-runtime.mjs';
// Compare only recorded navigation edges within one Debug instance. A missing
// observation is not proof that a field does not exist in the template.
export function analyzeStageFields(data) {
  const stages = [], differences = [], byField = new Map();
  for (const run of data?.runs ?? []) {
    if (run.origin !== 'automatic-debug') continue;
    const latest = new Map();
    for (const e of run.events) if (e.kind === 'stage') latest.set(e.state.flowStepId, e);
    for (const e of latest.values()) {
      stages.push({ instanceId: run.instanceId, nodeId: e.state.nodeId, step: e.state.flowStepId,
        name: e.state.name.trim(), role: e.role, fields: e.fields, screenshot: e.screenshot });
      for (const field of e.fields) {
        if (!byField.has(field.id)) byField.set(field.id, []);
        byField.get(field.id).push({ field, stage: e.state.name.trim(), nodeId: e.state.nodeId,
          screenshot: e.screenshot, scope: e.memberScopes?.find(s => s.fieldId === field.id) });
      }
    }
    for (const e of run.events.filter(e => e.kind === 'resume')) {
      const from = latest.get(e.before.flowStepId), to = latest.get(e.after.flowStepId);
      if (!from || !to) continue;
      const a = new Map(from.fields.map(f => [f.id, f])), b = new Map(to.fields.map(f => [f.id, f]));
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(id), y = b.get(id), changes = [];
        if (!x || !y) changes.push(!x ? '前节点未采集到绑定，当前节点有绑定' : '当前节点未采集到绑定');
        else {
          if (x.visible !== y.visible) changes.push(y.visible ? '当前观测显示' : '当前观测隐藏');
          if (x.readOnly !== y.readOnly) changes.push(y.readOnly === true ? '当前只读' : y.readOnly === false ? '当前可编辑' : '编辑权限未明确');
          if (x.required !== y.required) changes.push(y.required ? '当前配置必填' : '当前配置非必填');
        }
        if (changes.length) differences.push({ instanceId: run.instanceId, fieldId: id,
          from: from.state.name.trim(), to: to.state.name.trim(), changes,
          cause: '仅确认节点观测差异；角色、业务条件或前序数据的因果关系未单独验证' });
      }
    }
  }
  const special = [];
  for (const [id, rows] of byField) {
    const visible = rows.filter(r => r.field.visible);
    if (!visible.length) continue;
    const states = new Set(rows.map(r => JSON.stringify([r.field.visible,r.field.readOnly,r.field.required])));
    if (!rows.some(r => r.scope?.settings?.userFilters || r.field.fieldChanging) && states.size < 2) continue;
    for (const row of visible) {
      if (special.some(s => s.fieldId === id && s.stage === row.stage)) continue;
      special.push({ fieldId: id, name: row.field.name, stage: row.stage,
        source: row.scope ? `人员选择服务；${memberScopeDescription(row.scope.settings)} 组织目录来源及上下级关系未单独验证。` :
          row.field.type === 'Code' ? '选项来源以已有字典或接口证据为准。' : '当前节点表单配置；自动带出来源未确认。',
        rule: `当前观测显示；${row.field.readOnly === true ? '只读' : row.field.readOnly === false ? '可编辑' : '编辑权限待确认'}；${row.field.required ? '配置必填，条件必填边界待核对' : '配置非必填'}。${states.size > 1 ? '跨节点状态存在差异，具体触发原因不能仅凭阶段变化推断。' : ''}`,
        screenshot: row.screenshot });
    }
  }
  return { schemaVersion: 2, stages, differences, special, exclusiveObservedFields: [...byField].filter(([,rows]) =>
    new Set(rows.filter(r => r.field.visible).map(r => r.nodeId)).size === 1).length,
    exclusiveMeaning: '仅在一个已观察节点显示，非全流程专属字段结论' };
}
