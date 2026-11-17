# 问题处理知识库

每条记录使用统一结构。验证状态以证据为准；没有代码或测试支撑的方案只标为建议。流程专属编号、人员和实例只留在受控证据中。

## Chrome CDP 与页面读取

- **问题现象**：页面读取超时、元素找不到、标签切换后页面丢失、iframe 内表单为空、连接正常但无法点击。
- **如何识别**：分别检查 `chromeEndpoint()`、`attachChrome()`、`context.pages()`、页面 URL、iframe、`#form_holder`、当前步骤和 `permission.executable`。连接成功只证明 CDP 可用。
- **已确认原因**：专用 Chrome 未启动；连接了日常 Chrome；旧标签失效；页面仍在重载；表单位于 iframe；固定视口只截到平台外壳；后台实例没有写入权限。
- **推荐步骤**：运行 `start-infoplus-chrome.ps1 -Check` → 使用 `INFOPLUS_CDP=http://127.0.0.1:9222/` → 按同源和版本重新定位标签 → 等重载完成 → 进入 iframe → 定位 `#form_holder` → 只读核对当前步骤和权限。
- **自动恢复**：启动时检查命令有超时重试一次；页面读取按“重载/标签/iframe”分层重试，不重复发起业务动作。
- **停止条件**：专用资料目录不匹配、版本不一致、权限不足、目标页面不存在；不能靠重新启动浏览器绕过。
- **替代方案**：保留同版本 HAR、XSN、截图和运行日志，走前台只读或离线生成；无法操作的部分标缺口。
- **证据**：`raw/debug-probe.json`、浏览器检查报告、`screenshot-index.json`、失败步骤 ID。
- **代码/测试**：`src/live-options.mjs`、`src/full-form-capture.mjs`、`scripts/v12-stability-browser-check.mjs`。
- **验证状态**：CDP 固定端口、完整表单定位和只读浏览器检查已真实验证；自动标签恢复仅部分实现。

## Debug 模式误判

- **现象**：普通委托页、前台申请页或带 `release=false` 的 URL 被当成 Debug；未确认身份即操作。
- **识别**：交叉核对 IDE 目标版本 Debug 入口、Instances → DEBUG 中业务流水号、页面“正在调试模式”、实例 ID/定义 ID/版本、当前模拟身份与待办角色。
- **原因**：IDE Debug 链接可能先打开委托中转页；URL 参数只是辅助线索；委托身份与当前办理人可能不同。
- **处理**：提交前调用 `verifyDebugInstance` 和 `requireDebugPage`；身份切换后重新读取节点、身份和 actions；证据不齐停止动作。
- **停止条件**：实例属于其他流程/版本、页面无 Debug 标记、定义 ID 不匹配、身份与待办不符。
- **替代**：保留前台只读、XSN 和 Workflow 配置证据，不标为 Debug 实测。
- **证据**：`raw/debug-runs.json` 的 `modeEvidence`、`raw/debug-probe.json`。
- **代码/测试**：`src/debug-verification.mjs`、`src/debug-session.mjs`、`tests/debug-probe.test.mjs`。
- **验证状态**：Z0095/Z1775 同实例多节点交叉核验已真实验证；自动跨节点换身份尚未在其他流程完整验证。

## 环境回调与授权边界

- **现象**：Debug 与外部事件共用回调；曾因此提前停止全部测试。
- **识别**：`raw/debug-probe.json` 的 `boundary.sharedEndpoints`；用户是否明确授权该流程及版本。
- **原因**：测试与正式环境可能使用同一事件地址，但共享本身不能证明具体动作不可逆。
- **处理**：在用户明确授权的旧平台范围内执行常规 Debug，记录可能的通知和事件；只对具体未授权、不可逆的外部系统写入停止该动作，并继续其他可采集节点。
- **停止条件**：动作会修改正式配置、部署、删除真实业务数据、批量通知，或授权范围只覆盖读操作。
- **替代**：静态 Workflow/XSN、前台只读、已有实例证据继续生成；不扩大授权到其他流程。
- **代码/测试**：`config/debug-policy.json`、`src/debug-policy.mjs`、`tests/debug-policy.test.mjs`。
- **验证状态**：已有授权下继续常规 Debug 已真实验证；不可逆外部写入的实际拦截需按流程判断。

## 业务响应与流转状态

- **现象**：HTTP 200 但业务失败；22001、护照查询失败、批件制作中、回调超时；提交后页面未跳转。
- **识别**：分别记录 HTTP 状态、`doAction.errno/error`、`listNextStepsUsers.nextTasks`、当前实例和待办变化。
- **原因**：HTTP 层成功不代表业务层成功；业务码需结合接口和消息；CLI 超时可能与业务成功同时发生；外部服务等待不是流程结束。
- **处理**：`submissionOutcome` 区分 accepted、validation、external-service、unknown；结果未知先核验实例和待办，再决定是否重试。只有实际后续待办或可核对流转标为已验证。
- **停止条件**：同一错误指纹连续出现、业务码非零且未变化、待办未变化、外部服务持续制作中。
- **证据**：响应脱敏记录、`debug-runs.json`、`flow-progress.json`、`reports/path-coverage.json`。
- **代码/测试**：`src/dialog-classification.mjs`、`tests/v12-stability.test.mjs`、`src/path-coverage.mjs`。
- **验证状态**：分类和状态判定已自动化测试；外部服务根因仍待业务日志。

## 表单校验与动态必填

- **现象**：请选择一个选项、内容完整及格式正确、至少需要填写一个、联系方式格式错误、联动后新增必填。
- **识别**：扫描 DOM 控件 `validate[...]`、`.formError`、radio checked、select 值、附件状态；不能只信 `entity.fields.required`。
- **原因**：模板必填不等于运行时必填；提交会暴露条件字段；旧红字不会自动清除；弹窗分类曾把校验误当普通确认。
- **处理**：先保存校验证据 → 关闭提示（仅表示已读）→ 定位未满足控件 → 填合规 DEBUG 测试值 → 重新扫描 → 再提交。错误指纹变化后继续，连续两次相同转针对性排查。
- **停止条件**：无安全测试值、需要真实法律效力材料、权限不足、重复错误已确认阻断。
- **替代**：保留校验截图和字段诊断，继续其他节点或静态分析。
- **证据**：`round-*-pre-scan/repair/post-scan.json`、`debug-evidence-v12/step7-apply/`。
- **代码/测试**：`src/form-autofill.mjs`、`scripts/v12-repair-and-submit.mjs`、`tests/v12-stability.test.mjs`。
- **验证状态**：Z1775 申请人填写和出访报告节点已真实验证；所有流程的自动修复仍属部分实现。

## 其他高频症状

| 症状 | 首选处理 | 停止条件 | 状态 |
|---|---|---|---|
| 节点进不去 | 查真实待办 → 当前模拟身份 → Debug 证据 → Workflow 进入条件；不因一次未跳转就判失败 | 权限不足且无合适身份、节点未部署 | 部分实现 |
| 未知弹窗 | 按七类分类；未知/删除/部署不自动确认 | 无法识别后果 | 已真实验证 |
| 成员候选不足 | 区分搜索分页与权限白名单；记录 settings 过滤、组织关系和实测范围 | 无法确认跨组织范围时标待确认 | 部分实现 |
| 批件一直制作中 | 刷新一次并记录响应，保留实例；不循环刷新、不冒充结束 | 外部服务持续无结果 | 已真实验证 |
| 知识库未命中 | 搜 `issue-index.md` → 检查同类代码/测试 → 有限可恢复尝试 → 保存失败原因 | 需要大规模改造则进 backlog | 已真实验证 |
