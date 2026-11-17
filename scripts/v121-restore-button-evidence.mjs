/**
 * V1.2.1: restore validated action-button crops from the same DEBUG instance.
 * The recapture pass intentionally replaces all page images; this script adds back only
 * button pictures whose source and labels were already confirmed in the pre-recapture index.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright-core';
import { cropBottomRegion, pngInfo } from '../src/screenshot-evidence.mjs';
import { screenshotValue } from '../src/screenshot-quality.mjs';

const directory = path.resolve(process.argv[2]);
const root = path.join(directory, 'debug-evidence');
const sourceIndex = JSON.parse(await fs.readFile(path.join(directory, 'reports/v1.2.1/screenshot-index-before.json'), 'utf8'));
const cropSources = JSON.parse(await fs.readFile(path.join(directory, 'button-crop-sources.json'), 'utf8'));
const index = JSON.parse(await fs.readFile(path.join(root, 'screenshot-index.json'), 'utf8'));
const byNode = new Map(index.nodes.map(node => [Number(node.nodeId), node]));
const browser = await chromium.connectOverCDP(process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/', { timeout: 25000 });
const results = [];
try {
  for (const old of sourceIndex.nodes) {
    const nodeId = Number(old.nodeId);
    const node = byNode.get(nodeId);
    const oldButton = (old.images || []).find(image => image.category === 'action-buttons');
    const source = cropSources[String(nodeId)];
    if (!node || !oldButton || !source) continue;
    const labels = source.labels || [];
    if (!labels.length) continue;
    const target = path.join(root, node.folder, 'action-buttons.png');
    const info = await cropBottomRegion(browser, source.file, target,
      { height: source.cropHeight || 420, excludeBottom: source.excludeBottom || 55 });
    const bytes = await fs.readFile(target);
    const image = {
      file: target, category: 'action-buttons', sourceVariant: 'masked',
      nodeId, width: info.width, height: info.height, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      labels, detection: 'live-full-page-bottom-crop',
      title: '底部业务操作按钮', purpose: '从同一 DEBUG 实例实时办理完整截图裁剪的底部业务操作按钮区',
      reviewed: true,
    };
    image.quality = screenshotValue(image, { nodeId });
    node.images = [...node.images.filter(item => item.category !== 'action-buttons'), image];
    node.buttonsDetected = labels;
    node.buttonDetectionNote = `来源：${source.file}（同一 DEBUG 实例实时办理完整截图底部裁剪）；历史只读表单只证明页面结构。`;
    results.push({ nodeId, width: info.width, height: info.height, labels: labels.length });
  }
} finally {
  await browser.close().catch(() => {});
}
for (const node of index.nodes) {
  node.folder = path.relative(path.dirname(root), node.folder).replace(/\\/g, '/');
  node.images = node.images.map(image => ({ ...image,
    file: path.relative(path.dirname(root), image.file).replace(/\\/g, '/') }));
}
await fs.writeFile(path.join(root, 'screenshot-index.json'), JSON.stringify(index, null, 2) + '\n');
await fs.writeFile(path.join(directory, 'reports/v1.2.1/restore-buttons.json'), JSON.stringify(results, null, 2) + '\n');
console.log('RESTORE_BUTTONS', JSON.stringify(results));
