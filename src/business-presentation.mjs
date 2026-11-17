// Presentation-only transformation: original evidence is never rewritten.
export function businessTextFormatter(bundle) {
  const names = new Map((bundle.fields || []).filter(f => f.name && f.name !== f.id).map(f => [f.id,f.name]));
  const z0095Names = new Map([
    ['fieldTZXXTZBH','团组编号'], ['fieldGRXXZGH','申请人工号'], ['fieldGRXXXM','申请人姓名'],
    ['fieldSJFrom','出访开始日期'], ['fieldSJTo','出访结束日期'], ['fieldGZDW','出访国家地区'],
    ['fieldRS','团组人数'], ['fieldTZMC','团组名称'],
  ]);
  const labelFor = id => names.get(String(id)) || z0095Names.get(String(id)) || null;
  const source = JSON.stringify(bundle.crossFlow || {});
  const identities = new Set();
  for (const match of source.matchAll(/(?:姓名|登录身份|办理人(?:经平台显示为)?|当前 DEBUG 身份)([\u4e00-\u9fff]{2,4})(?=[(（，。、；\s])/g)) identities.add(match[1]);
  for (const match of source.matchAll(/([\u4e00-\u9fff]{2,4})[（(][A-Za-z]?\d{5,}[)）]/g)) identities.add(match[1]);
  return value => {
    let text = String(value ?? '');
    const version = String(bundle.project?.version || '');
    if (version) text = text.replaceAll(version, 'FLOWVERSIONPLACEHOLDER');
    for (const name of identities) text = text.replaceAll(name, '测试人员');
    text = text.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, '（详见受控证据）')
      .replace(/\b[A-Za-z]?\d{5,}\b/g, '（测试值已隐去）')
      .replace(/\bfield[A-Za-z0-9_]+\b/g, id => names.get(id) || '关联字段（名称待核对）')
      .replace(/具体动作和条件见详细版规则证据/g, '具体动作和条件见内部规则证据')
      .replace(/静态动作脚本：/g, '配置规则：')
      .replace(/HTTP\s*200\s*[、/，]?\s*(?:errno\s*0|业务码\s*0)/gi, '办理成功响应');
    if (version) text = text.replaceAll('FLOWVERSIONPLACEHOLDER',version);
    return text;
  };
}

export function businessAssociation(bundle) {
  if (!bundle.crossFlow) return null;
  const {summary=[],fields=[],limits=[]} = bundle.crossFlow;
  const names = new Map((bundle.fields || []).filter(f=>f.name && f.name!==f.id).map(f=>[f.id,f.name]));
  const z0095Names = new Map([
    ['fieldTZXXTZBH','团组编号'], ['fieldGRXXZGH','申请人工号'], ['fieldGRXXXM','申请人姓名'],
    ['fieldSJFrom','出访开始日期'], ['fieldSJTo','出访结束日期'], ['fieldGZDW','出访国家地区'],
    ['fieldRS','团组人数'], ['fieldTZMC','团组名称'],
  ]);
  const labelFor = id => names.get(String(id)) || z0095Names.get(String(id)) || null;
  const overview = summary[0]?.split(/，项目代码|，定义 ID/)[0];
  const paragraphs = overview ? [overview.replace(/。?$/,'。')] : [];
  if (summary.some(s=>/团组编号与流程流水号.*不同字段/.test(s)))
    paragraphs.push('关联时使用前置申请的团组编号；团组编号与流程流水号不同，不得混用。');
  if (summary.some(s=>/验证关联关系成立|关联成功/.test(s)))
    paragraphs.push('已通过 Debug 验证前置数据关联成功；已验证案例中前置申请人与模拟申请人一致。其他匹配边界仍需确认。');
  const carried = summary.find(s=>/自动带出/.test(s));
  if (carried) paragraphs.push('关联后的自动带出字段、来源与可修改状态见下表；历史页面显示不自动证明当前编辑权限。');
  return {
    paragraphs,
    fields: fields.map(row=>{
      let source = String(row[2] || '').split(/，值|=|；当前 DEBUG|详情姓名/)[0];
      const evidence = String(row[3] || '');
      const rules = [];
      if (/只读/.test(evidence)) rules.push('已观测阶段只读');
      if (/可编辑/.test(evidence)) rules.push('已采集页面记录可编辑，当前权限须按节点配置');
      if (/自动带出/.test(evidence)) rules.push('关联成功后自动带出；后续是否允许修改待确认');
      if (!rules.length) rules.push('已取得关联显示结果；具体修改权限按节点核对');
      let label = labelFor(row[0]) || row[0];
      if (/^\d{4,}$/.test(label)) label = '关联字段（名称待核对）';
      const labels = label.split(' / ').map(part => labelFor(part.trim()) || part.trim());
      source = source.replace(/field[A-Za-z0-9_]+/g, id => labelFor(id) || '关联字段（名称待核对）');
      if (/From\/To/.test(label)) label = '出访起止日期';
      return { fieldId: String(row[0]), labels, source, rules: rules.join('；') };
    }),
    limits: limits.filter(s=> !/本地校验阻断|护照状态查询失败|本次仅验证/.test(s)),
  };
}
