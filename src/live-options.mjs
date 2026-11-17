import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright-core';
import { isChoiceField } from './field-options.mjs';
import { isSuggest, matchSuggest, readFieldIndex, readOptionEvidence, saveOptionEvidence } from './option-evidence.mjs';

const renderPath = /^\/infoplus\/form\/[\w-]+\/render\/?$/i;
const renderApi = '/infoplus/interface/render';
const instanceIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const progressPath = /^\/infoplus\/interface\/instance\/([a-f0-9-]+)\/progress$/i;
const safeId = /^[\w.-]{1,128}$/u;
const dropDownMenu = '[role="option"], .ui-autocomplete .ui-menu-item, .select2-results__option, .suggestion';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const dedicatedEndpoint = 'http://127.0.0.1:9222/';
const chromeLauncher = fileURLToPath(new URL('../start-infoplus-chrome.ps1', import.meta.url));
const runFile = promisify(execFile);

function localChromeEndpoint(value) {
  const url = URL.parse(value);
  const validPath = url?.protocol === 'http:' && url.pathname === '/' ||
    url?.protocol === 'ws:' && /^\/devtools\/browser\/[\w-]+$/.test(url.pathname);
  if (!validPath || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash) {
    throw new Error('Chrome 调试端点必须是本机 HTTP 地址或浏览器级 WebSocket 地址');
  }
  return url.href;
}

export async function chromeEndpoint() {
  if (process.env.INFOPLUS_CDP && localChromeEndpoint(process.env.INFOPLUS_CDP) !== dedicatedEndpoint) {
    throw new Error('本项目使用专用 Chrome 的固定端口 9222，请检查 INFOPLUS_CDP');
  }
  // V1.2：PowerShell -Check 在系统瞬时负载下可能超时误报，超时可配置并重试一次，
  // 仍以脚本退出码为准（退出码 2 仍表示专用 Chrome 未运行），不降低专用 Chrome 校验语义。
  const timeout = Number(process.env.INFOPLUS_CHROME_CHECK_TIMEOUT || 25000);
  const check = () => runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', chromeLauncher, '-Check'],
    { timeout, windowsHide: true });
  try {
    await check();
  } catch (error) {
    if (error.code === 2) return;
    try {
      await check();
    } catch (retryError) {
      if (retryError.code === 2) return;
      throw new Error('无法确认端口 9222 由专用 Chrome 使用，请运行 start-infoplus-chrome.ps1 检查', { cause: retryError });
    }
  }
  return dedicatedEndpoint;
}

export async function attachChrome(endpoint) {
  endpoint ??= await chromeEndpoint();
  if (!endpoint) throw new Error('专用 Chrome 尚未启动，请运行 start-infoplus-chrome.ps1');
  const browser = await chromium.connectOverCDP(localChromeEndpoint(endpoint), { timeout: 25000, noDefaults: true })
    .catch(error => { throw new Error('无法连接 Chrome 调试会话，请检查专用 Chrome 是否仍在运行', { cause: error }); });
  return { context: browser.contexts()[0], close: () => browser.close() };
}

async function optional(path) {
  try { return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, '')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function inventory(directory, project) {
  const network = await optional(join(directory, 'raw', 'network', 'index.json'));
  const index = await readFieldIndex(directory, network);
  const known = await optional(join(directory, 'normalized', 'bundle.json'));
  const fields = new Map();
  const add = (id, info) => {
    if (!safeId.test(id ?? '')) return;
    const field = fields.get(id) ?? { id, choice: false, sensitive: false, staticViews: [], uuids: [], aliases: [] };
    field.choice ||= info.choice;
    field.sensitive ||= info.sensitive;
    if (!field.name && info.name && info.name !== id) field.name = info.name;
    if (info.static && info.viewId) field.staticViews.push(info.viewId);
    if (info.uuid && safeId.test(info.uuid)) field.uuids.push(info.uuid);
    if (info.alias && safeId.test(info.alias)) field.aliases.push([info.viewId, info.alias]);
    fields.set(id, field);
  };
  for (const f of index.fields) add(f.id, {
    uuid: f.uuid, name: f.label, choice: isChoiceField({ ...f, apiType: f.type }), sensitive: ['User', 'Organize'].includes(f.type),
  });
  if (known?.project?.workflowDefinitionId === project.workflowDefinitionId) {
    for (const f of known.fields) add(f.id, {
      name: f.name, choice: isChoiceField(f), sensitive: ['User', 'Organize'].includes(f.apiType),
      viewId: f.viewId, static: f.optionSets?.some(set => set.kind === 'xsn' && set.completeness === 'complete'),
    });
  }
  for (const view of project.views ?? []) {
    if (!/^[\da-f-]{36}$/i.test(view.id)) continue;
    const xsn = await optional(join(directory, 'views', view.id, 'xsn.json'));
    for (const panel of xsn?.views ?? []) {
      for (const control of panel.controls ?? []) {
        const id = control.binding.split('/').at(-1).split(':').at(-1);
        add(id, { viewId: view.id, alias: control.id, choice: isChoiceField({ usages: [control] }) });
      }
    }
  }
  return [...fields.values()];
}

async function targets(context, project, supplied) {
  const origin = new URL(project.source).origin;
  const possible = value => {
    try {
      const url = new URL(value);
      return url.origin === origin && renderPath.test(url.pathname) && !url.username && !url.password;
    } catch { return false; }
  };
  if (supplied) {
    if (!possible(supplied)) throw new Error('申请页必须是同源的 InfoPlus render 页面');
    return [supplied];
  }
  const code = project.code.toLowerCase();
  const pages = await Promise.all(context.pages().filter(page => possible(page.url())).map(async page => {
    const title = await page.title().catch(() => '');
    return title.toLowerCase().split(/[^a-z0-9_]+/).includes(code) ? page.url() : undefined;
  }));
  const selected = pages.filter(Boolean);
  if (selected.length) return [...new Set(selected)];
  const ide = new Set([project.source, project.editor].filter(Boolean));
  const links = await Promise.all(context.pages().filter(page => ide.has(page.url())).map(page =>
    page.locator('a[href]').evaluateAll(anchors => anchors.map(anchor => anchor.href)).catch(() => [])));
  return [...new Set(links.flat().filter(possible))];
}

// The probe uses a separate tab. Only same-origin read routes are reachable from it.
export function permittedProbeRequest(url, method, resource, renderUrl, { formBody, instanceId } = {}) {
  if (url.origin !== renderUrl.origin) return false;
  if (isSuggest(url)) return ['GET', 'POST'].includes(method);
  if (method === 'POST' && ['xhr', 'fetch'].includes(resource) && formBody && formBody.length <= 32768 &&
      renderPath.test(renderUrl.pathname) && !url.search) {
    const step = renderUrl.pathname.split('/')[3];
    const params = new URLSearchParams(formBody);
    if (params.getAll('stepId').length !== 1 || params.get('stepId') !== step) return false;
    if (url.pathname === renderApi) {
      return params.getAll('admin').length === 1 && params.get('admin') === 'false' &&
        params.getAll('instanceId').length <= 1 && (!params.get('instanceId') || params.get('instanceId') === step);
    }
    return instanceIdPattern.test(instanceId ?? '') && progressPath.exec(url.pathname)?.[1].toLowerCase() === instanceId.toLowerCase() &&
      !params.has('admin') && !params.has('instanceId');
  }
  if (!['GET', 'HEAD'].includes(method)) return false;
  if (resource === 'document') return url.href === renderUrl.href;
  if (['stylesheet', 'image', 'font', 'script'].includes(resource) &&
      /\.(?:m?js|css|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|otf)$/i.test(url.pathname) &&
      !/\/(?:start|apply|submit|save|draft|delete|withdraw|doAction)(?:\/|\.|$)/i.test(url.pathname)) return true;
  return /\/(?:findFormTemplate|findWorkflowDefinition|getFormData|getFormFields|getFormControls|listCodes)\/?$/i.test(url.pathname);
}

function renderedForm(data, project) {
  const form = data?.entities?.[0];
  if (![0, '0'].includes(data?.errno) || !form?.step?.definitionId || form.step.definitionId !== project.workflowDefinitionId ||
      !(project.views ?? []).some(view => view.id === form.viewId) ||
      !instanceIdPattern.test(form.step.instanceId ?? '')) return;
  return { viewId: form.viewId, instanceId: form.step.instanceId, fields: form.fields };
}

function identityFromPage({ code, definitionId, views, stageViews }) {
  const metadata = [...document.querySelectorAll('[data-workflow-definition-id],[data-view-id],[data-form-view-id]')];
  const definitions = metadata.map(element => element.getAttribute('data-workflow-definition-id')).filter(Boolean);
  const title = document.title.toLowerCase();
  const titleMatch = title.split(/[^a-z0-9_]+/).includes(code);
  const stageName = document.title.split(/\s+-\s+/)[0]?.trim();
  const stageIds = [...new Set(stageViews.filter(node => node.name === stageName).map(node => node.view))];
  const ids = [...new Set(metadata.flatMap(element => [element.getAttribute('data-view-id'),
    element.getAttribute('data-form-view-id')]).filter(id => views.includes(id)))];
  return {
    valid: definitions.length ? definitions.every(id => id === definitionId) : titleMatch,
    versionVerified: definitions.includes(definitionId),
    viewId: ids.length === 1 ? ids[0] : stageIds.length === 1 ? stageIds[0] : undefined,
  };
}

function scanControls({ fields, viewId }) {
  const aliases = new Map();
  const collisions = new Set();
  const set = (name, id) => {
    if (aliases.has(name) && aliases.get(name) !== id) collisions.add(name);
    else aliases.set(name, id);
  };
  for (const field of fields) {
    set(field.id, field.id);
    for (const uuid of field.uuids) set(uuid, field.id);
    for (const [view, name] of field.aliases) if (viewId === view) set(name, field.id);
  }
  const result = [];
  for (const [index, element] of [...document.querySelectorAll('select,input,textarea,[role="combobox"]')].entries()) {
    const type = element.getAttribute('type')?.toLowerCase();
    if (['button', 'submit', 'reset', 'hidden', 'password', 'file', 'image'].includes(type)) continue;
    const wrapper = element.closest('[data-field-name],[data-field],[data-binding],[xd\\:binding]');
    const raw = [element.name, element.id, element.getAttribute('data-field-id'), wrapper?.getAttribute('data-field-name'),
      wrapper?.getAttribute('data-field'), wrapper?.getAttribute('data-binding'), wrapper?.getAttribute('xd:binding')];
    const keys = raw.filter(Boolean).flatMap(key => [key, key.split('/').at(-1).split(':').at(-1)]);
    const ids = [...new Set(keys.filter(key => aliases.has(key) && !collisions.has(key)).map(key => aliases.get(key)))];
    if (ids.length !== 1) continue;
    const id = ids[0];
    const select2 = element.tagName === 'SELECT' && element.nextElementSibling?.matches('.select2')
      ? element.nextElementSibling.querySelector('.select2-selection') : null;
    const target = select2 || element;
    const container = target.closest('.infoplus_control') || target;
    const visible = target.getClientRects().length > 0 && getComputedStyle(target).visibility !== 'hidden';
    const native = !select2 && (element.tagName === 'SELECT' || type === 'radio' || type === 'checkbox');
    const radioLabel = type === 'radio' && (element.labels?.[0]?.textContent ||
      element.getAttribute('aria-label') || (element.nextSibling?.nodeType === 3 && element.nextSibling.nodeValue));
    const radioValue = type === 'radio' && (element.getAttribute('value') ||
      element.getAttribute('data-value') || element.getAttribute('xd:onValue'));
    const options = native && element.tagName === 'SELECT'
      ? [...element.options].filter(option => !option.disabled && option.value && option.textContent.trim()).slice(0, 500)
        .map(option => ({ value: option.value, label: option.textContent.trim() }))
      : radioValue && radioLabel?.trim() ? [{ value: radioValue, label: radioLabel.trim() }] : [];
    const labelCell = element.closest('td')?.previousElementSibling;
    const labelText = element.labels?.[0]?.textContent || element.getAttribute('aria-label') ||
      (labelCell && !labelCell.querySelector('input,select,textarea,.infoplus_control') ? labelCell.textContent : '');
    const label = labelText?.replace(/[\s*：:]+$/u, '').trim();
    target.setAttribute('data-infoplus-prd-control', String(index));
    result.push({ id, index, visible, native, select2: !!select2, type, options, checked: element.checked,
      label: label && /^(?=.*\p{L})[\p{L}\p{N}（）()、/／· _-]{1,60}$/u.test(label) ? label : undefined,
      required: element.required === true || target.getAttribute('aria-required') === 'true' ||
      element.getAttribute('aria-required') === 'true',
    readOnly: element.readOnly === true || element.disabled === true || element.getAttribute('aria-readonly') === 'true' ||
      target.getAttribute('aria-disabled') === 'true' || container.classList.contains('infoplus_readonly') ||
      element.getAttribute('aria-disabled') === 'true' });
  }
  return result;
}

const controlAt = (page, index) => page.locator(`[data-infoplus-prd-control="${index}"]`);

function snapshots(rows) {
  const state = new Map();
  for (const row of rows) {
    const values = state.get(row.id) ?? { visible: false, required: false, readOnly: true };
    values.visible ||= row.visible;
    values.required ||= row.required;
    values.readOnly &&= row.readOnly;
    state.set(row.id, values);
  }
  return state;
}

function changedFields(before, after, fieldId) {
  const changes = [];
  const absent = { present: false, visible: false, required: false, readOnly: null };
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    if (id === fieldId) continue;
    const old = before.has(id) ? { present: true, ...before.get(id) } : absent;
    const next = after.has(id) ? { present: true, ...after.get(id) } : absent;
    if (JSON.stringify(old) !== JSON.stringify(next)) changes.push({ fieldId: id, before: old, after: next });
  }
  return changes;
}

async function menuLabels(page) {
  return page.locator(dropDownMenu).filter({ visible: true }).allTextContents()
    .then(items => items.map(item => item.trim()).filter(Boolean));
}

async function collectPage(context, url, project, fields, bundle, driverHints, deadline) {
  const page = await context.newPage();
  const observations = [];
  try {
    const session = await context.newCDPSession(page);
    await session.send('Network.setBypassServiceWorker', { bypass: true });
    await page.routeWebSocket('**/*', socket => socket.close());
    const destination = new URL(url);
    let form;
    let renderRequested = false;
    await page.route('**/*', async route => {
      const request = route.request();
      const requestUrl = new URL(request.url());
      const formRead = request.method() === 'POST' && (requestUrl.pathname === renderApi || progressPath.test(requestUrl.pathname));
      const formBody = formRead && request.frame() === page.mainFrame() &&
        /^application\/x-www-form-urlencoded(?:;|$)/i.test(request.headers()['content-type'] ?? '')
        ? request.postData() : undefined;
      const permitted = permittedProbeRequest(requestUrl, request.method(), request.resourceType(), destination,
        { formBody, instanceId: form?.instanceId });
      if (!permitted) return route.abort();
      if (!formRead) return route.continue();
      const initial = requestUrl.pathname === renderApi;
      if (initial) {
        renderRequested = true;
        form = undefined;
      }
      let response;
      try {
        response = await route.fetch({ maxRedirects: 0, timeout: 10000 });
        if (response.status() >= 300 && response.status() < 400) return await route.abort();
        if (initial && response.ok()) form = renderedForm(await response.json().catch(() => undefined), project);
        await route.fulfill({ response });
      } catch { await route.abort().catch(() => {}); }
      finally { await response?.dispose(); }
    });
    const ready = async () => {
      await page.locator('input[name]:not([type="hidden"]):visible,select:visible,textarea:visible,[role="combobox"]:visible').first()
        .waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      if (form) await page.locator('.overlay.active').first().waitFor({ state: 'hidden', timeout: 6000 });
    };
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 12000 });
    await ready();
    const identity = renderRequested ? { valid: !!form, viewId: form?.viewId, versionVerified: !!form } : await page.evaluate(identityFromPage, {
      code: project.code.toLowerCase(), definitionId: project.workflowDefinitionId,
      views: (project.views ?? []).map(view => view.id),
      stageViews: (bundle?.workflow?.nodes ?? []).filter(node => node.view).map(node => ({ name: node.name, view: node.view })),
    });
    if (!identity.valid) return { observations, reason: '申请页项目或版本无法核对' };
    const renderedFields = new Map(fields.map(field => [field.id, { ...field }]));
    for (const [id, metadata] of Object.entries(form?.fields ?? {})) {
      if (!safeId.test(id) || metadata?.name !== id) continue;
      const field = renderedFields.get(id) ?? { id, aliases: [], uuids: [], staticViews: [] };
      field.choice ||= isChoiceField({ apiType: metadata.type });
      field.sensitive ||= /^(?:User|Organi[sz]e|Department|Person)/i.test(metadata.type ?? '');
      renderedFields.set(id, field);
    }
    fields = [...renderedFields.values()];
    const describe = () => page.evaluate(scanControls, { fields, viewId: identity.viewId });
    const records = await describe();
    if (!records.some(row => row.visible)) return { observations, reason: '表单尚未显示可识别控件' };
    const state = snapshots(records);
    const relevant = new Map(fields.filter(field => !field.sensitive).map(field => [field.id, field]));
    const choiceIds = rows => [...new Set(rows.filter(row => row.visible && !row.readOnly &&
      relevant.has(row.id) && (row.native || row.select2 || relevant.get(row.id).choice)).map(row => row.id))];
    const choices = choiceIds(records);
    const known = fields.filter(field => !field.sensitive).flatMap(field =>
      [{ id: field.id }, ...field.uuids.map(uuid => ({ id: field.id, uuid }))]);
    const names = new Map(fields.filter(field => field.name).map(field => [field.id, field.name]));
    for (const row of records) if (row.label) names.set(row.id, row.label);
    const observe = (fieldId, item) => observations.push({
      fieldId, fieldName: names.get(fieldId), viewId: identity.viewId, versionVerified: identity.versionVerified, when: [], ...item,
    });
    for (const [id, properties] of state) observe(id, { kind: 'runtime-state', state: properties });

    const pending = [];
    page.on('response', response => {
      if (!isSuggest(new URL(response.url())) || !response.ok() || pending.length >= 60) return;
      const request = response.request();
      pending.push(response.text().then(text => ({
        request: { url: request.url(), method: request.method(), postData: {
          mimeType: request.headers()['content-type'], text: request.postData(),
        } },
        response: { status: response.status(), content: { text } },
      }), () => undefined));
    });
    async function probe(id, rows, when = []) {
      if (Date.now() >= deadline) return;
      const controls = rows.filter(row => row.id === id && row.visible && !row.readOnly);
      if (!controls.length) return;
      if (controls[0].label && !names.has(id)) names.set(id, controls[0].label);
      const options = controls.flatMap(control => control.options).filter(option => option.label).slice(0, 500);
      if (options.length) observe(id, {
        kind: 'runtime-dom', when, options, completeness: 'partial',
      });
      const first = controls.find(control => !control.native);
      if (!first || relevant.get(id).staticViews.includes(identity.viewId)) return [];
      const previous = new Set(await menuLabels(page));
      pending.length = 0;
      const locator = controlAt(page, first.index);
      if (!await locator.click({ timeout: 1100 }).then(() => true, () => false)) return [];
      await delay(450);
      const labels = (await menuLabels(page)).filter(label => !previous.has(label));
      const entries = await Promise.race([Promise.all(pending.splice(0)), delay(800).then(() => [])]);
      const interaction = { fieldId: id, viewId: identity.viewId, labels, when, versionVerified: identity.versionVerified };
      const matched = entries.filter(Boolean).map(entry => matchSuggest(entry, project, known, interaction)).filter(Boolean);
      for (const item of matched) observe(id, item);
      await page.keyboard.press('Escape').catch(() => {});
      return matched.flatMap(item => item.options).filter(option => labels.includes(option.label));
    }
    const custom = new Map();
    for (const id of choices) {
      const options = await probe(id, records);
      if (options?.length) custom.set(id, options);
    }

    let trials = 0;
    let reason;
    const drivers = [...choices].sort((a, b) => Number(driverHints.has(b)) - Number(driverHints.has(a)) ||
      Number(custom.has(b)) - Number(custom.has(a)));
    for (const id of drivers) {
      if (Date.now() >= deadline) break;
      const baseline = await describe();
      const before = snapshots(baseline);
      let previous = before;
      const rows = baseline.filter(row => row.id === id && row.visible && !row.readOnly);
      const native = rows.flatMap(row => row.options.map(option => ({ ...option, index: row.index, type: row.type })));
      if (rows.length === 1 && rows[0].type === 'checkbox') {
        native.push({ value: true, label: '勾选', index: rows[0].index, type: 'checkbox' },
          { value: false, label: '取消勾选', index: rows[0].index, type: 'checkbox' });
      }
      const first = rows.find(row => !row.native);
      const options = native.length ? native : first ?
        (custom.get(id) ?? []).map(option => ({ ...option, index: first.index, type: 'suggest' })) : [];
      if (options.length < 2 || options.length > 5) continue;
      const baseControl = controlAt(page, options[0].index);
      const original = options[0].type === 'checkbox' ? rows[0].checked :
        await baseControl.evaluate(element => element.type === 'radio'
          ? [...element.ownerDocument.querySelectorAll('input[type="radio"]')].find(item =>
            item.name === element.name && item.checked)?.getAttribute('value') : element.value,
        undefined, { timeout: 600 }).catch(() => null);
      for (const option of options) {
        if (Date.now() >= deadline) break;
        const current = await describe();
        const target = current.find(row => row.id === id && row.visible && !row.readOnly &&
          (option.type !== 'radio' || row.options.some(item => item.value === option.value)));
        if (!target) continue;
        const locator = controlAt(page, target.index);
        const when = [{ fieldId: id, value: option.value, label: option.label,
          state: option.type === 'checkbox' ? 'checked' : undefined }];
        try {
          if (option.type === 'radio') await locator.check({ timeout: 950 });
          else if (option.type === 'checkbox') await locator.setChecked(option.value, { timeout: 950 });
          else if (option.type === 'suggest') {
            if (await locator.getAttribute('aria-expanded') !== 'true') await locator.click({ timeout: 950 });
            const exact = new RegExp(`^\\s*${option.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
            await page.locator(dropDownMenu).filter({ visible: true, hasText: exact }).click({ timeout: 1100 });
          }
          else await locator.selectOption(option.value, { timeout: 950 });
          if (target.select2 && !await locator.evaluate((element, value) =>
            element.closest('.select2')?.previousElementSibling?.value === String(value), option.value, { timeout: 950 })) continue;
          trials++;
          await delay(350);
          const updated = await describe();
          const currentState = snapshots(updated);
          const changes = [...new Map([...changedFields(previous, currentState, id), ...changedFields(before, currentState, id)]
            .map(change => [change.fieldId, change])).values()];
          previous = currentState;
          if (changes.length) observe(id, { kind: 'runtime-change', when, changes });
          const affected = new Set(changes.map(change => change.fieldId));
          for (const next of choiceIds(updated)) {
            if (next !== id && (affected.has(next) || updated.some(row => row.id === next &&
                !baseline.some(old => old.id === next && JSON.stringify(old.options) === JSON.stringify(row.options))))) {
              await probe(next, updated, when);
            }
          }
        } catch { /* The field could not be switched in this view. */ }
      }
      if (Date.now() < deadline) {
        // Reload the isolated probe when a custom or initially blank radio cannot be restored reliably.
        const current = await describe();
        const restore = current.find(row => row.id === id && row.visible && !row.readOnly &&
          (options[0].type !== 'radio' || row.options.some(item => item.value === original)));
        if (!native.length || !restore) {
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 8000 });
            await ready();
          } catch {
            reason = '恢复表单时超时，保留已采集结果';
            break;
          }
          if (renderRequested && form?.viewId !== identity.viewId) {
            reason = '恢复后的表单视图无法核对，保留已采集结果';
            break;
          }
        } else if (options[0].type === 'radio') {
          await controlAt(page, restore.index).check({ timeout: 750 }).catch(() => {});
        } else if (options[0].type === 'checkbox') {
          await controlAt(page, restore.index).setChecked(original, { timeout: 750 }).catch(() => {});
        } else if (original != null) {
          await controlAt(page, restore.index).selectOption(original, { timeout: 750 }).catch(() => {});
        }
        await delay(150);
      }
    }
    return { observations, controls: choices.length, trials, reason, timeLimitReached: Date.now() >= deadline,
      viewId: identity.viewId, versionVerified: identity.versionVerified };
  } finally { await page.close(); }
}

export async function collectLiveOptions(context, directory, project, supplied) {
  const pages = await targets(context, project, supplied);
  if (!pages.length) return { pages: 0, added: 0, reason: '会话中没有可核对的同流程申请页' };
  const fields = await inventory(directory, project);
  const bundle = await optional(join(directory, 'normalized', 'bundle.json'));
  const driverHints = new Set((await readOptionEvidence(directory, project))
    .filter(item => item.changes?.length).map(item => item.fieldId));
  const deadline = Date.now() + 75000;
  const runs = [];
  for (const url of pages) {
    if (Date.now() >= deadline) break;
    try { runs.push(await collectPage(context, url, project, fields, bundle, driverHints, deadline)); }
    catch { runs.push({ reason: '无法打开或读取受限申请页', observations: [] }); }
  }
  const observations = runs.flatMap(run => run.observations);
  return { pages: runs.length, captured: observations.filter(item => item.options?.length).length,
    ...await saveOptionEvidence(directory, project, observations), runs: runs.map(({ observations, ...run }) => run) };
}
