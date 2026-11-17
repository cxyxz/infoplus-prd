import { writeWordAtomic } from './output-management.mjs';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, ImageRun,
  Packer, PageNumber, PageOrientation, Paragraph, SectionType, Table, TableCell,
  TableLayoutType, TableRow, TextRun, VerticalAlign, WidthType,
} from 'docx';
import { buildBusinessContent } from './business-content.mjs';
import { originalWorkflowImage, originalPngName, originalSvgName } from './workflow-original.mjs';
import { stageProfile } from './stage-pages.mjs';
import { buildNodeEvidenceSections } from './node-evidence-content.mjs';
import { dedupeSectionImages, dedupeSectionRules, imageCropSegments } from './image-layout.mjs';
import { workflowOrder } from './workflow-order.mjs';
import { businessTextFormatter, businessAssociation } from './business-presentation.mjs';
import { atomicFieldRows, atomicRowsForWord } from './field-atomic.mjs';

const configUrl = name => new URL(`../config/${name}`, import.meta.url);
const readJson = async (path, optional = false) => {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (!optional || error.code !== 'ENOENT') throw error; }
};
const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
const mdEscape = value => String(value).replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');
const mdTable = (headers, rows) => [headers, headers.map(() => '---'), ...rows]
  .map(row => `| ${row.map(mdEscape).join(' | ')} |`).join('\n');
const nodeFieldsForWord = fields => atomicRowsForWord(atomicFieldRows(fields, { groupName: '' }));

const windowsChars = { '<':'＜', '>':'＞', ':':'：', '"':'＂', '/':'／', '\\':'＼', '|':'｜', '?':'？', '*':'＊' };
const filenamePart = value => value.replace(/[<>:"/\\|?*]/g, char => windowsChars[char])
  .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');

export function customDocxName(project) {
  const code = String(project.code || project.projectCode || '流程').trim();
  const title = String(project.name || code).trim();
  const separator = title.search(/[:：]/);
  const name = separator >= 0 && title.slice(0, separator).trim().toLowerCase() === code.toLowerCase()
    ? title.slice(separator + 1).trim() : title;
  const stem = `${filenamePart(code) || '流程'}：${filenamePart(name) || '未命名流程'}`;
  const safeStem = /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])\./i.test(stem) ? '_' + stem : stem;
  // Limit UTF-16 units without cutting a surrogate pair; reserve room for the suffix.
  let shortened = '';
  for (const char of safeStem) {
    if (shortened.length + char.length > 160) break;
    shortened += char;
  }
  return `${shortened.trimEnd()}需求文档.docx`;
}

async function png(path) {
  let data;
  try { data = await readFile(path); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  return pngImage(data);
}

function pngImage(data) {
  if (!data || data.length < 24 || data.toString('hex', 0, 8) !== '89504e470d0a1a0a') return;
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width && height) return { data, width, height };
}

async function figures(bundle, content, profile, directory, policy, inlineNodeIds = new Set()) {
  const seen = new Map();
  const unavailable = [];
  const nodes = bundle.workflow.nodes;
  const stages = new Map(bundle.stagePages?.map(stage => [stage.viewId, stage]));
  for (const view of content.views) {
    const stage = stages.get(view.id);
    const panels = view.packageViews?.filter(item => item.screenshot) ?? [];
    const preferred = panels.find(item => /默认/.test(item.name)) ??
      panels.find(item => !/手机|mobile|\[360\]/i.test(item.name)) ?? panels[0];
    const debugStages = [...new Map((bundle.debug?.runtime?.stages ?? []).filter(s =>
      s.state.viewId === view.id && s.screenshot && !inlineNodeIds.has(Number(s.state.nodeId)))
      .map(s => [s.state.nodeId, s])).values()];
    const selected = debugStages.length ? debugStages.map(s => {
      const history=bundle.debugHistory?.stages.find(h=>h.state.flowStepId===s.state.flowStepId && h.screenshot);
      return { screenshot: history?.screenshot || s.screenshot, name: s.state.name.trim(), debug: true, history:Boolean(history) };
    }) : stage?.screenshot
      ? [{ screenshot: stage.screenshot, name: '前台完整截图', live: true }, ...(preferred ? [preferred] : [])]
      : policy === 'all' ? panels : preferred ? [preferred] : [];
    let found = false;
    for (const item of selected) {
      const source = resolve(directory, item.screenshot);
      if (!source.startsWith(resolve(directory, 'views') + sep)) continue;
      const image = await png(source);
      if (!image) continue;
      found = true;
      const digest = createHash('sha256').update(image.data).digest('hex');
      let figure = seen.get(digest);
      if (!figure) {
        figure = { ...image, path: item.screenshot, labels: [], uses: new Set() };
        seen.set(digest, figure);
      }
      const label = item.debug ? item.name : stage?.binding === '入口' ? '办事说明页' : view.name;
      figure.labels.push(selected.length > 1 && !stage?.screenshot ? `${label} · ${item.name}` : label);
      const used = [...new Set(nodes.filter(node => [node.view, node.printView].includes(view.id)).map(node => node.name))];
      const note = item.debug ? `「${item.name}」${item.history ? '历史只读页面' : '实际办理页面'}。图为后台 Debug 完整截图，身份和字段值已遮盖；仅证明该节点页面已读取，审批动作是否完成见运行验收记录。` : stage?.binding === '入口'
        ? `申请人在此阅读办理说明后开始申请。${stage.nextStages?.length ? `下一阶段为${stage.nextStages.join('、')}。` : ''}${item.live ? '图为前台完整截图。' : '图为 XSN 静态预览。'}`
        : profile?.formNotes?.[view.id] ??
        (bundle.workflow.startView === view.id ? '办事入口的说明页面。' :
          used.length ? `供${used.join('、')}环节使用。` : '原表单模板，运行时调用环节需核对。');
      figure.uses.add(stage?.binding === '模板' ? `模板参考。 ${note}` : stage?.category && stage.binding !== '入口' ? `${stage.category}。 ${note}` : note);
      if (stage?.screenshot && !item.debug) break;
    }
    if (!found) unavailable.push(view.name);
  }
  return { panels: [...seen.values()], unavailable };
}

function section(children, page, headers, footers) {
  const { width, height, ...margin } = page;
  const landscape = width > height;
  return {
    children, headers, footers,
    properties: {
      type: SectionType.NEXT_PAGE,
      page: { size: { width: Math.min(width, height), height: Math.max(width, height),
        orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT }, margin },
    },
  };
}

function imageParagraph(image, page, reserve, caption) {
  const availableWidth = (page.width - page.left - page.right) / 15 - 4;
  const availableHeight = (page.height - page.top - page.bottom) / 15 - reserve;
  const scale = Math.min(availableWidth / image.width, availableHeight / image.height, 1);
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new ImageRun({
      data: image.data, type: 'png',
      transformation: { width: Math.floor(image.width * scale), height: Math.floor(image.height * scale) },
      altText: { title: caption, description: caption, name: caption },
    })],
  });
}

function imageParagraphSegments(image, page, reserve, caption) {
  const segments = imageCropSegments(image, page, reserve);
  return segments.flatMap((segment, index) => {
    const children = [];
    if (index > 0) {
      children.push(new Paragraph({
        style: 'BusinessCaption',
        text: `${caption}（续 ${index + 1}/${segments.length}）`,
        keepNext: true,
        pageBreakBefore: true,
      }));
    }
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new ImageRun({
        data: image.data,
        type: 'png',
        transformation: { width: segment.width, height: segment.height },
        crop: segment.crop,
        altText: {
          title: `${caption}${segments.length > 1 ? `（${index + 1}/${segments.length}）` : ''}`,
          description: caption,
          name: caption,
        },
      })],
    }));
    return children;
  });
}

function templateTable(headers, rows, widths, word) {
  const tableWidth = word.page.width - word.page.left - word.page.right;
  const columnWidths = widths.map(percent => Math.round(tableWidth * percent / 100));
  const rowFont = headers.length === 6 ? Math.min(word.tablePt, 8.5) : word.tablePt;
  const border = { style: BorderStyle.SINGLE, size: 5, color: word.border };
  return new Table({
    width: { size: tableWidth, type: WidthType.DXA }, columnWidths, layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    margins: { top: 70, bottom: 70, left: headers.length === 6 ? 60 : 105, right: headers.length === 6 ? 60 : 105 },
    rows: [headers, ...rows].map((row, i) => new TableRow({
      tableHeader: i === 0, cantSplit: true,
      children: row.map((value, j) => new TableCell({
        width: { size: columnWidths[j], type: WidthType.DXA }, verticalAlign: VerticalAlign.CENTER,
        ...(i === 0 ? { shading: { fill: word.headerFill } } : {}),
        children: [new Paragraph({
          style: 'BusinessCell',
          alignment: headers.length === 3 && j === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
          children: [new TextRun({ text: value, bold: i === 0, size: i === 0 ? undefined : Math.round(rowFont * 2) })],
        })],
      })),
    })),
  });
}

function styles(word) {
  const font = { ascii: word.font, eastAsia: word.font, hAnsi: word.font };
  const run = (size, color = '182A3A', bold = false) => ({ font, size: Math.round(size * 2), color, bold });
  return {
    default: {
      document: { run: run(word.bodyPt), paragraph: { spacing: { after: 110, line: 300 } } },
      title: { run: run(word.titlePt, '101820', true), paragraph: { spacing: { after: 160 }, keepNext: true } },
      heading1: { run: run(word.headingPt, word.accent, true), paragraph: { spacing: { before: 235, after: 100 }, keepNext: true } },
      heading2: { run: run(word.subheadingPt, word.accent, true), paragraph: { spacing: { before: 160, after: 85 }, keepNext: true } },
    },
    paragraphStyles: [
      { id: 'BusinessMeta', name: 'Business Metadata', run: run(9, word.muted), paragraph: { spacing: { after: 100 } } },
      { id: 'BusinessCell', name: 'Business Table Text', run: run(word.tablePt), paragraph: { spacing: { before: 0, after: 0, line: 265 } } },
      { id: 'BusinessCaption', name: 'Business Figure Caption', run: run(word.subheadingPt, word.accent, true), paragraph: { spacing: { before: 100, after: 70 }, keepNext: true } },
    ],
  };
}

export async function generateCustom(bundle, directory, templatePath = process.env.INFOPLUS_CUSTOM_TEMPLATE) {
  const template = await readJson(templatePath ? resolve(templatePath) : configUrl('requirements-custom.json'));
  const { word, appendix } = template;
  const code = bundle.project.code;
  const profile = await stageProfile(bundle.project);
  const content = buildBusinessContent(bundle, profile);
  const businessText = businessTextFormatter(bundle);
  const title = `${content.title} ${template.title}`;
  const meta = [code, bundle.project.version && `流程版本 ${bundle.project.version}`].filter(Boolean).join('  /  ');
  const diagram = pngImage(await originalWorkflowImage(bundle, directory));
  const screenshotRoot = process.env.INFOPLUS_SCREENSHOT_DIR
    ? resolve(process.env.INFOPLUS_SCREENSHOT_DIR) : join(directory, 'debug-evidence');
  const nodeSections = buildNodeEvidenceSections(bundle, directory, screenshotRoot);
  for (const sectionData of nodeSections) {
    for (const screenshot of sectionData.screenshots) screenshot.image = await png(resolve(directory, screenshot.file));
    sectionData.screenshots = sectionData.screenshots.filter(s => s.image);
  }
  dedupeSectionImages(nodeSections, data => createHash('sha256').update(data).digest('hex'));
  dedupeSectionRules(nodeSections);
  const inlineNodeIds = new Set(nodeSections.map(s => s.nodeId));
  const { panels, unavailable } = await figures(bundle, content, profile, directory, word.formPanelPolicy, inlineNodeIds);
  const header = new Header({ children: [new Paragraph({
    style: 'BusinessMeta', alignment: AlignmentType.RIGHT, text: `${template.header}  /  ${content.title}`,
  })] });
  const footer = new Footer({ children: [new Paragraph({
    style: 'BusinessMeta', alignment: AlignmentType.CENTER,
    children: [new TextRun(`${template.footer}  |  ${code}  |  第 `),
      new TextRun({ children: [PageNumber.CURRENT] }), new TextRun(' 页')],
  })] });
  const headers = { default: header };
  const footers = { default: footer };
  const markdown = [`# ${title}`, meta, template.purpose];
  const body = [new Paragraph({ heading: HeadingLevel.TITLE, children: [
    new TextRun(content.title), new TextRun({ text: template.title, break: 1 }),
  ] }),
    new Paragraph({ style: 'BusinessMeta', text: meta }), new Paragraph(template.purpose)];
  let children = body;
  let figureNo = 1;
  function heading(text, level = 1) {
    markdown.push(`${'#'.repeat(level + 1)} ${text}`);
    children.push(new Paragraph({ heading: level === 1 ? HeadingLevel.HEADING_1 : HeadingLevel.HEADING_2, text }));
  }
  function paragraphs(values, list = false) {
    for (const raw of values) {
      const value = businessText(raw);
      markdown.push(list ? `- ${value}` : value);
      children.push(list ? new Paragraph({ bullet: { level: 0 }, text: value }) : new Paragraph(value));
    }
  }
  function table(head, rows, columns) {
    if (!rows.length) return;
    rows = rows.map(row => row.map(businessText));
    markdown.push(mdTable(head, rows));
    children.push(templateTable(head, rows, columns, word));
  }
  function screenshotNote(screenshot) {
    const source = ['A', 'B', 'C'].includes(screenshot.source) ? `证据等级 ${screenshot.source}` : '证据等级待核对';
    return `${screenshot.note} ${source}；来源：${screenshot.sourceType || '真实 Debug 页面'}。`;
  }
  const renderSection = {
    scope: () => {
      paragraphs(content.scope.filter(s => !/用户手动推进|当前实际办理节点/.test(s)));
      paragraphs([`本资料收录 ${nodeSections.length} 个已采集页面节点；页面、历史快照与实际动作分别标记，未执行路径仅作配置确认。`]);
      paragraphs(content.requirements.filter(s=> !/已经办理过此任务/.test(s)), true);
    },
    association: () => {
      const association = businessAssociation(bundle);
      if (!association) { paragraphs(['现有证据未确认独立前置流程依赖；关联数据要求以字段及规则表为准。']); return; }
      paragraphs(association.paragraphs);
      const associationRows = association.fields.flatMap(field =>
        field.labels.map(label => ['前置业务关联', label, '按已核验来源', `${field.source}；${field.rules}`]));
      table(['分组', '字段名称', '字段类型', '必填', '出现阶段', '数据来源/规则'], associationRows, word.fieldsColumns);
      paragraphs(association.limits);
    },
    flow: () => {
      paragraphs(content.flow);
      if (diagram) {
        paragraphs(['以下为后台原始完整流程图；可缩放原图及大幅参考图见附录 A。']);
        children.push(imageParagraph(diagram, word.page, 140, '完整业务流程'));
        markdown.push(`![完整业务流程](${originalPngName})`);
      }
    },
    roles: () => {
      const names = new Map(bundle.workflow.nodes.map(n => [String(n.id),n.name]));
      for (const gateway of bundle.workflow.nodes.filter(n => n.type === '分流')) {
        const targets = bundle.workflow.transitions.filter(e => String(e.source) === String(gateway.id))
          .map(e => names.get(String(e.target))).filter(Boolean);
        if (targets.length > 1) paragraphs([`并行办理（Workflow 配置）：${targets.join('、')}属于同一分流后的并行环节，以下排列不表示依次审批。`]);
      }
      table(['节点', '办理角色', '进入与后续办理', '验证状态'],
        workflowOrder(bundle.workflow).filter(n => n.type === '办理').map(n => {
          const evidence = nodeSections.find(s => String(s.nodeId) === String(n.id));
          const incoming = bundle.workflow.transitions.filter(e => String(e.target) === String(n.id));
          const outgoing = bundle.workflow.transitions.filter(e => String(e.source) === String(n.id));
          return [n.name, evidence?.role || bundle.nodeEvidence?.find(e => String(e.id) === String(n.id))?.role || '待确认',
            `进入：${incoming.map(e => `${names.get(String(e.source))}（${e.name}）`).join('；') || '流程入口'}。后续：${outgoing.map(e => `${e.name} → ${names.get(String(e.target))}`).join('；')}`,
            evidence?.verified ? '有实际流转证据' : evidence ? '页面已采集，动作未验证' : 'Workflow 配置确认'];
        }), [18,18,47,17]);
    },
    nodeEvidence: () => {
      if (!nodeSections.length) {
        paragraphs(['尚未采集到可插入正文的真实 Debug 节点截图；相关节点仅保留配置分析与证据缺口说明。']);
        return;
      }
      paragraphs(['本节按实际办理顺序说明关键节点。每个节点均把业务说明、字段要求、真实页面截图和按钮流转放在一起，便于新平台开发时直接对照实现；历史只读快照不表示新的提交动作。']);
      for (const item of nodeSections) {
        markdown.push(`### 节点：${item.name}`);
        children.push(new Paragraph({ heading: HeadingLevel.HEADING_2, text: `节点：${item.name}` }));
        children.push(new Paragraph({ style: 'BusinessMeta', text: `办理角色/身份：${item.role} ｜ 页面来源：${item.sourceNote} ｜ 流转证据：${item.verified ? '实际提交并核对流转' : '页面实测，动作按配置或待确认'}` }));
        children.push(new Paragraph({ style: 'BusinessCaption', text: '业务说明' }));
        paragraphs([item.description]);
        children.push(new Paragraph({ style: 'BusinessCaption', text: '主要字段' }));
        table(['分组', '字段名称', '字段类型', '必填', '出现阶段', '数据来源/规则'], nodeFieldsForWord(item.fields), word.fieldsColumns);
        if (!item.fields.length) paragraphs(['未取得可单独确认的新增或可编辑字段证据；通用只读资料见字段清单，不能根据历史快照推断当前编辑权限。']);
        for (const screenshot of item.screenshots) {
          const caption = `图 N-${String(figureNo++).padStart(2, '0')}  ${item.name} · ${screenshot.title}`;
          children.push(new Paragraph({ style: 'BusinessCaption', text: caption, keepNext: true }));
          children.push(new Paragraph({ text: screenshotNote(screenshot), keepNext: true }));
          children.push(...imageParagraphSegments(screenshot.image, word.formPage, 150, caption));
          markdown.push(`### ${caption}`, screenshotNote(screenshot), `![${caption}](${screenshot.file})`);
        }
        children.push(new Paragraph({ style: 'BusinessCaption', text: '操作按钮及流转' }));
        table(['按钮', '执行条件', '目标节点', '验证状态'], item.buttons, [25, 24, 34, 17]);
        if (item.rules.length) {
          children.push(new Paragraph({ style: 'BusinessCaption', text: '特殊规则与条件证据' }));
          paragraphs(item.rules, true);
        }
      }
    },
    approvals: () => {
      table(['类别／条件', '后续处理'], content.approvals, word.approvalsColumns);
      paragraphs(content.approvers);
      paragraphs(content.returnNotes);
    },
    requirements: () => {
      if (bundle.crossFlow) {
        const { summary, fields, limits } = bundle.crossFlow;
        heading('前置业务关联与带出字段', 2);
        paragraphs(summary);
        table(['字段', '绑定', '来源及核验', '填写与权限'], fields, [20, 23, 28, 29]);
        // Later Debug records supersede earlier blocked-attempt conclusions.
        paragraphs(limits.filter(limit => !/本地校验阻断|护照状态查询失败/.test(limit)));
      }
      paragraphs(content.requirements, true);
    },
    fields: () => {
      paragraphs(['每个真实业务字段独立列示，分组仅用于分类；同一字段跨阶段出现时汇总阶段状态。空白模板值不代表运行时默认值。人员字段未注明范围时，仍须核对，不能理解为任意人员可选。']);
      for (const [i, group] of content.fields.entries()) {
        heading(`${i + 1}  ${group.title}`, 2);
        table(['分组', '字段名称', '字段类型', '必填', '出现阶段', '数据来源/规则'], atomicRowsForWord(group.fields), word.fieldsColumns);
      }
      const special = bundle.stageFieldAnalysis?.special ?? [];
      if (special.length) {
        heading(template.specialFields?.title ?? '特殊字段的阶段与来源规则', 2);
        paragraphs(['以下为实测状态或人员过滤配置，普通字段见前表。节点间差异的触发原因、条件必填边界、人员目录及组织关系仍须单独验证。阶段图见附录 B，已补采的字段局部图见附录 C。']);
        const candidates = special.filter(s => s.name !== s.fieldId || profile?.fields?.[s.fieldId]?.name)
          .filter(s => s.source.startsWith('人员选择') || /审核|审批|意见|负责人|公示|行前/.test(profile?.fields?.[s.fieldId]?.name || s.name))
          .map(s => [profile?.fields?.[s.fieldId]?.name || s.name, s.stage,
            s.source.replace(' 组织目录来源及上下级关系未单独验证。',''),
            s.rule.replace('，条件必填边界待核对','').replace('跨节点状态存在差异，具体触发原因不能仅凭阶段变化推断。','')]);
        const rows = candidates;
        table(['分组', '字段名称', '字段类型', '必填', '出现阶段', '数据来源/规则'], atomicRowsForWord(atomicFieldRows(candidates, { groupName: '特殊字段' })),
          word.specialFieldsColumns ?? [20,18,30,32]);
      }
    },
    questions: () => {
      const questions = content.questions.filter(q => !/^仍未完成自动运行验收/.test(q));
      const decisions = questions.filter(q=>/^确认「/.test(q));
      paragraphs(questions.filter(q=>!/^确认「/.test(q)), true);
      if (decisions.length) paragraphs([`尚待核对的判断边界：${decisions.map(q=>q.match(/「(.*?)」/)?.[1]).filter(Boolean).join('、')}；配置路径见第七章。`], true);
      const unvisited = bundle.workflow.nodes.filter(n=>n.type==='办理' && !nodeSections.some(s=>String(s.nodeId)===String(n.id)));
      if (unvisited.length) paragraphs([`尚无真实页面取证的办理节点：${unvisited.map(n=>n.name).join('、')}。这些节点仅按 Workflow/XSN 配置描述，不计为 Debug 已验证。`],true);
    },
  };
  const include = {
    approvals: content.approvals.length || content.returnNotes.length,
    requirements: content.requirements.length || bundle.crossFlow,
    questions: content.questions.length,
  };
  let ordinal = 0;
  const sections = [];
  let currentPage = word.page;
  for (const item of template.sections) {
    if (!Object.hasOwn(renderSection, item.key)) throw new Error(`未知业务文档章节 ${item.key}`);
    const page = item.key === 'nodeEvidence' ? word.formPage : word.page;
    if (page !== currentPage) {
      sections.push(section(children, currentPage, headers, footers));
      children = [];
      currentPage = page;
    }
    heading(`${cn[ordinal] ?? ordinal + 1}、${item.title}`);
    ordinal++;
    renderSection[item.key]();
  }
  sections.push(section(children, currentPage, headers, footers));
  children = [];
  heading('九、附录');
  heading(appendix.flow);
  paragraphs([diagram ? '下图取自 InfoPlus IDE Workflow 编辑器的完整原始画布。' :
    '本版本尚未取得可核对的 InfoPlus IDE Workflow 原始画布。取得完整原图后，可单独重生成业务版。']);
  if (diagram) {
    paragraphs([appendix.flowNote]);
    markdown.push(`![InfoPlus IDE 原始流程图](${originalPngName})`, `[查看可缩放原图](${originalSvgName})`);
    children.push(imageParagraph(diagram, word.diagramPage, 100, appendix.flow));
    if (diagram.width / diagram.height > 2) {
      paragraphs(['以下按原图从左到右放大，边界保留重叠区域；节点位置及连线均来自同一原始画布。']);
      for (let i = 0; i < 3; i++) {
        const left = Math.max(0, i / 3 - .025);
        const right = Math.min(1, (i + 1) / 3 + .025);
        const w = (word.diagramPage.width - word.diagramPage.left - word.diagramPage.right) / 15 - 4;
        const h = (word.diagramPage.height - word.diagramPage.top - word.diagramPage.bottom) / 15 - 120;
        const scale = Math.min(w / (diagram.width * (right-left)), h / diagram.height);
        children.push(new Paragraph({style:'BusinessCaption', text:`流程图局部 ${i+1}/3（按原图从左到右）`,pageBreakBefore:true}),
          new Paragraph({children:[new ImageRun({data:diagram.data,type:'png',
            crop:{left:left*100, right:(1-right)*100, top:0, bottom:0},
            transformation:{width:Math.round(diagram.width*(right-left)*scale),height:Math.round(diagram.height*scale)}})]}));
      }
    }
  }
  sections.push(section(children, word.diagramPage, headers, footers));
  children = [];
  heading(appendix.forms);
  paragraphs([appendix.formNote]);
  if (unavailable.length) paragraphs([`以下阶段尚无可用静态图：${unavailable.join('、')}。`]);
  for (const [index, panel] of panels.entries()) {
    const caption = `图 B-${String(index + 1).padStart(2, '0')}  ${panel.labels.join('、')}`;
    const use = [...panel.uses].join(' ');
    markdown.push(`### ${caption}`, use, `![${caption}](${panel.path})`);
    children.push(
      new Paragraph({ style: 'BusinessCaption', text: caption, pageBreakBefore: index > 0 }),
      new Paragraph({ text: use, keepNext: true }),
      ...imageParagraphSegments(panel, word.formPage, index === 0 ? 165 : 130, caption),
    );
  }
  sections.push(section(children, word.formPage, headers, footers));
  const historyImages = [...bundle.debugHistory?.stages ?? []].reverse().flatMap(stage => stage.images.map(item => ({...item,stage})));
  const keyFields = new Set((bundle.stageFieldAnalysis?.special ?? []).filter(item => /审核|审批|意见|负责人|公示|行前|系所/.test(profile?.fields?.[item.fieldId]?.name || item.name)).map(item => item.fieldId));
  const seenFields = new Set();
  const selectedImages = historyImages.filter(item => {
    if (!keyFields.has(item.fieldId) || seenFields.has(item.fieldId)) return false;
    seenFields.add(item.fieldId); return true;
  });
  if (selectedImages.length) {
    children = []; heading(appendix.details ?? '附录 C  特殊字段局部参考');
    paragraphs(['以下为同一 Debug 实例已完成步骤的历史页面局部图，字段值已遮盖。只证明页面展示，不证明条件切换、成员候选范围变化或新的审批操作。']);
    const imageHashes = new Set();
    for (const item of selectedImages) {
      const path=resolve(directory,item.file);
      if (!path.startsWith(resolve(directory,'debug-evidence')+sep)) continue;
      const picture=await png(path); if(!picture) continue;
      const digest=createHash('sha256').update(picture.data).digest('hex');
      if(imageHashes.has(digest)) continue;
      imageHashes.add(digest);
      const name=profile?.fields?.[item.fieldId]?.name || bundle.fields.find(f=>f.id===item.fieldId && f.name!==f.id)?.name;
      if(!name) continue;
      const caption=`${name} · ${item.stage.state.name.trim()}（历史页面）`;
      children.push(new Paragraph({style:'BusinessCaption',text:caption}),imageParagraph(picture,word.page,160,caption));
      markdown.push(`### ${caption}`,`![${caption}](${item.file})`);
    }
    sections.push(section(children,word.page,headers,footers));
  }
  const doc = new Document({ title, styles: styles(word), sections });
  const docxPath = join(directory, customDocxName(bundle.project));
  await writeWordAtomic(docxPath, await Packer.toBuffer(doc));
  await writeFile(join(directory, 'requirements_custom.md'), markdown.join('\n\n') + '\n');
  return { docxPath, hasOriginalDiagram: Boolean(diagram) };
}

