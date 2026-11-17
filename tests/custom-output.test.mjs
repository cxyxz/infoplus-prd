import assert from 'node:assert/strict';
import test from 'node:test';
import { customDocxName } from '../src/generate-custom.mjs';

test('业务版使用流程编号和名称，不重复采集标题中的编号', () => {
  assert.equal(customDocxName({ code: 'Z0095', name: '教职工因公临时出国、赴港澳审批' }),
    'Z0095：教职工因公临时出国、赴港澳审批需求文档.docx');
  assert.equal(customDocxName({ code: 'Z1778', name: 'Z1778:教职工因公临时赴台审批' }),
    'Z1778：教职工因公临时赴台审批需求文档.docx');
});

test('业务版处理 Windows 不支持的字符、保留设备名和长标题', () => {
  const file = customDocxName({ code: 'CON.old', name: '../物品:"申请"?* ' + '📄'.repeat(120) });
  assert.doesNotMatch(file, /[<>:"/\\|?*\u0000-\u001f]/);
  assert.match(file, /^_CON\.old：/);
  assert.ok(file.length <= 170);
  assert.ok(file.isWellFormed());
});
