import {attachChrome} from '../src/live-options.mjs';
import {readDebugStep,requireDebugAuthorization} from '../src/debug-session.mjs';
import {readFile} from 'node:fs/promises';
const [dir,instance,scope,sourceStep,targetStep]=process.argv.slice(2),project=JSON.parse(await readFile(dir+'/project.json','utf8'));
requireDebugAuthorization(project,scope);const c=await attachChrome();let source;
try{
 const target=c.context.pages().find(p=>p.url().includes('/'+targetStep+'/render'));
 source=await c.context.newPage();
 await source.goto(new URL(`/infoplus/form/${sourceStep}/render?snapshot=true`,project.source).href,{waitUntil:'domcontentloaded',timeout:15000});
 await source.waitForFunction(()=>window.$$?.entity?.step,undefined,{timeout:15000});
 await readDebugStep(source,project,instance);
 // Keep the account only in memory, never print or persist it.
 const identity=await source.evaluate(()=>{
   const entity=window.$$.entity;
   return {ownerKeys:Object.keys(entity.step).filter(k=>/owner|execut|initiat|creat/i.test(k)),
     entityKeys:Object.keys(entity).filter(k=>/owner|execut|initiat|creat|data/i.test(k)),
     ownerContainerKeys:Object.keys(entity.step.owner||{}).filter(k=>/account|id/i.test(k)),
     account:entity.step.ownerAccount||entity.step.entryOwnerAccount||entity.step.owner?.account||entity.data?._VAR_OWNER_ACCOUNT||null};
 });
 const account=identity.account;
 console.log({ownerKeys:identity.ownerKeys,entityKeys:identity.entityKeys,ownerContainerKeys:identity.ownerContainerKeys,ownerAccountFound:!!account});
 if(!account)throw Error('历史表单没有可核对的申请人账号');
 if(!/^[\w@.-]{1,100}$/.test(account))throw Error('历史申请人账号格式不明确');
 const listed=await target.evaluate(account=>{
   const radio=[...document.querySelectorAll('.dialog input[name=chooseEntrustee]')].find(r=>window.jQuery(r).data('account')===account);
   if(!radio)return false;
   radio.click();
   const button=[...radio.closest('.dialog').querySelectorAll('button')].find(b=>/^(继续|切换)$/.test(b.innerText.trim()));
   if(!button)return false;
   button.click();return true;
 },account);
 if(!listed){
 await target.evaluate(()=>{
  const dialog=[...document.querySelectorAll('.dialog')].find(d=>d.querySelectorAll('input[name=chooseEntrustee]').length===2);
  if(!dialog)throw Error('没有唯一的指定身份窗口');
  dialog.querySelectorAll('input[name=chooseEntrustee]')[0].click();
  dialog.querySelectorAll('input[name=chooseEntrustee]')[1].click();
 });
 const accountToggle=target.locator('.dialog a.toggleUser').filter({visible:true});
 if(await accountToggle.count()===1){
   const input=target.locator('.dialog input.entrust_specifiedUser');
   if(!await input.isVisible())await accountToggle.click({timeout:5000});
   await input.fill(account,{timeout:5000});
 }else{
 await target.locator('.entrustUserSelect [role=combobox]').click({timeout:5000});
 await target.locator('.select2-container--open input.select2-search__field').fill(account,{timeout:5000});
 const option=target.locator('.select2-results__option[aria-selected]').filter({visible:true});
 await option.first().waitFor({timeout:8000});
 const selected=await option.evaluateAll((options,account)=>{
   const exact=options.filter(e=>{
     const data=window.jQuery(e).data('data')||window.jQuery('select.select2-hidden-accessible').select2('data').find(d=>d.element===e);
     return String(data?.id??'')===account || e.innerText.split(/[\s()（）]+/).includes(account);
   });
   if(exact.length!==1)return false;
   window.jQuery(exact[0]).trigger('mouseup');return true;
 },account);
 if(!selected)throw Error('候选结果无法唯一核对为原申请人');
 }
 const ready=await target.evaluate(account=>{
   const selected=document.querySelector('.entrust_specifiedUser')?.value;
   const widget=document.querySelector('.entrustUserSelect')?.previousElementSibling;
   const selectedOption=widget?.selectedOptions?.[0];
   const button=[...document.querySelectorAll('.dialog button')].find(b=>/^(继续|切换)$/.test(b.innerText.trim())&&b.getClientRects().length);
   if(selected!==account && selectedOption?.value!==account)return {matched:false,hasValue:!!(selected||selectedOption?.value)};
   if(!button)return {matched:true,clicked:false};
   button.click();return {matched:true,clicked:true};
 },account);
 if(!ready.clicked)throw Error('平台控件未确认选中指定账号或切换按钮不可用');
 }
 await target.waitForFunction(()=>window.$$?.entity?.permission?.executable===true || [...document.querySelectorAll('.dialog button')]
   .some(b=>b.innerText.trim()==='继续'&&b.getClientRects().length),undefined,{timeout:15000});
 const continued=await target.evaluate(account=>{
   if(window.$$?.entity?.permission?.executable===true)return 'already-rendered';
   const candidates=[...document.querySelectorAll('input[name=chooseEntrustee]')];
   const owner=candidates.find(r=>window.jQuery(r).data('account')===account);
   if(!owner)return 'owner-not-listed';
   owner.click();
   const button=[...owner.closest('.dialog').querySelectorAll('button')].find(b=>b.innerText.trim()==='继续');
   if(!button)return 'no-continue';
   button.click();return 'continued';
 },account);
 console.log({postSwitch:continued});
 await target.waitForFunction(()=>window.$$?.entity?.permission?.executable===true,undefined,{timeout:15000});
 const state=await readDebugStep(target,project,instance);
 if(!state.executable)throw Error('已核对实例但当前身份没有办理权限');
 console.log({identitySource:'same-instance owner',node:state.nodeId,executable:state.executable});
}finally{await source?.close();await c.close();}
