import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, resolve, win32 } from 'node:path'
import type { InstalledRuntime } from './runtime-store.ts'

const PLUGIN_NAME = 'dsh-multi-model-orchestrator'
const PRESET_ID = 'multi-model-orchestrator'
const MARKER_NAME = '.dsh-multi-model-orchestrator.json'
const MANAGED_FILES = ['agent.cordis.yml', 'preset.yml'] as const
const INSTALL_TIMEOUT_MS = 2 * 60_000
const DIAGNOSTIC_PATTERN = /failed to apply loader entry multi-model-orchestrator-settings \(dsh-multi-model-orchestrator\): Refusing to modify preset target ([^\r\n]{1,32768}?): (?:(?:agent\.cordis\.yml|preset\.yml) (?:does not match the packaged preset|has changed since it was managed)\.|the management marker is (?:invalid|foreign or invalid)\.) Use --force to replace it\./gu

export interface PluginPresetRecoveryInput {
  home: string
  runtime: InstalledRuntime
  diagnostics: string
  environment?: NodeJS.ProcessEnv
}

export interface PluginPresetRecoveryResult {
  pluginName: string
  presetId: string
}

export interface PluginPresetRecoveryPlan extends PluginPresetRecoveryResult {
  apply(): Promise<PluginPresetRecoveryResult>
}

interface InstallerInvocation {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export interface PluginPresetRecoveryOptions {
  runInstaller?: (invocation: InstallerInvocation) => Promise<void>
}

function canonicalPath(value: string): string {
  const normalized = win32.isAbsolute(value) ? win32.resolve(value) : resolve(value)
  return process.platform === 'win32' || win32.isAbsolute(value) ? normalized.toLowerCase() : normalized
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

async function defaultRunInstaller(invocation: InstallerInvocation): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    let child: ChildProcess
    try {
      child = spawn(invocation.command, [...invocation.args], {
        cwd: invocation.cwd,
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch (error: unknown) {
      reject(error)
      return
    }
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error === undefined) resolvePromise()
      else reject(error)
    }
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
      finish(new Error('插件预设重置超时'))
    }, INSTALL_TIMEOUT_MS)
    timer.unref()
    child.once('error', error => { finish(error) })
    child.once('close', (code, signal) => {
      if (code === 0) finish()
      else finish(new Error(signal === null ? '插件预设重置退出码：' + String(code ?? 'unknown') : '插件预设重置被终止：' + signal))
    })
  })
}

async function readPackageName(manifest: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(manifest, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const name = (value as Record<string, unknown>).name
    return typeof name === 'string' ? name : undefined
  } catch {
    return undefined
  }
}

async function validateResetTarget(source: string, target: string): Promise<void> {
  const sources = new Map<string, Buffer>()
  for (const name of MANAGED_FILES) {
    const sourceContent = await readFile(join(source, name))
    const targetContent = await readFile(join(target, name))
    if (!sourceContent.equals(targetContent)) throw new Error('插件预设重置结果与安装包不一致')
    sources.set(name, sourceContent)
  }
  const markerValue: unknown = JSON.parse(await readFile(join(target, MARKER_NAME), 'utf8'))
  if (markerValue === null || typeof markerValue !== 'object' || Array.isArray(markerValue)) throw new Error('插件预设管理标记无效')
  const marker = markerValue as Record<string, unknown>
  const files = marker.files
  if (marker.schema !== 1 || marker.managedBy !== PLUGIN_NAME || files === null || typeof files !== 'object' || Array.isArray(files)) {
    throw new Error('插件预设管理标记无效')
  }
  for (const name of MANAGED_FILES) {
    if ((files as Record<string, unknown>)[name] !== sha256(sources.get(name) as Buffer)) throw new Error('插件预设管理标记无效')
  }
}

function diagnosticTargets(diagnostics: string): string[] {
  return [...diagnostics.matchAll(DIAGNOSTIC_PATTERN)].map(match => match[1] as string)
}

export async function inspectPluginPresetRecovery(
  input: PluginPresetRecoveryInput,
  options: PluginPresetRecoveryOptions = {},
): Promise<PluginPresetRecoveryPlan | undefined> {
  if (!isAbsolute(input.home) && !win32.isAbsolute(input.home)) return undefined
  const target = join(input.home, '.agent-presets', PRESET_ID)
  const targets = diagnosticTargets(input.diagnostics)
  if (targets.length === 0 || targets.some(value => canonicalPath(value) !== canonicalPath(target))) return undefined

  const packageRoot = join(input.home, 'profiles', 'web', 'node_modules', PLUGIN_NAME)
  const source = join(packageRoot, 'preset')
  const installer = join(packageRoot, 'src', 'install.mjs')
  if (await readPackageName(join(packageRoot, 'package.json')) !== PLUGIN_NAME) return undefined
  try {
    await Promise.all([
      readFile(installer),
      ...MANAGED_FILES.map(async name => readFile(join(source, name))),
      readFile(join(target, 'agent.cordis.yml')),
    ])
  } catch {
    return undefined
  }

  const runInstaller = options.runInstaller ?? defaultRunInstaller
  let applied = false
  return {
    pluginName: PLUGIN_NAME,
    presetId: PRESET_ID,
    async apply() {
      if (applied) throw new Error('插件预设恢复计划已执行')
      const backup = target + '.desktop-backup-' + Date.now().toString(36) + '-' + randomUUID()
      await rename(target, backup)
      try {
        const env = { ...(input.environment ?? process.env), DSH_HOME: input.home }
        await runInstaller({
          command: input.runtime.nodeExecutable,
          args: [installer, '--force', '--target', target],
          cwd: packageRoot,
          env,
        })
        await validateResetTarget(source, target)
        applied = true
        return { pluginName: PLUGIN_NAME, presetId: PRESET_ID }
      } catch (error: unknown) {
        let rollbackError: unknown
        try {
          await rm(target, { recursive: true, force: true })
          await rename(backup, target)
        } catch (value: unknown) {
          rollbackError = value
        }
        if (rollbackError !== undefined) throw new AggregateError([error, rollbackError], '插件预设重置失败，且自动回滚未完整完成')
        throw error
      }
    },
  }
}
