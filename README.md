# DeepSeek Harness Desktop

中文 | [English](README.en.md)

DeepSeek Harness 的 Windows 桌面壳。Shell 与 DSH runtime 独立版本化：安装器只安装 Electron Shell；首次启动时，Shell 根据上游 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-v*` tag 安装兼容的预构建 runtime。

## 下载

从 [Latest Release](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest) 下载 Windows x64 安装器或 portable 版本。首次启动会自动安装最新兼容的 DSH runtime。

## 版本模型

- **Shell version** 表示窗口、下载器、版本管理和 runtime 协议版本，例如 `0.1.0`。
- **DSH version** 对应一个上游 Git tag，例如 `0.1.0-rc.7` 对应 `dsh-v0.1.0-rc.7`。
- Shell 声明最低 DSH 版本；每个 runtime manifest 声明 `requiredShellRange` 和 `runtimeProtocolVersion`。
- 默认策略是 `latest-compatible`：仅在已有预构建产物且兼容当前 Shell 的版本中选择最高版本。
- 用户可以在 **Runtime → 管理 DSH 版本** 中固定具体版本。固定后不会自动切换到更高版本，直到恢复自动策略。

上游刚发布 tag、桌面 runtime 尚未构建时，该版本不会进入 catalog，因此不会破坏现有安装。Shell 和 DSH 的 Release 通道互不覆盖：`shell-v*` 发布 Shell，`runtime-dsh-v*` 发布 runtime，`runtime-catalog` 提供机器可读目录。

## 安装与更新

第一次启动需要网络。Shell 下载 `runtime-catalog.json`，选择版本，下载 Windows x64 runtime ZIP，并同时验证声明大小和 SHA-256。ZIP 先解压到 staging 目录；Node、pnpm 和 DSH 入口全部存在且 Web readiness 成功后，Shell 才更新当前版本。下载、校验或启动失败时，旧 runtime 保持可用。

Runtime 默认位于：

```text
%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\<dsh-version>
```

用户 profile、会话、设置和插件仍位于 `%USERPROFILE%\.dsh`，或由 `DSH_HOME` 覆盖。切换 DSH runtime、更新 Shell 或重新安装都不会删除该目录。

## 插件

Shell 在用户数据目录生成稳定的 `dsh.cmd`，将当前 runtime 中的标准 Node 和 pnpm 放到 `PATH`。通过 **Runtime → 打开插件管理终端** 使用原有命令：

```powershell
dsh plugin --profile web list
dsh plugin --profile web add <package-spec>
dsh plugin --profile web update <package-spec>
dsh plugin --profile web remove <package-name>
```

Git 来源的插件需要系统 `PATH` 中存在 Git。npm、本地目录和 tarball spec 不要求全局 Node 或 pnpm。

## Runtime 产物

`.github/workflows/runtime-release.yml` 每天检查上游最新 `dsh-v*` tag，也支持手动指定 tag 和 Shell 兼容范围。工作流验证 tag 与 CLI 版本，安装 DeepSeek 官方发布的精确 `@deepseek-ai/dsh` 版本，加入经过校验的官方 Node 24 和独立 pnpm，运行真实 Web/插件/关闭冒烟，再发布 ZIP、manifest 和更新后的 catalog。

客户端不在用户机器上 clone 和构建完整上游仓库。这样仍以 Git tag 为版本真源，同时避免要求用户安装 Git、开发依赖和原生编译工具。

## 开发

需要 Windows x64、Node 24 和 pnpm 11：

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm run start
pnpm run dist
```

构建一个完整 runtime：

```powershell
./scripts/build-runtime.ps1 `
  -DshTag dsh-v0.1.0-rc.7 `
  -OutputDirectory "$PWD/runtime-output" `
  -RequiredShellRange '>=0.1.0 <1.0.0'
```

本地 `dist` 默认未签名，Windows SmartScreen 可能显示信誉提示。Shell Release 工作流在配置 `CSC_LINK` 和 `CSC_KEY_PASSWORD` 后执行签名。

## 当前范围

- 仅支持 Windows x64。
- 默认最低 DSH 版本是 `0.1.0-rc.7`。
- runtime Release 始终标记为 GitHub prerelease，以免干扰 electron-updater 使用的 Shell latest Release。
- Shell 通过临时 loopback origin 打开 DSH Web；Host 与插件始终在下载的标准 Node runtime 中运行。
