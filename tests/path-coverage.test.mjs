import test from 'node:test';import assert from 'node:assert/strict';
import {analyzePathCoverage} from '../src/path-coverage.mjs';
test('收尾邻接终点不等于实例结束，自循环不生成无限路径',()=>{
 const b={project:{},workflow:{nodes:[{id:'a',type:'办理',name:'结果'},{id:'z',type:'自动步骤',name:'结束'}],transitions:[{id:'1',source:'a',target:'a'},{id:'2',source:'a',target:'z',name:'完成'}]},debugRuns:{runs:[{origin:'automatic-debug',instanceId:'one',events:[{kind:'stage',state:{nodeId:'a',entryStatus:1}}]}]}};
 const c=analyzePathCoverage(b);assert.equal(c.obligations.length,1);assert.equal(c.counts.completedInstances,0);assert.equal(c.counts.closingInstances,1);assert.equal(c.counts.observedOperations,0);
});
test('HTTP 500 只作为技术问题，不作为业务阻断',()=>{
 const c=analyzePathCoverage({project:{},workflow:{nodes:[{id:'a',type:'办理'}],transitions:[]},debugRuns:{runs:[{origin:'automatic-debug',events:[{kind:'action',before:{nodeId:'a'},responses:[{endpoint:'/doAction',http:500,error:'broken'}]}]}]}});
 assert.equal(c.instances[0].status,'系统故障');assert.equal(c.instances[0].businessBlock,undefined);
});
test('HTTP 200 的事件回调超时仍是技术故障',()=>{
 const c=analyzePathCoverage({project:{},workflow:{nodes:[{id:'a',type:'办理'}],transitions:[]},debugRuns:{runs:[{origin:'automatic-debug',events:[{kind:'action',before:{nodeId:'a'},responses:[{endpoint:'/doAction',http:200,errno:22007,error:'EVENT_MESSENGER_TIMEOUT: Read timed out'}]}]}]}});
 assert.equal(c.instances[0].status,'系统故障');assert.equal(c.instances[0].businessBlock,undefined);
});
test('材料仍在制作属于业务等待，不计入校验失败或实例完成',()=>{
 const bundle={project:{},workflow:{nodes:[{id:'a',type:'办理'},{id:'z',type:'自动步骤'}],transitions:[{id:'1',source:'a',target:'z'}]},debugRuns:{runs:[{origin:'automatic-debug',events:[{kind:'action',before:{nodeId:'a',entryStatus:1},responses:[{endpoint:'/doAction',http:200,errno:22001,error:'材料制作中'}]}]}]}};
 const coverage=analyzePathCoverage(bundle);
 assert.equal(coverage.counts.closingInstances,1);
 assert.equal(coverage.counts.businessWaitingInstances,1);
 assert.equal(coverage.counts.businessBlockedInstances,0);
 assert.equal(coverage.counts.completedInstances,0);
});
test('外部查询失败原因未知，不断言业务数据或系统故障',()=>{
 const c=analyzePathCoverage({project:{},workflow:{nodes:[{id:'a',type:'办理'}],transitions:[]},debugRuns:{runs:[{origin:'automatic-debug',events:[{kind:'action',before:{nodeId:'a'},responses:[{endpoint:'/doAction',http:200,errno:22001,error:'查询护照状态失败，请联系技术人员检查！'}]}]}]}});
 assert.equal(c.instances[0].status,'外部查询阻断，原因待核实');assert.equal(c.counts.businessBlockedInstances,0);assert.equal(c.counts.queryBlockedInstances,1);
});
