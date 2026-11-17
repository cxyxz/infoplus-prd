import {attachChrome} from '../src/live-options.mjs';
import {readDebugStep} from '../src/debug-session.mjs';
import {readFile} from 'node:fs/promises';
const dir='E:/infoplus/output/Z0095/20260428-104555';
const project=JSON.parse(await readFile(dir+'/project.json','utf8'));
const c=await attachChrome();
try {const p=c.context.pages().find(p=>p.url().includes('/15544135/render')); await readDebugStep(p,project,'c68e706a-681a-4d9b-bd74-e9be121eeb5d');
const inputs=p.locator('input[type=file][name=qqfile]');console.log({count:await inputs.count()});
for(let i=0;i<2;i++){await inputs.nth(i).setInputFiles(dir+'/raw/debug-runtime/debug-test-placeholder.jpg',{timeout:10000});await new Promise(r=>setTimeout(r,1500));}
console.log(await p.evaluate(()=>[...document.querySelectorAll('.qq-upload-status-text,.qq-upload-success,.dialog.display')].map(e=>e.innerText).filter(t=>/成功|后缀|失败/.test(t)).map(t=>t.slice(0,200))));
}finally{await c.close();}
