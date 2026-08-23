import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { gt, valid } from 'semver'
import type { InstalledRuntime } from './runtime-store.ts'

const MAX_PACKAGE_NAME = 214
const MAX_PACKAGE_SPEC = 512
const MAX_LIST_BYTES = 1024 * 1024
const MAX_OUTPUT_CHARS = 64 * 1024
const MAX_ENTRIES = 1_000
const OPERATION_TIMEOUT_MS = 15 * 60_000
const UPDATE_CHECK_TIMEOUT_MS = 8_000
const MAX_UPDATE_BYTES = 256 * 1024
const VIRTUAL_STORE_MISMATCH = 'ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF'

export type PluginAction = 'add' | 'update' | 'remove'

export interface PluginEntry {
  name: string
  spec?: string
  version?: string
  manualUpdate?: true
}

export interface PluginList {
  entries: PluginEntry[]
}

export interface PluginUpdateEntry {
  name: string
  currentVersion: string
  latestVersion: string
}

export interface PluginUpdateList {
  entries: PluginUpdateEntry[]
}

export type PluginStartInput =
  | { action: 'add'; spec: string }
  | { action: 'update' | 'remove'; packageName: string }

export interface PluginOperationStatus {
  operationId: string
  state: 'running' | 'succeeded' | 'failed'
  action: PluginAction
  packageName?: string
  output: string
  error?: string
}

export interface PluginProcess {
  stdout: NodeJS.ReadableStream
  stderr: NodeJS.ReadableStream
  once(event: 'error', listener: (error: Error) => void): this
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

export interface PluginProcessOptions {
  cwd: string
  env: NodeJS.ProcessEnv
  shell: false
  windowsHide: true
}

export type PluginProcessRunner = (
  command: string,
  args: readonly string[],
  options: PluginProcessOptions,
) => PluginProcess

export interface PluginManagerOptions {
  runtime(): InstalledRuntime | undefined
  home: string
  environment?: NodeJS.ProcessEnv
  runProcess?: PluginProcessRunner
  readText?: (filename: string) => Promise<string>
  removeFile?: (filename: string) => Promise<void>
  onOperationFinished?: (status: PluginOperationStatus) => void
}

interface OperationRecord extends PluginOperationStatus {
  child?: PluginProcess
  timer?: NodeJS.Timeout
}

interface ProcessResult {
  stdout: string
  stderr: string
  code: number | null
  signal: NodeJS.Signals | null
}

function defaultRunProcess(command: string, args: readonly string[], options: PluginProcessOptions): PluginProcess {
  const child: ChildProcess = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    shell: options.shell,
    windowsHide: options.windowsHide,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.stdout === null || child.stderr === null) throw new Error('plugin process pipes are unavailable')
  return child as PluginProcess
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object')
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys)
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error(label + ' has unsupported fields')
}

function boundedText(value: unknown, label: string, limit: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > limit || (!allowEmpty && value.length === 0)) {
    throw new Error(label + ' is invalid')
  }
  return value
}

export function validatePackageName(value: unknown): string {
  const name = boundedText(value, 'packageName', MAX_PACKAGE_NAME)
  const atom = '[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?'
  const pattern = new RegExp('^(?:' + atom + '|@' + atom + '/' + atom + ')$')
  if (!pattern.test(name)) throw new Error('packageName is invalid')
  return name
}

export function validatePackageSpec(value: unknown): string {
  const spec = boundedText(value, 'spec', MAX_PACKAGE_SPEC)
  if (spec.trim() !== spec || /[\s\u0000-\u001f\u007f]/u.test(spec) || spec.startsWith('-')) {
    throw new Error('spec is invalid')
  }
  const packageName = '(?:[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?|@[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?/[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?)'
  const registry = new RegExp('^' + packageName + '(?:@[0-9A-Za-z](?:[0-9A-Za-z._+-]*[0-9A-Za-z])?)?$')
  const github = /^(?:github:|(?:git\+)?https:\/\/github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:#[A-Za-z0-9._\/-]+)?$/u
  if (!registry.test(spec) && !github.test(spec)) throw new Error('spec must be an npm package or GitHub HTTPS reference')
  return spec
}

function parseStartInput(value: unknown): PluginStartInput {
  const input = object(value, 'plugin operation')
  if (input.action === 'add') {
    exactKeys(input, ['action', 'spec'], 'plugin operation')
    return { action: 'add', spec: validatePackageSpec(input.spec) }
  }
  if (input.action === 'update' || input.action === 'remove') {
    exactKeys(input, ['action', 'packageName'], 'plugin operation')
    return { action: input.action, packageName: validatePackageName(input.packageName) }
  }
  throw new Error('plugin action is invalid')
}

function sanitizeOutput(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\r\n?/gu, '\n')
    .replace(/[^\t\n\x20-\x7e\u0080-\uffff]/gu, '')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

function redactPaths(value: string, paths: readonly string[]): string {
  let result = sanitizeOutput(value)
  for (const path of paths) {
    const variants = new Set([path, path.replaceAll('\\', '/'), path.replaceAll('/', '\\')])
    for (const variant of variants) {
      if (variant.length === 0) continue
      result = result.replace(new RegExp(escapeRegExp(variant) + '(?:[\\\\/][^\\s\"\'<>|]*)?', 'giu'), '[路径已隐藏]')
    }
  }
  return result
}

function appendOutput(previous: string, chunk: unknown): string {
  const next = previous + sanitizeOutput(String(chunk))
  if (next.length <= MAX_OUTPUT_CHARS) return next
  const marker = '[较早的输出已省略]\n'
  return marker + next.slice(-(MAX_OUTPUT_CHARS - marker.length))
}

function stringField(value: unknown, label: string, limit: number): string | undefined {
  if (value === undefined) return undefined
  return boundedText(value, label, limit)
}

function versionField(value: unknown, label: string): string | undefined {
  const version = stringField(value, label, 256)
  return version === undefined ? undefined : valid(version) ?? undefined
}

function supportsManualUpdate(spec: string): boolean {
  return /^(?:github:|git(?:\+|:)|(?:git\+)?https:\/\/github\.com\/|file:|link:|workspace:)/u.test(spec)
}

async function readInstalledPluginVersion(
  profilePath: string,
  name: string,
  readText: (filename: string) => Promise<string>,
): Promise<string | undefined> {
  try {
    const manifestPath = join(profilePath, 'node_modules', ...name.split('/'), 'package.json')
    const text = await readText(manifestPath)
    if (Buffer.byteLength(text, 'utf8') > MAX_LIST_BYTES) return undefined
    const manifest = object(JSON.parse(text) as unknown, 'installed plugin manifest')
    if (stringField(manifest.name, 'installed plugin name', MAX_PACKAGE_NAME) !== name) return undefined
    return versionField(manifest.version, 'installed plugin version')
  } catch {
    return undefined
  }
}

async function parsePluginList(
  stdout: string,
  expectedProfilePath: string,
  readText: (filename: string) => Promise<string>,
): Promise<PluginList> {
  if (Buffer.byteLength(stdout, 'utf8') > MAX_LIST_BYTES) throw new Error('plugin list output is too large')
  const parsed: unknown = JSON.parse(stdout)
  if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error('plugin list must contain one profile')
  const profile = object(parsed[0], 'plugin profile')
  const profilePath = boundedText(profile.path, 'plugin profile path', 32_768)
  if (!isAbsolute(profilePath) || resolve(profilePath).toLowerCase() !== resolve(expectedProfilePath).toLowerCase()) {
    throw new Error('plugin profile path is invalid')
  }
  const listed = profile.dependencies === undefined ? {} : object(profile.dependencies, 'listed dependencies')
  const manifestText = await readText(join(profilePath, 'package.json'))
  if (Buffer.byteLength(manifestText, 'utf8') > MAX_LIST_BYTES) throw new Error('plugin profile manifest is too large')
  const manifest = object(JSON.parse(manifestText) as unknown, 'plugin profile manifest')
  const dependencies = manifest.dependencies === undefined ? {} : object(manifest.dependencies, 'plugin dependencies')
  const names = Object.keys(dependencies)
  if (names.length > MAX_ENTRIES) throw new Error('plugin dependency list is too large')
  const entries: PluginEntry[] = []
  for (const name of names) {
    validatePackageName(name)
    const dependencySpec = boundedText(dependencies[name], 'plugin dependency spec', MAX_PACKAGE_SPEC)
    let spec: string | undefined
    try { spec = validatePackageSpec(dependencySpec) } catch { spec = undefined }
    const manualUpdate = supportsManualUpdate(dependencySpec)
    const detailValue = listed[name]
    const detail = detailValue === undefined ? undefined : object(detailValue, 'listed plugin')
    const listedVersion = detail === undefined ? undefined : versionField(detail.version, 'plugin version')
    const version = listedVersion ?? await readInstalledPluginVersion(profilePath, name, readText)
    entries.push({
      name,
      ...(spec === undefined ? {} : { spec }),
      ...(version === undefined ? {} : { version }),
      ...(manualUpdate ? { manualUpdate: true as const } : {}),
    })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { entries }
}

export function parsePluginUpdates(stdout: string): PluginUpdateList {
  if (stdout.trim().length === 0) return { entries: [] }
  if (Buffer.byteLength(stdout, 'utf8') > MAX_LIST_BYTES) throw new Error('plugin update output is too large')
  const parsed = object(JSON.parse(stdout) as unknown, 'plugin update list')
  const names = Object.keys(parsed)
  if (names.length > MAX_ENTRIES) throw new Error('plugin update list is too large')
  const entries: PluginUpdateEntry[] = []
  for (const name of names) {
    validatePackageName(name)
    const detail = object(parsed[name], 'plugin update')
    const currentValue = stringField(detail.current, 'current plugin version', 256)
    const latestValue = stringField(detail.wanted ?? detail.latest, 'latest plugin version', 256)
    if (currentValue === undefined || latestValue === undefined) continue
    const currentVersion = valid(currentValue)
    const latestVersion = valid(latestValue)
    if (currentVersion === null || latestVersion === null || !gt(latestVersion, currentVersion)) continue
    entries.push({ name, currentVersion, latestVersion })
  }
  entries.sort((left, right) => left.name.localeCompare(right.name))
  return { entries }
}

export class PluginManager {
  private readonly runtimeProvider: () => InstalledRuntime | undefined
  private readonly home: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly runProcess: PluginProcessRunner
  private readonly readText: (filename: string) => Promise<string>
  private readonly removeFile: (filename: string) => Promise<void>
  private readonly onOperationFinished: (status: PluginOperationStatus) => void
  private readonly operations = new Map<string, OperationRecord>()
  private activeOperationId: string | undefined
  private pendingRestartOperationId: string | undefined
  private disposed = false

  constructor(options: PluginManagerOptions) {
    if (!isAbsolute(options.home)) throw new Error('DSH home must be absolute')
    this.runtimeProvider = options.runtime
    this.home = options.home
    this.environment = options.environment ?? process.env
    this.runProcess = options.runProcess ?? defaultRunProcess
    this.readText = options.readText ?? (async filename => readFile(filename, 'utf8'))
    this.removeFile = options.removeFile ?? (async filename => rm(filename, { force: true }))
    this.onOperationFinished = options.onOperationFinished ?? (() => {})
  }

  async list(): Promise<PluginList> {
    this.assertAvailable()
    if (this.activeOperationId !== undefined) throw new Error('plugin operation is already running')
    const runtime = this.requireRuntime()
    try {
      const result = await this.execute(runtime, ['plugin', '--profile', 'web', 'list', '--depth', '0', '--json'], MAX_LIST_BYTES)
      if (result.code !== 0) throw new Error(this.processFailure('list', result))
      return await parsePluginList(result.stdout, join(this.home, 'profiles', 'web'), this.readText)
    } catch (error: unknown) {
      throw new Error(this.redact(error instanceof Error ? error.message : String(error)))
    }
  }

  async updates(): Promise<PluginUpdateList> {
    this.assertAvailable()
    if (this.activeOperationId !== undefined) return { entries: [] }
    const runtime = this.requireRuntime()
    try {
      const result = await this.execute(runtime, [
        'plugin', '--profile', 'web', 'outdated', '--format', 'json', '--prod', '--compatible', '--silent',
      ], MAX_UPDATE_BYTES, UPDATE_CHECK_TIMEOUT_MS, 'plugin update check')
      if (result.code !== 0 && result.code !== 1) throw new Error('plugin update check failed')
      return parsePluginUpdates(result.stdout)
    } catch {
      throw new Error('无法检查插件更新')
    }
  }

  async start(value: unknown, prepare: () => Promise<void> = async () => {}): Promise<{ operationId: string }> {
    this.assertAvailable()
    if (this.activeOperationId !== undefined || this.pendingRestartOperationId !== undefined) {
      throw new Error('plugin operation is already running')
    }
    const input = parseStartInput(value)
    const runtime = this.requireRuntime()
    const operationId = randomUUID()
    const argument = input.action === 'add' ? input.spec : input.packageName
    const args = ['plugin', '--profile', 'web', input.action, argument]
    const record: OperationRecord = {
      operationId,
      state: 'running',
      action: input.action,
      ...(input.action === 'add' ? {} : { packageName: input.packageName }),
      output: '',
    }
    this.operations.set(operationId, record)
    this.activeOperationId = operationId
    this.trimOperations()
    let settled = false
    let repairAttempted = false
    const finish = (state: 'succeeded' | 'failed', error?: string): void => {
      if (settled) return
      settled = true
      if (record.timer !== undefined) clearTimeout(record.timer)
      delete record.timer
      delete record.child
      record.state = state
      if (state === 'succeeded') this.pendingRestartOperationId = operationId
      if (error === undefined) delete record.error
      else record.error = error
      if (this.activeOperationId === operationId) this.activeOperationId = undefined
      if (!this.disposed) {
        try { this.onOperationFinished(this.status(operationId)) } catch {}
      }
    }
    const runAttempt = (): void => {
      if (settled) return
      if (this.disposed) {
        finish('failed', 'plugin manager is disposed')
        return
      }
      try {
        const child = this.spawn(runtime, args)
        record.child = child
        child.stdout.on('data', chunk => { record.output = appendOutput(record.output, chunk) })
        child.stderr.on('data', chunk => { record.output = appendOutput(record.output, chunk) })
        child.once('error', error => { finish('failed', '无法启动插件管理进程：' + error.message) })
        child.once('close', (code, signal) => {
          if (settled) return
          delete record.child
          if (code === 0) {
            finish('succeeded')
            return
          }
          if (signal === null
            && !repairAttempted
            && !this.disposed
            && this.activeOperationId === operationId
            && record.output.includes(VIRTUAL_STORE_MISMATCH)) {
            repairAttempted = true
            record.output = appendOutput(record.output, '\n检测到旧版 pnpm 元数据不兼容，正在重建后重试...\n')
            const metadata = join(this.home, 'profiles', 'web', 'node_modules', '.modules.yaml')
            void this.removeFile(metadata).then(
              () => {
                if (this.disposed || this.activeOperationId !== operationId) return
                runAttempt()
              },
              (error: unknown) => {
                const detail = error instanceof Error ? error.message : String(error)
                finish('failed', '无法重建旧插件目录：' + detail)
              },
            )
            return
          }
          finish('failed', signal === null ? '插件操作退出码：' + String(code ?? 'unknown') : '插件操作被终止：' + signal)
        })
      } catch (error: unknown) {
        finish('failed', error instanceof Error ? error.message : String(error))
      }
    }
    record.timer = setTimeout(() => {
      record.child?.kill('SIGTERM')
      finish('failed', '插件操作超时')
    }, OPERATION_TIMEOUT_MS)
    record.timer.unref()
    try {
      await prepare()
    } catch (error: unknown) {
      finish('failed', '无法准备插件变更：' + (error instanceof Error ? error.message : String(error)))
    }
    runAttempt()
    return { operationId }
  }

  status(value: unknown): PluginOperationStatus {
    this.assertAvailable()
    const operationId = boundedText(value, 'operationId', 128)
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) {
      throw new Error('operationId is invalid')
    }
    const record = this.operations.get(operationId)
    if (record === undefined) throw new Error('plugin operation was not found')
    return {
      operationId: record.operationId,
      state: record.state,
      action: record.action,
      ...(record.packageName === undefined ? {} : { packageName: record.packageName }),
      output: this.redact(record.output),
      ...(record.error === undefined ? {} : { error: this.redact(record.error) }),
    }
  }

  current(): PluginOperationStatus | undefined {
    this.assertAvailable()
    const operationId = this.activeOperationId ?? this.pendingRestartOperationId
    return operationId === undefined ? undefined : this.status(operationId)
  }

  markRestarted(value: unknown): void {
    const operation = this.status(value)
    if (this.pendingRestartOperationId !== operation.operationId) {
      throw new Error('plugin operation is not pending Runtime restart')
    }
    this.pendingRestartOperationId = undefined
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const active = this.activeOperationId === undefined ? undefined : this.operations.get(this.activeOperationId)
    if (active?.timer !== undefined) clearTimeout(active.timer)
    active?.child?.kill('SIGTERM')
    this.activeOperationId = undefined
  }

  private execute(
    runtime: InstalledRuntime,
    args: readonly string[],
    limit: number,
    timeoutMs = 60_000,
    label = 'plugin list',
  ): Promise<ProcessResult> {
    return this.collect(this.spawn(runtime, args), limit, timeoutMs, label)
  }

  private collect(child: PluginProcess, limit: number, timeoutMs: number, label: string): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish(new Error(label + ' timed out'))
      }, timeoutMs)
      timer.unref()
      const finish = (error?: Error, result?: ProcessResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error !== undefined) reject(error)
        else resolve(result as ProcessResult)
      }
      child.stdout.on('data', chunk => {
        stdout += String(chunk)
        if (Buffer.byteLength(stdout, 'utf8') > limit) {
          child.kill('SIGTERM')
          finish(new Error(label + ' output is too large'))
        }
      })
      child.stderr.on('data', chunk => { stderr = appendOutput(stderr, chunk) })
      child.once('error', error => { finish(error) })
      child.once('close', (code, signal) => { finish(undefined, { stdout, stderr, code, signal }) })
    })
  }

  private spawn(runtime: InstalledRuntime, args: readonly string[]): PluginProcess {
    return this.runProcess(runtime.nodeExecutable, [runtime.dshBin, ...args], this.processOptions(runtime, this.home))
  }

  private processOptions(runtime: InstalledRuntime, cwd: string): PluginProcessOptions {
    const inheritedPath = Object.entries(this.environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
    const path = [dirname(runtime.pnpmExecutable), dirname(runtime.nodeExecutable), inheritedPath]
      .filter(value => value.length > 0)
      .join(delimiter)
    const env = { ...this.environment }
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
    return {
      cwd,
      env: { ...env, DSH_HOME: this.home, PATH: path },
      shell: false,
      windowsHide: true,
    }
  }

  private processFailure(operation: string, result: ProcessResult): string {
    const detail = this.redact(result.stderr).trim()
    const reason = result.signal === null ? 'exit code ' + String(result.code ?? 'unknown') : 'signal ' + result.signal
    return detail.length === 0 ? 'plugin ' + operation + ' failed with ' + reason : 'plugin ' + operation + ' failed with ' + reason + ': ' + detail
  }

  private redact(value: string): string {
    const runtime = this.runtimeProvider()
    return redactPaths(value, [
      this.home,
      runtime?.directory ?? '',
      runtime?.nodeExecutable ?? '',
      runtime?.pnpmExecutable ?? '',
      runtime?.dshBin ?? '',
    ])
  }

  private requireRuntime(): InstalledRuntime {
    const runtime = this.runtimeProvider()
    if (runtime === undefined) throw new Error('DSH Runtime 尚未安装')
    return runtime
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error('plugin manager is disposed')
  }

  private trimOperations(): void {
    while (this.operations.size > 16) {
      const oldest = this.operations.keys().next().value as string | undefined
      if (oldest === undefined || oldest === this.activeOperationId) return
      this.operations.delete(oldest)
    }
  }
}
