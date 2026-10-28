# DeepSeek Harness Desktop

[中文](README.md) | English

[![Latest release](https://img.shields.io/github/v/release/ToxicantX/deepseek-harness-desktop?label=Release)](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/ToxicantX/deepseek-harness-desktop/total)](https://github.com/ToxicantX/deepseek-harness-desktop/releases)
[![License](https://img.shields.io/github/license/ToxicantX/deepseek-harness-desktop)](LICENSE)

A Windows desktop client for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), for chatting with AI agents and working on projects. It installs the required runtime automatically and includes plugin management, usage statistics, a desktop pet, and a koi pond.

**Windows x64 only. Normal use requires no separate Node.js, pnpm, or Git installation.**

![DeepSeek Harness Desktop](docs/images/desktop-overview.png)

## Download And Get Started

1. Open the [download page](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest) and choose the Windows x64 installer or the build with `Portable` in its name.
2. Launch the app and wait for it to download and install DSH Runtime. First launch requires internet access to GitHub.
3. Open **File → Settings** to configure your model provider, API address, and key, then select a model.
4. Select or create a workspace and start a new conversation.

Later launches reuse the installed runtime. If a download or startup fails, follow the diagnostics on the startup page to retry or recover.

## Common Actions

| What you want to do | Where to find it |
| --- | --- |
| Configure models and providers | **File → Settings** |
| Set your preferred language and response style | **File → Personalization...** |
| Install or update plugins, connect MCP servers, manage skills | **Runtime → Manage Plugins / Manage MCP / Manage Skill** |
| Change the DSH version | **Runtime → Manage DSH versions** |
| Configure Exa, Perplexity, or automatic search routing | **Runtime → Search Settings**; enter your API key, then save and restart Runtime |
| View request counts, token usage, and trends | **Help → Usage Monitor**; counts usage recorded in sessions, without balances or costs |
| Change the theme or show or hide the pet | **View → Theme / Desktop Pet** |
| Open the koi pond | Use the floating koi pond entry in the main window to feed and name fish, then return to your conversation |

Paste long text and text files directly into the conversation composer, then preview or remove them before sending. Personalization text enters model context; do not put keys, tokens, or passwords in it.

### Optional Plugins

For the Telegram and orchestrator plugins, paste the repository URL into **Runtime → Manage Plugins**, then configure the plugin in Settings. Installing plugins from GitHub requires Git on your system.

| Plugin | Purpose |
| --- | --- |
| [dsh-channel-telegram](https://github.com/ToxicantX/dsh-channel-telegram) | Use DSH through Telegram, QQ official bot, or WeChat iLink private messages |
| [dsh-multi-model-orchestrator](https://github.com/ToxicantX/dsh-multi-model-orchestrator) | Configure specialist agents and let the main agent assign tasks |
| [dsh-ops](https://github.com/T-Auto/dsh-ops) | Optional native file, search, and PTC tools; use the dsh-ops install button in Manage Plugins |

The dedicated entry installs the verified stable release `0.4.4`, requiring DSH `>=0.2.0-rc.2 <0.2.2`. Pin a compatible version in **Runtime → Manage DSH versions** when using this plugin; `0.2.2`, including prereleases, is unsupported. After installation, create a new session to check tool availability.

## Updates And Backups

- **Update the desktop client**: File → Check for Updates.
- **Update DSH Runtime**: Runtime → Manage DSH versions. The default policy selects the newest compatible version; you can also pin a version. New upstream versions become available when their desktop runtime builds are ready.
- **Back up your data**: File → Open DSH Data Directory. Fully exit the app before copying this directory. The default is `%USERPROFILE%\.dsh`; a `DSH_HOME` override changes its location.

Client updates and runtime switches do not automatically delete sessions, settings, or plugins. Use **Exit** in the system tray menu to fully close the app.

## Common Problems

**First launch is stuck downloading?** Check that your network can reach GitHub and retry from the startup page. Any existing usable runtime is retained.

**The app cannot start after installing a plugin?** Update, disable, or remove the plugin from the startup page or **Runtime → Manage Plugins**. After updating an isolated plugin, use its re-enable and verify action. Do not delete the entire data directory.

**An old conversation will not open?** Use **Help → Repair Historical Sessions**. Run diagnostics and check the backup location before confirming a repair.

**Sessions become unavailable after switching to DSH 0.2.2, including new sessions?** If diagnostics contain `agent-preset/invalid`, `tool-subagent-list-agents`, or `/list-agents ... never started`, update `dsh-multi-model-orchestrator` to `0.8.3` or later in **Runtime → Manage Plugins** and wait for Runtime to restart. The old preset references a component entry removed by the new Runtime; deleting history is unnecessary.

**Windows shows Unknown Publisher or a SmartScreen warning?** Check the download source and file signature, and download only from this repository's releases. Some builds may be unsigned; the signature status shown by Windows is authoritative.

For other problems, open an [issue](https://github.com/ToxicantX/deepseek-harness-desktop/issues) with the versions shown in **Help → About DeepSeek Harness**, steps to reproduce, and error details with sensitive information removed.

## Versions And Updates

### 2026-10-28 20:43 (Beijing Time) · DSH 0.2.2 Session Recovery

- Identified a removed `/list-agents` component referenced by orchestrator `0.8.2`. Updating the installed plugin to the published `0.8.3` through the Shell restored session availability on `0.2.2-alpha.2`; no Shell release or Runtime downgrade was required.
- Added an isolated regression for the original preset failure, new-session creation, offline reply, persisted listing, and cold resume, with and without the Shell hook. Verified the actual desktop history input became available, preserving the history file and six specialist configurations.
- Backed up the plugin and managed presets before updating. No real model request was sent; OPS `0.4.4` still does not support DSH `0.2.2`.

### 0.1.68 · 2026-10-28 20:05 (Beijing Time)

- Added optional installation of `dsh-ops@0.4.4` through the existing plugin manager. Unsupported Runtime versions are rejected before stopping the backend or changing the profile; existing installations disable the shortcut.
- Verified actual installation in an isolated profile, native reading/search/editing and conflict guards, and the real PTC tool path on DSH `0.2.1-rc.3`. Browser interaction checks used mock IPC. All 552 tests, type checking, and the build passed.
- Added bounded recovery for explicit `empty_stream` failures before any content, tool calls, or replay state. The existing retry policy decides whether to retry, with up to two added recovery attempts; persistent errors stay visible and no synthetic reply or model switch is introduced.
- Verified recovery and persistent failure with the real Agent and retry plugin on Runtime `0.2.1-rc.3`, using an offline model fixture. Unknown Runtime source layouts retain their original behavior with a diagnostic.
- Update and fully restart the desktop client to apply the changes. OPS remains optional. External model workflows, optional Bash execution, and the incident on the other computer remain unverified.

### 0.1.64 · 2026-10-21 20:59 (Beijing Time)

- Added search settings for Exa, Perplexity, and existing DSH search providers. Automatic routing skips channels with missing credentials and uses an available configured provider.
- Saved keys are encrypted by the operating system and are not returned to the settings window. Applying settings requires confirmation to restart Runtime and interrupts running tasks.
- Fixed MCP discovery tool parameter schemas that caused WorkBuddy to reject the first request with `11129 invalid function call parameters`.
- Update and restart the desktop client to apply these changes. Sessions, models, and plugin settings are retained.

### 2026-10-17 12:28 (Beijing Time)

- Simplified both guides around downloads, initial setup, common actions, updates, and troubleshooting.

### Recent Changes

- **0.1.64**: Added Exa and Perplexity search settings with automatic fallback, and fixed the MCP parameter format behind WorkBuddy error 11129.
- **0.1.60**: Fixed the workspace folder button becoming unresponsive after opening Explorer.
- Added custom image generation protocol support, enlarged image previews, and audio/video playback. Generation capabilities depend on the configured provider and model.
- Added model information to subagent conversations and improved pond backgrounds and task status display.

See [Releases](https://github.com/ToxicantX/deepseek-harness-desktop/releases) for the full version history.

## Code Signing Policy

After SignPath Foundation approves and activates the integration, free code signing for eligible desktop client releases is provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org). See the [complete code signing policy](docs/code-signing-policy.md).
