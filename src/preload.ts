import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { RuntimePreference } from './catalog.ts'
import type { McpEndpointView, McpEntryView, McpList } from './mcp-manager.ts'
import type { PluginEntry, PluginList, PluginOperationStatus, PluginStartInput, PluginUpdateList } from './plugin-manager.ts'
import type { RuntimeView } from './runtime-controller.ts'
import type { SessionRepairAnomalyKind, SessionRepairInspection, SessionRepairResult, SessionRepairRollbackResult } from './session-repair.ts'
import type { ShellUpdateProgress } from './shell-updater.ts'

contextBridge.exposeInMainWorld('dshDesktopFiles', {
  getAbsolutePath: (file: File): string => webUtils.getPathForFile(file),
})

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

const PET_ACTIVE_SESSION_MESSAGE = 'dsh/desktop-pet-active-session'

function petActiveSession(value: unknown): string | null | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const payload = value as Record<string, unknown>
  if (payload.type !== PET_ACTIVE_SESSION_MESSAGE) return undefined
  if (payload.sessionId === null) return null
  if (typeof payload.sessionId !== 'string'
    || payload.sessionId.length === 0
    || payload.sessionId.length > 128
    || !/^[0-9A-Za-z._~-]+$/u.test(payload.sessionId)) return undefined
  return payload.sessionId
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return
  const sessionId = petActiveSession(event.data)
  if (sessionId !== undefined) ipcRenderer.send('pet:set-active-session', sessionId)
})

function element<T extends HTMLElement>(id: string): T {
  const value = document.querySelector<T>('#' + id)
  if (value === null) throw new Error('page is missing #' + id)
  return value
}

let runtimeRecoveryIds: string[] = []
let runtimeRecoveryCount = 0
let runtimeBundleRecovery: { packageNames: string[]; count: number } | undefined
let runtimePresetRecovery: { pluginName: string; presetId: string } | undefined
let runtimeLatestView: RuntimeView | undefined
let runtimeDraftMode: RuntimePreference['mode'] | undefined
let runtimeDraftVersion: string | undefined
let runtimePreferenceTouched = false
let runtimeManagerMode = false

const runtimePhaseLabels: Record<RuntimeView['phase'], string> = {
  checking: '检查中',
  downloading: '下载中',
  starting: '启动中',
  ready: '已就绪',
  error: '需要处理',
}

function runtimePreferenceMatches(view: RuntimeView): boolean {
  if (runtimeDraftMode !== view.preference.mode) return false
  return runtimeDraftMode === 'latest-compatible'
    || (view.preference.mode === 'pinned' && runtimeDraftVersion === view.preference.version)
}

function renderRuntime(view: RuntimeView): void {
  runtimeLatestView = view
  if (!runtimePreferenceTouched) {
    runtimeDraftMode = view.preference.mode
    runtimeDraftVersion = view.preference.mode === 'pinned' ? view.preference.version : undefined
  }
  runtimeDraftMode ??= 'latest-compatible'
  const availableVersions = view.versions.filter((version, index, versions) =>
    versions.findIndex(candidate => candidate.version === version.version) === index)
  const fallbackVersion = availableVersions.find(version => version.current)?.version ?? availableVersions[0]?.version
  runtimeDraftVersion ??= fallbackVersion

  const busy = view.phase === 'checking' || view.phase === 'downloading' || view.phase === 'starting'
  document.body.dataset.phase = view.phase
  document.body.dataset.view = runtimeManagerMode ? 'manager' : 'startup'
  element<HTMLElement>('version-settings').hidden = !runtimeManagerMode
  element('runtime-page').setAttribute('aria-busy', String(busy))
  element('phase-chip').textContent = runtimePhaseLabels[view.phase]
  element('shell-version').textContent = 'Shell ' + view.shellVersion + ' · 最低 DSH ' + view.minimumDshVersion
  element('message').textContent = view.message

  const versionDetail = view.currentVersion === undefined
    ? ''
    : '当前使用：DSH ' + view.currentVersion
  runtimeRecoveryIds = view.recovery?.kind === 'stale-local-plugins' ? view.recovery.entryIds : []
  runtimeRecoveryCount = view.recovery?.kind === 'stale-local-plugins' ? view.recovery.count : runtimeRecoveryIds.length
  runtimeBundleRecovery = view.recovery?.kind === 'profile-bundle-mismatch'
    ? { packageNames: view.recovery.packageNames, count: view.recovery.count }
    : undefined
  runtimePresetRecovery = view.recovery?.kind === 'plugin-preset-conflict'
    ? { pluginName: view.recovery.pluginName, presetId: view.recovery.presetId }
    : undefined
  const staleDetail = runtimeRecoveryIds.length === 0 ? '' : '检测到失效的本地插件：' + runtimeRecoveryIds.join('、')
  const bundleDetail = runtimeBundleRecovery === undefined
    ? ''
    : '检测到不兼容的 Profile bundle：' + runtimeBundleRecovery.packageNames.join('、')
  const presetDetail = runtimePresetRecovery === undefined ? '' : '检测到冲突的插件预设：' + runtimePresetRecovery.presetId
  element('detail').textContent = [versionDetail, staleDetail, bundleDetail, presetDetail].filter(value => value.length > 0).join('\n')

  const progressElement = element('runtime-progress')
  const progressRow = element('runtime-progress-row')
  const progress = view.progress === undefined || view.progress.total === 0
    ? undefined
    : Math.max(0, Math.min(100, (view.progress.received / view.progress.total) * 100))
  const indeterminate = busy && progress === undefined
  progressRow.hidden = !busy
  progressElement.dataset.indeterminate = String(indeterminate)
  element<HTMLDivElement>('progress-value').style.width = String(progress ?? 0) + '%'
  if (progress === undefined) progressElement.removeAttribute('aria-valuenow')
  else progressElement.setAttribute('aria-valuenow', progress.toFixed(1))
  element('progress-label').textContent = progress !== undefined
    ? progress.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) + '%'
    : view.phase === 'checking' ? '正在检查' : view.phase === 'starting' ? '正在连接' : '正在准备'

  element('cache').style.display = view.cachedCatalog ? 'block' : 'none'
  const error = element('error')
  error.textContent = view.error ?? ''
  error.style.display = view.error === undefined ? 'none' : 'block'

  const autoInput = element<HTMLInputElement>('version-mode-auto')
  const pinnedInput = element<HTMLInputElement>('version-mode-pinned')
  autoInput.checked = runtimeDraftMode === 'latest-compatible'
  pinnedInput.checked = runtimeDraftMode === 'pinned'
  autoInput.disabled = busy
  pinnedInput.disabled = busy

  const select = element<HTMLSelectElement>('version')
  select.replaceChildren()
  const selectedAvailable = availableVersions.some(version => version.version === runtimeDraftVersion)
  if (runtimeDraftVersion !== undefined && !selectedAvailable) {
    const unavailable = document.createElement('option')
    unavailable.value = runtimeDraftVersion
    unavailable.textContent = runtimeDraftVersion + ' · 当前兼容目录中不可用'
    select.append(unavailable)
  }
  for (const version of availableVersions) {
    const option = document.createElement('option')
    option.value = version.version
    option.textContent = version.version + (version.current ? '（当前使用）' : '')
    select.append(option)
  }
  if (runtimeDraftVersion !== undefined) select.value = runtimeDraftVersion

  const pinned = runtimeDraftMode === 'pinned'
  const selectedVersion = availableVersions.find(version => version.version === runtimeDraftVersion)
  const targetVersion = pinned ? selectedVersion : availableVersions[0]
  const pinnedField = element('pinned-version-field')
  pinnedField.dataset.active = String(pinned)
  select.disabled = busy || !pinned || availableVersions.length === 0
  element('strategy-summary').textContent = pinned ? '保持在指定版本' : '自动跟随最新兼容版本'
  element('version-meta').textContent = !pinned
    ? '切换到固定版本后可选择'
    : selectedVersion === undefined
      ? '当前选择不可用'
      : selectedVersion.current ? '当前使用' : ''

  const selectionVersion = element('selection-version')
  const selectionDetail = element('selection-detail')
  if (targetVersion === undefined) {
    selectionVersion.textContent = busy
      ? '正在读取版本目录'
      : pinned && runtimeDraftVersion !== undefined
        ? '固定 · DSH ' + runtimeDraftVersion
        : '尚无兼容版本'
    selectionDetail.textContent = busy
      ? '完成检查后将显示目标版本'
      : pinned && runtimeDraftVersion !== undefined
        ? '该版本不在当前兼容目录，请选择其他版本'
        : '刷新版本目录后将显示可用版本'
  } else {
    selectionVersion.textContent = 'DSH ' + targetVersion.version
    selectionDetail.textContent = targetVersion.current ? '当前使用' : ''
  }

  const applyButton = element<HTMLButtonElement>('apply')
  applyButton.textContent = pinned && runtimeDraftVersion !== undefined
    ? '固定到 ' + runtimeDraftVersion
    : '使用自动策略'
  applyButton.disabled = busy || targetVersion === undefined || runtimePreferenceMatches(view)
  element<HTMLButtonElement>('retry').disabled = busy

  const startupRetry = element<HTMLButtonElement>('startup-retry')
  startupRetry.hidden = runtimeManagerMode || view.phase !== 'error'
  startupRetry.disabled = busy
  const recoverButton = element<HTMLButtonElement>('recover-stale-plugins')
  recoverButton.hidden = runtimeRecoveryIds.length === 0
  recoverButton.disabled = busy || runtimeRecoveryIds.length === 0
  recoverButton.textContent = runtimeRecoveryCount <= 1
    ? '禁用失效本地插件并重试'
    : '禁用 ' + String(runtimeRecoveryCount) + ' 个失效本地插件并重试'
  const bundleButton = element<HTMLButtonElement>('recover-profile-bundles')
  bundleButton.hidden = runtimeBundleRecovery === undefined
  bundleButton.disabled = busy || runtimeBundleRecovery === undefined
  bundleButton.textContent = runtimeBundleRecovery === undefined || runtimeBundleRecovery.count <= 1
    ? '修复不兼容插件配置并重试'
    : '修复 ' + String(runtimeBundleRecovery.count) + ' 个不兼容插件配置并重试'
  const presetButton = element<HTMLButtonElement>('recover-plugin-preset')
  presetButton.hidden = runtimePresetRecovery === undefined
  presetButton.disabled = busy || runtimePresetRecovery === undefined
  element<HTMLElement>('startup-actions').hidden = startupRetry.hidden && recoverButton.hidden && bundleButton.hidden && presetButton.hidden
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
  runtimeManagerMode = new URLSearchParams(window.location.search).get('view') === 'manager'
  document.body.dataset.view = runtimeManagerMode ? 'manager' : 'startup'
  element<HTMLElement>('version-settings').hidden = !runtimeManagerMode
  const showError = (error: unknown): void => {
    const errorElement = element('error')
    errorElement.textContent = errorMessage(error)
    errorElement.style.display = 'block'
  }
  const rerender = (): void => { if (runtimeLatestView !== undefined) renderRuntime(runtimeLatestView) }

  ipcRenderer.on('runtime:view', (_event, view: RuntimeView) => { renderRuntime(view) })
  element<HTMLInputElement>('version-mode-auto').addEventListener('change', event => {
    if (!(event.currentTarget as HTMLInputElement).checked) return
    runtimePreferenceTouched = true
    runtimeDraftMode = 'latest-compatible'
    rerender()
  })
  element<HTMLInputElement>('version-mode-pinned').addEventListener('change', event => {
    if (!(event.currentTarget as HTMLInputElement).checked) return
    runtimePreferenceTouched = true
    runtimeDraftMode = 'pinned'
    runtimeDraftVersion ??= runtimeLatestView?.versions.find(version => version.current)?.version
      ?? runtimeLatestView?.versions[0]?.version
    rerender()
  })
  element<HTMLSelectElement>('version').addEventListener('change', event => {
    runtimePreferenceTouched = true
    runtimeDraftMode = 'pinned'
    runtimeDraftVersion = (event.currentTarget as HTMLSelectElement).value
    rerender()
  })
  const retry = (): void => { void ipcRenderer.invoke('runtime:retry').catch(showError) }
  element<HTMLButtonElement>('retry').addEventListener('click', retry)
  element<HTMLButtonElement>('startup-retry').addEventListener('click', retry)
  element<HTMLButtonElement>('recover-stale-plugins').addEventListener('click', () => {
    if (runtimeRecoveryIds.length === 0) return
    const names = runtimeRecoveryIds.join('、')
    if (!window.confirm('将备份配置并禁用 ' + String(runtimeRecoveryCount) + ' 个失效本地插件：' + names + '。会话、设置和其他插件不会被删除。是否继续？')) return
    void ipcRenderer.invoke('runtime:recover-stale-local-plugins').catch(showError)
  })
  element<HTMLButtonElement>('recover-profile-bundles').addEventListener('click', () => {
    const recovery = runtimeBundleRecovery
    if (recovery === undefined) return
    const names = recovery.packageNames.join('、')
    const message = '将备份 Web profile 配置，并从 bundle 层列表移除不兼容项：' + names
      + '。插件依赖、插件配置、会话和设置都会保留。是否继续？'
    if (!window.confirm(message)) return
    void ipcRenderer.invoke('runtime:recover-profile-bundles').catch(showError)
  })
  element<HTMLButtonElement>('recover-plugin-preset').addEventListener('click', () => {
    const recovery = runtimePresetRecovery
    if (recovery === undefined) return
    const message = '将完整备份预设 ' + recovery.presetId + '，再用插件 ' + recovery.pluginName
      + ' 当前打包版本重置该预设。人工修改不会被删除，但会移入带 desktop-backup 标记的备份目录。是否继续？'
    if (!window.confirm(message)) return
    void ipcRenderer.invoke('runtime:recover-plugin-preset').catch(showError)
  })
  element<HTMLButtonElement>('apply').addEventListener('click', () => {
    if (runtimeDraftMode === 'pinned' && runtimeDraftVersion === undefined) return
    const preference: RuntimePreference = runtimeDraftMode === 'pinned'
      ? { mode: 'pinned', version: runtimeDraftVersion as string }
      : { mode: 'latest-compatible' }
    void ipcRenderer.invoke('runtime:set-preference', preference).then(() => {
      runtimePreferenceTouched = false
    }).catch(showError)
  })
  void (ipcRenderer.invoke('runtime:get-view') as Promise<RuntimeView>).then(renderRuntime).catch(showError)
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
  let currentEntries: PluginEntry[] = []
  let updateVersions = new Map<string, string>()
  let listGeneration = 0

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
      const latestVersion = updateVersions.get(entry.name)
      meta.textContent = (entry.version === undefined ? '未解析版本' : '版本 ' + entry.version)
        + (latestVersion === undefined ? '' : ' · 可更新至 ' + latestVersion)
        + (entry.spec === undefined ? '' : ' · ' + entry.spec)
      main.append(name, meta)
      const actions = document.createElement('div')
      actions.className = 'plugin-actions'
      if (latestVersion !== undefined) {
        const updateButton = document.createElement('button')
        updateButton.type = 'button'
        updateButton.textContent = '更新至 ' + latestVersion
        updateButton.disabled = busy
        updateButton.addEventListener('click', () => { void runOperation({ action: 'update', packageName: entry.name }, '更新 ' + entry.name) })
        actions.append(updateButton)
      }
      const removeButton = document.createElement('button')
      removeButton.type = 'button'
      removeButton.className = 'danger'
      removeButton.textContent = '卸载'
      removeButton.addEventListener('click', () => {
        if (window.confirm('确认卸载 ' + entry.name + '？')) void runOperation({ action: 'remove', packageName: entry.name }, '卸载 ' + entry.name)
      })
      removeButton.disabled = busy
      actions.append(removeButton)
      row.append(main, actions)
      listElement.append(row)
    }
  }
  const loadEntries = async (): Promise<void> => {
    const generation = ++listGeneration
    const value = await ipcRenderer.invoke('plugin-manager:list') as PluginList
    currentEntries = value.entries
    updateVersions = new Map()
    renderEntries(currentEntries)
    void (ipcRenderer.invoke('plugin-manager:updates') as Promise<PluginUpdateList>).then(updates => {
      if (generation !== listGeneration) return
      updateVersions = new Map(updates.entries
        .filter(update => currentEntries.some(entry => entry.name === update.name && entry.version === update.currentVersion))
        .map(update => [update.name, update.latestVersion]))
      renderEntries(currentEntries)
    }).catch(() => undefined)
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

function initializeMcpManagerPage(): void {
  const search = element<HTMLInputElement>('mcp-search')
  const refreshButton = element<HTMLButtonElement>('mcp-refresh')
  const status = element('mcp-status')
  const progress = element<HTMLProgressElement>('mcp-progress')
  const list = element('mcp-list')
  const empty = element('mcp-empty')
  const filters = {
    all: element<HTMLButtonElement>('mcp-filter-all'),
    enabled: element<HTMLButtonElement>('mcp-filter-enabled'),
    disabled: element<HTMLButtonElement>('mcp-filter-disabled'),
  }
  let snapshot: McpList | undefined
  let filter: 'all' | 'enabled' | 'disabled' = 'all'
  let busy = false
  const expanded = new Set<string>()

  const setStatus = (message: string, kind: 'normal' | 'success' | 'error' = 'normal'): void => {
    status.textContent = message
    status.dataset.kind = kind
  }

  const setBusy = (value: boolean): void => {
    busy = value
    search.disabled = value
    refreshButton.disabled = value
    progress.hidden = !value
    for (const button of Object.values(filters)) button.disabled = value
    for (const control of list.querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) control.disabled = value || control.dataset.mutable === 'false'
  }

  const transportLabel = (value: McpEndpointView['transport']): string => {
    if (value === 'stdio') return 'stdio'
    if (value === 'streamable-http') return 'Streamable HTTP'
    return '未知传输'
  }

  const appendDetail = (grid: HTMLDListElement, label: string, value: string | undefined): void => {
    if (value === undefined || value.length === 0) return
    const term = document.createElement('dt')
    term.textContent = label
    const detail = document.createElement('dd')
    detail.textContent = value
    grid.append(term, detail)
  }

  const endpointDetails = (endpoint: McpEndpointView): HTMLElement => {
    const section = document.createElement('section')
    section.className = 'endpoint'
    const heading = document.createElement('h3')
    heading.textContent = endpoint.name
    const grid = document.createElement('dl')
    grid.className = 'detail-grid'
    appendDetail(grid, '传输', transportLabel(endpoint.transport))
    appendDetail(grid, '命令', endpoint.command)
    appendDetail(grid, '参数', endpoint.args?.join(' '))
    appendDetail(grid, '工作目录', endpoint.cwd)
    appendDetail(grid, '环境变量', endpoint.environmentKeys?.join(', '))
    appendDetail(grid, '地址', endpoint.url)
    appendDetail(grid, 'Header', endpoint.headerKeys?.join(', '))
    section.append(heading, grid)
    return section
  }

  const matchesSearch = (entry: McpEntryView, query: string): boolean => {
    if (query.length === 0) return true
    const endpointText = entry.endpoints.flatMap(endpoint => [
      endpoint.name,
      endpoint.command ?? '',
      endpoint.url ?? '',
      ...(endpoint.args ?? []),
    ]).join(' ')
    return [entry.name, entry.provider, entry.source, entry.entryId ?? '', endpointText].join(' ').toLocaleLowerCase('zh-CN').includes(query)
  }

  const visibleEntries = (): McpEntryView[] => {
    const query = search.value.trim().toLocaleLowerCase('zh-CN')
    return (snapshot?.entries ?? []).filter(entry => {
      const matchesState = filter === 'all' || entry.dynamic !== true && (filter === 'enabled' ? entry.enabled : !entry.enabled)
      return matchesState && matchesSearch(entry, query)
    })
  }

  const setFilter = (value: typeof filter): void => {
    filter = value
    for (const [name, button] of Object.entries(filters)) button.setAttribute('aria-pressed', String(name === value))
    renderEntries()
  }

  const renderDetails = (entry: McpEntryView): HTMLDivElement => {
    const details = document.createElement('div')
    details.className = 'mcp-details'
    details.hidden = !expanded.has(entry.key)
    const inner = document.createElement('div')
    inner.className = 'details-inner'
    const metadata = document.createElement('dl')
    metadata.className = 'detail-grid'
    appendDetail(metadata, entry.management === 'codex-import' ? 'DSH 导入 ID' : 'Cordis ID', entry.entryId)
    appendDetail(metadata, '来源', entry.source)
    if (entry.management === 'codex-import') appendDetail(metadata, 'Codex 状态', entry.sourceEnabled === false ? '已禁用' : '已启用')
    if (entry.provider === 'MCP Lens') {
      appendDetail(metadata, '允许规则', entry.allowToolCount === undefined ? undefined : String(entry.allowToolCount))
      appendDetail(metadata, '拒绝规则', entry.denyToolCount === undefined ? undefined : String(entry.denyToolCount))
    }
    inner.append(metadata)
    if (entry.endpoints.length === 0) {
      const message = document.createElement('div')
      message.className = 'mcp-meta'
      message.textContent = '未配置 MCP Server'
      inner.append(message)
    } else {
      for (const endpoint of entry.endpoints) inner.append(endpointDetails(endpoint))
    }
    details.append(inner)
    return details
  }

  const runToggle = async (entry: McpEntryView, enabled: boolean): Promise<void> => {
    const current = snapshot
    if (busy || current === undefined || !entry.mutable) return
    setBusy(true)
    const action = entry.management === 'codex-import'
      ? enabled ? '正在接入 DSH ' : '正在从 DSH 禁用 '
      : enabled ? '正在启用 ' : '正在禁用 '
    setStatus(action + entry.name + '，Runtime 将自动重启...')
    try {
      snapshot = await ipcRenderer.invoke('mcp-manager:set-enabled', {
        key: entry.key,
        enabled,
        expectedRevision: current.revision,
      }) as McpList
      renderEntries()
      const result = entry.management === 'codex-import'
        ? enabled ? ' 已接入 DSH' : ' 已从 DSH 禁用'
        : enabled ? ' 已启用' : ' 已禁用'
      setStatus(entry.name + result, 'success')
    } catch (error: unknown) {
      setStatus(errorMessage(error), 'error')
      renderEntries()
    } finally {
      setBusy(false)
    }
  }

  function renderEntries(): void {
    const allEntries = snapshot?.entries ?? []
    const enabledCount = allEntries.filter(entry => entry.dynamic !== true && entry.enabled).length
    const dynamicCount = allEntries.filter(entry => entry.dynamic === true).length
    element('mcp-count').textContent = String(allEntries.length) + ' 个 MCP · ' + String(enabledCount) + ' 个在 DSH 中启用'
      + (dynamicCount === 0 ? '' : ' · ' + String(dynamicCount) + ' 个动态')
    const visible = visibleEntries()
    list.replaceChildren()
    empty.hidden = visible.length !== 0
    empty.textContent = allEntries.length === 0 ? '没有识别到本地 MCP 配置' : '没有匹配当前筛选的 MCP'
    const knownKeys = new Set(allEntries.map(entry => entry.key))
    for (const key of expanded) if (!knownKeys.has(key)) expanded.delete(key)

    for (const entry of visible) {
      const row = document.createElement('article')
      row.className = 'mcp-row'
      row.setAttribute('role', 'listitem')
      const summary = document.createElement('div')
      summary.className = 'mcp-summary'
      const main = document.createElement('div')
      main.className = 'mcp-main'
      const titleLine = document.createElement('div')
      titleLine.className = 'mcp-title-line'
      const name = document.createElement('h2')
      name.className = 'mcp-name'
      name.textContent = entry.name
      const provider = document.createElement('span')
      provider.className = 'badge'
      provider.textContent = entry.provider
      const state = document.createElement('span')
      state.className = 'badge ' + (entry.dynamic === true ? 'dynamic' : entry.enabled ? 'enabled' : 'disabled')
      state.textContent = entry.dynamic === true
        ? '动态'
        : entry.management === 'codex-import'
          ? entry.enabled ? '已接入' : '未接入'
          : entry.enabled ? '已启用' : '已禁用'
      titleLine.append(name, provider, state)
      const meta = document.createElement('div')
      meta.className = 'mcp-meta'
      const transportNames = [...new Set(entry.endpoints.map(endpoint => transportLabel(endpoint.transport)))]
      meta.textContent = entry.source + ' · ' + String(entry.endpoints.length) + ' 个 Server'
        + (transportNames.length === 0 ? '' : ' · ' + transportNames.join(' / '))
      main.append(titleLine, meta)

      const actions = document.createElement('div')
      actions.className = 'mcp-actions'
      const detailsButton = document.createElement('button')
      detailsButton.type = 'button'
      detailsButton.className = 'details-button'
      detailsButton.textContent = expanded.has(entry.key) ? '收起' : '详情'
      detailsButton.setAttribute('aria-expanded', String(expanded.has(entry.key)))
      detailsButton.disabled = busy
      detailsButton.addEventListener('click', () => {
        if (expanded.has(entry.key)) expanded.delete(entry.key)
        else expanded.add(entry.key)
        renderEntries()
      })
      const switchLabel = document.createElement('label')
      switchLabel.className = 'switch'
      const toggle = document.createElement('input')
      toggle.type = 'checkbox'
      toggle.checked = entry.enabled
      toggle.indeterminate = entry.dynamic === true
      toggle.disabled = busy || !entry.mutable
      toggle.dataset.mutable = String(entry.mutable)
      const toggleAction = entry.management === 'codex-import'
        ? entry.enabled ? '从 DSH 禁用 ' : '接入 DSH '
        : entry.dynamic === true || !entry.enabled ? '启用 ' : '禁用 '
      toggle.setAttribute('aria-label', toggleAction + entry.name)
      toggle.title = entry.mutable
        ? entry.management === 'codex-import'
          ? entry.enabled ? '从 DSH 禁用' : '接入 DSH'
          : entry.dynamic === true ? '设置为明确启用或禁用' : entry.enabled ? '禁用' : '启用'
        : entry.entryId === undefined ? '缺少稳定的 Cordis entry id' : '当前配置无法安全切换'
      const track = document.createElement('span')
      track.className = 'switch-track'
      switchLabel.append(toggle, track)
      toggle.addEventListener('change', () => { void runToggle(entry, toggle.checked) })
      actions.append(detailsButton, switchLabel)
      summary.append(main, actions)
      row.append(summary, renderDetails(entry))
      list.append(row)
    }
  }

  const load = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setStatus('正在读取 MCP 配置...')
    try {
      snapshot = await ipcRenderer.invoke('mcp-manager:list') as McpList
      renderEntries()
      setStatus('MCP 列表已刷新', 'success')
    } catch (error: unknown) {
      setStatus(errorMessage(error), 'error')
      snapshot = undefined
      renderEntries()
    } finally {
      setBusy(false)
    }
  }

  filters.all.addEventListener('click', () => { setFilter('all') })
  filters.enabled.addEventListener('click', () => { setFilter('enabled') })
  filters.disabled.addEventListener('click', () => { setFilter('disabled') })
  search.addEventListener('input', renderEntries)
  refreshButton.addEventListener('click', () => { void load() })
  void load()
}

interface PersonalizationDocument {
  path: string
  content: string
  exists: boolean
  revision: string
  maxBytes: number
}

const PERSONALIZATION_TEMPLATE = [
  '# 全局 Agent 个性化',
  '',
  '## 沟通方式',
  '',
  '- 默认使用中文沟通。',
  '- 先给出明确结论，再提供必要依据。',
  '- 对假设、风险和未验证事项明确说明。',
  '',
  '## 工程方式',
  '',
  '- 修改前先阅读现有实现、测试和项目约定。',
  '- 优先使用项目已有模式，避免无关重构。',
  '- 根据改动风险补充测试，并报告实际验证结果。',
  '',
  '## 操作边界',
  '',
  '- 遵从当前 Agent 预设提供的角色、工具、能力与工作流程。',
  '- 不假定当前预设拥有未提供的工具。',
  '- 未明确要求时，不创建提交、Tag 或发布版本。',
  '- 不修改与当前任务无关的用户变更。',
  '',
].join('\n')

function initializePersonalizationPage(): void {
  const editor = element<HTMLTextAreaElement>('personalization-content')
  const templateButton = element<HTMLButtonElement>('personalization-template')
  const reloadButton = element<HTMLButtonElement>('personalization-reload')
  const saveButton = element<HTMLButtonElement>('personalization-save')
  const state = element('personalization-state')
  const path = element('personalization-path')
  const count = element('personalization-count')
  const status = element('personalization-status')
  const progress = element<HTMLProgressElement>('personalization-progress')
  const encoder = new TextEncoder()
  let snapshot: PersonalizationDocument | undefined
  let baseline = ''
  let busy = false
  let reportedDirty = false

  const byteLength = (): number => encoder.encode(editor.value).byteLength
  const isDirty = (): boolean => editor.value !== baseline
  const reportDirty = (value: boolean): void => {
    if (reportedDirty === value) return
    reportedDirty = value
    ipcRenderer.send('personalization:dirty', value)
  }
  const setStatus = (message: string, kind: 'normal' | 'success' | 'error' = 'normal'): void => {
    status.textContent = message
    status.dataset.kind = kind
  }
  const updateControls = (): void => {
    const bytes = byteLength()
    const maximum = snapshot?.maxBytes ?? 65_536
    const dirty = isDirty()
    const over = bytes > maximum
    count.textContent = bytes.toLocaleString('zh-CN') + ' / ' + maximum.toLocaleString('zh-CN') + ' B'
    count.dataset.over = String(over)
    state.textContent = dirty ? '有未保存更改' : snapshot?.exists === true ? '已保存' : '未创建'
    state.dataset.kind = dirty ? 'dirty' : snapshot === undefined ? 'normal' : 'saved'
    editor.disabled = busy
    templateButton.disabled = busy
    reloadButton.disabled = busy
    saveButton.disabled = busy || snapshot === undefined || !dirty || over
    progress.hidden = !busy
    reportDirty(dirty)
    if (over) setStatus('内容超过 ' + maximum.toLocaleString('zh-CN') + ' B 限制', 'error')
  }
  const updateAfterEdit = (): void => {
    updateControls()
    if (byteLength() <= (snapshot?.maxBytes ?? 65_536)) setStatus('更改尚未保存')
  }
  const setBusy = (value: boolean): void => { busy = value; updateControls() }

  const load = async (confirmDiscard: boolean): Promise<void> => {
    if (busy) return
    if (confirmDiscard && isDirty() && !window.confirm('放弃尚未保存的更改并重新加载？')) return
    setBusy(true)
    setStatus('正在读取全局个性化设置...')
    try {
      snapshot = await ipcRenderer.invoke('personalization:read') as PersonalizationDocument
      editor.value = snapshot.content
      baseline = editor.value
      path.textContent = snapshot.path
      setStatus(snapshot.exists ? '已加载全局个性化设置' : '尚未创建全局个性化设置', 'success')
    } catch (error: unknown) {
      setStatus(errorMessage(error), 'error')
    } finally {
      setBusy(false)
      editor.focus()
    }
  }

  const save = async (): Promise<void> => {
    const current = snapshot
    if (busy || current === undefined || !isDirty() || byteLength() > current.maxBytes) return
    setBusy(true)
    setStatus(editor.value.trim().length === 0 ? '正在移除全局个性化设置...' : '正在保存全局个性化设置...')
    try {
      snapshot = await ipcRenderer.invoke('personalization:save', {
        content: editor.value,
        expectedRevision: current.revision,
      }) as PersonalizationDocument
      editor.value = snapshot.content
      baseline = editor.value
      path.textContent = snapshot.path
      setStatus(snapshot.exists ? '已保存；后续新会话将使用该设置' : '已移除全局个性化设置', 'success')
    } catch (error: unknown) {
      setStatus(errorMessage(error), 'error')
    } finally {
      setBusy(false)
    }
  }

  editor.addEventListener('input', updateAfterEdit)
  editor.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase('en-US') === 's') {
      event.preventDefault()
      void save()
      return
    }
    if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault()
      editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end')
      updateAfterEdit()
    }
  })
  templateButton.addEventListener('click', () => {
    if (editor.value.trim().length > 0 && !window.confirm('使用推荐模板替换编辑器中的当前内容？')) return
    editor.value = PERSONALIZATION_TEMPLATE
    updateAfterEdit()
    editor.focus()
  })
  reloadButton.addEventListener('click', () => { void load(true) })
  saveButton.addEventListener('click', () => { void save() })
  void load(false)
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
  else if (document.querySelector('#personalization-page') !== null) initializePersonalizationPage()
  else if (document.querySelector('#mcp-manager-page') !== null) initializeMcpManagerPage()
  else if (document.querySelector('#plugin-manager-page') !== null) initializePluginManagerPage()
  else if (document.querySelector('#version') !== null) initializeRuntimePage()
  else if (document.querySelector('#repair-session-id') !== null) initializeRepairPage()
})
