# DeepSeek Harness Desktop

[中文](README.md) | English

Windows desktop shell for DeepSeek Harness. The Shell and DSH runtime have independent versions: the installer carries only the Electron Shell, and first launch installs a compatible prebuilt runtime derived from a `dsh-v*` tag in [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).

## Download

Download the Windows x64 installer or portable build from the [Latest Release](https://github.com/ToxicantX/deepseek-harness-desktop/releases/latest). First launch installs the newest compatible DSH runtime automatically.

## Version model

- **Shell version** identifies the window, downloader, version manager, and runtime protocol, for example `0.1.0`.
- **DSH version** identifies an upstream Git tag; `0.1.0-rc.7` corresponds to `dsh-v0.1.0-rc.7`.
- **Runtime revision** identifies an immutable desktop build of the same upstream DSH tag. Legacy manifests default to revision `0`; rebuilt artifacts must increment it.
- The Shell declares its minimum DSH version. Each runtime manifest declares `requiredShellRange`, `runtimeProtocolVersion`, and `runtimeRevision`.
- The default `latest-compatible` policy selects the highest version that has a prebuilt artifact and is compatible with the current Shell.
- Users can explicitly choose **Automatic** or **Pinned version** under **Runtime → Manage DSH versions**. A pin remains selected until the user restores the automatic policy; the list shows only DSH version numbers and marks the version currently in use.

A new upstream tag does not enter the catalog until its desktop runtime passes the build, compatibility, and smoke gates, so an unprepared version cannot break an existing installation. Release channels stay separate: `shell-v*` publishes the Shell, `runtime-dsh-v*-desktop.<revision>` publishes immutable runtimes, and `runtime-catalog` carries the machine-readable catalog.

## Installation and updates

On a normal application launch, the local Shell startup page shows only the status ring and catalog, Runtime download, or startup state; it does not expose version selection. For first install, automatic upgrade, or a DSH switch initiated from the version manager, target-version download progress stays at the bottom of the startup page. Version selection appears only under **Runtime → Manage DSH versions**. Animation is disabled when the system requests reduced motion. First launch requires network access. The Shell downloads `runtime-catalog.json`, selects a version, downloads the Windows x64 runtime ZIP, and verifies both its declared size and SHA-256. Extraction occurs in a staging directory. The Shell updates the current version only after Node, pnpm, and DSH are present and Web readiness succeeds. Download, verification, and startup failures leave the previous runtime available.

Runtimes are stored by default under:

```text
%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\<dsh-version>
```

Profiles, sessions, settings, and plugins remain under `%USERPROFILE%\.dsh`, or the existing `DSH_HOME` override. Runtime switching, Shell updates, and reinstallation do not remove that directory.

## Agent personalization

Open the global Agent personalization editor from **File → Personalization...**. It directly manages `$DSH_HOME/AGENTS.md` (`%USERPROFILE%\.dsh\AGENTS.md` by default) and supports a starter template, reload, a UTF-8 byte counter, and keyboard save. Saving blank content removes the file. Every mutation checks the observed document revision and uses a same-directory temporary file with atomic replacement. When an external change has already been detected, saving is rejected until the document is reloaded.

This document is a user-preference layer. It does not modify an Agent preset or grant tools and permissions the preset does not provide. Presets composed with `@deepseek-ai/dsh-agent-instructions` load it for subsequent new sessions while retaining their own role, tools, capabilities, and security boundaries; a workspace `AGENTS.md` can add more specific project rules. Personalization text enters model context, so it must not contain API keys, tokens, passwords, or other credentials.

## Desktop pet settings

The default pet is an original anime sprite character rendered entirely inside the transparent Electron desktop window. Local transparent PNG strips provide separate frame animations for idle, thinking, speaking, approval, success, error, unavailable, and dragging states; missing, malformed, or undecodable strips fall back to the original procedural Canvas robot. The pet loads no network assets and launches no Web page. When Windows reduced motion is enabled, each state holds a representative frame.

Choose **File → Desktop Pet Settings → Small / Standard / Large** to resize the character. The three modes use 72, 96, and 128 CSS pixels while retaining the 192×192 Canvas backing store. A size change updates the transparent window, native hit-test shape, bubble anchor, and drag bounds together, then persists the selection in `desktop-pet.json` under application `userData`. Standard preserves the previous 96-pixel appearance.

The legacy local still-image and animated-GIF skin picker, decoders, and renderer data-URL channel have been removed. After an upgrade, the Shell deletes stale `desktop-pet-skin.png`, `desktop-pet-skin.gif`, and their corresponding `.tmp` files.

## Plugins

Open the desktop plugin manager from **Runtime → Manage Plugins**. It lists plugins installed in the current Web profile and supports installing and removing them. For installation, enter a controlled npm package spec or a GitHub HTTPS / `github:` spec, such as `@scope/plugin@1.2.3`, `https://github.com/owner/repo.git`, or `github:owner/repo`. An update action appears only after the bundled pnpm confirms an actionable newer npm version; Git sources, pinned versions, network failures, and unresolved update states show no update action. The manager shows operation progress and logs.

Before an install, update, or removal, the Shell stops the Runtime so Web/HMR cannot load partially changed files from `node_modules`. The Runtime restarts after success and is also restored after a failed mutation. Closing and reopening the plugin manager does not lose an active operation or a pending Runtime restart; the reopened window resumes the same progress and log. If a plugin fails to load and prevents Web readiness, the Shell-owned plugin manager remains available so you can remove or update the problematic plugin and restart the Runtime again.

If an older Web profile was created with a different pnpm `virtual-store-dir-max-length`, the manager removes the regenerable `.modules.yaml` only after matching that exact compatibility error, then retries the original operation once. It does not delete the profile manifest, lockfile, plugin configuration, or other user data.

If a patch under an existing `%USERPROFILE%\.dsh` still references a deleted local plugin file, the setup page offers **Disable stale local plugins and retry**. After confirmation, the Shell backs up and removes only loader entries that exactly match the startup error; it does not clear sessions, settings, credentials, other plugins, or the profile.

If `dsh-multi-model-orchestrator` refuses startup because its managed preset conflicts with the currently installed package, the setup page offers a separate confirmed recovery. It is enabled only when the loader entry, package, target, and conflict reason all match exactly. After confirmation, the Shell moves the complete `multi-model-orchestrator` preset directory to a sibling `desktop-backup`, then runs the installed plugin's installer with fixed `--force --target` arguments. If reset or validation fails, the original directory is restored automatically.

The Shell writes a stable `dsh.cmd` under its user-data directory and puts the active runtime's standard Node and pnpm on `PATH`. As an advanced fallback, open **Runtime → Open plugin management terminal** and use the existing commands:

```powershell
dsh plugin --profile web list
dsh plugin --profile web add <package-spec>
dsh plugin --profile web update <package-spec>
dsh plugin --profile web remove <package-name>
```

Git package specifications require system Git on `PATH`. npm, local-directory, and tarball specifications need no global Node or pnpm installation.

## MCP management

Open the desktop MCP manager from **Runtime → Manage MCP**. It scans Bundle patches declared by the current Web profile, the profile patch, `$DSH_HOME/cordis.patch.yml`, and the desktop Runtime overlay in actual Cordis patch order. It recognizes one-server `@deepseek-ai/dsh-mcp-client` entries and multi-server `dsh-mcp-lens` aggregate entries, and also discovers local MCPs from `%USERPROFILE%\.codex\config.toml` read-only. The list supports search, DSH connection-state filters, and configuration details. Environment and HTTP header values stay in the main process; URLs lose credentials and query strings, and likely secret arguments are redacted before any data reaches the renderer.

Enabling or disabling requires a stable Cordis entry `id`. The Shell writes only a `disabled` override in the highest controlling profile or home user patch and never changes an installed plugin package or MCP server files. It checks the revision across all effective layers before using a same-directory temporary file and atomic replacement. A Codex MCP switch controls whether that server is connected to DSH: the initial connection writes its execution or connection settings to the DSH profile patch, and later toggles affect only the DSH entry. Codex `config.toml` always remains unchanged. An entry remains visible but cannot be toggled from a lower layer when the higher-priority desktop Runtime overlay locks its state; a dynamic `!!js` state is labeled explicitly. The Runtime stops for the mutation and restarts afterward, including recovery attempts after failures. MCP Lens uses one Cordis entry, so its switch controls every server shown under that Lens entry together.

## Runtime artifacts

`.github/workflows/runtime-release.yml` checks the newest upstream `dsh-v*` tag each day and also accepts an explicit tag, positive `runtime_revision`, and Shell range. It verifies the tag and CLI version, installs the exact official `@deepseek-ai/dsh` release, adds a checksum-verified official Node 24 runtime and standalone pnpm, runs real Web, settings-open, session-repair, plugin, and shutdown smokes, and publishes the ZIP, manifest, and updated catalog. The catalog accepts only a higher revision for the same DSH version; release tags and assets are never overwritten.

The client does not clone and build the complete upstream repository on the user's machine. Git tags remain the version source of truth without requiring users to install Git, development dependencies, or native build tools.

## Development

Windows x64, Node 24, and pnpm 11 are required:

```powershell
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
pnpm run build
pnpm run start
pnpm run dist
```

Build one complete runtime with:

```powershell
./scripts/build-runtime.ps1 `
  -DshTag dsh-v0.1.0-rc.7 `
  -OutputDirectory "$PWD/runtime-output" `
  -RuntimeRevision 1 `
  -RequiredShellRange '>=0.1.0 <1.0.0'
```

## Windows code signing

Public distribution should use an Authenticode code-signing certificate issued by a Windows-trusted CA. A self-signed certificate is suitable only for managed internal environments where its root is deployed; it does not remove Unknown Publisher or SmartScreen warnings for ordinary users.

For an exportable PKCS#12/PFX certificate, create two Repository secrets under GitHub **Settings → Secrets and variables → Actions**:

- `CSC_LINK`: the Base64 content of the PFX file. Generate it in PowerShell with `[Convert]::ToBase64String([IO.File]::ReadAllBytes('certificate.pfx')) | Set-Clipboard`. Never commit the PFX or its Base64 content.
- `CSC_KEY_PASSWORD`: the password selected when exporting the PFX.

Only `shell-v*` tag builds receive these secrets. The workflow lets electron-builder sign the main executable, NSIS installer, uninstaller, and portable EXE. When `CSC_LINK` is present, it also requires both published EXEs to report a `Valid` Authenticode status. Increment the `package.json` version and push the matching `shell-v<version>` tag to publish a newly signed version.

Most newly issued public certificates require hardware- or cloud-protected private keys and cannot be exported as PFX. Do not copy a hardware-token key into GitHub. Instead, integrate the provider action for a remote service such as Azure Artifact Signing, DigiCert KeyLocker, or SignPath into the tag build.

Local `dist` artifacts remain unsigned when no certificate is configured. Even with a trusted certificate, SmartScreen reputation may still need to develop through downloads and time.

## Current scope

- Windows x64 is the only supported target.
- The default minimum DSH version is `0.1.0-rc.7`.
- Runtime Releases are always marked as GitHub prereleases so they do not replace the latest Shell Release used by electron-updater.
- The Shell opens DSH Web over an ephemeral loopback origin. Host code and plugins always run in the downloaded standard-Node runtime.
