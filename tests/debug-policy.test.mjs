import test from 'node:test';
import assert from 'node:assert/strict';
import { loadDebugPolicy, debugAvailability, assertOrdinaryDebugAction, assertCallbacksAllowed } from '../src/debug-policy.mjs';
import { ordinaryConfirmation } from '../src/debug-session.mjs';
import { probeDebug } from '../src/debug-probe.mjs';

test('默认优先 Debug，共享回调不是回退条件', () => {
  const policy = loadDebugPolicy();
  assert.equal(policy.preferred, true);
  assert.equal(policy.autoRun, true);
  assert.equal(policy.allowExistingWorkflowCallbacks, true);
  assert.equal(debugAvailability({ state: 'identity-ready', boundary: { status: 'shared-callback' } }, policy).selectedMode, 'debug');
  assert.equal(debugAvailability({ state: 'not-deployed' }, policy).selectedMode, 'front');
  assert.equal(debugAvailability({ state: 'permission-denied' }, { ...policy, fallbackToFrontend: false }).selectedMode, 'unavailable');
});

test('禁用回调时仅接受已核实零启用回调', () => {
  const policy = { ...loadDebugPolicy(), allowExistingWorkflowCallbacks: false };
  assert.throws(() => assertCallbacksAllowed(policy));
  assert.throws(() => assertCallbacksAllowed(policy, { callbacks: { enabled: 1 } }));
  assert.doesNotThrow(() => assertCallbacksAllowed(policy, { callbacks: { enabled: 0 } }));
});

test('前期版本地址校验失败也遵循关闭前台回退配置', async () => {
  const policy = { ...loadDebugPolicy(), fallbackToFrontend: false };
  const result = await probeDebug(null, { source: 'https://invalid.test/not-ide', editor: '' }, policy);
  assert.equal(result.selectedMode, 'unavailable');
});

test('只允许常规 Debug 动作，普通确认可处理，危险动作仍拒绝', () => {
  for (const label of ['提交', '审核通过', '退回修改', '重新提交']) assert.doesNotThrow(() => assertOrdinaryDebugAction(label));
  for (const label of ['提交/Submit', '审核通过/Approved', '退回修改/Return for Modification', '重新提交/Submit again']) assert.doesNotThrow(() => assertOrdinaryDebugAction(label));
  for (const label of ['删除记录', '发布流程', '部署', '终止流程', '注销账户', '同步真实数据', '提交付款', '其他未知操作', '提交/Delete', '提交/Submit and synchronize data', '审核通过/Submit']) assert.throws(() => assertOrdinaryDebugAction(label));
  assert.throws(() => assertOrdinaryDebugAction('提交', { allowNormalWorkflowActions: false }));
  assert.equal(ordinaryConfirmation('确定提交吗？', '申请人提交并打印'), true);
  assert.equal(ordinaryConfirmation('确认删除记录？', '删除记录'), false);
});
