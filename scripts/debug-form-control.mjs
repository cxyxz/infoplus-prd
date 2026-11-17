import {attachChrome} from '../src/live-options.mjs';
import {readDebugStep,requireDebugAuthorization} from '../src/debug-session.mjs';
import {readFile} from 'node:fs/promises';
import {chooseDebugMember} from '../src/debug-runtime.mjs';
const [directory,instanceId,step,scope,operation,target,value]=process.argv.slice(2);
const project=JSON.parse(await readFile(directory+'/project.json','utf8'));
requireDebugAuthorization(project,scope);
const chrome=await attachChrome();
try {
 const page=chrome.context.pages().find(p=>p.url().includes('/'+step+'/render'));
 const state=await readDebugStep(page,project,instanceId);
 if(!state.executable||state.status!==1)throw Error('步骤不可办理');
 if(operation==='select'){
  await page.evaluate(id=>{const e=document.getElementById(id);if(!e||e.disabled)throw Error('控件不可选');window.jQuery(e).select2('open');},target);
  await page.waitForTimeout(1000);
  if(value && !await page.locator('.select2-results__option').filter({hasText:value}).count()) {
    const search=page.locator('.select2-container--open input.select2-search__field');
    if(await search.count()){await search.fill(value);await page.waitForTimeout(1500);}
  }
  if(value)await page.evaluate(text=>{const options=[...document.querySelectorAll('.select2-results__option')].filter(e=>e.getAttribute('aria-selected')!==null&&e.innerText.trim()===text);if(options.length!==1)throw Error('实际候选中没有唯一选项');window.jQuery(options[0]).trigger('mouseup');},value);
  else console.log(await page.locator('.select2-results__option').allTextContents());
 }else if(operation==='fill'){
  const values=JSON.parse(await readFile(target,'utf8'));
  for(const [id,text]of Object.entries(values)){
   await page.evaluate(({id,text})=>{const e=document.getElementById(id);if(!e||e.disabled||e.readOnly||!e.getClientRects().length)return;if(!['INPUT','TEXTAREA'].includes(e.tagName))throw Error('不是文本控件');e.value=text;window.jQuery(e).trigger('input').trigger('change');},{id,text});
   await page.waitForTimeout(400);await page.waitForFunction(()=>!window.jQuery?.active,undefined,{timeout:6000}).catch(()=>{});
  }
 }else if(operation==='member') console.log(await chooseDebugMember(page,directory,project,{scope,instanceId,fieldId:target}));
 else if(operation==='upload')await page.locator('input[type=file]').nth(Number(target)).setInputFiles(value);
 else throw Error('未知操作');
 await page.waitForTimeout(1000);
 console.log({operation,step,completed:true});
}finally{await chrome.close();}
