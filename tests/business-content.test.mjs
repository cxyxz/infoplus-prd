import assert from 'node:assert/strict';
import test from 'node:test';
import { buildBusinessContent } from '../src/business-content.mjs';

test('业务版按表单证据合并字段，并将未核实的条件标为待确认', () => {
  const result = buildBusinessContent({
    project: { code: 'OTHER', name: '物品领取' },
    workflow: {
      nodes: [{ id: 'a', name: '是否复核', type: '判断' }, { id: 'b', name: '部门复核', type: '办理' }],
      transitions: [{ source: 'a', target: 'b', name: '是' }],
    },
    rules: [{ id: 'a', name: '是否复核', kind: '判断', expression: 'unknown()' }],
    views: [{ id: 'v1', name: '填写' }, { id: 'v2', name: '审核' }],
    fields: [
      { id: 'name', name: '领用人', apiType: 'User', view: '填写', required: true, usages: [{}] },
      { id: 'name', name: 'name', view: '审核', readOnly: true, usages: [{}] },
      { id: '_VAR_OWNER', name: '内部变量', view: '填写', usages: [{}] },
      { id: 'hidden', name: '辅助：分流', view: '填写', usages: [{}] },
    ],
  });
  assert.deepEqual(result.fields.flatMap(group => group.rows), [['领用人', '成员选择', '填写模板标记必填（实际阶段规则待核实） 审核只读']]);
  assert.match(result.approvals[0][1], /部门复核.*触发条件待确认/);
  assert.doesNotMatch(result.approvals[0][1], /unknown/);
  assert.match(result.questions[0], /是否复核/);
});

test('业务版把可识别的字段比较映射到实际连线目标', () => {
  const result = buildBusinessContent({
    project: { code: 'OTHER', name: '物品领取' },
    workflow: {
      nodes: [
        { id: 'a', name: '是否复核', type: '判断' },
        { id: 'b', name: '部门复核', type: '办理' },
        { id: 'c', name: '领取完成', type: '自动步骤' },
      ],
      transitions: [
        { source: 'a', target: 'b', code: 'yes', name: '是' },
        { source: 'a', target: 'c', code: 'no', name: '否' },
      ],
    },
    rules: [{
      id: 'a', name: '是否复核', kind: '判断',
      expression: 'String value = ${"fieldReview"}; if ("是".equals(value)) { return "yes"; } return "no";',
    }],
    views: [],
    fields: [{ id: 'fieldReview', name: '需要复核', usages: [] }],
  });
  assert.deepEqual(result.approvals, [['是否复核', '「需要复核」为「是」时进入部门复核，其余进入领取完成。']]);
  assert.deepEqual(result.questions, []);
});
