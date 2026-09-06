import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { gte } from 'semver'
import { parse, stringify } from 'yaml'
import { desktopEnvironment } from './backend.ts'
import { validatePackageName } from './plugin-manager.ts'
import type { InstalledRuntime } from './runtime-store.ts'

export type IsolationReason = 'manual' | 'removed-client-runtime' | 'import-incompatible'
export interface IsolatedPlugin { name: string; reason: IsolationReason }
export class PluginImportFailure extends Error {
  constructor(readonly packages: string[]) {
    super('插件导入不兼容：' + packages.join(', '))
  }
}
type Target = { id: string; name: string; disabled: true }
const run = promisify(execFile)
const legacyClient = '@deepseek-ai/dsh-client-runtime'

export function thirdParty(name: string): boolean {
  try { return validatePackageName(name) === name && !name.startsWith('@deepseek-ai/') }
  catch { return false }
}

export function classifyPluginFailure(diagnostics: string): string[] {
  const clean = diagnostics.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, '')
  const names = new Set<string>()
  for (const match of clean.matchAll(/failed to import loader entry [\w-]+ \(([^)]+)\): ([^\n]+)/gu)) {
    const name = match[1]!
    const reason = match[2]!
    if (thirdParty(name) && /(?:client-modules: require\("[^"\n]+"\) missed the module table|Cannot find (?:package|module) ['"]|does not provide an export named)/u.test(reason)) names.add(name)
  }
  return [...names]
}

export function isolationTargets(value: unknown, packages: readonly string[], requireEnabled = false): Target[] {
  if (!Array.isArray(value)) throw new Error('Invalid Runtime composition')
  const names = new Set(packages.filter(thirdParty))
  const ids = new Set<string>()
  const targets: Target[] = []
  const visit = (rows: unknown[], depth: number, parentDisabled = false): void => {
    if (depth > 32) throw new Error('Runtime composition is too deep')
    for (const row of rows) {
      if (row === null || typeof row !== 'object') throw new Error('Invalid Runtime entry')
      const entry = row as Record<string, unknown>
      const disabled = parentDisabled || (entry.disabled !== undefined && entry.disabled !== null && entry.disabled !== false)
      if (typeof entry.id === 'string') {
        if (ids.has(entry.id)) throw new Error('Runtime entry ID is ambiguous')
        ids.add(entry.id)
      }
      if (typeof entry.name === 'string' && names.has(entry.name)) {
        if (typeof entry.id !== 'string' || entry.id.length === 0 || entry.group) throw new Error('Plugin cannot be isolated safely')
        if (requireEnabled && disabled) throw new Error('插件仍被用户配置或条件禁用，无法验证；原配置未修改')
        targets.push({ id: entry.id, name: entry.name, disabled: true })
      }
      if (entry.group && Array.isArray(entry.config)) visit(entry.config, depth + 1, disabled)
    }
  }
  visit(value, 0)
  return targets
}

export class PluginIsolation {
  private readonly filename: string

  constructor(private readonly options: { home: string; directory: string }) {
    const key = createHash('sha256').update(resolve(options.home).toLowerCase()).digest('hex').slice(0, 24)
    this.filename = join(options.directory, `plugin-isolation-${key}.json`)
  }

  supported(runtime: InstalledRuntime): boolean {
    return gte(runtime.manifest.dshVersion, '0.1.3-alpha.1')
  }

  async packages(): Promise<string[]> {
    try {
      const manifest = JSON.parse(await readFile(join(this.options.home, 'profiles/web/package.json'), 'utf8'))
      return Object.keys(manifest.dependencies ?? {}).filter(thirdParty)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  async list(): Promise<IsolatedPlugin[]> {
    try {
      const state = JSON.parse(await readFile(this.filename, 'utf8'))
      if (state.schemaVersion !== 1 || !Array.isArray(state.plugins) || state.plugins.length > 1000
        || state.plugins.some((row: IsolatedPlugin) => !row || !thirdParty(row.name) || !['manual', 'removed-client-runtime', 'import-incompatible'].includes(row.reason))) {
        throw new Error('Invalid Shell plugin isolation state')
      }
      return state.plugins
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  }

  private async save(plugins: IsolatedPlugin[]): Promise<void> {
    await mkdir(this.options.directory, { recursive: true })
    const temporary = this.filename + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, JSON.stringify({ schemaVersion: 1, plugins }, null, 2), { flag: 'wx', mode: 0o600 })
      await rename(temporary, this.filename)
    } finally { await rm(temporary, { force: true }) }
  }

  async disable(name: string, reason: IsolationReason): Promise<void> {
    if (!(await this.packages()).includes(name)) throw new Error('Only explicitly installed third-party plugins can be isolated')
    const rows = await this.list()
    await this.save([...rows.filter(row => row.name !== name), { name, reason }])
  }

  async validate(name: string, attempt: () => Promise<void>): Promise<void> {
    if (!(await this.list()).some(row => row.name === name)) throw new Error('Plugin is not isolated')
    await attempt()
    await this.save((await this.list()).filter(row => row.name !== name))
  }

  async incompatible(runtime: InstalledRuntime): Promise<string[]> {
    if (!this.supported(runtime)) return []
    try { createRequire(runtime.dshBin).resolve(legacyClient + '/client'); return [] }
    catch { /* Only the known removed client module is preflighted. */ }
    const names: string[] = []
    for (const name of await this.packages()) {
      try {
        const manifest = JSON.parse(await readFile(join(this.options.home, 'profiles/web/node_modules', name, 'package.json'), 'utf8'))
        const inject = manifest.dsh?.client?.inject
        if (manifest.name === name && Array.isArray(inject) && inject.includes(legacyClient)) names.push(name)
      } catch { /* Missing or unreadable packages retain the normal Runtime diagnostic. */ }
    }
    return names
  }

  async composition(runtime: InstalledRuntime, environment: NodeJS.ProcessEnv): Promise<unknown> {
    try {
      const { stdout } = await run(runtime.nodeExecutable, [runtime.dshBin, 'web', '--dump-config', '--patch', join(runtime.directory, 'app/desktop.patch.yml')], {
        cwd: this.options.home, env: desktopEnvironment(runtime, environment), windowsHide: true,
        timeout: 30_000, maxBuffer: 4 * 1024 * 1024,
      })
      return parse(stdout, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as unknown
    } catch {
      // A config dump can contain credentials; never surface child output or persist it.
      throw new Error('无法读取 Runtime 插件组合，未修改插件配置')
    }
  }

  async quarantine(runtime: InstalledRuntime, environment: NodeJS.ProcessEnv, diagnostics: string | PluginImportFailure): Promise<boolean> {
    if (!this.supported(runtime)) return false
    const installed = await this.packages()
    const isolated = new Set((await this.list()).map(row => row.name))
    const failures = typeof diagnostics === 'string' ? classifyPluginFailure(diagnostics) : diagnostics.packages
    const candidates = failures.filter(name => installed.includes(name) && !isolated.has(name))
    if (!candidates.length) return false
    const targets = isolationTargets(await this.composition(runtime, environment), candidates)
    for (const name of candidates.filter(name => targets.some(target => target.name === name))) await this.disable(name, 'import-incompatible')
    return targets.length > 0
  }

  async prepare(runtime: InstalledRuntime, environment: NodeJS.ProcessEnv, trial?: string): Promise<{ path: string; dispose(): Promise<void> } | undefined> {
    if (!this.supported(runtime)) {
      if ((await this.list()).length) throw new Error('当前 Runtime 不支持 Shell 插件隔离，请切换到支持的版本')
      return undefined
    }
    const incompatible = await this.incompatible(runtime)
    if (trial !== undefined && incompatible.includes(trial)) throw new Error('插件仍依赖已移除的客户端模块，已保持隔离')
    const records = await this.list()
    const names = [...new Set([...records.map(row => row.name), ...incompatible])].filter(name => name !== trial)
    if (!names.length && trial === undefined) return undefined
    const composition = await this.composition(runtime, environment)
    if (trial !== undefined && isolationTargets(composition, [trial], true).length === 0) throw new Error('插件未包含在 Runtime 组合中，无法验证')
    const targets = isolationTargets(composition, names)
    for (const name of incompatible) {
      if (!records.some(row => row.name === name) && targets.some(target => target.name === name)) await this.disable(name, 'removed-client-runtime')
    }
    const installed = await this.packages()
    if (names.some(name => installed.includes(name) && !targets.some(target => target.name === name))) {
      throw new Error('无法定位已隔离插件的 Runtime 条目，已停止启动以避免意外加载')
    }
    if (!targets.length) return undefined
    await mkdir(this.options.directory, { recursive: true })
    const path = join(this.options.directory, `plugin-isolation-overlay-${randomUUID()}.yml`)
    await writeFile(path, stringify(targets), { flag: 'wx', mode: 0o600 })
    return { path, async dispose() { await rm(path, { force: true }) } }
  }
}
