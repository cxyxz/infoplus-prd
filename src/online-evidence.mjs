import { probeDebug, saveDebugProbe } from './debug-probe.mjs';
import { captureStagePages } from './capture-stage.mjs';
import { collectLiveOptions } from './live-options.mjs';
import { readDebugRuns, captureDebugStep, runtimeSummary, actDebugStep, resumeDebugTask, debugTaskLinks, appendDebugEvent } from './debug-runtime.mjs';
import { readDebugStep, redactDebugText } from './debug-session.mjs';
import { verifyDebugInstance } from './debug-verification.mjs';
import { launchDebug } from './debug-launch.mjs';
import { loadDebugPolicy, debugAvailability, assertOrdinaryDebugAction } from './debug-policy.mjs';
import { loadWorkflowInputs, applyWorkflowInputs, mayRetryAction } from './workflow-inputs.mjs';
import { recoverLinkedInput } from './linked-dashboard.mjs';

// Only unambiguous standard progression; alternate paths require a separately planned instance.
export function selectAutomaticAction(actions) {
  const standard = /^(?:提交(?:\/Submit)?|审核通过(?:\/Approved)?|审批通过(?:\/Approved)?|重新提交(?:\/Submit again)?)$/iu;
  const matches = actions.filter(a => standard.test(a.label) && !a.remarkRequired);
  if (matches.length !== 1) return undefined;
  try { assertOrdinaryDebugAction(matches[0].label); return matches[0]; } catch { return undefined; }
}

export function transientDebugProbe(result) {
  const state=result?.entry?.state;
  if (state==='unavailable') {
    const http=result.entry.http;
    return http == null || http >= 500 && http <= 599;
  }
  // not-checked can also mean invalid project or version; retry only the explicit timeout/transport result.
  return state==='not-checked' && result.reason==='专用 Chrome 未能在时限内核对目标版本或 Debug 页面';
}

export async function retryDebugProbe(operation, retries) {
  let result;
  for (let attempt=0; attempt<=retries; attempt++) {
    try {
      result=await operation();
      if (!transientDebugProbe(result) || attempt===retries) return result;
    } catch(error) { if (attempt===retries) throw error; }
  }
  return result;
}

async function missingRequired(page) {
  return page.evaluate(() => Object.values(window.$$?.entity?.fields ?? {}).filter(f => {
    if (!f.bound || f.notNull !== true || !f.permission?.includes('w')) return false;
    const controls = [...document.querySelectorAll('[name]')].filter(e =>
      (e.name === f.name || e.name === 'radioList-' + f.name || e.name?.startsWith(f.name + '_')) &&
      e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
    if (!controls.length) return false;
    return !controls.some(e => (e.type === 'checkbox' || e.type === 'radio') ? e.checked : String(e.value ?? '').trim());
  }).map(f => f.name));
}

async function matchingPages(context, project, instanceId) {
  const result=[];
  for (const page of context.pages()) {
    try { result.push({page,state:await readDebugStep(page,project,instanceId)}); } catch {}
  }
  return result;
}

export async function collectOnlineEvidence(context, directory, project, debug = undefined) {
  const policy=await loadDebugPolicy();
  debug ??= await retryDebugProbe(()=>probeDebug(context, project),policy.maxRetries);
  const availability=debugAvailability(debug.entry, policy);
  const scope=`${project.code}@${project.version}`;
  const configuredInputs=await loadWorkflowInputs(project);
  let prior=await readDebugRuns(directory, project);
  const runs=prior?.runs?.filter(run=>run.origin==='automatic-debug') ?? [];
  const auto={ attempted:false, resumed:0, launched:0, steps:0, blocks:[] };
  const callbackBlocked=policy.allowExistingWorkflowCallbacks===false && debug.boundary?.callbacks?.enabled !== 0;
  if (policy.preferred && policy.autoRun && availability.selectedMode==='debug' && !callbackBlocked) {
    auto.attempted=true;
    const linked = await recoverLinkedInput(context, project, configuredInputs);
    if (linked?.item) configuredInputs.push(linked.item);
    else if (linked) {
      auto.blocks.push({kind:'business-validation',reason:`缺少可靠的前置业务编号（${linked.status}）`});
      await saveDebugProbe(directory,project,{...debug,front:{attempted:false},auto});
      return {debug,front:{attempted:false},auto};
    }
    if (!runs.length && configuredInputs.some(item => item.requiredApplicant)) {
      auto.blocks.push({kind:'business-wait',reason:'请先用 IDE Debug 选择关联原申请的身份并登记该实例'});
    } else if (!runs.length && policy.maxInstancesPerWorkflow>0) {
      try {
        const result=await launchDebug(context,directory,project,scope,'normal');
        if (result.instanceId) { auto.launched++; prior=await readDebugRuns(directory,project); }
        else auto.blocks.push({kind:'business-wait', reason:result.reason || result.status});
      } catch(error) { auto.blocks.push({kind:'technical-failure',reason:redactDebugText(error.message)}); }
    }
    for (const run of (prior?.runs ?? []).filter(r=>r.origin==='automatic-debug')) {
      try {
        let pages=await matchingPages(context,project,run.instanceId);
        if (pages.length!==1) { auto.blocks.push({kind:'unverified',reason:'缺少唯一已登记实例页面'}); continue; }
        const page=pages[0].page; auto.resumed++;
        for(let i=0;i<12;i++) {
          let state=await readDebugStep(page,project,run.instanceId);
          const modeEvidence=await verifyDebugInstance(page,project,state);
          await appendDebugEvent(directory,project,run.instanceId,{kind:'debug-mode-verification',state,modeEvidence});
          if(state.status!==1 || !state.executable) {
            const tasks=await debugTaskLinks(page,project,run.instanceId);
            if(tasks.length!==1) { auto.blocks.push({kind:'business-wait',reason:`待办数量为 ${tasks.length}，未自动选择`}); break; }
            const result=await resumeDebugTask(page,directory,project,{instanceId:run.instanceId,scope,step:tasks[0].step});
            state=result.state;
          }
          await captureDebugStep(page,directory,project,run.instanceId);
          const action=selectAutomaticAction(state.actions ?? []);
          if(!policy.allowNormalWorkflowActions || !action) { auto.blocks.push({kind:'unverified',reason:'无唯一普通自动推进动作'}); break; }
          const applied=await applyWorkflowInputs(page,project,state,configuredInputs);
          const missing=await missingRequired(page);
          if(missing.length) { auto.blocks.push({kind:'business-validation',reason:`必填字段待填写：${missing.join('、')}`}); break; }
          const latest=await readDebugRuns(directory,project);
          const events=latest?.runs.find(r=>r.instanceId===run.instanceId)?.events ?? [];
          if(!mayRetryAction(events,state.flowStepId,applied.fingerprint)) {
            auto.blocks.push({kind:'business-wait',reason:'此步骤已有动作记录，避免重复提交'}); break;
          }
          if (applied.fingerprint) await appendDebugEvent(directory,project,run.instanceId,{kind:'input-snapshot',flowStepId:state.flowStepId,fields:applied.fields,fingerprint:applied.fingerprint});
          const result=await actDebugStep(page,directory,project,{instanceId:run.instanceId,scope,label:action.label});
          if(!result.submitted || result.http!==200 || result.errno!==0) { auto.blocks.push({kind:'business-validation',reason:'动作未获业务成功确认'}); break; }
          auto.steps++;
        }
      } catch(error) { auto.blocks.push({kind:'technical-failure',reason:redactDebugText(error.message)}); }
    }
  } else if(callbackBlocked) auto.blocks.push({kind:'policy',reason:'配置禁止调用现有流程回调'});
  const summary=runtimeSummary(await readDebugRuns(directory,project));
  if(summary.instances) debug={...debug,selectedMode:'debug',visitedNodes:summary.observedNodes,simulatedRoles:summary.roles,verifiedPaths:summary.verifiedPaths};
  let front={attempted:false,reason:'后台 Debug 技术可用，优先保留 Debug 证据'};
  if(policy.fallbackToFrontend && (availability.selectedMode==='front' || callbackBlocked ||
      (auto.launched===0 && !runs.length && auto.blocks.some(b=>b.kind==='technical-failure')))) {
    let stages,options;
    try { stages=await captureStagePages(context,directory,project); } catch { stages={captured:0,reason:'前台欢迎页补采未完成'}; }
    try { options=await collectLiveOptions(context,directory,project,process.env.INFOPLUS_FORM_URL); } catch { options={pages:0,captured:0,reason:'前台选项补采未完成'}; }
    front={attempted:true,stages,options};
  }
  await saveDebugProbe(directory,project,{...debug,front,auto});
  return {debug,front,auto};
}
