import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  Tray,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { MINIMUM_DSH_VERSION, type RuntimePreference } from './catalog.ts'
import { DesktopPetController as PetEventController, type PetRendererState as PetProtocolState, type PetWebSocket } from './desktop-pet.ts'
import { openPluginTerminal } from './cli-shell.ts'
import { McpManager, type McpList } from './mcp-manager.ts'
import { mutateMcpWithRuntime } from './mcp-restart.ts'
import { PersonalizationManager } from './personalization-manager.ts'
import { parsePetWindowShape, PetWindowController, type PetRendererState as PetWindowState } from './pet-window.ts'
import type { PetSize } from './pet-size.ts'
import { PluginManager } from './plugin-manager.ts'
import { PluginRestartCoordinator } from './plugin-restart.ts'
import { RuntimeController, type RuntimeView } from './runtime-controller.ts'
import { SessionRepairClient } from './session-repair.ts'
import { SettingsDocumentClient } from './settings-document.ts'
import { RuntimeStore } from './runtime-store.ts'
import { ShellUpdater, type ShellUpdateProgress } from './shell-updater.ts'
import { createClientBundleAdapterScript, createSkinDisposerScript, createSkinMarketInjectorScript } from './skin-market-injector.ts'
import { ShellSkinStore } from './shell-skin-store.ts'
import { allowDshWebPermission, shouldOpenInSystemBrowser } from './window-security.ts'

protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-skin', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const setupPage = join(app.getAppPath(), 'assets', 'runtime.html')
const repairPage = join(app.getAppPath(), 'assets', 'session-repair.html')
const pluginManagerPage = join(app.getAppPath(), 'assets', 'plugin-manager.html')
const mcpManagerPage = join(app.getAppPath(), 'assets', 'mcp-manager.html')
const personalizationPage = join(app.getAppPath(), 'assets', 'personalization.html')
const shellUpdatePage = join(app.getAppPath(), 'assets', 'shell-update.html')
const petPage = join(app.getAppPath(), 'assets', 'pet.html')
const allowedLocalPages = new Set([setupPage, repairPage, pluginManagerPage, mcpManagerPage, personalizationPage, shellUpdatePage, petPage])
const preload = join(moduleDirectory, 'preload.cjs')
const petPreload = join(moduleDirectory, 'pet-preload.cjs')
const shutdownHook = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'lib', 'shutdown-hook.js')
  : join(moduleDirectory, 'shutdown-hook.js')

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let managerWindow: BrowserWindow | undefined
let repairWindow: BrowserWindow | undefined
let pluginWindow: BrowserWindow | undefined
let mcpWindow: BrowserWindow | undefined
let personalizationWindow: BrowserWindow | undefined
let updateWindow: BrowserWindow | undefined
let latestUpdateProgress: ShellUpdateProgress | undefined
let controller: RuntimeController | undefined
let pluginManager: PluginManager | undefined
let mcpManager: McpManager | undefined
let personalizationManager: PersonalizationManager | undefined
let personalizationDirty = false
let personalizationClosePrompt = false
let personalizationQuitPrompt = false
let mcpMutationActive = false
const pluginRestartCoordinator = new PluginRestartCoordinator()
let updater: ShellUpdater | undefined
let petWindow: PetWindowController | undefined
let petEvents: PetEventController | undefined
let disposePetEvents: (() => void) | undefined
let activePetSession: string | undefined
let latestView: RuntimeView | undefined
let cliDirectory: string | undefined
let trustedOrigin: string | undefined
let mainUiLoaded = false
let shellSkinStore: ShellSkinStore | undefined
let quitting = false

function runtimeRoot(): string {
  if (process.env.DSH_DESKTOP_RUNTIME_ROOT !== undefined) return process.env.DSH_DESKTOP_RUNTIME_ROOT
  const local = process.env.LOCALAPPDATA
  if (local === undefined || local.length === 0) throw new Error('LOCALAPPDATA is unavailable')
  return join(local, 'DeepSeek Harness', 'runtime-manager')
}

let skinReactRuntimeSource: string | undefined
function getSkinReactRuntimeSource(): string {
  skinReactRuntimeSource ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'skin-react-runtime.global.iife.js'), 'utf8')
  return skinReactRuntimeSource
}

type ClientBundleAdapterResult = {
  ok: boolean
  error?: { stage?: string; name?: string; message?: string; stack?: string }
  diagnostics?: unknown
}

async function executeClientBundleAdapter(contents: WebContents, bundle: string, skinId: string, variantId?: string): Promise<void> {
  await contents.executeJavaScript(`if (!window.__dshDesktopReactRuntime) { ${getSkinReactRuntimeSource()} }`)
  const result: unknown = await contents.executeJavaScript(createClientBundleAdapterScript(bundle, skinId, variantId))
  if (result === null || typeof result !== 'object' || Array.isArray(result) || typeof (result as ClientBundleAdapterResult).ok !== 'boolean') {
    throw new Error('皮肤适配器执行失败：皮肤 ' + skinId + ' 返回了无效结果')
  }
  const adapterResult = result as ClientBundleAdapterResult
  if (adapterResult.ok) return
  const detail = adapterResult.error ?? {}
  const parts = ['皮肤适配器执行失败：皮肤 ' + skinId]
  if (detail.stage !== undefined) parts.push('阶段 ' + detail.stage)
  if (detail.name !== undefined) parts.push('名称 ' + detail.name)
  if (detail.message !== undefined) parts.push('消息 ' + detail.message)
  const error = new Error(parts.join('，'))
  if (detail.stack !== undefined) error.stack = error.message + '\n' + detail.stack
  throw error
}

function injectSkinMarket(window: BrowserWindow): void {
  if (window !== mainWindow || trustedOrigin === undefined || window.isDestroyed()) return
  try {
    if (new URL(window.webContents.getURL()).origin !== trustedOrigin) return
  } catch {
    return
  }
  void (async () => {
    await window.webContents.executeJavaScript(createSkinMarketInjectorScript())
    const active = await shellSkinStore?.activeClientBundle()
    if (active !== undefined && active !== null) await executeClientBundleAdapter(window.webContents, active.bundle, active.id)
  })().catch(logFatalError)
}

function petStatus(message: string | undefined): string | undefined {
  if (message === undefined) return undefined
  if (message === 'Approval response failed') return '审批响应发送失败'
  if (message === 'Invalid approval response') return '审批响应格式无效'
  if (message === 'Approval expired') return '审批已失效'
  if (message === 'DSH event stream unavailable') return 'DSH 事件流暂不可用'
  if (message === 'DSH connection lost; retrying') return '正在重新连接 DSH'
  return '宠物状态暂不可用'
}

function toPetWindowState(state: PetProtocolState): PetWindowState {
  const status = petStatus(state.message)
  const approval = state.approval
  if (approval !== undefined) {
    return {
      mode: 'approval',
      ...(status === undefined ? {} : { status }),
      approval: {
        id: approval.approvalId,
        toolName: approval.toolName,
        sessionLabel: approval.sessionLabel,
        ...(approval.reason === undefined ? {} : { reason: approval.reason }),
        pendingCount: state.queuedApprovals + 1,
        responding: approval.status === 'responding',
      },
    }
  }
  if (state.reply !== undefined) {
    return {
      mode: state.reply.streaming ? 'speaking' : 'success',
      reply: state.reply.text + (state.reply.truncated ? '…' : ''),
      sessionLabel: '当前会话',
      ...(status === undefined ? {} : { status }),
    }
  }
  if (state.thinking === true) return { mode: 'thinking', status: '正在思考', sessionLabel: '当前会话' }
  if (state.connection !== 'connected') {
    return { mode: 'unavailable', status: status ?? (state.connection === 'reconnecting' ? '正在重新连接 DSH' : 'DSH 暂不可用') }
  }
  if (status !== undefined) return { mode: 'error', status }
  return { mode: 'idle' }
}

async function setPetEnabled(enabled: boolean): Promise<void> {
  await petWindow?.setEnabled(enabled)
  installMenu()
  installTrayMenu()
}

async function setPetSize(size: PetSize): Promise<void> {
  const pet = petWindow
  if (pet === undefined) return
  try { await pet.setSize(size) }
  catch (error: unknown) {
    dialog.showErrorBox('无法调整桌宠大小', error instanceof Error ? error.message : String(error))
  } finally {
    installMenu()
  }
}

function showPetContextMenu(event: IpcMainEvent): void {
  const pet = petSender(event)
  const owner = BrowserWindow.fromWebContents(event.sender)
  if (pet === undefined || owner === null || owner.isDestroyed()) return
  Menu.buildFromTemplate([
    { label: '打开 DeepSeek Harness', click: showMainWindow },
    { type: 'separator' },
    {
      label: '桌宠大小',
      submenu: [
        { label: '小', type: 'radio', checked: pet.size === 'small', click: () => { void setPetSize('small') } },
        { label: '标准', type: 'radio', checked: pet.size === 'standard', click: () => { void setPetSize('standard') } },
        { label: '大', type: 'radio', checked: pet.size === 'large', click: () => { void setPetSize('large') } },
      ],
    },
    { type: 'separator' },
    { label: '隐藏桌宠', click: () => { void setPetEnabled(false) } },
  ]).popup({ window: owner })
}

async function stopPet(): Promise<void> {
  activePetSession = undefined
  petEvents?.stop()
  disposePetEvents?.()
  disposePetEvents = undefined
  petEvents = undefined
  await petWindow?.dispose()
  petWindow = undefined
}

function installTrayMenu(): void {
  if (tray === undefined || tray.isDestroyed()) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DeepSeek Harness', click: showMainWindow },
    {
      label: '启用桌面宠物',
      type: 'checkbox',
      checked: petWindow?.enabled ?? true,
      click: item => { void setPetEnabled(item.checked) },
    },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } },
  ]))
}

function clearMainMenu(): void {
  Menu.setApplicationMenu(null)
  mainWindow?.setMenuBarVisibility(false)
}

function syncMainMenuVisibility(): void {
  const window = mainWindow
  if (window === undefined || window.isDestroyed()) return
  let trustedPageLoaded = false
  if (mainUiLoaded && latestView?.phase === 'ready' && trustedOrigin !== undefined) {
    try { trustedPageLoaded = new URL(window.webContents.getURL()).origin === trustedOrigin }
    catch { trustedPageLoaded = false }
  }
  window.setMenuBarVisibility(trustedPageLoaded)
}

function createWindow(options: { utility?: 'manager' | 'repair' | 'plugin' | 'mcp' | 'personalization' | 'update' } = {}): BrowserWindow {
  const utility = options.utility
  const manager = utility === 'manager'
  const repair = utility === 'repair'
  const plugin = utility === 'plugin'
  const mcp = utility === 'mcp'
  const personalization = utility === 'personalization'
  const update = utility === 'update'
  const window = new BrowserWindow({
    ...(update && mainWindow !== undefined ? { parent: mainWindow, modal: true } : {}),
    width: manager ? 700 : repair ? 760 : plugin ? 740 : mcp ? 860 : personalization ? 800 : update ? 480 : 1240,
    height: manager ? 720 : repair ? 780 : plugin ? 700 : mcp ? 760 : personalization ? 720 : update ? 250 : 820,
    minWidth: manager || repair ? 480 : plugin ? 420 : mcp ? 600 : personalization ? 520 : update ? 420 : 820,
    minHeight: manager ? 560 : plugin ? 520 : mcp || personalization ? 560 : update ? 220 : 600,
    ...(update ? { closable: false, minimizable: false, maximizable: false, resizable: false } : {}),
    show: false,
    autoHideMenuBar: utility !== undefined,
    backgroundColor: '#f5f6f8',
    icon: nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'icon.png')),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    callback(allowDshWebPermission({
      permission,
      requestingUrl: details.requestingUrl,
      currentUrl: contents.getURL(),
      trustedOrigin,
      mainWindow: contents === mainWindow?.webContents,
    }))
  })
  window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
    return allowDshWebPermission({
      permission,
      requestingUrl: requestingOrigin,
      currentUrl: contents?.getURL() ?? '',
      trustedOrigin,
      mainWindow: contents === mainWindow?.webContents,
    })
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (shouldOpenInSystemBrowser(url, trustedOrigin)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    const origin = parsed.origin
    const localNavigation = parsed.protocol === 'file:' && allowedLocalPages.has(fileURLToPath(parsed))
    const allowed = localNavigation || (trustedOrigin !== undefined && origin === trustedOrigin)
    if (!allowed) {
      event.preventDefault()
      if (shouldOpenInSystemBrowser(url, trustedOrigin)) void shell.openExternal(url)
    }
  })
  if (utility === undefined) window.setMenuBarVisibility(false)
  window.once('ready-to-show', () => { window.show() })
  window.webContents.on('did-finish-load', () => {
    sendView(window)
    if (window === mainWindow) { syncMainMenuVisibility(); injectSkinMarket(window) }
  })
  return window
}

function showMainWindow(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'icon.png')))
  tray.setToolTip('DeepSeek Harness')
  installTrayMenu()
  tray.on('click', showMainWindow)
}

async function showSetup(window: BrowserWindow): Promise<void> {
  if (window === mainWindow) {
    mainUiLoaded = false
    clearMainMenu()
  }
  const current = window.webContents.getURL()
  if (!current.startsWith('file:')) await window.loadFile(setupPage)
  sendView(window)
}

function sendView(window: BrowserWindow): void {
  if (latestView !== undefined && !window.isDestroyed()) window.webContents.send('runtime:view', latestView)
}

async function retryRuntimeFromMenu(): Promise<void> {
  const runtimeController = controller
  if (runtimeController === undefined) return
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await runtimeController.retry()
}

function showUpdateProgress(progress: ShellUpdateProgress): void {
  latestUpdateProgress = progress
  if (progress.state === 'checking' || progress.state === 'idle' || progress.state === 'error') {
    mainWindow?.setProgressBar(-1)
    if (updateWindow !== undefined && !updateWindow.isDestroyed()) updateWindow.destroy()
    updateWindow = undefined
    return
  }
  if (progress.state === 'downloading') {
    mainWindow?.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)), { mode: 'normal' })
  } else {
    mainWindow?.setProgressBar(2, { mode: 'indeterminate' })
  }
  if (updateWindow === undefined || updateWindow.isDestroyed()) {
    updateWindow = createWindow({ utility: 'update' })
    updateWindow.on('closed', () => { updateWindow = undefined })
    void updateWindow.loadFile(shellUpdatePage).then(() => {
      if (latestUpdateProgress !== undefined && updateWindow !== undefined && !updateWindow.isDestroyed()) {
        updateWindow.webContents.send('shell-update:progress', latestUpdateProgress)
      }
    })
    return
  }
  updateWindow.webContents.send('shell-update:progress', progress)
}

async function openTextDocument(path: string): Promise<void> {
  const failure = await shell.openPath(path)
  if (failure.length === 0) return
  await new Promise<void>((resolve, reject) => {
    const child = spawn('notepad.exe', [path], { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => { child.unref(); resolve() })
  }).catch((error: unknown) => {
    throw new Error(failure + '\n' + (error instanceof Error ? error.message : String(error)))
  })
}

async function openSettings(): Promise<void> {
  if (trustedOrigin === undefined || latestView?.phase !== 'ready') {
    await dialog.showMessageBox({ type: 'warning', title: '设置', message: 'DSH Runtime 尚未就绪。' })
    return
  }
  try {
    await new SettingsDocumentClient(new URL(trustedOrigin)).open()
  } catch (error: unknown) {
    await dialog.showMessageBox({
      type: 'error',
      title: '无法打开设置',
      message: '无法打开 DSH 配置文件。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}

function broadcast(view: RuntimeView): void {
  latestView = view
  if (view.phase !== 'ready') {
    mainUiLoaded = false
    mainWindow?.setMenuBarVisibility(false)
    activePetSession = undefined
    petEvents?.setActiveSession(undefined)
    petEvents?.stop()
  }
  installMenu()
  if (mainWindow !== undefined && view.phase === 'error') void showSetup(mainWindow)
  if (mainWindow !== undefined) sendView(mainWindow)
  if (managerWindow !== undefined) sendView(managerWindow)
}

function parsePreference(value: unknown): RuntimePreference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime preference must be an object')
  const input = value as Record<string, unknown>
  if (input.mode === 'latest-compatible') return { mode: 'latest-compatible' }
  if (input.mode === 'pinned' && typeof input.version === 'string' && input.version.length > 0) {
    return { mode: 'pinned', version: input.version }
  }
  throw new Error('runtime preference is invalid')
}

async function openVersionManager(): Promise<void> {
  if (managerWindow !== undefined && !managerWindow.isDestroyed()) {
    managerWindow.focus()
    return
  }
  managerWindow = createWindow({ utility: 'manager' })
  managerWindow.on('closed', () => { managerWindow = undefined })
  await managerWindow.loadFile(setupPage, { query: { view: 'manager' } })
}

async function openSessionRepair(): Promise<void> {
  if (repairWindow !== undefined && !repairWindow.isDestroyed()) {
    repairWindow.focus()
    return
  }
  repairWindow = createWindow({ utility: 'repair' })
  repairWindow.on('closed', () => { repairWindow = undefined })
  await repairWindow.loadFile(repairPage)
}

async function openPluginManager(): Promise<void> {
  if (controller?.installedRuntime() === undefined) {
    await dialog.showMessageBox({ type: 'warning', title: '插件管理', message: 'DSH Runtime 尚未安装。' })
    return
  }
  if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
    pluginWindow.focus()
    return
  }
  pluginWindow = createWindow({ utility: 'plugin' })
  pluginWindow.on('closed', () => { pluginWindow = undefined })
  await pluginWindow.loadFile(pluginManagerPage)
}

async function openMcpManager(): Promise<void> {
  if (controller?.installedRuntime() === undefined) {
    await dialog.showMessageBox({ type: 'warning', title: 'MCP 管理', message: 'DSH Runtime 尚未安装。' })
    return
  }
  if (mcpWindow !== undefined && !mcpWindow.isDestroyed()) {
    mcpWindow.focus()
    return
  }
  mcpWindow = createWindow({ utility: 'mcp' })
  mcpWindow.on('closed', () => { mcpWindow = undefined })
  await mcpWindow.loadFile(mcpManagerPage)
}

async function openPersonalization(): Promise<void> {
  if (personalizationWindow !== undefined && !personalizationWindow.isDestroyed()) {
    personalizationWindow.focus()
    return
  }
  personalizationDirty = false
  personalizationClosePrompt = false
  personalizationQuitPrompt = false
  const window = createWindow({ utility: 'personalization' })
  personalizationWindow = window
  window.on('close', event => {
    if (quitting || !personalizationDirty) return
    event.preventDefault()
    if (personalizationClosePrompt) return
    personalizationClosePrompt = true
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: '个性化设置',
      message: '个性化设置有尚未保存的更改。',
      detail: '关闭窗口将放弃这些更改。',
      buttons: ['继续编辑', '放弃更改'],
      defaultId: 0,
      cancelId: 0,
    }).then(result => {
      personalizationClosePrompt = false
      if (result.response !== 1 || window.isDestroyed()) return
      personalizationDirty = false
      window.close()
    })
  })
  window.on('closed', () => {
    personalizationWindow = undefined
    personalizationDirty = false
    personalizationClosePrompt = false
    personalizationQuitPrompt = false
  })
  await window.loadFile(personalizationPage)
}

async function showAbout(): Promise<void> {
  const runtimeVersion = latestView?.currentVersion === undefined
    ? '尚未启动'
    : latestView.currentVersion
  await dialog.showMessageBox({
    type: 'info',
    title: '关于 DeepSeek Harness',
    message: 'DeepSeek Harness',
    detail: 'Windows 桌面壳与 DSH Runtime 管理器\n\nShell ' + app.getVersion() + '\nDSH ' + runtimeVersion + '\n\nCopyright © 2026 ToxicantX\nMIT License',
    icon: nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'icon.png')),
    buttons: ['确定'],
    defaultId: 0,
  })
}

function repairClient(event: IpcMainInvokeEvent): SessionRepairClient {
  if (repairWindow === undefined || repairWindow.isDestroyed() || event.sender !== repairWindow.webContents) {
    throw new Error('会话修复请求来源无效')
  }
  if (trustedOrigin === undefined || latestView?.phase !== 'ready') {
    throw new Error('DSH Runtime 尚未就绪，请等待启动完成后再试')
  }
  return new SessionRepairClient(new URL(trustedOrigin))
}

function runtimeClient(event: IpcMainInvokeEvent): RuntimeController {
  const fromMainWindow = mainWindow !== undefined && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents
  const fromManagerWindow = managerWindow !== undefined && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents
  if (!fromMainWindow && !fromManagerWindow) throw new Error('Runtime 请求来源无效')
  const url = new URL(event.sender.getURL())
  if (url.protocol !== 'file:' || resolve(fileURLToPath(url)) !== resolve(setupPage)) throw new Error('Runtime 请求页面无效')
  if (controller === undefined) throw new Error('DSH Runtime 控制器尚未初始化')
  return controller
}

function fromTrustedDshWindow(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
    || trustedOrigin === undefined || latestView?.phase !== 'ready') return false
  try { return new URL(event.sender.getURL()).origin === trustedOrigin }
  catch { return false }
}

function skinService(event: IpcMainInvokeEvent): ShellSkinStore {
  if (!fromTrustedDshWindow(event)) throw new Error('皮肤市场请求来源无效')
  if (shellSkinStore === undefined) throw new Error('皮肤市场尚未初始化')
  return shellSkinStore
}

function openSkinMarket(): void {
  if (mainWindow === undefined || mainWindow.isDestroyed() || trustedOrigin === undefined) return
  try {
    if (new URL(mainWindow.webContents.getURL()).origin !== trustedOrigin) return
  } catch {
    return
  }
  void mainWindow.webContents.executeJavaScript("typeof window.__dshDesktopOpenSkinMarket === 'function' ? window.__dshDesktopOpenSkinMarket() : false").catch(logFatalError)
}

function petSender(event: IpcMainEvent | IpcMainInvokeEvent): PetWindowController | undefined {
  const window = petWindow
  return window?.matchesSender(event.sender, petPage) === true ? window : undefined
}

function fromPetWindow(event: IpcMainInvokeEvent): PetWindowController {
  const window = petSender(event)
  if (window === undefined) throw new Error('桌面宠物请求来源无效')
  return window
}

function parseActivePetSession(value: unknown): string | undefined {
  if (value === null) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !/^[0-9A-Za-z._~-]+$/u.test(value)) {
    throw new Error('桌面宠物前台会话无效')
  }
  return value
}

function pluginService(event: IpcMainInvokeEvent): PluginManager {
  if (pluginWindow === undefined || pluginWindow.isDestroyed() || event.sender !== pluginWindow.webContents) {
    throw new Error('插件管理请求来源无效')
  }
  if (pluginManager === undefined) throw new Error('插件管理器尚未初始化')
  return pluginManager
}

function mcpService(event: IpcMainInvokeEvent): McpManager {
  if (mcpWindow === undefined || mcpWindow.isDestroyed() || event.sender !== mcpWindow.webContents) {
    throw new Error('MCP 管理请求来源无效')
  }
  if (mcpManager === undefined) throw new Error('MCP 管理器尚未初始化')
  return mcpManager
}

function personalizationService(event: IpcMainInvokeEvent): PersonalizationManager {
  if (personalizationWindow === undefined || personalizationWindow.isDestroyed() || event.sender !== personalizationWindow.webContents) {
    throw new Error('个性化设置请求来源无效')
  }
  if (personalizationManager === undefined) throw new Error('个性化设置管理器尚未初始化')
  return personalizationManager
}

function isPersonalizationSender(event: IpcMainEvent): boolean {
  return personalizationWindow !== undefined && !personalizationWindow.isDestroyed() && event.sender === personalizationWindow.webContents
}

async function setMcpEnabled(event: IpcMainInvokeEvent, value: unknown): Promise<McpList> {
  const service = mcpService(event)
  const runtimeController = controller
  if (runtimeController === undefined) throw new Error('DSH Runtime 控制器尚未初始化')
  if (mcpMutationActive) throw new Error('另一个 MCP 操作正在进行')
  if (pluginManager?.current() !== undefined) throw new Error('插件操作正在进行，请完成后再切换 MCP')
  mcpMutationActive = true
  try {
    return await mutateMcpWithRuntime({
      async pause() {
        if (quitting) throw new Error('应用正在退出，无法切换 MCP')
        if (mainWindow !== undefined) await showSetup(mainWindow)
        await runtimeController.pauseForPluginMutation()
      },
      async mutate() {
        if (quitting) throw new Error('应用正在退出，无法切换 MCP')
        return service.setEnabled(value)
      },
      async retry() {
        if (!quitting) await runtimeController.retry()
      },
    })
  } finally {
    mcpMutationActive = false
  }
}

function installMenu(): void {
  if (!mainUiLoaded) {
    clearMainMenu()
    return
  }
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '个性化设置...', click: () => { void openPersonalization() } },
        {
          label: '桌宠设置',
          submenu: [
            { label: '小', type: 'radio', checked: petWindow?.size === 'small', enabled: petWindow !== undefined, click: () => { void setPetSize('small') } },
            { label: '标准', type: 'radio', checked: petWindow?.size === 'standard', enabled: petWindow !== undefined, click: () => { void setPetSize('standard') } },
            { label: '大', type: 'radio', checked: petWindow?.size === 'large', enabled: petWindow !== undefined, click: () => { void setPetSize('large') } },
          ],
        },
        { label: '设置', enabled: latestView?.phase === 'ready', click: () => { void openSettings() } },
        { label: '检查更新', click: () => { void updater?.check(true) } },
        { type: 'separator' },
        {
          label: '打开 DSH 数据目录',
          click: () => {
            const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
            void mkdir(home, { recursive: true }).then(() => shell.openPath(home))
          },
        },
      ],
    },
    {
      label: 'Runtime',
      submenu: [
        { label: '管理 DSH 版本', click: () => { void openVersionManager() } },
        { label: '刷新并应用版本策略', click: () => { void retryRuntimeFromMenu().catch(logFatalError) } },
        { type: 'separator' },
        {
          label: '管理插件',
          enabled: controller?.installedRuntime() !== undefined,
          click: () => { void openPluginManager() },
        },
        {
          label: '管理 MCP',
          enabled: controller?.installedRuntime() !== undefined,
          click: () => { void openMcpManager() },
        },
        {
          label: '打开插件管理终端',
          enabled: cliDirectory !== undefined,
          click: () => {
            if (cliDirectory === undefined) return
            const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
            void openPluginTerminal(cliDirectory, home).catch((error: unknown) => {
              dialog.showErrorBox('无法打开插件管理终端', String(error))
            })
          },
        },
      ],
    },
    { label: '编辑', submenu: [{ role: 'copy', label: '复制' }, { role: 'paste', label: '粘贴' }, { role: 'selectAll', label: '全选' }] },
    {
      label: '视图',
      submenu: [
        { label: '主题', enabled: latestView?.phase === 'ready', click: openSkinMarket },
        { label: '桌面宠物', type: 'checkbox', checked: petWindow?.enabled ?? true, click: item => { void setPetEnabled(item.checked) } },
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        { label: '修复历史会话', click: () => { void openSessionRepair() } },
        { type: 'separator' },
        { label: '关于 DeepSeek Harness', click: () => { void showAbout() } },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  syncMainMenuVisibility()
}

async function startApplication(): Promise<void> {
  mainUiLoaded = false
  clearMainMenu()
  latestView = {
    phase: 'checking',
    message: '正在检查可用的 DSH 版本',
    shellVersion: app.getVersion(),
    minimumDshVersion: MINIMUM_DSH_VERSION,
    preference: { mode: 'latest-compatible' },
    versions: [],
    cachedCatalog: false,
  }
  mainWindow = createWindow()
  petWindow = new PetWindowController({
    page: petPage,
    preload: petPreload,
    icon: join(app.getAppPath(), 'assets', 'icon.png'),
    userData: app.getPath('userData'),
    onFatal: logFatalError,
  })
  await petWindow.start()
  petEvents = new PetEventController({
    webSocketFactory: url => new WebSocket(url) as unknown as PetWebSocket,
  })
  disposePetEvents = petEvents.subscribe(state => { petWindow?.setState(toPetWindowState(state)) })
  petWindow.setState(toPetWindowState(petEvents.snapshot()))
  mainWindow.on('show', () => { petWindow?.setMainVisible(true) })
  mainWindow.on('hide', () => { petWindow?.setMainVisible(false) })
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
    if (!quitting) petWindow?.setMainVisible(false)
  })
  petWindow.setMainVisible(mainWindow.isVisible())
  createTray()
  await mainWindow.loadFile(setupPage)
  const store = new RuntimeStore(runtimeRoot())
  shellSkinStore = new ShellSkinStore(join(app.getPath('userData'), 'skins'), undefined, progress => {
    if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.webContents.send('shell-skins:progress', progress)
  })
  await shellSkinStore.initialize().catch(logFatalError)
  protocol.handle('dsh-skin', async request => {
    try {
      const url = new URL(request.url)
      const asset = await shellSkinStore?.readAsset(decodeURIComponent(url.hostname), decodeURIComponent(url.pathname === '/' ? '/skin.html' : url.pathname))
      if (asset === undefined) return new Response('skin store unavailable', { status: 503 })
      return new Response(new Uint8Array(asset.body), { status: 200, headers: { 'content-type': asset.contentType, 'cache-control': 'no-cache', 'access-control-allow-origin': '*' } })
    } catch (error) {
      return new Response(error instanceof Error ? error.message : String(error), { status: 404 })
    }
  })
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  await mkdir(home, { recursive: true })
  controller = new RuntimeController({
    shellVersion: app.getVersion(),
    store,
    shutdownHook,
    userData: app.getPath('userData'),
    ...(process.env.DSH_DESKTOP_CATALOG_URL === undefined ? {} : { catalogUrl: process.env.DSH_DESKTOP_CATALOG_URL }),
    onView: broadcast,
    async onReady(url, _runtime, preparedCliDirectory) {
      mainUiLoaded = false
      clearMainMenu()
      cliDirectory = preparedCliDirectory
      trustedOrigin = url.origin
      activePetSession = undefined
      petEvents?.setActiveSession(undefined)
      petEvents?.start(url.origin)
      installMenu()
      installTrayMenu()
      const window = mainWindow
      if (window === undefined) return
      await window.loadURL(url.href)
      if (mainWindow !== window || window.isDestroyed()) return
      mainUiLoaded = true
      installMenu()
    },
    onOpenSettingsDocument: openTextDocument,
  })
  pluginManager = new PluginManager({
    runtime: () => controller?.installedRuntime(),
    home,
    onOperationFinished(operation) {
      if (operation.state !== 'failed' || controller === undefined) return
      void controller.retry().catch(logFatalError)
    },
  })
  personalizationManager = new PersonalizationManager({ home })
  mcpManager = new McpManager({
    home,
    codexConfigPath: join(homedir(), '.codex', 'config.toml'),
    overlayPaths() {
      const runtime = controller?.installedRuntime()
      return runtime === undefined ? [] : [join(runtime.directory, 'app', 'desktop.patch.yml')]
    },
  })
  updater = new ShellUpdater(mainWindow, async () => {
    pluginManager?.dispose()
    await stopPet()
    await controller?.stop()
    quitting = true
  }, showUpdateProgress)
  installMenu()
  await controller.start()
  const updateTimer = setTimeout(() => { void updater?.check(false) }, 5_000)
  updateTimer.unref()
}

function logFatalError(error: unknown): void {
  const directory = app.getPath('userData')
  mkdirSync(directory, { recursive: true })
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  appendFileSync(join(directory, 'desktop.log'), `[${new Date().toISOString()}] ${detail}\n`, 'utf8')
}

ipcMain.on('pet:set-active-session', (event, value: unknown) => {
  if (!fromTrustedDshWindow(event)) return
  try {
    const sessionId = parseActivePetSession(value)
    if (sessionId === activePetSession) return
    activePetSession = sessionId
    petEvents?.setActiveSession(sessionId)
  } catch {
    // Invalid page messages cannot change the foreground reply source.
  }
})
function parsePetDragPoint(value: unknown): { x: number; y: number } | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.x !== 'number' || !Number.isFinite(input.x) || Math.abs(input.x) > 1_000_000
    || typeof input.y !== 'number' || !Number.isFinite(input.y) || Math.abs(input.y) > 1_000_000) return undefined
  return { x: input.x, y: input.y }
}

ipcMain.on('pet:ready', (event) => { petSender(event)?.rendererDidLoad() })
ipcMain.on('pet:interaction', (event, value: unknown) => { petSender(event)?.setInteraction(value === true) })
ipcMain.on('pet:set-shape', (event, value: unknown) => {
  const pet = petSender(event)
  if (pet === undefined) return
  try { pet.setBubbleShape(parsePetWindowShape(value, pet.size)) }
  catch { /* Invalid renderer geometry cannot expand the native pet window region. */ }
})
ipcMain.on('pet:drag-start', (event, value: unknown) => {
  const point = parsePetDragPoint(value)
  if (point !== undefined) petSender(event)?.startDrag(point)
})
ipcMain.on('pet:drag-move', (event, value: unknown) => {
  const point = parsePetDragPoint(value)
  if (point !== undefined) petSender(event)?.dragTo(point)
})
ipcMain.on('pet:drag-end', (event) => { petSender(event)?.endDrag() })
ipcMain.on('pet:focus-main', (event) => { if (petSender(event) !== undefined) showMainWindow() })
ipcMain.on('pet:context-menu', showPetContextMenu)
ipcMain.on('pet:hide', (event) => { if (petSender(event) !== undefined) void setPetEnabled(false) })
ipcMain.handle('shell-skins:list', event => skinService(event).list())
ipcMain.handle('shell-skins:preview', async (event, skinId: unknown, index: unknown) => skinService(event).preview(String(skinId), Number(index)))
ipcMain.handle('shell-skins:install', async (event, skinId: unknown) => skinService(event).install(String(skinId)))
ipcMain.handle('shell-skins:activate', async (event, skinId: unknown) => {
  const service = skinService(event)
  const active = await service.activate(String(skinId))
  if (active !== null) await executeClientBundleAdapter(event.sender, active.bundle, active.id)
  return service.list()
})
ipcMain.handle('shell-skins:select-variant', async (event, skinId: unknown, variantId: unknown) => {
  const service = skinService(event)
  const requestedSkinId = String(skinId)
  if (service.list().activeSkinId !== requestedSkinId) throw new Error('只能为当前激活皮肤选择变体')
  const active = await service.activeClientBundle()
  if (active === null || active.id !== requestedSkinId) throw new Error('当前激活皮肤不可用')
  await executeClientBundleAdapter(event.sender, active.bundle, active.id, String(variantId))
  return service.list()
})
ipcMain.handle('shell-skins:deactivate', async event => {
  const service = skinService(event)
  const result = await service.deactivate()
  await event.sender.executeJavaScript(createSkinDisposerScript())
  return result
})
ipcMain.handle('shell-skins:uninstall', async (event, skinId: unknown) => {
  const service = skinService(event)
  const active = service.list().activeSkinId === String(skinId)
  const result = await service.uninstall(String(skinId))
  if (active) await event.sender.executeJavaScript(createSkinDisposerScript())
  return result
})

ipcMain.handle('pet:respond', async (event, approvalId: unknown, outcome: unknown) => {
  fromPetWindow(event)
  if (typeof approvalId !== 'string' || approvalId.length === 0 || approvalId.length > 256
    || (outcome !== 'allowed-once' && outcome !== 'rejected')) throw new Error('桌面宠物审批参数无效')
  const events = petEvents
  if (events === undefined) throw new Error('DSH 审批连接不可用')
  return events.decide({ approvalId, outcome })
})

ipcMain.handle('runtime:get-view', (event) => {
  runtimeClient(event)
  return latestView
})
ipcMain.handle('runtime:retry', async (event) => {
  const runtimeController = runtimeClient(event)
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await runtimeController.retry()
})
ipcMain.handle('runtime:set-preference', async (event, value: unknown) => {
  const runtimeController = runtimeClient(event)
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await runtimeController.setPreference(parsePreference(value))
})
ipcMain.handle('runtime:recover-stale-local-plugins', async (event) => {
  const runtimeController = runtimeClient(event)
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await runtimeController.recoverStaleLocalPlugins()
})
ipcMain.handle('runtime:recover-plugin-preset', async (event) => {
  const runtimeController = runtimeClient(event)
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await runtimeController.recoverPluginPreset()
})
ipcMain.handle('personalization:read', async (event) => {
  return personalizationService(event).read()
})
ipcMain.handle('personalization:save', async (event, value: unknown) => {
  return personalizationService(event).save(value)
})
ipcMain.on('personalization:dirty', (event, value: unknown) => {
  if (isPersonalizationSender(event) && typeof value === 'boolean') personalizationDirty = value
})
ipcMain.handle('mcp-manager:list', async (event) => {
  return mcpService(event).list()
})
ipcMain.handle('mcp-manager:set-enabled', async (event, value: unknown) => {
  return setMcpEnabled(event, value)
})
ipcMain.handle('plugin-manager:list', async (event) => {
  return pluginService(event).list()
})
ipcMain.handle('plugin-manager:updates', async (event) => {
  return pluginService(event).updates()
})
ipcMain.handle('plugin-manager:start', async (event, value: unknown) => {
  const service = pluginService(event)
  if (mcpMutationActive) throw new Error('MCP 操作正在进行，请完成后再管理插件')
  const runtimeController = controller
  if (runtimeController === undefined) throw new Error('DSH Runtime 控制器尚未初始化')
  return service.start(value, async () => {
    if (mainWindow !== undefined) await showSetup(mainWindow)
    await runtimeController.pauseForPluginMutation()
  })
})
ipcMain.handle('plugin-manager:status', (event, operationId: unknown) => {
  return pluginService(event).status(operationId)
})
ipcMain.handle('plugin-manager:current', (event) => {
  return pluginService(event).current()
})
ipcMain.handle('plugin-manager:restart', async (event, operationId: unknown) => {
  const service = pluginService(event)
  const runtimeController = controller
  if (runtimeController === undefined) throw new Error('DSH Runtime 控制器尚未初始化')
  return pluginRestartCoordinator.restart(operationId as string, {
    status: id => service.status(id),
    async showSetup() { if (mainWindow !== undefined) await showSetup(mainWindow) },
    async retry() { await runtimeController.retry() },
    currentView: () => latestView,
  }, id => { service.markRestarted(id) })
})
ipcMain.handle('session-repair:inspect', async (event, sessionId: unknown) => {
  return repairClient(event).inspect(sessionId)
})
ipcMain.handle('session-repair:apply', async (event, sessionId: unknown, expectedRevision: unknown) => {
  const result = await repairClient(event).apply(sessionId, expectedRevision)
  mainWindow?.webContents.reload()
  return result
})
ipcMain.handle('session-repair:rollback', async (event, sessionId: unknown, expectedRevision: unknown) => {
  const result = await repairClient(event).rollback(sessionId, expectedRevision)
  mainWindow?.webContents.reload()
  return result
})

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    showMainWindow()
  })
  app.on('before-quit', (event) => {
    if (quitting) {
      tray?.destroy()
      tray = undefined
      return
    }
    if (personalizationDirty && personalizationWindow !== undefined && !personalizationWindow.isDestroyed()) {
      event.preventDefault()
      if (personalizationQuitPrompt || personalizationClosePrompt) return
      const window = personalizationWindow
      personalizationQuitPrompt = true
      void dialog.showMessageBox(window, {
        type: 'warning',
        title: '退出 DeepSeek Harness',
        message: '个性化设置有尚未保存的更改。',
        detail: '退出应用将放弃这些更改。',
        buttons: ['继续编辑', '放弃更改并退出'],
        defaultId: 0,
        cancelId: 0,
      }).then(result => {
        personalizationQuitPrompt = false
        if (result.response !== 1 || window.isDestroyed()) return
        personalizationDirty = false
        app.quit()
      })
      return
    }
    if (controller === undefined && petWindow === undefined) {
      tray?.destroy()
      tray = undefined
      return
    }
    event.preventDefault()
    quitting = true
    pluginManager?.dispose()
    tray?.destroy()
    tray = undefined
    void Promise.all([stopPet(), controller?.stop()]).finally(() => { app.quit() })
  })
  app.whenReady().then(startApplication).catch((error: unknown) => {
    logFatalError(error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}
