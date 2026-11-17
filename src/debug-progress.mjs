export function bindProgress(progress, instanceId) {
  if (progress.instanceId && progress.instanceId !== instanceId) throw Error('恢复记录属于其他实例');
  // Legacy records must be reconciled with the currently observed task before any action.
  return {...progress, instanceId, needsReconciliation:!progress.instanceId && Boolean(progress.trace?.length),
    trace:progress.trace || [], visited:progress.visited || []};
}
export function reconcileProgress(progress, state) {
  if (state?.instanceId !== progress.instanceId) throw Error('当前页面不属于恢复实例');
  if (progress.needsReconciliation) {
    const last=progress.trace.at(-1);
    if (String(last?.flowStepId) !== String(state.flowStepId)) throw Error('旧检查点与当前待办不一致，需要先核对实例历史');
    progress.needsReconciliation=false;
  }
  return state.status === 2 ? 'completed-step-reconcile-tasks' : 'observe-current-step';
}
