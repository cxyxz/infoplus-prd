import { DOMParser } from '@xmldom/xmldom';
import { parse } from 'parse5';

const children = element => Array.from(element?.childNodes ?? []).filter(node => node.nodeType === 1);
const child = (element, name) => children(element).find(node => node.tagName === name);
const attr = (element, name) => element?.getAttribute(name) ?? '';
const attrs = element => Object.fromEntries(Array.from(element.attributes, a => [a.name, a.value]));
const body = (element, name) => child(element, name)?.textContent.trim() ?? '';
const types = {
  steps: '办理', autoSteps: '自动步骤', decisions: '判断',
  splits: '分流', joins: '合并', subs: '子流程',
};

export function entity(response) {
  if (response?.errno !== 0 || response.entities?.length !== 1) return;
  return response.entities[0];
}

export function parseWorkflow(response, project, source) {
  const record = entity(response);
  if (record?.success !== true || typeof record.guiDefinition !== 'string') return;
  const xml = record.guiDefinition;
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('工作流 XML 含不受支持的文档类型');
  const root = new DOMParser().parseFromString(xml, 'application/xml').documentElement;
  if (root.tagName !== 'workflow' || (project.projectCode && attr(root, 'code') !== project.projectCode)) {
    throw new Error('工作流响应的项目代码与项目索引不一致');
  }
  const rootEvidence = source + '#/entities/0/guiDefinition';
  const nodes = Object.entries(types).flatMap(([container, type]) =>
    children(child(root, container)).map(node => {
      const id = attr(node, 'seqNo');
      const permissions = children(child(node, 'perms'));
      const executorGroups = permissions.filter(perm => attr(perm, 'type') === 'E').flatMap(children)
        .filter(group => group.tagName === 'posts');
      const actor = executorGroups.map(group => {
        const roles = children(group).filter(item => item.tagName === 'post').map(post => post.textContent || attr(post, 'id'));
        const limits = children(group).filter(item => item.tagName !== 'post').flatMap(item =>
          children(item).map(limit => `${item.tagName}=${attr(limit, 'value')}（类型 ${attr(limit, 'type')}）`));
        return [...roles, ...limits].join('；');
      }).filter(Boolean).join(' / ');
      return {
        id, name: (attr(node, 'displayName') || attr(node, 'name')).trim(), code: attr(node, 'name'), type,
        view: attr(child(node, 'displayView'), 'id'), printView: attr(child(node, 'printView'), 'id'),
        x: attr(node, 'x'), y: attr(node, 'y'), actor,
        attributes: attrs(node), script: body(node, 'script'),
        permissions: permissions.map(perm => perm.toString()),
        fieldPermissions: children(child(node, 'powers')).map(attrs),
        notifications: children(child(node, 'notifications')).map(item => item.toString()),
        evidence: `${rootEvidence} /workflow/${container}/${node.tagName}[@seqNo='${id}']`,
      };
    }));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const transitions = children(child(root, 'edges')).map(edge => {
    const id = attr(edge, 'seqNo');
    const from = attr(edge, 'source');
    const code = attr(edge, 'name');
    const parent = byId.get(from);
    const restrict = body(edge, 'restrictScript');
    return {
      id, source: from, target: attr(edge, 'target'), name: attr(edge, 'displayName') || code, code,
      condition: restrict || (parent?.script && parent.type === '判断' ? `节点 ${from} 返回 ${code}` : ''),
      conditionSource: parent?.type === '判断' && parent.script ? parent.evidence + '/script' : undefined,
      script: body(edge, 'script'), restrictScript: restrict, attributes: attrs(edge),
      evidence: `${rootEvidence} /workflow/edges/edge[@seqNo='${id}']`,
    };
  });
  const externalEvents = children(child(root, 'events')).map(event => ({
    name: attr(event, 'name'), enabled: attr(event, 'enabled') === 'true',
    steps: children(event).map(binding => attr(binding, 'step')).filter(Boolean),
  }));
  return {
    nodes, transitions, externalEvents, description: body(root, 'description'),
    startView: attr(child(root, 'startView'), 'id'), form: attr(root, 'form'),
    released: record.released === true, lastModify: record.lastModify,
  };
}

function* descendants(node, tag) {
  for (const item of node.childNodes ?? []) {
    if (item.tagName === tag) yield item;
    yield* descendants(item, tag);
  }
}
const htmlAttr = (node, name) => node?.attrs?.find(a => a.name === name)?.value ?? '';
const htmlText = node => node.nodeName === '#text' ? node.value :
  (node.childNodes ?? []).map(htmlText).join('');
const hasClass = (node, name) => htmlAttr(node, 'class').split(/\s+/).includes(name);

export function parseFieldIndex(html, origin, views) {
  const rows = [];
  for (const row of descendants(parse(html), 'tr')) {
    const id = htmlAttr(row, 'data-value');
    const uuid = htmlAttr(row, 'title');
    if (!/^[\w.-]+$/u.test(id) || !/^[0-9a-f-]{36}$/i.test(uuid)) continue;
    const cells = row.childNodes.filter(node => node.tagName === 'td');
    if (!cells.length) continue;
    const link = [...descendants(cells[0], 'a')].find(node => hasClass(node, 'btn-nav'));
    const url = link && new URL(htmlAttr(link, 'href'), origin);
    const match = url?.pathname.match(/\/view\/([0-9a-f-]{36})\/field\/([0-9a-f-]{36})$/i);
    if (!match || url.origin !== origin || match[2] !== uuid || !views.has(match[1])) continue;
    const spans = [...descendants(row, 'span')];
    const type = htmlAttr(spans.find(node => hasClass(node, 'data-type')), 'data-value');
    const control = htmlAttr(spans.find(node => hasClass(node, 'bound-type')), 'data-value');
    if (!type) continue;
    const label = [...descendants(cells[0], 'b')].map(htmlText).find(text => text.trim())?.trim();
    const required = [...descendants(cells[0], 'span')]
      .some(node => hasClass(node, 'color-red') && htmlText(node).trim() === '*') ? true : null;
    rows.push({ id, uuid, viewId: match[1], label, type, control, required });
  }
  return rows;
}

// Keep only the table's view records. The page head contains session metadata.
export function parseViews(html, origin, workflowId) {
  const document = parse(html);
  const views = [];
  for (const row of descendants(document, 'tr')) {
    const cells = row.childNodes.filter(node => node.tagName === 'td');
    const id = htmlAttr(cells[0], 'title');
    if (!/^[0-9a-f-]{36}$/i.test(id)) continue;
    const links = [...descendants(row, 'a')];
    const sameOriginPath = (link, expected) => {
      if (!link) return;
      const url = new URL(htmlAttr(link, 'href'), origin);
      if (url.origin === origin && url.pathname.endsWith(expected)) return url.pathname;
    };
    const xsn = sameOriginPath(links.find(a => htmlAttr(a, 'title') === 'Download as XSN'), `/template/${id}/xsn`);
    const json = sameOriginPath(links.find(a => htmlAttr(a, 'title') === 'Download as JSON'), `/template/${id}/json`);
    const page = sameOriginPath(links[0], `/project/${workflowId}/view/${id}`);
    if (!page || (!xsn && !json)) continue;
    views.push({ id, name: htmlText(cells[0]).trim(), created: htmlText(cells[2]).trim(),
      updated: htmlText(cells[3]).trim(), xsn, json, page });
  }
  return views;
}
