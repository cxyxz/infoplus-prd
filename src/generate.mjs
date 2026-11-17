import { writeWordAtomic } from './output-management.mjs';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Document, HeadingLevel, ImageRun, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import { instance } from '@viz-js/viz';
import { withRenderer } from './render.mjs';
import { memberScopeDescription } from './debug-runtime.mjs';

const str = value => value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
const cell = value => str(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const csv = value => {
  const text = str(value);
  return '"' + (/^[\s]*[=+@-]|^[\t\r\n]/.test(text) ? "'" : '') + text.replaceAll('"', '""') + '"';
};
const mdTable = (header, rows) => [
  header, header.map(() => '---'), ...rows,
].map(row => '| ' + row.map(cell).join(' | ') + ' |').join('\n');
const dotQuote = value => JSON.stringify(str(value));
const mermaidQuote = value => str(value).replace(/[&"<>#|\r\n]/g, char => `#${char.charCodeAt(0)};`);

export function graphSource(workflow) {
  const ids = new Map(workflow.nodes.map((node, index) => [node.id, `n${index}`]));
  if (!ids.size || ids.size !== workflow.nodes.length || ids.has('') ||
      workflow.transitions.some(e => !ids.has(e.source) || !ids.has(e.target))) return null;
  const nodeRows = workflow.nodes.map(n => [ids.get(n.id), `${n.name || n.id} [${n.id}]`, n.type]);
  const edgeRows = workflow.transitions.map(e => [ids.get(e.source), ids.get(e.target),
    e.id ? `${e.name} [${e.id}]` : [e.name, e.condition].filter(Boolean).map(str).join(' / '),
    /退回|否决|重新/.test(e.name)]);
  return {
    mmd: ['flowchart TD', ...nodeRows.map(([id, name]) => `  ${id}["${mermaidQuote(name)}"]`),
      ...edgeRows.map(([from, to, label]) => label ? `  ${from} -->|"${mermaidQuote(label)}"| ${to}` : `  ${from} --> ${to}`),
    ].join('\n'),
    dot: ['digraph workflow {', 'graph [nodesep=0.55 ranksep=0.65]',
      'node [shape=box fontname="Microsoft YaHei" fontsize=13]', 'edge [fontname="Microsoft YaHei" fontsize=11]',
      ...nodeRows.map(([id, name, type]) => {
        const glyphs = [...name].reduce((width, char) => width + (char.codePointAt(0) > 255 ? 1 : 0.56), 0);
        const diamond = type === '判断';
        const width = ((glyphs * 13 * (diamond ? 1.45 : 1) + 20) / 72).toFixed(2);
        return `${id} [label=${dotQuote(name)}, width=${width}${diamond ? ', shape=diamond' : ''}];`;
      }),
      ...edgeRows.map(([from, to, label, loop]) => `${from} -> ${to} [label=${dotQuote(label)}${loop ? ', color="#a33c37", style=dashed' : ''}];`), '}',
    ].join('\n'),
  };
}

function table(header, rows) {
  return new Table({
    rows: [header, ...rows].map((row, index) => new TableRow({
      tableHeader: index === 0,
      children: row.map(value => new TableCell({ children: [new Paragraph(str(value))] })),
    })),
  });
}

async function cachedWorkflowImage(directory, bundleMtime) {
  if (bundleMtime === undefined) return;
  try {
    const files = ['workflow.mmd', 'workflow.svg', 'workflow.png'].map(name => join(directory, name));
    const stats = await Promise.all(files.map(file => stat(file)));
    if (stats.some(file => !file.isFile() || !file.size || file.mtimeMs < bundleMtime)) return;
    const image = await readFile(files[2]);
    if (image.length >= 24 && image.subarray(0, 8).toString('hex') === '89504e470d0a1a0a' &&
        image.readUInt32BE(16) && image.readUInt32BE(20)) return image;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function generate(bundle, report, directory, bundleMtime) {
  const missing = [...new Set([...report.missing, ...(bundle.issues ?? [])])];
  const graph = graphSource(bundle.workflow);
  let graphImage;
  if (graph && bundle.workflow.transitions.length) {
    graphImage = await cachedWorkflowImage(directory, bundleMtime);
    if (!graphImage) {
      const viz = await instance();
      const svg = viz.renderString(graph.dot, { format: 'svg' });
      await writeFile(join(directory, 'workflow.mmd'), graph.mmd);
      await writeFile(join(directory, 'workflow.svg'), svg);
      try {
        await withRenderer(render => render(`<style>body{margin:0}svg{display:block;width:2600px;height:auto}</style>${svg}`, join(directory, 'workflow.png')));
        graphImage = await readFile(join(directory, 'workflow.png'));
      } catch {
        missing.push('流程图 PNG 渲染失败，已有 SVG 与 Mermaid');
      }
    }
  }
  const title = `${bundle.project.name ?? bundle.project.code}｜流程重建需求资料`;
  const overview = `项目 ${bundle.project.code}，IDE 版本 ${bundle.project.version ?? '待确认'}。${bundle.project.published ? '接口标记此定义已发布。' : '发布状态待核实。'}流程包含 ${bundle.workflow.nodes.length} 个节点和 ${bundle.workflow.transitions.length} 条连线。`;
  const names = new Map(bundle.workflow.nodes.map(node => [node.id, `${node.name} [${node.id}]`]));
  const transitions = bundle.workflow.transitions.map(e => [
    names.get(e.source) ?? e.source,
    e.id ? `${e.name} [${e.id}]` : e.name, names.get(e.target) ?? e.target,
    [e.condition, e.script ? '动作脚本见 rules.csv' : ''].filter(Boolean).join('；'), e.evidence,
  ]);
  const viewRows = bundle.views.map(v => [v.name, v.updated || v.created, v.apiFieldCount,
    v.screenshot ? `${v.packageViews.filter(item => item.screenshot).length} 张静态图` : '待采集']);
  const nodeRows = bundle.workflow.nodes.map(node => [
    names.get(node.id), node.type || '待确认', node.actor || (node.type === '办理' ? '待确认' : '—'),
    bundle.views.find(view => view.id === node.view)?.name ?? (node.view || '—'), node.evidence,
  ]);
  const nodeHead = ['节点', '类型', '配置的处理人', '阶段视图', '来源'];
  const fields = bundle.fields.map(f => [
    f.name, f.type, f.required === true ? '是' : f.required === false ? '否' : '待确认',
    f.view, f.id, f.usages?.map(u => `${u.view} / ${u.kind}`).join('；'),
    f.groupName, f.repeatDepth, f.apiType, f.evidence,
    f.readOnly === true ? '是' : f.readOnly === false ? '否' : '待确认',
    f.defaultValue, f.defaultSource, f.optionStatus ?? '', f.optionSets, f.dependencies, f.observedStates, f.fieldConfigSource,
  ]);
  const fieldHead = ['字段名称', '字段类型', '必填', '模板阶段', '字段标识', '控件证据', '分组', '重复层级', '接口类型', '来源',
    '只读', '默认值', '默认值来源', '选项状态', '选项和触发条件', '关联规则', '运行时阶段观测', '字段配置来源'];
  const flowHead = ['起点', '动作', '终点', '路由或脚本', '来源'];
  const viewHead = ['阶段视图', '最后已知时间', '接口字段', '预览'];
  const ruleHead = ['类型', '编号', '名称', '业务说明', '脚本原文', '来源'];
  const ruleRows = (bundle.rules ?? []).map(r => [r.kind, r.id, r.name, r.interpretation, r.expression, r.evidence]);
  const reviewed = ruleRows.filter(r => r[3]).map(r => [r[1], r[2], r[3], r[5]]);
  const rejectActions = bundle.workflow.transitions.filter(edge => /否决/.test(edge.name));
  const reviewedHead = ['编号', '节点或动作', '配置行为', '脚本出处'];
  const flowNote = transitions.length ? '流程图按定义中的节点和连线生成。方括号内为源配置编号，同名节点按编号区分。红色虚线标出名称含退回、否决或重新的动作。'
    : '已记录 IDE 中可见的阶段清单。连线和条件待工作流响应核实。';
  const visibleFlow = !transitions.length && bundle.diagramObservation
    ? [
      `编辑器中可见的节点示例（不表示顺序）　${bundle.diagramObservation.nodeLabels.join('、')}。`,
      `图上可见的操作文字示例　${bundle.diagramObservation.actionLabels.join('、')}。`,
    ]
    : [];
  const formNote = '字段清单以接口字段和 XSD 声明为依据，按阶段记录，并补充控件绑定。运行时必填、显隐和打印效果需验收。';
  const panels = [];
  const hashes = new Map();
  const indexedViews = new Map(bundle.views.map(view => [view.id, view]));
  const orderedViews = bundle.stagePages?.length
    ? bundle.stagePages.map(stage => indexedViews.get(stage.viewId)).filter(Boolean) : bundle.views;
  for (const view of orderedViews) {
    for (const item of view.packageViews) {
      if (!item.screenshot) continue;
      const target = resolve(directory, item.screenshot);
      if (!target.startsWith(resolve(directory, 'views') + sep)) continue;
      const data = await readFile(target);
      const key = createHash('sha256').update(data).digest('hex');
      const title = `${view.name} / ${item.name}`;
      const existing = hashes.get(key);
      if (existing) existing.title += `；${title}`;
      else {
        const panel = { title, file: item.screenshot, data };
        panels.push(panel);
        hashes.set(key, panel);
      }
    }
  }
  const sections = [
    ['流程概述', overview],
    ['业务流程', flowNote],
    ['表单需求', formNote],
    ['审批与业务规则', '节点人员、流转条件及退回关系以已采集工作流配置为依据。'],
    ['特殊规则', [
      bundle.workflow.description && `版本说明原文　${bundle.workflow.description}`,
      ...((bundle.workflow.externalEvents ?? []).filter(event => event.enabled).map(event =>
        `定义启用外部事件订阅「${event.name}」，列有 ${new Set(event.steps).size} 个绑定节点。回调内部逻辑待对接验收。`)),
      '原始 XSL 表达式及模板规则随 XSN 保存。节点通知和字段权限配置见标准化资料包。',
    ].filter(Boolean).join('\n')],
    ['待确认事项', [
      ...missing.map(item => `- ${item}`),
      bundle.debug && `运行验收：${bundle.debug.runtime?.modeEvidence?.length ? '已核对 IDE Debug 入口、DEBUG 列表、页面调试标记及实际身份。' : ''}${bundle.debug.reason ?? ''}。已验证审批路径 ${bundle.debug.verifiedPaths.length} 条，已模拟身份 ${bundle.debug.simulatedRoles.length} 个。`,
      bundle.debug?.front?.attempted && !bundle.debugRuns && '已执行前台回退。前台字段观测仅对应相关视图，流程流转、退回与重提以配置为依据，需另行验收。',
      ...(bundle.debugRuns?.runs ?? []).flatMap(run => run.events).flatMap(event => event.responses ?? [])
        .filter(response => response.errno && response.error).map(response => `后台实际业务校验：${response.error}`),
      ...(bundle.manualEvidence?.issues ?? []).map(issue => `旧系统问题（用户手动截图）：${issue.description} 地址：${issue.url}。${issue.requirement}`),
      '需在测试环境核对动态人员解析、分流与并行任务退回、外部订阅及通知实际执行。',
      ...rejectActions.map(edge => `动作「${edge.name}」[${edge.id}] 配置目标为「${names.get(edge.target)}」。该动作的运行终止行为需核对。`),
    ].filter(Boolean).join('\n')],
  ];
  const markdown = [`# ${title}`];
  const word = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const [index, [heading, paragraph]] of sections.entries()) {
    markdown.push(`## ${heading}`, paragraph);
    word.push(new Paragraph({ text: heading, heading: HeadingLevel.HEADING_1 }),
      ...paragraph.split('\n').map(text => new Paragraph(text)));
    if (index === 1 && graph && transitions.length) {
      markdown.push('[流程图 SVG](workflow.svg)');
      if (graphImage) word.push(pngParagraph(graphImage));
    }
    if (index === 1 && visibleFlow.length) {
      markdown.push(...visibleFlow, '[图中文字记录](raw/editor-observation.json)');
      word.push(...visibleFlow.map(text => new Paragraph(text)));
    }
    if (index === 2) {
      if(bundle.pathCoverage){
        const coverage=bundle.pathCoverage;
        const head=['验证项','类型','状态'];
        const rows=coverage.obligations.map(p=>[p.name,p.kind,p.status]);
        markdown.push('### 多路径验证覆盖',coverage.counting,mdTable(head,rows));
        word.push(new Paragraph({text:'多路径验证覆盖',heading:HeadingLevel.HEADING_2}),new Paragraph(coverage.counting),table(head,rows));
        for(const run of coverage.instances) word.push(new Paragraph(`实例 ${run.instanceId}：${run.status}。当前待办或最后观察节点：${run.pendingNode||run.current?.name||'未知'}。${run.identityBlock||run.businessWaiting||run.businessBlock||''}。${run.unresolved||''}`));
      }
      markdown.push(mdTable(viewHead, viewRows), '[字段清单 CSV](fields.csv)');
      word.push(table(viewHead, viewRows), new Paragraph('完整字段清单见随附 fields.csv。'));
      const visibleFields = fields.filter(row => row[5]).slice(0, 12).map(row => [row[0], row[1], row[2], row[3], row[4]]);
      if (visibleFields.length) {
        markdown.push('以下列出已发现控件绑定的部分字段。', mdTable(fieldHead.slice(0, 5), visibleFields));
        word.push(new Paragraph('以下列出已发现控件绑定的部分字段。'), table(fieldHead.slice(0, 5), visibleFields));
      }
    }
    if (index === 3 && transitions.length) {
      const diff = bundle.stageFieldAnalysis;
      if (diff) {
        const head = ['字段','前节点','当前节点','实际差异'];
        const rows = diff.differences.map(d => [d.fieldId,d.from,d.to,d.changes.join('；')]);
        markdown.push('### 实测字段跨节点差异',mdTable(head,rows));
        word.push(new Paragraph({text:'实测字段跨节点差异',heading:HeadingLevel.HEADING_2}),
          new Paragraph('未采集到绑定不代表字段不存在；节点变化不能独自证明角色或业务条件导致变化。'),table(head,rows));
        await writeFile(join(directory,'stage-field-analysis.json'),JSON.stringify(diff,null,2));
          const scopes = new Map();
          for (const stage of bundle.debug?.runtime?.stages ?? []) for (const scope of stage.memberScopes ?? []) {
            const row=[scope.fieldId,stage.state.name.trim(),scope.settings?.userFilters || '未取得',memberScopeDescription(scope.settings)];
            scopes.set(JSON.stringify(row),row);
          }
          const scopeHead=['字段绑定','观测节点','原始筛选配置','已确认内容及证据边界'];
          markdown.push('### 成员候选来源与过滤配置',mdTable(scopeHead,[...scopes.values()]));
          word.push(new Paragraph({text:'成员候选来源与过滤配置',heading:HeadingLevel.HEADING_2}),
            new Paragraph('来源为运行时成员控件与人员选择服务，组织目录后端未独立核实。一次候选分页不能证明完整名单；历史页面截图不计入新增节点验证。'),table(scopeHead,[...scopes.values()]));
      }
      if (reviewed.length) {
        markdown.push('### 已核对的分流与校验规则', mdTable(reviewedHead, reviewed));
        word.push(new Paragraph({ text: '已核对的分流与校验规则', heading: HeadingLevel.HEADING_2 }), table(reviewedHead, reviewed));
      }
      markdown.push('[节点与动作脚本原文](rules.csv)');
      word.push(new Paragraph('分流与动作脚本原文见随附 rules.csv，包含源配置路径。'));
      markdown.push(mdTable(nodeHead, nodeRows), mdTable(flowHead, transitions));
      word.push(table(nodeHead, nodeRows), table(flowHead, transitions));
    }
  }
  if (bundle.crossFlow) {
    const { summary, fields, limits } = bundle.crossFlow;
    const head = ['字段', '绑定', '来源及核验', '填写与权限'];
    markdown.push('## 前置业务关联与字段核验', ...summary, mdTable(head, fields), ...limits);
    word.push(new Paragraph({ text: '前置业务关联与字段核验', heading: HeadingLevel.HEADING_1 }),
      ...summary.map(text => new Paragraph(text)), table(head, fields), ...limits.map(text => new Paragraph(text)));
  }
  if (bundle.stagePages?.length) {
    const stageHead = ['页面', '分类', '绑定', '对应节点'];
    const stageRows = bundle.stagePages.map(stage => [stage.name, stage.category, stage.binding, stage.nodes.join('、')]);
    markdown.push('## 附录　办理阶段页面', mdTable(stageHead, stageRows));
    word.push(new Paragraph({ text: '附录　办理阶段页面', heading: HeadingLevel.HEADING_1 }), table(stageHead, stageRows));
    for (const stage of bundle.stagePages.filter(stage => stage.category === '办事说明类')) {
      const title = stage.title || stage.name;
      const next = stage.nextStages?.length ? `进入办理后到达「${stage.nextStages.join('、')}」。` : '';
      const actions = (stage.actions ?? []).map(action => [action.label, action.kind, action.purpose, action.address].filter(Boolean).join('　'));
      const details = [next, ...actions, ...stage.text?.split('\n') ?? []].filter(Boolean);
      markdown.push(`### ${title}`, ...details);
      word.push(new Paragraph({ text: title, heading: HeadingLevel.HEADING_2 }));
      if (stage.screenshot) {
        const target = resolve(directory, stage.screenshot);
        const data = target.startsWith(resolve(directory, 'views') + sep) && await readFile(target).catch(error => {
          if (error.code !== 'ENOENT') throw error;
        });
        if (data) {
          markdown.push(`![前台完整截图](${stage.screenshot})`);
          word.push(pngParagraph(data));
        }
      }
      word.push(...details.map(text => new Paragraph(text)));
    }
  }
  const materialChecks=(bundle.pathCoverage?.instances??[]).flatMap(run=>
    [...new Map((run.materialChecks??[]).map(check=>[check.state?.flowStepId,check])).values()]);
  if(materialChecks.length){
    const heading='附录　国合处办理与材料收尾实测';
    markdown.push(`## ${heading}`);
    word.push(new Paragraph({text:heading,heading:HeadingLevel.HEADING_1}));
    for(const check of materialChecks){
      const result=`申请表链接${check.applicationReady?'已取得':'未取得'}。批件链接${check.approvalReady?'已取得':'未取得'}。${check.message||''}`;
      markdown.push(result);word.push(new Paragraph(result));
      if(check.review){
        const review=check.review;
        const evidence=[review.classification,review.externalDependency,review.candidateScope?.scope].filter(Boolean);
        markdown.push(...evidence);word.push(...evidence.map(line=>new Paragraph(line)));
        const headers=['退回目标','Workflow 配置及后续流转','验证状态'];
        const rows=review.returnActions.map(action=>[action.target,action.config,action.executed?'已实测':'页面入口和配置已核对']);
        markdown.push(mdTable(headers,rows));word.push(table(headers,rows));
      }
      for(const screenshot of check.screenshots??[]){
        const path=resolve(directory,screenshot.file);
        if(!path.startsWith(resolve(directory,'views')+sep))continue;
        const data=await readFile(path).catch(error=>{if(error.code!=='ENOENT')throw error;});
        if(!data)continue;
        markdown.push(`### ${screenshot.label}`,`![实测截图](${screenshot.file})`);
        word.push(new Paragraph({text:screenshot.label,heading:HeadingLevel.HEADING_2}),pngParagraph(data));
      }
    }
  }
  if (panels.length) {
    markdown.push('## 附录　XSN 静态预览', '截图由包内 XSL 和默认模板数据生成，运行时显隐、权限、数据和打印效果待复核。');
    word.push(new Paragraph({ text: '附录　XSN 静态预览', heading: HeadingLevel.HEADING_1 }),
      new Paragraph('截图由包内 XSL 和默认模板数据生成，运行时显隐、权限、数据和打印效果待复核。'));
    for (const panel of panels) {
      markdown.push(`### ${panel.title}`, `![静态预览](${panel.file})`);
      word.push(new Paragraph({ text: panel.title, heading: HeadingLevel.HEADING_2 }), pngParagraph(panel.data));
    }
  }
  await writeFile(join(directory, 'fields.csv'), '\uFEFF' + [fieldHead, ...fields].map(row => row.map(csv).join(',')).join('\r\n'));
  await writeFile(join(directory, 'rules.csv'), '\uFEFF' + [ruleHead, ...ruleRows].map(row => row.map(csv).join(',')).join('\r\n'));
  await writeFile(join(directory, 'requirements.md'), markdown.join('\n\n') + '\n');
  // V1.3: technical analysis stays internal; only generateCustom publishes Word.
  const docxPath = join(directory, 'requirements.md');
  report.missing = missing;
  report.structuralChecksPassed = missing.length === 0;
  report.status = missing.length ? 'unverified' : 'structurally-verified';
  await writeFile(join(directory, 'analysis-report.json'), JSON.stringify(report, null, 2));
  return docxPath;
}

function pngParagraph(data) {
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  const scale = Math.min(1, 570 / width, 680 / height);
  return new Paragraph({ children: [new ImageRun({
    data, type: 'png', transformation: {
      width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)),
    },
  })] });
}

