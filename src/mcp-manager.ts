import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { isScalar, isSeq, parseDocument } from 'yaml'
import { parseCodexMcpEntries, type CodexMcpEntry } from './codex-mcp.ts'

const MAX_PACKAGE_BYTES = 256 * 1024
const MAX_PATCH_BYTES = 1024 * 1024
const MAX_BUNDLES = 100
const SECRET_FLAG = /(?:api[-_]?key|auth|bearer|credential|password|secret|token)/iu
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u

type McpTransport = 'stdio' | 'streamable-http' | 'unknown'
type DataPath = (string | number)[]
type MutableLayer = 'profile' | 'home'

interface ControlLocation {
  layer: MutableLayer
  path: DataPath
}

export interface McpEndpointView {
  name: string
  transport: McpTransport
  command?: string
  args?: string[]
  cwd?: string
  environmentKeys?: string[]
  url?: string
  headerKeys?: string[]
}

export interface McpEntryView {
  key: string
  entryId?: string
  name: string
  provider: 'DSH MCP Client' | 'MCP Lens' | 'Codex MCP'
  management: 'dsh' | 'codex-import'
  enabled: boolean
  dynamic?: boolean
  sourceEnabled?: boolean
  mutable: boolean
  source: string
  endpoints: McpEndpointView[]
  allowToolCount?: number
  denyToolCount?: number
}

export interface McpList {
  revision: string
  entries: McpEntryView[]
}

export interface McpSetEnabledInput {
  key: string
  enabled: boolean
  expectedRevision: string
}

interface McpManagerOptions {
  home: string
  profile?: string
  overlayPaths?: () => readonly string[]
  codexConfigPath?: string
}

interface ConfigEntry {
  id?: string
  name?: string
  config?: unknown
  disabled?: unknown
  source: string
  control?: ControlLocation
  locked?: boolean
}

interface InternalEntry {
  view: McpEntryView
  entryId?: string
  entryName?: string
  control?: ControlLocation
  codexImported?: boolean
  codexConfig?: Record<string, unknown>
}

interface ParsedPatch {
  document: ReturnType<typeof parseDocument>
  data: unknown[]
}

interface MutablePatchDocument {
  path: string
  document: ReturnType<typeof parseDocument>
}

interface LoadedState {
  revision: string
  profileDocument: MutablePatchDocument
  homeDocument?: MutablePatchDocument
  entries: InternalEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function own(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function boundedText(value: unknown, limit = 4096): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= limit ? value : undefined
}

function stringArray(value: unknown, limit = 256): string[] {
  if (!Array.isArray(value) || value.length > limit) return []
  return value.flatMap(item => typeof item === 'string' && item.length <= 4096 ? [item] : [])
}

function recordKeys(value: unknown): string[] {
  if (!isRecord(value)) return []
  return Object.keys(value).filter(key => key.length <= 256).sort((left, right) => left.localeCompare(right))
}

function sanitizeUrl(value: unknown): string | undefined {
  const text = boundedText(value)
  if (text === undefined) return undefined
  try {
    const url = new URL(text)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.href
  } catch {
    return undefined
  }
}

function sanitizeArgs(value: unknown): string[] {
  const args = stringArray(value)
  let hideNext = false
  return args.map(argument => {
    if (hideNext) {
      hideNext = false
      return '[hidden]'
    }
    const separator = argument.indexOf('=')
    if (separator > 0 && SECRET_FLAG.test(argument.slice(0, separator))) {
      return argument.slice(0, separator + 1) + '[hidden]'
    }
    if (argument.startsWith('-') && SECRET_FLAG.test(argument)) hideNext = true
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(argument)) return sanitizeUrl(argument) ?? '[invalid URL]'
    return argument
  })
}

function transport(value: unknown): McpTransport {
  return value === 'stdio' || value === 'streamable-http' ? value : 'unknown'
}

function endpoint(value: unknown, fallbackName: string): McpEndpointView | undefined {
  if (!isRecord(value)) return undefined
  const name = boundedText(value.name, 128) ?? boundedText(value.serverName, 128) ?? fallbackName
  const selectedTransport = transport(value.transport)
  if (selectedTransport === 'stdio') {
    const command = boundedText(value.command)
    const cwd = boundedText(value.cwd)
    return {
      name,
      transport: selectedTransport,
      ...(command === undefined ? {} : { command }),
      ...(own(value, 'args') ? { args: sanitizeArgs(value.args) } : {}),
      ...(cwd === undefined ? {} : { cwd }),
      ...(own(value, 'env') ? { environmentKeys: recordKeys(value.env) } : {}),
    }
  }
  if (selectedTransport === 'streamable-http') {
    const url = sanitizeUrl(value.url)
    return {
      name,
      transport: selectedTransport,
      ...(url === undefined ? {} : { url }),
      ...(own(value, 'headers') ? { headerKeys: recordKeys(value.headers) } : {}),
    }
  }
  return { name, transport: selectedTransport }
}

function isDirectClientName(value: string | undefined): boolean {
  return value === '@deepseek-ai/dsh-mcp-client'
}

function isLensEntry(value: ConfigEntry): boolean {
  return value.name === 'dsh-mcp-lens'
}

function keyFor(provider: string, id: string | undefined, source: string, index: number): string {
  return createHash('sha256').update(provider).update('\0').update(id ?? '').update('\0').update(source).update('\0').update(String(index)).digest('hex').slice(0, 24)
}

function revision(sources: readonly string[]): string {
  const hash = createHash('sha256')
  for (const source of sources) hash.update(String(Buffer.byteLength(source, 'utf8'))).update(':').update(source)
  return hash.digest('hex')
}

function parsePatch(source: string, path: string): ParsedPatch {
  if (Buffer.byteLength(source, 'utf8') > MAX_PATCH_BYTES) throw new Error('MCP 配置文件超过 1 MiB，拒绝读取：' + path)
  const document = parseDocument(source.trim().length === 0 ? '[]\n' : source)
  if (document.errors.length > 0) throw new Error('MCP 配置 YAML 无效：' + document.errors[0]?.message)
  const data = document.toJS({ maxAliasCount: 100 }) as unknown
  if (!Array.isArray(data)) throw new Error('MCP 配置必须是顶层 YAML 数组：' + path)
  return { document, data }
}

function applyOverrides(
  target: ConfigEntry,
  patch: Record<string, unknown>,
  control: ControlLocation | undefined,
  lockLayer: boolean,
): void {
  if (typeof patch.name === 'string' && target.name !== undefined && patch.name !== target.name) return
  if (own(patch, 'config')) target.config = patch.config
  if (own(patch, 'disabled')) {
    target.disabled = patch.disabled
    if (lockLayer) target.locked = true
  }
  if (control !== undefined) target.control = control
}

function entryFrom(
  value: Record<string, unknown>,
  source: string,
  control: ControlLocation | undefined,
  locked: boolean,
): ConfigEntry {
  const id = boundedText(value.id, 256)
  const name = boundedText(value.name, 512)
  return {
    ...(id === undefined ? {} : { id }),
    ...(name === undefined ? {} : { name }),
    ...(own(value, 'config') ? { config: value.config } : {}),
    ...(own(value, 'disabled') ? { disabled: value.disabled } : {}),
    source,
    ...(control === undefined ? {} : { control }),
    ...(locked ? { locked: true } : {}),
  }
}

function applyPatchLayer(
  data: unknown[],
  source: string,
  entries: Map<string, ConfigEntry>,
  anonymous: ConfigEntry[],
  options: { controlLayer?: MutableLayer; lockLayer?: boolean } = {},
): void {
  const lockLayer = options.lockLayer === true
  const controlAt = (path: DataPath | undefined): ControlLocation | undefined => {
    return path === undefined || options.controlLayer === undefined ? undefined : { layer: options.controlLayer, path }
  }
  const addEntry = (value: unknown, path: DataPath | undefined): void => {
    if (!isRecord(value)) return
    const configEntry = entryFrom(value, source, controlAt(path), lockLayer)
    if (configEntry.id === undefined) anonymous.push(configEntry)
    else entries.set(configEntry.id, configEntry)
    if (value.group === true && Array.isArray(value.config)) {
      value.config.forEach((child, index) => addEntry(child, path === undefined ? undefined : [...path, 'config', index]))
    }
  }

  data.forEach((value, index) => {
    if (!isRecord(value)) return
    if (Array.isArray(value.insert)) {
      value.insert.forEach((inserted, insertedIndex) => addEntry(inserted, [index, 'insert', insertedIndex]))
      return
    }
    const id = boundedText(value.id, 256)
    if (id === undefined) return
    const target = entries.get(id)
    if (target !== undefined) applyOverrides(target, value, controlAt([index]), lockLayer)
  })
}

function toInternalEntry(value: ConfigEntry, index: number): InternalEntry | undefined {
  if (isDirectClientName(value.name)) {
    const config = isRecord(value.config) ? value.config : {}
    const server = endpoint(config, value.id ?? 'MCP Server')
    const displayName = boundedText(config.serverName, 128) ?? value.id ?? 'MCP Server'
    const dynamic = value.disabled !== undefined && value.disabled !== null && typeof value.disabled !== 'boolean'
    const view: McpEntryView = {
      key: keyFor('direct', value.id, value.source, index),
      ...(value.id === undefined ? {} : { entryId: value.id }),
      name: displayName,
      provider: 'DSH MCP Client',
      management: 'dsh',
      enabled: !dynamic && value.disabled !== true,
      ...(dynamic ? { dynamic: true } : {}),
      mutable: value.id !== undefined && value.locked !== true,
      source: value.source,
      endpoints: server === undefined ? [] : [server],
    }
    return {
      view,
      ...(value.id === undefined ? {} : { entryId: value.id }),
      ...(value.name === undefined ? {} : { entryName: value.name }),
      ...(value.control === undefined ? {} : { control: value.control }),
    }
  }
  if (!isLensEntry(value)) return undefined
  const config = isRecord(value.config) ? value.config : {}
  const servers = Array.isArray(config.servers) ? config.servers : []
  const endpoints = servers.flatMap((server, serverIndex) => {
    const result = endpoint(server, 'Server ' + String(serverIndex + 1))
    return result === undefined ? [] : [result]
  })
  const dynamic = value.disabled !== undefined && value.disabled !== null && typeof value.disabled !== 'boolean'
  const view: McpEntryView = {
    key: keyFor('lens', value.id, value.source, index),
    ...(value.id === undefined ? {} : { entryId: value.id }),
    name: 'MCP Lens',
    provider: 'MCP Lens',
    management: 'dsh',
    enabled: !dynamic && value.disabled !== true,
    ...(dynamic ? { dynamic: true } : {}),
    mutable: value.id !== undefined && value.locked !== true,
    source: value.source,
    endpoints,
    ...(Array.isArray(config.allowTools) ? { allowToolCount: config.allowTools.length } : {}),
    ...(Array.isArray(config.denyTools) ? { denyToolCount: config.denyTools.length } : {}),
  }
  return {
    view,
    ...(value.id === undefined ? {} : { entryId: value.id }),
    ...(value.name === undefined ? {} : { entryName: value.name }),
    ...(value.control === undefined ? {} : { control: value.control }),
  }
}

function codexImportId(name: string): string {
  return 'desktop-codex-' + createHash('sha256').update(name).digest('hex').slice(0, 16)
}

function codexServerName(name: string): string {
  return /^[A-Za-z0-9_-]{1,32}$/u.test(name)
    ? name
    : 'codex_' + createHash('sha256').update(name).digest('hex').slice(0, 12)
}

function codexDshConfig(value: CodexMcpEntry): Record<string, unknown> | undefined {
  const serverName = codexServerName(value.name)
  if (value.transport === 'stdio' && value.command !== undefined) {
    return {
      serverName,
      transport: 'stdio',
      command: value.command,
      ...(value.args === undefined ? {} : { args: value.args }),
      ...(Object.keys(value.environment).length === 0 ? {} : { env: value.environment }),
      ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    }
  }
  if (value.transport === 'streamable-http' && value.url !== undefined) {
    return {
      serverName,
      transport: 'streamable-http',
      url: value.url,
      ...(Object.keys(value.headers).length === 0 ? {} : { headers: value.headers }),
    }
  }
  return undefined
}

function toInternalCodexEntry(value: CodexMcpEntry, target: ConfigEntry | undefined, index: number): InternalEntry {
  const entryId = codexImportId(value.name)
  const imported = target?.name === '@deepseek-ai/dsh-mcp-client'
  const identityConflict = target !== undefined && !imported
  const dynamic = imported && target.disabled !== undefined && target.disabled !== null && typeof target.disabled !== 'boolean'
  const config = codexDshConfig(value)
  const server = endpoint({
    name: value.name,
    transport: value.transport,
    ...(value.command === undefined ? {} : { command: value.command }),
    ...(value.args === undefined ? {} : { args: value.args }),
    ...(value.cwd === undefined ? {} : { cwd: value.cwd }),
    ...(Object.keys(value.environment).length === 0 ? {} : { env: value.environment }),
    ...(value.url === undefined ? {} : { url: value.url }),
    ...(Object.keys(value.headers).length === 0 ? {} : { headers: value.headers }),
  }, value.name)
  return {
    view: {
      key: keyFor('codex', entryId, 'Codex 配置', index),
      entryId,
      name: value.name,
      provider: 'Codex MCP',
      management: 'codex-import',
      enabled: imported && !dynamic && target.disabled !== true,
      sourceEnabled: value.enabled,
      ...(dynamic ? { dynamic: true } : {}),
      mutable: config !== undefined && !identityConflict && target?.locked !== true,
      source: imported ? 'Codex → DSH' : 'Codex 配置（未接入 DSH）',
      endpoints: server === undefined ? [] : [server],
    },
    entryId,
    entryName: '@deepseek-ai/dsh-mcp-client',
    ...(target?.control === undefined ? {} : { control: target.control }),
    codexImported: imported,
    ...(config === undefined ? {} : { codexConfig: config }),
  }
}

function parseSetEnabledInput(value: unknown): McpSetEnabledInput {
  if (!isRecord(value)) throw new TypeError('MCP 开关请求无效')
  const key = boundedText(value.key, 64)
  const expectedRevision = boundedText(value.expectedRevision, 64)
  if (key === undefined || !/^[a-f0-9]{24}$/u.test(key) || typeof value.enabled !== 'boolean'
    || expectedRevision === undefined || !/^[a-f0-9]{64}$/u.test(expectedRevision)) {
    throw new TypeError('MCP 开关请求无效')
  }
  return { key, enabled: value.enabled, expectedRevision }
}

function retryableRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.desktop-' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    for (let attempt = 0; ; attempt += 1) {
      try {
        await rename(temporary, path)
        return
      } catch (error: unknown) {
        if (attempt >= 9 || !retryableRename(error)) throw error
        await delay(50)
      }
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => {})
  }
}

async function readBounded(path: string, limit: number, optional = false): Promise<string | undefined> {
  let value: string
  try {
    value = await readFile(path, 'utf8')
  } catch (error: unknown) {
    if (optional && (error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return undefined
    throw error
  }
  if (Buffer.byteLength(value, 'utf8') > limit) throw new Error('配置文件过大，拒绝读取：' + path)
  return value
}

export class McpManager {
  readonly profileDirectory: string
  readonly patchPath: string
  readonly homePatchPath: string
  readonly codexConfigPath: string | undefined
  private readonly overlayPaths: () => readonly string[]

  constructor(options: McpManagerOptions) {
    const profile = options.profile ?? 'web'
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(profile)) throw new TypeError('invalid DSH profile name')
    this.profileDirectory = join(options.home, 'profiles', profile)
    this.patchPath = join(this.profileDirectory, 'cordis.patch.yml')
    this.homePatchPath = join(options.home, 'cordis.patch.yml')
    this.codexConfigPath = options.codexConfigPath
    this.overlayPaths = options.overlayPaths ?? (() => [])
  }

  async list(): Promise<McpList> {
    const state = await this.load()
    return { revision: state.revision, entries: state.entries.map(entry => entry.view) }
  }

  async setEnabled(value: unknown): Promise<McpList> {
    const input = parseSetEnabledInput(value)
    const state = await this.load()
    if (state.revision !== input.expectedRevision) throw new Error('MCP 配置已被其他程序修改，请刷新后重试')
    const target = state.entries.find(entry => entry.view.key === input.key)
    if (target === undefined) throw new Error('MCP 配置项已不存在，请刷新后重试')
    if (target.entryId === undefined) throw new Error('该 MCP 缺少稳定的 Cordis entry id，无法安全切换')
    if (!target.view.mutable) {
      if (target.view.management === 'codex-import') throw new Error('该 Codex MCP 无法安全接入 DSH，请检查传输配置或 Entry ID 冲突')
      throw new Error('该 MCP 状态由更高优先级的桌面 Runtime overlay 控制')
    }
    if (target.view.dynamic !== true && target.view.enabled === input.enabled) {
      return { revision: state.revision, entries: state.entries.map(entry => entry.view) }
    }

    const selected = target.control?.layer === 'home' ? state.homeDocument : state.profileDocument
    if (selected === undefined) throw new Error('MCP 全局配置文件已不存在，请刷新后重试')
    const document = selected.document
    if (target.view.management === 'codex-import' && target.codexImported !== true) {
      if (target.codexConfig === undefined) throw new Error('该 Codex MCP 的传输配置无法转换为 DSH MCP Client')
      if (!isSeq(document.contents)) throw new Error('MCP 配置必须是顶层 YAML 数组')
      document.contents.flow = false
      document.contents.add({
        insert: [{
          id: target.entryId,
          name: target.entryName,
          config: target.codexConfig,
          disabled: false,
        }],
      })
    } else if (target.control !== undefined) {
      const disabledPath = [...target.control.path, 'disabled']
      document.setIn(disabledPath, !input.enabled)
      const disabledNode = document.getIn(disabledPath, true)
      if (isScalar(disabledNode)) delete disabledNode.tag
    } else {
      if (!isSeq(document.contents)) throw new Error('MCP 配置必须是顶层 YAML 数组')
      document.contents.flow = false
      document.contents.add({
        id: target.entryId,
        ...(target.entryName === undefined ? {} : { name: target.entryName }),
        disabled: !input.enabled,
      })
    }
    const output = String(document)
    parsePatch(output, selected.path)
    await atomicWrite(selected.path, output)
    return this.list()
  }

  private async load(): Promise<LoadedState> {
    const profileSource = await readBounded(this.patchPath, MAX_PATCH_BYTES, true) ?? '[]\n'
    const profilePatch = parsePatch(profileSource, this.patchPath)
    const homeSource = await readBounded(this.homePatchPath, MAX_PATCH_BYTES, true)
    const homePatch = homeSource === undefined ? undefined : parsePatch(homeSource, this.homePatchPath)
    const codexSource = this.codexConfigPath === undefined
      ? undefined
      : await readBounded(this.codexConfigPath, MAX_PATCH_BYTES, true)
    const codexEntries = codexSource === undefined || this.codexConfigPath === undefined
      ? []
      : parseCodexMcpEntries(codexSource, this.codexConfigPath)
    const entries = new Map<string, ConfigEntry>()
    const anonymous: ConfigEntry[] = []
    const revisionSources = [this.patchPath, profileSource, this.homePatchPath, homeSource ?? '<missing>']
    if (this.codexConfigPath !== undefined) revisionSources.push(this.codexConfigPath, codexSource ?? '<missing>')
    await this.loadBundleLayers(entries, anonymous, revisionSources)
    applyPatchLayer(profilePatch.data, 'Profile 配置', entries, anonymous, { controlLayer: 'profile' })
    if (homePatch !== undefined) applyPatchLayer(homePatch.data, '全局配置', entries, anonymous, { controlLayer: 'home' })

    const overlayPaths = [...new Set(this.overlayPaths())]
    if (overlayPaths.length > MAX_BUNDLES) throw new Error('桌面 Runtime overlay 数量超过安全上限')
    for (const overlayPath of overlayPaths) {
      const source = await readBounded(overlayPath, MAX_PATCH_BYTES, true)
      revisionSources.push(overlayPath, source ?? '<missing>')
      if (source === undefined) continue
      const overlay = parsePatch(source, overlayPath)
      applyPatchLayer(overlay.data, basename(overlayPath), entries, anonymous, { lockLayer: true })
    }

    const codexIds = new Set(codexEntries.map(entry => codexImportId(entry.name)))
    const dshResolved = [...entries.values(), ...anonymous]
      .filter(entry => entry.id === undefined || !codexIds.has(entry.id) || !isDirectClientName(entry.name))
      .map((entry, index) => toInternalEntry(entry, index))
      .filter((entry): entry is InternalEntry => entry !== undefined)
    const codexResolved = codexEntries.map((entry, index) => {
      return toInternalCodexEntry(entry, entries.get(codexImportId(entry.name)), index)
    })
    const resolved = [...dshResolved, ...codexResolved]
      .sort((left, right) => left.view.name.localeCompare(right.view.name, 'zh-CN'))
    return {
      revision: revision(revisionSources),
      profileDocument: { path: this.patchPath, document: profilePatch.document },
      ...(homePatch === undefined ? {} : { homeDocument: { path: this.homePatchPath, document: homePatch.document } }),
      entries: resolved,
    }
  }

  private async loadBundleLayers(
    entries: Map<string, ConfigEntry>,
    anonymous: ConfigEntry[],
    revisionSources: string[],
  ): Promise<void> {
    const manifestPath = join(this.profileDirectory, 'package.json')
    const source = await readBounded(manifestPath, MAX_PACKAGE_BYTES, true)
    revisionSources.push(manifestPath, source ?? '<missing>')
    if (source === undefined) return
    let manifest: unknown
    try { manifest = JSON.parse(source) } catch (error: unknown) {
      throw new Error('DSH Profile package.json 无效', { cause: error })
    }
    if (!isRecord(manifest) || !isRecord(manifest.dsh) || !isRecord(manifest.dsh.profile) || !Array.isArray(manifest.dsh.profile.bundles)) return
    const bundles = manifest.dsh.profile.bundles
    if (bundles.length > MAX_BUNDLES) throw new Error('DSH Profile Bundle 数量超过安全上限')
    for (const bundle of bundles) {
      if (typeof bundle !== 'string' || !PACKAGE_NAME.test(bundle)) continue
      const packageRoot = join(this.profileDirectory, 'node_modules', ...bundle.split('/'))
      const packagePath = join(packageRoot, 'package.json')
      const packageSource = await readBounded(packagePath, MAX_PACKAGE_BYTES, true)
      revisionSources.push(packagePath, packageSource ?? '<missing>')
      if (packageSource === undefined) continue
      let packageManifest: unknown
      try { packageManifest = JSON.parse(packageSource) } catch { continue }
      if (!isRecord(packageManifest) || !isRecord(packageManifest.dsh) || !isRecord(packageManifest.dsh.bundle)) continue
      const patch = boundedText(packageManifest.dsh.bundle.patch, 512)
      if (patch === undefined) continue
      const patchPath = resolve(packageRoot, patch)
      const pathFromRoot = relative(resolve(packageRoot), patchPath)
      if (pathFromRoot.startsWith('..') || isAbsolute(pathFromRoot)) continue
      const patchSource = await readBounded(patchPath, MAX_PATCH_BYTES, true)
      revisionSources.push(patchPath, patchSource ?? '<missing>')
      if (patchSource === undefined) continue
      const parsed = parsePatch(patchSource, patchPath)
      applyPatchLayer(parsed.data, bundle, entries, anonymous)
    }
  }
}
