import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBusinessContent, mergeEquivalentFields } from '../src/business-content.mjs';
import { atomicFieldRows, atomicRowsForWord } from '../src/field-atomic.mjs';
import { safeMemberFilters, memberScopeDescription } from '../src/debug-runtime.mjs';
test('相同规则合并字段名，不同必填或选项规则不可合并',()=>{
 const result=mergeEquivalentFields([['甲','文本','必填'],['乙','文本','必填'],['丙','文本','可选'],['甲','文本','必填']]);
 assert.deepEqual(result,[['甲','文本','必填'],['乙','文本','必填'],['丙','文本','可选'],['甲','文本','必填']]);
});
test('成员接口仅解析白名单过滤配置，不保留凭据或人员编号',()=>{
 const params=new URLSearchParams({settings:JSON.stringify({userFilters:':FACULTY',userTraversal:true,csrfToken:'secret',account:'1234567'})});
 assert.deepEqual(safeMemberFilters(params),{userFilters:':FACULTY',userTraversal:true});
 assert.deepEqual(safeMemberFilters(new URLSearchParams({settings:'broken'})),{});
 assert.match(memberScopeDescription({userFilters:'*:FACULTY'}),/尚未实测/);
});
test('静态模板必填标记不冒充办理阶段的运行时必填',()=>{
 const bundle={project:{code:'TEST'},workflow:{nodes:[],transitions:[]},views:[{id:'v',name:'主表单'}],fields:[{id:'fieldA',name:'说明',view:'主表单',required:true,usages:[{kind:'RichText'}]}],rules:[]};
 const result=buildBusinessContent(bundle);
 assert.match(result.fields[0].rows[0][2],/模板标记必填（实际阶段规则待核实）/);
});

test('字段原子化：不同 ID 不合并，同名不同 ID 保留，跨阶段汇总状态',()=>{
 const records=[
  {id:'a',name:'意见：说明',type:'富文本',view:'申请',required:true,rule:'必填'},
  {id:'b',name:'意见：说明',type:'富文本',view:'申请',required:true,rule:'必填'},
  {id:'c',name:'访问成果',type:'单行文本',view:'审核',required:false,rule:'只读'},
  {id:'a',name:'意见：说明',type:'富文本',view:'审核',required:false,rule:'只读'},
 ];
 const fields=atomicFieldRows(records,{groupName:'回国信息'});
 assert.equal(fields.length,3);
 assert.deepEqual(fields.find(f=>f.fieldId==='a').stages,['申请','审核']);
 assert.match(fields.find(f=>f.fieldId==='a').required,/申请必填/);
 assert.match(fields.find(f=>f.fieldId==='a').required,/审核可选/);
 const rows=atomicRowsForWord(fields);
 assert.equal(rows.length,3);
 assert.ok(rows.every(row=>row[0]==='回国信息'));
});

test('字段名称中的顿号和冒号不被文本拆分',()=>{
 const fields=atomicFieldRows([{id:'x',name:'是否安排打前站或团外团：说明',type:'富文本',view:'申请'}]);
 assert.deepEqual(fields.map(f=>f.fieldName),['是否安排打前站或团外团：说明']);
});
