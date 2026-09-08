import type { UsageRange, UsageScanProgress, UsageSnapshot } from './usage-monitor.ts'

const countFormatter = new Intl.NumberFormat('zh-CN')
const percentFormatter = new Intl.NumberFormat('zh-CN', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
const updatedFormatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
})
export function formatCount(value: number): string {
  return countFormatter.format(Number.isFinite(value) ? Math.max(0, value) : 0)
}
export function formatPercent(value: number): string {
  return percentFormatter.format(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0)
}

export function installUsageMonitor(readSnapshot: () => Promise<UsageSnapshot>, subscribeProgress?: (listener: (progress: UsageScanProgress) => void) => () => void): () => void {
  if (document.body.dataset.page !== 'usage-monitor') return () => {}
  const element = <T extends HTMLElement>(id: string): T => {
    const node = document.getElementById(id)
    if (node === null) throw new Error('Missing usage monitor element: ' + id)
    return node as T
  }
  const text = (id: string, value: string): void => { element(id).textContent = value }
  const refresh = element<HTMLButtonElement>('usage-refresh')
  const auto = element<HTMLInputElement>('usage-auto')
  const status = element('usage-status')
  const content = element('usage-content')
  const warning = element('usage-warning')
  const models = element('usage-models')
  const trend = element('usage-trend')
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-range]')]
  let selected: UsageRange = 'today'
  let snapshot: UsageSnapshot | undefined
  let error: string | undefined
  let busy = false
  let disposed = false
  let timer: ReturnType<typeof setInterval> | undefined
  let unsubscribeProgress: (() => void) | undefined
  let progress: UsageScanProgress | undefined
  const progressElement = element<HTMLProgressElement>('usage-progress')
  const progressStatus = element('usage-progress-status')
  const elapsed = element('usage-elapsed')
  let startedAt = 0
  let elapsedTimer: ReturnType<typeof setInterval> | undefined

  const renderStatus = (): void => {
    status.dataset.kind = error === undefined ? 'normal' : 'error'
    status.textContent = error ?? (busy ? '正在读取用量…' : snapshot?.ranges[selected].requestCount === 0 ? '此范围暂无已记录用量' : '已同步本地记录')
    progressStatus.hidden = !busy
    if (!busy) return
    const current = progress
    const discovering = current === undefined || current.phase === 'discovering'
    text('usage-progress-label', discovering
      ? '正在发现会话文件 · 已找到 ' + formatCount(current?.discoveredFiles ?? 0) + ' 个'
      : (current.phase === 'complete' ? '扫描完成' : '正在扫描日志') + ' · ' + formatCount(current.processedFiles) + '/' + formatCount(current.totalFiles) + ' 个文件 · ' + Math.floor(current.percent) + '%')
    progressElement.max = 100
    if (discovering) progressElement.removeAttribute('value')
    else progressElement.value = current.percent
    progressElement.setAttribute('aria-valuetext', discovering ? '正在发现会话文件' : Math.floor(current.percent) + '%')
    const fileElement = element('usage-progress-file')
    fileElement.textContent = current?.currentFile ?? ''
    fileElement.title = current?.currentFile ?? ''
    elapsed.textContent = '已用时 ' + Math.floor((Date.now() - startedAt) / 1000) + ' 秒'
  }
  const render = (): void => {
    renderStatus()
    for (const tab of tabs) tab.setAttribute('aria-pressed', String(tab.dataset.range === selected))
    if (snapshot === undefined) return
    const summary = snapshot.ranges[selected]
    content.hidden = false
    warning.hidden = snapshot.warnings.length === 0
    warning.textContent = snapshot.warnings.join(' ')
    text('usage-updated', '更新于 ' + updatedFormatter.format(new Date(snapshot.updatedAt)))
    const counts: Record<string, number> = {
      requests: summary.requestCount, total: summary.totalTokens, cache: summary.cacheReadTokens,
      days: summary.activeDays, 'model-count': summary.models.length, input: summary.inputTokens,
      read: summary.cacheReadTokens, write: summary.cacheWriteTokens, output: summary.outputTokens, reasoning: summary.reasoningTokens,
    }
    for (const [id, value] of Object.entries(counts)) text('usage-' + id, formatCount(value))
    text('usage-rate', formatPercent(summary.cacheHitRate))
    models.replaceChildren()
    for (const model of summary.models) {
      const row = document.createElement('tr')
      const name = document.createElement('td')
      const title = document.createElement('strong')
      title.textContent = model.model
      const provider = document.createElement('span')
      provider.className = 'provider'
      provider.textContent = model.provider
      name.append(title, provider)
      row.append(name)
      const values = [formatCount(model.requestCount), formatCount(model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens),
        formatCount(model.outputTokens), formatCount(model.totalTokens), formatPercent(model.cacheHitRate)]
      for (const value of values) {
        const cell = document.createElement('td')
        cell.textContent = value
        row.append(cell)
      }
      models.append(row)
    }
    element('usage-model-empty').hidden = summary.models.length > 0
    trend.replaceChildren()
    const days = selected === 'all' ? summary.daily.slice(-30) : summary.daily
    text('usage-trend-caption', selected === 'all' && summary.daily.length > 30 ? '最近 30 个活跃日 · Token / 日' : 'Token / 日')
    const maximum = days.reduce((max, day) => Math.max(max, day.totalTokens), 1)
    for (const day of days) {
      const row = document.createElement('div')
      row.className = 'day'
      row.title = day.date + ' · ' + formatCount(day.requestCount) + ' 次请求 · ' + formatCount(day.totalTokens) + ' Token'
      const date = document.createElement('span')
      date.textContent = day.date
      const track = document.createElement('div')
      track.className = 'track'
      track.setAttribute('aria-hidden', 'true')
      const bar = document.createElement('div')
      bar.className = 'bar'
      bar.style.width = String(day.totalTokens / maximum * 100) + '%'
      track.append(bar)
      const value = document.createElement('span')
      value.className = 'day-value'
      value.textContent = formatCount(day.totalTokens)
      row.append(date, track, value)
      trend.append(row)
    }
    element('usage-trend-empty').hidden = days.length > 0
  }
  const load = async (): Promise<void> => {
    if (busy || disposed) return
    busy = true
    progress = undefined
    startedAt = Date.now()
    refresh.disabled = true
    progressStatus.hidden = false
    progressElement.value = 0
    if (elapsedTimer !== undefined) clearInterval(elapsedTimer)
    elapsedTimer = setInterval(() => { if (!disposed) renderStatus() }, 1000)
    content.setAttribute('aria-busy', 'true')
    renderStatus()
    try {
      if (subscribeProgress !== undefined) unsubscribeProgress = subscribeProgress(nextProgress => { if (!disposed) { progress = nextProgress; renderStatus() } })
      const next = await readSnapshot()
      if (disposed) return
      snapshot = next
      error = undefined
    } catch {
      if (disposed) return
      error = snapshot === undefined ? '读取用量失败，请重试。' : '刷新失败，当前显示上次成功读取的数据。'
    } finally {
      if (!disposed) {
        busy = false
        progress = undefined
        if (unsubscribeProgress !== undefined) { unsubscribeProgress(); unsubscribeProgress = undefined }
        if (elapsedTimer !== undefined) { clearInterval(elapsedTimer); elapsedTimer = undefined }
        refresh.disabled = false
        content.setAttribute('aria-busy', 'false')
        render()
      }
    }
  }
  const resetTimer = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = auto.checked ? setInterval(() => { void load() }, 15_000) : undefined
  }
  const onRefresh = (): void => { void load() }
  const onRange = (event: Event): void => {
    const range = (event.currentTarget as HTMLElement).dataset.range
    if (range === 'today' || range === '7d' || range === '30d' || range === 'all') {
      selected = range
      render()
    }
  }
  const dispose = (): void => {
    disposed = true
    if (timer !== undefined) clearInterval(timer)
    if (elapsedTimer !== undefined) clearInterval(elapsedTimer)
    unsubscribeProgress?.()
    refresh.removeEventListener('click', onRefresh)
    auto.removeEventListener('change', resetTimer)
    for (const tab of tabs) tab.removeEventListener('click', onRange)
    window.removeEventListener('beforeunload', dispose)
  }
  refresh.addEventListener('click', onRefresh)
  auto.addEventListener('change', resetTimer)
  for (const tab of tabs) tab.addEventListener('click', onRange)
  window.addEventListener('beforeunload', dispose, { once: true })
  resetTimer()
  void load()
  return dispose
}