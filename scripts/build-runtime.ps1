param(
  [Parameter(Mandatory = $true)][string]$DshTag,
  [Parameter(Mandatory = $true)][string]$OutputDirectory,
  [ValidateRange(1, 2147483647)][int]$RuntimeRevision = 1,
  [string]$RequiredShellRange = '>=0.1.0 <1.0.0'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$NodeVersion = '24.19.0'
$PnpmVersion = '11.7.0'
$Repository = 'https://github.com/deepseek-ai/deepseek-harness.git'

if ($DshTag -notmatch '^dsh-v(?<version>\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$') {
  throw "Unsupported DSH tag: $DshTag"
}
$DshVersion = $Matches.version
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
$Work = Join-Path $OutputDirectory 'work'
$Source = Join-Path $Work 'source'
$Runtime = Join-Path $Work 'runtime'
$ArchiveRuntime = Join-Path $Work 'archive-runtime'
$Tools = Join-Path $Runtime 'tools'
$RepositoryRoot = Split-Path $PSScriptRoot -Parent
$RepairPluginSource = Join-Path $RepositoryRoot 'runtime/session-repair-plugin'
$DesktopPatchSource = Join-Path $RepositoryRoot 'runtime/desktop.patch.yml'
$ArtifactBase = "dsh-runtime-$DshVersion-desktop.$RuntimeRevision-win-x64"
$Archive = Join-Path $OutputDirectory "$ArtifactBase.zip"
$Manifest = Join-Path $OutputDirectory "$ArtifactBase.json"

Remove-Item $Work -Recurse -Force -ErrorAction SilentlyContinue
New-Item $Work -ItemType Directory -Force | Out-Null
New-Item $OutputDirectory -ItemType Directory -Force | Out-Null

git clone --depth 1 --branch $DshTag $Repository $Source
if ($LASTEXITCODE -ne 0) { throw 'Failed to clone the upstream DSH tag.' }
$Commit = (git -C $Source rev-parse HEAD).Trim()
$DeclaredVersion = node -e "const p=require(process.argv[1]); process.stdout.write(p.version)" (Join-Path $Source 'apps/cli/package.json')
if ($DeclaredVersion -ne $DshVersion) {
  throw "Tag $DshTag declares CLI version $DeclaredVersion instead of $DshVersion."
}

$App = Join-Path $Runtime 'app'
$RepairPlugin = Join-Path $App 'plugins/session-repair'
New-Item $App -ItemType Directory -Force | Out-Null
if (-not (Test-Path (Join-Path $RepairPluginSource 'index.js'))) { throw 'Session repair runtime plugin is incomplete; index.js is missing.' }
New-Item $RepairPlugin -ItemType Directory -Force | Out-Null
Copy-Item (Join-Path $RepairPluginSource '*') $RepairPlugin -Recurse -Force
Copy-Item $DesktopPatchSource (Join-Path $App 'desktop.patch.yml') -Force
@"
{
  "private": true,
  "type": "module",
  "dependencies": {
    "@deepseek-ai/dsh": "$DshVersion",
    "@deepseek-ai/dsh-desktop-session-repair": "file:./plugins/session-repair"
  }
}
"@ | Set-Content (Join-Path $App 'package.json') -Encoding utf8NoBOM
@"
node-linker=hoisted
package-import-method=copy
"@ | Set-Content (Join-Path $App '.npmrc') -Encoding utf8NoBOM
@"
packages:
  - .
allowBuilds:
  '@deepseek-ai/dsh-subprocess-local': true
  '@google/genai': false
  koffi: true
  node-pty: true
  protobufjs: false
"@ | Set-Content (Join-Path $App 'pnpm-workspace.yaml') -Encoding utf8NoBOM
Push-Location $App
try {
  pnpm install --prod --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Published DSH runtime installation failed.' }
  $DshManifest = Join-Path $App 'node_modules/@deepseek-ai/dsh/package.json'
  $InstalledVersion = node -e "const p=require(process.argv[1]); process.stdout.write(p.version)" $DshManifest
  if ($InstalledVersion -ne $DshVersion) { throw "Installed DSH version $InstalledVersion does not match $DshVersion." }
  # DSH links its manifest dependency closure into each profile for bare plugin resolution.
  node -e 'const fs=require("node:fs"); const path=process.argv[1]; const value=JSON.parse(fs.readFileSync(path, "utf8")); value.dependencies ??= {}; value.dependencies["@deepseek-ai/dsh-desktop-session-repair"] = "0.1.0"; fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n")' $DshManifest
  if ($LASTEXITCODE -ne 0) { throw 'Failed to register the desktop plugin in the packaged DSH dependency closure.' }
} finally {
  Pop-Location
}

$NodeArchiveName = "node-v$NodeVersion-win-x64.zip"
$NodeArchive = Join-Path $Work $NodeArchiveName
$NodeChecksums = Join-Path $Work 'SHASUMS256.txt'
Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/$NodeArchiveName" -OutFile $NodeArchive
Invoke-WebRequest "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt" -OutFile $NodeChecksums
$ChecksumLine = Select-String -Path $NodeChecksums -Pattern "^([0-9a-f]{64})  $([regex]::Escape($NodeArchiveName))$"
if ($null -eq $ChecksumLine) { throw 'Official Node checksum is missing.' }
$ExpectedNodeHash = $ChecksumLine.Matches[0].Groups[1].Value
$ActualNodeHash = (Get-FileHash $NodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ActualNodeHash -ne $ExpectedNodeHash) { throw 'Official Node archive SHA-256 mismatch.' }
$NodeExtract = Join-Path $Work 'node-extract'
Expand-Archive $NodeArchive -DestinationPath $NodeExtract
Move-Item (Join-Path $NodeExtract "node-v$NodeVersion-win-x64") (Join-Path $Runtime 'node')

New-Item $Tools -ItemType Directory -Force | Out-Null
@"
{
  "private": true,
  "dependencies": {
    "@pnpm/exe": "$PnpmVersion"
  }
}
"@ | Set-Content (Join-Path $Tools 'package.json') -Encoding utf8NoBOM
@"
packages:
  - .
allowBuilds:
  '@pnpm/exe': true
"@ | Set-Content (Join-Path $Tools 'pnpm-workspace.yaml') -Encoding utf8NoBOM
Push-Location $Tools
try {
  pnpm install --prod --no-frozen-lockfile
  if ($LASTEXITCODE -ne 0) { throw 'Standalone pnpm installation failed.' }
} finally {
  Pop-Location
}

node (Join-Path $PSScriptRoot 'prepare-runtime-archive.mjs') $Runtime $ArchiveRuntime
if ($LASTEXITCODE -ne 0) { throw 'Runtime junction materialization map generation failed.' }
Remove-Item $Archive -Force -ErrorAction SilentlyContinue
$SevenZip = (node -e "process.stdout.write(require('7zip-bin').path7za)").Trim()
if (-not (Test-Path $SevenZip)) { throw 'The locked 7zip-bin executable is unavailable.' }
Push-Location $ArchiveRuntime
try {
  & $SevenZip a -tzip $Archive '*'
  if ($LASTEXITCODE -ne 0) { throw 'Runtime archive creation failed.' }
} finally {
  Pop-Location
}

node (Join-Path $PSScriptRoot 'write-runtime-manifest.mjs') `
  --archive $Archive `
  --output $Manifest `
  --version $DshVersion `
  --tag $DshTag `
  --commit $Commit `
  --runtime-revision $RuntimeRevision `
  --shell-range $RequiredShellRange
if ($LASTEXITCODE -ne 0) { throw 'Runtime manifest generation failed.' }

Write-Host "Runtime archive: $Archive"
Write-Host "Runtime manifest: $Manifest"
