/**
 * 从同一份标准化 bundle + 截图索引生成「节点图文说明」内容。
 * 不写死 Z1775：字段、按钮、角色、规则和截图均来自已采集证据。
 */
import fs from 'node:fs';
import path from 'node:path';
import { eligibleScreenshot } from './screenshot-quality.mjs';
import { workflowOrder, businessControl } from './workflow-order.mjs';
import { memberScopeDescription } from './debug-runtime.mjs';

const IMAGE_EXT = /\.(png|jpg|jpeg)$/i;
const importantField = /审核|审批|意见|负责人|公示|保险|取消|报销|航班|回访|附件|日期|团组|打印|签名|报告/;
const documentImage = image => eligibleScreenshot(image);
const categoryOrder = { 'full-page': 0, 'business-module': 1, 'action-buttons': 2, 'special-field': 3, validation: 4 };
const preferredModules = /审核意见|处理意见|审批意见|负责人|公示|保险/;

function loadJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

function existingImage(directory, file, screenshotRoot = directory) {
  if (!file || !IMAGE_EXT.test(file)) return null;
  const root = path.resolve(screenshotRoot);
  const directoryRoot = path.resolve(directory);
  const absolute = path.isAbsolute(file) ? path.resolve(file) : path.resolve(directoryRoot, file);
  const allowed = [root, directoryRoot];
  if (absolute.split(path.sep).includes('original')) return null;
  if (!allowed.some(root => absolute.startsWith(root + path.sep)) || !fs.existsSync(absolute)) return null;
  return path.relative(directory, absolute).replace(/\\/g, '/');
}

function fieldName(bundle, id, fallback) {
  return bundle.fields?.find(f => f.id === id)?.name || fallback || id;
}

export function chooseFields(bundle, node, runtimeStages) {
  const ids = node?.fields || [];
  const details = new Map();
  for (const stage of runtimeStages) {
    for (const field of stage.fields || []) if (field.id) details.set(field.id, field);
  }
  const scored = ids.map(id => {
    const detail = details.get(id) || {};
    const name = fieldName(bundle, id, detail.name);
    const type = businessControl({ ...bundle.fields?.find(f => f.id === id), ...detail, name });
    const score = (importantField.test(name) ? 3 : 0) + (type === 'User' || type === 'Organize' ? 3 : 0) +
      (detail.required || detail.notNull ? 2 : 0) + (detail.fieldChanging ? 2 : 0) +
      (/w/.test(detail.permission || '') ? 1 : 0);
    const ruleParts = [];
    if (detail.required || detail.notNull) ruleParts.push('该次页面观测标记必填');
    if (!detail.readOnly && /w/.test(detail.permission || '')) ruleParts.push('该次页面观测可编辑；历史快照不能证明当前权限');
    if (detail.readOnly) ruleParts.push('只读');
    if (detail.fieldChanging) ruleParts.push('条件或联动字段');
    if (detail.settings?.userFilters) ruleParts.push(memberScopeDescription(detail.settings));
    if (type === '成员选择' && !detail.settings?.userFilters) ruleParts.push('候选人员范围待确认');
    if (!ruleParts.length) ruleParts.push('当前节点显示；详细规则见字段清单');
    const special = bundle.stageFieldAnalysis?.special?.find(s => s.fieldId === id && s.stage === node.name);
    const relevant = detail.visible !== false && !/^fieldFZ|^_VAR_|Help|URL/i.test(id) &&
      ((!detail.readOnly && /w/.test(detail.permission || '')) || detail.fieldChanging ||
        special && /新增|首次|变为|变化/.test(special.rule));
    return { id, name, type, rule: ruleParts.join('；'), score, relevant };
  }).filter(f => f.relevant).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'zh'));
  return scored.map(({ id, name, type, rule }) => [{
    id,
    name,
    type,
    required: details.get(id)?.required || details.get(id)?.notNull ? true : undefined,
    stages: [node?.name].filter(Boolean),
    rules: [rule],
  }]);
}

function chooseScreenshots(directory, shot, screenshotRoot, maxPerCategory = { full: 3, buttons: 1, special: 2 }) {
  const out = [];
  const images = (shot.images || []).filter(image => documentImage(image) && existingImage(directory, image.file, screenshotRoot));
  const seen = new Set();
  const add = (image, kind, title, note) => {
    const file = existingImage(directory, image.file, screenshotRoot);
    if (!file || seen.has(file)) return;
    seen.add(file);
    out.push({ kind, file, width: image.width, height: image.height, title, note,
      source: image.quality?.category, sourceType: shot.source || '真实 Debug 页面' });
  };
  const full = images.find(i => i.category === 'full-page' && i.sourceVariant === 'masked');
  const allModules = images.filter(i => i.category === 'business-module')
    .sort((a, b) => (a.crop?.y ?? 0) - (b.crop?.y ?? 0))
  const keyModules = allModules.filter(i => preferredModules.test(i.title || i.purpose || ''));
  const modules = (keyModules.length ? keyModules : allModules)
    .slice(0, maxPerCategory.full ?? 3);
  for (const [index, image] of modules.entries()) {
    add(image, 'full', image.title || `业务模块 ${index + 1}`,
      `${shot.source || '真实 Debug 页面'}；${image.purpose || image.title || '按业务模块从完整表单原图裁剪'}；${shot.verificationNote || ''}。`);
  }
  const hasPageImage = (shot.images || []).some(i => ['full-page', 'business-module'].includes(i.category) && existingImage(directory, i.file, screenshotRoot));
  if (full && !modules.length) add(full, 'full', '真实页面完整图',
    `${shot.source || '真实 Debug 页面'}；已核对完整表单边界，字段值和身份信息已遮盖。`);
  const button = images.find(i => i.category === 'action-buttons');
  if (button) add(button, 'buttons', '节点底部操作按钮',
    button.purpose || '从同一实例真实办理页面采集的底部按钮证据。');
  const specials = images.filter(i => i.category === 'special-field')
    .sort((a, b) => (categoryOrder[a.category] ?? 9) - (categoryOrder[b.category] ?? 9))
    .slice(0, maxPerCategory.special || 0);
  for (const image of specials) {
    add(image, 'special', `${image.fieldName || image.title || '特殊字段'}（${image.reason || '条件证据'}）`,
      `${image.purpose || '真实页面局部证据'}；${shot.verificationNote || shot.source || ''}`);
  }
  const kindOrder = { full: 0, buttons: 1, special: 2 };
  return out.sort((a, b) => (kindOrder[a.kind] ?? 9) - (kindOrder[b.kind] ?? 9));
}

function buttonRows(shot, mapped) {
  if (mapped) return mapped.buttons.map(t => [
    t.label, t.condition || '具体执行条件待验证',
    t.targetName || (t.kill ? '平台终止操作，结果未验证' : '待按 Workflow 核对'),
    t.verification === 'actual-verified' ? '实际点击并核对流转' : t.verification === 'actual-executed' ? '提交成功；后续流转待核对' : '配置确认、未实际点击',
  ]);
  const transitions = new Map((shot.buttonTransitions || []).map(b => [b.label, b]));
  const detected = [...new Set(shot.buttonsDetected || [])];
  const labels = [...new Set([...detected, ...transitions.keys()])]
    .filter(label => !/调试窗口|我知道了|查看最新数据|本步骤可|撤回/.test(label))
    .filter(label => detected.includes(label) || transitions.has(label))
    .filter(label => detected.some(value => value === label || value.includes(label) || label.includes(value)));
  return labels.map(label => {
    const t = transitions.get(label);
    return [label, t?.condition || '具体执行条件待验证', t?.targetName || '待按 Workflow 核对',
      t?.verification === 'actual-verified' ? '实际流转验证' : '配置确认、未实际点击'];
  });
}

function descriptionFor(bundle, node, shot) {
  if (shot.pageType === 'live-debug') {
    return `已进入该节点并完成页面取证。${shot.buttonDetectionNote || '当前身份可读取页面，动作执行状态见按钮流转表。'}`;
  }
  return `本节页面来自同一实例的历史只读快照，仅证明页面观测；实际办理结果以关联的流转记录为准。`;
}

export function buildNodeEvidenceSections(bundle, directory, screenshotRoot = path.join(directory, 'debug-evidence')) {
  if (!path.resolve(screenshotRoot).startsWith(path.resolve(directory) + path.sep)) return [];
  const index = loadJson(path.join(screenshotRoot, 'screenshot-index.json'));
  if (index?.code && bundle.project?.code && index.code !== bundle.project.code) return [];
  if (index?.version && bundle.project?.version && index.version !== bundle.project.version) return [];
  if (!index?.nodes?.length) return [];
  const nodeEvidence = new Map((bundle.nodeEvidence || []).map(n => [Number(n.id), n]));
  const stages = bundle.debug?.runtime?.stages || [];
  const special = bundle.stageFieldAnalysis?.special || [];
  const buttonMap = loadJson(path.join(directory, 'button-branch-map.json'));
  const order = new Map(workflowOrder(bundle.workflow || {nodes:[]}).map((n,i) => [String(n.id), i]));
  return [...index.nodes].sort((a,b) => (order.get(String(a.nodeId)) ?? Infinity) - (order.get(String(b.nodeId)) ?? Infinity)).map(shot => {
    const nodeId = Number(shot.nodeId);
    const node = nodeEvidence.get(nodeId) || {};
    const mapped = buttonMap?.nodes.find(n => Number(n.nodeId) === nodeId);
    const names = new Map((bundle.workflow?.nodes || []).map(n => [String(n.id), n.name]));
    const incoming = (bundle.workflow?.transitions || []).filter(e => String(e.target) === String(nodeId));
    const entry = incoming.map(e => `${names.get(String(e.source)) || '前置环节'}：${e.name}`).join('；') || '流程入口（按 Workflow 配置）';
    const relevantStages = stages.filter(s => Number(s.state?.nodeId) === nodeId);
    const ownSpecial = special.filter(s => String(s.stage || '').includes(shot.nodeName)).slice(0, 5)
      .map(s => `${s.name || s.fieldId}：${s.source || ''}${s.rule ? `；${s.rule}` : ''}`);
    return {
      nodeId, name: shot.nodeName || node.name || `节点 ${nodeId}`,
      role: node.role || '待确认',
      verified: (mapped?.buttons || shot.buttonTransitions || []).some(b => b.verification === 'actual-verified'),
      description: `进入条件（Workflow 配置）：${entry}。${descriptionFor(bundle, node, shot)}`,
      fields: chooseFields(bundle, node, relevantStages),
      screenshots: chooseScreenshots(directory, shot, screenshotRoot),
      buttons: buttonRows(shot, mapped),
      rules: ownSpecial,
      sourceNote: `${shot.source || '真实 Debug'}；${shot.pageType === 'live-debug' ? '采集时实际办理页面' : '历史只读快照'}`,
    };
  });
}
