import { access, readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { chromium } from 'playwright-core';

const imageTypes = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.bmp', 'image/bmp'], ['.webp', 'image/webp'],
]);
const host = 'https://infoplus-preview.invalid';

export async function withRenderer(run) {
  const candidates = [
    process.env.INFOPLUS_CHROME,
    join(process.env.ProgramFiles ?? 'C:/Program Files', 'Google/Chrome/Application/chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ].filter(Boolean);
  let executablePath;
  for (const candidate of candidates) {
    if (await access(candidate).then(() => true, () => false)) {
      executablePath = candidate;
      break;
    }
  }
  const browser = await chromium.launch({ executablePath, timeout: 15000 });
  try {
    const context = await browser.newContext({
      javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: 1440, height: 1000 },
    });
    await run(async (html, destination, directory, members = [], options = {}) => {
      const page = await context.newPage();
      try {
        await page.route('**/*', async route => {
          const url = new URL(route.request().url());
          if (url.origin !== host) return route.abort();
          if (url.pathname === '/preview') {
            return route.fulfill({
              contentType: 'text/html; charset=utf-8', body: html,
              headers: { 'Content-Security-Policy':
                "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; sandbox" },
            });
          }
          const name = decodeURIComponent(url.pathname.slice(1)).toLowerCase();
          const contentType = imageTypes.get(extname(name));
          if (!directory || !contentType || !members.includes(name)) return route.abort();
          return route.fulfill({ contentType, body: await readFile(join(directory, name)) });
        });
        await page.goto(host + '/preview', { waitUntil: 'load', timeout: 10000 });
        if (options.fitWorkflowSvg) return await fitWorkflowSvg(page, destination);
        const height = await page.locator('body').evaluate(el => el.scrollHeight);
        const width = await page.locator('body').evaluate(el => el.scrollWidth);
        if (height > 24000 || width > 10000 || height * width > 38000000) throw new Error('图片超过渲染上限');
        await page.screenshot({ path: destination, fullPage: true, timeout: 15000 });
      } finally {
        await page.close();
      }
    });
  } finally {
    await browser.close();
  }
}

async function fitWorkflowSvg(page, destination) {
  const fitted = await page.locator('body > svg').evaluate(svg => {
    document.body.style.margin = '0';
    svg.style.display = 'block';
    svg.style.overflow = 'visible';
    const root = svg.getBoundingClientRect();
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    const selector = 'path,image,rect,circle,ellipse,polygon,polyline,line,text,foreignObject div,foreignObject span';
    for (const el of svg.querySelectorAll(selector)) {
      if (el.closest('defs') || getComputedStyle(el).visibility === 'hidden') continue;
      if (el.closest('foreignObject') && (!el.textContent.trim() || el.children.length)) continue;
      const rect = el.getBoundingClientRect();
      if (!rect.width && !rect.height) continue;
      left = Math.min(left, rect.left - root.left);
      top = Math.min(top, rect.top - root.top);
      right = Math.max(right, rect.right - root.left);
      bottom = Math.max(bottom, rect.bottom - root.top);
    }
    const pad = 24;
    const x = Math.floor(left) - pad, y = Math.floor(top) - pad;
    const width = Math.ceil(right) - x + pad, height = Math.ceil(bottom) - y + pad;
    if (![x,y,width,height].every(Number.isFinite) || width < 1 || height < 1 ||
        Math.max(width,height) > 10000 || width * height > 36000000) throw new Error('无法确定 IDE 画布完整边界');
    const scale = Math.min(3, 10000 / Math.max(width, height), Math.sqrt(36000000 / (width * height)));
    const pixels = { width: Math.floor(width * scale), height: Math.floor(height * scale) };
    svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
    svg.setAttribute('width', String(pixels.width));
    svg.setAttribute('height', String(pixels.height));
    svg.removeAttribute('style');
    const xml = new XMLSerializer().serializeToString(svg);
    svg.style.display = 'block';
    return { svg: xml, bounds: { x, y, width, height }, pixels };
  });
  await page.setViewportSize(fitted.pixels);
  await page.screenshot({ path: destination, fullPage: false, timeout: 15000 });
  return fitted;
}
