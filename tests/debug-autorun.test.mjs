import test from 'node:test';
import assert from 'node:assert/strict';
import { selectAutomaticAction, retryDebugProbe } from '../src/online-evidence.mjs';
import { ordinaryWelcomeAcknowledgement } from '../src/debug-launch.mjs';

test('automatic actions require exactly one standard non-remark action', () => {
  assert.equal(selectAutomaticAction([{label:'审核通过'},{label:'退回修改'}]).label,'审核通过');
  assert.equal(selectAutomaticAction([{label:'提交/Submit'}]).label,'提交/Submit');
  assert.equal(selectAutomaticAction([{label:'审核通过/Approved'}]).label,'审核通过/Approved');
  assert.equal(selectAutomaticAction([{label:'提交'},{label:'审核通过'}]),undefined);
  assert.equal(selectAutomaticAction([{label:'删除'}]),undefined);
  assert.equal(selectAutomaticAction([{label:'提交并发起报销'}]),undefined);
  assert.equal(selectAutomaticAction([{label:'提交',remarkRequired:true}]),undefined);
});
test('only read-only operations are retried a bounded number of times', async () => {
  let calls=0;
  const result=await retryDebugProbe(async()=>{ if(++calls<3) throw Error('temporary'); return 'ok'; },2);
  assert.equal(result,'ok'); assert.equal(calls,3);
  calls=0;
  await assert.rejects(retryDebugProbe(async()=>{ calls++; throw Error('down'); },1));
  assert.equal(calls,2);
});
test('transient probe results are retried but permission and stable business states are not', async () => {
  let calls=0;
  let result=await retryDebugProbe(async()=>++calls===1 ? {entry:{state:'unavailable',http:503}} : {entry:{state:'identity-ready'}},2);
  assert.equal(calls,2); assert.equal(result.entry.state,'identity-ready');
  calls=0;
  result=await retryDebugProbe(async()=>{calls++;return {entry:{state:'not-checked'},reason:'专用 Chrome 未能在时限内核对目标版本或 Debug 页面'};},2);
  assert.equal(calls,3); assert.equal(result.entry.state,'not-checked');
  for (const entry of [{state:'permission-denied'}, {state:'login-required'}, {state:'not-deployed'}, {state:'unavailable',http:403}, {state:'not-checked'}]) {
    calls=0;
    await retryDebugProbe(async()=>{calls++;return {entry,reason:'未找到与该版本匹配的非发布 Debug 入口'};},2);
    assert.equal(calls,1,entry.state);
  }
});
test('welcome acknowledgement only accepts explicit reading confirmation', () => {
  assert.equal(ordinaryWelcomeAcknowledgement('我已认真阅读'),true);
  assert.equal(ordinaryWelcomeAcknowledgement('本人已阅读以上须知'),true);
  assert.equal(ordinaryWelcomeAcknowledgement('我同意自动删除所有记录'),false);
  assert.equal(ordinaryWelcomeAcknowledgement(''),false);
});
