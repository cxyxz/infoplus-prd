import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {officialDirectory,writeWordAtomic} from '../src/output-management.mjs';
test('正式路径按编号隔离，拒绝路径穿越',()=>{
 assert.match(officialDirectory('Z1778'),/output[\\/]Z1778$/);
 assert.throws(()=>officialDirectory('../other'));
});
test('无效 Word 不损坏旧文件',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'infoplus-output-'));const path=join(dir,'requirements.docx');
 try {await writeFile(path,'original');await assert.rejects(writeWordAtomic(path,Buffer.from('invalid')));assert.equal(await readFile(path,'utf8'),'original');}
 finally{await rm(dir,{recursive:true,force:true});}
});
