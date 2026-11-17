import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('.agents/skills/infoplus-prd');
const skill = fs.readFileSync(path.join(root,'SKILL.md'),'utf8');
const refs = [
  'references/issue-index.md',
  'references/troubleshooting.md',
  'references/debug-playbook.md',
  'references/cross-flow-identity.md',
  'references/field-button-screenshot.md',
  'references/document-output.md',
  'references/capability-matrix.md',
];

test('Skill 主文件引用的知识库全部存在且可读取',()=>{
  for(const ref of refs){
    assert.ok(skill.includes(`](${ref})`),`SKILL.md 未引用 ${ref}`);
    const text=fs.readFileSync(path.join(root,ref),'utf8');
    assert.ok(text.trim().length>200,`${ref} 内容过短`);
  }
});

test('问题索引条目链接和锚点可被解析',()=>{
  const index=fs.readFileSync(path.join(root,'references/issue-index.md'),'utf8');
  const links=[...index.matchAll(/\]\(([^)#]+)(?:#([^)]+))?\)/g)];
  assert.ok(links.length>=15);
  const slug=value=>value.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-');
  for(const [,file,anchor] of links){
    const target=path.resolve(root,'references',file);
    const text=fs.readFileSync(target,'utf8');
    if(anchor){
      const headings=[...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map(m=>slug(m[1]));
      assert.ok(headings.includes(slug(anchor)),`${file}#${anchor} 锚点不存在`);
    }
  }
});

test('关键执行规则在 Skill 与手册中保持一致',()=>{
  for(const text of [skill,fs.readFileSync(path.join(root,'references/debug-playbook.md'),'utf8')]){
    assert.match(text,/Debug/);
    assert.match(text,/校验|必填/);
    assert.match(text,/恢复|中断/);
  }
  assert.match(skill,/只输出命名业务 Word|只交付/);
  assert.match(skill,/先读.*debug-playbook|执行决策手册/);
  assert.match(fs.readFileSync(path.join(root,'references/capability-matrix.md'),'utf8'),/待实现|部分实现/);
  assert.doesNotMatch(skill,/默认生成两份 Word/);
});
