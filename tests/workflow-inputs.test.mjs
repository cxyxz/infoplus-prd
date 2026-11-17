import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkflowInputs, saveWorkflowInput, inputFingerprint, mayRetryAction, applyWorkflowInputs } from '../src/workflow-inputs.mjs';

test('测试输入保留字符串精度并绑定流程版本与定义',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infoplus-inputs-'));
 try {
  const project={code:'Z1',version:'v1',workflowDefinitionId:'d1'};
  const input={fieldId:'fieldNumber',fieldName:'编号',value:'900719925474099312345',source:'用户提供',validationStatus:'待验证',nodeIds:['1']};
  await writeFile(join(dir,'Z1.json'),JSON.stringify({code:'Z1',version:'v1',definitionId:'d1',inputs:[input]}));
  assert.equal((await loadWorkflowInputs(project,dir))[0].value,'900719925474099312345');
  await saveWorkflowInput(project,{...input,value:'00001234567890123456'},dir);
  assert.equal((await loadWorkflowInputs(project,dir))[0].value,'00001234567890123456');
  await assert.rejects(loadWorkflowInputs({...project,version:'v2'},dir),/不匹配/);
  input.value=900719925474099312345;
  await writeFile(join(dir,'Z1.json'),JSON.stringify({code:'Z1',version:'v1',definitionId:'d1',inputs:[input]}));
  await assert.rejects(loadWorkflowInputs(project,dir),/无效/);
 } finally { await rm(dir,{recursive:true,force:true}); }
});

test('仅明确的业务校验失败且已记录输入改变才允许重试',()=>{
 const snapshot={kind:'input-snapshot',flowStepId:3,fingerprint:'old'};
 const fail={kind:'action',before:{flowStepId:3},submitted:true,http:200,errno:22001,success:false,responses:[{endpoint:'/infoplus/interface/doAction',error:'团组编号不存在'}]};
 assert.equal(mayRetryAction([snapshot,fail],3,'new'),true);
 assert.equal(mayRetryAction([snapshot,fail],3,'old'),false);
 assert.equal(mayRetryAction([fail],3,'new'),false);
 assert.equal(mayRetryAction([snapshot,{...fail,errno:0}],3,'new'),false);
 assert.equal(mayRetryAction([snapshot,{...fail,responses:[{endpoint:'/infoplus/interface/doAction',error:'回调超时'}]}],3,'new'),false);
 assert.notEqual(inputFingerprint([{fieldId:'f',value:'1'}]),inputFingerprint([{fieldId:'f',value:'2'}]));
});

test('不在目标可执行非发布节点写入',async()=>{
 await assert.rejects(applyWorkflowInputs({}, {workflowDefinitionId:'d'}, {release:true,definitionId:'d',status:1,executable:true}, []),/非发布/);
});

test('保留不同的既有业务输入，空值才填入并仅保存指纹',async()=>{
 const original={window:globalThis.window,document:globalThis.document,getComputedStyle:globalThis.getComputedStyle};
 const control={name:'fieldNumber',value:'existing',type:'text',disabled:false,readOnly:false,getClientRects:()=>[{}],dispatchEvent:()=>{}};
 globalThis.window={$$:{entity:{fields:{fieldNumber:{bound:true,permission:'rw',type:'string',label:'编号'}}}}};
 globalThis.document={querySelectorAll:()=>[control]}; globalThis.getComputedStyle=()=>({visibility:'visible'});
 const page={evaluate:async(fn,arg)=>fn(arg)},project={workflowDefinitionId:'d'},state={release:false,definitionId:'d',status:1,executable:true,nodeId:1};
 const inputs=[{fieldId:'fieldNumber',fieldName:'编号',value:'different',nodeIds:['1']}];
 try {
  await assert.rejects(applyWorkflowInputs(page,project,state,inputs),/已有非空/);
  assert.equal(control.value,'existing');
  control.value=''; const result=await applyWorkflowInputs(page,project,state,inputs);
  assert.equal(control.value,'different'); assert.deepEqual(result.fields,['fieldNumber']);
  assert.equal(result.fingerprint,inputFingerprint(inputs)); assert.doesNotMatch(JSON.stringify(result),/different/);
 } finally { for(const [key,value] of Object.entries(original)) { if(value===undefined) delete globalThis[key]; else globalThis[key]=value; } }
});
