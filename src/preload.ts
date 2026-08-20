import { contextBridge, ipcRenderer } from 'electron'
import type { RuntimePreference } from './catalog.ts'
import type { PluginEntry, PluginList, PluginOperationStatus, PluginStartInput } from './plugin-manager.ts'
import type { RuntimeView } from './runtime-controller.ts'
import type { SessionRepairAnomalyKind, SessionRepairInspection, SessionRepairResult, SessionRepairRollbackResult } from './session-repair.ts'
import type { ShellUpdateProgress } from './shell-updater.ts'

contextBridge.exposeInMainWorld('dshDesktopSkins', {
  list: () => ipcRenderer.invoke('shell-skins:list'),
  preview: (skinId: string, index: number) => ipcRenderer.invoke('shell-skins:preview', skinId, index),
  install: (skinId: string) => ipcRenderer.invoke('shell-skins:install', skinId),
  activate: (skinId: string) => ipcRenderer.invoke('shell-skins:activate', skinId),
  selectVariant: (skinId: string, variantId: string) => ipcRenderer.invoke('shell-skins:select-variant', skinId, variantId),
  deactivate: () => ipcRenderer.invoke('shell-skins:deactivate'),
  uninstall: (skinId: string) => ipcRenderer.invoke('shell-skins:uninstall', skinId),
  onProgress: (listener: (progress: unknown) => void) => {
    const wrapped = (_event: Electron.IpcRendererEvent, progress: unknown) => listener(progress)
    ipcRenderer.on('shell-skins:progress', wrapped)
    return () => { ipcRenderer.removeListener('shell-skins:progress', wrapped) }
  },
})

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>('#' + id)
  if (value === null) throw new Error('page is missing #' + id)
  return value
}

let runtimeRecoveryIds: string[] = []
let runtimeRecoveryCount = 0
let runtimePresetRecovery: { pluginName: string; presetId: string } | undefined

function renderRuntime(view: RuntimeView): void {
  element('shell-version').textContent = 'Shell ' + view.shellVersion + ' · 最低 DSH ' + view.minimumDshVersion
  element('message').textContent = view.message
  const versionDetail = view.currentVersion === undefined
    ? ''
    : '当前运行版本：' + view.currentVersion + ' · desktop revision ' + String(view.currentRuntimeRevision ?? 0)
  runtimeRecoveryIds = view.recovery?.kind === 'stale-local-plugins' ? view.recovery.entryIds : []
  runtimeRecoveryCount = view.recovery?.kind === 'stale-local-plugins' ? view.recovery.count : runtimeRecoveryIds.length
  runtimePresetRecovery = view.recovery?.kind === 'plugin-preset-conflict'
    ? { pluginName: view.recovery.pluginName, presetId: view.recovery.presetId }
    : undefined
  const staleDetail = runtimeRecoveryIds.length === 0 ? '' : '检测到失效的本地插件：' + runtimeRecoveryIds.join('、')
  const presetDetail = runtimePresetRecovery === undefined ? '' : '检测到冲突的插件预设：' + runtimePresetRecovery.presetId
  element('detail').textContent = [versionDetail, staleDetail, presetDetail].filter(value => value.length > 0).join('\n')
  const progress = view.progress === undefined || view.progress.total === 0 ? 0 : Math.min(100, (view.progress.received / view.progress.total) * 100)
  element<HTMLDivElement>('progress-value').style.width = String(progress) + '%'
  element('cache').style.display = view.cachedCatalog ? 'block' : 'none'
  const error = element('error')
  error.textContent = view.error ?? ''
  error.style.display = view.error === undefined ? 'none' : 'block'
  const select = element<HTMLSelectElement>('version')
  const previous = select.value
  select.replaceChildren()
  const latest = document.createElement('option')
  latest.value = 'latest-compatible'
  latest.textContent = '自动选择最新兼容版本'
  select.append(latest)
  for (const version of view.versions) {
    const option = document.createElement('option')
    option.value = version.version
    const flags = [version.current ? '当前' : '', version.installed ? '已安装' : ''].filter(Boolean).join(' · ')
    const label = version.version + ' · desktop revision ' + String(version.runtimeRevision)
    option.textContent = flags.length === 0 ? label : label + ' (' + flags + ')'
    select.append(option)
  }
  const preferred = view.preference.mode === 'latest-compatible' ? 'latest-compatible' : view.preference.version
  select.value = previous !== '' && [...select.options].some(option => option.value === previous) ? previous : preferred
  const busy = view.phase === 'checking' || view.phase === 'downloading' || view.phase === 'starting'
  select.disabled = busy
  element<HTMLButtonElement>('apply').disabled = busy || view.versions.length === 0
  element<HTMLButtonElement>('retry').disabled = busy
  const recoverButton = element<HTMLButtonElement>('recover-stale-plugins')
  recoverButton.hidden = runtimeRecoveryIds.length === 0
  recoverButton.disabled = busy || runtimeRecoveryIds.length === 0
  recoverButton.textContent = runtimeRecoveryCount <= 1
    ? '禁用失效本地插件并重试'
    : '禁用 ' + String(runtimeRecoveryCount) + ' 个失效本地插件并重试'
  const presetButton = element<HTMLButtonElement>('recover-plugin-preset')
  presetButton.hidden = runtimePresetRecovery === undefined
  presetButton.disabled = busy || runtimePresetRecovery === undefined
}

function initializeShellUpdatePage(): void {
  ipcRenderer.on('shell-update:progress', (_event, progress: ShellUpdateProgress) => {
    const downloading = progress.state === 'downloading'
    const preparing = progress.state === 'preparing-restart'
    const version = downloading || preparing ? progress.version : ''
    const progressElement = element<HTMLProgressElement>('progress')
    element('version').textContent = version.length === 0 ? 'Shell 更新' : 'Shell ' + version
    if (downloading) {
      const percent = Math.max(0, Math.min(100, progress.percent))
      progressElement.value = percent
      element('percent').textContent = percent.toFixed(1) + '%'
      element('transferred').textContent = formatBytes(progress.transferred)
      element('total').textContent = formatBytes(progress.total)
      element('speed').textContent = formatBytes(progress.bytesPerSecond) + '/s'
    } else {
      progressElement.removeAttribute('value')
      element('percent').textContent = preparing ? '完成' : ''
      element('transferred').textContent = ''
      element('total').textContent = ''
      element('speed').textContent = ''
    }
    element('status').textContent = progress.state === 'error'
      ? progress.message
      : preparing
        ? '下载完成，正在关闭 Runtime 并准备重启...'
        : downloading
          ? '正在下载更新，完成后将自动安装并重启。'
          : progress.state === 'checking' ? '正在检查更新...' : '当前已是最新版本。'
  })
}

function initializeRuntimePage(): void {
  ipcRenderer.on('runtime:view', (_event, view: RuntimeView) => { renderRuntime(view) })
  element<HTMLButtonElement>('retry').addEventListener('click', () => { void ipcRenderer.invoke('runtime:retry') })
  element<HTMLButtonElement>('recover-stale-plugins').addEventListener('click', () => {
    if (runtimeRecoveryIds.length === 0) return
    const names = runtimeRecoveryIds.join('、')
    if (!window.confirm('将备份配置并禁用 ' + String(runtimeRecoveryCount) + ' 个失效本地插件：' + names + '。会话、设置和其他插件不会被删除。是否继续？')) return
    void ipcRenderer.invoke('runtime:recover-stale-local-plugins').catch((error: unknown) => {
      const errorElement = element('error')
      errorElement.textContent = errorMessage(error)
      errorElement.style.display = 'block'
    })
  })
  element<HTMLButtonElement>('recover-plugin-preset').addEventListener('click', () => {
    const recovery = runtimePresetRecovery
    if (recovery === undefined) return
    const message = '将完整备份预设 ' + recovery.presetId + '，再用插件 ' + recovery.pluginName
      + ' 当前打包版本重置该预设。人工修改不会被删除，但会移入带 desktop-backup 标记的备份目录。是否继续？'
    if (!window.confirm(message)) return
    void ipcRenderer.invoke('runtime:recover-plugin-preset').catch((error: unknown) => {
      const errorElement = element('error')
      errorElement.textContent = errorMessage(error)
      errorElement.style.display = 'block'
    })
  })
  element<HTMLButtonElement>('apply').addEventListener('click', () => {
    const value = element<HTMLSelectElement>('version').value
    const preference: RuntimePreference = value === 'latest-compatible' ? { mode: 'latest-compatible' } : { mode: 'pinned', version: value }
    void ipcRenderer.invoke('runtime:set-preference', preference)
  })
  void (ipcRenderer.invoke('runtime:get-view') as Promise<RuntimeView>).then(renderRuntime)
}

function setHidden(id: string, hidden: boolean): void { element(id).hidden = hidden }

function formatBytes(value: number | undefined): string {
  if (value === undefined) return 'Runtime 未返回'
  if (value < 1024) return String(value) + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let amount = value / 1024
  let unit = units[0] ?? 'KB'
  for (let index = 1; index < units.length && amount >= 1024; index += 1) {
    amount /= 1024
    unit = units[index] ?? unit
  }
  return amount.toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' ' + unit
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': Error: /u, '')
}

function initializePluginManagerPage(): void {
  const specInput = element<HTMLInputElement>('plugin-spec')
  const installButton = element<HTMLButtonElement>('plugin-install')
  const refreshButton = element<HTMLButtonElement>('plugin-refresh')
  const progress = element<HTMLProgressElement>('plugin-progress')
  const statusElement = element('plugin-status')
  const listElement = element('plugin-list')
  const emptyElement = element('plugin-empty')
  const logSection = element('plugin-log-section')
  const logElement = element('plugin-log')
  let busy = false

  const setStatus = (message: string, kind: 'normal' | 'success' | 'error' = 'normal'): void => {
    statusElement.textContent = message
    statusElement.dataset.kind = kind
  }
  const setBusy = (value: boolean): void => {
    busy = value
    specInput.disabled = value
    installButton.disabled = value
    refreshButton.disabled = value
    progress.hidden = !value
    for (const button of listElement.querySelectorAll<HTMLButtonElement>('button')) button.disabled = value
  }
  const showLog = (value: string): void => {
    logElement.textContent = value
    logSection.hidden = value.length === 0
    logElement.scrollTop = logElement.scrollHeight
  }
  const renderEntries = (entries: PluginEntry[]): void => {
    listElement.replaceChildren()
    emptyElement.hidden = entries.length !== 0
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = 'plugin-row'
      row.setAttribute('role', 'listitem')
      const main = document.createElement('div')
      main.className = 'plugin-main'
      const name = document.createElement('div')
      name.className = 'plugin-name'
      name.textContent = entry.name
      const meta = document.createElement('div')
      meta.className = 'plugin-meta'
      meta.textContent = (entry.version === undefined ? '未解析版本' : '版本 ' + entry.version)
        + (entry.spec === undefined ? '' : ' · ' + entry.spec)
      main.append(name, meta)
      const actions = document.createElement('div')
      actions.className = 'plugin-actions'
      const updateButton = document.createElement('button')
      updateButton.type = 'button'
      updateButton.textContent = '更新'
      updateButton.addEventListener('click', () => { void runOperation({ action: 'update', packageName: entry.name }, '更新 ' + entry.name) })
      const removeButton = document.createElement('button')
      removeButton.type = 'button'
      removeButton.className = 'danger'
      removeButton.textContent = '卸载'
      removeButton.addEventListener('click', () => {
        if (window.confirm('确认卸载 ' + entry.name + '？')) void runOperation({ action: 'remove', packageName: entry.name }, '卸载 ' + entry.name)
      })
      actions.append(updateButton, removeButton)
      row.append(main, actions)
      listElement.append(row)
    }
  }
  const loadEntries = async (): Promise<void> => {
    const value = await ipcRenderer.invoke('plugin-manager:list') as PluginList
    renderEntries(value.entries)
  }
  const waitForOperation = async (operationId: string): Promise<PluginOperationStatus> => {
    for (;;) {
      const value = await ipcRenderer.invoke('plugin-manager:status', operationId) as PluginOperationStatus
      showLog(value.output)
      if (value.state !== 'running') return value
      await new Promise<void>(resolve => { setTimeout(resolve, 350) })
    }
  }
  const resumeOrRefresh = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus('正在读取插件状态...')
    try {
      const current = await ipcRenderer.invoke('plugin-manager:current') as PluginOperationStatus | undefined
      if (current === undefined) {
        await loadEntries()
        setStatus('插件列表已刷新', 'success')
        return
      }
      showLog(current.output)
      setStatus(current.state === 'running' ? '检测到尚未完成的插件操作，正在继续等待...' : '插件操作已完成，正在重启 Runtime...')
      const result = current.state === 'running' ? await waitForOperation(current.operationId) : current
      if (result.state === 'failed') throw new Error(result.error ?? '插件操作失败')
      await ipcRenderer.invoke('plugin-manager:restart', result.operationId)
      await loadEntries()
      setStatus('插件操作已完成', 'success')
    } catch (error: unknown) {
      setStatus(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }
  async function runOperation(input: PluginStartInput, label: string): Promise<void> {
    if (busy) return
    setBusy(true)
    showLog('')
    setStatus(label + '，请稍候...')
    try {
      const started = await ipcRenderer.invoke('plugin-manager:start', input) as { operationId: string }
      const result = await waitForOperation(started.operationId)
      if (result.state === 'failed') throw new Error(result.error ?? '插件操作失败')
      setStatus(label + '完成，正在重启 Runtime...')
      await ipcRenderer.invoke('plugin-manager:restart', started.operationId)
      await loadEntries()
      if (input.action === 'add') specInput.value = ''
      setStatus(label + '完成', 'success')
    } catch (error: unknown) {
      setStatus(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  installButton.addEventListener('click', () => {
    const spec = specInput.value
    if (spec.length === 0) { setStatus('请输入插件包名或 GitHub 地址', 'error'); specInput.focus(); return }
    void runOperation({ action: 'add', spec }, '安装插件')
  })
  specInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') installButton.click()
  })
  refreshButton.addEventListener('click', () => { void resumeOrRefresh() })
  void resumeOrRefresh()
}

function anomalyLabel(kind: SessionRepairAnomalyKind): string {
  if (kind === 'branch-reset') return '分支重置'
  if (kind === 'stale-single-event') return '陈旧单条事件'
  return '无法明确判断'
}

function isSafeInspection(value: SessionRepairInspection | undefined): boolean {
  return value !== undefined && value.repairable && value.eventCount !== undefined && value.fileSize !== undefined
    && value.backupPath !== undefined && value.preservesAllEvents === true
    && value.strategy === 'renumber-preserve-physical-order' && value.anomalies.length > 0
    && value.anomalies.every(anomaly => anomaly.kind !== 'ambiguous')
}

function initializeRepairPage(): void {
  const sessionInput = element<HTMLInputElement>('repair-session-id')
  const inspectButton = element<HTMLButtonElement>('repair-inspect')
  const confirm = element<HTMLInputElement>('repair-confirm')
  const applyButton = element<HTMLButtonElement>('repair-apply')
  const rollbackButton = element<HTMLButtonElement>('repair-rollback')
  const status = element<HTMLParagraphElement>('repair-status')
  let inspection: SessionRepairInspection | undefined
  let repairResult: SessionRepairResult | undefined
  let busy = false

  function setStatus(message: string, state: 'normal' | 'error' | 'success' = 'normal'): void {
    status.textContent = message
    status.className = state === 'normal' ? 'status' : 'status ' + state
  }

  function updateControls(): void {
    sessionInput.disabled = busy
    inspectButton.disabled = busy
    confirm.disabled = busy || !isSafeInspection(inspection) || repairResult !== undefined
    applyButton.disabled = busy || !confirm.checked || !isSafeInspection(inspection) || repairResult !== undefined
    rollbackButton.disabled = busy || repairResult === undefined
    setHidden('repair-progress', !busy)
  }

  function setBusy(value: boolean): void { busy = value; updateControls() }

  function renderAnomalies(value: SessionRepairInspection): void {
    const rows = element<HTMLTableSectionElement>('anomaly-rows')
    rows.replaceChildren()
    for (const anomaly of value.anomalies) {
      const row = document.createElement('tr')
      for (const text of [anomalyLabel(anomaly.kind), String(anomaly.eventIndex), String(anomaly.expectedSeq), String(anomaly.actualSeq), String(anomaly.runLength)]) {
        const cell = document.createElement('td')
        cell.textContent = text
        row.append(cell)
      }
      rows.append(row)
    }
    element('anomaly-count').textContent = String(value.anomalies.length) + ' 处'
    setHidden('repair-anomalies', value.anomalies.length === 0)
  }

  function renderInspection(value: SessionRepairInspection): void {
    inspection = value
    repairResult = undefined
    confirm.checked = false
    element('inspection-session-id').textContent = value.sessionId
    element('inspection-revision').textContent = value.revision
    element('inspection-file-size').textContent = formatBytes(value.fileSize)
    element('inspection-event-count').textContent = value.eventCount === undefined ? 'Runtime 未返回' : value.eventCount.toLocaleString('zh-CN')
    element('inspection-strategy').textContent = value.strategy === 'renumber-preserve-physical-order' ? '保持物理顺序并统一重编号' : '无自动修复策略'
    element('inspection-preserves').textContent = value.preservesAllEvents === true ? '是' : value.preservesAllEvents === false ? '否' : 'Runtime 未确认'
    element('inspection-backup').textContent = value.backupPath ?? 'Runtime 未返回（禁止自动修复）'
    element('inspection-reason').textContent = value.reason ?? '无'
    const safe = isSafeInspection(value)
    element('repairability').textContent = safe ? '可安全修复' : value.anomalies.length === 0 ? '无需修复' : '禁止自动修复'
    setHidden('repair-inspection', false)
    setHidden('repair-result', true)
    renderAnomalies(value)
    updateControls()
  }

  function renderRepairResult(value: SessionRepairResult): void {
    repairResult = value
    inspection = undefined
    element('result-event-count').textContent = value.eventCount.toLocaleString('zh-CN')
    element('result-last-seq').textContent = value.lastSeq.toLocaleString('zh-CN')
    element('result-message-count').textContent = value.derivedMessageCount.toLocaleString('zh-CN')
    element('result-previous-revision').textContent = value.previousRevision
    element('result-new-revision').textContent = value.newRevision
    element('result-backup').textContent = '备份：' + value.backupPath
    setHidden('repair-result', false)
    updateControls()
  }

  async function inspectSession(): Promise<void> {
    const sessionId = sessionInput.value.trim()
    if (sessionId.length === 0) { setStatus('请输入会话 ID。', 'error'); sessionInput.focus(); return }
    inspection = undefined
    repairResult = undefined
    confirm.checked = false
    setHidden('repair-inspection', true)
    setHidden('repair-anomalies', true)
    setHidden('repair-result', true)
    setStatus('正在读取并诊断会话日志…')
    setBusy(true)
    try {
      const value = await ipcRenderer.invoke('session-repair:inspect', sessionId) as SessionRepairInspection
      renderInspection(value)
      if (isSafeInspection(value)) setStatus('诊断完成。请核对信息后确认修复。', 'success')
      else if (value.anomalies.length === 0) setStatus(value.reason ?? '日志健康，无需修复。', 'success')
      else setStatus(value.reason ?? '诊断结果不满足自动修复条件。', 'error')
    } catch (error: unknown) { setStatus(errorMessage(error), 'error') }
    finally { setBusy(false) }
  }

  inspectButton.addEventListener('click', () => { void inspectSession() })
  sessionInput.addEventListener('keydown', event => { if (event.key === 'Enter' && !busy) void inspectSession() })
  confirm.addEventListener('change', updateControls)
  applyButton.addEventListener('click', () => {
    const current = inspection
    if (current === undefined || !confirm.checked || !isSafeInspection(current)) return
    setStatus('正在修复并执行完整语义重放验证…')
    setBusy(true)
    void (async () => {
      try {
        const value = await ipcRenderer.invoke('session-repair:apply', current.sessionId, current.revision) as SessionRepairResult
        renderRepairResult(value)
        setStatus('修复成功，历史会话已刷新。', 'success')
      } catch (error: unknown) { setStatus(errorMessage(error), 'error') }
      finally { setBusy(false) }
    })()
  })
  rollbackButton.addEventListener('click', () => {
    const current = repairResult
    if (current === undefined || !window.confirm('确认使用保留的备份回滚此会话？')) return
    setStatus('正在回滚会话备份…')
    setBusy(true)
    void (async () => {
      try {
        const value = await ipcRenderer.invoke('session-repair:rollback', current.sessionId, current.newRevision) as SessionRepairRollbackResult
        repairResult = undefined
        setHidden('repair-inspection', true)
        setHidden('repair-anomalies', true)
        setHidden('repair-result', true)
        setStatus('回滚成功，新 revision：' + value.newRevision, 'success')
      } catch (error: unknown) { setStatus(errorMessage(error), 'error') }
      finally { setBusy(false) }
    })()
  })
  updateControls()
  sessionInput.focus()
}

window.addEventListener('DOMContentLoaded', () => {
  if (document.querySelector('#shell-update-page') !== null) initializeShellUpdatePage()
  else if (document.querySelector('#plugin-manager-page') !== null) initializePluginManagerPage()
  else if (document.querySelector('#version') !== null) initializeRuntimePage()
  else if (document.querySelector('#repair-session-id') !== null) initializeRepairPage()
})
