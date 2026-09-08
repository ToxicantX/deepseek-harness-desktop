import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { zstdDecompress } from 'node:zlib'

export type UsageRange = 'today' | '7d' | '30d' | 'all'
export interface UsageTotals {
  requestCount: number
  inputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  outputTokens: number
  reasoningTokens: number
  totalTokens: number
  cacheHitRate: number
  activeDays: number
}
export interface UsageModel extends UsageTotals { provider: string; model: string }
export interface UsageDay { date: string; requestCount: number; totalTokens: number }
export interface UsageSummary extends UsageTotals { models: UsageModel[]; daily: UsageDay[] }
export interface UsageScanProgress {
  phase: 'discovering' | 'scanning' | 'complete'
  discoveredFiles: number
  processedFiles: number
  totalFiles: number
  currentFile: string
  percent: number
}
export interface UsageSnapshot {
  updatedAt: string
  timeZone: string
  warnings: string[]
  ranges: Record<UsageRange, UsageSummary>
}

type TokenKey = 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'outputTokens' | 'reasoningTokens'
type UsageRecord = Pick<UsageTotals, TokenKey> & {
  sessionId: string
  seq: number
  time: number
  provider: string
  model: string
}
interface FileUsage { records: UsageRecord[]; warnings: string[] }
interface CacheEntry extends FileUsage { signature: string }
const tokenKeys: TokenKey[] = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens', 'reasoningTokens']
const timeZone = 'Asia/Shanghai'
const dayMilliseconds = 86_400_000
const decompress = promisify(zstdDecompress)
const maxFrameBytes = 64 * 1024 * 1024
const maxCachedRecords = 100_000
const maxCachedFiles = 1024
const fileCache = new Map<string, CacheEntry>()
let cachedRecords = 0
interface PendingScan {
  promise: Promise<UsageSnapshot>
  listeners: Set<(progress: UsageScanProgress) => void>
  latest?: UsageScanProgress
}
const pendingReads = new Map<string, PendingScan>()

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function count(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
function dateOf(time: number): string {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}
function emptyTotals(): UsageTotals {
  return { requestCount: 0, inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    outputTokens: 0, reasoningTokens: 0, totalTokens: 0, cacheHitRate: 0, activeDays: 0 }
}

// Locate one standard Zstd frame, including its checksum. DSH appends independent
// frames; Node's one-shot decoder consumes only the first frame in a buffer.
function frameLength(bytes: Buffer): number | undefined {
  if (bytes.length < 5) return undefined
  if (bytes.readUInt32LE(0) !== 0xfd2fb528) throw new Error('压缩帧标识损坏')
  const descriptor = bytes[4]!
  if ((descriptor & 0x18) !== 0) throw new Error('压缩帧头损坏')
  const singleSegment = (descriptor & 0x20) !== 0
  const sizeFlag = descriptor >>> 6
  const dictionaryFlag = descriptor & 3
  const sizeBytes = sizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << sizeFlag
  let offset = 5 + (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + sizeBytes
  for (;;) {
    if (offset + 3 > bytes.length) return undefined
    const block = bytes.readUIntLE(offset, 3)
    const kind = (block >>> 1) & 3
    if (kind === 3) throw new Error('压缩块类型损坏')
    offset += 3 + (kind === 1 ? 1 : block >>> 3)
    if (offset > maxFrameBytes) throw new Error('单个压缩帧超过读取上限')
    if (offset > bytes.length) return undefined
    if ((block & 1) !== 0) break
  }
  if ((descriptor & 4) !== 0) offset += 4
  return offset <= bytes.length ? offset : undefined
}

async function* compressedLines(path: string, onBytes?: (bytes: number) => void): AsyncGenerator<string> {
  let pending = Buffer.alloc(0)
  let readBytes = 0
  for await (const chunk of createReadStream(path, { highWaterMark: 256 * 1024 })) {
    pending = Buffer.concat([pending, chunk as Buffer])
    readBytes += (chunk as Buffer).length
    onBytes?.(readBytes)
    let consumed = 0
    while (consumed < pending.length) {
      const length = frameLength(pending.subarray(consumed))
      if (length === undefined) break
      const decoded = await decompress(pending.subarray(consumed, consumed + length), { maxOutputLength: maxFrameBytes })
      const text = decoded.toString('utf8')
      // Never count a partially committed JSONL record, even if it parses.
      const lastNewline = text.lastIndexOf(String.fromCharCode(10))
      if (lastNewline >= 0) {
        for (const line of text.slice(0, lastNewline).split(String.fromCharCode(10))) yield line
      }
      if (lastNewline !== text.length - 1) throw new Error('压缩帧包含未完整写入的记录')
      consumed += length
      onBytes?.(readBytes)
    }
    pending = Buffer.from(pending.subarray(consumed))
    if (pending.length > maxFrameBytes) throw new Error('单个压缩帧超过读取上限')
  }
  if (pending.length > 0) throw new Error('日志尾部尚未完整写入')
}

async function* plainLines(path: string, onBytes?: (bytes: number) => void): AsyncGenerator<string> {
  let pending = ''
  let readBytes = 0
  const newline = String.fromCharCode(10)
  for await (const chunk of createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 })) {
    pending += chunk
    readBytes += Buffer.byteLength(chunk as string)
    onBytes?.(readBytes)
    let start = 0
    let end = pending.indexOf(newline)
    while (end >= 0) {
      yield pending.slice(start, end)
      start = end + 1
      end = pending.indexOf(newline, start)
    }
    pending = pending.slice(start)
    if (pending.length > maxFrameBytes) throw new Error('单条日志超过读取上限')
  }
  if (pending.trim()) throw new Error('日志尾部尚未完整写入')
}

async function readFileUsage(path: string, onBytes?: (bytes: number) => void): Promise<FileUsage> {
  const records: UsageRecord[] = []
  const warnings = new Set<string>()
  let sessionId: string | undefined
  let seedLength = 0
  let inSeed = false
  let seeded = false
  let sawHeader = false
  const parseLine = (line: string): void => {
    if (!line.trim()) return
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { warnings.add('存在无法解析的日志记录'); return }
    const event = object(parsed)
    if (event === undefined) { warnings.add('存在无效的日志记录'); return }
    if (!sawHeader) {
      sawHeader = true
      if (event.type !== 'session' || typeof event.id !== 'string' || !event.id) {
        throw new Error('会话日志缺少有效标头')
      }
      sessionId = event.id
      if (event.seedLength !== undefined && !count(event.seedLength)) throw new Error('会话继承长度无效')
      seedLength = count(event.seedLength) ? event.seedLength : 0
      seeded = event.isSeeded === true
      inSeed = seeded
      return
    }
    if (event.type === 'session/end-seed') {
      if (seeded && object(event.data)?.inherited === true) {
        // Nested forks include their ancestors' markers; the last one is the cut.
        records.length = 0
        inSeed = false
      }
      return
    }
    if (event.type !== 'assistant/message' || inSeed) return
    const data = object(event.data)
    const source = object(object(data?.message)?.source)
    if (source?.kind !== 'model' || data?.usage === undefined) return
    if (!count(event.seq) || !count(event.time) || event.time > 8_640_000_000_000_000 - dayMilliseconds) {
      warnings.add('存在无效的用量时间或序号'); return
    }
    // Legacy forks store a seedLength; newer sessions delimit it with end-seed.
    if (event.seq < seedLength) return
    const usage = object(data.usage)
    if (usage === undefined) { warnings.add('存在无效的 Token 用量'); return }
    const values = {} as Pick<UsageTotals, TokenKey>
    for (const key of tokenKeys) {
      const value = usage[key] === undefined && key !== 'inputTokens' && key !== 'outputTokens' ? 0 : usage[key]
      if (!count(value)) { warnings.add('存在无效的 Token 用量'); return }
      values[key] = value
    }
    if (!Number.isSafeInteger(values.inputTokens + values.cacheReadTokens + values.cacheWriteTokens + values.outputTokens)) {
      warnings.add('Token 用量超过安全整数范围'); return
    }
    records.push({ ...values, sessionId: sessionId!, seq: event.seq, time: event.time,
      provider: typeof source.provider === 'string' && source.provider ? source.provider : '未知提供方',
      model: typeof source.model === 'string' && source.model ? source.model : '未知模型' })
  }
  try {
    if (path.endsWith('.zstd')) {
      for await (const line of compressedLines(path, onBytes)) parseLine(line)
    } else {
      for await (const line of plainLines(path, onBytes)) parseLine(line)
    }
    if (!sawHeader) warnings.add('会话日志为空')
    if (inSeed) warnings.add('会话继承标记尚未完整写入')
  } catch (error: unknown) {
    warnings.add(error instanceof Error && !('code' in error) ? error.message : '无法读取会话日志')
  }
  return { records, warnings: [...warnings] }
}

async function discoverFiles(home: string, warnings: string[], onProgress?: (progress: UsageScanProgress) => void): Promise<string[]> {
  const files: string[] = []
  const emit = (): void => onProgress?.({ phase: 'discovering', discoveredFiles: files.length, processedFiles: 0, totalFiles: 0, currentFile: '', percent: 0 })
  const visit = async (directory: string, depth: number): Promise<void> => {
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) }
    catch (error: unknown) {
      if (depth !== 0 || (error as NodeJS.ErrnoException).code !== 'ENOENT') warnings.push('部分会话目录无法读取')
      return
    }
    // Runtime migrations retain immutable older generations alongside the active one.
    const candidates = entries.flatMap(entry => {
      if (!entry.isFile()) return []
      const match = /^session(?:[.]v([1-9][0-9]*))?[.]jsonl([.]zstd)?$/.exec(entry.name)
      if (match === null) return []
      const version = Number(match[1] ?? 0)
      return Number.isSafeInteger(version) ? [{ name: entry.name, version, compressed: match[2] !== undefined }] : []
    }).sort((a, b) => b.version - a.version || Number(b.compressed) - Number(a.compressed))
    if (candidates[0]) {
      files.push(join(directory, candidates[0].name))
      emit()
    }
    for (const entry of entries) {
      if (entry.isDirectory() && depth < 2) await visit(join(directory, entry.name), depth + 1)
    }
  }
  await visit(join(home, 'sessions'), 0)
  return files
}

function forget(path: string): void {
  const previous = fileCache.get(path)
  if (previous) cachedRecords -= previous.records.length
  fileCache.delete(path)
}
async function cachedFile(path: string, onBytes?: (bytes: number) => void): Promise<FileUsage> {
  const info = await stat(path)
  const signature = [info.size, info.mtimeMs, info.ctimeMs, info.ino].join(':')
  const previous = fileCache.get(path)
  if (previous?.signature === signature) {
    fileCache.delete(path)
    fileCache.set(path, previous)
    return previous
  }
  const result = await readFileUsage(path, onBytes)
  forget(path)
  if (result.records.length <= maxCachedRecords) {
    while (fileCache.size >= maxCachedFiles || cachedRecords + result.records.length > maxCachedRecords) {
      const oldest = fileCache.keys().next().value
      if (oldest === undefined) break
      forget(oldest)
    }
    fileCache.set(path, { ...result, signature })
    cachedRecords += result.records.length
  }
  return result
}

interface Accumulator {
  totals: UsageTotals
  days: Map<string, UsageDay>
  models: Map<string, { totals: UsageModel; days: Set<string> }>
}
function accumulator(): Accumulator {
  return { totals: emptyTotals(), days: new Map(), models: new Map() }
}
function add(totals: UsageTotals, record: UsageRecord): void {
  totals.requestCount += 1
  for (const key of tokenKeys) totals[key] += record[key]
  // DSH input/cache counts are disjoint. Reasoning is already part of output.
  totals.totalTokens += record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.outputTokens
}
function finishTotals(totals: UsageTotals, activeDays: number): void {
  totals.activeDays = activeDays
  const input = totals.inputTokens + totals.cacheReadTokens
  totals.cacheHitRate = input > 0 ? totals.cacheReadTokens / input : 0
}
function accumulate(target: Accumulator, record: UsageRecord, date: string): void {
  add(target.totals, record)
  const key = JSON.stringify([record.provider, record.model])
  let model = target.models.get(key)
  if (!model) {
    model = { totals: { ...emptyTotals(), provider: record.provider, model: record.model }, days: new Set() }
    target.models.set(key, model)
  }
  add(model.totals, record)
  model.days.add(date)
  const day = target.days.get(date) ?? { date, requestCount: 0, totalTokens: 0 }
  day.requestCount += 1
  day.totalTokens += record.inputTokens + record.cacheReadTokens + record.cacheWriteTokens + record.outputTokens
  target.days.set(date, day)
}
function finish(target: Accumulator): UsageSummary {
  finishTotals(target.totals, target.days.size)
  for (const model of target.models.values()) finishTotals(model.totals, model.days.size)
  return { ...target.totals,
    models: [...target.models.values()].map(model => model.totals).sort((a, b) => b.totalTokens - a.totalTokens),
    daily: [...target.days.values()].sort((a, b) => a.date.localeCompare(b.date)) }
}

async function scan(home: string, emit: (progress: UsageScanProgress, force?: boolean) => void): Promise<UsageSnapshot> {
  const now = Date.now()
  const warnings: string[] = []
  emit({ phase: 'discovering', discoveredFiles: 0, processedFiles: 0, totalFiles: 0, currentFile: '', percent: 0 }, true)
  const files = await discoverFiles(home, warnings, progress => emit(progress))
  const sizes = new Map<string, number>()
  for (const path of files) {
    try { sizes.set(path, Math.max(1, (await stat(path)).size)) }
    catch { sizes.set(path, 1) }
  }
  const totalFiles = files.length
  const totalBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0)
  let processedBytes = 0
  let processedFiles = 0
  let currentFile = ''
  const report = (partialBytes = 0, force = false): void => {
    emit({ phase: 'scanning', discoveredFiles: totalFiles, processedFiles, totalFiles, currentFile,
      percent: totalBytes > 0 ? Math.min(99.9, (processedBytes + partialBytes) / totalBytes * 100) : 0 }, force)
  }
  report(0, true)
  const available = new Set(files)
  const prefix = join(home, 'sessions')
  for (const path of fileCache.keys()) if (path.startsWith(prefix) && !available.has(path)) forget(path)
  const targets: Record<UsageRange, Accumulator> = { today: accumulator(), '7d': accumulator(), '30d': accumulator(), all: accumulator() }
  const starts: Record<UsageRange, string> = { today: dateOf(now), '7d': dateOf(now - 6 * dayMilliseconds), '30d': dateOf(now - 29 * dayMilliseconds), all: '' }
  const seen = new Set<string>()
  let unreadable = 0
  for (const path of files) {
    currentFile = relative(home, path)
    const size = sizes.get(path)!
    report(0, processedFiles === 0)
    let result: FileUsage
    try { result = await cachedFile(path, bytes => report(Math.min(bytes, size))) }
    catch { result = { records: [], warnings: ['无法读取会话日志'] } }
    if (result.warnings.length) {
      unreadable += 1
      for (const warning of result.warnings) if (!warnings.includes(warning) && warnings.length < 12) warnings.push(warning)
    }
    for (const record of result.records) {
      if (record.time > now) continue
      const key = JSON.stringify([record.sessionId, record.seq])
      if (seen.has(key)) continue
      seen.add(key)
      const date = dateOf(record.time)
      for (const range of Object.keys(targets) as UsageRange[]) {
        if (date >= starts[range]) accumulate(targets[range], record, date)
      }
    }
    processedBytes += size
    processedFiles += 1
    report()
  }
  if (unreadable > 0) warnings.unshift('有 ' + unreadable + ' 个会话日志未能完整统计，以下数据可能不完整。')
  const result: UsageSnapshot = { updatedAt: new Date(now).toISOString(), timeZone, warnings: [...new Set(warnings)],
    ranges: { today: finish(targets.today), '7d': finish(targets['7d']), '30d': finish(targets['30d']), all: finish(targets.all) } }
  emit({ phase: 'complete', discoveredFiles: totalFiles, processedFiles: totalFiles, totalFiles, currentFile: '', percent: 100 }, true)
  return result
}

export function readUsageSnapshot(home: string, onProgress?: (progress: UsageScanProgress) => void): Promise<UsageSnapshot> {
  const root = resolve(home)
  const pending = pendingReads.get(root)
  const notify = (listener: (progress: UsageScanProgress) => void, progress: UsageScanProgress): void => {
    try { listener({ ...progress }) } catch { /* A closing window must not abort a shared scan. */ }
  }
  if (pending) {
    if (onProgress) {
      pending.listeners.add(onProgress)
      if (pending.latest) notify(onProgress, pending.latest)
    }
    return pending.promise
  }
  const listeners = new Set<(progress: UsageScanProgress) => void>()
  if (onProgress) listeners.add(onProgress)
  let lastEmitted = -Infinity
  // Start on a microtask so callback re-entry also joins this registered scan.
  const state: PendingScan = { listeners, promise: Promise.resolve().then(() => scan(root, (progress, force) => {
    state.latest = progress
    const now = performance.now()
    if (!force && now - lastEmitted < 150) return
    lastEmitted = now
    for (const listener of listeners) notify(listener, progress)
  })).finally(() => { listeners.clear(); pendingReads.delete(root) }) }
  pendingReads.set(root, state)
  return state.promise
}
