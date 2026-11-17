/**
 * 在指定目录内直接生成两份 Word 并复制到正式交付目录。
 * 不经过 CLI 的 prepareOfficial，避免按 project.code 意外写回其他流程目录。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { generate } from '../src/generate.mjs';
import { generateCustom, customDocxName } from '../src/generate-custom.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, cur, i, arr) => {
  if (cur.startsWith('--')) acc.push([cur.slice(2), arr[i + 1]]);
  return acc;
}, []));
for (const k of ['dir', 'official']) if (!args[k]) { console.error('MISSING --dir or --official'); process.exit(2); }
const dir = path.resolve(args.dir), official = path.resolve(args.official);
if (dir !== official) throw Error('请使用 CLI --output-dir 在指定目录生成，不跨目录复制 Word');
const bundle = JSON.parse(await fs.readFile(path.join(dir, 'normalized', 'bundle.json'), 'utf-8'));
const report = JSON.parse(await fs.readFile(path.join(dir, 'analysis-report.json'), 'utf-8'));
const stat = await fs.stat(path.join(dir, 'normalized', 'bundle.json'));

const detail = await generate(bundle, report, dir, stat.mtimeMs);
const custom = await generateCustom(bundle, dir);
const detailName = typeof detail === 'string' ? path.basename(detail) : 'requirements.docx';
const customName = path.basename(custom.docxPath || customDocxName(bundle.project));
await fs.mkdir(official, { recursive: true });
console.log(JSON.stringify({ detail: path.join(official, 'requirements.docx'), business: path.join(official, customName) }, null, 2));
