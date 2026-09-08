import { appendFile, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { constants, zstdCompressSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readUsageSnapshot, type UsageScanProgress } from '../src/usage-monitor.ts'

const now = Date.parse('2026-09-08T04:00:00Z')
const newline = String.fromCharCode(10)
let home: string
const header = (id: string, extra = {}) => ({ type: 'session', version: 0, id, createdAt: now - 1000, ...extra })
function event(seq: number, time = now - 1000, usage: unknown = { inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 30, reasoningTokens: 10 }, source = { kind: 'model', provider: 'custom', model: 'model-a' }) {
  return { type: 'assistant/message', seq, time, data: { message: { role: 'assistant', content: [{ text: 'private message' }], source }, usage } }
}
function frame(rows: unknown[]): Buffer {
  return zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join(newline) + newline), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}
async function session(id: string, rows: unknown[], options: { compressed?: boolean; metadata?: Record<string, unknown> } = {}): Promise<string> {
  const path = join(home, 'sessions', 'workspace', id, options.compressed === false ? 'session.jsonl' : 'session.jsonl.zstd')
  await mkdir(dirname(path), { recursive: true })
  const meta = header(id, options.metadata)
  await writeFile(path, options.compressed === false
    ? [meta, ...rows].map(row => JSON.stringify(row)).join(newline) + newline
    : Buffer.concat([frame([meta]), ...rows.map(row => frame([row]))]))
  return path
}
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-usage-test-'))
  vi.spyOn(Date, 'now').mockReturnValue(now)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(home, { recursive: true, force: true })
})

describe('local usage monitoring', () => {
  it('reads independent checksummed Zstd frames and disjoint token counts without any price filtering', async () => {
    const path = await session('a', [event(1), event(2, now - 1000, { inputTokens: 10, outputTokens: 5 }, { kind: 'model', provider: 'other', model: 'new-model' })])
    const before = await readFile(path)
    const result = await readUsageSnapshot(home)
    expect(result.warnings).toEqual([])
    expect(result.ranges.today).toMatchObject({ requestCount: 2, inputTokens: 110, cacheReadTokens: 50, cacheWriteTokens: 20, outputTokens: 35, reasoningTokens: 10, totalTokens: 215, activeDays: 1, cacheHitRate: 50 / 160 })
    expect(result.ranges.all.models.map(model => model.provider)).toEqual(['custom', 'other'])
    expect(JSON.stringify(result)).not.toMatch(/private message|cost|balance|price/)
    expect(await readFile(path)).toEqual(before)
  })
  it('reads today from the current v2 generation rather than its retained legacy copy', async () => {
    const legacy = await session('generations', [event(1, now - 86400000)])
    await writeFile(join(dirname(legacy), 'session.v1.jsonl.zstd'), frame([header('generations'), event(1, now - 86400000)]))
    await writeFile(join(dirname(legacy), 'session.v2.jsonl.zstd'), frame([header('generations', { version: 2 }), event(1, now - 86400000), event(2)]))
    await writeFile(join(dirname(legacy), 'session.v02.jsonl.zstd'), frame([header('invalid'), event(1)]))
    await writeFile(join(dirname(legacy), 'session.v3.jsonl.zstd.backup'), frame([header('backup'), event(1)]))
    const result = await readUsageSnapshot(home)
    expect(result.ranges.today.requestCount).toBe(1)
    expect(result.ranges.all.requestCount).toBe(2)
    expect(result.warnings).toEqual([])
  })

  it('supports legacy JSONL and missing optional counts, preserving unknown model identifiers', async () => {
    await session('plain', [event(1, now - 1000, { inputTokens: 2, outputTokens: 3 }, { kind: 'model', provider: '', model: '' })], { compressed: false })
    const result = await readUsageSnapshot(home)
    expect(result.ranges.all).toMatchObject({ requestCount: 1, totalTokens: 5, reasoningTokens: 0, cacheHitRate: 0 })
    expect(result.ranges.all.models[0]).toMatchObject({ provider: '未知提供方', model: '未知模型' })
  })
  it('uses inclusive Beijing calendar ranges and excludes future usage', async () => {
    const dates = ['2026-09-07T16:00:00Z', '2026-09-07T15:59:59Z', '2026-09-01T16:00:00Z', '2026-09-01T15:59:59Z', '2026-08-09T16:00:00Z', '2026-08-09T15:59:59Z', '2026-09-08T04:00:01Z']
    await session('calendar', dates.map((date, index) => event(index, Date.parse(date))))
    const result = await readUsageSnapshot(home)
    expect(Object.values(result.ranges).map(summary => summary.requestCount)).toEqual([1, 3, 5, 6])
    expect(result.ranges.today.daily[0]?.date).toBe('2026-09-08')
    expect(result.ranges.all.activeDays).toBe(6)
  })
  it('counts only model messages with valid usage, never chunks or tool-generated messages', async () => {
    await session('invalid', [event(1), { ...event(2), type: 'assistant/chunk' }, event(3, now - 1, undefined, { kind: 'tool', provider: 'x', model: 'y' }),
      event(4, now - 1, null), event(5, now - 1, { inputTokens: -1, outputTokens: 3 }), event(6, now - 1, { inputTokens: 1, outputTokens: 3, cacheReadTokens: null }),
      event(7, now - 1, { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1 }), event(8, now - 1, { inputTokens: '10', outputTokens: 2 }),
      { type: 'assistant/message', seq: 9, time: now, data: { message: { source: { kind: 'model' } } } },
      { ...event(10), seq: 1.5 }, { ...event(11), time: -1 }])
    const result = await readUsageSnapshot(home)
    expect(result.ranges.all.requestCount).toBe(1)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
  it('deduplicates source sequences and ignores compressed-file backups', async () => {
    const path = await session('same', [event(1), event(1), event(2)])
    await copyFile(path, path + '.backup')
    const duplicate = join(home, 'sessions', 'another-workspace', 'copy', 'session.jsonl.zstd')
    await mkdir(dirname(duplicate), { recursive: true })
    await copyFile(path, duplicate)
    const result = await readUsageSnapshot(home)
    expect(result.ranges.all.requestCount).toBe(2)
  })
  it('excludes copied history in both legacy and current seeded sessions', async () => {
    await session('parent', [event(1)])
    await session('legacy-fork', [event(1), event(3)], { metadata: { parentSession: 'parent', seedLength: 3 } })
    await session('fork', [event(1), { type: 'session/end-seed', seq: 2, time: now, data: { inherited: true } }, event(3)], { metadata: { parentSession: 'parent', isSeeded: true } })
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(3)
  })
  it('uses the last inherited marker when a fork contains an older fork history', async () => {
    await session('nested-fork', [event(1),
      { type: 'session/end-seed', seq: 2, time: now, data: { inherited: true } }, event(3),
      { type: 'session/end-seed', seq: 4, time: now, data: { inherited: true } }, event(5),
      { type: 'session/end-seed', seq: 6, time: now, data: { inherited: false } }, event(7)],
    { metadata: { isSeeded: true, version: 2 } })
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(2)
  })
  it('handles cache hits, appends, truncation and deletion without stale totals', async () => {
    const path = await session('changes', [event(1)])
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(1)
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(1)
    await appendFile(path, frame([event(2)]))
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(2)
    await writeFile(path, frame([header('changes')]))
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(0)
    await rm(path)
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(0)
  })
  it('retains complete frames but warns for a torn tail, then recovers on append', async () => {
    const path = await session('torn', [event(1)])
    const next = frame([event(2)])
    await appendFile(path, next.subarray(0, 10))
    const partial = await readUsageSnapshot(home)
    expect(partial.ranges.all.requestCount).toBe(1)
    expect(partial.warnings.join(' ')).toContain('未能完整统计')
    await appendFile(path, next.subarray(10))
    const complete = await readUsageSnapshot(home)
    expect(complete.ranges.all.requestCount).toBe(2)
    expect(complete.warnings).toEqual([])
  })
  it('does not count parseable JSONL tails until the newline commits them', async () => {
    const path = await session('plain-tail', [event(1)], { compressed: false })
    await appendFile(path, JSON.stringify(event(2)))
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(1)
    await appendFile(path, newline)
    expect((await readUsageSnapshot(home)).ranges.all.requestCount).toBe(2)
  })
  it('reports bad lines and corrupt frames while retaining prior valid usage', async () => {
    const plain = await session('bad-line', [event(1)], { compressed: false })
    await appendFile(plain, '{invalid' + newline + JSON.stringify(event(2)) + newline)
    const compressed = await session('bad-frame', [event(1)])
    const corrupted = frame([event(2)])
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff
    await appendFile(compressed, corrupted)
    const result = await readUsageSnapshot(home)
    expect(result.ranges.all.requestCount).toBe(3)
    expect(result.warnings.join(' ')).toContain('未能完整统计')
  })
  it('returns an empty snapshot for a fresh home, but warns when sessions is not a directory', async () => {
    const empty = await readUsageSnapshot(home)
    expect(empty.ranges.all.requestCount).toBe(0)
    expect(empty.warnings).toEqual([])
    await writeFile(join(home, 'sessions'), 'not a directory')
    expect((await readUsageSnapshot(home)).warnings).not.toEqual([])
  })
  it('reports byte progress within a large file and finishes with exact file counts', async () => {
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => { clock += 200; return clock })
    const path = await session('large', [event(1)], { compressed: false })
    await appendFile(path, (JSON.stringify({ type: 'assistant/chunk', text: 'x'.repeat(200000) }) + newline).repeat(6))
    const updates: UsageScanProgress[] = []
    const result = await readUsageSnapshot(home, progress => updates.push(progress))
    expect(result.ranges.today.requestCount).toBe(1)
    expect(updates[0]?.phase).toBe('discovering')
    expect(updates.some(p => p.phase === 'scanning' && p.processedFiles === 0 && p.percent > 0 && p.percent < 100)).toBe(true)
    expect(updates.filter(p => p.phase === 'scanning').every(p => !p.currentFile.startsWith(home))).toBe(true)
    expect(updates.at(-1)).toMatchObject({ phase: 'complete', totalFiles: 1, processedFiles: 1, percent: 100 })
    const percentages = updates.map(p => p.percent)
    expect(percentages).toEqual([...percentages].sort((a, b) => a - b))
    const cached: UsageScanProgress[] = []
    await readUsageSnapshot(home, p => cached.push(p))
    expect(cached.at(-1)).toMatchObject({ phase: 'complete', totalFiles: 1, percent: 100 })
  })
  it('broadcasts to concurrent and reentrant subscribers without letting callback failures break the scan', async () => {
    await session('subscribers', [event(1)])
    const firstUpdates: UsageScanProgress[] = []
    const secondUpdates: UsageScanProgress[] = []
    const first = readUsageSnapshot(home, p => { firstUpdates.push(p); throw new Error('closed window') })
    const second = readUsageSnapshot(home, p => secondUpdates.push(p))
    expect(first).toBe(second)
    expect((await first).ranges.all.requestCount).toBe(1)
    expect(firstUpdates.at(-1)?.phase).toBe('complete')
    expect(secondUpdates.at(-1)?.phase).toBe('complete')
    const later: UsageScanProgress[] = []
    const next = readUsageSnapshot(home, p => later.push(p))
    await next
    expect(next).not.toBe(first)
    expect(later.at(-1)?.percent).toBe(100)
  })
  it('throttles progress bursts but always emits start and completion, including corrupt files', async () => {
    vi.spyOn(performance, 'now').mockReturnValue(0)
    const path = await session('corrupt-progress', [event(1)])
    await appendFile(path, Buffer.from([1, 2]))
    const updates: UsageScanProgress[] = []
    const result = await readUsageSnapshot(home, p => updates.push(p))
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(updates.length).toBeLessThanOrEqual(4)
    expect(updates[0]?.percent).toBe(0)
    expect(updates.at(-1)).toMatchObject({ phase: 'complete', processedFiles: 1, percent: 100 })
  })
  it('coalesces concurrent requests for the same data directory', async () => {
    await session('concurrent', [event(1)])
    const first = readUsageSnapshot(home)
    const second = readUsageSnapshot(home)
    expect(first).toBe(second)
    expect((await first).ranges.all.requestCount).toBe(1)
  })
})
