# 问题索引

按关键词选择条目。执行采集或 Debug 前先读相关条目；同一问题有多条策略时，以“已真实验证”优先。验证状态定义见 [能力状态](capability-matrix.md)。

| ID | 关键词 | 问题摘要 | 知识条目 | 主要证据/测试 | 状态 |
|---|---|---|---|---|---|
| KC-01 | CDP、超时、iframe、标签、页面失效 | Chrome 已连接但页面不能读取或操作 | [CDP 与页面读取](troubleshooting.md#chrome-cdp-与页面读取) | `src/live-options.mjs`、`src/full-form-capture.mjs`、`reports/v12-stability-browser-check.json` | 已真实验证/部分实现 |
| KC-02 | Debug、委托、release=false、身份 | 把前台或委托办理误判为 Debug | [Debug 模式误判](troubleshooting.md#debug-模式误判) | `src/debug-verification.mjs`、`src/debug-session.mjs`、Z0095 debug-probe | 已真实验证 |
| KC-03 | 回调、副作用、共享事件 | 共享回调导致提前中止或授权边界不清 | [环境回调与授权边界](troubleshooting.md#环境回调与授权边界) | `config/debug-policy.json`、Z0095/Z1775 运行记录 | 已真实验证 |
| KC-04 | 22001、团组编号、前置业务、流水号 | 跨流程业务编号无法获取或混用 | [跨流程关联](cross-flow-identity.md) | `src/linked-dashboard.mjs`、`config/workflow-inputs/Z1775-linked.json`、`raw/cross-flow-evidence.json` | 已真实验证 |
| KC-05 | HTTP 200、errno、回调超时、制作中 | HTTP 成功与业务/流转成功混淆 | [业务响应与流转状态](troubleshooting.md#业务响应与流转状态) | `src/dialog-classification.mjs`、`src/debug-runs.json`、`reports/path-coverage.json` | 已真实验证 |
| KC-06 | 必填、格式、校验弹窗、动态字段 | 普通校验导致 Debug 中止 | [表单校验修复](troubleshooting.md#表单校验与动态必填) | `src/form-autofill.mjs`、`scripts/v12-repair-and-submit.mjs`、Z1775 step7-apply | 已真实验证 |
| KC-07 | 附件、成员、日期、必填、阶段差异 | 字段类型/权限识别错误 | [字段证据优先级](field-button-screenshot.md#字段类型与证据优先级) | `src/workflow-order.mjs`、`stage-field-differences.mjs`、测试 | 已真实验证/部分实现 |
| KC-08 | 成员范围、组织、党委、审批人 | 成员候选范围无法确认 | [人员来源](cross-flow-identity.md#成员选择与组织范围) | `debug-runtime.mjs`、`raw/debug-runs.json`、Z0095 特殊字段分析 | 部分实现 |
| KC-09 | 按钮、终止、动作 ID、目标节点 | 按钮遗漏、拼接、错误去重 | [按钮与分支](field-button-screenshot.md#按钮与分支映射) | `src/node-button-map.mjs`、`v13-document.test.mjs` | 已真实验证 |
| KC-10 | 多路径、退回、重提、批件制作中、完成 | 多路径与完成状态判断错误 | [多路径与完成状态](debug-playbook.md#多路径与完成状态) | `reports/path-coverage.json`、Z0095 运行记录 | 部分实现 |
| KC-11 | 恢复、中断、模型切换、旧实例 | Debug 中断后错误重启 | [中断恢复](debug-playbook.md#中断恢复) | `src/debug-progress.mjs`、`debug-session ... adopt/observe` | 部分实现 |
| KC-12 | 截图、长图、iframe、遮挡、重复 | 截图不能证明业务内容 | [截图质量](field-button-screenshot.md#截图质量) | `full-form-capture.mjs`、`screenshot-quality.mjs`、screenshot-index.json | 已真实验证 |
| KC-13 | Word、EBUSY、pending、覆盖 | Word 占用导致替换失败 | [Word 原子更新](document-output.md#word-占用与原子替换) | `src/output-management.mjs`、V1.2 稳定性测试 | 已真实验证 |
| KC-14 | 输出目录、_verification、对比目录 | 正式成果散落无法识别 | [目录隔离](document-output.md#输出目录与隔离) | `src/output-management.mjs`、`v12-output-smoke.mjs` | 已真实验证 |
| KC-15 | 单 Word、章节、节点顺序、重复字段 | 文档结构和质量问题 | [单文档交付](document-output.md#单文档交付) | `config/requirements-custom.json`、`v13-document.test.mjs`、V1.3 验收 | 已真实验证 |
| KC-16 | 字段合并、分组、多字段单元格、顿号拆分 | 多个独立字段被合并到同一行 | [字段原子化](document-output.md#字段原子化) | `src/field-atomic.mjs`、`tests/v13-document.test.mjs`、V1.3.1 验收 | 已真实验证 |
