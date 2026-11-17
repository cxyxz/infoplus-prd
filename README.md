# InfoPlus PRD Skill V1.3

在 Windows 上采集已授权的 InfoPlus IDE 配置，输出可追溯的迁移资料。完整需求见 [任务说明](docs/task.md)。

Skill 执行前先读 [SKILL.md](.agents/skills/infoplus-prd/SKILL.md)；实际采集或 Debug 前按 [问题索引](.agents/skills/infoplus-prd/references/issue-index.md) 查阅相关经验。 [执行决策手册](.agents/skills/infoplus-prd/references/debug-playbook.md) 给出提交失败、节点进不去、截图失败和中断恢复的顺序决策；[能力状态](.agents/skills/infoplus-prd/references/capability-matrix.md) 区分已真实验证、仅自动化、部分实现和待实现，避免把未验证能力当成通用能力。

在 Codex 的项目对话中输入 `$infoplus-prd 分析 Z1778：教职工因公临时赴台审批`。在 Claude Code、Cursor 或普通 PowerShell 中，从项目根目录直接使用同一 CLI。

```powershell
node src/cli.mjs run 'Z1778：教职工因公临时赴台审批'
node src/cli.mjs run Z0095 --offline
node src/cli.mjs run Z1525 --static
node src/cli.mjs collect-online output/Z0095
node src/cli.mjs analyze output/Z0095
node src/cli.mjs generate output/Z0095
node src/cli.mjs coverage Z0095
node src/cli.mjs issues
```

`run` 优先复用匹配的缓存。目标没有缓存时，设置下文的 `INFOPLUS_IDE_URL` 后采集静态资料，再检查 Debug 并补充可访问的动态证据。`--rescan` 可主动核对 IDE；已有正式缓存版本不一致时会停止，以免合并不同版本。`--static` 跳过动态采集，缺缓存时仍需 Chrome 下载静态资料。`--offline` 只使用已有缓存。运行报告在 `output/<编号>/reports/run-report.json`，路径覆盖报告在同目录的 `path-coverage.json`。状态为 `partial` 或退出码 2 时，请核对报告中缺失的证据。

`run` 在用户授权的 InfoPlus 旧平台内优先尝试非发布 Debug。常规测试实例、身份选择、提交、审批、退回、重新提交及普通确认包含在本次授权范围内；共享回调、测试记录及普通通知本身不构成阻断。统一策略见 `config/debug-policy.json`；结果、失败和未覆盖部分以运行报告及实例证据为准。已登记实例优先恢复；测试输入或动作无法可靠判断时保留阻断，不把未执行路径标为验证。不得绕过权限、修改或部署正式定义、删除业务记录；发现不可逆修改其他系统真实业务数据时停止该具体动作。

可运行 `node src/cli.mjs debug-session <流程目录> <实例UUID> verify` 只读核对当前实例。发送动作前会重新检查目标版本行的 IDE Debug 入口、`Instances → DEBUG` 中的业务流水号、页面的调试模式标记、办理身份和权限。普通委托中转页只能辅助导航。核验结果保存在 `raw/debug-runs.json`。

使用 `node src/cli.mjs input-set <流程目录> <输入 JSON>` 保存流程专属业务编号。编号以字符串保存，绑定流程版本、字段和适用节点。`linked-discover <前置流程目录> <匹配条件 JSON> <候选输出路径>` 按已授权且明确的条件从前置申请数据页只读提取字段值。核对候选后再保存为业务测试输入。实例表的 Id 用于定位记录。业务测试输入和需求规则分别维护。

`linked-fields <目标流程目录>` 从已解析字段列出可能关联业务的字段。结合原页面说明或脚本核实前置流程和字段 ID 后，可用 `linked-dashboard <目标流程目录> <前置流程目录> <匹配条件 JSON> --save` 调用办事中心已完成申请查询。工具逐项核对前置流程定义、流水号、申请人工号、详情状态及业务字段，以字符串保存业务编号。

`config/workflow-inputs/<目标编号>-linked.json` 供 `run` 在缺少目标输入时查找。记录 `targetVersion`、`targetDefinitionId`、`predecessorCode`、`applicantAccount`、`applicantFieldId`、`fieldId`、`targetFieldId`、`targetFieldName`、`targetApplicantFieldId` 和 `nodeIds`，可选 `serial` 指定唯一案例。多候选或条件不全时补充匹配条件。使用已缓存的编号前核对当前模拟人和表单申请人。

`debug-session <流程目录> <实例UUID> adopt <编号>@<版本>` 核实并登记用户已手动推进的在办 DEBUG 实例。实际步骤可采证，之前动作保留为人工验证。已核实的字段来源、权限和待确认事项通过 `raw/cross-flow-evidence.json` 进入唯一业务 Word。

V1.2 的 Debug 全流程深度采集由 `src/form-autofill.mjs` 与 `scripts/v12-walk-flow.mjs` 执行逐节点循环：全页面必填扫描（含滚动区外、条件隐藏、动态字段、附件）→ 自动填合规测试值 → 提交 → 校验失败自动修正 → 核对真实待办与流转 → 保存证据 → 下一节点。普通必填校验失败不会终止分析；提交暴露的新联动必填项会自动补填后再提交。

```powershell
node scripts/v12-walk-flow.mjs --dir output/Z1775 --instance <实例UUID> --scope Z1775@<版本> --workflow output/Z1775/workflow.mmd --evidence <证据目录> --attachment <DEBUG测试附件> --max-steps 25
```

弹窗统一区分说明、提交确认、必填、格式、业务条件、外部服务异常及未知。关闭校验提示仅表示已读；修复字段并重新检查后才能重新提交。请求结果未知时核验实例与待办，禁止盲目重复提交。错误证据与状态保留，不能把生成 Word 当作 Debug 完成。

正式成果在 `output/<编号>/`，包括一份业务 Word 和配套证据。Word 被占用会报告失败并保留同目录 `.pending`，关闭 Word 后重新运行生成。参见 [版本记录](CHANGELOG.md)、[已知问题](docs/known-issues.md)、[迭代待办](docs/improvement-backlog.md) 和 [V1.0 验收报告](docs/v1.0-acceptance.md)。

安装 Node.js 22 及更新版本、Chrome。使用 `npm ci` 安装依赖，`npm test` 执行结构校验测试。

在 PowerShell 启动专用 Chrome。

```powershell
& 'E:\infoplus\start-infoplus-chrome.ps1'
```

首次启动后，在新窗口登录 InfoPlus。以后运行同一个脚本可复用 `E:\infoplus\chrome-profile`，会话有效时可直接进入 InfoPlus。Chrome DevTools MCP 的配置随项目加载，使用 `--browser-url=http://127.0.0.1:9222`。在 `E:\infoplus` 开启 Codex 会话后，可用 `codex mcp get infoplus_chrome` 查看配置。

用完后，在专用 Chrome 窗口的菜单中选择「退出」，结束该实例并释放端口。保留 `chrome-profile` 以便下次复用。若要检查端口是否已释放，执行脚本并附加 `-Check`。退出码 2 表示专用 Chrome 未运行。

```powershell
$env:INFOPLUS_IDE_URL = 'https://one.zju.edu.cn/infoplus/ide/project/ZD_YGCGJSCS'
# 有多个版本时，先核实要采集的版本。指定采集版本不会将其标为已发布。
$env:INFOPLUS_VERSION = '20260428-104555'
.\infoplus-prd.cmd scan Z0095 output
```

`scan` 使用专用 Chrome，按页面显示的项目和视图下载链接采集。后续可直接针对版本目录再生成文档。

```powershell
.\infoplus-prd.cmd import-har output\Z0095\z0095.har output\Z0095\20260428-104555
.\infoplus-prd.cmd generate output\Z0095\20260428-104555
.\infoplus-prd.cmd xsn 'C:\data\view.xsn' 'output\Z0095\20260428-104555\views\<视图ID>'
.\infoplus-prd.cmd import-templates 'C:\data\Z0095-views' 'output\Z0095\20260428-104555'
.\infoplus-prd.cmd capture 'output\Z0095\20260428-104555' 'output\Z0095\z0095.har' 'C:\data\Z0095-views'
```

HAR 使用 Chrome DevTools 的 sanitized 导出。导入器提取指定站点的目标响应体，筛除会话字段，原始 HAR 保持在本地。Views HTML 只保留视图表的标题、编号、时间和同源资源路径。已验证的 `guiDefinition` XML 格式自动解析。其他 JSON 格式可配置 `workflow-map.json`，其中 `file` 指向响应文件名，`nodes`、`transitions` 为节点和连线数组的 JSON Pointer，`node`、`edge` 指定各条记录的字段路径。

离线解析支持 XSN 或 InfoPlus IDE 下载的 JSON 模板。使用 `template-json` 命令导入后者，输出目录与 `xsn` 相同。`import-templates` 批量匹配同一版本目录中的视图 ID 或名称，保留首次导入的源文件。渲染使用默认模板数据，禁止脚本和外部网络访问。

输出 Markdown、DOCX、字段与脚本 CSV、标准化 JSON、流程图和完整性报告。退出码 2 表示部分输出或缺失资料。Z0095 已用真实 HAR 和 18 个 XSN 验证 `capture`，运行时回调、审批人解析与动态权限需要业务验收。

`generate`、`capture` 和 `scan` 默认交付唯一业务 Word，`流程编号：流程名称需求文档.docx`。命令在 `documents` 中返回业务 Word 路径。Markdown 等文件保留为内部资料。旧命名 `requirements_custom.docx` 已停用，确认有当前版替代且旧件无独有内容后可清理。

唯一业务 Word 共用同一次本地解析和已核对的规则。直接对版本目录执行 `generate` 会复用完整且未过期的标准化缓存及可用流程图，无需连接采集浏览器。命令通过 `analysisCache` 报告是否复用。原始资料有更新时自动重建缓存，也可用 `generate <版本目录> --refresh` 强制重新解析本地资料。

选项解析读取已有 XSN、IDE 字段配置和表单定义。已授权 Chrome 会话中的同流程申请页可在隔离标签页补采，工具记录 `suggest` 选项、实际值、阶段及条件变化。自动探测只打开现有申请或安全预览，拦截写入操作。单次接口返回标为已观测，未取得的选项单独计入覆盖摘要。没有可读取的申请页时，仍生成本地资料。

截图取证在 V1.2 中与字段分析、按钮流转同等重要。`scripts/v12-capture-screenshots.mjs` 复用当前 Debug 实例与历史只读快照，按节点采集完整页面（长页面分段）、底部业务按钮、特殊字段/条件图，写入 `debug-evidence/NN-节点名-ID/`，并生成 `screenshot-index.json` / `.md` 和 `screenshot-quality.json`；重复图、过小图、节点不匹配图会被质量门禁拒绝。没有实时按钮证据时，可用 `scripts/v12-finalize-button-screenshots.mjs` 从同一实例的实时完整截图裁剪底部按钮区并注明来源；完全缺失时明确记录原因，不用平台工具栏或 XSN 预览冒充。业务版 Word 默认在正文中按节点展示真实截图和按钮流转表，不把截图只堆在附录。`INFOPLUS_SCREENSHOT_DIR` 可指定隔离输出中的截图索引目录；`INFOPLUS_ISOLATED_OUTPUT=true` 可阻止 CLI 按流程编号回写正式目录。

`node src/cli.mjs stages <版本目录>` 独立补采欢迎页的完整截图、说明文字、链接和按钮。命令默认使用专用 Chrome 中已缓存且与版本匹配的前台预览，拦截发起和提交。若没有实时证据，文档仍保留流程定义和 XSN 中的阶段页面，并标明图片来源。业务版附录 B 将说明页放在第一张图。

`node src/cli.mjs collect-online <版本目录>` 使用专用 Chrome 先检查目标版本的非发布 Debug 入口与回调配置，再补采前台欢迎页和字段选项。`scan` 也执行该检查。入口可达、部署状态及共享回调分别记录；共享回调本身不阻断已授权的常规 Debug。前台回退和实际运行结果见 `raw/debug-probe.json` 与运行报告，业务文档和内部资料共用标准化证据。

```powershell
.\infoplus-prd.cmd options 'output\Z0095\20260428-104555'
.\infoplus-prd.cmd import-options 'output\Z0095\20260428-104555' 'C:\data\sanitized-options.har'
.\infoplus-prd.cmd generate 'output\Z0095\20260428-104555'
```

`options` 和项目 MCP 在连接前检查 9222 的监听进程是否属于专用资料目录。保留可读取的申请页或安全预览即可采集。若其他进程占用了 9222，启动脚本会提示释放该端口。

实时采集在隔离标签页放行与当前申请步骤匹配的 `POST /infoplus/interface/render`，用响应核对流程定义和视图。随后仅放行同一实例的 `POST /infoplus/interface/instance/<实例 ID>/progress` 读取历史。Select2 选项与联动变化随阶段和触发条件记录。

可用 `INFOPLUS_FORM_URL` 指定已验证的同源 render 页面。观测记录在版本目录的 `raw/field-option-observations.json`，结果写入标准化数据和字段 CSV。浏览器验证中的必填、只读及显隐状态按所观测阶段记录，现有申请值不作为默认值。

仅调整业务版时，可复用已生成的标准化资料和图像。

```powershell
.\infoplus-prd.cmd generate-custom 'output\Z0095\20260428-104555'
.\infoplus-prd.cmd generate-custom 'output\Z0095\20260428-104555' 'config\requirements-custom.json'
```

业务版模板位于 `config/requirements-custom.json`。调整 `sections` 可改标题和章节顺序，`word` 控制字号、纸张、页边距、表格配色与列宽。`formPanelPolicy` 默认每阶段选一张代表图，可设为 `all` 展示包内全部不同图片。业务说明与排版分开配置。`config/business-profiles/Z0095.json` 是经过核对的版本专用示例，只在流程编号、版本与定义 ID 匹配时使用。

业务文档正文和附录 A 使用 InfoPlus IDE 的完整原始画布，宽图增加局部放大。在线 `scan` 会尝试保存 SVG，已采集的原图则直接复用。若已有原始 Workflow SVG，可用 `workflow-original <版本目录> <IDE 画布 SVG>` 核对并生成原图，再执行 `generate-custom`。缺少经核对的原图时标明待补图；自动绘制图只作为内部技术资料。

跨项目使用时，将 `.agents/skills/infoplus-prd` 安装到个人技能目录，并将 `INFOPLUS_PRD_HOME` 指向本项目。

### V1.2 稳定性修复（2026-11-17）

版本唯一来源是 package.json；运行报告读取 src/version.mjs。lock 和 Skill 元数据由一致性测试核对，历史 CHANGELOG 保留。

默认使用 output/<编号>/。独立对比明确指定目录，证据、缓存、报告和 Word 均留在该目录：

```powershell
node src/cli.mjs run Z1775 --output-dir output/Z1775workbuddy --offline
node src/cli.mjs generate output/Z1775workbuddy
```

不需要 INFOPLUS_ISOLATED_OUTPUT；旧环境变量仍兼容。已有目录参数保持原位置；仅旧 _verification 输入继续按原有迁移核对规则处理。截图限定任务内相对路径，original 原图不插入业务版。无业务结果码不算成功，步骤完成不算实例结束。验收范围见 [稳定性报告](docs/v1.2-stability-acceptance.md)。

### V1.2.1 截图与排版质量修复（2026-11-17）

截图采集使用 `src/full-form-capture.mjs`：在宽屏视口定位唯一 `#form_holder`，展开内部滚动容器，隐藏平台导航并脱敏字段值，生成完整表单图和按业务行对齐的模块裁剪图。图片进入 Word 前由 `src/screenshot-quality.mjs` 分为 A/B/C/D/E；只有完整业务页面、业务局部和有效校验提示可进入正文，调试错误和视口分段只保留在证据中。

补采已完成节点的历史只读页面：`node scripts/v121-recapture-snapshots.mjs output/<对比目录>`；同一实例已有实时按钮源图时，用 `scripts/v121-restore-button-evidence.mjs` 恢复按钮裁剪。随后执行 `node src/cli.mjs generate output/<对比目录>` 原位重生成唯一业务 Word。业务版章节顺序由 `config/requirements-custom.json` 的 `sections` 控制，历史阻断仅在后续 Debug 未解决时作为当前问题。

业务文档附录 B 遇到超长 XSN 预览时按页面可用高度连续分段，附图标注“续 N/M”，并明确静态来源。测试使用 `npm test`，覆盖图片分段、质量门禁、按钮动作标识、版本、拓扑顺序、身份脱敏和输出隔离。

### V1.3.1 字段原子化与分组结构修复（2026-11-17）

字段清单统一为六列：分组、字段名称、字段类型、必填、出现阶段、数据来源/规则。一个真实字段占一行，字段身份以真实 field ID 为准；同一 ID 跨阶段出现时汇总阶段状态，不同 ID 即使名称、类型、规则或阶段相同也不合并。禁止按顿号、冒号等显示文本拆分字段，也禁止为了压缩表格把多个字段写入一个单元格。回归测试直接解析生成的 DOCX 表格核对字段行。

### V1.3 单文档交付（2026-11-17）

默认仅生成 `流程编号：流程名称需求文档.docx`，不再写 `requirements.docx`。技术 Markdown、CSV、JSON、XSN、路径覆盖和截图保持内部资料。`generate-custom` 是兼容命令。固定九章按模板顺序输出，节点按 Workflow 正向拓扑排序，按钮按动作标识去重。已有旧 Word 不会批量删除。对比目录仍完全独立。
