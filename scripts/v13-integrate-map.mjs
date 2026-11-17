import fs from 'node:fs';
const p='scripts/v12-build-button-map.mjs';let t=fs.readFileSync(p,'utf8');
const start=t.indexOf('const args =');const end=t.indexOf('const workflowPath =');
t=t.slice(0,start)+`export function rebuildButtonMap(args) {\n`+t.slice(end);
t=t.replace("console.log(JSON.stringify({ ...summary, files }, null, 2));",`return { ...summary, files };\n}\nif (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {\n const args = Object.fromEntries(process.argv.slice(2).flatMap((arg,i,a)=>arg.startsWith('--')?[[arg.slice(2),a[i+1]]]:[]));\n console.log(JSON.stringify(rebuildButtonMap(args),null,2));\n}`);
t=t.replace("console.error('MISSING --workflow'); process.exit(2);","throw new Error('MISSING --workflow');");
fs.writeFileSync(p,t);
