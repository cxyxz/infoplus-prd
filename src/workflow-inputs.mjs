import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function validateInput(item) {
  return /^field\w+$/.test(item.fieldId ?? '') && typeof item.value === 'string' && !!item.value.trim() &&
    typeof item.fieldName === 'string' && !!item.fieldName && ['用户提供','历史实例','关联流程'].includes(item.source) &&
    ['待验证','已验证','失效'].includes(item.validationStatus) && Array.isArray(item.nodeIds) &&
    !!item.nodeIds.length && item.nodeIds.every(id => /^\d+$/.test(String(id))) &&
    (!item.requiredApplicant || (typeof item.requiredApplicant.account === 'string' &&
      !!item.requiredApplicant.account && /^field\w+$/.test(item.requiredApplicant.fieldId ?? '')));
}

// Business test inputs are data, not workflow rules. They are never included in
// generated requirements or runtime evidence; only a fingerprint is recorded.
export async function loadWorkflowInputs(project, directory = new URL('../config/workflow-inputs/', import.meta.url), includeInactive = false) {
  if (!/^Z[0-9]+$/i.test(project.code ?? '')) throw new Error('无效的流程编号');
  let config;
  const path = directory instanceof URL ? new URL(`${project.code.toUpperCase()}.json`, directory) : join(directory, `${project.code.toUpperCase()}.json`);
  try { config = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (config.code !== project.code || config.version !== project.version || config.definitionId !== project.workflowDefinitionId || !Array.isArray(config.inputs)) {
    throw new Error('测试输入与目标流程版本不匹配');
  }
  for (const item of config.inputs) {
    if (!validateInput(item)) throw new Error('业务测试输入配置无效');
  }
  if (new Set(config.inputs.map(i=>i.fieldId)).size !== config.inputs.length) throw new Error('测试输入字段重复');
  return includeInactive ? config.inputs : config.inputs.filter(i => i.validationStatus !== '失效');
}

export async function saveWorkflowInput(project, item, directory = new URL('../config/workflow-inputs/', import.meta.url)) {
  if (!validateInput(item)) throw new Error('业务测试输入配置无效');
  const items=await loadWorkflowInputs(project,directory,true);
  const next=items.filter(x=>x.fieldId!==item.fieldId);
  next.push(item);
  const folder=directory instanceof URL ? fileURLToPath(directory) : directory;
  const path=join(folder,`${project.code.toUpperCase()}.json`),temp=`${path}.${randomUUID()}.tmp`;
  await mkdir(folder,{recursive:true});
  await writeFile(temp,JSON.stringify({code:project.code,version:project.version,definitionId:project.workflowDefinitionId,inputs:next},null,2)+'\n',{flag:'wx'});
  await rename(temp,path);
}

export function inputFingerprint(inputs) {
  return createHash('sha256').update(JSON.stringify(inputs.map(({fieldId,value})=>[fieldId,value]).sort((a,b)=>a[0].localeCompare(b[0])))).digest('hex');
}

export async function applyWorkflowInputs(page, project, state, inputs) {
  if (state.release !== false || state.definitionId !== project.workflowDefinitionId || !state.executable || state.status !== 1) throw new Error('测试输入只可用于目标非发布可办理节点');
  const applicable=inputs.filter(item=>item.nodeIds.map(String).includes(String(state.nodeId)));
  if (!applicable.length) return { fields: [], fingerprint: undefined };
  const results=await page.evaluate(items => items.map(item => {
    const form = window.$$?.entity;
    if (item.requiredApplicant && (form?.data?._VAR_ACTION_ACCOUNT !== item.requiredApplicant.account ||
        form?.data?.[item.requiredApplicant.fieldId] !== item.requiredApplicant.account)) {
      return { fieldId:item.fieldId, applied:false, reason:'applicant-mismatch' };
    }
    const field=form?.fields?.[item.fieldId];
    const controls=[...document.querySelectorAll('input,textarea')].filter(e => e.name===item.fieldId && e.getClientRects().length &&
      getComputedStyle(e).visibility!=='hidden' && !e.disabled && !e.readOnly && ['text','search','textarea'].includes((e.type || e.tagName).toLowerCase()));
    if (!field?.bound || !field.permission?.includes('w') || !['string','text'].includes(String(field.type).toLowerCase()) || controls.length!==1 ||
        (field.label || field.description || field.name)!==item.fieldName) return {fieldId:item.fieldId, applied:false};
    const el=controls[0];
    if (String(el.value ?? '').trim() && el.value!==item.value) return {fieldId:item.fieldId,applied:false,reason:'existing-value-differs'};
    if (el.value!==item.value) { el.value=item.value; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }
    return {fieldId:item.fieldId,applied:el.value===item.value};
  }),applicable);
  if (results.some(r=>r.reason==='applicant-mismatch')) throw new Error('当前模拟办理身份或表单申请人与关联测试记录不匹配');
  if (results.some(r=>r.reason==='existing-value-differs')) throw new Error('已有非空业务输入与配置不同，需核对后手动更正');
  if (results.some(r=>!r.applied)) throw new Error('测试输入字段与当前可写控件不匹配');
  const used=applicable.filter(item=>results.some(result=>result.fieldId===item.fieldId && result.applied));
  return {fields:used.map(r=>r.fieldId),fingerprint:used.length ? inputFingerprint(used) : undefined};
}

// Only a confirmed business rejection followed by a different recorded input
// fingerprint can be retried; unknown delivery and successes remain blocked.
export function mayRetryAction(events, step, fingerprint) {
  const index=events.findLastIndex(e=>e.kind==='action' && String(e.before?.flowStepId)===String(step));
  if (index<0) return true;
  const action=events[index];
  if (!action.submitted || action.http!==200 || !Number.isInteger(action.errno) || action.errno===0 || action.success || !fingerprint) return false;
  const message=action.responses?.find(r=>r.endpoint==='/infoplus/interface/doAction')?.error ?? '';
  if (!/不存在|请(?:输入|填写|选择)|必填|格式不正确|校验(?:不通过|失败)/u.test(message) || /超时|timeout|网络|服务器异常|回调|连接|系统故障/i.test(message)) return false;
  const earlierAction=events.slice(0,index).findLastIndex(e=>e.kind==='action' && String(e.before?.flowStepId)===String(step));
  const prior=events.slice(earlierAction+1,index).findLast(e=>e.kind==='input-snapshot' && String(e.flowStepId)===String(step));
  return Boolean(prior?.fingerprint && prior.fingerprint!==fingerprint);
}
