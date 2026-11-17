import {bindProgress,reconcileProgress} from '../src/debug-progress.mjs';
import {dismissDialogs} from '../src/form-autofill.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, mkdtemp, rm, mkdir, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {classifyDialog, submissionOutcome} from '../src/dialog-classification.mjs';
import {ordinaryConfirmation} from '../src/debug-session.mjs';
import {version} from '../src/version.mjs';
import {prepareOfficial, officialDirectory} from '../src/output-management.mjs';
import {buildButtonMap, parseWorkflowMermaid} from '../src/node-button-map.mjs';
import {buildNodeEvidenceSections} from '../src/node-evidence-content.mjs';
import {screenshotValue, eligibleScreenshot} from '../src/screenshot-quality.mjs';

test('七类弹窗独立判断，校验和危险提示绝不成为提交确认',()=>{
 const cases=[['调试说明：仅供调试','information'],['确定提交吗？','submission-confirmation'],
 ['请选择一个选项。确定','required-validation'],['请填写姓名','required-validation'],
 ['请输入正确的联系方式。确定','format-validation'],['请确保填写内容完整及格式正确。确定','format-validation'],
 ['至少需要填写一个。确定','business-validation'],['业务编号不存在','business-validation'],
 ['外部回调超时','external-service'],['删除记录前请填写原因，确定','unknown'],['未知提示 确定','unknown']];
 for(const [text,kind] of cases){assert.equal(classifyDialog(text,'提交'),kind);assert.equal(ordinaryConfirmation(text,'提交'),['information','submission-confirmation'].includes(kind));}
});
test('缺少返回码及请求超时不算成功，也不允许盲目重试',()=>{
 const base={submitted:true,http:200,responses:[{endpoint:'/doAction'}]};
 assert.equal(submissionOutcome(base),'unknown');
 assert.equal(submissionOutcome(null),'unknown');
 assert.equal(submissionOutcome({...base,responses:[{endpoint:'/doAction',errno:0}]}),'accepted');
 assert.equal(submissionOutcome({...base,responses:[{endpoint:'/doAction',errno:1,error:'回调超时'}]}),'external-service');
});
test('package、lock、Skill 与运行时版本一致，历史版本不改',async()=>{
 const pkg=JSON.parse(await readFile('package.json','utf8')),lock=JSON.parse(await readFile('package-lock.json','utf8'));
 assert.equal(version,'1.3.1');assert.equal(pkg.version,version);assert.equal(lock.version,version);assert.equal(lock.packages[''].version,version);
 assert.match(await readFile('.agents/skills/infoplus-prd/SKILL.md','utf8'),new RegExp('version: '+version.replaceAll('.','\\.')));
 assert.match(await readFile('CHANGELOG.md','utf8'),/## 1\.1\.0/);
});
test('显式输入目录保留，不读取或写回编号目录',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infoplus-compare-'));
 try{assert.equal(await prepareOfficial(dir),resolve(dir));assert.match(officialDirectory('Z1775'),/output[\\/]Z1775$/);}
 finally{await rm(dir,{recursive:true,force:true});}
});
test('按钮名称精确映射，无目标或实例证据不算实测',()=>{
 const parsed=parseWorkflowMermaid('n1["申请 [1]"]\nn2["审核 [2]"]\nn1 --> |"提交国合处 [10]"| n2');
 const map=buildButtonMap(parsed,{verifiedActions:[{nodeId:1,label:'提交',instanceId:'test',actualTargetNodeId:2}]});
 assert.equal(map.nodes[0].buttons[0].verification,'config-confirmed');
 assert.equal(buildButtonMap(parsed,{verifiedActions:[{nodeId:1,label:'提交国合处',instanceId:'test',actualTargetNodeId:2}]}).nodes[0].buttons[0].verification,'actual-verified');
 const noId=parseWorkflowMermaid('n1 --> |"提交"| n2');assert.equal(noId.transitions[0].transitionId,null);assert.equal(noId.transitions[0].toKey,'n2');
});
test('Word 截图不跨任务、不使用 original，历史快照不声称审批成功',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infoplus-shots-'));
 try{
  await mkdir(join(dir,'debug-evidence','original'),{recursive:true});
  await writeFile(join(dir,'debug-evidence','original','raw.png'),'raw');
  await writeFile(join(dir,'debug-evidence','screenshot-index.json'),JSON.stringify({nodes:[{nodeId:1,images:[{category:'full-page',sourceVariant:'masked',file:'debug-evidence/original/raw.png'}]}]}));
  const sections=buildNodeEvidenceSections({},dir);assert.equal(sections[0].screenshots.length,0);assert.match(sections[0].description,/仅证明页面观测/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('截图分类拒绝调试错误、视口分段和未关联节点，只保留 A/B/C',()=>{
 const page={nodeId:14,complete:true,businessContent:true};
 assert.equal(screenshotValue({category:'full-page',sourceVariant:'masked',width:1021,height:2976,nodeId:14},page).category,'A');
 assert.equal(screenshotValue({category:'business-module',sourceVariant:'masked',width:1021,height:400,parentImage:'full-page.png',nodeId:14},page).category,'B');
 assert.equal(screenshotValue({category:'action-buttons',sourceVariant:'masked',width:1275,height:380,nodeId:14,labels:['审核通过'],detection:'live-full-page-bottom-crop'},page).category,'B');
 assert.equal(screenshotValue({category:'validation',width:800,height:200,nodeId:14,rule:'必填字段'},page).category,'C');
 assert.equal(screenshotValue({category:'full-page',width:1000,height:500,errorText:'Required request parameter field'}).category,'D');
 assert.equal(screenshotValue({category:'page-segment',width:959,height:913,nodeId:14},page).category,'E');
 assert.equal(screenshotValue({category:'full-page',width:959,height:913},{}).category,'E');
 assert.equal(eligibleScreenshot({quality:{category:'D',eligible:false}}),false);
});
test('节点图文只用有效截图，按钮证据必须带标签且图题按业务模块',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infoplus-shot-quality-'));
 try{
  await mkdir(join(dir,'debug-evidence','01-14'),{recursive:true});
  const write=async(name,w=1021,h=300)=>{
   const buf=Buffer.alloc(24);buf.write('89504e470d0a1a0a','hex');buf.writeUInt32BE(w,16);buf.writeUInt32BE(h,20);
   await writeFile(join(dir,'debug-evidence','01-14',name),buf);return `debug-evidence/01-14/${name}`;
  };
  const good=await write('module-01.png'),buttons=await write('action-buttons.png',1275,380);
  await write('old-segment.png',959,913);
  await writeFile(join(dir,'debug-evidence','screenshot-index.json'),JSON.stringify({code:'Z',version:'v',nodes:[{
   nodeId:14,nodeName:'审核',source:'同一实例历史只读表单',pageType:'historical-snapshot',
   images:[
    {category:'page-segment',file:'debug-evidence/01-14/old-segment.png',width:959,height:913,quality:{category:'E',eligible:false}},
    {category:'business-module',file:good,width:1021,height:300,title:'审核意见与人员',purpose:'审核意见与人员字段',parentImage:'full-page.png',quality:{category:'B',eligible:true}},
    {category:'action-buttons',file:buttons,width:1275,height:380,labels:['审核通过'],purpose:'底部按钮',quality:{category:'B',eligible:true}},
   ],buttonTransitions:[{label:'审核通过',verification:'actual-verified',targetName:'下一节点'}]
  }]}));
  const sections=buildNodeEvidenceSections({},dir);
  assert.deepEqual(sections[0].screenshots.map(s=>s.title),['审核意见与人员','节点底部操作按钮']);
  assert.ok(!JSON.stringify(sections[0].screenshots).includes('真实页面分段'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('断点绑定实例，旧记录须与实际待办一致，步骤完成不是实例结束',()=>{
 assert.throws(()=>bindProgress({instanceId:'a'},'b'));
 const p=bindProgress({trace:[{flowStepId:10}]},'a');
 assert.throws(()=>reconcileProgress(p,{instanceId:'a',flowStepId:11,status:1}));
 assert.equal(reconcileProgress(p,{instanceId:'a',flowStepId:10,status:2}),'completed-step-reconcile-tasks');
 assert.equal(p.needsReconciliation,false);
 assert.throws(()=>reconcileProgress(p,{instanceId:'b',flowStepId:10}));
});
test('多弹窗关闭后索引不漂移，未知按钮不点击',async()=>{
 const items=['请填写姓名','未知操作 确定','请输入正确的联系方式'];
 const page={locator:()=>({all:async()=>items.map((_,i)=>({
  innerText:async()=>{if(!items[i])throw Error('stale index');return items[i]},
  locator:()=>({all:async()=>[{innerText:async()=>'确定',click:async()=>items.splice(i,1)}]})
 }))})};
 const records=await dismissDialogs(page);assert.equal(records.length,2);
 assert.deepEqual(items,['未知操作 确定']);assert.ok(records.every(r=>!r.validationPassed));
});
