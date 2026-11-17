// Read-only existing tabs plus a disposable local fixture. No workflow requests are sent.
import {chromium} from 'playwright-core';
import {writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {scanFormState, repairPass, dismissDialogs} from '../src/form-autofill.mjs';
const browser=await chromium.connectOverCDP('http://127.0.0.1:9222',{timeout:15000});
let fixture;
try {
 const context=browser.contexts()[0];
 const observations=[];
 for(const page of context.pages()) {
  if(!page.url().includes('/infoplus/form/')) continue;
  const state=await page.evaluate(()=>{
   const e=window.$$?.entity;
   return e?{name:e.step?.name,step:e.step?.flowStepId,instanceId:e.step?.instanceId,
    status:e.step?.status,executable:e.permission?.executable,
    debugMarker:/正在调试模式|debug mode/i.test(document.querySelector('#FormCommandDebug')?.textContent||''),
    fields:Object.keys(e.fields||{}).length,actions:(e.actions||[]).length}:null;
  }).catch(()=>null);
  if(state) observations.push(state);
 }
 fixture=await context.newPage();
 await fixture.route('**/*',route=>route.abort());
 await fixture.setContent(`<table><tr><td>联系电话</td><td><input id="fieldPhone" name="fieldPhone" value="bad"></td></tr></table>
 <div class="fieldPhoneformError formError">请输入正确的联系方式</div>
 <div class="dialog display" id="validation">请输入正确的联系方式<button onclick="this.parentNode.remove()">确定</button></div>
 <div class="dialog display" id="unknown">未知操作<button onclick="window.unsafe=true">确定</button></div>
 <div class="dialog display" id="danger">删除记录前请填写原因<button onclick="window.unsafe=true">确定</button></div>`);
 const before=await scanFormState(fixture);assert.equal(before.errors[0].satisfied,false);
 const acknowledged=await dismissDialogs(fixture);assert.equal(acknowledged[0].validationPassed,false);
 const repaired=await repairPass(fixture,before,{valueOverrides:{fieldPhone:'13800000000'}});
 assert.equal(repaired.after.errors[0].satisfied,true);
 assert.equal(await fixture.evaluate(()=>Boolean(window.unsafe)),false);
 assert.equal(await fixture.locator('#unknown').count(),1);
 assert.equal(await fixture.locator('#danger').count(),1);
 const report={checkedAt:new Date().toISOString(),liveReadOnly:observations,
  fixture:{passed:true,checks:['invalid nonempty phone','acknowledgement is not success','repair and rescan','unknown and dangerous buttons untouched']},
  endToEnd:'not performed: no live submit, no new instance, existing registered comparison instance not advanced'};
 await writeFile('output/_verification/v12-stability/browser-check.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({readOnlyPages:observations.length,fixturePassed:true,endToEnd:false}));
} finally {await fixture?.close();await browser.close();}
