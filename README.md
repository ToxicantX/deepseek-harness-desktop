# DeepSeek Harness Desktop

[中文](README.md) | [English](README.en.md)

[![最新版本](https://img.shields.io/github/v/release/ToxicantX/deepseek-harness-desktop?label=Release)](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest)
[![下载量](https://img.shields.io/github/downloads/ToxicantX/deepseek-harness-desktop/total)](https://github.com/ToxicantX/deepseek-harness-desktop/releases)
[![License](https://img.shields.io/github/license/ToxicantX/deepseek-harness-desktop)](LICENSE)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Windows 桌面客户端，用于与 AI Agent 对话、处理项目任务。应用自动安装所需运行环境，并提供插件管理、用量查看、桌面宠物和后院鱼塘。

**目前仅支持 Windows x64，普通使用无需安装 Node.js、pnpm 或 Git。**

![DeepSeek Harness Desktop 主界面](docs/images/desktop-overview.png)

## 下载与开始使用

1. 前往 [下载页面](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest)，选择 Windows x64 安装器，或名称含 `Portable` 的便携版。
2. 启动应用，等待自动下载并安装 DSH Runtime。首次启动需要联网并能够访问 GitHub。
3. 在 **文件 → 设置** 中配置模型提供商、API 地址和密钥，选择要使用的模型。
4. 选择或创建工作区，开始新会话。

后续启动会复用已安装的运行环境。下载或启动失败时，可根据启动页的诊断提示重试或恢复。

## 常用入口

| 想做什么 | 在哪里 |
| --- | --- |
| 配置模型和提供商 | **文件 → 设置** |
| 设置 Agent 的语言、输出风格等偏好 | **文件 → 个性化设置...** |
| 安装或更新插件、接入 MCP、管理 Skill | **Runtime → 管理插件 / 管理 MCP / 管理 Skill** |
| 更换 DSH 版本 | **Runtime → 管理 DSH 版本** |
| 查看请求数、Token 用量和趋势 | **帮助 → 用量监控**，仅统计会话已记录的用量，不显示余额或费用 |
| 切换主题、显示或隐藏桌宠 | **视图 → 主题 / 桌面宠物** |
| 打开后院鱼塘 | 主界面的“后院鱼塘”悬浮入口，可投喂、命名锦鲤并随时返回对话 |

长文本和文本文件可直接粘贴到对话输入框，发送前可以预览或移除。个性化设置会进入模型上下文，请勿填写密钥、Token 或密码。

### 可选插件

在 **Runtime → 管理插件** 中粘贴下列仓库地址即可安装，完成后到设置页配置。安装 GitHub 来源的插件需要系统已安装 Git。

| 插件 | 用途 |
| --- | --- |
| [dsh-channel-telegram](https://github.com/ToxicantX/dsh-channel-telegram) | 通过 Telegram、QQ 官方机器人或微信 iLink 私聊使用 DSH |
| [dsh-multi-model-orchestrator](https://github.com/ToxicantX/dsh-multi-model-orchestrator) | 配置多个专家 Agent，由主 Agent 分配任务 |

## 更新与数据备份

- **更新桌面客户端**：文件 → 检查更新。
- **更新 DSH Runtime**：Runtime → 管理 DSH 版本。默认自动选择最新兼容版本，也可固定版本；上游新版本需等待对应桌面运行包可用。
- **备份数据**：文件 → 打开 DSH 数据目录。完全退出应用后备份该目录，默认是 `%USERPROFILE%\.dsh`；设置过 `DSH_HOME` 时以实际目录为准。

更新客户端或切换 Runtime 不会主动删除会话、设置和插件。托盘菜单中的“退出”可完全关闭应用。

## 常见问题

**首次启动一直停在下载页？** 确认网络能访问 GitHub，按启动页提示重试。已有可用 Runtime 会被保留。

**安装插件后无法启动？** 从启动页或 **Runtime → 管理插件** 更新、禁用或移除问题插件。被自动隔离的插件可在更新后选择“重新启用并验证”。请勿直接删除整个数据目录。

**旧会话打不开？** 使用 **帮助 → 修复历史会话**，先诊断并核对备份位置，再确认修复。

**Windows 提示“未知发布者”或 SmartScreen 警告？** 请核对下载来源和文件签名，仅从本仓库发布页下载。部分构建可能未签名，具体以 Windows 显示的签名状态为准。

其他问题请提交 [Issue](https://github.com/ToxicantX/deepseek-harness-desktop/issues)，附上 **帮助 → 关于 DeepSeek Harness** 中的版本、复现步骤和脱敏后的错误信息。

## 版本与更新说明

### 0.1.61 · 2026-10-18 18:27（北京时间）

- 桌面壳通过运行时加载适配，让 Grok 改用宿主已有的原生工具呈现路径，不修改已安装 DSH 核心源文件，也不再要求模型通过 run_code 编写 TypeScript 调用工具；按每个主会话或子代理当前实际模型独立选择，其他模型保留原有模式。
- 工具声明、系统提示和执行准入共用同一原生路径，保留原有权限和工具可见范围；不静默裁剪 MCP 工具或回退 PTC，工具数量超过已知接口限制时输出诊断。
- 撤回会改写模板字符串内容的全局 import/export 自动转换与 require 注入，移除上一版仅靠提示词约束 Grok 的方案；保留原有工具兼容功能，并增加 PTC 模块不改写的边界回归测试。
- 原生模式、父子代理隔离和模型切换已有 focused 测试覆盖；已在 0.2.1-rc.2 独立进程中验证 xapi/grok-4.7 从 initial PTC 自动切为 native，实测范围为 25 个基础工具，read 和 pwsh 两次真实调用状态均为 completed。完整 MCP 工具集尚未实测；安装此版本并重新启动后端后生效，不会自动替换当前正在运行的安装版。

### 2026-10-17 12:28（北京时间）

- 精简使用指南，集中展示下载、首次配置、常用入口、更新和排障信息，同步英文版。

### 近期更新

- **0.1.61**：修复 Grok 主会话与子智能体的原生工具调用适配，其他模型保持原有模式。
- **0.1.60**：修复打开工作区目录后按钮无法再次点击的问题。
- 支持自定义图片生成协议、图片放大预览和音视频播放；生成能力取决于所配置的提供商与模型。
- 子智能体对话页显示模型信息；优化鱼塘背景和任务状态显示。

完整版本记录见 [Releases](https://github.com/ToxicantX/deepseek-harness-desktop/releases)。

## 代码签名政策

SignPath Foundation 批准并启用集成后，符合条件的桌面客户端发布将使用 [SignPath.io](https://about.signpath.io) 提供的免费代码签名，证书由 [SignPath Foundation](https://signpath.org) 持有。详见[完整代码签名政策](docs/code-signing-policy.md)。
