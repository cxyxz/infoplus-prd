import fs from 'node:fs';
const read=f=>fs.readFileSync(f,'utf8');
const edit=(f,fn)=>fs.writeFileSync(f,fn(read(f)));
for(const f of ['package.json','package-lock.json']) edit(f,t=>{const j=JSON.parse(t);j.version='1.3.0';if(j.packages?.[''])j.packages[''].version='1.3.0';return JSON.stringify(j,null,2)+'\n'});
edit('tests/v12-stability.test.mjs',t=>t.replace("assert.equal(version,'1.2.1')","assert.equal(version,'1.3.0')"));
edit('config/requirements-custom.json',t=>{const j=JSON.parse(t);j.sections=[['scope','业务概述'],['association','前置业务与数据关联'],['flow','完整业务流程'],['roles','流程节点与办理角色'],['fields','表单字段清单'],['nodeEvidence','核心办理节点图文说明'],['approvals','业务分支与流转规则'],['questions','待确认事项']].map(([key,title])=>({key,title}));return JSON.stringify(j,null,2)+'\n'});
edit('scripts/v12-output-smoke.mjs',t=>t.replace("const word=await readFile(join(directory,'requirements.docx'));assert.equal(word.readUInt32LE(0),0x04034b50);", "const official=(await readdir(directory)).find(f=>f.endsWith('需求文档.docx')); assert.ok(official); const word=await readFile(join(directory,official));assert.equal(word.readUInt32LE(0),0x04034b50);").replace('assert.equal(words.length,2)','assert.equal(words.length,1)').replace("join(home,'output/Z1775/requirements.docx')","join(home,'output/Z1775',official)"));
