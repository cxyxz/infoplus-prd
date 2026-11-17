import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import { workflowOrder, businessControl } from '../src/workflow-order.mjs';
import { buildButtonMap, parseWorkflowMermaid } from '../src/node-button-map.mjs';
import { chooseFields } from '../src/node-evidence-content.mjs';
import { businessTextFormatter, businessAssociation } from '../src/business-presentation.mjs';
import fs2 from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

test('V1.3 顺序来自拓扑，汇合晚于两个并行节点，退回不形成排序循环', () => {
  const nodes = ['end','b','start','join','a'].map(id => ({id,name:id,type:'办理'}));
  const transitions = [['start','a'],['start','b'],['a','join'],['b','join'],['join','end']]
    .map(([source,target])=>({source,target,name:'通过'}));
  transitions.push({source:'end',target:'start',name:'退回修改'});
  const ordered=workflowOrder({nodes,transitions});
  assert.equal(ordered[0].id,'start');
  assert.equal(ordered.at(-1).id,'end');
  assert.equal(ordered.find(n=>n.id==='a').topologyLevel,ordered.find(n=>n.id==='b').topologyLevel);
  assert.ok(ordered.findIndex(n=>n.id==='join')>ordered.findIndex(n=>n.id==='b'));
  assert.deepEqual(workflowOrder({nodes:[...nodes].reverse(),transitions:[...transitions].reverse()}).map(n=>n.id),ordered.map(n=>n.id));
});

test('V1.3 业务控件不退化为 string',()=>{
  for(const [field,want] of [[{type:'string',name:'上传附件'},'附件上传'],
    [{type:'User'},'成员选择'],[{apiType:'Organize'},'部门选择'],
    [{usages:[{kind:'DatePicker'}]},'日期选择']]) assert.equal(businessControl(field),want);
});

test('V1.3 同动作副本合并，同名不同动作保留，未知提交不标成功',()=>{
  const parsed=parseWorkflowMermaid('n1["入口 [1]"]\nn2["甲 [2]"]\nn3["乙 [3]"]\nn1 --> |"提交 [10]"| n2\nn1 --> |"提交 [11]"| n3');
  const map=buildButtonMap(parsed,{observedButtons:{1:[
    {text:'提交',actionId:'action_123_10'}, {text:'提交',actionId:'action_123_10'},
    {text:'终止终止流程',actionId:'action_123_kill',kill:true,tip:'终止流程'},
    {text:'终止 终止流程',actionId:'action_123_kill',kill:true,tip:'终止流程'},
  ]},verifiedActions:[{nodeId:1,label:'提交',instanceId:'test',actualTargetNodeId:2}]});
  const buttons=map.nodes[0].buttons;
  assert.equal(buttons.length,3);
  assert.equal(buttons.filter(b=>b.label==='终止').length,1);
  assert.equal(buttons.filter(b=>b.verification==='actual-verified').length,0);
});

test('V1.3 节点字段不重复通用只读字段，也不漏可编辑附件',()=>{
  const bundle={fields:[{id:'a',name:'继承姓名'},{id:'b',name:'上传附件'}]};
  const rows=chooseFields(bundle,{fields:['a','b']},[{fields:[
    {id:'a',readOnly:true,required:true,visible:true,permission:'r'},
    {id:'b',readOnly:false,required:true,visible:true,permission:'rw',type:'string'},
  ]}]);
  assert.equal(rows.length,1);
  assert.equal(rows[0][0].name,'上传附件');
});

test('V1.3 固定章节顺序与单 Word 发布入口',()=>{
  const config=JSON.parse(fs.readFileSync('config/requirements-custom.json','utf8'));
  assert.deepEqual(config.sections.map(s=>s.key),['scope','association','flow','roles','fields','nodeEvidence','approvals','questions']);
  const source=fs.readFileSync('src/generate.mjs','utf8');
  assert.doesNotMatch(source,/writeWordAtomic\(/);
  assert.doesNotMatch(fs.readFileSync('src/cli.mjs','utf8'),/documents = \{ detailed/);
});

test('V1.3 受控身份及实例数据不进入业务正文，原始证据不改写',()=>{
  const bundle={fields:[{id:'fieldNumber',name:'申请人工号'}],
    crossFlow:{summary:['前置流程确认为 TEST（测试业务），定义 ID 12345678-1234-1234-1234-123456789012。',
    '姓名测试甲。登录身份测试乙(A123456)。验证关联关系成立。'],
    fields:[['fieldNumber','binding','姓名测试甲 工号1234567','只读']],limits:[]}};
  const before=JSON.stringify(bundle);
  const fmt=businessTextFormatter(bundle);
  assert.doesNotMatch(fmt(bundle.crossFlow.summary.join(' ')),/测试甲|测试乙|A123456|12345678-1234/);
  assert.equal(fmt('fieldNumber'),'申请人工号');
  assert.deepEqual(businessAssociation(bundle).fields[0].labels,['申请人工号']);
  assert.equal(JSON.stringify(bundle),before);
});

test('V1.3.1 字段清单六列原子化，DOCX 表格实际保持一字段一行',async()=>{
 const config=JSON.parse(fs.readFileSync('config/requirements-custom.json','utf8'));
 assert.equal(config.word.fieldsColumns.length,6);
 const bundle={
  project:{code:'ZTEST',name:'测试流程',version:'v1'},
  workflow:{nodes:[],transitions:[],startView:'v1'},
  views:[{id:'v1',name:'01流程视图'}],
  fields:[
   {id:'f1',name:'出访单位审核意见',view:'01流程视图',required:true,usages:[{kind:'RichText'}]},
   {id:'f2',name:'访问成果',view:'01流程视图',required:true,usages:[{kind:'RichText'}]},
   {id:'f3',name:'未归还原因',view:'01流程视图',required:true,usages:[{kind:'RichText'}]},
  ],
  rules:[],stageFieldAnalysis:{special:[]},
 };
 const {buildBusinessContent}=await import('../src/business-content.mjs');
 const content=buildBusinessContent(bundle);
 assert.ok(content.fields.some(group=>group.fields.length>=3));
 const dir=await fs2.mkdtemp(join(os.tmpdir(),'infoplus-v131-'));
 try{
  await fs2.mkdir(join(dir,'views'));
  const custom=await import('../src/generate-custom.mjs');
  const docs=await custom.generateCustom(bundle,dir);
  const docPath=resolve(dir,typeof docs==='string'?docs:docs.docxPath);
  const out=join(dir,'rendered');
  execFileSync(process.execPath,['scripts/inspect-docx.mjs',docPath,out],{stdio:'pipe'});
  const report=JSON.parse(fs.readFileSync(join(out,'report.json'),'utf8'));
  assert.ok(report.tables.some(table=>table.headers.join('|').includes('字段名称|字段类型|必填|出现阶段|数据来源/规则')),JSON.stringify(report.tables.map(t=>t.headers)));
  const expected=new Set(content.fields.flatMap(group=>group.fields.map(field=>field.fieldName)));
  const globalTables=report.fieldTables.filter(table=>table.rows.length>1);
  for(const table of globalTables) for(const row of table.rows) {
    if(!row[1] || /、/.test(row[1]) && !expected.has(row[1])) assert.fail(`字段表出现非原子字段名称：${row[1]}`);
  }
  assert.ok([...expected].some(name=>name==='出访单位审核意见'));
 }finally{await fs2.rm(dir,{recursive:true,force:true});}
});
