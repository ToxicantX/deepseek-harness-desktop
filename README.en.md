# DeepSeek Harness Desktop

[中文](README.md) | English

Windows desktop shell for DeepSeek Harness. The Shell and DSH runtime have independent versions: the installer carries only the Electron Shell, and first launch installs a compatible prebuilt runtime derived from a `dsh-v*` tag in [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness).

## Version model

- **Shell version** identifies the window, downloader, version manager, and runtime protocol, for example `0.1.0`.
- **DSH version** identifies an upstream Git tag; `0.1.0-rc.7` corresponds to `dsh-v0.1.0-rc.7`.
- The Shell declares its minimum DSH version. Each runtime manifest declares `requiredShellRange` and `runtimeProtocolVersion`.
- The default `latest-compatible` policy selects the highest version that has a prebuilt artifact and is compatible with the current Shell.
- Users can pin an exact version under **Runtime → Manage DSH versions**. A pin remains selected until the user restores the automatic policy.

A new upstream tag does not enter the catalog until its desktop runtime passes the build, compatibility, and smoke gates, so an unprepared version cannot break an existing installation. Release channels stay separate: `shell-v*` publishes the Shell, `runtime-dsh-v*` publishes runtimes, and `runtime-catalog` carries the machine-readable catalog.

## Installation and updates

First launch requires network access. The Shell downloads `runtime-catalog.json`, selects a version, downloads the Windows x64 runtime ZIP, and verifies both its declared size and SHA-256. Extraction occurs in a staging directory. The Shell updates the current version only after Node, pnpm, and DSH are present and Web readiness succeeds. Download, verification, and startup failures leave the previous runtime available.

Runtimes are stored by default under:

```text
%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\<dsh-version>
```

Profiles, sessions, settings, and plugins remain under `%USERPROFILE%\.dsh`, or the existing `DSH_HOME` override. Runtime switching, Shell updates, and reinstallation do not remove that directory.

## Plugins

The Shell writes a stable `dsh.cmd` under its user-data directory and puts the active runtime's standard Node and pnpm on `PATH`. Open **Runtime → Open plugin management terminal** and use the existing commands:

```powershell
dsh plugin --profile web list
dsh plugin --profile web add <package-spec>
dsh plugin --profile web update <package-spec>
dsh plugin --profile web remove <package-name>
```

Git package specifications require system Git on `PATH`. npm, local-directory, and tarball specifications need no global Node or pnpm installation.

## Runtime artifacts

`.github/workflows/runtime-release.yml` checks the newest upstream `dsh-v*` tag each day and also accepts an explicit tag and Shell range. It verifies the tag and CLI version, installs the exact official `@deepseek-ai/dsh` release, adds a checksum-verified official Node 24 runtime and standalone pnpm, runs real Web, plugin, and shutdown smokes, and publishes the ZIP, manifest, and updated catalog.

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
  -RequiredShellRange '>=0.1.0 <1.0.0'
```

Local `dist` artifacts are unsigned and may trigger Windows SmartScreen reputation warnings. The Shell Release workflow signs when `CSC_LINK` and `CSC_KEY_PASSWORD` are configured.

## Current scope

- Windows x64 is the only supported target.
- The default minimum DSH version is `0.1.0-rc.7`.
- Runtime Releases are always marked as GitHub prereleases so they do not replace the latest Shell Release used by electron-updater.
- The Shell opens DSH Web over an ephemeral loopback origin. Host code and plugins always run in the downloaded standard-Node runtime.
