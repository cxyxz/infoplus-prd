const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();

// Field identity comes from structured data. Group is only a display attribute.
// Different field IDs are never merged, even when names/types/rules/stages match.
export function atomicFieldRows(records, { groupName, viewOrder = new Map(), fieldsById } = {}) {
  const byId = new Map();
  for (const record of records) {
    const id = record.id ?? record.fieldId;
    if (!id || /^_VAR_/i.test(String(id))) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(record);
  }
  return [...byId].map(([id, items]) => {
    const canonical = fieldsById?.get(id) ?? items.find(item => item.name && item.name !== id) ?? items[0];
    const stages = [...new Set(items.flatMap(item => item.stages ?? [item.view ?? item.stage]).filter(Boolean))]
      .sort((a, b) => (viewOrder.get(a) ?? Infinity) - (viewOrder.get(b) ?? Infinity));
    const requiredParts = [];
    for (const item of items) {
      const itemStages = item.stages ?? [item.view ?? item.stage];
      if (item.required === true) requiredParts.push(`${itemStages.map(clean).filter(Boolean).join('、') || '未标明阶段'}必填`);
      else if (item.required === false) requiredParts.push(`${itemStages.map(clean).filter(Boolean).join('、') || '未标明阶段'}可选`);
    }
    const rules = [...new Set(items.flatMap(item => item.rules ?? []).filter(Boolean))];
    const source = clean(canonical.source ?? items.find(item => item.source)?.source);
    const rule = [...new Set(items.flatMap(item => [
      clean(item.rule), clean(item.description), ...(item.evidence ?? []),
    ]).filter(Boolean))];
    if (source) rules.unshift(source);
    rules.push(...rule);
    return {
      fieldId: String(id),
      groupName: clean(groupName ?? canonical.groupName ?? '未分组字段'),
      fieldName: clean(canonical.name ?? id),
      fieldType: clean(canonical.type ?? canonical.fieldType ?? canonical.usages?.[0]?.kind ?? '待核对'),
      required: requiredParts.length ? [...new Set(requiredParts)].join('；') : '按阶段配置',
      stages,
      source: source || '待核实',
      rules: rules.length ? [...new Set(rules)].join('；') : '按阶段配置',
      evidence: [...new Set(items.flatMap(item => item.evidence ?? []).filter(Boolean))],
      editableStages: [...new Set(items.filter(item => item.editable === true || item.readOnly === false)
        .map(item => item.view ?? item.stage).filter(Boolean))],
      visibleStages: stages,
    };
  });
}

export function atomicRowsForWord(records) {
  return records.map(field => [
    field.groupName,
    field.fieldName,
    field.fieldType,
    field.required,
    field.stages.join('、') || '待核实',
    field.rules,
  ]);
}

export function nodeFieldsForWord(records) {
  return records.map(field => [
    field.groupName,
    field.fieldName,
    field.fieldType,
    field.required,
    field.stages.join('、') || field.groupName,
    field.rules,
  ]);
}
