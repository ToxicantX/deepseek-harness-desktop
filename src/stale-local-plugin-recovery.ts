import { constants } from 'node:fs'
import { access, copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isMap, isSeq, parseDocument, type YAMLMap, type YAMLSeq } from 'yaml'

const PATCH_FILES = [join('profiles', 'web', 'cordis.patch.yml'), 'cordis.patch.yml'] as const
const DIAGNOSTIC_PATTERN = /failed to import loader entry ([^()\r\n]{1,256}?) \((file:\/\/\/[^)\r\n]+)\): Cannot find module ['"]([^'"\r\n]+)['"]/gu
const GROUP_MODULES = new Set(['cordis:group', 'cordis:include'])

interface MissingReference {
  id: string
  path: string
  key: string
}

interface Removal {
  sequence: YAMLSeq
  index: number
  id: string
}

interface PendingUpdate {
  file: string
  original: string
  replacement: string
  ids: string[]
}

export interface StaleLocalPluginRecoveryInput {
  home: string
  diagnostics: string
}

export interface StaleLocalPluginRecoveryResult {
  removedEntryIds: string[]
  count: number
}

export interface StaleLocalPluginRecoveryPlan {
  entryIds: string[]
  count: number
  apply(): Promise<StaleLocalPluginRecoveryResult>
}

interface RecoveryFileSystem {
  readText(file: string): Promise<string>
  writeNew(file: string, content: string): Promise<void>
  copyExclusive(source: string, destination: string): Promise<void>
  replace(source: string, destination: string): Promise<void>
  remove(file: string): Promise<void>
  exists(file: string): Promise<boolean>
}

export interface StaleLocalPluginRecoveryOptions {
  fileSystem?: Partial<RecoveryFileSystem>
}

const defaultFileSystem: RecoveryFileSystem = {
  readText: async file => readFile(file, 'utf8'),
  writeNew: async (file, content) => writeFile(file, content, { encoding: 'utf8', flag: 'wx' }),
  copyExclusive: async (source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL),
  replace: async (source, destination) => rename(source, destination),
  remove: async file => rm(file, { force: true }),
  async exists(file) {
    try {
      await access(file)
      return true
    } catch (error: unknown) {
      if (isFileNotFound(error)) return false
      throw error
    }
  },
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function canonicalPath(value: string): string {
  const normalized = /^[A-Za-z]:[\\/]/u.test(value) ? win32.resolve(value) : resolve(value)
  return process.platform === 'win32' || /^[A-Za-z]:[\\/]/u.test(value) ? normalized.toLowerCase() : normalized
}

function absoluteLocalPath(value: string): string | undefined {
  try {
    if (value.startsWith('file:')) {
      const url = new URL(value)
      if (url.protocol !== 'file:') return undefined
      return fileURLToPath(url)
    }
  } catch {
    return undefined
  }
  return isAbsolute(value) || win32.isAbsolute(value) ? value : undefined
}

function missingReferences(diagnostics: string): MissingReference[] {
  const unique = new Map<string, MissingReference>()
  for (const match of diagnostics.matchAll(DIAGNOSTIC_PATTERN)) {
    const id = match[1]?.trim()
    const urlPath = match[2] === undefined ? undefined : absoluteLocalPath(match[2])
    const modulePath = match[3] === undefined ? undefined : absoluteLocalPath(match[3])
    if (id === undefined || id.length === 0 || /[\u0000-\u001f\u007f]/u.test(id) || urlPath === undefined || modulePath === undefined) continue
    const urlKey = canonicalPath(urlPath)
    const moduleKey = canonicalPath(modulePath)
    if (urlKey !== moduleKey) continue
    const key = id + '\u0000' + moduleKey
    unique.set(key, { id, path: modulePath, key })
  }
  return [...unique.values()]
}

function scalarString(map: YAMLMap, key: string): string | undefined {
  const value = map.get(key)
  return typeof value === 'string' ? value : undefined
}

function matchingReference(entry: YAMLMap, references: ReadonlyMap<string, MissingReference>): MissingReference | undefined {
  const id = scalarString(entry, 'id')
  const name = scalarString(entry, 'name')
  if (id === undefined || name === undefined) return undefined
  const localPath = absoluteLocalPath(name)
  if (localPath === undefined) return undefined
  return references.get(id + '\u0000' + canonicalPath(localPath))
}

function scanLoaderEntries(
  sequence: YAMLSeq,
  references: ReadonlyMap<string, MissingReference>,
  removals: Removal[],
  seen: WeakSet<object>,
): void {
  sequence.items.forEach((node, index) => {
    if (!isMap(node)) return
    const match = matchingReference(node, references)
    if (match !== undefined && !seen.has(node)) {
      seen.add(node)
      removals.push({ sequence, index, id: match.id })
    }
    const name = scalarString(node, 'name')
    const config = node.get('config', true)
    if (name !== undefined && GROUP_MODULES.has(name) && isSeq(config)) scanMixedSequence(config, references, removals, seen)
  })
}

function scanMixedSequence(
  sequence: YAMLSeq,
  references: ReadonlyMap<string, MissingReference>,
  removals: Removal[],
  seen: WeakSet<object>,
): void {
  sequence.items.forEach((node, index) => {
    if (!isMap(node)) return
    const insert = node.get('insert', true)
    if (isSeq(insert)) {
      scanLoaderEntries(insert, references, removals, seen)
      const config = node.get('config', true)
      if (isSeq(config)) scanMixedSequence(config, references, removals, seen)
      return
    }
    const match = matchingReference(node, references)
    if (match !== undefined && !seen.has(node)) {
      seen.add(node)
      removals.push({ sequence, index, id: match.id })
    }
    const name = scalarString(node, 'name')
    const config = node.get('config', true)
    if (name !== undefined && GROUP_MODULES.has(name) && isSeq(config)) scanMixedSequence(config, references, removals, seen)
  })
}

function scanPatchDocument(contents: unknown, references: ReadonlyMap<string, MissingReference>): Removal[] {
  if (!isSeq(contents)) return []
  const removals: Removal[] = []
  const seen = new WeakSet<object>()
  for (const node of contents.items) {
    if (!isMap(node)) continue
    const insert = node.get('insert', true)
    if (isSeq(insert)) scanLoaderEntries(insert, references, removals, seen)
    const config = node.get('config', true)
    if (isSeq(config)) scanMixedSequence(config, references, removals, seen)
  }
  return removals
}

function applyRemovals(removals: readonly Removal[]): void {
  const grouped = new Map<YAMLSeq, number[]>()
  for (const removal of removals) {
    const indexes = grouped.get(removal.sequence) ?? []
    indexes.push(removal.index)
    grouped.set(removal.sequence, indexes)
  }
  for (const [sequence, indexes] of grouped) {
    for (const index of [...new Set(indexes)].sort((left, right) => right - left)) sequence.items.splice(index, 1)
  }
}

async function optionalText(file: string, fileSystem: RecoveryFileSystem): Promise<string | undefined> {
  try {
    return await fileSystem.readText(file)
  } catch (error: unknown) {
    if (isFileNotFound(error)) return undefined
    throw error
  }
}

function safeEntryIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

async function rollback(
  changed: readonly PendingUpdate[],
  backups: ReadonlyMap<string, string>,
  fileSystem: RecoveryFileSystem,
): Promise<Error[]> {
  const failures: Error[] = []
  for (const update of [...changed].reverse()) {
    const backup = backups.get(update.file)
    if (backup === undefined) continue
    try {
      const rollbackFile = update.file + '.rollback-source-' + randomUUID()
      await fileSystem.writeNew(rollbackFile, update.original)
      await fileSystem.replace(rollbackFile, update.file)
    } catch (error: unknown) {
      failures.push(error instanceof Error ? error : new Error(String(error)))
    }
  }
  return failures
}

export async function inspectStaleLocalPluginRecovery(
  input: StaleLocalPluginRecoveryInput,
  options: StaleLocalPluginRecoveryOptions = {},
): Promise<StaleLocalPluginRecoveryPlan | undefined> {
  const fileSystem: RecoveryFileSystem = { ...defaultFileSystem, ...options.fileSystem }
  const references = missingReferences(input.diagnostics)
  if (references.length === 0) return undefined
  const missing = await Promise.all(references.map(async reference => ({
    reference,
    missing: !(await fileSystem.exists(reference.path)),
  })))
  const missingReferencesByKey = new Map(missing.filter(value => value.missing).map(value => [value.reference.key, value.reference]))
  if (missingReferencesByKey.size === 0) return undefined

  const updates: PendingUpdate[] = []
  for (const relative of PATCH_FILES) {
    const file = join(input.home, relative)
    const original = await optionalText(file, fileSystem)
    if (original === undefined) continue
    const document = parseDocument(original)
    if (document.errors.length > 0) continue
    const removals = scanPatchDocument(document.contents, missingReferencesByKey)
    if (removals.length === 0) continue
    applyRemovals(removals)
    updates.push({ file, original, replacement: document.toString(), ids: removals.map(value => value.id) })
  }
  if (updates.length === 0) return undefined

  const entryIds = safeEntryIds(updates.flatMap(update => update.ids))
  const count = updates.reduce((total, update) => total + update.ids.length, 0)
  let applied = false
  return {
    entryIds,
    count,
    async apply() {
      if (applied) throw new Error('失效本地插件恢复计划已执行')
      for (const update of updates) {
        if (await fileSystem.readText(update.file) !== update.original) throw new Error('插件配置已更改，请重新诊断')
      }
      const backups = new Map<string, string>()
      const temps: string[] = []
      const changed: PendingUpdate[] = []
      try {
        for (const update of updates) {
          const backup = update.file + '.desktop-backup-' + Date.now().toString(36) + '-' + randomUUID()
          await fileSystem.copyExclusive(update.file, backup)
          if (await fileSystem.readText(backup) !== update.original) {
            throw new Error('插件配置已更改，请重新诊断')
          }
          backups.set(update.file, backup)
        }
        for (const update of updates) {
          const temp = join(dirname(update.file), '.' + randomUUID() + '.desktop-recovery.tmp')
          temps.push(temp)
          await fileSystem.writeNew(temp, update.replacement)
          await fileSystem.replace(temp, update.file)
          changed.push(update)
        }
        applied = true
        return { removedEntryIds: entryIds, count }
      } catch (error: unknown) {
        const rollbackFailures = await rollback(changed, backups, fileSystem)
        if (rollbackFailures.length > 0) {
          throw new AggregateError([error, ...rollbackFailures], '插件配置恢复失败，且自动回滚未完整完成')
        }
        throw error
      } finally {
        // Temporary cleanup must not replace the mutation or rollback result.
        await Promise.allSettled(temps.map(async temp => { await fileSystem.remove(temp) }))
      }
    },
  }
}
