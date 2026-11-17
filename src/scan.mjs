import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { importHarEntries, matchKind } from './har.mjs';
import { importXsn, importTemplateJson } from './xsn.mjs';
import { withRenderer } from './render.mjs';
import { collectEditorCanvas } from './workflow-original.mjs';
import { attachChrome } from './live-options.mjs';
import { probeDebug } from './debug-probe.mjs';
import { collectOnlineEvidence } from './online-evidence.mjs';

const pathSegment = value => {
  if (!/^[\p{L}\p{N}_-]{1,80}$/u.test(value) ||
      /^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/iu.test(value)) {
    throw new Error('项目编号或版本无法作为缓存目录名');
  }
  return value;
};

function observeResponses(page, origin) {
  const pending = new Set();
  const entries = [];
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== origin || !matchKind(url.pathname)) return;
    const promise = (async () => {
      let body;
      try { body = await response.body(); } catch { /* body unavailable */ }
      entries.push({
        request: { method: response.request().method(), url: url.href },
        response: {
          status: response.status(),
          content: body && body.length <= 32000000 ? { text: body.toString('base64'), encoding: 'base64' } : {},
        },
      });
    })();
    pending.add(promise);
    promise.finally(() => pending.delete(promise));
  });
  return { entries, drain: () => Promise.race([
    Promise.allSettled([...pending]),
    new Promise(resolveWait => { const timer = setTimeout(resolveWait, 8000); timer.unref(); }),
  ]) };
}

export async function scan(query, outRoot, { staticOnly = false, outputDirectory } = {}) {
  if (!process.env.INFOPLUS_IDE_URL) throw new Error('先设置 INFOPLUS_IDE_URL 为已获授权的 InfoPlus IDE 入口');
  const start = new URL(process.env.INFOPLUS_IDE_URL);
  if (start.protocol !== 'https:' || !start.pathname.includes('/ide/') || start.username || start.password) {
    throw new Error('INFOPLUS_IDE_URL 应是 HTTPS InfoPlus IDE 页面');
  }
  const { context, close } = await attachChrome();
  let page;
  let directory;
  try {
    page = await context.newPage();
    const network = observeResponses(page, start.origin);
    await page.goto(start.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.locator('.fancytree-title').first().waitFor({ timeout: 85000 });
    if (new URL(page.url()).origin !== start.origin) throw new Error('登录后未返回指定的 InfoPlus 站点');
    const projectTitle = await page.title();
    const term = query.toLowerCase();
    if (!projectTitle.toLowerCase().includes(term)) {
      const titles = await page.locator('.fancytree-title').allTextContents();
      const candidates = [...new Set(titles.map(title => title.trim())
        .filter(title => /\([\w-]+\)$/.test(title) && title.toLowerCase().includes(term)))];
      if (candidates.length !== 1) throw new Error(`项目匹配到 ${candidates.length} 项，请使用唯一项目编号或名称`);
      await page.getByText(candidates[0], { exact: true }).click({ timeout: 8000 });
      await page.locator('a[href$="/editor"]').first().waitFor({ timeout: 10000 });
    }
    const projectPage = new URL(page.url());
    const name = await page.title();
    const projectCode = projectPage.pathname.split('/').filter(Boolean).at(-1);
    const code = name.match(/^([A-Z]\d+)[:：]/i)?.[1] ?? projectCode;
    const versions = await page.locator('a[href$="/editor"]').evaluateAll(links => links
      .filter(link => /^V-/.test(link.textContent.trim()))
      .map(link => ({
        name: link.textContent.trim().slice(2),
        path: link.getAttribute('href'),
        status: [...link.closest('tr')?.cells ?? []].map(cell => cell.innerText.trim()).find(text => text === '可用'),
      })));
    const selected = process.env.INFOPLUS_VERSION
      ? versions.find(version => version.name === process.env.INFOPLUS_VERSION)
      : versions.length === 1 ? versions[0]
        : versions.filter(version => version.status === '可用').length === 1
          ? versions.find(version => version.status === '可用') : undefined;
    if (!selected) {
      throw new Error(`正式版本需核实。请设置 INFOPLUS_VERSION。可见版本：${versions.map(version => version.name).join('、')}`);
    }
    const editor = new URL(selected.path, projectPage);
    if (editor.origin !== start.origin) throw new Error('编辑器不在指定站点');
    const workflowDefinitionId = editor.pathname.match(/\/project\/([^/]+)\/editor$/)?.[1];
    if (!workflowDefinitionId) throw new Error('未识别编辑器中的流程定义 ID');
    directory = outputDirectory || join(outRoot, pathSegment(code));
    const cached = await readFile(join(directory,'project.json'),'utf8').then(JSON.parse,error=>{
      if(error.code!=='ENOENT')throw error;
    });
    if(cached && (cached.version!==selected.name || cached.workflowDefinitionId!==workflowDefinitionId)) {
      throw new Error('目标版本与现有正式缓存不一致，请先核对版本与证据迁移');
    }
    await mkdir(join(directory, 'raw'), { recursive: true });
    await page.goto(editor.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    try { await collectEditorCanvas(page, directory); }
    catch { console.warn('Workflow 编辑器未提供可读取的 SVG，业务版将尝试使用已核对的缓存原图。'); }
    const viewLabel = page.getByText('Views', { exact: true });
    // The IDE loads its views table when the first view in the tree is selected.
    const viewsGroup = page.locator('li:has(> span > .fancytree-title:text-is("Views"))').first();
    const viewItems = viewsGroup.locator(':scope > ul > li .fancytree-title');
    const expandViews = async () => {
      // Collapsed fancytree nodes keep their children in the DOM but hidden.
      if (await viewItems.first().isVisible({ timeout: 1000 }).catch(() => false)) return;
      const expander = viewsGroup.locator(':scope > span > .fancytree-expander');
      if (await expander.count() === 1) await expander.click({ timeout: 5000 });
      else if (await viewLabel.count() === 1) await viewLabel.click({ timeout: 5000 });
      // Expanding navigates the IDE to its views route and re-renders the tree.
      await page.waitForTimeout(2000);
    };
    // The XSN icon is a webfont glyph, so the anchor itself can be 0x0 and never "visible".
    const downloadRow = page.locator('tr:has(a[title="Download as XSN"])').first();
    for (let attempt = 0; ; attempt++) {
      await expandViews();
      try { await viewItems.first().click({ timeout: 10000 }); } catch { /* route change replaces the node */ }
      try {
        await downloadRow.waitFor({ timeout: attempt < 2 ? 20000 : 45000 });
        break;
      } catch (error) {
        if (attempt >= 2) throw error;
        await page.waitForTimeout(2000);
      }
    }
    const views = await page.locator('tr').filter({ has: page.locator('a[title="Download as XSN"]') })
      .evaluateAll(rows => rows.map(row => ({
        id: row.cells[0].title, name: row.cells[0].innerText.trim(),
        created: row.cells[2].innerText, updated: row.cells[3].innerText,
        xsn: row.querySelector('a[title="Download as XSN"]').getAttribute('href'),
        json: row.querySelector('a[title="Download as JSON"]')?.getAttribute('href'),
      })));
    const project = {
      code, name, projectCode, version: selected.name, versionEvidence: selected.status,
      workflowDefinitionId, source: projectPage.origin + projectPage.pathname,
      editor: editor.origin + editor.pathname, expectedViews: views.length, views,
    };
    await writeFile(join(directory, 'project.json'), JSON.stringify(project, null, 2));
    await network.drain();
    await importHarEntries(network.entries, directory, project);
    const failures = [];
    const fieldsTitle = page.locator('.fancytree-title').filter({ hasText: /^Fields & Controls$/ });
    if (await fieldsTitle.count() === 1) {
      try { await fieldsTitle.click({ timeout: 5000 }); }
      catch { failures.push('Fields & Controls 打开失败'); }
    }
    await withRenderer(async render => {
      for (const view of views) {
        if (!/^[a-f0-9-]{36}$/i.test(view.id)) {
          failures.push(`「${view.name}」视图标识格式未知`);
          continue;
        }
        const xsnPath = join(directory, 'raw', `${view.id}.xsn`);
        for (const kind of ['xsn', 'json']) {
          try {
            if (!view[kind]) continue;
            const url = new URL(view[kind], editor);
            if (url.origin !== start.origin || matchKind(url.pathname) !== (kind === 'json' ? 'form' : 'xsn')) continue;
            if (kind === 'xsn' && await access(xsnPath).then(() => true, () => false)) continue;
            const response = await context.request.get(url.href, { timeout: 10000, maxRedirects: 0 });
            try {
              if (!response.ok()) throw new Error(`HTTP ${response.status()}`);
              const bytes = await response.body();
              if (bytes.length > 32000000) throw new Error('资源超过大小限制');
              if (kind === 'xsn') {
                if (bytes.toString('ascii', 0, 4) !== 'MSCF') throw new Error('下载内容不是 CAB');
                await writeFile(xsnPath, bytes, { flag: 'wx' });
              } else {
                network.entries.push({
                  request: { method: 'GET', url: url.href },
                  response: { status: response.status(), content: { text: bytes.toString('base64'), encoding: 'base64' } },
                });
              }
            } finally { await response.dispose(); }
          } catch {
            failures.push(`「${view.name}」${kind.toUpperCase()} 读取失败`);
          }
        }
        try { await importXsn(xsnPath, join(directory, 'views', view.id), render); }
        catch {
          const index = await importHarEntries(network.entries, directory, project);
          const template = index.captured.find(item => item.templateId === view.id &&
            item.kind === 'form' && item.source.endsWith('/json'));
          try {
            if (!template) throw new Error('无 JSON 模板');
            await importTemplateJson(join(directory, 'raw', 'network', template.file), join(directory, 'views', view.id), render);
          } catch { failures.push(`「${view.name}」模板解析失败`); }
        }
      }
    });
    await network.drain();
    await importHarEntries(network.entries, directory, project);
    await writeFile(join(directory, 'scan-issues.json'), JSON.stringify(failures, null, 2));
    if(!staticOnly){
      try {console.log(JSON.stringify(await collectOnlineEvidence(context,directory,project,await probeDebug(context,project))));}
      catch {console.warn('动态采集未完成，静态文件已保存');}
    }
    return directory;
  } finally {
    try { await page?.close(); } finally { await close(); }
  }
}

