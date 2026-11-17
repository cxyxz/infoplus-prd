import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { analyzePathCoverage } from './path-coverage.mjs';
import { basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import { entity, parseWorkflow } from './infoplus.mjs';
import { enrichField, fieldAnalysisVersion, readStaticPanels, readTemplateDefaults } from './field-options.mjs';
import { readFieldIndex, readOptionEvidence } from './option-evidence.mjs';
import { buildStagePages, stageAnalysisVersion, stageProfile } from './stage-pages.mjs';
import { debugProbeFile, readDebugProbe } from './debug-probe.mjs';
import { buildNodeEvidence, nodeEvidenceVersion } from './node-evidence.mjs';
import { readDebugRuns, debugRuntimeFile, runtimeSummary, memberScopeDescription } from './debug-runtime.mjs';
import {analyzeStageFields} from './stage-field-differences.mjs';

export const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const optional = async path => {
  try { return await json(path); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
};

const idOf = value => {
  const id = value && typeof value === 'object' ? value.id : value;
  return ['string', 'number'].includes(typeof id) ? String(id) : '';
};
function readPath(data, pointer) {
  if (pointer === '') return data;
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) return;
  return pointer.slice(1).split('/').reduce((value, key) => {
    const part = key.replaceAll('~1', '/').replaceAll('~0', '~');
    return value && Object.hasOwn(value, part) ? value[part] : undefined;
  }, data);
}

export function normalizeWorkflow(raw, mapping, source) {
  const nodes = readPath(raw, mapping.nodes);
  const transitions = readPath(raw, mapping.transitions);
  if (!Array.isArray(nodes) || !Array.isArray(transitions)) throw new Error('流程映射未指向节点和连线数组');
  const nodeFields = {
    id: '/id', name: '/name', type: '/type', view: '/viewId', actor: '/actor',
    x: '/x', y: '/y', permissions: '/permissions', actions: '/actions', ...mapping.node,
  };
  const edgeFields = {
    source: '/source', target: '/target', name: '/name', condition: '/condition', type: '/type', ...mapping.edge,
  };
  const project = (items, fields, collection) => items.map((item, index) => ({
    ...Object.fromEntries(Object.entries(fields).map(([key, path]) => [key, readPath(item, path)])),
    evidence: `${source}#${collection}/${index}`,
  }));
  return {
    nodes: project(nodes, nodeFields, mapping.nodes).map(item => ({ ...item, id: idOf(item.id), view: idOf(item.view) })),
    transitions: project(transitions, edgeFields, mapping.transitions)
      .map(item => ({ ...item, source: idOf(item.source), target: idOf(item.target) })),
  };
}

export function topology(workflow) {
  const incoming = new Map(workflow.nodes.map(node => [node.id, []]));
  const outgoing = new Map(workflow.nodes.map(node => [node.id, []]));
  for (const edge of workflow.transitions) {
    if (!outgoing.has(edge.source) || !incoming.has(edge.target)) continue;
    outgoing.get(edge.source).push(edge);
    incoming.get(edge.target).push(edge);
  }
  const canReach = (start, end) => {
    const seen = new Set();
    const queue = [start];
    while (queue.length) {
      const node = queue.pop();
      if (node === end) return true;
      if (seen.has(node)) continue;
      seen.add(node);
      for (const edge of outgoing.get(node) ?? []) queue.push(edge.target);
    }
    return false;
  };
  return {
    entries: workflow.nodes.filter(node => incoming.get(node.id).length === 0).map(node => node.id),
    exits: workflow.nodes.filter(node => outgoing.get(node.id).length === 0).map(node => node.id),
    splits: workflow.nodes.filter(node => outgoing.get(node.id).length > 1).map(node => node.id),
    merges: workflow.nodes.filter(node => incoming.get(node.id).length > 1).map(node => node.id),
    cycleTransitions: workflow.transitions.filter(edge =>
      incoming.has(edge.target) && outgoing.has(edge.source) && canReach(edge.target, edge.source))
      .map(edge => edge.evidence),
  };
}

const xsdTypes = {
  string: '文本', boolean: '布尔值', date: '日期', dateTime: '日期时间',
  time: '时间', decimal: '数字', int: '整数', integer: '整数',
  double: '数字', float: '数字', base64Binary: '二进制（控件类型待确认）',
};
const controls = {
  PlainText: '单行文本', RichText: '富文本', DropDown: '下拉选择',
  OptionButton: '单选', CheckBox: '复选', FileAttachment: '附件',
  DTPicker: '日期', DatePicker: '日期',
};

export async function analyze(directory) {
  const project = await json(join(directory, 'project.json'));
  const network = await optional(join(directory, 'raw', 'network', 'index.json'));
  const fieldIndex = await readFieldIndex(directory, network);
  const optionEvidence = await readOptionEvidence(directory, project);
  const mapping = await optional(join(directory, 'workflow-map.json'));
  const diagramObservation = await optional(join(directory, 'raw', 'editor-observation.json'));
  const evidence = [{ source: project.source, file: 'project.json', kind: 'IDE 页面记录' }];
  if (fieldIndex.source) evidence.push({ file: fieldIndex.source, kind: 'IDE 字段表' });
  for (const file of new Set(optionEvidence.map(item => item.file))) evidence.push({ file, kind: '字段选项证据' });
  const issues = await optional(join(directory, 'scan-issues.json')) ?? [];
  const observed = network?.captured ?? [];
  const latest = (kind, path) => observed.findLast(item => item.kind === kind && item.source.endsWith(path));
  const readItem = async item => {
    if (!item || basename(item.file) !== item.file) throw new Error('无效的采集资源路径');
    const file = `raw/network/${item.file}`;
    evidence.push({ source: item.source, file, kind: item.kind });
    return { file, data: await json(join(directory, file)) };
  };
  let workflow = { nodes: [], transitions: [] };
  const workflowItem = latest('workflow', '/findWorkflowDefinition');
  if (mapping) {
    const item = observed.find(r => r.kind === 'workflow' && r.file === mapping.file);
    if (!item || basename(item.file) !== item.file) throw new Error('流程映射未引用已导入的工作流响应');
    const source = `raw/network/${item.file}`;
    workflow = normalizeWorkflow(await json(join(directory, source)), mapping, source);
    evidence.push({ source: item.source, file: source, kind: '工作流响应' });
  } else if (workflowItem) {
    const { file, data } = await readItem(workflowItem);
    workflow = parseWorkflow(data, project, file) ?? workflow;
    if (!workflow.nodes.length) issues.push('工作流响应未返回有效定义');
    else {
      project.published = workflow.released;
      project.releaseEvidence = `${file}#/entities/0/released`;
    }
  } else {
    issues.push('缺少工作流响应体');
  }
  const formItem = observed.findLast(item => item.kind === 'form' && item.source.endsWith('/findFormTemplate') &&
    (!workflow.form || item.templateId === workflow.form));
  const form = formItem && await readItem(formItem);
  const formEntity = entity(form?.data);
  const formViews = new Map();
  if (Array.isArray(formEntity?.formFields) && formEntity.formTemplateId === formItem.templateId) {
    const record = (template, pointer) => formViews.set(template.formTemplateId, { template, pointer });
    record(formEntity, '#/entities/0');
    (formEntity.templateViews ?? []).forEach((template, index) => record(template, `#/entities/0/templateViews/${index}`));
  } else {
    issues.push('缺少有效的 findFormTemplate 响应，字段清单仅依据静态模板');
  }
  const viewsItem = latest('views', '/views');
  const viewIndex = viewsItem && await readItem(viewsItem);
  const indexedViews = viewIndex?.data.views ?? project.views ?? [];
  if (viewIndex && project.expectedViews && indexedViews.length !== project.expectedViews) {
    issues.push('HAR 视图目录与 IDE 索引数量不一致');
  }
  const fields = [];
  const views = [];
  for (const meta of indexedViews) {
    if (!/^[a-f0-9-]{36}$/i.test(meta.id)) throw new Error('视图 ID 格式错误');
    const path = `views/${meta.id}/xsn.json`;
    const xsn = await optional(join(directory, path));
    const view = { ...meta, source: viewIndex?.file ?? 'project.json', packageViews: [], rules: xsn?.rules ?? [] };
    if (!xsn) {
      view.templateMissing = true;
    } else {
      evidence.push({ source: meta.xsn, file: path, kind: 'XSN 静态解析' });
      view.packageViews = xsn.views.map(v => ({
        ...v, screenshot: v.screenshot && `views/${meta.id}/${v.screenshot}`,
      }));
      view.screenshot = view.packageViews.find(v => v.screenshot)?.screenshot;
      for (const child of view.packageViews.filter(v => v.issue || !v.screenshot)) {
        issues.push(`「${meta.name} / ${child.name}」静态预览失败`);
      }
    }
    const apiView = formViews.get(meta.id);
    const [panels, template] = await Promise.all([readStaticPanels(directory, view), readTemplateDefaults(directory, meta.id)]);
    for (const panel of panels) evidence.push({ file: panel.source, kind: 'XSN 控件配置' });
    if (template.source) evidence.push({ file: template.source, kind: 'XSN 默认数据' });
    const configs = new Map(fieldIndex.fields.filter(item => item.viewId === meta.id).map(item => [item.id, item]));
    const observations = new Map();
    for (const item of optionEvidence) {
      if ((item.viewId || workflow.form) !== meta.id) continue;
      if (!observations.has(item.fieldId)) observations.set(item.fieldId, []);
      observations.get(item.fieldId).push(item);
    }
    const addField = (field, definition) => fields.push(enrichField({ ...field, viewId: meta.id }, {
      config: configs.get(field.id), definition, panels, runtime: observations.get(field.id) ?? [], schemaSource: path, template,
    }));
    const usagesFor = id => view.packageViews.flatMap(v => v.controls
      .filter(control => control.binding.split('/').at(-1).split(':').at(-1) === id)
      .map(control => ({ ...control, view: v.name })));
    const apiIds = new Set();
    const getType = (type, usages) => controls[usages.find(u => Object.hasOwn(controls, u.kind))?.kind] ??
      xsdTypes[type] ?? (type || '结构或未知');
    for (const [index, field] of (apiView?.template.formFields ?? []).entries()) {
      const id = field.fieldName;
      apiIds.add(id);
      const usages = usagesFor(id);
      const schema = xsn?.fields.find(item => item.name === id);
      addField({
        id, name: field.label || field.description || usages.find(control => control.title)?.title || id,
        type: getType(field.fieldType, usages), apiType: field.fieldType,
        groupName: field.groupName, repeatDepth: field.repeatDepth,
        required: null, defaultValue: schema?.defaultValue, enumeration: schema?.enumeration,
        usages, view: meta.name, evidence: `${form.file}${apiView.pointer}/formFields/${index}`,
      }, field);
    }
    if (!apiView && formViews.size) issues.push(`「${meta.name}」未匹配接口字段`);
    view.apiFieldCount = apiView?.template.formFields?.length;
    for (const [index, field] of (xsn?.fields ?? []).entries()) {
      if (!field.name || apiIds.has(field.name)) continue;
      const references = xsn.fields.filter(item => item.ref.split(':').at(-1) === field.name);
      const type = (field.type || field.restriction[0] || '').split(':').at(-1);
      const usages = usagesFor(field.name);
      addField({
        id: field.name, name: usages.find(control => control.title)?.title || field.name,
        type: getType(type, usages),
        required: null, defaultValue: field.defaultValue, enumeration: field.enumeration,
        schemaReferences: references, usages, view: meta.name,
        evidence: `${path}#/fields/${index}`,
      });
    }
    views.push(view);
  }
  if (diagramObservation) evidence.push({
    source: project.editor, file: 'raw/editor-observation.json', kind: '编辑器图中文字',
  });
  const viewIds = new Set(views.map(view => view.id));
  for (const node of workflow.nodes) {
    if (node.view && !viewIds.has(node.view)) issues.push(`节点「${node.name ?? node.id}」视图关联未解析`);
  }
  const rules = [
    ...workflow.nodes.filter(node => node.script).map(node => ({
      kind: node.type, id: node.id, name: node.name, expression: node.script, evidence: node.evidence + '/script',
    })),
    ...workflow.transitions.flatMap(edge => [
      edge.script && { kind: '动作脚本', expression: edge.script, evidence: edge.evidence + '/script' },
      edge.restrictScript && { kind: '动作限制', expression: edge.restrictScript, evidence: edge.evidence + '/restrictScript' },
    ].filter(Boolean).map(rule => ({ ...rule, id: edge.id, name: edge.name }))),
  ];
  const reviewed = await optional(join(directory, 'reviewed-rules.json')) ?? [];
  for (const rule of rules) {
    const sha256 = createHash('sha256').update(rule.expression).digest('hex');
    const item = reviewed.find(note => note.id === rule.id && note.kind === rule.kind && note.sha256 === sha256);
    if (item) rule.interpretation = item.interpretation;
  }
  const flowTopology = topology(workflow);
  const stagePages = await buildStagePages(directory, project, workflow, flowTopology, views, await stageProfile(project));
  let debug = await readDebugProbe(directory, project);
  const debugRuns = await readDebugRuns(directory, project);
  const history = await optional(join(directory, 'raw/debug-history-evidence.json'));
  const debugHistory = history?.version === project.version && history?.definitionId === project.workflowDefinitionId &&
    debugRuns?.runs.some(run => run.instanceId === history.instanceId) ? history : undefined;
  const manualReference = await optional(join(directory, 'raw/manual-debug-reference.json'));
  const manualEvidence = manualReference?.code === project.code && manualReference?.version === project.version &&
    manualReference?.definitionId === project.workflowDefinitionId ? manualReference : undefined;
  if (manualEvidence) evidence.push({ file: 'raw/manual-debug-reference.json', kind: '用户手动 Debug 截图说明，非自动验证' });
  const debugObserved = runtimeSummary(debugRuns);
  if (debugRuns) {
    evidence.push({ file: debugRuntimeFile, kind: '按实例区分的后台 Debug 实际观察' });
    for (const field of fields) {
      const observations = debugObserved.stages.filter(s => s.state.viewId === field.viewId)
        .flatMap(s => s.fields.filter(f => f.id === field.id).map(f => ({ ...f, flowStepId: s.state.flowStepId, node: s.state.name })));
      if (!observations.length) continue;
      const latest = observations.at(-1);
      if (latest.name && latest.name !== field.id) field.name = latest.name;
      field.apiType = latest.type || field.apiType;
      field.debugObservations = observations;
      field.memberScopes = debugObserved.stages.filter(s => s.state.viewId === field.viewId)
        .flatMap(s => s.memberScopes.filter(f => f.fieldId === field.id).map(f => ({ ...f, description:memberScopeDescription(f.settings), node: s.state.name, source: debugRuntimeFile })));
    }
    debug = { ...debug, selectedMode: 'debug', reason: '已在用户授权范围内执行 Debug，覆盖仅以实际实例记录为准',
      entry: debug?.entry ?? { state: 'identity-ready' }, simulatedRoles: debugObserved.roles,
      visitedNodes: debugObserved.observedNodes, verifiedPaths: debugObserved.verifiedPaths, runtime: debugObserved };
  }
  const nodeEvidence = buildNodeEvidence(workflow, stagePages, fields, optionEvidence, debugObserved);
  if (debug) evidence.push({ file: debugProbeFile, kind: 'IDE Debug 入口与隔离检查' });
  for (const stage of stagePages) {
    if (stage.manifest) evidence.push({ source: stage.source, file: stage.manifest, kind: '前台阶段页面' });
    else if (stage.source) evidence.push({ file: stage.source, kind: 'XSN 说明页文字' });
  }
  const linkedEvidencePath = 'raw/cross-flow-evidence.json';
  const linkedEvidence = await optional(join(directory, linkedEvidencePath));
  const crossFlow = linkedEvidence?.version === project.version &&
    linkedEvidence.definitionId === project.workflowDefinitionId ? linkedEvidence : undefined;
  if (crossFlow) evidence.push({file: linkedEvidencePath, kind: '跨流程关系和字段核验证据'});
  const bundle = {
    fieldAnalysisVersion, stageAnalysisVersion, stagePages, nodeEvidenceVersion, nodeEvidence, debug, debugRuns, manualEvidence,
    stageFieldAnalysis: analyzeStageFields(debugRuns), debugHistory,
    project, workflow, fields, views, crossFlow, expectedViews: project.expectedViews ?? indexedViews.length,
    topology: flowTopology, rules, evidence, issues, diagramObservation,
  };
  await mkdir(join(directory, 'normalized'), { recursive: true });
  await writeFile(join(directory, 'normalized', 'bundle.json'), JSON.stringify(bundle, null, 2));
  bundle.pathCoverage=analyzePathCoverage(bundle);
  await mkdir(join(directory,'reports'),{recursive:true});
  await writeFile(join(directory,'reports/path-coverage.json'),JSON.stringify(bundle.pathCoverage,null,2));
  await writeFile(join(directory,'normalized/bundle.json'),JSON.stringify(bundle,null,2));
  return bundle;
}

