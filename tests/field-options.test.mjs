import test from 'node:test';
import assert from 'node:assert/strict';
import { enrichField, extractStaticControls } from '../src/field-options.mjs';
import { matchSuggest, parseSuggestResponse } from '../src/option-evidence.mjs';
import { permittedProbeRequest } from '../src/live-options.mjs';

test('静态选项保留显示名、编码和条件，默认值不借用当前申请值', () => {
  const source = 'view.xsl';
  const controls = extractStaticControls(`
    <xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform"
      xmlns:xd="http://schemas.microsoft.com/office/infopath/2003">
      <select xd:binding="my:fieldA" required="required">
        <option value="1" selected="selected">甲</option>
        <xsl:if test="my:fieldB='yes'"><option value="2">乙</option></xsl:if>
      </select>
    </xsl:stylesheet>`, source);
  const field = enrichField({ id: 'fieldA', name: '甲类' }, {
    panels: [{ controls, source, name: '填写' }], runtime: [], schemaSource: 'xsn.json',
  });
  assert.equal(field.defaultValue, '1');
  assert.equal(field.required, true);
  assert.equal(field.readOnly, null);
  assert.deepEqual(field.optionSets.map(set => [set.when, set.options]), [
    [[], [{ value: '1', label: '甲' }]],
    [[{ fieldId: 'fieldB', operator: '=', value: 'yes' }], [{ value: '2', label: '乙' }]],
  ]);
  assert.equal(field.optionStatus, 'partial');
});

test('suggest 仅在来源和字段有对应证据时保存编码和显示名称', () => {
  const project = {
    source: 'https://example.test/infoplus/ide/project/P',
    workflowDefinitionId: 'definition', views: [{ id: 'view' }],
  };
  const fields = [{ id: 'fieldA', uuid: 'field-uuid' }];
  const entry = {
    request: {
      url: 'https://example.test/infoplus/internal/suggest?token=secret',
      method: 'POST', postData: { mimeType: 'application/x-www-form-urlencoded', text: 'fieldId=field-uuid&viewId=view&q=x' },
    },
    response: { status: 200, content: { text: '{"errno":0,"entities":[{"codeId":"1","codeName":"甲","extra":"discard"}]}' } },
  };
  const result = matchSuggest(entry, project, fields);
  assert.equal(result.viewId, 'view');
  assert.equal(result.versionVerified, true);
  assert.equal(result.completeness, 'partial');
  assert.deepEqual(result.options, [{ value: '1', label: '甲' }]);
  assert.equal(result.request.searchFiltered, true);
  assert.doesNotMatch(JSON.stringify(result), /token|secret|discard/);
  assert.equal(matchSuggest(entry, project, [{ id: 'other' }]), undefined);
  assert.equal(parseSuggestResponse({ text: '{"errno":2,"entities":[{"codeId":"1","codeName":"甲"}]}' }), undefined);
});

test('隔离探测只允许已有申请页面和明确的读取请求', () => {
  const page = new URL('https://example.test/infoplus/form/1/render?theme=x');
  const allowed = (path, method, type) => permittedProbeRequest(new URL(path, page), method, type, page);
  assert.ok(allowed(page.href, 'GET', 'document'));
  assert.ok(allowed('/infoplus/interface/suggest', 'POST', 'xhr'));
  assert.equal(allowed('/infoplus/form/1/start', 'GET', 'document'), false);
  assert.equal(allowed('/infoplus/form/1/save', 'POST', 'xhr'), false);
  assert.equal(allowed('https://other.test/infoplus/interface/suggest', 'POST', 'xhr'), false);
  const render = new URL('/infoplus/interface/render', page);
  const instanceId = '12345678-1234-1234-1234-123456789abc';
  const progress = new URL(`/infoplus/interface/instance/${instanceId}/progress`, page);
  assert.ok(permittedProbeRequest(render, 'POST', 'xhr', page, { formBody: 'stepId=1&admin=false' }));
  assert.equal(permittedProbeRequest(render, 'POST', 'xhr', page, { formBody: 'stepId=2&admin=false' }), false);
  assert.equal(permittedProbeRequest(render, 'POST', 'xhr', page, { formBody: 'stepId=1&admin=true' }), false);
  assert.equal(permittedProbeRequest(render, 'POST', 'xhr', page, { formBody: 'stepId=1&stepId=2&admin=false' }), false);
  assert.ok(permittedProbeRequest(progress, 'POST', 'xhr', page, { formBody: 'stepId=1', instanceId }));
  assert.equal(permittedProbeRequest(progress, 'POST', 'xhr', page, { formBody: 'stepId=1' }), false);
  assert.equal(permittedProbeRequest(progress, 'POST', 'xhr', page,
    { formBody: 'stepId=1', instanceId: '22345678-1234-1234-1234-123456789abc' }), false);
});
