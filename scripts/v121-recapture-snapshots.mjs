import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { captureFullForm } from '../src/full-form-capture.mjs';

const directory = path.resolve(process.argv[2]);
const root = path.join(directory, 'debug-evidence');
const index = JSON.parse(await fs.readFile(path.join(root, 'screenshot-index.json'), 'utf8'));
const urls = {
  14: 'https://one.zju.edu.cn/infoplus/form/15556116/render?snapshot=true',
  27: 'https://one.zju.edu.cn/infoplus/form/15556127/render?entrust=true',
  32: 'https://one.zju.edu.cn/infoplus/form/15556056/render?snapshot=true',
  30: 'https://one.zju.edu.cn/infoplus/form/15556057/render?snapshot=true',
  37: 'https://one.zju.edu.cn/infoplus/form/15555969/render?snapshot=true',
  48: 'https://one.zju.edu.cn/infoplus/form/15555924/render?snapshot=true',
  42: 'https://one.zju.edu.cn/infoplus/form/15555899/render?snapshot=true',
  7: 'https://one.zju.edu.cn/infoplus/form/15555553/render?snapshot=true',
  24: 'https://one.zju.edu.cn/infoplus/form/15555527/render?snapshot=true',
};
const browser = await chromium.connectOverCDP(process.env.INFOPLUS_CDP || 'http://127.0.0.1:9222/', { timeout: 25000 });
const page = await browser.contexts()[0].newPage();
const results = [];
try {
  for (const [position, node] of index.nodes.entries()) {
    try {
      await page.route('**/*', route => /\/interface\/(doAction|start|save)(?:\?|$)/i.test(route.request().url())
        ? route.abort() : route.continue());
      await page.goto(urls[node.nodeId], { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForFunction(() => !!window.$$?.entity?.step, undefined, { timeout: 20000 });
      await page.waitForTimeout(1200);
      const meta = {
        index: position + 1, nodeId: node.nodeId, nodeName: node.nodeName,
        flowStepId: node.flowStepId, instanceId: node.instanceId, url: page.url(),
        pageType: node.pageType, capturedAt: new Date().toISOString(),
        source: node.pageType === 'live-debug' ? '当前 Debug 表单只读采集' : '同一实例历史只读表单',
      };
      const shot = await captureFullForm(page, meta, { root });
      Object.assign(node, {
        images: shot.images, folder: path.relative(root, shot.folder),
        pageChecks: shot.pageChecks, metrics: { width: shot.metrics.width, height: shot.metrics.height },
        source: shot.source,
        verificationNote: node.pageType === 'historical-snapshot'
          ? '历史只读页面；证明页面结构，不证明新条件切换或新动作'
          : '当前实时节点；未在本轮重复提交动作',
        buttonDetectionNote: shot.buttonDetectionNote, buttonsDetected: [], error: undefined,
      });
      results.push({ node: node.nodeId, eligible: shot.images.filter(image => image.quality?.eligible).length,
        complete: shot.pageChecks.complete, width: shot.metrics.width, height: shot.metrics.height });
      console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
      Object.assign(node, { images: [], error: String(error.message || error).slice(0, 180) });
      results.push({ node: node.nodeId, error: node.error });
      console.log(JSON.stringify(results.at(-1)));
    }
    await page.unrouteAll().catch(() => {});
  }
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
}
await fs.mkdir(path.join(directory, 'reports/v1.2.1'), { recursive: true });
await fs.writeFile(path.join(root, 'screenshot-index.json'), JSON.stringify(index, null, 2) + '\n');
await fs.writeFile(path.join(directory, 'reports/v1.2.1/recapture.json'), JSON.stringify(results, null, 2) + '\n');
console.log('RECAPTURE_DONE', JSON.stringify(results));
