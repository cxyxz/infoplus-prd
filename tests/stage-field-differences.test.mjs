import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeStageFields} from '../src/stage-field-differences.mjs';
test('仅比较同实例实际跳转，缺少绑定和显隐权限分别记录',()=>{
 const stage=(step,fields)=>({kind:'stage',state:{flowStepId:step,nodeId:step,name:String(step)},fields});
 const a={id:'x',name:'审核意见',visible:true,readOnly:true,required:false};
 const events=[stage(1,[a]),stage(2,[{...a,readOnly:false,required:true},{id:'y',name:'审批人',visible:true}]),
 {kind:'resume',before:{flowStepId:1},after:{flowStepId:2}}];
 const out=analyzeStageFields({runs:[{origin:'automatic-debug',instanceId:'one',events}]});
 assert.equal(out.differences.length,2);
 assert.deepEqual(out.differences[0].changes,['当前可编辑','当前配置必填']);
 assert.match(out.differences[1].changes[0],/未采集到绑定/);
 assert.equal(analyzeStageFields({runs:[{origin:'automatic-debug',events:events.slice(0,2)}]}).differences.length,0);
 assert.equal(analyzeStageFields({runs:[{origin:'user-manual-debug',events}]}).stages.length,0);
});
