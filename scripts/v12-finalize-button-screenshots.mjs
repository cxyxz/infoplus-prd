/**
 * 用同一实例实时办理页面的完整截图裁剪底部业务按钮区，
 * 替换历史快照中只能看到平台工具栏的退化截图，并重建截图索引。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { cropBottomRegion, pngInfo, qualityCheck, writeScreenshotIndex } from '../src/screenshot-evidence.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['root', 'sources']) if (!args[k]) { console.error('MISSING --root or --sources'); process.exit(2); }
const root = path.resolve(args.root);
const sources = JSON.parse(fs.readFileSync(path.resolve(args.sources), 'utf-8'));
const index = JSON.parse(fs.readFileSync(path.join(root, 'screenshot-index.json'), 'utf-8'));
for (const shot of index.nodes) {
  shot.folder = path.resolve(path.dirname(root), shot.folder);
  for (const image of shot.images || []) {
    image.file = path.resolve(path.dirname(root), image.file);
    if (!image.file.startsWith(path.dirname(root) + path.sep)) throw Error('截图索引跨任务');
  }
}
const browser = await chromium.connectOverCDP(process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/', { timeout: 25000 });

for (const shot of index.nodes) {
  const source = sources[String(shot.nodeId)];
  const image = shot.images.find(i => i.category === 'action-buttons');
  if (!image) continue;
  if (!source) {
    // 没有实时按钮区证据时，删除退化截图，不让平台工具栏冒充业务按钮。
    shot.images = shot.images.filter(i => i !== image);
    shot.buttonTransitions = shot.buttonTransitions || [];
    shot.buttonDetectionNote = '该节点未暴露业务按钮 DOM，历史快照只显示平台工具栏；未采集业务按钮截图，按钮依据 Workflow 配置，未冒充实际截图。';
    try { fs.unlinkSync(image.file); } catch {}
    console.log(JSON.stringify({ nodeId: shot.nodeId, action: 'removed-fallback', reason: 'no-live-business-buttons' }));
    continue;
  }
  const info = await cropBottomRegion(browser, source.file, image.file,
    { height: source.cropHeight || 420, excludeBottom: source.excludeBottom || 55 });
  if (!info) continue;
  Object.assign(image, info, { sha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(image.file)).digest('hex'),
    sourceVariant: 'masked', labels: source.labels || [], detection: 'live-full-page-bottom-crop',
    purpose: '文档展示：从同一实例实时办理完整截图裁剪的底部业务操作按钮区' });
  shot.buttonsDetected = source.labels || [];
  shot.buttonDetectionNote = `来源：${source.file}（同一 DEBUG 实例实时办理完整截图的底部裁剪）`;
  console.log(JSON.stringify({ nodeId: shot.nodeId, action: 'cropped', file: image.file, width: info.width, height: info.height }));
}

await browser.close().catch(() => {});
const quality = qualityCheck(index.nodes);
const stats = writeScreenshotIndex(root, index.nodes, quality, {
  code: index.code, version: index.version, definitionId: index.definitionId,
  instanceId: index.instanceId, source: index.source, notes: [...(index.notes || []), '业务按钮区优先取同一实例实时页面完整截图底部裁剪；历史快照不提供按钮时明确标记缺失'],
});
console.log('FINALIZED', JSON.stringify(stats.statistics), 'QUALITY', JSON.stringify({ ok: quality.ok, issues: quality.issues.length }));
