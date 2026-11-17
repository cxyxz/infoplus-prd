// The caller supplies a verified predecessor definition, an explicit applicant,
// business name and status, and the exact business field ID. No fuzzy inference.
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fieldId = /^[A-Za-z][A-Za-z0-9_]{0,127}$/;

export function selectLinkedInstance(rows, criteria) {
  if (!criteria || !criteria.applicant || !criteria.name || !criteria.status ||
      !fieldId.test(criteria.fieldId || '') || !criteria.predecessorCode) {
    return { status: 'needs-context', reason: '缺少已核实的前置流程、申请人、业务名称、状态或字段 ID' };
  }
  const matches = rows.filter(r => r.applicant === criteria.applicant && r.name === criteria.name &&
    r.status === criteria.status && typeof r.dataPath === 'string');
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous' : 'not-found', count: matches.length };
  return { status: 'matched', candidate: matches[0] };
}

export function extractLinkedBusinessValue(fields, requestedFieldId) {
  if (!fieldId.test(requestedFieldId || '')) return { status: 'invalid-field' };
  const matches = fields.filter(f => f.id === requestedFieldId && typeof f.value === 'string' && f.value.trim());
  if (matches.length !== 1) return { status: matches.length ? 'ambiguous-field' : 'field-unavailable' };
  return { status: 'found', value: matches[0].value };
}

// Read-only browser access. Every document is an explicitly validated same-origin
// GET, all scripts, subresources, navigations and non-GET requests are blocked.
// The candidate's numeric platform step/instance identifiers are never used as
// the requested business value. No applicant name or field value is logged.
export async function discoverLinkedBusinessValue(context, predecessor, criteria) {
  const source = URL.parse(predecessor?.source || '');
  const definition = predecessor?.workflowDefinitionId;
  if (!source || source.protocol !== 'https:' || source.username || source.password || !uuid.test(definition || '') ||
      !/^[A-Za-z0-9_-]+$/.test(predecessor?.code || '') || criteria?.predecessorCode !== predecessor.code ||
      !criteria.applicant || !criteria.name || !criteria.status || !fieldId.test(criteria.fieldId || '')) {
    return { status: 'needs-context', reason: '缺少可核对的前置流程、申请人、业务名称、状态或字段 ID' };
  }
  const mode = criteria.release === false ? 'false' : criteria.release === true ? 'true' : null;
  if (mode === null) return { status: 'needs-context', reason: '须明确前置实例为 RELEASE 或 DEBUG' };
  const list = new URL(`/infoplus/ide/project/${definition}/instances`, source.origin);
  list.searchParams.set('release', mode);
  const page = await context.newPage();
  let allowed = list.href;
  await page.route('**/*', route => {
    const request = route.request();
    return request.method() === 'GET' && request.url() === allowed && request.resourceType() === 'document'
      ? route.continue() : route.abort();
  });
  try {
    const response = await page.goto(list.href, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!response?.ok() || page.url() !== list.href) return { status: 'unavailable', reason: '前置流程实例列表不可读取' };
    const rows = await page.evaluate(() => {
      const table = [...document.querySelectorAll('table')].find(t => {
        const headings = [...t.querySelectorAll('th')].map(e => e.textContent.trim());
        return ['Name', 'User', 'Status'].every(h => headings.includes(h));
      });
      if (!table) return [];
      const headings = [...table.querySelectorAll('th')].map(e => e.textContent.trim());
      return [...table.querySelectorAll('tbody tr')].flatMap(row => {
        const cells = [...row.cells];
        const data = [...row.querySelectorAll('a[href]')].map(a => new URL(a.getAttribute('href'), location.href))
          .filter(u => u.origin === location.origin && /^\/infoplus\/form\/e?\d+\/data\/?$/.test(u.pathname) && !u.search && !u.hash);
        if (data.length !== 1) return [];
        return [{name:cells[headings.indexOf('Name')]?.textContent.trim(), applicant:cells[headings.indexOf('User')]?.textContent.trim(),
          status:cells[headings.indexOf('Status')]?.textContent.trim(), dataPath:data[0].pathname}];
      });
    });
    const selection = selectLinkedInstance(rows, criteria);
    if (selection.status !== 'matched') return selection;
    const dataUrl = new URL(selection.candidate.dataPath, source.origin);
    allowed = dataUrl.href;
    const dataResponse = await page.goto(allowed, { waitUntil: 'domcontentloaded', timeout: 15000 });
    if (!dataResponse?.ok() || page.url() !== allowed) return { status: 'unavailable', reason: '前置申请数据页不可读取' };
    const values = await page.evaluate(id => [...document.querySelectorAll('input[name], textarea[name], select[name]')]
      .filter(e => e.name === id).map(e => ({id:e.name,value:String(e.value ?? '')})), criteria.fieldId);
    const value = extractLinkedBusinessValue(values, criteria.fieldId);
    if (value.status !== 'found') return value;
    return {...value, evidence:{predecessorCode:predecessor.code, definitionId:definition, fieldId:criteria.fieldId,
      release:criteria.release, match:'申请人、业务名称、状态精确匹配', source:'已授权的前置实例数据页', verifiedAt:new Date().toISOString()}};
  } finally { await page.close(); }
}
