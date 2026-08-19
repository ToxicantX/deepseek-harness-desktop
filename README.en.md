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
- Users can pin an exact version under **Runtime → Manage DSH versions**. A pin remains selected until the user restores the automatic policy.

A new upstream tag does not enter the catalog until its desktop runtime passes the build, compatibility, and smoke gates, so an unprepared version cannot break an existing installation. Release channels stay separate: `shell-v*` publishes the Shell, `runtime-dsh-v*-desktop.<revision>` publishes immutable runtimes, and `runtime-catalog` carries the machine-readable catalog.

## Installation and updates

First launch requires network access. The Shell downloads `runtime-catalog.json`, selects a version, downloads the Windows x64 runtime ZIP, and verifies both its declared size and SHA-256. Extraction occurs in a staging directory. The Shell updates the current version only after Node, pnpm, and DSH are present and Web readiness succeeds. Download, verification, and startup failures leave the previous runtime available.

Runtimes are stored by default under:

```text
%LOCALAPPDATA%\DeepSeek Harness\runtime-manager\runtimes\<dsh-version>
```

Profiles, sessions, settings, and plugins remain under `%USERPROFILE%\.dsh`, or the existing `DSH_HOME` override. Runtime switching, Shell updates, and reinstallation do not remove that directory.

## Plugins

Open the desktop plugin manager from **Runtime → Manage Plugins**. It lists plugins installed in the current Web profile and supports installing, updating, and removing them. For installation, enter a controlled npm package spec or a GitHub HTTPS / `github:` spec, such as `@scope/plugin@1.2.3`, `https://github.com/owner/repo.git`, or `github:owner/repo`. Update and removal actions use package names from the installed list. The manager shows operation progress and logs.

After a successful install, update, or removal, the Runtime restarts automatically so the change takes effect. If a plugin fails to load and prevents Web readiness, the Shell-owned plugin manager remains available so you can remove or update the problematic plugin and restart the Runtime again.

If a patch under an existing `%USERPROFILE%\.dsh` still references a deleted local plugin file, the setup page offers **Disable stale local plugins and retry**. After confirmation, the Shell backs up and removes only loader entries that exactly match the startup error; it does not clear sessions, settings, credentials, other plugins, or the profile.

The Shell writes a stable `dsh.cmd` under its user-data directory and puts the active runtime's standard Node and pnpm on `PATH`. As an advanced fallback, open **Runtime → Open plugin management terminal** and use the existing commands:

```powershell
dsh plugin --profile web list
dsh plugin --profile web add <package-spec>
dsh plugin --profile web update <package-spec>
dsh plugin --profile web remove <package-name>
```

Git package specifications require system Git on `PATH`. npm, local-directory, and tarball specifications need no global Node or pnpm installation.

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
