import { resolveDebugLaunch, probeDebug } from './debug-probe.mjs';
import { requireDebugAuthorization, readDebugStep } from './debug-session.mjs';
import { appendDebugEvent, captureDebugStep, chooseDebugIdentity, readDebugRuns } from './debug-runtime.mjs';
import { loadDebugPolicy } from './debug-policy.mjs';
import { verifyDebugInstance } from './debug-verification.mjs';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function ordinaryWelcomeAcknowledgement(text) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  return value.length <= 80 && /^(?:我已|本人已|已)(?:认真|仔细)?阅读(?:并(?:知悉|了解))?(?:以上|上述)?(?:内容|说明|须知|告知|条款)?[。！!]?$/u.test(value);
}

export async function launchDebug(context,directory,project,scope,plan){
  requireDebugAuthorization(project,scope);
  if(!/^[\p{L}\p{N}_-]{1,60}$/u.test(plan??''))throw Error('请指定唯一调试路径名');
  const prior=await readDebugRuns(directory,project);
  if(prior?.runs.some(run=>run.events.some(event=>event.planName===plan)))throw Error('此调试路径已有实例，请使用 debug-session 恢复');
  const policy=loadDebugPolicy();
  if ((prior?.runs?.length ?? 0) >= policy.maxInstancesPerWorkflow) throw Error('已达到此流程 Debug 实例上限');
  const probe=await probeDebug(context,project);
  if (!probe.entry.ideDebugEntry || !['identity-ready', 'delegation-interstitial'].includes(probe.entry.state))
    throw Error('未确认非发布 IDE Debug 启动入口');
  if (!policy.allowExistingWorkflowCallbacks && probe.boundary?.callbacks?.enabled !== 0)
    throw Error('策略禁止现有流程回调，或回调配置未能确认');
  const intent=join(directory,'raw',`debug-launch-intent-${plan}.json`);
  await mkdir(join(directory,'raw'),{recursive:true});
  for (const name of await readdir(join(directory,'raw'))) {
    if (!/^debug-launch-intent-.+\.json$/u.test(name)) continue;
    let record;
    try { record=JSON.parse(await readFile(join(directory,'raw',name),'utf8')); }
    catch { throw Error('已有启动登记不可读取，须先核查'); }
    if (record.definitionId === project.workflowDefinitionId && record.status !== 'registered')
      throw Error('已有未完成启动登记；须核对是否创建实例，避免重复启动');
  }
  try { await writeFile(intent,JSON.stringify({code:project.code,version:project.version,definitionId:project.workflowDefinitionId,status:'pending',plan,at:new Date().toISOString()}),{flag:'wx'}); }
  catch(error) { if(error.code==='EEXIST') throw Error('已有启动登记；须核对是否创建实例，避免重复启动'); throw error; }
  const page=await context.newPage();
  const entry=await resolveDebugLaunch(page,project);
  await page.goto(entry.href,{waitUntil:'domcontentloaded',timeout:15000});
  await page.locator('input[name=chooseEntrustee]').first().waitFor({timeout:10000});
  if (page.url() !== entry.href) throw Error('Debug 入口发生未核实跳转');
  const identity = await chooseDebugIdentity(page,{preferCandidate:false,waitForStep:false,allowCurrentLoginInterstitial:true});
  if (!identity.switched) throw Error(identity.reason ?? '未确认 Debug 入口身份窗口');
  const begin=page.locator('#preview_start_button').filter({visible:true});
  await begin.waitFor({timeout:12000});
  const unchecked=page.locator('input[type=checkbox]:not(:checked)').filter({visible:true});
  const acknowledgements = await unchecked.evaluateAll(elements => elements.map(e => {
    const label = e.labels?.length === 1 ? e.labels[0] : e.closest('label');
    return label?.innerText?.trim() || '';
  }));
  if (acknowledgements.length && acknowledgements.every(ordinaryWelcomeAcknowledgement)) {
    for (let i=0; i<acknowledgements.length; i++) await unchecked.first().check();
  }
  if(await unchecked.count()||!await begin.isEnabled()||await begin.getAttribute('aria-disabled')==='true'){
    await writeFile(intent,JSON.stringify({code:project.code,version:project.version,definitionId:project.workflowDefinitionId,status:'welcome-review',plan,at:new Date().toISOString()}));
    return {status:'welcome-review',reason:'请阅读欢迎说明并完成适用的确认，随后使用现有实例命令采集'};
  }
  await begin.click({timeout:5000});
  await page.waitForURL(url=>url.origin===entry.origin&&/^\/infoplus\/form\/\d+\/render$/.test(url.pathname),{timeout:12000});
  await page.waitForFunction(()=>Boolean(window.$$?.entity?.step||document.querySelector('input[name=chooseEntrustee]')),undefined,{timeout:12000});
  if(await page.locator('input[name=chooseEntrustee]').count())await chooseDebugIdentity(page,{preferCandidate:false,allowCurrentLoginInterstitial:true});
  await page.waitForFunction(()=>Boolean(window.$$?.entity?.step),undefined,{timeout:12000});
  const instanceId=await page.evaluate(()=>window.$$.entity.step.instanceId);
  const state=await readDebugStep(page,project,instanceId);
  const modeEvidence = await verifyDebugInstance(page, project, state, { writable: state.executable });
  await appendDebugEvent(directory,project,instanceId,{kind:'path-plan',planName:plan,state,modeEvidence,source:'授权 Debug 启动'});
  await captureDebugStep(page,directory,project,instanceId);
  await writeFile(intent,JSON.stringify({code:project.code,version:project.version,definitionId:project.workflowDefinitionId,status:'registered',instanceId,plan,at:new Date().toISOString()}));
  return {status:state.executable?'ready':'permission-denied',instanceId,state};
}
