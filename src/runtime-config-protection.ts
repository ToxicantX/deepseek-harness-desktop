import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { lt } from 'semver'
import { parseDocument, stringify } from 'yaml'

const CONFIGURATION_ROOT = '.desktop-runtime-config'
const BACKUP_DIRECTORY = 'backups'
const PENDING_FILE = 'pending.json'
const MAX_CONFIG_BYTES = 4 * 1024 * 1024
const LEGACY_PROFILE_VERSION = '0.1.7-alpha.1'
const PROTECTED_SECTION_ENTRIES = [
  ['agent-default-model', 'agent-default-model'],
  ['agent-presets', 'agent-preset-registry'],
  ['agent-preset-registry', 'agent-preset-registry'],
  ['llm-deepseek', 'llm-deepseek'],
  ['llm-pi-ai', 'llm-pi-ai'],
] as const
const PROTECTED_ENTRY_IDS = new Set<string>(PROTECTED_SECTION_ENTRIES.map(([, entry]) => entry))
const PROTECTED_FILES = [
  'settings.yaml',
  'settings.yaml.imported',
  join('profiles', 'web', 'cordis.patch.yml'),
] as const

interface SnapshotFile {
  path: string
  existed: boolean
  sha256?: string
}

interface SnapshotManifest {
  schemaVersion: 1
  id: string
  createdAt: string
  fromVersion?: string
  toVersion: string
  files: SnapshotFile[]
}

interface PendingJournal {
  schemaVersion: 1
  id: string
}

export interface RuntimeConfigProtectionInput {
  home: string
  fromVersion?: string
  toVersion: string
}

export interface RuntimeConfigVerifyOptions {
  timeoutMs?: number
  pollMs?: number
}

export interface RuntimeConfigProtection {
  readonly backupDirectory: string
  verify(options?: RuntimeConfigVerifyOptions): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
}

export class RuntimeConfigProtectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'RuntimeConfigProtectionError'
  }
}

export class RuntimeConfigurationLossError extends RuntimeConfigProtectionError {
  readonly sections: string[]

  constructor(sections: string[]) {
    super('Runtime 升级未完整保留模型配置：' + sections.join(', '))
    this.name = 'RuntimeConfigurationLossError'
    this.sections = sections
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function notFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

async function optionalFile(path: string): Promise<Buffer | undefined> {
  let value: Buffer
  try { value = await readFile(path) } catch (error: unknown) {
    if (notFound(error)) return undefined
    throw error
  }
  if (value.length > MAX_CONFIG_BYTES) throw new Error('配置文件过大，无法创建升级保护快照：' + path)
  return value
}

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

function retryableRename(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EBUSY' || code === 'EPERM'
}

async function replaceFile(path: string, value: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = path + '.desktop-' + randomUUID() + '.tmp'
  try {
    await writeFile(temporary, value, { flag: 'wx', mode: 0o600 })
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

async function writeNew(path: string, value: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, value, { flag: 'wx', mode: 0o600 })
}

function configurationDirectory(home: string): string {
  return join(home, CONFIGURATION_ROOT)
}

function pendingPath(home: string): string {
  return join(configurationDirectory(home), PENDING_FILE)
}

function backupPath(home: string, id: string): string {
  return join(configurationDirectory(home), BACKUP_DIRECTORY, id)
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-z0-9-]{10,80}$/u.test(value)
}

function parseJournal(value: Buffer): PendingJournal {
  let parsed: unknown
  try { parsed = JSON.parse(value.toString('utf8')) } catch { throw new Error('Runtime 配置保护事务记录无效') }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !validId(parsed.id)) {
    throw new Error('Runtime 配置保护事务记录无效')
  }
  return { schemaVersion: 1, id: parsed.id }
}

function parseManifest(value: Buffer, expectedId: string): SnapshotManifest {
  let parsed: unknown
  try { parsed = JSON.parse(value.toString('utf8')) } catch { throw new Error('Runtime 配置保护快照清单无效') }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || parsed.id !== expectedId
    || typeof parsed.createdAt !== 'string' || typeof parsed.toVersion !== 'string'
    || (parsed.fromVersion !== undefined && typeof parsed.fromVersion !== 'string')
    || !Array.isArray(parsed.files) || parsed.files.length !== PROTECTED_FILES.length) {
    throw new Error('Runtime 配置保护快照清单无效')
  }
  const files = parsed.files.map((value): SnapshotFile => {
    if (!isRecord(value) || typeof value.path !== 'string' || !PROTECTED_FILES.includes(value.path as typeof PROTECTED_FILES[number])
      || typeof value.existed !== 'boolean'
      || (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)))) {
      throw new Error('Runtime 配置保护快照清单无效')
    }
    return {
      path: value.path,
      existed: value.existed,
      ...(value.sha256 === undefined ? {} : { sha256: value.sha256 }),
    }
  })
  if (new Set(files.map(file => file.path)).size !== PROTECTED_FILES.length) {
    throw new Error('Runtime 配置保护快照清单无效')
  }
  return {
    schemaVersion: 1,
    id: expectedId,
    createdAt: parsed.createdAt,
    ...(parsed.fromVersion === undefined ? {} : { fromVersion: parsed.fromVersion }),
    toVersion: parsed.toVersion,
    files,
  }
}

async function currentJournal(home: string): Promise<PendingJournal | undefined> {
  const value = await optionalFile(pendingPath(home))
  return value === undefined ? undefined : parseJournal(value)
}

async function snapshotManifest(home: string, id: string): Promise<SnapshotManifest> {
  const value = await optionalFile(join(backupPath(home, id), 'manifest.json'))
  if (value === undefined) throw new Error('Runtime 配置保护快照清单不存在')
  return parseManifest(value, id)
}

async function restoreSnapshot(home: string, id: string): Promise<string> {
  const directory = backupPath(home, id)
  const manifest = await snapshotManifest(home, id)
  for (const file of manifest.files) {
    const target = join(home, file.path)
    if (!file.existed) {
      await rm(target, { force: true })
      continue
    }
    const source = await optionalFile(join(directory, file.path))
    if (source === undefined || file.sha256 === undefined || sha256(source) !== file.sha256) {
      throw new Error('Runtime 配置保护快照损坏：' + file.path)
    }
    await replaceFile(target, source)
  }
  return directory
}

export async function recoverPendingRuntimeConfigProtection(home: string): Promise<string | undefined> {
  const journal = await currentJournal(home)
  if (journal === undefined) return undefined
  const directory = await restoreSnapshot(home, journal.id)
  const latest = await currentJournal(home)
  if (latest?.id !== journal.id) throw new Error('Runtime 配置保护事务已被其他进程修改')
  await rm(pendingPath(home), { force: true })
  return directory
}

function yamlValue(source: Buffer, label: string): unknown {
  const document = parseDocument(source.toString('utf8'), { prettyErrors: false })
  if (document.errors.length > 0) throw new Error('无法保护模型配置：' + label + ' YAML 无效')
  try { return document.toJS({ maxAliasCount: 100 }) } catch { throw new Error('无法保护模型配置：' + label + ' YAML 无效') }
}

function protectedSectionsFromSettings(source: Buffer, label: string): Map<string, Record<string, unknown>> {
  const root = yamlValue(source, label)
  if (!isRecord(root)) throw new Error('无法保护模型配置：' + label + ' 必须是 YAML 对象')
  const sections = new Map<string, Record<string, unknown>>()
  for (const [section, entry] of PROTECTED_SECTION_ENTRIES) {
    const value = root[section]
    if (value === undefined) continue
    if (!isRecord(value)) throw new Error('无法保护模型配置：' + label + ' 中的 ' + section + ' 必须是对象')
    sections.set(entry, merge(sections.get(entry) ?? {}, value))
  }
  return sections
}

function protectedSectionsFromPatch(source: Buffer, label: string): Map<string, Record<string, unknown>> {
  const root = yamlValue(source, label)
  if (root === null) return new Map()
  if (!Array.isArray(root)) throw new Error('无法保护模型配置：' + label + ' 必须是 YAML 数组')
  const sections = new Map<string, Record<string, unknown>>()
  const scan = (value: unknown): void => {
    if (!isRecord(value)) return
    const id = typeof value.id === 'string' ? value.id : undefined
    if (id !== undefined && PROTECTED_ENTRY_IDS.has(id) && Object.hasOwn(value, 'config')) {
      if (!isRecord(value.config)) throw new Error('无法保护模型配置：' + label + ' 中的 ' + id + '.config 必须是对象')
      sections.set(id, value.config)
    }
  }
  for (const value of root) {
    scan(value)
    if (isRecord(value) && Array.isArray(value.insert)) value.insert.forEach(scan)
  }
  return sections
}

function merge(under: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const result = { ...under }
  for (const [key, value] of Object.entries(over)) {
    const previous = result[key]
    result[key] = isRecord(previous) && isRecord(value) ? merge(previous, value) : value
  }
  return result
}

function mergeSections(
  target: Map<string, Record<string, unknown>>,
  source: ReadonlyMap<string, Record<string, unknown>>,
): void {
  for (const [id, value] of source) target.set(id, merge(target.get(id) ?? {}, value))
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length
      && expected.every((value, index) => contains(actual[index], value))
  }
  if (isRecord(expected)) {
    return isRecord(actual) && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && contains(actual[key], value))
  }
  return Object.is(actual, expected)
}

function crossesLegacyProfileBoundary(input: RuntimeConfigProtectionInput): boolean {
  return (input.fromVersion === undefined || lt(input.fromVersion, LEGACY_PROFILE_VERSION))
    && !lt(input.toVersion, LEGACY_PROFILE_VERSION)
}

async function expectedModelSections(input: RuntimeConfigProtectionInput): Promise<Map<string, Record<string, unknown>>> {
  const settings = await optionalFile(join(input.home, 'settings.yaml'))
  const imported = await optionalFile(join(input.home, 'settings.yaml.imported'))
  const patch = await optionalFile(join(input.home, 'profiles', 'web', 'cordis.patch.yml'))
  const sections = patch === undefined
    ? new Map<string, Record<string, unknown>>()
    : protectedSectionsFromPatch(patch, 'profiles/web/cordis.patch.yml')
  if (crossesLegacyProfileBoundary(input)) {
    if (settings !== undefined) mergeSections(sections, protectedSectionsFromSettings(settings, 'settings.yaml'))
    else if (imported !== undefined) mergeSections(sections, protectedSectionsFromSettings(imported, 'settings.yaml.imported'))
  } else if (settings !== undefined) {
    // Parse before launch even outside the one-time migration so a malformed legacy file is never renamed unchecked.
    protectedSectionsFromSettings(settings, 'settings.yaml')
  }
  return sections
}

async function prepareLegacyMigration(input: RuntimeConfigProtectionInput): Promise<void> {
  if (!crossesLegacyProfileBoundary(input)) return
  const settingsPath = join(input.home, 'settings.yaml')
  let source = await optionalFile(settingsPath)
  let shouldWrite = false
  if (source === undefined) {
    source = await optionalFile(settingsPath + '.imported')
    if (source === undefined || protectedSectionsFromSettings(source, 'settings.yaml.imported').size === 0) return
    shouldWrite = true
  }
  const root = yamlValue(source, 'settings.yaml')
  if (!isRecord(root)) throw new Error('无法保护模型配置：settings.yaml 必须是 YAML 对象')
  if (root['agent-presets'] !== undefined) {
    root['agent-preset-registry'] = merge(
      isRecord(root['agent-presets']) ? root['agent-presets'] : {},
      isRecord(root['agent-preset-registry']) ? root['agent-preset-registry'] : {},
    )
    delete root['agent-presets']
    source = Buffer.from(stringify(root, { lineWidth: 0 }))
    shouldWrite = true
  }
  if (shouldWrite) await replaceFile(settingsPath, source)
}

async function missingModelSections(home: string, expected: ReadonlyMap<string, Record<string, unknown>>): Promise<string[]> {
  if (expected.size === 0) return []
  const source = await optionalFile(join(home, 'profiles', 'web', 'cordis.patch.yml'))
  if (source === undefined) return [...expected.keys()].sort((left, right) => left.localeCompare(right))
  const actual = protectedSectionsFromPatch(source, 'profiles/web/cordis.patch.yml')
  return [...expected].flatMap(([id, value]) => contains(actual.get(id), value) ? [] : [id])
    .sort((left, right) => left.localeCompare(right))
}

async function createSnapshot(input: RuntimeConfigProtectionInput): Promise<{ id: string; directory: string }> {
  const id = Date.now().toString(36) + '-' + randomUUID()
  const directory = backupPath(input.home, id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const files: SnapshotFile[] = []
  for (const relative of PROTECTED_FILES) {
    const value = await optionalFile(join(input.home, relative))
    if (value === undefined) {
      files.push({ path: relative, existed: false })
      continue
    }
    await writeNew(join(directory, relative), value)
    files.push({ path: relative, existed: true, sha256: sha256(value) })
  }
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    id,
    createdAt: new Date().toISOString(),
    ...(input.fromVersion === undefined ? {} : { fromVersion: input.fromVersion }),
    toVersion: input.toVersion,
    files,
  }
  await writeNew(join(directory, 'manifest.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  await replaceFile(pendingPath(input.home), Buffer.from(JSON.stringify({ schemaVersion: 1, id } satisfies PendingJournal, undefined, 2) + '\n'))
  return { id, directory }
}

export async function beginRuntimeConfigProtection(
  input: RuntimeConfigProtectionInput,
): Promise<RuntimeConfigProtection | undefined> {
  await recoverPendingRuntimeConfigProtection(input.home)
  const sources = await Promise.all(PROTECTED_FILES.map(path => optionalFile(join(input.home, path))))
  if (sources.every(value => value === undefined)) return undefined
  const expected = await expectedModelSections(input)
  const snapshot = await createSnapshot(input)
  try {
    await prepareLegacyMigration(input)
  } catch (error: unknown) {
    try {
      await restoreSnapshot(input.home, snapshot.id)
      await rm(pendingPath(input.home), { force: true })
    } catch (rollbackError: unknown) {
      throw new AggregateError([error, rollbackError], '无法准备旧版模型配置迁移，且配置回滚未完整完成')
    }
    throw error
  }
  let state: 'pending' | 'committed' | 'rolled-back' = 'pending'
  const ownJournal = async (): Promise<void> => {
    const journal = await currentJournal(input.home)
    if (journal?.id !== snapshot.id) throw new Error('Runtime 配置保护事务已被其他进程修改')
  }
  return {
    backupDirectory: snapshot.directory,
    async verify(options = {}) {
      if (state !== 'pending') throw new Error('Runtime 配置保护事务已结束')
      const timeoutMs = options.timeoutMs ?? 10_000
      const pollMs = options.pollMs ?? 100
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs <= 0) {
        throw new TypeError('Runtime 配置校验等待时间无效')
      }
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const missing = await missingModelSections(input.home, expected)
        if (missing.length === 0) return
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new RuntimeConfigurationLossError(missing)
        await delay(Math.min(pollMs, remaining))
      }
    },
    async commit() {
      if (state !== 'pending') throw new Error('Runtime 配置保护事务已结束')
      await ownJournal()
      await rm(pendingPath(input.home), { force: true })
      state = 'committed'
    },
    async rollback() {
      if (state === 'rolled-back') return
      if (state === 'committed') {
        if (await currentJournal(input.home) !== undefined) throw new Error('Runtime 配置保护事务已被其他进程修改')
        await replaceFile(pendingPath(input.home), Buffer.from(JSON.stringify({ schemaVersion: 1, id: snapshot.id } satisfies PendingJournal, undefined, 2) + '\n'))
      }
      await ownJournal()
      await restoreSnapshot(input.home, snapshot.id)
      await ownJournal()
      await rm(pendingPath(input.home), { force: true })
      state = 'rolled-back'
    },
  }
}
