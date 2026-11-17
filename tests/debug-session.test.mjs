import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesDebugAction, ordinaryConfirmation, requireDebugAuthorization} from '../src/debug-session.mjs';
import {runtimeSummary, memberScopeDescription} from '../src/debug-runtime.mjs';

test('办理请求必须匹配同源实例步骤和唯一动作，不接受重复参数或跨节点', () => {
  const request = {url:'https://example.test/infoplus/interface/doAction', method:'POST',body:'stepId=123&actionId=5'};
  assert.equal(matchesDebugAction(request,'https://example.test',123,5),true);
  for(const patch of [{body:'stepId=124&actionId=5'},{body:'stepId=123&actionId=5&actionId=6'},
    {url:'https://other.test/infoplus/interface/doAction'},{method:'GET'}])
    assert.equal(matchesDebugAction({...request,...patch},'https://example.test',123,5),false);
  assert.throws(()=>requireDebugAuthorization({code:'A',version:'v1'},'B@v1'));
});

test('实际备注确认可以继续，删除配置和校验错误不能当作审批确认', () => {
  assert.equal(ordinaryConfirmation('如有其它相关说明，请点击备注，或直接批注在填表内容处\n好\n取消','审核通过'),true);
  assert.equal(ordinaryConfirmation('确定提交吗？','提交'),true);
  for(const text of ['确定删除记录？','确定部署新版本？','请确保填写内容完整及格式正确！\n确定','已公示网站链接和上传公示内容截图，至少需要填写一个。\n确定'])
    assert.equal(ordinaryConfirmation(text,'提交'),false);
});

test('阶段观察和待办候选不等于完成审批，手动实例不计入自动覆盖', () => {
  const data={runs:[{origin:'user-manual-debug',events:[{kind:'action',success:true}]},
    {origin:'automatic-debug',instanceId:'test',events:[{kind:'stage',state:{nodeId:7,executable:true},role:'审批人'}]}]};
  const summary=runtimeSummary(data);
  assert.deepEqual(summary.observedNodes,[7]);assert.deepEqual(summary.completedNodes,[]);
  assert.deepEqual(summary.verifiedPaths,[]);assert.equal(summary.instances,1);
  assert.match(memberScopeDescription(),/不能据此认定/);
  assert.match(memberScopeDescription({userFilters:':FACULTY'}),/尚不能确定/);
});
