import test from 'node:test';
import assert from 'node:assert/strict';
import { projectQuery } from '../src/project-input.mjs';
import { launchDebug } from '../src/debug-launch.mjs';

test('编号标题识别为编号，纯名称仍原样匹配',()=>{
  assert.equal(projectQuery('Z1778：教职工因公临时赴台审批'),'Z1778');
  assert.equal(projectQuery('z1525'),'Z1525');
  assert.equal(projectQuery(' 校内兼聘申请 '),'校内兼聘申请');
});

test('已授权版本不得借用于其他版本和流程',async()=>{
  const project={code:'Z1778',version:'current'};
  await assert.rejects(launchDebug(null,'unused',project,'Z0095@current','normal'),/授权/);
  await assert.rejects(launchDebug(null,'unused',project,'Z1778@previous','normal'),/授权/);
});
