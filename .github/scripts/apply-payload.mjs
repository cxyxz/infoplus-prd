import fs from 'node:fs';
import path from 'node:path';

const payloadFile = process.argv[2];
if (!payloadFile) throw new Error('Missing payload file');

const text = fs.readFileSync(payloadFile, 'utf8').replaceAll('~~~', '```');
const lines = text.split(/\r?\n/);
let current = null;
let count = 0;

for (const line of lines) {
  if (!current && line.startsWith('=== ')) {
    current = { name: line.slice(4).trim(), lines: [] };
    continue;
  }
  if (current && line === `=== END ${current.name}`) {
    const out = path.join(process.cwd(), current.name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, current.lines.join('\n'), 'utf8');
    count += 1;
    current = null;
    continue;
  }
  if (current) current.lines.push(line);
}

if (current) throw new Error(`Unclosed payload section: ${current.name}`);
console.log(`Restored ${count} files from ${payloadFile}`);
