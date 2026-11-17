import { resolveDebugLaunch } from './debug-probe.mjs';

export function requireDebugPage(state, { writable = false } = {}) {
  if (state.release !== false || !state.debugMarker || !/^\d+$/.test(String(state.entryId))) {
    throw new Error('页面缺少非发布实例和平台调试模式标记，不能确认为后台 DEBUG');
  }
  if (writable && (!state.executable || state.status !== 1 || !state.identityMatched)) {
    throw new Error('当前调试身份未与办理人核对一致，或步骤不可办理');
  }
}

export async function verifyDebugInstance(page, project, state, options) {
  requireDebugPage(state, options);
  const evidencePage = await page.context().newPage();
  try {
    const entry = await resolveDebugLaunch(evidencePage, project);
    const list = new URL(`/infoplus/ide/project/${project.workflowDefinitionId}/instances?release=false`, entry.origin);
    for (const keyword of ['', String(state.entryId)]) {
      if (keyword) list.searchParams.set('keyword', keyword);
      const response = await evidencePage.goto(list.href, { waitUntil: 'domcontentloaded', timeout: 10000 });
      if (!response?.ok() || evidencePage.url() !== list.href) break;
      const result = await evidencePage.evaluate(({ path, entryId }) => {
        const debugTab = [...document.querySelectorAll('a')].find(a => {
          const url = new URL(a.href);
          return a.textContent.trim() === 'DEBUG' && a.parentElement.classList.contains('selected') &&
            url.origin === location.origin && url.pathname === path && url.searchParams.get('release') === 'false';
        });
        const detailPath = path.replace(/\/instances$/, '/instance/') + entryId;
        const rows = [...document.querySelectorAll('table tr')].filter(row =>
          row.cells[0]?.textContent.trim() === entryId && [...row.querySelectorAll('a[href]')].some(a => {
            const url = new URL(a.href);
            return url.origin === location.origin && url.pathname === detailPath && url.searchParams.get('release') === 'false';
          }));
        return { debugTab: Boolean(debugTab), entries: rows.length, status: rows[0]?.cells[5]?.textContent.trim() };
      }, { path: list.pathname, entryId: String(state.entryId) });
      if (!result.debugTab) break;
      if (result.entries === 1) {
        if (options?.writable && result.status !== '进行中') throw new Error('IDE DEBUG 实例状态不是进行中');
        return { verifiedAt: new Date().toISOString(), version: project.version, definitionId: project.workflowDefinitionId,
          instanceId: state.instanceId, entryId: state.entryId, flowStepId: state.flowStepId,
          ideDebugEntry: true, debugTab: true, listedStatus: result.status, debugMarker: true,
          identityMatched: state.identityMatched };
      }
    }
    throw new Error('未能在目标版本的 IDE Instances → DEBUG 核对当前实例');
  } finally {
    await evidencePage.close();
  }
}
