# DeepSeek Harness Desktop

中文 | [English](README.en.md)

DeepSeek Harness 的 Windows 桌面壳。Shell 与 DSH runtime 独立版本化：安装器只安装 Electron Shell；首次启动时，Shell 根据上游 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh-v*` tag 安装兼容的预构建 runtime。

## 下载

从 [Latest Release](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest) 下载 Windows x64 安装器或 portable 版本。首次启动会自动安装最新兼容的 DSH runtime。

## 版本模型

- **Shell version** 表示窗口、下载器、版本管理和 runtime 协议版本，例如 `0.1.0`。
- **DSH version** 对应一个上游 Git tag，例如 `0.1.0-rc.7` 对应 `dsh-v0.1.0-rc.7`。
- **Runtime revision** 表示同一上游 DSH tag 的不可变桌面构建修订；旧 manifest 缺省为 revision `0`，后续重构建必须递增。
- Shell 声明最低 DSH 版本；每个 runtime manifest 声明 `requiredShellRange`、`runtimeProtocolVersion` 和 `runtimeRevision`。
- 默认策略是 `latest-compatible`：仅在已有预构建产物且兼容当前 Shell 的版本中选择最高版本。
- 用户可以在 **Runtime → 管理 DSH 版本** 中明确选择“自动选择”或“固定版本”。固定后不会自动切换到更高版本，直到恢复自动策略；列表只显示 DSH 版本号，并标记当前使用的版本。

上游刚发布 tag、桌面 runtime 尚未构建时，该版本不会进入 catalog，因此不会破坏现有安装。Shell 和 DSH 的 Release 通道互不覆盖：`shell-v*` 发布 Shell，`runtime-dsh-v*-desktop.<revision>` 发布不可变 runtime，`runtime-catalog` 提供机器可读目录。

## 安装与更新

正常打开应用时，Shell 本地启动页只显示状态环和目录检查、Runtime 下载或启动状态，不提供版本选择。首次安装、自动升级或从版本管理器切换 DSH 时，目标版本的下载进度固定显示在启动页底部；版本选择只在 **Runtime → 管理 DSH 版本** 窗口中出现。系统启用减少动态效果时会自动停用动画。第一次启动需要网络。Shell 下载 `runtime-catalog.json`，选择版本，下载 Windows x64 runtime ZIP，并同时验证声明大小和 SHA-256。ZIP 先解压到 staging 目录；Node、pnpm 和 DSH 入口全部存在且 Web readiness 成功后，Shell 才更新当前版本。下载、校验或启动失败时，旧 runtime 保持可用。

Runtime 默认位于：

```text
%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\<dsh-version>
```

用户 profile、会话、设置和插件仍位于 `%USERPROFILE%\.dsh`，或由 `DSH_HOME` 覆盖。切换 DSH runtime、更新 Shell 或重新安装都不会删除该目录。

## 文本与文件粘贴

Shell 为 DSH 对话输入框补充原生文本/文件粘贴体验。超过 500 字符的纯文本和可读取的文本文件会先显示为待发送附件，可预览、移除或展开；提交时再写入消息。2 MB 以内的文本文件以内联上下文发送，较大的文本文件只发送用户所选文件的绝对路径和分段读取指令；单次最多处理 32 个文本文件，内联文本上限为 8 MB。图片、音视频、压缩包、PDF、Office 文件及其他二进制内容继续交给 DSH Web 自身处理。Web 页面右键菜单提供受 Electron edit flags 控制的撤销、重做、剪切、复制、粘贴、删除和全选。

## Agent 个性化

通过 **文件 → 个性化设置...** 打开全局 Agent 个性化编辑器。编辑器直接管理 `$DSH_HOME/AGENTS.md`（默认是 `%USERPROFILE%\.dsh\AGENTS.md`），支持从推荐模板开始、重新加载、UTF-8 字节计数和快捷保存。空白内容保存为移除该文件；写入前会校验已观察到的 revision，并通过同目录临时文件原子替换；检测到已发生的外部修改时会拒绝保存并要求重新加载。

这份文档是用户级偏好，不会修改 Agent 预设，也不能增加预设未提供的工具或权限。装配了 `@deepseek-ai/dsh-agent-instructions` 的预设会在后续新会话中加载它，并继续遵从预设的角色、工具、能力和安全边界；项目目录中的 `AGENTS.md` 可以提供更具体的项目规则。个性化文档会进入模型上下文，不应存放 API Key、Token、密码或其他凭据。

## 桌面宠物设置

默认桌宠是在 Electron 透明桌面窗口内播放的原创二次元精灵角色，使用本地透明 PNG 为待机、思考、说话、审批、成功、错误、不可用和拖动提供独立逐帧动作；资源缺失、尺寸不符或解码失败时自动回退原创程序化 Canvas 机器人。桌宠不加载网络资源或打开 Web 页面。Windows 启用“减少动态效果”时，各状态停在对应代表帧。

通过 **文件 → 桌宠设置 → 小 / 标准 / 大** 调整角色大小。三个档位分别使用 72、96 和 128 CSS 像素，Canvas 始终保留 192×192 backing；切换时同步更新透明窗口、原生点击 shape、气泡锚点和拖动边界，并把选择保存到应用 `userData` 下的 `desktop-pet.json`。标准档保持原有 96 像素视觉大小。左键单击角色会打开主窗口，右键菜单可打开主窗口、调整大小或隐藏桌宠。回复流式输出时显示气泡，输出结束后停留 5 秒自动关闭；审批气泡在请求解决前持续显示。

旧的本地静态图片和动态 GIF 皮肤入口、解码器及 renderer 数据 URL 通道已移除；升级后 Shell 会清理遗留的 `desktop-pet-skin.png`、`desktop-pet-skin.gif` 及对应 `.tmp` 中间文件。

## 插件

通过 **Runtime → 管理插件** 打开桌面插件管理器。管理器会列出当前 Web profile 中已安装的插件，并支持安装和移除。安装时请输入受控的 npm package spec，或 GitHub HTTPS / `github:` spec；例如 `@scope/plugin@1.2.3`、`https://github.com/owner/repo.git` 或 `github:owner/repo`。管理器会优先从 pnpm 列表读取已安装版本；列表缺失版本时，再从受控的已安装包清单回退读取。registry 插件只在后台确认存在兼容新版本时显示“更新至”按钮；GitHub、git、link、file 和 workspace 来源提供通用“更新”按钮，不依赖 registry outdated 结果。网络失败或无法确认最新 registry 版本不会影响这些手动更新入口。管理器会显示每项操作的进度和日志。

安装、更新或移除前，Shell 会先停止 Runtime，避免 Web/HMR 在 `node_modules` 变更过程中加载不完整文件。操作成功后 Runtime 自动重启；操作失败时 Shell 也会恢复 Runtime。关闭并重新打开插件管理器不会丢失正在执行的操作或待完成的 Runtime 重启，窗口会继续显示同一操作的进度和日志。若插件加载失败导致 Web 无法就绪，由 Shell 独立提供的插件管理器仍保持可用，可移除或更新有问题的插件并再次重启 Runtime。

若旧 Web profile 由不同 pnpm `virtual-store-dir-max-length` 创建，管理器会在精确识别该兼容性错误后移除可再生的 `.modules.yaml`，并自动重试原操作一次；profile manifest、lockfile、插件配置和其他用户数据不会被删除。

若旧的 `%USERPROFILE%\.dsh` patch 仍引用已经删除的本地插件文件，启动页会提供 **禁用失效本地插件并重试**。确认后，Shell 只备份并移除与启动错误精确匹配的 loader 条目，不会清除会话、设置、凭据、其他插件或整个 profile。

若 `dsh-multi-model-orchestrator` 因已管理预设与当前插件包冲突而拒绝启动，启动页会提供独立的确认操作。Shell 只在 loader、插件、目标和冲突原因全部精确匹配时启用该操作；确认后会先将整个 `multi-model-orchestrator` 预设目录移动到同级 `desktop-backup` 备份，再通过已安装插件的安装器执行固定的 `--force --target` 重置。重置或校验失败时会自动恢复原目录。

Shell 在用户数据目录生成稳定的 `dsh.cmd`，将当前 runtime 中的标准 Node 和 pnpm 放到 `PATH`。作为高级回退，也可以通过 **Runtime → 打开插件管理终端** 使用原有命令：

```powershell
dsh plugin --profile web list
dsh plugin --profile web add <package-spec>
dsh plugin --profile web update <package-spec>
dsh plugin --profile web remove <package-name>
```

Git 来源的插件需要系统 `PATH` 中存在 Git。npm、本地目录和 tarball spec 不要求全局 Node 或 pnpm。

## MCP 管理

通过 **Runtime → 管理 MCP** 打开桌面 MCP 管理器。管理器按真实 Cordis Patch 顺序扫描当前 Web profile 声明的 Bundle、Profile Patch、`$DSH_HOME/cordis.patch.yml` 与桌面 Runtime overlay，识别官方 `@deepseek-ai/dsh-mcp-client` 单 Server 配置和 `dsh-mcp-lens` 多 Server 聚合配置；同时只读扫描 `%USERPROFILE%\.codex\config.toml` 中的本机 MCP。列表支持搜索、DSH 接入状态筛选和配置详情；环境变量与 HTTP Header 仅显示键名，URL 用户信息、查询参数及疑似密钥参数不会发送到渲染进程。

启用或禁用需要稳定的 Cordis entry `id`。Shell 只在拥有该条目最高控制权的 Profile 或 Home 用户 Patch 中写入 `disabled` 覆盖，不修改已安装插件包或 MCP Server 文件；写入前校验所有有效层的配置 revision，并使用同目录临时文件原子替换。Codex MCP 的开关表示是否接入 DSH：接入时将该 Server 的执行或连接配置写入 DSH Profile Patch，之后只切换 DSH Entry；Codex `config.toml` 始终保持原样。若更高优先级的桌面 Runtime overlay 锁定状态，条目仍可查看但不能从低优先级层切换；动态 `!!js` 状态会明确显示为“动态”。切换期间 Runtime 会停止并自动恢复，失败时也会尝试恢复。MCP Lens 由一个 Cordis entry 承载，其开关会同时控制该 Lens 条目下显示的全部 Server。

## Runtime 产物

`.github/workflows/runtime-release.yml` 每天检查上游最新 `dsh-v*` tag，也支持手动指定 tag、正整数 `runtime_revision` 和 Shell 兼容范围。工作流验证 tag 与 CLI 版本，安装 DeepSeek 官方发布的精确 `@deepseek-ai/dsh` 版本，加入经过校验的官方 Node 24 和独立 pnpm，运行真实 Web、配置打开、会话修复、插件及关闭冒烟，再发布 ZIP、manifest 和更新后的 catalog。同一 DSH 版本只允许以更高 revision 更新 catalog；release tag 和资产不会被覆盖。

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
  -RuntimeRevision 1 `
  -RequiredShellRange '>=0.1.0 <1.0.0'
```

## Windows 代码签名

公开分发应从受 Windows 信任的 CA 获取 Authenticode 代码签名证书。自签名证书只适合已部署根证书的内部环境，不能消除普通用户看到的“未知发布者”或 SmartScreen 提示。

对于可导出的 PKCS#12/PFX 证书，在 GitHub 仓库 **Settings → Secrets and variables → Actions** 中创建两个 Repository secrets：

- `CSC_LINK`：PFX 文件的 Base64 内容。可在 PowerShell 中运行 `[Convert]::ToBase64String([IO.File]::ReadAllBytes('certificate.pfx')) | Set-Clipboard` 生成；不得把 PFX 或 Base64 内容提交到仓库。
- `CSC_KEY_PASSWORD`：导出 PFX 时设置的密码。

只有 `shell-v*` tag 构建会接收这两个 secret。工作流使用 electron-builder 对主程序、NSIS 安装器、卸载器和 portable EXE 签名；提供 `CSC_LINK` 后还会检查两个发布 EXE 的 Authenticode 状态必须为 `Valid`。增加 `package.json` 版本并推送匹配的 `shell-v<version>` tag 即可发布新的签名版本。

多数新签发的公开证书要求硬件或云端保护私钥，不能导出 PFX。此时不要把硬件 token 密钥复制到 GitHub；应按 CA 选择 Azure Artifact Signing、DigiCert KeyLocker、SignPath 等远程签名服务，并把 provider action 接入 tag 构建。

本地 `dist` 在没有证书时保持未签名，Windows SmartScreen 可能显示信誉提示。即使使用受信任证书，SmartScreen 信誉仍可能需要随下载量和时间建立。

## 当前范围

- 仅支持 Windows x64。
- 默认最低 DSH 版本是 `0.1.0-rc.7`。
- runtime Release 始终标记为 GitHub prerelease，以免干扰 electron-updater 使用的 Shell latest Release。
- Shell 通过临时 loopback origin 打开 DSH Web；Host 与插件始终在下载的标准 Node runtime 中运行。
