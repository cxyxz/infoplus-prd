# 能力状态矩阵

状态只按当前代码和证据标注，不为让文档看起来完整而虚构能力。

| 能力 | 状态 | 依据 | 边界 |
|---|---|---|---|
| 固定端口 9222 专用 Chrome 与只读连接 | 已真实验证 | `src/live-options.mjs`、`start-infoplus-chrome.ps1`、Z0095/Z1775 CDP 记录 | 需用户首次登录专用资料目录；不复用日常 Chrome Cookie |
| 页面超时后分层恢复、iframe 自动重定位 | 部分实现 | `chromeEndpoint()` 重试、`full-form-capture.mjs` | 标签/版本变化仍需按手册人工核对 |
| 静态 HAR/XSN/Views/Workflow/字段解析 | 已真实验证 | Z0095 18 个 XSN、HAR 接口、测试 | 其他格式依赖 `workflow-map.json` |
| Debug 模式五项交叉验证 | 已真实验证 | `debug-verification.mjs`、Z0095/Z1775 debug-runs | 自动启动后的新流程仍需按授权验证 |
| 后台 Debug 优先、前台回退 | 已真实验证 | `online-evidence.mjs`、debug-policy | 回退保留缺口，不能替代动态验证 |
| 常规 Debug 动作、身份切换、确认处理 | 部分实现 | Z0095/Z1775 多节点实例、`debug-session` | 尚未做到所有流程无人值守全路径 |
| 全页面必填扫描与普通校验修复 | 已真实验证 | `form-autofill.mjs`、Z1775 step7-apply、稳定性测试 | 新控件类型需补规则；错误两次后停止 |
| 七类弹窗分类和未知结果核验 | 已真实验证 | `dialog-classification.mjs`、69 项自动化回归 | 业务条件需按响应和待办判断 |
| 跨流程历史查询、业务编号与申请人匹配 | 已真实验证 | `linked-dashboard.mjs`、Z1775/Z0095 关联证据 | 多候选和变更同步规则仍需确认 |
| 成员候选组织范围完整判定 | 部分实现 | 白名单 settings 与组织分析、Z0095 特殊字段 | 搜索分页不等于权限；跨组织范围待验证 |
| 按钮完整发现、动作合并、Workflow 映射 | 已真实验证 | `node-button-map.mjs`、V1.3 测试和验收 | 同节点不同身份的条件差异需更多实例 |
| 多路径/退回/重提自动编排 | 部分实现 | path-coverage、Z0095 多实例记录 | 不能宣称全分支覆盖；互斥路径需独立实例 |
| 中断恢复与人工步骤 adopt | 已真实验证（实例级） | `debug-progress.mjs`、`debug-session adopt` | 多模型同时控制同一实例仍需手工协调 |
| 完整表单与业务按钮截图、A/B/C/D/E 门禁 | 已真实验证 | `full-form-capture.mjs`、`screenshot-quality.mjs`、99 张索引 | 条件前后成对截图未全部分支覆盖 |
| Word 原子替换与占用恢复 | 已真实验证 | `output-management.mjs`、输出管理测试 | 被占用时只保留 pending，需关闭后重跑 |
| 单 Word 固定九章、拓扑节点排序 | 已真实验证 | `v13-document.test.mjs`、V1.3 46 页渲染 | 新流程结构仍需按模板检查 |
| 字段原子化与六列字段表 | 已真实验证 | `src/field-atomic.mjs`、`v13-document.test.mjs`、V1.3.1 DOCX 表格检查 | 无真实 ID 的字段保留待解析标记 |
| 自动逐节点完整办理直至所有分支 | 待实现/待更多真实验证 | 现有调度器已运行部分节点 | 外部服务、权限和条件分支需按流程补充实测 |
