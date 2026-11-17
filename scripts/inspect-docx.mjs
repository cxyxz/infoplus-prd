import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

// Minimal ZIP reader for OOXML inspection; avoids depending on a global Python.
function centralDirectory(buffer) {
  const entries = new Map();
  for (let offset = 0; offset < buffer.length - 4; offset++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, localOffset });
    offset += 45 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readEntry(buffer, entry) {
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const data = buffer.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? inflateRawSync(data) : data;
}

function elements(xml, tag, limit) {
  const out = [];
  const open = new RegExp(`<w:${tag}(?:\\s[^>]*)?>`, 'g');
  const close = `</w:${tag}>`;
  let cursor = 0;
  while (cursor < xml.length) {
    const match = open.exec(xml);
    if (!match) break;
    const start = match.index;
    let depth = 1;
    let end = match.index + match[0].length;
    const tokenPattern = new RegExp(`<\\/?w:${tag}(?:\\s[^>]*)?>`, 'g');
    tokenPattern.lastIndex = end;
    while (depth > 0) {
      const token = tokenPattern.exec(xml);
      if (!token) break;
      const value = token[0];
      if (value.startsWith('</')) depth--;
      else if (!value.endsWith('/>')) depth++;
      end = tokenPattern.lastIndex;
    }
    out.push(xml.slice(start, end));
    open.lastIndex = end;
    cursor = end;
  }
  return out;
}

function cellText(cell) {
  return [...cell.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
    .map(match => match[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'))
    .join('');
}

const [inputPath, outputDir] = process.argv.slice(2);
if (!inputPath || !outputDir) throw new Error('用法: node scripts/inspect-docx.mjs <docx> <输出目录>');
const buffer = readFileSync(resolve(inputPath));
mkdirSync(resolve(outputDir), { recursive: true });
const entries = centralDirectory(buffer);
const documentEntry = entries.get('word/document.xml');
if (!documentEntry) throw new Error('DOCX 缺少 word/document.xml');
const xml = readEntry(buffer, documentEntry).toString('utf8');
const tables = elements(xml, 'tbl').map(table => elements(table, 'tr')
  .map(row => elements(row, 'tc').map(cellText))).filter(rows => rows.length);
const fieldTables = tables.filter(rows => rows[0].includes('字段名称') && rows[0].includes('字段类型'))
  .map(rows => ({ headers: rows[0], rows: rows.slice(1) }));
writeFileSync(join(resolve(outputDir), 'report.json'), JSON.stringify({
  tables: tables.map(rows => ({ headers: rows[0], rows: rows.slice(1) })), fieldTables,
}, null, 2));
