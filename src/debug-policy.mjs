import { readFileSync } from 'node:fs';

const defaults = Object.freeze({ preferred: true, autoRun: true, allowNormalWorkflowActions: true,
  allowExistingWorkflowCallbacks: true, fallbackToFrontend: true, maxRetries: 2, maxInstancesPerWorkflow: 3 });

// Central policy describes permission for ordinary, non-release Debug only. It never
// overrides actual platform permissions, workflow identity checks or destructive guards.
export function loadDebugPolicy(file = new URL('../config/debug-policy.json', import.meta.url)) {
  let supplied = {};
  try { supplied = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const policy = { ...defaults };
  for (const key of ['preferred', 'autoRun', 'allowNormalWorkflowActions', 'allowExistingWorkflowCallbacks', 'fallbackToFrontend']) {
    if (key in supplied) {
      if (typeof supplied[key] !== 'boolean') throw new Error(`Debug 策略 ${key} 必须是布尔值`);
      policy[key] = supplied[key];
    }
  }
  for (const [key, max] of [['maxRetries', 5], ['maxInstancesPerWorkflow', 10]]) {
    if (key in supplied) {
      if (!Number.isInteger(supplied[key]) || supplied[key] < 0 || supplied[key] > max) throw new Error(`Debug 策略 ${key} 超出允许范围`);
      policy[key] = supplied[key];
    }
  }
  return policy;
}

export function debugAvailability(entry, policy = loadDebugPolicy()) {
  if (!policy.preferred) return { selectedMode: 'front', reason: '配置未启用后台 Debug 优先' };
  if (entry?.state === 'identity-ready') return { selectedMode: 'debug', reason: '非发布 Debug 身份入口可达；实际办理以实例证据为准' };
  if (entry?.state === 'delegation-interstitial' && entry.ideDebugEntry === true)
    return { selectedMode: 'debug', reason: 'IDE Debug 入口可达，当前仅显示委托中转页，仍须核对实例和调试身份' };
  if (entry?.state === 'permission-denied' || entry?.state === 'login-required') {
    return { selectedMode: 'unavailable', reason: 'Debug 权限或登录状态不足，不能绕过平台访问控制' };
  }
  return { selectedMode: policy.fallbackToFrontend ? 'front' : 'unavailable', reason: '后台 Debug 技术上未就绪' };
}

export function assertOrdinaryDebugAction(label, policy = loadDebugPolicy()) {
  if (!policy.allowNormalWorkflowActions) throw new Error('Debug 策略未启用常规办理动作');
  const dangerous = /删除|部署|发布|配置|撤销|终止|注销|同步|转账|付款|支付|退款|扣款|销户|清空|delete|deploy|publish|terminate/i;
  const ordinary = /^(?:申请人)?(?:提交(?:并打印|国合处审核|审核|申请)?|重新提交|审核通过|审批通过|通过|同意|批准|退回(?:申请人|申请人修改|修改|出访单位|所在单位流转|国合处|国合处负责人|给国合处修改|给申请人修改)?|重新选择|选择|保存|确认|已确认|已完成|完成|报销已完成|刷新预约结果|刷新查看(?:批件|申请表)|请领导审核|转(?:交|送|至|给|国合处)|否决申请|打印|下载(?:申请表|批件)?)$/;
  const bilingual = /^(提交\/Submit|审核通过\/Approved|审批通过\/Approved|重新提交\/Submit again|重新选择\/Select again|退回(?:申请人|申请人修改|修改|给申请人修改)\/Return for Modification|退回出访单位\/Return to unit|请领导审核\/Review by OGE Leader)$/;
  if (typeof label !== 'string' || dangerous.test(label) || !(ordinary.test(label.trim()) || bilingual.test(label.trim()))) {
    throw new Error('该动作不属于已授权的常规 Debug 办理');
  }
}

export function assertCallbacksAllowed(policy, boundary) {
  if (policy.allowExistingWorkflowCallbacks) return;
  if (!Number.isInteger(boundary?.callbacks?.enabled) || boundary.callbacks.enabled !== 0) {
    throw new Error('Debug 策略禁止现有业务回调，或回调配置尚未核实');
  }
}
