import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLinkedDetail, linkedFieldCandidates, selectDashboardRecord } from '../src/linked-dashboard.mjs';

test('办事中心筛选完成记录并拒绝多条相符记录', () => {
  const row = { serial: '42', path: '/infoplus/form/e42/render', status: '已完成' };
  assert.equal(selectDashboardRecord([row], { serial: '42' }).status, 'matched');
  assert.equal(selectDashboardRecord([row, { ...row }], {}).status, 'ambiguous');
  assert.equal(selectDashboardRecord([{ ...row, status: '进行中' }], {}).status, 'not-found');
  assert.equal(selectDashboardRecord([{ ...row, path: '/infoplus/form/e43/render' }], {}).status, 'not-found');
});

test('历史详情须核对发布模式、版本、人员和实际字符串业务字段', () => {
  const predecessor = { workflowDefinitionId: 'expected' };
  const criteria = { applicantAccount: '000123' };
  const detail = { serial: 42, definitionId: 'expected', release: true, status: 4, account: '000123', value: '77001000000000001' };
  assert.equal(checkLinkedDetail(detail, predecessor, criteria, '42'), true);
  for (const mismatch of [{ account: '123' }, { value: '42' }, { value: Number(detail.value) }, { definitionId: 'other' }, { release: false }]) {
    assert.equal(checkLinkedDetail({ ...detail, ...mismatch }, predecessor, criteria, '42'), false);
  }
});

test('关联字段识别保留候选状态并合并跨视图重复项', () => {
  const fields = [{ id: 'fieldPrevious', name: '原申请编号' }, { id: 'fieldItem', name: '当前标题' }];
  assert.deepEqual(linkedFieldCandidates({ fields: fields.concat(fields) }).map(item => item.fieldId), ['fieldPrevious']);
});
