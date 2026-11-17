import test from 'node:test';
import assert from 'node:assert/strict';
import { selectLinkedInstance, extractLinkedBusinessValue, discoverLinkedBusinessValue } from '../src/linked-instances.mjs';

const criteria={predecessorCode:'PREV',applicant:'authorized-user',name:'业务名称',status:'已完成',fieldId:'fieldBusinessNo',release:false};
const row={applicant:'authorized-user',name:'业务名称',status:'已完成',dataPath:'/infoplus/form/123/data'};
test('关联数据必须同时匹配前置流程、申请人、业务名称和状态，多个候选不自动选取',()=>{
  assert.equal(selectLinkedInstance([row],criteria).status,'matched');
  assert.equal(selectLinkedInstance([row,row],criteria).status,'ambiguous');
  assert.equal(selectLinkedInstance([{...row,applicant:'someone-else'}],criteria).status,'not-found');
  assert.equal(selectLinkedInstance([row],{...criteria,predecessorCode:''}).status,'needs-context');
});
test('业务编号只从指定字段提取为字符串，不能用实例 ID 代替',()=>{
  assert.deepEqual(extractLinkedBusinessValue([{id:'instanceId',value:'123'}],'fieldBusinessNo'),{status:'field-unavailable'});
  assert.equal(extractLinkedBusinessValue([{id:'fieldBusinessNo',value:'33001920265590408'}],'fieldBusinessNo').value,'33001920265590408');
  assert.equal(extractLinkedBusinessValue([{id:'fieldBusinessNo',value:'1'},{id:'fieldBusinessNo',value:'2'}],'fieldBusinessNo').status,'ambiguous-field');
});
test('缺少明确可信前置流程或匹配上下文时不会打开浏览器',async()=>{
  let called=false;
  const result=await discoverLinkedBusinessValue({newPage(){called=true;}},{source:'https://example.test/infoplus/ide/project/A',code:'PREV',workflowDefinitionId:'bad'},criteria);
  assert.equal(result.status,'needs-context'); assert.equal(called,false);
});
test('只在唯一匹配后读取指定字段，并封锁写请求和外站请求',async()=>{
  let guard, current, evalCount=0, closed=false;
  const page={route:async (_pattern,fn)=>guard=fn, goto:async url=>(current=url,{ok:()=>true}), url:()=>current,
    evaluate:async ()=>++evalCount===1?[row]:[{id:'fieldBusinessNo',value:'33001920265590408'}], close:async()=>{closed=true;}};
  const predecessor={source:'https://example.test/infoplus/ide/project/PREV',code:'PREV',workflowDefinitionId:'12345678-1234-1234-1234-123456789abc'};
  const result=await discoverLinkedBusinessValue({newPage:async()=>page},predecessor,criteria);
  assert.equal(result.status,'found'); assert.equal(result.value,'33001920265590408'); assert.equal(closed,true);
  for (const [method,url] of [['POST',current],['GET','https://other.test/infoplus/form/123/data']]) {
    let aborted=false; await guard({request:()=>({method:()=>method,url:()=>url,resourceType:()=> 'document'}),abort:()=>{aborted=true;},continue:()=>{}});
    assert.equal(aborted,true);
  }
});
