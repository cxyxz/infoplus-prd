# InfoPlus PRD Windows 分发方案

这套目录给出一个与 Magpie 类似的分发模型：Codex 插件承载技能，独立 Windows 安装器把采集运行时放到用户目录，并用版本化目录和稳定入口完成更新与回滚。

## 组成

- `plugin/`：Codex 插件包，含 `plugin.json`、`.codex-plugin/plugin.json` 和 `skills/infoplus-prd/`。
- `.agents/plugins/marketplace.json`：仓库市场清单，发布时复制到发布仓库根目录的 `.agents/plugins/`。
- `scripts/release.ps1`：从当前项目生成版本化 runtime ZIP 与 plugin ZIP。
- `scripts/install.ps1`：安装 runtime，执行 `npm ci`，优先建立 `current` 符号链接；无管理员权限时写入 `current.path`。
- `scripts/update.ps1`：支持 `version.json` 或 GitHub latest 自动发现版本，原子切换稳定入口；失败时切回旧版本。
- `scripts/check.ps1`：检查安装清单、runtime 版本和 CLI 入口。
- `scripts/uninstall.ps1`：只卸载 runtime；默认保留 `versions/`、`data/` 和 `chrome-profile/`，避免误删数据。

## 发布一次版本

1. 更新根目录 `package.json` 的 `version`，运行 `npm test`。
2. 在 `packaging/plugin/plugin.json` 和 `packaging/plugin/.codex-plugin/plugin.json` 同步版本。
3. 发布：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\packaging\scripts\release.ps1
```

产物在 `packaging/dist/`：

- `infoplus-prd-runtime-<版本>.zip`
- `infoplus-prd-plugin-<版本>.zip`
- `release.json`

把 runtime ZIP 上传到 GitHub Release；把 `packaging/.agents/plugins/marketplace.json` 和 `packaging/plugin/` 放入一个 Git 仓库，供 Codex Marketplace 安装。

建议 GitHub Release 的 tag 使用 `v<版本>`，例如 `v1.3.1`；资产名保持 `infoplus-prd-runtime-<版本>.zip`，这样 `-GitHubRepo OWNER/REPO` 才能直接找到最新资产。

## 使用者安装

使用者只需 Windows + Node.js 22+ + Git + Codex。

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "& ([scriptblock]::Create((irm 'https://raw.githubusercontent.com/OWNER/REPO/main/packaging/scripts/install.ps1'))) -PackageUrl 'https://github.com/OWNER/REPO/releases/download/v1.3.1/infoplus-prd-runtime-1.3.1.zip'"
```

若已把脚本下载到本地：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 `
  -PackageUrl https://github.com/OWNER/REPO/releases/download/v1.3.1/infoplus-prd-runtime-1.3.1.zip
```

安装后：

```text
%LOCALAPPDATA%\InfoPlusPRD\
  current -> versions\1.3.1
  current.path
  versions\1.3.1\
  install.json
  data\
```

持久化数据默认不放在版本目录，避免更新后丢失；插件会写入 `INFOPLUS_PRD_DATA` 指定的位置，默认 `%LOCALAPPDATA%\InfoPlusPRD\data`。专用 Chrome 登录目录默认 `%LOCALAPPDATA%\InfoPlusPRD\chrome-profile`。更新只切换稳定入口，不覆盖这些数据。Windows 禁止普通用户创建符号链接时，安装器改用 `current.path`，所有版本命令都通过 `install.json` 解析实际路径。

## 使用者更新

把 `packaging/version.example.json` 改为实际的 `version.json`，放到静态托管或仓库 raw 地址。然后使用者执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\update.ps1 `
  -VersionUrl https://raw.githubusercontent.com/OWNER/REPO/main/packaging/version.json
```

也可以直接从 GitHub Releases 找最新资产：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\update.ps1 -GitHubRepo OWNER/REPO
```

只检查不更新：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\update.ps1 -GitHubRepo OWNER/REPO -Check
```

也可在 Codex 中说“更新 InfoPlus PRD 到 1.4.0”，由 onboarding skill 引导执行相同命令。

## 接入 Codex Marketplace

发布仓库根目录包含：

```text
.agents/plugins/marketplace.json
packaging/plugin/...
```

若要把插件放到 `plugins/infoplus-prd/`，同时把市场清单里的 `source.path` 改为 `./plugins/infoplus-prd`。使用者执行：

```powershell
codex plugin marketplace add OWNER/REPO
codex plugin add infoplus-prd@REPO
```

更新插件清单：

```powershell
codex plugin marketplace upgrade REPO
```

首次使用插件内置 hook 时，需要在 `/hooks` 中审查并信任。仓库市场清单属本地市场，Codex 依据市场快照刷新插件；runtime 的版本更新由 `update.ps1` 单独负责。

## 与 Magpie 的差别

Magpie 是常驻桌面应用，自带托盘、更新频道和签名校验。此方案是 Windows 命令行安装器 + Codex 插件：

- 不做常驻进程，避免后台服务。
- 保持 PowerShell 脚本透明可审计。
- 使用 GitHub Release 作为版本源。
- 使用符号链接（不可用时用路径指针）切换版本，失败自动回滚。
- 若后续需要 GUI，可再包一层 WinForms/WPF 更新器，脚本不用重写。

## 上线前必须替换

- `plugin.json` 和 `.codex-plugin/plugin.json` 中的 `REPLACE_OWNER/REPLACE_REPO`。
- 文档与命令示例中的 `OWNER/REPO`。
- 如为公开仓库，按许可情况修改 `license`，或补齐 `LICENSE` 文件。
- 发布新版本时同步更新 GitHub Release 资产和 `version.json`；两者版本必须一致。
