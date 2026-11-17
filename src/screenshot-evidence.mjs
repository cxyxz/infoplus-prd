/**
 * InfoPlus PRD Skill V1.2 — 真实 Debug 截图取证（通用）
 *
 * 将截图从「附录装饰」提升为一等证据：按节点采集完整页面、可读分段、
 * 底部操作按钮、特殊字段/成员控件，并与实例、身份、字段、按钮、来源和
 * 验证状态一起写入索引。历史步骤只读快照不增加新的已验证动作。
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const screenshotSchemaVersion = 1;

export function pngInfo(file) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(24);
    if (fs.readSync(fd, header, 0, 24, 0) < 24) return null;
    if (header.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20), bytes: fs.statSync(file).size };
  } finally { fs.closeSync(fd); }
}

function hashFile(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function shot(page, file, options = {}) {
  const base = { path: file, animations: 'allow', caret: 'hide', timeout: 45000, fullPage: false, ...options };
  try { await page.screenshot(base); }
  catch (error) {
    await page.waitForTimeout(250);
    await page.screenshot({ ...base, animations: 'disabled', timeout: 60000 });
  }
}

function safePart(value, fallback = 'node') {
  const text = String(value ?? '').trim().replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '');
  return text || fallback;
}

export function nodeFolder(root, index, nodeId, nodeName) {
  return path.join(root, `${String(index).padStart(2, '0')}-${safePart(nodeName)}-${nodeId}`);
}

/** 关闭普通提示弹窗；业务错误弹窗保留给调用方单独取证。 */
export async function dismissNotice(page) {
  return page.evaluate(() => {
    const dialogs = [...document.querySelectorAll('.dialog, .modal, [role=dialog]')]
      .filter(d => d.getClientRects().length);
    let closed = 0;
    for (const d of dialogs) {
      const text = (d.innerText || '').replace(/\s+/g, ' ');
      if (!/提示|注意|information|notice/i.test(text)) continue;
      const button = [...d.querySelectorAll('button, a')].find(b => /^(确定|确认|好|OK|Close|关闭)$/i.test((b.innerText || '').trim()));
      if (button) { button.click(); closed++; }
    }
    return closed;
  }).catch(() => 0);
}

/** 滚动整页，触发懒加载；历史快照只读，不点击任何办理动作。 */
export async function revealPage(page, { passes = 3 } = {}) {
  const metrics = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: innerHeight }));
  for (let i = 0; i <= passes; i++) {
    await page.evaluate(y => window.scrollTo(0, y), Math.round((metrics.height - metrics.viewport) * i / passes));
    await page.waitForTimeout(180);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(120);
  return await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: innerHeight }));
}

function visibleSelector(selector) {
  return [...document.querySelectorAll(selector)].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
}

/** 采集底部命令栏；找不到命令栏时退化为底部视口截图，并如实记录退化原因。 */
export async function captureActionButtons(page, file, options = {}) {
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  await page.waitForTimeout(250);
  const region = await page.evaluate(() => {
    const actions = [...document.querySelectorAll('a[name^="infoplus_action_"], #command_holder a, .commandBar a, .commandBar button')]
      .filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
    const text = actions.map(e => (e.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!actions.length) {
      return { found: false, labels: [], reason: '页面未暴露可见操作按钮（可能身份不匹配或命令栏由平台动态绘制）' };
    }
    const boxes = actions.map(e => e.getBoundingClientRect());
    const left = Math.max(0, Math.min(...boxes.map(b => b.left)) - 24);
    const right = Math.min(innerWidth, Math.max(...boxes.map(b => b.right)) + 24);
    const top = Math.max(0, Math.min(...boxes.map(b => b.top)) - 30);
    const bottom = Math.min(innerHeight, Math.max(...boxes.map(b => b.bottom)) + 30);
    return { found: true, labels: text, clip: { x: Math.floor(left), y: Math.floor(top), width: Math.floor(right - left), height: Math.floor(bottom - top) } };
  });
  const vp = page.viewportSize() || { width: 1275, height: 900 };
  const fallbackClip = { x: 0, y: Math.max(0, vp.height - 240), width: vp.width, height: Math.min(240, vp.height) };
  const clip = region.found && region.clip.width > 40 && region.clip.height > 30 ? region.clip : fallbackClip;
  try {
    await page.screenshot({ path: file, clip, animations: 'disabled', caret: 'hide', timeout: 45000 });
  } catch (error) {
    // 长页面中滚动后截图偶发超时：回到顶部再取底部视口，仍失败则保留明确原因。
    try {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
      await page.waitForTimeout(300);
      await page.screenshot({ path: file, clip: fallbackClip, animations: 'allow', caret: 'hide', timeout: 45000 });
      region.fallbackSucceeded = true;
    } catch (retryError) {
      region.found = false;
      region.reason = `底部按钮截图失败：${String(retryError.message || '').slice(0, 120)}`;
    }
  }
  return region;
}

/** 采集可辨识的页面分段，避免把长页面压缩到 Word 中无法阅读。 */
export async function captureSegments(page, directory, prefix, options = {}) {
  const maxSegments = Number(options.maxSegments || 6);
  const info = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, viewport: innerHeight }));
  const maxScroll = Math.max(0, info.height - info.viewport);
  const files = [];
  if (info.height > info.viewport + 50) {
    const step = Math.max(400, info.viewport - 80);
    const positions = [];
    for (let y = 0; y < info.height && positions.length < maxSegments; y += step) {
      const pos = Math.min(y, maxScroll);
      if (positions.includes(pos)) continue;
      positions.push(pos);
      if (pos === maxScroll) break;
    }
    for (const [i, pos] of positions.entries()) {
      await page.evaluate(p => window.scrollTo(0, p), pos);
      await page.waitForTimeout(120);
      const file = path.join(directory, `${prefix}-segment-${String(i + 1).padStart(2, '0')}.png`);
      await shot(page, file);
      files.push({ file, scrollY: pos });
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return files;
}

/** 特殊字段/成员控件局部图。只截图真实存在的控件，不为凑数量制造条件。 */
export async function captureSpecialFields(page, directory, prefix, options = {}) {
  const candidates = await page.evaluate(limit => {
    const fields = Object.values(window.$$?.entity?.fields ?? {});
    return fields.filter(f => f.bound && (f.fieldChanging === true || f.type === 'User' || f.type === 'Organize' || f.notNull === true))
      .slice(0, limit)
      .map(f => ({ id: f.name, name: f.label || f.description || f.name, type: f.type,
        reason: [f.fieldChanging ? '条件/联动字段' : '', f.type === 'User' || f.type === 'Organize' ? '成员或组织控件' : '', f.notNull ? '必填字段' : ''].filter(Boolean).join('、'),
        settings: f.settings && { userFilters: f.settings.userFilters, userTraversal: f.settings.userTraversal } }));
  }, Number(options.limit || 6));
  const items = [];
  for (const field of candidates) {
    if (!/^\w+$/.test(field.id)) continue;
    const control = page.locator(`[name="${field.id}"], [name^="${field.id}_"], [name="radioList-${field.id}"]`).filter({ visible: true }).first();
    let target = null;
    if (await control.count()) {
      const row = control.locator('xpath=ancestor::tr[1]').filter({ visible: true }).first();
      target = await row.count() ? row : control;
    }
    // 历史快照常把字段渲染成只读文本；此时用字段标签定位真实表格行，仍属于真实页面证据。
    if (!target && field.name) {
      const textRow = page.locator('tr').filter({ hasText: field.name }).filter({ visible: true }).first();
      if (await textRow.count()) target = textRow;
    }
    if (!target) continue;
    const file = path.join(directory, `${prefix}-field-${field.id}.png`);
    const clip = await target.boundingBox().catch(() => null);
    if (!clip) continue;
    try {
      await shot(page, file, { clip });
      items.push({ ...field, file });
    } catch { /* 局部不可截时保留整页与按钮证据 */ }
  }
  return items;
}

const MASK_SELECTOR = 'input,textarea,select,.select2-selection__rendered,.infoplus_labelControlContainer,.infoplus_labelControl,[id*=entrust],[id*=history],[id*=History],[id*=user],[id*=User],.form_remark_title,.color_b2';

/** 单节点完整取证：原始证据 + 脱敏文档图 + 分段 + 按钮 + 特殊字段 + 元数据。 */
export async function captureNodeScreenshots(page, meta, options = {}) {
  const root = options.root;
  const folder = nodeFolder(root, meta.index, meta.nodeId, meta.nodeName);
  const originalDir = path.join(folder, 'original');
  fs.mkdirSync(originalDir, { recursive: true });
  const prefix = safePart(meta.nodeName);
  await dismissNotice(page);
  const metrics = await revealPage(page);

  const rawFull = path.join(originalDir, 'full-page-original.png');
  const maskedFull = path.join(folder, 'full-page.png');
  await shot(page, rawFull, { fullPage: true });
  await shot(page, maskedFull, { fullPage: true, mask: [page.locator(MASK_SELECTOR)], maskColor: '#dce3eb' });

  const segments = await captureSegments(page, folder, prefix, { maxSegments: options.maxSegments });
  const actionFile = path.join(folder, 'action-buttons.png');
  const actionRegion = await captureActionButtons(page, actionFile);
  const specials = await captureSpecialFields(page, folder, prefix, { limit: options.specialLimit || 6 });

  const images = [];
  const seenHashes = new Set();
  const add = (record) => {
    const info = pngInfo(record.file);
    if (!info) return;
    const digest = hashFile(record.file);
    if (seenHashes.has(digest)) {
      try { fs.unlinkSync(record.file); } catch {}
      return;
    }
    seenHashes.add(digest);
    images.push({ ...record, ...info, sha256: digest });
  };
  add({ category: 'full-page', sourceVariant: 'original', file: rawFull, purpose: '原始证据（按项目权限保存，不直接插入文档）' });
  add({ category: 'full-page', sourceVariant: 'masked', file: maskedFull, purpose: '文档展示：完整页面结构，字段值与身份信息已遮盖' });
  for (const [i, seg] of segments.entries()) add({ category: 'page-segment', sequence: i + 1, scrollY: seg.scrollY,
    file: seg.file, purpose: '文档展示：长页面分段，保证字段名称可读' });
  add({ category: 'action-buttons', sourceVariant: 'masked', file: actionFile,
    labels: actionRegion.labels || [], detection: actionRegion.found ? 'command-bar' : 'bottom-viewport-fallback',
    purpose: '文档展示：节点底部实际业务操作按钮' });
  for (const field of specials) add({ category: 'special-field', fieldId: field.id, fieldName: field.name,
    reason: field.reason, settings: field.settings, file: field.file,
    purpose: '文档展示：特殊字段、成员控件或必填项局部证据' });

  return {
    ...meta, folder, metrics, images,
    buttonsDetected: actionRegion.labels || [],
    buttonDetectionNote: actionRegion.reason || '已定位命令栏按钮',
    pageChecks: { nodeNamePresent: await page.evaluate(name => (document.body.innerText || '').includes(name), meta.nodeName).catch(() => false) },
  };
}

/**
 * 从同一实例的实时完整截图中裁剪底部按钮区。
 * 用于历史快照不暴露业务按钮时，避免用平台工具栏冒充业务操作按钮。
 */
export async function cropBottomRegion(browser, sourceFile, targetFile, options = {}) {
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(path.resolve(sourceFile)).href, { waitUntil: 'load', timeout: 20000 });
    const dataUrl = await page.evaluate(async ({ height, excludeBottom }) => {
      const img = document.querySelector('img');
      if (!img) throw new Error('源图不可读取');
      await img.decode();
      const cropHeight = Math.min(height, img.naturalHeight);
      const y = Math.max(0, img.naturalHeight - cropHeight - excludeBottom);
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = cropHeight;
      canvas.getContext('2d').drawImage(img, 0, y, img.naturalWidth, cropHeight, 0, 0, img.naturalWidth, cropHeight);
      return canvas.toDataURL('image/png');
    }, { height: Number(options.height || 420), excludeBottom: Number(options.excludeBottom || 0) });
    fs.mkdirSync(path.dirname(path.resolve(targetFile)), { recursive: true });
    fs.writeFileSync(targetFile, Buffer.from(String(dataUrl).split(',')[1] || '', 'base64'));
    return pngInfo(targetFile);
  } finally { await page.close().catch(() => {}); }
}

/** 质量门禁：存在、可打开、尺寸、重复、DOM 匹配；不声称完成 OCR。 */
export function qualityCheck(screenshots) {
  const seen = new Map();
  const issues = [];
  const rows = [];
  for (const shot of screenshots) {
    for (const image of shot.images) {
      const relative = path.relative(path.dirname(shot.folder), image.file).replace(/\\/g, '/');
      const minWidth = image.category === 'special-field' ? 220 : image.category === 'action-buttons' ? 300 : 600;
      const minHeight = image.category === 'special-field' ? 40 : image.category === 'action-buttons' ? 60 : 300;
      const checks = {
        exists: Boolean(image.width),
        readableSize: image.width >= minWidth && image.height >= minHeight,
        nonEmpty: image.bytes > (image.category === 'special-field' ? 2000 : 10000),
      };
      if (seen.has(image.sha256)) {
        checks.unique = false;
        issues.push({ node: shot.nodeName, file: relative, issue: '与已有截图内容完全相同', duplicateOf: seen.get(image.sha256) });
      } else {
        checks.unique = true;
        seen.set(image.sha256, `${shot.nodeName}/${relative}`);
      }
      if (shot.pageChecks?.nodeNamePresent === false && image.category === 'full-page') {
        checks.nodeMatched = false;
        issues.push({ node: shot.nodeName, file: relative, issue: '页面文本未匹配节点名称' });
      } else checks.nodeMatched = true;
      const ok = Object.values(checks).every(Boolean);
      rows.push({ nodeId: shot.nodeId, nodeName: shot.nodeName, category: image.category,
        file: path.relative(path.dirname(shot.folder), image.file).replace(/\\/g, '/'),
        width: image.width, height: image.height, bytes: image.bytes, checks, ok });
    }
  }
  return { ok: issues.length === 0, issues, rows };
}

export function writeScreenshotIndex(root, screenshots, quality, extra = {}) {
  fs.mkdirSync(root, { recursive: true });
  const index = {
    schemaVersion: screenshotSchemaVersion,
    generatedAt: new Date().toISOString(),
    ...extra,
    statistics: {
      nodes: screenshots.length,
      fullPage: screenshots.filter(s => s.images.some(i => i.category === 'full-page' && i.sourceVariant === 'masked')).length,
      actionButtons: screenshots.filter(s => s.images.some(i => i.category === 'action-buttons')).length,
      specialFields: screenshots.reduce((n, s) => n + s.images.filter(i => i.category === 'special-field').length, 0),
      images: screenshots.reduce((n, s) => n + s.images.length, 0),
    },
    nodes: screenshots.map(shot => ({...shot,
      folder: path.relative(path.dirname(root), shot.folder).replace(/\\/g, '/'),
      images: shot.images.map(image => {
        const relative = path.relative(path.dirname(root), image.file);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('截图不属于当前输出目录');
        return {...image, file:relative.replace(/\\/g, '/')};
      })
    })),
  };
  fs.writeFileSync(path.join(root, 'screenshot-index.json'), JSON.stringify(index, null, 2), 'utf-8');
  fs.writeFileSync(path.join(root, 'screenshot-quality.json'), JSON.stringify(quality, null, 2), 'utf-8');
  const lines = ['# 真实 Debug 截图索引', '',
    `实例：\`${extra.instanceId || '—'}\`；来源：${extra.source || '—'}`, '',
    `节点 ${index.statistics.nodes} 个；完整页面 ${index.statistics.fullPage} 个；底部按钮 ${index.statistics.actionButtons} 个；特殊字段 ${index.statistics.specialFields} 个；图片 ${index.statistics.images} 张。`, '',
    '| 节点 | 来源 | 完整页面 | 分段 | 底部按钮 | 特殊字段 | 实际按钮 | 主要文档用途 |',
    '|---|---|---|---:|---:|---:|---|---|'];
  for (const s of screenshots) {
    const count = category => s.images.filter(i => i.category === category).length;
    lines.push(`| ${s.nodeName} [${s.nodeId}] | ${s.pageType || '—'} | ${count('full-page') ? '有' : '无'} | ${count('page-segment')} | ${count('action-buttons') ? '有' : '无'} | ${count('special-field')} | ${(s.buttonsDetected || []).join(' / ') || '未暴露'} | ${path.relative(path.dirname(root), s.folder).replace(/\\/g, '/')} |`);
  }
  lines.push('', '完整页面原始图保存在各节点 `original/` 子目录；文档使用脱敏图。历史快照只证明页面结构，不增加新的已验证动作。');
  fs.writeFileSync(path.join(root, 'screenshot-index.md'), lines.join('\n') + '\n', 'utf-8');
  return index;
}
