import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';

export const stageAnalysisVersion = 1;
export const stageManifest = viewId => `views/${viewId}/live-stage.json`;
export const stageProfileUrl = code => new URL(`../config/business-profiles/${code}.json`, import.meta.url);
const optional = path => readFile(path, 'utf8').catch(error => {
  if (error.code !== 'ENOENT') throw error;
});
const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
const unique = values => [...new Set(values.filter(Boolean))];

export async function stageProfile(project) {
  if (!/^[a-z0-9_-]+$/i.test(project.code)) return;
  const raw = await optional(stageProfileUrl(project.code));
  const profile = raw && JSON.parse(raw.replace(/^\uFEFF/, ''));
  if (profile?.version === project.version && profile?.definitionId === project.workflowDefinitionId) return profile;
}

function classification(start, display, print, view) {
  const context = [view.name, ...display.map(node => node.name)].join(' ');
  if (start || /欢迎|办理须知|办事说明|办事指南|业务说明|申请须知/.test(view.name)) return '办事说明类';
  if (/批件下载|办理结果|办结|打印|回执|证书/.test(view.name) || !display.length && print.length) return '结果展示类';
  if (/身份选择|选择页面|申请类型选择|人员选择|单位选择|信息选择/.test(context)) return '信息选择类';
  if (/审核|审批|复核|会签|审查|办理意见|授权确认|党委确认/.test(context)) return '审批办理类';
  if (/填写|填报|填表|修改|申请|主表单/.test(context) || view.packageViews.some(panel => panel.controls?.length)) return '申请填写类';
  return '待确认';
}

function splitInstructions(text) {
  const sections = [];
  const headings = [
    ['申请条件', /申请条件|办理条件|申请资格|受理条件|适用范围/],
    ['适用人员', /适用人员|适用对象|服务对象|申请对象|办理对象/],
    ['办理材料', /办理材料|申请材料|所需材料|提交材料|材料清单/],
    ['办理步骤', /办理流程|办理步骤|办理方式|申办流程|申请流程/],
    ['注意事项', /办理须知|注意事项|温馨提示|特别提醒|填报须知/],
  ];
  let current;
  for (const line of text.split('\n')) {
    const heading = headings.find(([, pattern]) => pattern.test(line) &&
      (line.length <= 30 || /^(?:[一二三四五六七八九十\d]+[、.．]\s*)?(?:申请条件|办理条件|适用范围|适用人员|办理材料|办理流程|办理须知|注意事项)[：:]/.test(line)));
    if (heading) {
      current = { kind: heading[0], lines: [] };
      sections.push(current);
    }
    if (!current) {
      current = { kind: '页面说明', lines: [] };
      sections.push(current);
    }
    if (line.trim()) current.lines.push(line);
  }
  const excerpts = [
    ['申请条件', /(?:适用于|限于|出访前.*申请|不得事后补办)/],
    ['适用人员', /(?:仅限|适用人员|适用对象|外籍教职工.*申请)/],
    ['办理材料', /(?:上传|提交|携带|准备).*(?:材料|附件|邀请函|原件|证明|说明)/],
  ];
  for (const [kind, pattern] of excerpts) {
    if (sections.some(section => section.kind === kind)) continue;
    const lines = text.split('\n').filter(line => pattern.test(line));
    if (lines.length) sections.push({ kind, lines });
  }
  return sections.filter(section => section.lines.length);
}

async function staticDescription(directory, view) {
  const panel = view.packageViews.find(item => item.file && !/手机|mobile/i.test(item.name));
  if (!panel?.file || basename(panel.file) !== panel.file) return;
  const source = `views/${view.id}/source/${panel.file}`;
  const xml = await optional(join(directory, source));
  if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml)) return;
  let doc;
  try { doc = new DOMParser({ onError: () => {} }).parseFromString(xml, 'application/xml'); }
  catch { return; }
  const lines = [];
  const actions = [];
  let pending = '';
  const flush = () => { if (clean(pending)) lines.push(clean(pending)); pending = ''; };
  function walk(node) {
    if (node.nodeType === 3 || node.nodeType === 4) { pending += node.nodeValue; return; }
    if (node.nodeType !== 1 || /^(style|script|head|xsl:(?:attribute|comment|variable|param|value-of|output))$/i.test(node.tagName)) return;
    const block = /^(div|p|br|tr|li|h[1-6])$/i.test(node.tagName);
    if (block) flush();
    for (const child of Array.from(node.childNodes)) walk(child);
    if (block) flush();
    if (/^(a|button)$/i.test(node.tagName)) {
      const label = clean(node.textContent);
      const href = URL.parse(node.getAttribute('href') ?? '');
      const address = href && /^(https?):$/.test(href.protocol) && !href.username && !href.password ? href.origin + href.pathname : undefined;
      if (label) actions.push({ label, kind: address ? '链接' : '按钮', address });
    }
  }
  walk(doc.documentElement);
  flush();
  return { text: lines.join('\n'), actions, source };
}

export async function buildStagePages(directory, project, workflow, topology, views, profile) {
  const bound = new Set(workflow.nodes.flatMap(node => [node.view, node.printView]).filter(Boolean));
  const starts = workflow.nodes.filter(node => node.attributes?.defaultInitial === 'true');
  const startNodes = starts.length ? starts : workflow.nodes.filter(node =>
    profile?.startNode ? node.id === profile.startNode : topology.entries.includes(node.id));
  const ordered = new Set([workflow.startView]);
  const queue = startNodes.slice();
  const seen = new Set();
  const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
  const outgoing = new Map();
  for (const edge of workflow.transitions) {
    if (!outgoing.has(edge.source)) outgoing.set(edge.source, []);
    if (!/退回|返回|重新|刷新|否决/.test(edge.name)) outgoing.get(edge.source).push(edge);
  }
  for (const node of queue) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    if (node.view) ordered.add(node.view);
    for (const edge of outgoing.get(node.id) ?? []) if (nodes.has(edge.target)) queue.push(nodes.get(edge.target));
  }
  for (const id of profile?.viewOrder ?? []) if (bound.has(id)) ordered.add(id);
  for (const view of views) if (bound.has(view.id)) ordered.add(view.id);
  for (const view of views) ordered.add(view.id);
  const viewMap = new Map(views.map(view => [view.id, view]));
  const stages = [];
  for (const id of ordered) {
    const view = viewMap.get(id);
    if (!view) continue;
    const start = workflow.startView === id;
    const display = workflow.nodes.filter(node => node.view === id);
    const print = workflow.nodes.filter(node => node.printView === id);
    const category = classification(start, display, print, view);
    const displayIds = new Set(display.map(node => node.id));
    const configuredActions = workflow.transitions.filter(edge => displayIds.has(edge.source)).map(edge => ({
      label: edge.name, from: nodes.get(edge.source)?.name, to: nodes.get(edge.target)?.name,
      nextView: nodes.get(edge.target)?.view || undefined, evidence: edge.evidence,
    }));
    const row = {
      viewId: id, name: view.name, category, binding: start ? '入口' : display.length ? '办理' : print.length ? '打印' : '模板',
      nodes: unique([...display, ...print].map(node => node.name)),
      staticScreenshot: view.screenshot, configuredActions,
      nextStages: start ? unique(startNodes.map(node => node.name)) : [],
      nextEvidence: start ? startNodes.map(node => node.evidence).filter(Boolean) : [],
    };
    if (category === '办事说明类') {
      const manifest = stageManifest(id);
      const raw = await optional(join(directory, manifest));
      let live;
      try { live = raw && JSON.parse(raw); }
      catch (error) { if (!(error instanceof SyntaxError)) throw error; }
      const match = live?.code === project.code && live?.version === project.version && live?.viewId === id &&
        live?.definitionId === project.workflowDefinitionId && /^live-stage-[a-f0-9-]+\.png$/i.test(live.screenshot ?? '');
      const description = match ? live : await staticDescription(directory, view);
      if (description) {
        const { title, text, actions, source } = description;
        Object.assign(row, { title, text, actions, source, instructionSections: splitInstructions(text ?? '') });
      }
      if (match) Object.assign(row, { screenshot: `views/${id}/${live.screenshot}`, screenshotSource: '前台完整截图', manifest });
      if (!row.screenshot) row.screenshotSource = 'XSN 静态预览';
    }
    stages.push(row);
  }
  return stages;
}
