import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { UsageMonitorService } from '../src/usage-monitor-service.ts'
import type { UsageScanProgress, UsageSnapshot } from '../src/usage-monitor.ts'

const snapshot = { updatedAt: '2026-09-09T00:00:00Z' } as UsageSnapshot
const progress: UsageScanProgress = { phase: 'scanning', discoveredFiles: 2, totalFiles: 2, processedFiles: 1, currentFile: 'session.jsonl', percent: 50 }

describe('usage startup initialization', () => {
  it('shares startup and opening reads, replays progress and reuses the result', async () => {
    let finish!: (snapshot: UsageSnapshot) => void
    let report!: (progress: UsageScanProgress) => void
    const scan = vi.fn((_home: string, listener?: (progress: UsageScanProgress) => void) => {
      report = listener!
      return new Promise<UsageSnapshot>(resolve => { finish = resolve })
    })
    const service = new UsageMonitorService('home', scan)
    const startup = service.initialize()
    const first = vi.fn()
    expect(service.initialize(first)).toBe(startup)
    await Promise.resolve()
    report(progress)
    const late = vi.fn()
    expect(service.initialize(late)).toBe(startup)
    expect(first).toHaveBeenCalledWith(progress)
    expect(late).toHaveBeenCalledWith(progress)
    finish(snapshot)
    expect(await startup).toBe(snapshot)
    expect(await service.initialize()).toBe(snapshot)
    expect(scan).toHaveBeenCalledTimes(1)
    const refresh = service.read()
    await Promise.resolve()
    finish(snapshot)
    await refresh
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('retries failed initialization and isolates broken progress listeners', async () => {
    const scan = vi.fn().mockRejectedValueOnce(new Error('unavailable')).mockImplementationOnce(async (_home, report) => {
      report(progress)
      return snapshot
    })
    const service = new UsageMonitorService('home', scan)
    await expect(service.initialize()).rejects.toThrow('unavailable')
    expect(await service.initialize(() => { throw new Error('window closed') })).toBe(snapshot)
    expect(scan).toHaveBeenCalledTimes(2)
  })

  it('refreshes appended logs and initializes again in a new service without changing records', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-usage-startup-'))
    try {
      const directory = join(home, 'sessions', 'workspace', 'session')
      await mkdir(directory, { recursive: true })
      const path = join(directory, 'session.v2.jsonl')
      const record = (seq: number) => JSON.stringify({ type: 'assistant/message', seq, time: Date.now(), data: {
        message: { source: { kind: 'model', provider: 'fixture', model: 'fixture' } }, usage: { inputTokens: 5, outputTokens: 5 },
      } }) + '\n'
      await writeFile(path, JSON.stringify({ type: 'session', version: 2, id: 'session', createdAt: Date.now() }) + '\n' + record(1))
      const service = new UsageMonitorService(home)
      expect((await service.initialize()).ranges.all.requestCount).toBe(1)
      await appendFile(path, record(2))
      expect((await service.initialize()).ranges.all.requestCount).toBe(1)
      expect((await service.read()).ranges.all.requestCount).toBe(2)
      expect((await service.initialize()).ranges.all.requestCount).toBe(2)
      expect((await new UsageMonitorService(home).initialize()).ranges.all.requestCount).toBe(2)
    } finally { await rm(home, { recursive: true, force: true }) }
  })
})
