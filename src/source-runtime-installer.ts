import { spawn } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import type { RuntimeManifest } from './catalog.ts'

const COMMAND_TIMEOUT_MS = 30 * 60_000
const OUTPUT_LIMIT = 24 * 1024

export type SourceInstallStage = 'cloning' | 'installing' | 'building' | 'assembling'

export interface SourceInstallProgress {
  stage: SourceInstallStage
  received: 0
  total: 0
}

export interface CommandResult {
  stdout: string
}

export type RunCommand = (command: string, args: readonly string[], cwd?: string) => Promise<CommandResult>

export interface SourceRuntimeInstallerOptions {
  manifest: RuntimeManifest
  destination: string
  workDirectory: string
  resourcesDirectory: string
  onProgress?: (progress: SourceInstallProgress) => void
  runCommand?: RunCommand
  resolveExecutable?: (name: 'git' | 'node' | 'pnpm') => Promise<string>
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = current + chunk.toString()
  return next.length <= OUTPUT_LIMIT ? next : next.slice(next.length - OUTPUT_LIMIT)
}

export function runSourceCommand(command: string, args: readonly string[], cwd?: string): Promise<CommandResult> {
  return new Promise((resolveCommand, reject) => {
    const child = spawn(command, [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout = appendTail(stdout, chunk) })
    child.stderr.on('data', chunk => { stderr = appendTail(stderr, chunk) })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Source build command timed out: ' + command + ' ' + args.join(' ')))
    }, COMMAND_TIMEOUT_MS)
    timer.unref()
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', code => {
      clearTimeout(timer)
      if (code === 0) resolveCommand({ stdout: stdout.trim() })
      else {
        const detail = stderr.trim() || stdout.trim()
        reject(new Error('Source build command failed (' + String(code ?? 'unknown') + '): ' + command + ' ' + args.join(' ')
          + (detail.length === 0 ? '' : '\n\n' + detail)))
      }
    })
  })
}

async function findExecutable(name: 'git' | 'node' | 'pnpm'): Promise<string> {
  const result = await runSourceCommand('where.exe', [name])
  const candidates = result.stdout.split(/\r?\n/u).map(value => value.trim()).filter(value => value.length > 0)
  const executable = candidates.find(candidate => extname(candidate).toLowerCase() === '.exe')
  if (executable === undefined) throw new Error('Source installation requires an executable ' + name + ' on PATH')
  return executable
}

function inside(root: string, relativePath: string): string {
  if (isAbsolute(relativePath)) throw new Error('Runtime path must be relative: ' + relativePath)
  const filename = resolve(root, relativePath)
  const prefix = resolve(root) + (process.platform === 'win32' ? '\\' : '/')
  if (!filename.startsWith(prefix)) throw new Error('Runtime path escapes source installation: ' + relativePath)
  return filename
}

async function addDesktopPlugins(dshDirectory: string, appDirectory: string, resourcesDirectory: string): Promise<void> {
  const scope = join(appDirectory, 'node_modules', '@deepseek-ai')
  const repair = join(scope, 'dsh-desktop-session-repair')
  const petBridge = join(scope, 'dsh-desktop-pet-bridge')
  await Promise.all([
    cp(join(resourcesDirectory, 'session-repair-plugin'), repair, { recursive: true, force: true }),
    cp(join(resourcesDirectory, 'pet-bridge-plugin'), petBridge, { recursive: true, force: true }),
    copyFile(join(resourcesDirectory, 'desktop.patch.yml'), join(appDirectory, 'desktop.patch.yml')),
  ])
  const packageFile = join(dshDirectory, 'package.json')
  const manifest = JSON.parse(await readFile(packageFile, 'utf8')) as { dependencies?: Record<string, string> }
  manifest.dependencies ??= {}
  manifest.dependencies['@deepseek-ai/dsh-desktop-session-repair'] = '0.1.0'
  manifest.dependencies['@deepseek-ai/dsh-desktop-pet-bridge'] = '0.1.0'
  await writeFile(packageFile, JSON.stringify(manifest, undefined, 2) + '\n', 'utf8')
}

export async function installRuntimeFromSource(options: SourceRuntimeInstallerOptions): Promise<void> {
  const run = options.runCommand ?? runSourceCommand
  const resolveTool = options.resolveExecutable ?? findExecutable
  const report = (stage: SourceInstallStage): void => { options.onProgress?.({ stage, received: 0, total: 0 }) }
  const source = join(options.workDirectory, 'source')
  const dshDirectory = dirname(dirname(inside(options.destination, options.manifest.paths.dsh)))
  const appDirectory = join(options.destination, 'app')
  try {
    await rm(options.workDirectory, { recursive: true, force: true })
    await rm(options.destination, { recursive: true, force: true })
    await mkdir(options.workDirectory, { recursive: true })
    const [git, node, pnpm] = await Promise.all([resolveTool('git'), resolveTool('node'), resolveTool('pnpm')])

    report('cloning')
    await run(git, ['clone', '--depth', '1', '--branch', options.manifest.source.tag, '--single-branch', options.manifest.source.repository, source])
    const commit = (await run(git, ['rev-parse', 'HEAD'], source)).stdout.trim().toLowerCase()
    if (commit !== options.manifest.source.commit) throw new Error('Source tag resolved to ' + commit + ', expected ' + options.manifest.source.commit)
    const cliManifest = JSON.parse(await readFile(join(source, 'apps', 'cli', 'package.json'), 'utf8')) as { version?: unknown }
    if (cliManifest.version !== options.manifest.dshVersion) {
      throw new Error('Source tag declares DSH ' + String(cliManifest.version) + ' instead of ' + options.manifest.dshVersion)
    }

    report('installing')
    await run(pnpm, ['install', '--frozen-lockfile'], source)
    report('building')
    await run(pnpm, ['run', 'build'], source)

    report('assembling')
    await mkdir(dirname(dshDirectory), { recursive: true })
    await run(pnpm, ['--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod', dshDirectory], source)
    await addDesktopPlugins(dshDirectory, appDirectory, options.resourcesDirectory)
    for (const [sourceTool, targetPath] of [[node, options.manifest.paths.node], [pnpm, options.manifest.paths.pnpm]] as const) {
      const target = inside(options.destination, targetPath)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(sourceTool, target)
    }
    await writeFile(join(options.destination, 'runtime-manifest.json'), JSON.stringify(options.manifest, undefined, 2) + '\n', 'utf8')
  } catch (error: unknown) {
    await rm(options.destination, { recursive: true, force: true })
    throw error
  } finally {
    await rm(options.workDirectory, { recursive: true, force: true })
  }
}
