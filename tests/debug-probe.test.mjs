import assert from 'node:assert/strict';
import test from 'node:test';
import { debugBoundary, debugEntry } from '../src/debug-probe.mjs';
import { buildNodeEvidence } from '../src/node-evidence.mjs';
import { debugAvailability } from '../src/debug-policy.mjs';
import { requireDebugPage } from '../src/debug-verification.mjs';

const project = {
  source: 'https://example.test/infoplus/ide/project/Test', projectCode: 'Test',
  workflowDefinitionId: '00000000-0000-0000-0000-000000000001',
};

test('探测只接受目标版本的同源非发布 Debug 入口', () => {
  const path = `/infoplus/form/${project.workflowDefinitionId}/start`;
  const query = '?release=false&entrust=true';
  assert.equal(debugEntry(path + query, project).pathname, path);
  assert.equal(debugEntry(path + query + '&release=true', project), undefined);
  assert.equal(debugEntry(path + '?release=true&entrust=true', project), undefined);
  assert.equal(debugEntry('https://other.test' + path + query, project), undefined);
  assert.equal(debugEntry(path.replace('001', '002') + query, project), undefined);
});

test('正式和测试共用回调应记录，不保存地址和凭据', () => {
  const check = dev => debugBoundary({ success: true, released: true,
    guiDefinition: `<workflow code="Test"><events><applicationEvent enabled="true"
      address="https://example.test/events?token=private" addressDev="${dev}"/></events></workflow>` }, project);
  const shared = check('https://example.test/events?token=test');
  assert.equal(shared.status, 'shared-callback');
  assert.equal(shared.callbacks.sharedEndpoints, 1);
  assert.doesNotMatch(JSON.stringify(shared), /example\.test|private/);
  assert.equal(check('https://staging.test/events').status, 'unverified');
});

test('委托中转页只有经过 IDE 启动入口才可继续核验，普通页面和正式实例不能执行动作', () => {
  assert.equal(debugAvailability({ state: 'delegation-interstitial' }).selectedMode, 'front');
  assert.match(debugAvailability({ state: 'delegation-interstitial', ideDebugEntry: true }).reason, /仍须核对/);
  const page = { release: false, entryId: 123, debugMarker: true, identityMatched: true, status: 1, executable: true };
  for (const fields of [{ release: true }, { debugMarker: false }, { entryId: undefined }, { identityMatched: false }, { executable: false }]) {
    assert.throws(() => requireDebugPage({ ...page, ...fields }, { writable: true }));
  }
  assert.doesNotThrow(() => requireDebugPage(page, { writable: true }));
});

test('前台视图观测不会把审批节点和退回路径标为已验证', () => {
  const [node] = buildNodeEvidence({
    nodes: [{ id: '1', name: '审批', view: 'v', actor: '主管' }, { id: '2', name: '填报' }],
    transitions: [{ id: 'e', source: '1', target: '2', name: '退回修改' }],
  }, [{ viewId: 'v', staticScreenshot: 'view.png' }], [], [{
    viewId: 'v', file: 'raw/field-option-observations.json', versionVerified: true,
    source: 'raw/field-option-observations.json#/observations/1', fieldId: 'reason', options: [{ label: '补充资料' }],
  }]);
  assert.deepEqual(node.optionFields, ['reason']);
  assert.equal(node.verification.page, 'front-view');
  assert.equal(node.verification.transition, 'not-verified');
  assert.equal(node.returns[0].nodeName, '填报');
  assert.equal(node.returns[0].verified, false);
});
