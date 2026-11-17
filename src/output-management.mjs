import { mkdir, readFile, writeFile, rename, open, cp } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export function officialDirectory(code) {
  if (!/^[A-Za-z0-9_-]+$/.test(code)) throw new Error('流程编号不能用于目录');
  return resolve(process.env.INFOPLUS_PRD_HOME || fileURLToPath(new URL('..',import.meta.url)),'output',code);
}

export async function prepareOfficial(input) {
  const source=resolve(input);
  // 隔离分析时保留在输入目录，禁止按 project.code 回写其他流程的正式目录。
  if (process.env.INFOPLUS_ISOLATED_OUTPUT === 'true' || !source.split(sep).includes('_verification')) return source;
  const project=JSON.parse(await readFile(join(source,'project.json'),'utf8'));
  const target=officialDirectory(project.code);
  if(source===target) return target;
  await mkdir(target,{recursive:true});
  try {
    const current=JSON.parse(await readFile(join(target,'project.json'),'utf8'));
    if(current.version!==project.version || current.workflowDefinitionId!==project.workflowDefinitionId) throw new Error('正式目录版本不同，需先核对迁移证据');
    // Existing canonical evidence is authoritative; never silently replace it with an old verification copy.
    return target;
  } catch(error) {if(error.code!=='ENOENT') throw error;}
  for(const name of ['project.json','raw','views','debug-evidence','reviewed-rules.json','field-options-reviewed.json','workflow-original.json','workflow-original.png','workflow-original.svg','workflow-map.json']) {
    try {await cp(join(source,name),join(target,name),{recursive:true});} catch(error){if(error.code!=='ENOENT') throw error;}
  }
  return target;
}

export async function writeWordAtomic(path, buffer) {
  if(buffer.length<100 || buffer.readUInt32LE(0)!==0x04034b50 || !buffer.includes(Buffer.from('word/document.xml'))) throw new Error('Word 内容校验失败，原文件保持不变');
  const pending=path+'.pending';
  await writeFile(pending,buffer);
  for(let attempt=0;attempt<6;attempt++) {
    try {
      const handle=await open(path,'r+').catch(error=>{if(error.code!=='ENOENT') throw error;});
      await handle?.close();
      await rename(pending,path);
      return path;
    } catch(error) {
      if(!['EBUSY','EPERM','EACCES'].includes(error.code)) throw error;
      if(attempt===5) throw new Error(`正式 Word 被占用，未更新：${path}；已保留同目录临时文件 ${pending}，解除占用后重新运行 generate 将自动安全替换。`);
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
}
