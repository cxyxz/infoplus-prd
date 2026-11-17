import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFragment, serializeOuter } from 'parse5';
import { withRenderer } from './render.mjs';

export const editorCanvas = 'iframe[src*="/editor-vue/"]';
export const originalSvgName = 'workflow-original.svg';
export const originalPngName = 'workflow-original.png';
const rawCanvas = 'workflow-editor-dom.svg';
const metadata = 'workflow-original.json';
const hash = data => createHash('sha256').update(data).digest('hex');
const tags = new Set([
  'svg', 'g', 'image', 'foreignObject', 'div', 'span', 'br', 'b', 'strong', 'i', 'em',
  'path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line', 'text', 'tspan',
  'defs', 'clipPath', 'marker', 'linearGradient', 'radialGradient', 'stop', 'title', 'desc',
]);
const embeddedImage = /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/=\s]+$/i;

function* elements(node) {
  if (node.tagName) yield node;
  for (const child of node.childNodes ?? []) yield* elements(child);
}

const textOf = node => node.nodeName === '#text' ? node.value : (node.childNodes ?? []).map(textOf).join('');
const clean = text => (text ?? '').replace(/\s+/g, ' ').trim();

function checkCanvas(root, workflow) {
  const groups = [...elements(root)].filter(node => node.tagName === 'g');
  const edgeGroup = node => {
    const children = node.childNodes.filter(child => child.tagName);
    return children.length === 3 && children.every(child => child.tagName === 'path');
  };
  // mxGraph groups the drawing paths in one pane and overlays in a separate pane.
  const edgeCount = Math.max(0, ...groups.map(pane =>
    pane.childNodes.filter(node => node.tagName === 'g' && edgeGroup(node)).length));
  const labels = [...elements(root)].filter(node => node.tagName === 'foreignObject').map(node => clean(textOf(node)));
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  const expected = [...workflow.nodes.map(node => node.name), ...workflow.transitions.map(edge =>
    edge.attributes?.displayName ?? edge.name)].map(clean).filter(Boolean);
  const missing = expected.filter(label => {
    const count = counts.get(label) ?? 0;
    counts.set(label, count - 1);
    return count <= 0;
  });
  if (!workflow.nodes.length || !workflow.transitions.length || edgeCount !== workflow.transitions.length || missing.length) {
    throw new Error(`IDE 画布与此版本定义不符（连线 ${edgeCount}/${workflow.transitions.length}，未匹配标签 ${missing.length}）`);
  }
  return { nodes: workflow.nodes.length, edges: edgeCount, labels: labels.length };
}

async function icon(href, origin) {
  const url = new URL(href, origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password ||
      url.search || url.hash || !/\/static\/editor-vue\/(?:img|assets)\/.+\.(?:png|jpe?g|gif|webp)$/i.test(url.pathname)) {
    throw new Error('IDE 画布包含未识别的图标来源');
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(6000), redirect: 'error' });
  const type = response.headers.get('content-type')?.split(';')[0];
  if (!response.ok || !/^image\/(?:png|jpeg|gif|webp)$/.test(type ?? '')) throw new Error('无法读取 IDE 画布图标');
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length || data.length > 1_000_000) throw new Error('IDE 画布图标尺寸异常');
  return `data:${type};base64,${data.toString('base64')}`;
}

export async function prepareOriginalWorkflow(raw, bundle, directory) {
  if (Buffer.byteLength(raw) > 15_000_000) throw new Error('原始画布文件过大');
  const parsed = parseFragment(raw);
  const roots = parsed.childNodes.filter(node => node.tagName);
  const root = roots[0];
  if (roots.length !== 1 || root?.tagName !== 'svg') throw new Error('未找到完整 Workflow SVG');
  const stats = checkCanvas(root, bundle.workflow);
  const origin = new URL(bundle.project.editor).origin;
  const images = new Map();
  for (const node of elements(root)) {
    if (!tags.has(node.tagName)) throw new Error(`IDE 画布包含不支持的元素 ${node.tagName}`);
    for (const attr of node.attrs ?? []) {
      if (/^on|^src|^xml:base/i.test(attr.name) ||
          /url\s*\(\s*[^#]/i.test(attr.value.replace(/url\(#[^)]*\)/gi, '')) ||
          (attr.name === 'style' && /url\s*\(|@import|expression\s*\(/i.test(attr.value))) {
        throw new Error('IDE 画布包含不支持的活动内容');
      }
      if (attr.name !== 'href') continue;
      if (node.tagName !== 'image') throw new Error('IDE 画布包含不支持的链接');
      if (embeddedImage.test(attr.value)) continue;
      if (!images.has(attr.value)) images.set(attr.value, []);
      images.get(attr.value).push(attr);
    }
  }
  await Promise.all([...images].map(async ([href, attrs]) => {
    const data = await icon(href, origin);
    for (const attr of attrs) attr.value = data;
  }));
  root.attrs = root.attrs.filter(attr => !['style', 'width', 'height', 'viewBox'].includes(attr.name));
  root.attrs.push({ name: 'width', value: '4096' }, { name: 'height', value: '4096' });
  const outputPng = join(directory, originalPngName);
  let result;
  await withRenderer(async render => {
    result = await render(serializeOuter(root), outputPng, undefined, [], { fitWorkflowSvg: true });
  });
  await writeFile(join(directory, originalSvgName), result.svg);
  const provenance = {
    source: 'InfoPlus IDE Workflow canvas SVG',
    editor: bundle.project.editor,
    workflowDefinitionId: bundle.project.workflowDefinitionId,
    ...stats, icons: images.size, bounds: result.bounds, pixels: result.pixels,
    pngSha256: hash(await readFile(outputPng)), svgSha256: hash(result.svg),
  };
  await writeFile(join(directory, metadata), JSON.stringify(provenance, null, 2) + '\n');
  return provenance;
}

export async function originalWorkflowImage(bundle, directory) {
  try {
    const record = JSON.parse(await readFile(join(directory, metadata), 'utf8'));
    if (record.workflowDefinitionId !== bundle.project.workflowDefinitionId ||
        record.editor !== bundle.project.editor || record.edges !== bundle.workflow.transitions.length ||
        record.nodes !== bundle.workflow.nodes.length) return;
    const [png, svg] = await Promise.all([
      readFile(join(directory, originalPngName)), readFile(join(directory, originalSvgName)),
    ]);
    if (hash(png) === record.pngSha256 && hash(svg) === record.svgSha256) return png;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

export async function originalWorkflowSource(directory) {
  try { return await readFile(join(directory, 'raw', rawCanvas), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function collectEditorCanvas(page, directory) {
  const canvas = page.frameLocator(editorCanvas).locator('svg:has(foreignObject)').first();
  const markup = await canvas.evaluate(svg => svg.outerHTML, undefined, { timeout: 6500 });
  await writeFile(join(directory, 'raw', rawCanvas), markup);
}
