// Read existing history snapshots only. Does not create or advance a workflow.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { attachChrome } from '../src/live-options.mjs';
import { readDebugStep } from '../src/debug-session.mjs';
const directory=resolve(process.argv[2]), instanceId=process.argv[3];
const project=JSON.parse(await readFile(join(directory,'project.json'),'utf8'));
const chrome=await attachChrome();
let page;
try {
  const source=chrome.context.pages().find(p=>/\/form\/\d+\/render/.test(p.url()) && !p.url().includes('snapshot'));
  if(!source) throw new Error('没有可读取的实例页面');
  await readDebugStep(source,project,instanceId);
  const links=await source.evaluate(()=>[...document.querySelectorAll('a[href]')].flatMap(a=>{
    const u=new URL(a.href);return u.origin===location.origin&&/^\/infoplus\/form\/\d+\/render$/.test(u.pathname)&&u.search==='?snapshot=true' ? [u.href]:[];
  }));
  page=await chrome.context.newPage();
  await page.route('**/*',route=> /\/interface\/(doAction|start|save)(?:\?|$)/i.test(route.request().url()) ? route.abort() : route.continue());
  const evidence={version:project.version,definitionId:project.workflowDefinitionId,instanceId,source:'existing-debug-history',stages:[]};
  try {
    const previous=JSON.parse(await readFile(join(directory,'raw/debug-history-evidence.json'),'utf8'));
    if(previous.version===project.version && previous.definitionId===project.workflowDefinitionId && previous.instanceId===instanceId) evidence.stages=previous.stages;
  } catch(error) {if(error.code!=='ENOENT') throw error;}
  const started=Date.now();
  // Unit distribution and subsequent review pages are selected by their actual history links.
  for(const url of [...new Set(links)]) {
    if(Date.now()-started>80000) throw new Error('历史补图已到本次时间上限，已保存证据可继续复用');
    await page.goto(url,{waitUntil:'domcontentloaded',timeout:15000});
    await page.waitForFunction(()=>window.$$?.entity?.step,{timeout:10000});
    await page.waitForTimeout(1000);
    const state=await readDebugStep(page,project,instanceId);
    const fields=await page.evaluate(()=>Object.values(window.$$.entity.fields||{}).filter(f=>f.bound&&(f.type==='User'||f.fieldChanging)).map(f=>({id:f.name,type:f.type,settings:{userFilters:f.settings?.userFilters,userTraversal:f.settings?.userTraversal}})));
    const stage={state,mode:'historical-snapshot',note:'已完成步骤的历史只读页面；不证明新的条件切换或候选范围测试',fields,images:[]};
    const masks=page.locator('input,textarea,select,.select2-selection__rendered,.infoplus_labelControl,#command_holder,.commandBar_helper,[id*=entrust],[id*=history],[id*=History],[id*=user],[id*=User],.form_remark_title,.color_b2');
    const viewFolder=`views/${state.viewId}`;await mkdir(join(directory,viewFolder),{recursive:true});
    stage.screenshot=`${viewFolder}/history-${state.flowStepId}.png`;
    await page.screenshot({path:join(directory,stage.screenshot),fullPage:true,mask:[masks],maskColor:'#dce3eb',timeout:12000});
    for(const f of fields) {
      if(!/^\w+$/.test(f.id)) continue;
      const control=page.locator(`[name="${f.id}"],[name^="${f.id}_"],[name="radioList-${f.id}"]`).first();
      if(!await control.count()) continue;
      const row=control.locator('xpath=ancestor::tr[1]').filter({visible:true});
      if(!await row.count()) continue;
      const folder=`debug-evidence/${state.nodeId}`; await mkdir(join(directory,folder),{recursive:true});
      const file=`${folder}/history-${state.flowStepId}-${f.id}.png`;
      await row.screenshot({path:join(directory,file),mask:[masks],maskColor:'#dce3eb',timeout:4000});
      stage.images.push({fieldId:f.id,file,source:'historical-snapshot',capturedAt:new Date().toISOString()});
    }
    const existing=evidence.stages.findIndex(item=>item.state.flowStepId===stage.state.flowStepId);
    if(existing<0) evidence.stages.push(stage); else evidence.stages[existing]=stage;
    // Persist partial progress before the next page so timeouts cannot lose evidence.
    await writeFile(join(directory,'raw/debug-history-evidence.json'),JSON.stringify(evidence,null,2));
    console.log(JSON.stringify({node:state.nodeId,name:state.name,images:stage.images.length}));
  }
} finally {await page?.close();await chrome.close();}
