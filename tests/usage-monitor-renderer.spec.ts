import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatCount, formatPercent, installUsageMonitor } from '../src/usage-monitor-renderer.ts'
import type { UsageSnapshot, UsageSummary, UsageScanProgress } from '../src/usage-monitor.ts'

class Element extends EventTarget {
  dataset: Record<string, string> = {}
  style: Record<string, string> = {}
  attributes = new Map<string, string>()
  children: Element[] = []
  className = ''
  title = ''
  hidden = false
  disabled = false
  checked = true
  private value = ''
  set textContent(value: string) { this.value = value; this.children = [] }
  get textContent(): string { return this.value + this.children.map(child => child.textContent).join('') }
  append(...children: Element[]): void { this.children.push(...children) }
  replaceChildren(...children: Element[]): void { this.children = children; this.value = '' }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value) }
  removeAttribute(name: string): void { this.attributes.delete(name) }
  click(): void { this.dispatchEvent(new Event('click')) }
}
const html = readFileSync(new URL('../assets/usage-monitor.html', import.meta.url), 'utf8')
let elements: Map<string, Element>
let tabs: Element[]
let body: Element
let host: EventTarget
const node = (id: string): Element => elements.get('usage-' + id)!
const summary = (overrides: Partial<UsageSummary> = {}): UsageSummary => ({
  requestCount: 2, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 500, cacheWriteTokens: 100,
  reasoningTokens: 50, totalTokens: 1800, cacheHitRate: 1 / 3, activeDays: 1, models: [], daily: [], ...overrides,
})
function snapshot(): UsageSnapshot {
  const today = summary()
  today.models = [{ ...summary(), provider: '<provider>', model: '<img src=x onerror=alert(1)>' }]
  today.daily = [{ date: '2026-09-08', totalTokens: 1800, requestCount: 2 }]
  return { updatedAt: '2026-09-08T04:00:00Z', timeZone: 'Asia/Shanghai', warnings: [],
    ranges: { today, '7d': summary({ requestCount: 7 }), '30d': summary({ requestCount: 30 }), all: summary({ requestCount: 100 }) } }
}
async function settled(): Promise<void> { await Promise.resolve(); await Promise.resolve() }
beforeEach(() => {
  vi.useFakeTimers()
  elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1]!, new Element()]))
  body = new Element()
  body.dataset.page = 'usage-monitor'
  tabs = ['today', '7d', '30d', 'all'].map(range => { const element = new Element(); element.dataset.range = range; return element })
  host = new EventTarget()
  vi.stubGlobal('window', host)
  vi.stubGlobal('document', { body, getElementById: (id: string) => elements.get(id) ?? null,
    querySelectorAll: () => tabs, createElement: () => new Element() })
})
afterEach(() => {
  host.dispatchEvent(new Event('beforeunload'))
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('usage monitor rendering', () => {
  it('subscribes before loading and shows live progress, file names and elapsed time without removing the progress DOM', async () => {
    const order: string[] = []
    let notify!: (progress: UsageScanProgress) => void
    let complete!: (snapshot: UsageSnapshot) => void
    const unsubscribe = vi.fn()
    installUsageMonitor(() => { order.push('read'); return new Promise(resolve => { complete = resolve }) }, listener => {
      order.push('subscribe'); notify = listener; return unsubscribe
    })
    expect(order).toEqual(['subscribe', 'read'])
    expect(node('progress-status').hidden).toBe(false)
    expect(node('progress-label').textContent).toContain('正在发现')
    notify({ phase: 'discovering', discoveredFiles: 7, processedFiles: 0, totalFiles: 0, currentFile: '', percent: 0 })
    expect(node('progress-label').textContent).toContain('7 个')
    expect(node('progress').attributes.has('value')).toBe(false)
    notify({ phase: 'scanning', discoveredFiles: 10, processedFiles: 4, totalFiles: 10, currentFile: 'sessions/workspace/id/session.v2.jsonl.zstd', percent: 45.5 })
    expect(node('progress-label').textContent).toContain('4/10')
    expect(node('progress-label').textContent).toContain('45%')
    expect(node('progress-file').title).toContain('session.v2.jsonl.zstd')
    await vi.advanceTimersByTimeAsync(3000)
    expect(node('elapsed').textContent).toContain('3 秒')
    complete(snapshot())
    await settled()
    expect(node('progress-status').hidden).toBe(true)
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)
  })
  it('removes progress listeners on failed reads and closes while scanning', async () => {
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => unsubscribe)
    const dispose = installUsageMonitor(async () => { throw new Error('failure') }, subscribe)
    await settled()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(node('progress-status').hidden).toBe(true)
    dispose()
    expect(vi.getTimerCount()).toBe(0)
    const unsubscribePending = vi.fn()
    const stop = installUsageMonitor(() => new Promise(() => {}), () => unsubscribePending)
    stop()
    expect(unsubscribePending).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('formats exact counts and cache percentages', () => {
    expect(formatCount(12345)).toBe('12,345')
    expect(formatCount(Infinity)).toBe('0')
    expect(formatPercent(1 / 3)).toBe('33.3%')
    expect(formatPercent(2)).toBe('100.0%')
    expect(formatPercent(-1)).toBe('0.0%')
  })
  it('renders metrics, model quantities and real chart bars using text-only model labels', async () => {
    installUsageMonitor(async () => snapshot())
    await settled()
    expect(node('total').textContent).toBe('1,800')
    expect(node('write').textContent).toBe('100')
    expect(node('reasoning').textContent).toBe('50')
    expect(node('rate').textContent).toBe('33.3%')
    expect(node('models').children[0]?.children.map(child => child.textContent)).toEqual([
      '<img src=x onerror=alert(1)><provider>', '2', '1,600', '200', '1,800', '33.3%',
    ])
    expect(node('trend').children[0]?.children[1]?.children[0]?.style.width).toBe('100%')
    expect(node('content').hidden).toBe(false)
    expect(node('updated').textContent).toContain('12:00:00')
  })
  it('switches range locally with accessible selected state', async () => {
    const read = vi.fn(async () => snapshot())
    installUsageMonitor(read)
    await settled()
    tabs[1]!.click()
    expect(node('requests').textContent).toBe('7')
    expect(tabs[1]!.attributes.get('aria-pressed')).toBe('true')
    expect(tabs[0]!.attributes.get('aria-pressed')).toBe('false')
    expect(read).toHaveBeenCalledTimes(1)
  })
  it('keeps refresh failure visible when changing ranges, then clears it after recovery', async () => {
    const read = vi.fn<() => Promise<UsageSnapshot>>().mockResolvedValueOnce(snapshot()).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(snapshot())
    installUsageMonitor(read)
    await settled()
    node('refresh').click()
    await settled()
    expect(node('status').textContent).toContain('上次成功')
    tabs[2]!.click()
    expect(node('requests').textContent).toBe('30')
    expect(node('status').dataset.kind).toBe('error')
    expect(node('status').textContent).toContain('上次成功')
    node('refresh').click()
    await settled()
    expect(node('status').dataset.kind).toBe('normal')
  })
  it('handles loading, first failure, empty results and partial-data warnings', async () => {
    const read = vi.fn<() => Promise<UsageSnapshot>>().mockRejectedValueOnce(new Error('failed'))
    const empty = snapshot()
    empty.ranges.today = summary({ requestCount: 0, models: [], daily: [] })
    empty.warnings = ['部分日志损坏']
    read.mockResolvedValueOnce(empty)
    installUsageMonitor(read)
    expect(node('refresh').disabled).toBe(true)
    expect(node('status').textContent).toContain('正在读取')
    await settled()
    expect(node('status').textContent).toContain('读取用量失败')
    node('refresh').click()
    await settled()
    expect(node('status').textContent).toContain('暂无')
    expect(node('model-empty').hidden).toBe(false)
    expect(node('trend-empty').hidden).toBe(false)
    expect(node('warning').textContent).toBe('部分日志损坏')
  })
  it('prevents overlapping loads and cleans up auto refresh and pending results on disposal', async () => {
    let complete!: (value: UsageSnapshot) => void
    const read = vi.fn(() => new Promise<UsageSnapshot>(resolve => { complete = resolve }))
    const dispose = installUsageMonitor(read)
    node('refresh').click()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    complete(snapshot())
    await settled()
    node('auto').checked = false
    node('auto').dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(1)
    node('auto').checked = true
    node('auto').dispatchEvent(new Event('change'))
    await vi.advanceTimersByTimeAsync(15_000)
    expect(read).toHaveBeenCalledTimes(2)
    dispose()
    const final = snapshot()
    final.ranges.today.totalTokens = 999
    complete(final)
    await settled()
    expect(node('total').textContent).toBe('1,800')
    await vi.advanceTimersByTimeAsync(30_000)
    node('refresh').click()
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('limits all-time charts to 30 active days without truncating totals', async () => {
    const data = snapshot()
    data.ranges.all.daily = Array.from({ length: 40 }, (_, index) => ({ date: String(index), totalTokens: index, requestCount: 1 }))
    installUsageMonitor(async () => data)
    await settled()
    tabs[3]!.click()
    expect(node('trend').children).toHaveLength(30)
    expect(node('trend-caption').textContent).toContain('30 个活跃日')
    expect(node('requests').textContent).toBe('100')
  })
  it('does not install on unrelated utility or web pages', () => {
    body.dataset.page = 'other'
    const read = vi.fn()
    installUsageMonitor(read)
    expect(read).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
