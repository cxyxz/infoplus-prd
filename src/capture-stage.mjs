import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseWorkflow } from './infoplus.mjs';
import { permittedProbeRequest } from './live-options.mjs';

const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const previewApi = '/infoplus/interface/preview';

async function cachedPreview(context, entry, project) {
  const anchor = context.pages().find(page => URL.parse(page.url())?.origin === entry.origin);
  if (!anchor) return;
  return anchor.evaluate(async ({ url, definition, code }) => {
    const response = await fetch(url, { cache: 'only-if-cached', mode: 'same-origin', redirect: 'manual',
      signal: AbortSignal.timeout(3500) }).catch(() => undefined);
    if (!response?.ok) return;
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const scripts = [...doc.scripts].map(script => script.textContent).join('\n');
    const workflowId = scripts.match(/\bworkflowId\s*=\s*["']([\w-]+)["']/)?.[1];
    const pageCode = doc.title.trim().split(/[:：\s]/)[0];
    if (workflowId === definition && pageCode.toLowerCase() === code.toLowerCase() &&
        /\$\$\.PREVIEW\s*=\s*true\b/.test(scripts)) return html;
  }, { url: entry.href, definition: project.workflowDefinitionId, code: project.code });
}

async function capturePreview(context, entry, html, project, viewId, refresh) {
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    const frame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
    await cdp.send('Network.setBypassServiceWorker', { bypass: true });
    await page.setViewportSize({ width: 1440, height: 950 });
    await page.addInitScript(() => { window.open = () => null; });
    await page.routeWebSocket('**/*', socket => socket.close());
    let opened = false;
    let previewSent = false;
    cdp.on('Fetch.requestPaused', async ({ requestId, request, resourceType, frameId, networkId }) => {
      try {
        const url = new URL(request.url);
        const type = resourceType.toLowerCase();
        const method = request.method;
        const sameFrame = frameId === frame;
        if (!opened && type === 'document' && method === 'GET' && sameFrame && url.href === entry.href) {
          opened = true;
          if (refresh) return await cdp.send('Fetch.continueRequest', { requestId });
          return await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 200,
            responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
            body: Buffer.from(html).toString('base64') });
        }
        const preview = !previewSent && method === 'POST' && url.origin === entry.origin && url.pathname === previewApi &&
          !url.search && ['fetch', 'xhr'].includes(type) && sameFrame;
        if (preview) {
          const body = request.postData ?? (await cdp.send('Network.getRequestPostData', { requestId: networkId })).postData;
          const params = new URLSearchParams(body);
          if (body.length <= 32768 && params.getAll('workflowId').length === 1 &&
              params.get('workflowId') === project.workflowDefinitionId && params.has('rand') && params.has('width')) {
            previewSent = true;
            return await cdp.send('Fetch.continueRequest', { requestId });
          }
        }
        const asset = ['stylesheet', 'image', 'font', 'script'].includes(type);
        const alive = method === 'GET' && url.origin === entry.origin && url.pathname === '/infoplus/alive' &&
          ['xhr', 'fetch'].includes(type) && sameFrame;
        if (alive || asset && permittedProbeRequest(url, method, type, entry)) {
          return await cdp.send('Fetch.continueRequest', { requestId });
        }
      } catch {
        // Interception errors fail closed.
      }
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
    const pending = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === entry.origin && url.pathname === previewApi && response.request().method() === 'POST';
    }, { timeout: 12000 }).catch(() => undefined);
    await page.goto(entry.href, { waitUntil: 'domcontentloaded', timeout: 12000 });
    const response = await pending;
    const result = response?.ok() && await response.json();
    if (![0, '0'].includes(result?.errno) || result.entities?.[0]?.viewId !== viewId) {
      throw new Error(`欢迎页预览未返回匹配的视图（${result?.errno ?? response?.status() ?? '未收到响应'}）`);
    }
    const content = page.locator('#div_render_container');
    await content.waitFor({ state: 'visible', timeout: 12000 });
    const detail = await page.evaluate(() => {
      const main = document.querySelector('#div_render_container');
      const visible = node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden';
      // The renderer can put long instructions in nested scroll containers.
      const ancestors = [];
      for (let node = main; node; node = node.parentElement) ancestors.push(node);
      for (const node of [...ancestors, ...main.querySelectorAll('div,section,article')]) {
        if (!visible(node) || node.scrollHeight <= node.clientHeight + 2) continue;
        const style = getComputedStyle(node);
        if (!/auto|scroll|hidden|clip/.test(style.overflowY)) continue;
        node.style.setProperty('overflow', 'visible', 'important');
        node.style.setProperty('max-height', 'none', 'important');
        if (node !== document.documentElement) node.style.setProperty('height', 'auto', 'important');
      }
      const text = main.innerText.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
      const startAction = /^(?:开始办理|立即办理|我要申请|发起申请|开始申请)$/;
      const controls = [...main.querySelectorAll('a[href],button,input[type=button],input[type=submit],input[type=checkbox],[role=button],[role=checkbox]')];
      // This renderer also uses clickable divs for the primary action.
      for (const node of main.querySelectorAll('*')) {
        if (!controls.includes(node) && visible(node) && startAction.test((node.innerText ?? '').trim())) controls.push(node);
      }
      const actions = controls
        .filter(visible).map(node => {
          const checkbox = node.matches('input[type=checkbox],[role=checkbox]');
          const label = (node.innerText || node.getAttribute('aria-label') || node.labels?.[0]?.innerText ||
            (checkbox ? node.closest('td')?.innerText : node.value) || node.title || '').trim();
          const href = node.getAttribute('href');
          const url = href && URL.parse(href, location.href);
          const address = url && /^(http|https):$/.test(url.protocol) && !url.username && !url.password
            ? url.origin + url.pathname : undefined;
          const kind = address ? '链接' : checkbox ? '勾选项' : '按钮';
          const purpose = /^(?:开始办理|立即办理|我要申请|发起申请|开始申请|Start|Apply)(?:\s|$)/i.test(label)
            ? '进入流程的首个办理步骤'
            : checkbox && /已.*阅读|同意.*须知/.test(label) ? '确认已阅读办理说明'
              : address && /\/infoplus\/form\/[^/]+\/start\/?$/.test(url.pathname) ? '进入页面所指的另一项办理流程'
                : address ? '打开链接所指资料' : undefined;
          return { label, kind, address, purpose };
        }).filter(action => action.label);
      const distinct = new Map(actions.map(action => [JSON.stringify(action), action]));
      return { title: document.title, text, actions: [...distinct.values()],
        contentHeight: Math.ceil(Math.max(main.scrollHeight, main.getBoundingClientRect().bottom + scrollY)) };
    });
    if (!detail.text) throw new Error('欢迎页未呈现说明文字');
    const image = await page.screenshot({ fullPage: true, animations: 'disabled', timeout: 10000 });
    if (image.readUInt32BE(20) < detail.contentHeight) throw new Error('欢迎页截图未覆盖完整正文');
    return { ...detail, image };
  } finally { await page.close(); }
}

export async function captureStagePages(context, directory, project, supplied) {
  const index = await readJson(join(directory, 'raw', 'network', 'index.json'));
  const item = index.captured.findLast(row => row.kind === 'workflow' && row.source.endsWith('/findWorkflowDefinition'));
  if (!item || basename(item.file) !== item.file) return { captured: 0, reason: '未取得工作流定义' };
  const workflow = parseWorkflow(await readJson(join(directory, 'raw', 'network', item.file)), project, item.file);
  const viewId = workflow?.startView;
  if (!/^[0-9a-f-]{36}$/i.test(viewId ?? '') || !project.views?.some(view => view.id === viewId)) {
    return { captured: 0, reason: '未配置可核对的入口视图' };
  }
  const ide = new URL(project.source);
  const slug = /^\/infoplus\/ide\/project\/([\w-]+)\/?$/i.exec(ide.pathname)?.[1];
  if (!slug) return { captured: 0, reason: '缺少可核对的前台项目路径' };
  const path = `/infoplus/form/${slug}/start`;
  const sameEntry = url => url?.origin === ide.origin && url.pathname === path && !url.username && !url.password;
  const entries = supplied ? [URL.parse(supplied)] : [
    ...context.pages().map(page => URL.parse(page.url())).filter(sameEntry),
    new URL(`${path}?theme=zju_new`, ide), new URL(path, ide),
  ];
  if (supplied && !sameEntry(entries[0])) throw new Error('欢迎页必须属于指定项目及已授权的 InfoPlus 站点');
  for (const url of new Map(entries.map(entry => [entry.href, entry])).values()) {
    const html = await cachedPreview(context, url, project);
    if (!html) continue;
    const { image, ...detail } = await capturePreview(context, url, html, project, viewId, Boolean(supplied));
    const viewDirectory = join(directory, 'views', viewId);
    const filename = `live-stage-${randomUUID()}.png`;
    await mkdir(viewDirectory, { recursive: true });
    const manifest = join(viewDirectory, 'live-stage.json');
    const previous = await readJson(manifest).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const screenshot = previous?.screenshot;
    if (screenshot && /^live-stage-[a-f0-9-]+\.png$/i.test(screenshot) && previous.text === detail.text &&
        JSON.stringify(previous.actions) === JSON.stringify(detail.actions) &&
        (await readFile(join(viewDirectory, screenshot)).catch(() => undefined))?.equals(image)) {
      return { captured: 1, changed: false, viewId, screenshot: `views/${viewId}/${screenshot}` };
    }
    await writeFile(join(viewDirectory, filename), image, { flag: 'wx' });
    const next = join(viewDirectory, `${filename}.json.tmp`);
    await writeFile(next, JSON.stringify({ ...detail, code: project.code, version: project.version,
      definitionId: project.workflowDefinitionId, viewId, source: url.origin + url.pathname,
      screenshot: filename, width: image.readUInt32BE(16), height: image.readUInt32BE(20) }, null, 2), { flag: 'wx' });
    await rename(next, manifest);
    return { captured: 1, changed: true, viewId, screenshot: `views/${viewId}/${filename}` };
  }
  return { captured: 0, reason: '当前 Chrome 没有匹配版本的前台预览缓存，可使用 XSN 阶段图' };
}
