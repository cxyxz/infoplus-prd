import {attachChrome} from '../src/live-options.mjs';
import {submitDebugAction,readDebugStep} from '../src/debug-session.mjs';
import {readFile,writeFile} from 'node:fs/promises';
const dir='E:/infoplus/output/Z0095/20260428-104555',iid='c68e706a-681a-4d9b-bd74-e9be121eeb5d';
const project=JSON.parse(await readFile(dir+'/project.json','utf8')),c=await attachChrome();
try {const p=c.context.pages().find(p=>p.url().includes('/15544135/render'));
p.on('response',async r=>{if(r.url().includes('/listNextStepsUsers')){const j=await r.json().catch(()=>({}));console.log(JSON.stringify({nextStepsHttp:r.status(),keys:Object.keys(j),errno:j.errno,error:j.error,entityKeys:j.entities?.map(e=>Object.keys(e))}));}});
const result=await submitDebugAction(p,project,{scope:'Z0095@20260428-104555',instanceId:iid,label:'提交'});
const inspection=await p.evaluate(()=>({dialogs:[...document.querySelectorAll('.dialog.display')].map(e=>e.innerText),errors:[...document.querySelectorAll('.formError')].map(e=>({class:e.className,text:e.innerText})),href:location.pathname}));
await writeFile(dir+'/raw/debug-runtime/apply-attempt-latest.json',JSON.stringify({result,inspection},null,2));console.log(JSON.stringify({result,inspection}));
}finally{await c.close();}

