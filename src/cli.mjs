import { version } from './version.mjs';
import { existsSync } from 'node:fs';
import { rebuildButtonMap } from '../scripts/v12-build-button-map.mjs';
import { prepareOfficial, officialDirectory } from './output-management.mjs';
import { findCachedProject, projectQuery } from './project-input.mjs';
import {readFile,mkdir,stat,writeFile} from 'node:fs/promises';
import {resolve,join,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
import {importXsn, importTemplateJson} from './xsn.mjs';
import {withRenderer} from './render.mjs';
import {importHar} from './har.mjs';
import {analyze, json} from './analyze.mjs';
import {generate} from './generate.mjs';
import {generateCustom} from './generate-custom.mjs';
import {originalWorkflowImage, originalWorkflowSource, prepareOriginalWorkflow} from './workflow-original.mjs';
import {scan} from './scan.mjs';
import {importTemplates} from './templates.mjs';
import {fieldAnalysisVersion} from './field-options.mjs';
import {importOptionHar, optionEvidence, reviewedOptionEvidence} from './option-evidence.mjs';
import {attachChrome, chromeEndpoint, collectLiveOptions} from './live-options.mjs';
import {captureStagePages} from './capture-stage.mjs';
import {stageAnalysisVersion, stageManifest, stageProfileUrl} from './stage-pages.mjs';
import {debugProbeFile} from './debug-probe.mjs';
import {collectOnlineEvidence} from './online-evidence.mjs';
import {nodeEvidenceVersion} from './node-evidence.mjs';
import {debugRuntimeFile, captureDebugStep, actDebugStep, resumeDebugTask, debugTaskLinks, runtimeSummary, readDebugRuns, appendDebugEvent} from './debug-runtime.mjs';
import {readDebugStep} from './debug-session.mjs';
import {verifyDebugInstance} from './debug-verification.mjs';
import {launchDebug} from './debug-launch.mjs';
import {saveWorkflowInput} from './workflow-inputs.mjs';
import {discoverLinkedBusinessValue} from './linked-instances.mjs';
import {discoverDashboardValue, linkedFieldCandidates, linkedTestInput} from './linked-dashboard.mjs';

export function inspect(bundle) {
  const missing=[];
  if (!bundle.project?.version || bundle.project?.published !== true) missing.push('正式版本尚未确认');
  const nodes=bundle.workflow?.nodes ?? [];
  const edges=bundle.workflow?.transitions ?? [];
  const ids=new Set(nodes.map(n=>n.id));
  if (!nodes.length) missing.push('缺少流程节点');
  if (ids.size!==nodes.length || nodes.some(n=>!n.id)) missing.push('节点 ID 缺失或重复');
  if (!edges.length) missing.push('缺少流程连线');
  edges.forEach((e,i)=>{if(!ids.has(e.source)||!ids.has(e.target)) missing.push(`连线 ${i} 存在悬空节点`);});
  if (!bundle.fields?.length) missing.push('缺少字段清单');
  if (!Number.isInteger(bundle.expectedViews) || bundle.expectedViews<1) missing.push('视图总数未验证');
  if ((bundle.views?.length??0)!==bundle.expectedViews) missing.push('视图数量不一致');
  const viewIds = new Set();
  for (const v of bundle.views??[]) {
    if (!v.id || viewIds.has(v.id)) missing.push('视图 ID 缺失或重复');
    viewIds.add(v.id);
    if (!v.source) missing.push(`视图 ${v.id} 缺少来源`);
    if (!v.screenshot) missing.push(`视图「${v.name ?? v.id}」缺少阶段图`);
  }
  if(!bundle.evidence?.length) missing.push('缺少来源证据');
  const optionStages = { known: 0, partial: 0, unavailable: 0 };
  const optionIds = new Set();
  for (const field of bundle.fields ?? []) {
    if (!Object.hasOwn(optionStages, field.optionStatus)) continue;
    optionStages[field.optionStatus]++;
    optionIds.add(field.id);
  }
  return {
    status: missing.length ? 'unverified' : 'structurally-verified',
    structuralChecksPassed: missing.length === 0, missing,
    limitations: ['已校验静态配置与采集资料。运行时权限、外部服务行为及业务语义需单独验收。'],
    fieldOptions: { choiceFields: optionIds.size, stageRecords: optionStages },
    stagePages: { total: bundle.stagePages?.length ?? 0,
      live: bundle.stagePages?.filter(stage => stage.screenshotSource === '前台完整截图').length ?? 0 },
    runtimeCoverage: bundle.debug && { mode: bundle.debug.selectedMode, reason: bundle.debug.reason,
      entry: bundle.debug.entry, deployment: bundle.debug.deployment, boundary: bundle.debug.boundary,
      frontFallback: bundle.debug.front?.attempted === true, simulatedRoles: bundle.debug.simulatedRoles,
      debugNodes: bundle.debug.visitedNodes?.length ?? 0, verifiedPaths: bundle.debug.verifiedPaths,
      frontOptionFields: new Set(bundle.nodeEvidence?.flatMap(node => node.optionFields)).size,
      completedDebugNodes: bundle.debug.runtime?.completedNodes ?? [],
      debugModeEvidence: bundle.debug.runtime?.modeEvidence ?? [],
      debugInstances: bundle.debug.runtime?.instances ?? 0,
      observedActions: bundle.debug.runtime?.actions ?? [] },
    counts: {
      nodes: nodes.length, transitions: edges.length, fields: bundle.fields?.length ?? 0,
      views: bundle.views?.length ?? 0,
      templates: bundle.views?.filter(view => !view.templateMissing && view.packageViews?.length).length ?? 0,
      previews: bundle.views?.flatMap(view => view.packageViews ?? []).filter(view => view.screenshot).length ?? 0,
    },
  };
}

async function statIfPresent(file) {
  try { return await stat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function readCompleteBundle(directory) {
  const file = join(directory, 'normalized', 'bundle.json');
  const cached = await statIfPresent(file);
  if (!cached?.isFile()) return;
  let bundle;
  try { bundle = await json(file); }
  catch (error) {
    if (error instanceof SyntaxError || error.code === 'ENOENT') return;
    throw error;
  }
  if (!bundle?.project?.code || !Array.isArray(bundle.issues) || bundle.issues.length ||
      ![bundle.workflow?.nodes, bundle.workflow?.transitions, bundle.fields, bundle.views,
        bundle.rules, bundle.evidence].every(Array.isArray)) return;
  if (bundle.fieldAnalysisVersion !== fieldAnalysisVersion && await statIfPresent(join(directory, 'project.json'))) return;
  if (bundle.stageAnalysisVersion !== stageAnalysisVersion && await statIfPresent(join(directory, 'project.json'))) return;
  if (bundle.nodeEvidenceVersion !== nodeEvidenceVersion && await statIfPresent(join(directory, 'project.json'))) return;
  if ((bundle.pathCoverage?.schemaVersion!==2 || bundle.stageFieldAnalysis?.schemaVersion !== 2) && await statIfPresent(join(directory, 'project.json'))) return;
  const report = inspect(bundle);
  if (!report.structuralChecksPassed) return;

  const sources = new Set([
    'project.json', 'raw/network/index.json', 'workflow-map.json', 'raw/editor-observation.json',
    'scan-issues.json', 'reviewed-rules.json', 'raw/manual-debug-reference.json', 'raw/debug-history-evidence.json', 'raw/cross-flow-evidence.json', optionEvidence, reviewedOptionEvidence, debugProbeFile, debugRuntimeFile, ...bundle.evidence.map(item => item.file),
    ...bundle.views.map(view => stageManifest(view.id)),
  ]);
  const sourceStats = await Promise.all([...sources].map(source => {
    if (typeof source !== 'string') return;
    const path = resolve(directory, source);
    if (path.startsWith(directory + sep)) return statIfPresent(path);
  }));
  if (sourceStats.some(source => source?.mtimeMs > cached.mtimeMs)) return;
  if (/^[a-z0-9_-]+$/i.test(bundle.project.code) &&
      (await statIfPresent(stageProfileUrl(bundle.project.code)))?.mtimeMs > cached.mtimeMs) return;

  if (bundle.views.some(view => view.templateMissing || !view.packageViews?.length ||
      view.packageViews.some(panel => !panel.screenshot || panel.issue))) return;
  const previews = new Set(bundle.views.flatMap(view => [view.screenshot, ...view.packageViews.map(panel => panel.screenshot)]));
  for (const stage of bundle.stagePages ?? []) if (stage.screenshot) previews.add(stage.screenshot);
  const viewsDirectory = join(directory, 'views') + sep;
  const previewStats = await Promise.all([...previews].map(preview => {
    const path = resolve(directory, preview);
    if (path.startsWith(viewsDirectory)) return statIfPresent(path);
  }));
  if (!previewStats.every(preview => preview?.isFile() && preview.size > 0)) return;
  return { bundle, report, mtimeMs: cached.mtimeMs };
}

export async function main(args) {
  const outputFlag = args.indexOf('--output-dir');
  let explicitOutput;
  if (outputFlag >= 0) {
    if (!args[outputFlag+1] || args[outputFlag+1].startsWith('--')) throw Error('--output-dir 需要目录');
    explicitOutput = resolve(args[outputFlag+1]);
    args = args.filter((_, i) => i !== outputFlag && i !== outputFlag+1);
    if (explicitOutput.split(sep).includes('_verification')) throw Error('对比正式目录不能位于 _verification');
  }
  let [command,input,output='output']=args;
  if (explicitOutput && !['run','scan','generate','generate-custom','analyze','options','collect-online','debug-session','debug-start','stages','coverage'].includes(command)) throw Error('此命令不支持 --output-dir，请使用其目录参数');
  if (explicitOutput && !['run','scan','coverage'].includes(command)) input = explicitOutput;
  if (command === 'linked-fields' && input) {
    const bundle = await json(join(input, 'normalized', 'bundle.json'));
    console.log(JSON.stringify(linkedFieldCandidates(bundle)));
    return;
  }
  if (command === 'linked-dashboard' && input && args[2] && args[3]) {
    const target = await json(join(input, 'project.json'));
    const predecessor = await json(join(args[2], 'project.json'));
    const criteria = await json(resolve(args[3]));
    if (new URL(target.source).origin !== new URL(predecessor.source).origin)
      throw new Error('关联流程必须属于目标流程所在的已授权站点');
    const connection = await attachChrome();
    try {
      const result = await discoverDashboardValue(connection.context, predecessor, criteria);
      if (result.status !== 'found') { console.log(JSON.stringify(result)); process.exitCode = 2; return; }
      if (args.includes('--save')) {
        await saveWorkflowInput(target, linkedTestInput(criteria, result));
      }
      console.log(JSON.stringify({ status: 'found', evidence: result.evidence, saved: args.includes('--save') }));
    } finally { await connection.close(); }
    return;
  }
  if (command === 'input-set' && input && args[2]) {
    const directory=await prepareOfficial(input);
    const project=await json(join(directory,'project.json'));
    const item=await json(resolve(args[2]));
    await saveWorkflowInput(project,item);
    console.log('已保存流程专属业务测试输入；值不写入业务规则或运行报告。');
    return;
  }
  if (command === 'linked-discover' && input && args[2] && args[3]) {
    const predecessor = await json(join(resolve(input), 'project.json'));
    const criteria = await json(resolve(args[2]));
    const candidate = resolve(args[3]);
    const base = resolve('config/workflow-inputs') + sep;
    if (!candidate.startsWith(base) || !candidate.endsWith('.candidate.json'))
      throw new Error('候选结果必须保存在 config/workflow-inputs 内的 .candidate.json 文件');
    const endpoint = await chromeEndpoint();
    if (!endpoint) throw new Error('专用 Chrome 尚未启动');
    const connection = await attachChrome(endpoint);
    try {
      const result = await discoverLinkedBusinessValue(connection.context, predecessor, criteria);
      if (result.status !== 'found') { console.log(JSON.stringify(result)); process.exitCode=2; return; }
      await mkdir(base, {recursive:true});
      await writeFile(candidate, JSON.stringify(result,null,2)+'\n', {flag:'wx'});
      console.log(JSON.stringify({status:'found', candidateFile:candidate, evidence:result.evidence}));
    } finally { await connection.close(); }
    return;
  }
  if(command==='issues'){
    console.log(await readFile(new URL('../docs/known-issues.md',import.meta.url),'utf8'));
    return;
  }
  if(command==='run'&&input){
    const flags=args.slice(2);
    if(flags.some(flag=>!['--offline','--static','--rescan'].includes(flag)) || flags.includes('--offline')&&flags.includes('--rescan'))throw new Error('用法：run <编号或名称> [--offline | --static] [--rescan]');
    const query=projectQuery(input);
    let cached;
    if (explicitOutput) {
      const metadata = await statIfPresent(join(explicitOutput,'project.json'));
      if (metadata) {
        const project = await json(join(explicitOutput,'project.json'));
        if (![project.code,project.name,project.projectCode].some(v=>String(v??'').toLowerCase()===query.toLowerCase()) || (process.env.INFOPLUS_VERSION && project.version!==process.env.INFOPLUS_VERSION)) throw Error('指定目录流程或版本不匹配');
        if (!flags.includes('--rescan')) cached=explicitOutput;
      }
    } else cached=flags.includes('--rescan')?undefined:await findCachedProject(query);
    if(!cached&&flags.includes('--offline'))throw new Error('未找到匹配的离线项目缓存');
    const directory=await prepareOfficial(cached??await scan(query,resolve(officialDirectory('_'),'..'),{staticOnly:true, outputDirectory:explicitOutput}));
    let online={status:'skipped',reason:'已指定离线或仅静态模式'};
    if(!flags.includes('--offline')&&!flags.includes('--static')){
      try{
        const endpoint=await chromeEndpoint();
        if(!endpoint)throw Error('专用 Chrome 未启动');
        const project=await json(join(directory,'project.json'));
        const connection=await attachChrome(endpoint);
        try{const result=await collectOnlineEvidence(connection.context,directory,project);online={status:'checked',debug:result.debug.entry,front:result.front,auto:result.auto};}
        finally{await connection.close();}
      }catch{online={status:'unavailable',reason:'专用 Chrome 或动态页面采集未完成，继续使用本地证据'};}
    }
    const reports=join(directory,'reports');await mkdir(reports,{recursive:true});
    const reportPath=join(reports,'run-report.json');
    const report={version,query,finishedAt:null,static:cached?'reused':'collected',online,documents:'pending'};
    await writeFile(reportPath,JSON.stringify(report,null,2));
    try{await main(['generate',directory]);report.documents=process.exitCode===2?'partial':'updated';}
    catch(error){report.documents='update-failed';throw error;}
    finally{report.finishedAt=new Date().toISOString();await writeFile(reportPath,JSON.stringify(report,null,2));}
    if(online.status==='unavailable')process.exitCode=2;
    return;
  }
  if(command==='coverage'&&input){
    const cached=explicitOutput || await findCachedProject(projectQuery(input));
    if(!cached)throw Error('未找到匹配的项目缓存');
    const report=await json(join(cached,'reports','path-coverage.json'));
    console.log(JSON.stringify(report.counts));
    console.log(join(cached,'reports','path-coverage.json'));
    return;
  }
  if (input && ['generate','generate-custom','analyze','options','collect-online','debug-session','debug-start','stages'].includes(command)) input=await prepareOfficial(input);
  if(command==='debug-start'&&input&&args[2]&&args[3]){
    const project=await json(join(input,'project.json'));
    const connection=await attachChrome();
    try{console.log(JSON.stringify(await launchDebug(connection.context,input,project,args[2],args[3])));}
    finally{await connection.close();}
    return;
  }
  if (command === 'debug-session' && input && args[2]) {
    const directory = resolve(input), project = await json(join(directory, 'project.json'));
    const instanceId = args[2], operation = args[3] ?? 'observe';
    const registered = await readDebugRuns(directory, project);
    if (operation === 'adopt' && args[4] !== `${project.code}@${project.version}`)
      throw new Error('登记现有实例需要明确流程编号和版本');
    if (operation !== 'adopt' && !registered?.runs.some(run => run.origin === 'automatic-debug' && run.instanceId === instanceId))
      throw new Error('仅处理当前流程已登记的调试实例');
    const connection = await attachChrome();
    try {
      const pages = [];
      for (const page of connection.context.pages()) {
        try { const state = await readDebugStep(page, project, instanceId); pages.push({ page, state }); } catch {}
      }
      const active = pages.filter(p => p.state.status === 1);
      const candidates = active.length ? active : pages;
      if (candidates.length !== 1) throw new Error('需要唯一的同版本同实例页面，不能按最近标签页猜测实例');
      const {page, state} = candidates[0];
      let result;
      if (operation === 'verify' || operation === 'observe' || operation === 'adopt') {
        const modeEvidence = await verifyDebugInstance(page, project, state, { writable: operation === 'adopt' });
        await appendDebugEvent(directory, project, instanceId, { kind: 'debug-mode-verification', state, modeEvidence,
          ...(operation === 'adopt' ? { source: '用户手动推进后登记；此前动作未由工具执行' } : {}) });
        if (operation === 'verify') { console.log(JSON.stringify(modeEvidence)); return; }
        result = { stage: await captureDebugStep(page, directory, project, instanceId),
          tasks: await debugTaskLinks(page, project, instanceId) };
      }
      else if (operation === 'act' || operation === 'confirm') result = await actDebugStep(page, directory, project,
        { instanceId, label: args[4], scope: args[5], resumeConfirmation: operation === 'confirm' });
      else if (operation === 'next') result = await resumeDebugTask(page, directory, project,
        { instanceId, step: args[4], scope: args[5] });
      else throw new Error('Debug 操作仅支持 verify、observe、act、confirm、next');
      console.log(JSON.stringify(operation === 'observe' ? { state: result.stage.state,
        memberScopes: result.stage.memberScopes, screenshot: result.stage.screenshot, tasks: result.tasks } : result));
    } finally { await connection.close(); }
    return;
  }
  if (command === 'generate-custom' && input) {
    const directory = resolve(input);
    const cached = await readCompleteBundle(directory);
    const bundle = cached?.bundle ?? (await statIfPresent(join(directory, 'project.json'))
      ? await analyze(directory) : await json(join(directory, 'normalized', 'bundle.json')));
    await writeBusinessVersion(bundle, directory, args[2]);
    return;
  }
  if (command === 'workflow-original' && input) {
    const directory = resolve(input);
    const bundle = await json(join(directory, 'normalized', 'bundle.json'));
    const svg = args[2] ? await readFile(resolve(args[2]), 'utf8') : await originalWorkflowSource(directory);
    if (!svg) throw new Error('缺少 IDE Workflow 画布 SVG');
    console.log(JSON.stringify(await prepareOriginalWorkflow(svg, bundle, directory)));
    return;
  }
  if (command === 'capture' && input && args[2] && args[3]) {
    const directory = resolve(input);
    const project = await json(join(directory, 'project.json'));
    const network = await importHar(output, directory, project);
    const templates = await importTemplates(resolve(args[3]), directory);
    const options = await importOptionHar(output, directory, project);
    console.log(JSON.stringify({ resources: network.captured.length, ...templates, formOptions: options }));
    await main(['generate', directory, '--refresh']);
    if (templates.failed.length) process.exitCode = 2;
    return;
  }
  if (command === 'scan' && input) {
    const directory = await scan(projectQuery(input), resolve(output),{staticOnly:args.includes('--static'),outputDirectory:explicitOutput});
    return main(['generate', directory, '--refresh']);
  }
  if (command === 'import-har' && input && args[2]) {
    const project = await json(join(output, 'project.json'));
    const result = await importHar(input, output, project);
    const options = await importOptionHar(input, output, project);
    console.log(JSON.stringify({ resources: result.captured.length, missingBodies: result.missingBodies, formOptions: options }));
    if (!result.captured.length && !options.matched) process.exitCode = 2;
    return;
  }
  if (command === 'import-templates' && input && args[2]) {
    const result = await importTemplates(resolve(input), resolve(output));
    console.log(JSON.stringify(result));
    if (result.unmatched.length || result.failed.length) process.exitCode = 2;
    return;
  }
  if (command === 'import-options' && input && args[2]) {
    const directory = resolve(input);
    const project = await json(join(directory, 'project.json'));
    const bundle = await statIfPresent(join(directory, 'normalized', 'bundle.json')) &&
      await json(join(directory, 'normalized', 'bundle.json'));
    const result = await importOptionHar(resolve(output), directory, project, bundle);
    console.log(JSON.stringify(result));
    if (!result.matched) process.exitCode = 2;
    return;
  }
  if (command === 'options' && input) {
    const directory = resolve(input);
    const project = await json(join(directory, 'project.json'));
    const endpoint = await chromeEndpoint();
    if (!endpoint) {
      console.log(JSON.stringify({ formOptions: { added: 0, reason: '专用 Chrome 尚未启动，请运行 start-infoplus-chrome.ps1' } }));
      process.exitCode = 2;
      return;
    }
    const { context, close } = await attachChrome(endpoint);
    try {
      const result = await collectLiveOptions(context, directory, project, args[2] || process.env.INFOPLUS_FORM_URL);
      console.log(JSON.stringify({ formOptions: result }));
      if (!result.captured) process.exitCode = 2;
    } finally { await close(); }
    return;
  }
  if (command === 'collect-online' && input) {
    const directory = resolve(input);
    const project = await json(join(directory, 'project.json'));
    const endpoint = await chromeEndpoint();
    if (!endpoint) {
      console.log(JSON.stringify({ reason: '专用 Chrome 尚未启动，文档可继续使用本地证据' }));
      process.exitCode = 2;
      return;
    }
    const { context, close } = await attachChrome(endpoint);
    try {
      const result = await collectOnlineEvidence(context, directory, project);
      console.log(JSON.stringify(result));
      if (!result.front.stages.captured && !result.front.options.captured) process.exitCode = 2;
    } finally { await close(); }
    return;
  }
  if (command === 'stages' && input) {
    const directory = resolve(input);
    const project = await json(join(directory, 'project.json'));
    const endpoint = await chromeEndpoint();
    if (!endpoint) {
      console.log(JSON.stringify({ stagePages: { captured: 0, reason: '专用 Chrome 未启动，可使用 XSN 阶段图' } }));
      process.exitCode = 2;
      return;
    }
    const { context, close } = await attachChrome(endpoint);
    try {
      const result = await captureStagePages(context, directory, project, args[2]);
      console.log(JSON.stringify({ stagePages: result }));
      if (!result.captured) process.exitCode = 2;
    } finally { await close(); }
    return;
  }
  if (['analyze', 'generate'].includes(command) && input) {
    const directory = resolve(input);
    const cached = command === 'generate' && output !== '--refresh' ? await readCompleteBundle(directory) : undefined;
    const bundle = cached?.bundle ?? await analyze(directory);
    const report = cached?.report ?? inspect(bundle);
    report.missing = [...new Set([...report.missing, ...bundle.issues])];
    report.structuralChecksPassed = !report.missing.length;
    report.status = report.missing.length ? 'unverified' : 'structurally-verified';
    let documents;
    if (command === 'generate') {
      await generate(bundle, report, directory, cached?.mtimeMs);
      const business = await writeBusinessVersion(bundle, directory);
      documents = { business };
    } else await writeFile(join(directory, 'analysis-report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({
      counts: report.counts, missing: report.missing.length, status: report.status,
      analysisCache: cached ? 'reused' : 'rebuilt', fieldOptions: report.fieldOptions, stagePages: report.stagePages,
      runtimeCoverage: report.runtimeCoverage, documents,
    }));
    if (report.missing.length) process.exitCode = 2;
    return;
  }
  if (['xsn', 'template-json'].includes(command) && input) {
    await withRenderer(async render => {
      const importer = command === 'xsn' ? importXsn : importTemplateJson;
      const result = await importer(resolve(input), resolve(output), render);
      console.log(JSON.stringify({
        fields: result.fields.length, views: result.views.length,
        screenshots: result.views.filter(view => view.screenshot).length,
      }));
    });
    return;
  }
  if(command!=='inspect'||!input) throw new Error('命令：scan <编号或名称>、collect-online <版本目录>、capture <版本目录> <HAR> <模板目录>、stages <版本目录> [已核实的前台入口 URL]、options <版本目录> [申请页 URL]、import-options <版本目录> <HAR>、inspect <bundle.json>、xsn <文件> <输出目录>、template-json <文件> <输出目录>、import-har <HAR> <版本目录>、import-templates <模板目录> <版本目录>、analyze <版本目录>、generate <版本目录> [--refresh]、generate-custom <版本目录> [模板 JSON]、workflow-original <版本目录> [IDE 画布 SVG]');
  const bundle=JSON.parse(await readFile(resolve(input),'utf8'));
  const report=inspect(bundle);
  await mkdir(resolve(output),{recursive:true});
  await writeFile(join(resolve(output),'analysis-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
  if(report.missing.length) process.exitCode=2;
}

async function writeBusinessVersion(bundle, directory, template) {
  const workflow = join(directory, 'workflow.mmd');
  if (existsSync(workflow)) {
    const evidence = ['debug-evidence-v12', 'debug-evidence'].map(name => join(directory,name)).find(existsSync);
    rebuildButtonMap({workflow,evidence,output:directory});
  }
  if (!await originalWorkflowImage(bundle, directory)) {
    const svg = await originalWorkflowSource(directory);
    if (svg) {
      try { await prepareOriginalWorkflow(svg, bundle, directory); }
      catch (error) { console.warn(`IDE 原图未采用：${error.message}`); }
    }
  }
  const { docxPath, hasOriginalDiagram } = await generateCustom(bundle, directory, template);
  console.log(`已生成 ${docxPath}`);
  if (!hasOriginalDiagram) console.warn('业务版附录 A 尚无可核对的 IDE 原图。请采集完整 Workflow SVG 后再生成。');
  return docxPath;
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error=>{console.error('执行失败：', error.killed ? '子进程超时' : (process.env.INFOPLUS_DEBUG_STACK ? error.stack : error.message.split('\n')[0]));process.exitCode=1;});

