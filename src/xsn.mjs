import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const limit = 64 * 1024 * 1024;
const psScript = fileURLToPath(new URL('./xsn.ps1', import.meta.url));
const windows = process.env.SystemRoot ?? 'C:\\Windows';
const safeMember = name => name.length > 0 && name.length <= 180 &&
  !/[\\/:<>|?*"\x00-\x1f\uFFFD]|[. ]$|^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(name);

// Validate names and expanded sizes before invoking the Windows CAB extractor.
export function cabinetMembers(buffer) {
  if (buffer.length < 36 || buffer.toString('ascii', 0, 4) !== 'MSCF' ||
      buffer.readUInt32LE(8) !== buffer.length || buffer.readUInt16LE(30) & 3) {
    throw new Error('不支持的 CAB 或多卷 XSN');
  }
  const count = buffer.readUInt16LE(28);
  let position = buffer.readUInt32LE(16);
  let bytes = 0;
  const names = new Set();
  for (let i = 0; i < count; i++) {
    if (position < 36 || position + 16 >= buffer.length) throw new Error('XSN 文件表截断');
    bytes += buffer.readUInt32LE(position);
    const end = buffer.indexOf(0, position + 16);
    if (bytes > limit || end < 0 || end - position > 200) throw new Error('XSN 文件表超出限制');
    const name = buffer.toString('utf8', position + 16, end);
    if (!safeMember(name) || names.has(name.toLowerCase())) throw new Error('XSN 文件名不安全或重复');
    names.add(name.toLowerCase());
    position = end + 1;
  }
  if (!names.has('manifest.xsf')) throw new Error('缺少 manifest.xsf');
  return [...names];
}

export async function importXsn(file, output, render) {
  if (process.platform !== 'win32') throw new Error('XSN 解包需要 Windows expand.exe');
  if ((await stat(file)).size > limit) throw new Error('XSN 超出大小限制');
  const bytes = await readFile(file);
  const members = cabinetMembers(bytes);
  await mkdir(output, { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), 'infoplus-xsn-'));
  try {
    const source = join(temp, 'source.cab');
    const extracted = join(temp, 'extracted');
    await mkdir(extracted);
    await writeFile(source, bytes, { flag: 'wx' });
    await exec(join(windows, 'System32', 'expand.exe'), ['-F:*', source, extracted], { timeout: 30000 });
    return await parseTemplate(file, extracted, members, output, render);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export async function importTemplateJson(file, output, render) {
  if (process.platform !== 'win32') throw new Error('模板解析需要 Windows PowerShell');
  if ((await stat(file)).size > limit) throw new Error('模板超出大小限制');
  const data = JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('模板 JSON 必须是文件名到内容的对象');
  const members = Object.keys(data);
  const lower = members.map(name => name.toLowerCase());
  if (!lower.includes('manifest.xsf') || new Set(lower).size !== members.length ||
      !members.every(name => safeMember(name) && typeof data[name] === 'string')) {
    throw new Error('模板 JSON 缺少清单或包含不支持的文件');
  }
  const temp = await mkdtemp(join(tmpdir(), 'infoplus-template-'));
  try {
    for (const name of members) await writeFile(join(temp, name), data[name], { flag: 'wx' });
    return await parseTemplate(file, temp, lower, output, render);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function parseTemplate(file, extracted, members, output, render) {
  const { stdout } = await exec(join(windows, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Directory', extracted,
  ], { timeout: 45000, maxBuffer: limit });
  const result = JSON.parse(stdout);
  result.source = basename(file);
  result.members = members;
  const sources = join(output, 'source');
  await mkdir(sources, { recursive: true });
  for (const name of members) await copyFile(join(extracted, name), join(sources, name));
  for (const [index, view] of result.views.entries()) {
    const html = view.html;
    delete view.html;
    if (!html || !render) continue;
    try {
      view.screenshot = `view-${index + 1}.png`;
      await render(html, resolve(output, view.screenshot), sources, members);
    } catch {
      delete view.screenshot;
      view.issue = '静态预览截图失败';
    }
  }
  await writeFile(join(output, 'xsn.json'), JSON.stringify(result, null, 2));
  return result;
}
