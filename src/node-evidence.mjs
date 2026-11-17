import { optionEvidence } from './option-evidence.mjs';

export const nodeEvidenceVersion = 2;

export function buildNodeEvidence(workflow, stagePages, fields, optionRows, debugRuntime) {
  const names = new Map(workflow.nodes.map(node => [node.id, node.name]));
  const stages = new Map(stagePages.map(stage => [stage.viewId, stage]));
  const fieldIds = new Map();
  for (const field of fields) {
    if (!field.usages?.length) continue;
    if (!fieldIds.has(field.viewId)) fieldIds.set(field.viewId, new Set());
    fieldIds.get(field.viewId).add(field.id);
  }
  const runtime = new Map();
  for (const row of optionRows) {
    if (row.file !== optionEvidence || !row.versionVerified || !row.viewId) continue;
    if (!runtime.has(row.viewId)) runtime.set(row.viewId, { options: new Set(), dependencies: new Set(), sources: new Set() });
    const view = runtime.get(row.viewId);
    if (row.options?.length) view.options.add(row.fieldId);
    if (row.changes?.length) view.dependencies.add(row.fieldId);
    view.sources.add(row.source);
  }
  const edgeRef = (edge, other) => ({ id: edge.id, label: edge.name, nodeId: other, nodeName: names.get(other),
    evidence: edge.evidence, conditionConfigured: Boolean(edge.condition || edge.restrictScript), verified: false });
  return workflow.nodes.map(node => {
    const stage = stages.get(node.view);
    const observed = runtime.get(node.view);
    const operations = workflow.transitions.filter(edge => edge.source === node.id).map(edge => edgeRef(edge, edge.target));
    const observedAtView = Boolean(observed || stage?.screenshot);
    const debugStages = debugRuntime?.stages?.filter(s => String(s.state.nodeId) === String(node.id)) ?? [];
    const debugActions = debugRuntime?.actions?.filter(a => String(a.nodeId) === String(node.id)) ?? [];
    return {
      id: node.id, name: node.name, type: node.type, category: stage?.category, viewId: node.view || undefined,
      role: node.actor?.replace(/[\w.+-]+@[\w.-]+|\b\d{5,}\b/g, '（已脱敏）') || undefined,
      roleSource: node.actor ? node.evidence : undefined,
      incoming: workflow.transitions.filter(edge => edge.target === node.id).map(edge => edgeRef(edge, edge.source)),
      fields: [...fieldIds.get(node.view) ?? []],
      optionFields: [...observed?.options ?? []], linkedFields: [...observed?.dependencies ?? []],
      operations, returns: operations.filter(action => /退回|退给|返回|重新办理/.test(action.label)),
      screenshot: debugStages.at(-1)?.screenshot ?? stage?.screenshot ?? stage?.staticScreenshot,
      debugStages, observedActions: debugActions,
      evidence: [
        { source: 'IDE 流程配置', reference: node.evidence },
        ...debugStages.map(s => ({ source: '后台 Debug 实际观察', reference: 'raw/debug-runs.json', instanceId: s.instanceId, flowStepId: s.state.flowStepId })),
        ...(stage?.staticScreenshot ? [{ source: 'XSN 模板', reference: stage.staticScreenshot }] : []),
        ...(stage?.manifest ? [{ source: '前台 Chrome 实际观察', reference: stage.manifest, scope: '视图' }] : []),
        ...[...observed?.sources ?? []].map(reference => ({ source: '前台 Chrome 实际观察', reference, scope: '视图' })),
      ],
      verification: { page: debugStages.length ? 'debug-node' : observedAtView ? 'front-view' : stage?.staticScreenshot ? 'static-template' : 'configuration',
        role: debugStages.some(s => s.state.executable) ? 'debug-permission-verified' : 'configuration',
        transition: debugActions.length ? 'observed-actions-only' : 'not-verified' },
    };
  });
}
