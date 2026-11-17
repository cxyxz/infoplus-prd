// Finite branch obligations, not exponential enumeration of all field combinations.
export function analyzePathCoverage(bundle) {
  const nodes=new Map(bundle.workflow.nodes.map(n=>[String(n.id),n]));
  const edges=bundle.workflow.transitions;
  const outgoing=id=>edges.filter(e=>String(e.source)===String(id));
  const ends=[...nodes.values()].filter(n=>!outgoing(n.id).length && n.type==='自动步骤').map(n=>String(n.id));
  function frontier(start) {
    const queue=[String(start)],seen=new Set(),result=[];
    while(queue.length && seen.size<=nodes.size) {
      const id=queue.shift();if(seen.has(id))continue;seen.add(id);
      const node=nodes.get(id);if(!node)continue;
      if(node.type==='办理'||ends.includes(id)){result.push({id,name:node.name,type:node.type});continue;}
      queue.push(...outgoing(id).map(e=>String(e.target)));
    }
    return result;
  }
  const runs=(bundle.debugRuns?.runs??[]).filter(r=>r.origin==='automatic-debug');
  const obligations=edges.filter(e=>e.source!==e.target && e.attributes?.hideOnForm!=='true').map(e=>{
    const source=nodes.get(String(e.source)),target=nodes.get(String(e.target));
    const evidence=[];
    const failures=[];
    for(const run of runs) for(const event of run.events) {
      if(String(event.action?.id??event.actionId)!==String(e.id))continue;
      const failure=event.kind==='technical-diagnostic'||event.kind==='identity-block'?event:
        event.responses?.find(r=>r.errno===22007&&/EVENT_MESSENGER_TIMEOUT/i.test(r.error||''));
      if(failure)failures.push({instanceId:run.instanceId,at:event.at,kind:event.kind==='identity-block'?'identity-block':'callback-timeout',errno:failure.errno,reason:failure.reason});
    }
    for(const run of runs) for(const event of run.events) {
      if(event.kind!=='action'||String(event.before?.nodeId)!==String(e.source))continue;
      const action=event.action;
      const id=typeof action==='object'?action.id:event.actionId;
      const label=typeof action==='object'?action.label:action;
      if(id!=null ? String(id)!==String(e.id) : label!==e.name || outgoing(e.source).filter(x=>x.name===label).length!==1)continue;
      if(event.responses?.some(r=>r.endpoint?.endsWith('/doAction')&&r.http===200&&r.errno===0))
        evidence.push({instanceId:run.instanceId,at:event.at,kind:'successful-action'});
      else if(event.submitted && !event.responses?.some(r=>r.endpoint?.endsWith('/doAction') && typeof r.errno==='number' && r.errno!==0) && run.events.some(later=>later.kind==='stage' && String(later.state.flowStepId)===String(event.nextRender) &&
        later.state.flowStepId!==event.before.flowStepId && frontier(e.target).some(n=>n.id===String(later.state.nodeId))))
        evidence.push({instanceId:run.instanceId,at:event.at,kind:'observed-next-step',note:'同实例后续页面已读取；不证明中间条件分支全部执行细节'});
    }
    return {id:String(e.id),source:String(e.source),target:String(e.target),name:`${source?.name}：${e.name} → ${target?.name}`,
      operation:e.name,kind:source?.type==='判断'?'条件分支':source?.type==='分流'?'并行分支':/退回|重新提交/.test(e.name)?'退回或重提':'节点操作',
      condition:e.condition||e.restrictScript||bundle.rules?.find(r=>r.id===e.source && r.kind==='判断')?.expression||'',conditionEvidence:e.evidence,nextHandling:frontier(e.target),
      status:evidence.length?'操作成功，后续路径需核对':failures.some(f=>f.kind==='identity-block')?'进入待办受阻，操作未执行':failures.length?'已尝试，受阻':'待验证',evidence,failures};
  });
  const instances=runs.map(run=>{
    const observations=run.events.flatMap(e=>e.after?[e.after]:e.state?[e.state]:e.before?[e.before]:[]);
    const current=observations.at(-1);
    const completed=[...new Set(observations.filter(s=>s.status===2).map(s=>String(s.nodeId)))];
    const identityBlock=run.events.at(-1)?.kind==='identity-block'?run.events.at(-1):undefined;
    const completedActions=run.events.filter(e=>e.kind==='after-action'&&e.completed);
    const pendingTasks=completedActions.at(-1)?.tasks??[];
    const pendingNode=identityBlock?nodes.get(String(identityBlock.nodeId)):undefined;
    const lastCompleted=completedActions.at(-1);
    const actualPendingFrontier=current?.status===2 && lastCompleted?.after.flowStepId===current.flowStepId && pendingTasks.length>0;
    const remaining=current&&!actualPendingFrontier?outgoing(pendingNode?.id??current.nodeId).filter(e=>e.source!==e.target).map(e=>({operation:e.name,target:String(e.target),next:frontier(e.target)})):[];
    const tail=run.events.filter(e=>e.kind==='action').at(-1);
    const response=tail?.responses?.findLast(r=>r.endpoint?.endsWith('/doAction'));
    const diagnostic=run.events.findLast(e=>e.kind==='technical-diagnostic');
    const technical=response?.http>=500 || response?.http===0 || /EVENT_MESSENGER_TIMEOUT|Read timed out/i.test(response?.error||'') ||
      diagnostic && String(diagnostic.nodeId)===String(current?.nodeId) && diagnostic.at>= (tail?.at||'');
    const queryBlocked=!technical && response?.http===200 && response.errno!==0 && /查询.{0,30}失败/.test(response.error??'');
    const business=!technical && !queryBlocked && response?.http===200 && typeof response.errno==='number' && response.errno!==0;
    const businessWaiting=business && /制作中|生成中|等待生成|等待.*办理|尚未就绪/.test(response.error??'');
    const terminal=current && ends.includes(String(current.nodeId)) && current.entryStatus===2 && !actualPendingFrontier;
    // A terminal neighbour proves remaining topology, not successful completion or every upstream rule.
    const closing=current && remaining.length>0 && remaining.every(e=>ends.includes(e.target));
    return {instanceId:run.instanceId,testPlan:run.events.find(e=>e.kind==='path-plan'),current,completedNodes:completed,remaining,
      pendingNode:pendingNode?.name||(actualPendingFrontier?pendingTasks.map(t=>t.name.trim()).join('、'):undefined),identityBlock:identityBlock?.reason,pendingTasks,
      completedActions:completedActions.map(e=>({operation:e.action.label,actionId:e.action.id,step:e.before.flowStepId,node:e.before.name,nextTasks:e.tasks??[]})),
      fieldComparisons:run.events.filter(e=>e.kind==='field-comparison'),
      materialChecks:run.events.filter(e=>e.kind==='material-check'),
      testPlans:run.events.filter(e=>e.kind==='path-plan'),
      reachedEnd:Boolean(terminal),status:terminal?'实例已完成':identityBlock?'待办身份未核实':technical?'系统故障':queryBlocked?'外部查询阻断，原因待核实':closing?'主要审批已到收尾，最终完成待验证':business?'业务条件阻断':'进行中',
      businessWaiting:businessWaiting?response.error:undefined,
      businessBlock:business&&!businessWaiting?response.error:undefined,queryBlock:queryBlocked?response.error:undefined,technicalFailure:technical?{http:response?.http??diagnostic?.http}:undefined,
      interpretation:closing?'当前节点的非自循环出口仅指向终点；不据此认定所有前序条件及完整路径已经验证。':undefined,
      unresolved:business||queryBlocked?'业务响应已确认，外部服务内部状态未取得；不能仅凭提示断言数据错误或服务故障。':undefined};
  });
  return {schemaVersion:2,definitionId:bundle.project.workflowDefinitionId,ends,obligations,instances,
    counting:'按非自循环、非隐藏连线统计有限路径验证项；不是完整起终点组合数。条件分支及并行汇合必须另有实测证据。',
    counts:{obligations:obligations.length,observedOperations:obligations.filter(o=>o.evidence.length).length,
      completedInstances:instances.filter(i=>i.reachedEnd).length,closingInstances:instances.filter(i=>i.status.startsWith('主要审批')).length,
      businessWaitingInstances:instances.filter(i=>i.businessWaiting).length,businessBlockedInstances:instances.filter(i=>i.businessBlock).length,queryBlockedInstances:instances.filter(i=>i.queryBlock).length,technicalBlockedInstances:instances.filter(i=>i.technicalFailure).length}};
}
