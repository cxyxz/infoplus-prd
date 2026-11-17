import {mkdtemp,cp,mkdir,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import assert from 'node:assert/strict';
const home=await mkdtemp(join(tmpdir(),'infoplus-v12-smoke-'));
const source='output/Z1775workbuddy';
const components=['project.json','raw','normalized','reports','views','debug-evidence','analysis-report.json','stage-field-analysis.json','scan-issues.json','workflow-original.json','workflow-original.png','workflow-original.svg'];
const results=[];let defaultBytes;
for(const mode of ['default','comparison']) {
 const directory=join(home,'output',mode==='default'?'Z1775':'Z1775comparison');
 await mkdir(directory,{recursive:true});
 for(const file of components) await cp(join(source,file),join(directory,file),{recursive:true,
  filter: src => !/(?:^|[\\/])(?:v1\.2\.1|v1\.3)(?:[\\/]|$)|\.tmp$|[\\/]~\$/i.test(src)});
 const args=['src/cli.mjs','run','Z1775','--offline',...(mode==='comparison'?['--output-dir',directory]:[])];
 const proc=spawnSync(process.execPath,args,{encoding:'utf8',timeout:110000,maxBuffer:1024*1024*8,
  env:{...process.env,INFOPLUS_PRD_HOME:home,INFOPLUS_ISOLATED_OUTPUT:'',INFOPLUS_SCREENSHOT_DIR:''}});
 await writeFile(`output/_verification/v12-stability/${mode}-cli.log`,proc.stdout+'\n'+proc.stderr);
 assert.ok([0,2].includes(proc.status),proc.stderr);
 const report=JSON.parse(await readFile(join(directory,'reports/run-report.json'),'utf8'));
 assert.equal(report.version,(JSON.parse(await readFile('package.json','utf8'))).version);assert.ok(['updated','partial'].includes(report.documents));
 const official=(await readdir(directory)).find(f=>f.endsWith('需求文档.docx')); assert.ok(official); const word=await readFile(join(directory,official));assert.equal(word.readUInt32LE(0),0x04034b50);
 const words=(await readdir(directory)).filter(f=>f.endsWith('.docx'));assert.equal(words.length,1);
 const currentDefault=await readFile(join(home,'output/Z1775',official));
 if(mode==='default')defaultBytes=currentDefault;else assert.deepEqual(currentDefault,defaultBytes);
 results.push({wordCount:words.length,mode,directory,exitCode:proc.status,documents:report.documents,version:report.version});
 console.log(JSON.stringify(results.at(-1)));
}
await writeFile('output/_verification/v12-stability/output-smoke.json',JSON.stringify({home,results},null,2));
