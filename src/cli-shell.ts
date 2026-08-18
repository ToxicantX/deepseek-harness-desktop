import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { InstalledRuntime } from './runtime-store.ts'

function cmdLiteral(value: string): string {
  return value.replaceAll('%', '%%')
}

export function renderCliShim(runtime: InstalledRuntime): string {
  return [
    '@echo off',
    'setlocal',
    `set "PATH=${cmdLiteral(dirname(runtime.pnpmExecutable))};${cmdLiteral(dirname(runtime.nodeExecutable))};%PATH%"`,
    `"${cmdLiteral(runtime.nodeExecutable)}" "${cmdLiteral(runtime.dshBin)}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n')
}

export async function prepareCliShim(runtime: InstalledRuntime, userData: string): Promise<string> {
  const directory = join(userData, 'cli')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'dsh.cmd'), renderCliShim(runtime), 'utf8')
  return directory
}

export async function openPluginTerminal(
  cliDirectory: string,
  cwd: string,
  inherited: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const environment: NodeJS.ProcessEnv = { ...inherited, Path: `${cliDirectory};${inherited.Path ?? inherited.PATH ?? ''}` }
  environment.PATH = environment.Path
  const command = [
    "$Host.UI.RawUI.WindowTitle = 'DeepSeek Harness 插件管理'",
    "Write-Host 'dsh plugin --profile web list' -ForegroundColor Cyan",
    "Write-Host 'dsh plugin --profile web add <package-spec>' -ForegroundColor DarkGray",
  ].join('; ')
  await new Promise<void>((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoExit', '-Command', command], {
      cwd,
      env: environment,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  })
}
