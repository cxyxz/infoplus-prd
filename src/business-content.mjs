import { memberScopeDescription } from './debug-runtime.mjs';
import { businessControl } from './workflow-order.mjs';
import { atomicFieldRows } from './field-atomic.mjs';
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const viewLabel = name => clean(name).replace(/^\d+\s*/, '');
const hiddenName = /^(?:辅助|内部变量|系统变量|隐藏字段|点击查询)|(?:辅助字段|控件提示|隐藏标志|短信通知)$/u;
const displayControl = new Map([
  ['User', '成员选择'], ['Organize', '部门选择'], ['Code', '下拉选择'],
  ['date', '日期选择'], ['dateTime', '日期时间'], ['boolean', '复选框'],
  ['int', '数字'], ['integer', '数字'], ['decimal', '数字'], ['double', '数字'],
  ['CheckBox', '复选框'], ['OptionButton', '单选'], ['DropDown', '下拉选择'],
  ['RichText', '多行文本'], ['FileAttachment', '附件上传'], ['DatePicker', '日期选择'],
  ['DTPicker', '日期选择'],
]);

export function businessOrder(bundle, profile) {
  if (bundle.stagePages?.length) {
    const views = new Map(bundle.views.map(view => [view.id, view]));
    return bundle.stagePages.map(stage => views.get(stage.viewId)).filter(Boolean);
  }
  const nodes = new Map(bundle.workflow.nodes.map(n => [n.id, n]));
  const adjacent = new Map();
  for (const edge of bundle.workflow.transitions) {
    if (!adjacent.has(edge.source)) adjacent.set(edge.source, []);
    if (!/退回|重新|刷新|否决/.test(edge.name)) adjacent.get(edge.source).push(edge.target);
  }
  const starts = profile?.startNode ? [profile.startNode] : bundle.topology?.entries ?? [];
  const queue = starts.slice();
  const visited = new Set();
  const ordered = new Set([bundle.workflow.startView, ...profile?.viewOrder ?? []].filter(Boolean));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index];
    if (visited.has(id) || !nodes.has(id)) continue;
    visited.add(id);
    const node = nodes.get(id);
    if (node.view) ordered.add(node.view);
    if (node.printView) ordered.add(node.printView);
    queue.push(...(adjacent.get(id) ?? []));
  }
  for (const view of bundle.views) ordered.add(view.id);
  const views = new Map(bundle.views.map(view => [view.id, view]));
  return [...ordered].map(id => views.get(id)).filter(Boolean);
}

function reviewText(rule, overrides) {
  const override = overrides?.[rule.id];
  return override && override.review === rule.interpretation ? override.text : rule.interpretation;
}

export function buildBusinessContent(bundle, profile) {
  const title = clean(bundle.project.name || bundle.project.code);
  const views = businessOrder(bundle, profile);
  const nodes = new Map(bundle.workflow.nodes.map(n => [n.id, n]));
  const decisionRules = new Map((bundle.rules ?? []).filter(r => r.kind === '判断').map(r => [r.id, r]));
  const groups = new Map();
  for (const edge of bundle.workflow.transitions) {
    if (edge.condition || edge.restrictScript || nodes.get(edge.source)?.type === '判断') {
      if (!groups.has(edge.source)) groups.set(edge.source, []);
      groups.get(edge.source).push(edge);
    }
  }
  for (const [id] of groups) {
    if (!decisionRules.has(id)) decisionRules.set(id, { id, name: nodes.get(id)?.name ?? '条件分流' });
  }
  const labels = new Set();
  const approvals = [];
  const questions = [...profile?.questions ?? []];
  if (bundle.debug?.boundary?.status === 'shared-callback' && !bundle.debugRuns?.runs?.length) {
    questions.push('调试和正式流程共用外部回调；核对事件的实际副作用、审批人和通知，并依据运行证据验收未验证路径。');
  }
  for (const [id, rule] of decisionRules) {
    const condition = profile?.approvalLabels?.[id] || clean(rule.name);
    const edges = bundle.workflow.transitions.filter(edge => edge.source === id);
    const reviewed = reviewText(rule, profile?.ruleWording) || simpleDecision(rule.expression, edges, nodes, bundle.fields);
    const branches = edges
      .map(edge => `${edge.name} → ${nodes.get(edge.target)?.name ?? '待核对的环节'}`);
    const outcome = reviewed || (branches.length ? `已配置路径为${branches.join('、')}。触发条件待确认。` : '触发条件及后续处理待确认。');
    const key = condition + outcome;
    if (labels.has(key)) continue;
    labels.add(key);
    approvals.push([condition, outcome]);
    if (!reviewed) questions.push(`确认「${condition}」的触发条件和边界取值。`);
  }
  const requirements = (bundle.rules ?? []).filter(rule => rule.kind === '动作脚本' && rule.interpretation)
    .map(rule => reviewText(rule, profile?.ruleWording))
    .filter(text => text && !/^静态动作脚本：/.test(text));
  // Historical blockers are evidence only while the later DEBUG record has not resolved them.
  const runtimeEvidence = JSON.stringify({
    stages: bundle.debug?.runtime?.stages ?? [],
    completedNodes: bundle.debug?.runtime?.completedNodes ?? [],
    debugRuns: bundle.debugRuns?.runs ?? [],
    pathCoverage: bundle.pathCoverage ?? {},
  });
  const laterDebugReachedForm = runtimeEvidence.includes('申请人填写');
  const resolvedBlocker = /22001|护照状态查询失败|团组编号不存在/;
  for (const requirement of profile?.requirements ?? []) {
    if (laterDebugReachedForm && resolvedBlocker.test(requirement)) continue;
    // Cross-flow evidence records the later successful association; keep it there only.
    if (/申请人选择节点填入团组编号并提交/.test(requirement)) continue;
    requirements.push(requirement);
  }
  requirements.push(...(bundle.manualEvidence?.issues ?? []).map(issue => issue.requirement).filter(Boolean));
  for (const issue of bundle.manualEvidence?.issues ?? []) questions.push(`旧系统问题（用户手动观察）：${issue.description}`);
  const runtime = bundle.debug?.runtime;
  const actions=bundle.pathCoverage?.obligations ?? [];
  for(const path of actions.filter(path=>path.kind==='退回或重提' && path.evidence.length)) {
    requirements.push(`Debug 已确认「${path.name.replace(' → ','」后转入「')}」。其他返回路径按各自证据确认。`);
  }
  for(const run of bundle.pathCoverage?.instances ?? []) if(run.identityBlock && run.pendingNode) {
    questions.push(`已产生「${run.pendingNode}」待办。请验收发起人收到待办、修改和重新提交后的流转。`);
  }
  for(const run of bundle.pathCoverage?.instances ?? []) {
    if(run.status.startsWith('主要审批')) requirements.push('已观察路径进入最终材料办理阶段，尚未完成流程。材料就绪后仍须执行完成操作；外部生成服务状态待核实。');
  }
  const runtimeErrors = (bundle.debugRuns?.runs ?? []).flatMap(run => run.events)
    .flatMap(event => event.responses ?? []).filter(response => response.http===200 && response.errno && response.error &&
      !/EVENT_MESSENGER_TIMEOUT|Read timed out|connection|网络|服务器异常/i.test(response.error));
  for (const error of [...new Set(runtimeErrors.map(e => e.error))]) {
    requirements.push(`实际办理校验：${error}`);
  }
  if (runtime?.stages?.length) {
    const missing = bundle.workflow.nodes.filter(n => n.type === '办理' && !runtime.completedNodes.map(String).includes(String(n.id)));
    if (missing.length) questions.push(`仍未完成自动运行验收的办理节点有 ${missing.length} 个；其路径与权限以配置为依据，不能视为已实测通过。`);
  }
  if (laterDebugReachedForm) {
    for (const question of [...questions]) {
      if (/护照状态查询失败的服务日志|成功关联后哪些字段会自动带出尚未实测/.test(question))
        questions.splice(questions.indexOf(question), 1);
    }
  }
  if (laterDebugReachedForm) {
    for (const requirement of [...requirements]) {
      if (/申请人填写节点提交被本地校验阻断|查询护照状态失败/.test(requirement))
        requirements.splice(requirements.indexOf(requirement), 1);
    }
  }
  const manualNodes = bundle.workflow.nodes.filter(node => node.type === '办理');
  const returnTargets = [...new Set(bundle.workflow.transitions.filter(e => /退回/.test(e.name))
    .map(e => nodes.get(e.target)?.name).filter(Boolean))];
  const resubmits = bundle.workflow.transitions.filter(e => /重新提交/.test(e.name)).length;
  const rejects = bundle.workflow.transitions.filter(e => /否决|不通过/.test(e.name));
  const entry = bundle.stagePages?.find(stage => stage.binding === '入口');
  const begin = entry?.actions?.find(action => action.purpose === '进入流程的首个办理步骤');
  const acknowledge = entry?.actions?.find(action => action.purpose === '确认已阅读办理说明');
  const next = entry?.nextStages?.length ? `进入「${entry.nextStages.join('、')}」` : '进入正式申请';
  const entryFlow = entry && `申请人先阅读办理说明${acknowledge ? `，勾选「${acknowledge.label}」` : ''}，再${begin ? `点击「${begin.label}」` : ''}${next}。`;
  const flow = profile?.flow ?? [
    !entry && bundle.workflow.startView && views.length ? `办事入口显示「${viewLabel(views[0].name)}」。` : '',
    ...views.filter(v => v.id !== bundle.workflow.startView).slice(0, 8).map(v => {
      const stages = [...new Set(manualNodes.filter(n => n.view === v.id).map(n => n.name))];
      return stages.length ? `「${viewLabel(v.name)}」用于${stages.join('、')}。` : '';
    }),
    bundle.workflow.nodes.length ? '各路径及结束关系见附录 A。' : '办理路径需补齐流程定义后确认。',
  ].filter(Boolean);
  const returnNotes = profile?.returns ?? [
    returnTargets.length ? `定义包含退回动作，目标包括${returnTargets.join('、')}。${resubmits ? '退回后可按配置重新提交。' : ''}` : '',
    rejects.length ? '配置包含审批否决或不通过动作。其结束行为以验收结果为准。' : '',
  ].filter(Boolean);
  if (!profile) {
    if (manualNodes.some(n => /executors=|departments=/.test(n.actor))) questions.push('确认按表单或组织解析审批人员时的候选范围、多人及空结果处理。');
    if (bundle.workflow.nodes.some(n => n.type === '分流')) questions.push('确认并行审批的汇合、退回及未完成待办处理。');
    if (rejects.length) questions.push('确认否决后是否结束、能否修改重提及如何告知申请人。');
    if (bundle.workflow.externalEvents?.some(e => e.enabled)) questions.push('确认外部业务服务的输入、结果回写和失败处理。');
  }
  return {
    title, scope: [...(profile?.scope ?? [
      `本流程办理「${title}」。`,
      ...(!manualNodes.length ? ['申请与办理角色需补齐节点配置后确认。'] : []),
      ...roleSummary(manualNodes),
    ]), ...(entry ? ['办理范围包括申请前的说明页面。申请人先阅读办理说明，再进入申请。'] : [])],
    flow: [entryFlow, ...flow].filter(Boolean), approvals, approvers: profile?.approvers ?? [], returnNotes, requirements: [...new Set(requirements)],
    fields: businessFields(bundle, views, profile), questions: [...new Set(questions)], views,
  };
}

function simpleDecision(expression, edges, nodes, fields) {
  if (!expression || edges.length !== 2 || edges.some(edge => edge.restrictScript)) return;
  // Parse an exact, side-effect-free Java-shaped comparison. Never evaluate a script.
  const match = expression.trim().match(/^String\s+(\w+)\s*=\s*\$\{\s*"([\w]+)"\s*\}\s*;\s*if\s*\(\s*"([^"\\]+)"\.equals\(\1\)\s*\)\s*\{?\s*return\s*"([\w]+)"\s*;\s*\}?\s*return\s*"([\w]+)"\s*;$/u);
  if (!match) return;
  const [, , fieldId, literal, whenTrue, whenFalse] = match;
  const label = fields.find(field => field.id === fieldId && field.name !== fieldId)?.name;
  const target = code => nodes.get(edges.find(edge => edge.code === code)?.target)?.name;
  const yes = target(whenTrue);
  const no = target(whenFalse);
  if (label && yes && no && whenTrue !== whenFalse) return `「${label}」为「${literal}」时进入${yes}，其余进入${no}。`;
}

function roleSummary(nodes) {
  const groups = [...new Set(nodes.flatMap(node => clean(node.actor).split(/[；/]/))
    .map(role => role.replace(/^.+?_/u, ''))
    .filter(role => role && !role.includes('=') && !/^VAR_/.test(role)))];
  const sourceActors = nodes.filter(node => /_VAR_OWNER_ACCOUNT/.test(node.actor ?? ''))
    .flatMap(node => clean(node.actor).split('；')[0].split(' / ')).filter(Boolean);
  const applicant = [...new Set(sourceActors)];
  return [
    applicant.length ? `发起人办理环节的配置角色包括${applicant.join('、')}。` : '',
    groups.length ? `办理角色包括${groups.slice(0, 10).join('、')}${groups.length > 10 ? '等' : ''}。` : '',
  ].filter(Boolean);
}

function choiceNotes(records, names, optionLabels) {
  const options = new Map();
  const defaults = new Set();
  const linkages = new Set();
  const conditionText = items => {
    if (!items?.length) return '';
    const conditions = items.map(item => {
      const name = names.get(item.fieldId);
      const label = item.label || optionLabels.get(item.fieldId)?.get(String(item.value));
      return name && label ? `「${name}」${item.operator === '!=' ? '不为' : '为'}「${label}」` : null;
    });
    return conditions.every(Boolean) ? conditions.join('且') : null;
  };
  for (const record of records) {
    for (const set of record.optionSets ?? []) {
      const labels = [...new Set(set.options.map(option => option.label).filter(Boolean))];
      if (!labels.length) continue;
      const condition = conditionText(set.when);
      if (condition === null) {
        linkages.add('存在条件选项，适用条件见字段清单。');
        continue;
      }
      const kind = set.kind === 'user-confirmed' ? '固定选项（业务方确认）' :
        set.kind === 'user-reported' ? '已返回选项（业务方提供）' :
        set.completeness === 'complete' ? '可选' : set.versionVerified === false ? '当前页观测到的选项（版本待核对）' : '已观测选项';
      const key = JSON.stringify([condition, kind, labels]);
      if (!options.has(key)) options.set(key, { condition, kind, labels, stages: new Set() });
      if (set.viewScoped !== false) options.get(key).stages.add(viewLabel(record.view));
      if (record.defaultValue != null) {
        const selected = set.options.find(option => String(option.value) === String(record.defaultValue));
        if (selected?.label) defaults.add(`${viewLabel(record.view)}默认「${selected.label}」。`);
      }
    }
    for (const dependency of record.dependencies ?? []) {
      if (dependency.kind === 'template-visibility') {
        const alternatives = dependency.alternatives.map(conditionText);
        if (alternatives.length && alternatives.every(Boolean)) {
          linkages.add(`${viewLabel(record.view)}模板在${alternatives.join('或')}时显示此控件。`);
        }
      } else if (dependency.kind === 'observed-change' && dependency.versionVerified !== false) {
        const condition = conditionText(dependency.when);
        const changes = dependency.changes.filter(change => names.has(change.fieldId)).map(change => {
          const label = `「${names.get(change.fieldId)}」`;
          if (change.before.visible !== change.after.visible) return label + (change.after.visible ? '显示' : '隐藏');
          if (change.before.required !== change.after.required) return label + (change.after.required ? '必填' : '取消必填');
          if (change.before.readOnly !== change.after.readOnly) return label + (change.after.readOnly ? '只读' : '可编辑');
        }).filter(Boolean);
        if (condition && changes.length) linkages.add(`${viewLabel(record.view)}观测到${condition}时，${changes.slice(0, 4).join('、')}。`);
      }
    }
  }
  // An empty template value is not a runtime default; explain this once above the table.
  const sentences = [...options.values()].slice(0, 5).map(({ condition, kind, labels, stages }) => {
    const stage = stages.size === 1 ? [...stages][0] : '';
    const prefix = [stage, condition && `${condition}时`, kind].filter(Boolean).join('，');
    return labels.length <= 8 ? `${prefix}${labels.map(label => `「${label}」`).join('、')}。` :
      `${prefix}共 ${labels.length} 项，见字段清单。`;
  });
  if (!sentences.length && records.some(record => record.optionStatus)) sentences.push('选项待核对。');
  if (options.size > 5) sentences.push('其他阶段或条件的选项见字段清单。');
  const defaultGroups = new Map();
  for (const text of defaults) {
    const match=text.match(/^(.*?)默认(.*)$/);
    if(!match) continue;
    if(!defaultGroups.has(match[2])) defaultGroups.set(match[2],[]);
    defaultGroups.get(match[2]).push(match[1]);
  }
  return [...sentences, ...[...defaultGroups].map(([value,stages])=>`${stages.join('、')}默认${value}`), ...[...linkages].slice(0, 4)];
}

function businessFields(bundle, views, profile) {
  const byField = new Map();
  for (const field of bundle.fields) {
    if (!field.id || /^_VAR_/i.test(field.id) || field.visible === false) continue;
    if (!byField.has(field.id)) byField.set(field.id, []);
    byField.get(field.id).push(field);
  }
  const names = new Map([...byField].flatMap(([id, records]) => {
    const name = profile?.fields?.[id]?.name || records.find(record => record.name && record.name !== id)?.name;
    return name && !profile?.fields?.[id]?.exclude && !hiddenName.test(name) ? [[id, name]] : [];
  }));
  const optionLabels = new Map();
  for (const [id, records] of byField) {
    const labels = new Map();
    for (const option of records.flatMap(record => record.optionSets ?? []).flatMap(set => set.options)) {
      if (option.value == null || !option.label) continue;
      const value = String(option.value);
      labels.set(value, !labels.has(value) || labels.get(value) === option.label ? option.label : null);
    }
    if (labels.size) optionLabels.set(id, labels);
  }
  const groups = new Map();
  const order = new Map(views.map((v, i) => [v.name, i]));
  for (const [id, records] of byField) {
    const note = profile?.fields?.[id];
    if (note?.exclude) continue;
    const bound = records.filter(record => record.usages?.length);
    const name = names.get(id);
    if (!bound.length || !name || hiddenName.test(name)) continue;
    const typeHints = new Set([
      ...records.map(record => record.apiType),
      ...bound.flatMap(record => record.usages.map(usage => usage.kind)),
    ]);
    const type = note?.type ?? businessControl({ name, usages: [...typeHints].map(kind => ({ kind })) });
    const stageNames = [...new Set(bound.map(record => record.view))]
      .sort((a,b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity));
    const businessStages = stageNames.filter(stage => stage !== bundle.views.find(v => /^00主表单/.test(v.name))?.name);
    const stages = businessStages.length ? businessStages : stageNames;
    const stage = viewLabel(stages[0]);
    const matchedGroup = profile?.groupPatterns?.find(item => new RegExp(item.pattern, 'u').test(name))?.group;
    const group = note?.group || matchedGroup || stage || '其他已识别字段';
    const known = [
      ...new Set(records.flatMap(record => [
        typeof record.required === 'boolean' ? `${viewLabel(record.view)}模板标记${record.required ? '必填' : '可选'}（实际阶段规则待核实）` : '',
        record.readOnly === true ? `${viewLabel(record.view)}只读` : '',
        typeof record.visibilityRule === 'string' ? record.visibilityRule : '',
        typeof record.linkageRule === 'string' ? record.linkageRule : '',
      ]).filter(Boolean)),
    ];
    const usage = stages.length > 1 ? `在${stages.slice(0,2).map(viewLabel).join('、')}${stages.length > 2 ? '等阶段' : ''}使用。` : '';
    const choices = choiceNotes(records, names, optionLabels);
    // Group identical range evidence; repeated observations do not add a new rule.
    const hasSpecial = bundle.stageFieldAnalysis?.special?.some(s=>s.fieldId===id);
    const memberScopes = hasSpecial ? [] : [...new Set(records.flatMap(record => record.memberScopes ?? [])
      .filter(s => s.settings?.userFilters).map(s => memberScopeDescription(s.settings)))];
    const description = [note?.rule, ...known, ...choices, ...memberScopes, ...(note?.rule || known.length || choices.length ? [] : [usage])]
      .filter(Boolean).join(' ');
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push({
      id,
      name: clean(name),
      type,
      view: stages[0],
      required: records.some(record => record.required === true) ? true : undefined,
      description: description || '见对应阶段表单图。',
      evidence: [],
    });
  }
  const ordered = [...profile?.fieldGroups ?? [], ...groups.keys()];
  const viewOrder = new Map(views.map((view, index) => [view.name, index]));
  return [...new Set(ordered)].filter(key => groups.has(key)).map(group => {
    const fields = atomicFieldRows(groups.get(group), { groupName: group, viewOrder });
    return { title: group, fields, rows: fields.map(field => [
      field.fieldName, field.fieldType, field.rules,
    ]) };
  });
}

// Compatibility wrapper kept for old callers; it no longer merges independent fields.
export function mergeEquivalentFields(rows) {
  return rows.map(row => [row[0], row[1], row[2]]);
}
