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
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { MINIMUM_DSH_VERSION, type RuntimePreference } from './catalog.ts'
import { openPluginTerminal } from './cli-shell.ts'
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
const shellUpdatePage = join(app.getAppPath(), 'assets', 'shell-update.html')
const allowedLocalPages = new Set([setupPage, repairPage, pluginManagerPage, shellUpdatePage])
const preload = join(moduleDirectory, 'preload.cjs')
const shutdownHook = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'lib', 'shutdown-hook.js')
  : join(moduleDirectory, 'shutdown-hook.js')

let mainWindow: BrowserWindow | undefined
let tray: Tray | undefined
let managerWindow: BrowserWindow | undefined
let repairWindow: BrowserWindow | undefined
let pluginWindow: BrowserWindow | undefined
let updateWindow: BrowserWindow | undefined
let latestUpdateProgress: ShellUpdateProgress | undefined
let controller: RuntimeController | undefined
let pluginManager: PluginManager | undefined
const pluginRestartCoordinator = new PluginRestartCoordinator()
let updater: ShellUpdater | undefined
let latestView: RuntimeView | undefined
let cliDirectory: string | undefined
let trustedOrigin: string | undefined
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

function createWindow(options: { utility?: 'manager' | 'repair' | 'plugin' | 'update' } = {}): BrowserWindow {
  const utility = options.utility
  const manager = utility === 'manager'
  const repair = utility === 'repair'
  const plugin = utility === 'plugin'
  const update = utility === 'update'
  const window = new BrowserWindow({
    ...(update && mainWindow !== undefined ? { parent: mainWindow, modal: true } : {}),
    width: manager ? 700 : repair ? 760 : plugin ? 740 : update ? 480 : 1240,
    height: manager ? 720 : repair ? 780 : plugin ? 700 : update ? 250 : 820,
    minWidth: manager || repair ? 480 : plugin || update ? 420 : 820,
    minHeight: manager ? 560 : plugin ? 520 : update ? 220 : 600,
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
  window.once('ready-to-show', () => { window.show() })
  window.webContents.on('did-finish-load', () => {
    sendView(window)
    injectSkinMarket(window)
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
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 DeepSeek Harness', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { app.quit() } },
  ]))
  tray.on('click', showMainWindow)
}

async function showSetup(window: BrowserWindow): Promise<void> {
  const current = window.webContents.getURL()
  if (!current.startsWith('file:')) await window.loadFile(setupPage)
  sendView(window)
}

function sendView(window: BrowserWindow): void {
  if (latestView !== undefined && !window.isDestroyed()) window.webContents.send('runtime:view', latestView)
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
  await managerWindow.loadFile(setupPage)
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

async function showAbout(): Promise<void> {
  const runtimeVersion = latestView?.currentVersion === undefined
    ? '尚未启动'
    : latestView.currentVersion + ' (desktop revision ' + String(latestView.currentRuntimeRevision ?? 0) + ')'
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
  if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) {
    throw new Error('Runtime 请求来源无效')
  }
  const url = new URL(event.sender.getURL())
  if (url.protocol !== 'file:' || resolve(fileURLToPath(url)) !== resolve(setupPage)) throw new Error('Runtime 请求页面无效')
  if (controller === undefined) throw new Error('DSH Runtime 控制器尚未初始化')
  return controller
}

function skinService(event: IpcMainInvokeEvent): ShellSkinStore {
  if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents) throw new Error('皮肤市场请求来源无效')
  if (trustedOrigin === undefined || new URL(event.sender.getURL()).origin !== trustedOrigin) throw new Error('皮肤市场请求页面无效')
  if (shellSkinStore === undefined) throw new Error('皮肤市场尚未初始化')
  return shellSkinStore
}

function pluginService(event: IpcMainInvokeEvent): PluginManager {
  if (pluginWindow === undefined || pluginWindow.isDestroyed() || event.sender !== pluginWindow.webContents) {
    throw new Error('插件管理请求来源无效')
  }
  if (pluginManager === undefined) throw new Error('插件管理器尚未初始化')
  return pluginManager
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

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
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
        { label: '刷新并应用版本策略', click: () => { void controller?.retry() } },
        { type: 'separator' },
        {
          label: '管理插件',
          enabled: controller?.installedRuntime() !== undefined,
          click: () => { void openPluginManager() },
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
    { label: '视图', submenu: [{ label: '主题', enabled: latestView?.phase === 'ready', click: openSkinMarket }, { type: 'separator' }, { role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
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
}

async function startApplication(): Promise<void> {
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
  mainWindow.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    mainWindow?.hide()
  })
  mainWindow.on('closed', () => { mainWindow = undefined })
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
      cliDirectory = preparedCliDirectory
      trustedOrigin = url.origin
      installMenu()
      if (mainWindow !== undefined) await mainWindow.loadURL(url.href)
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
  updater = new ShellUpdater(mainWindow, async () => {
    pluginManager?.dispose()
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

ipcMain.handle('shell-skins:list', event => skinService(event).list())
ipcMain.handle('shell-skins:preview', async (event, skinId: unknown, index: unknown) => skinService(event).preview(String(skinId), Number(index)))
ipcMain.handle('shell-skins:install', async (event, skinId: unknown) => skinService(event).install(String(skinId)))
ipcMain.handle('shell-skins:activate', async (event, skinId: unknown) => {
  const active = await skinService(event).activate(String(skinId))
  if (active !== null) await executeClientBundleAdapter(event.sender, active.bundle, active.id)
  return skinService(event).list()
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
  const result = await skinService(event).deactivate()
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
ipcMain.handle('plugin-manager:list', async (event) => {
  return pluginService(event).list()
})
ipcMain.handle('plugin-manager:start', async (event, value: unknown) => {
  const service = pluginService(event)
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
    if (quitting || controller === undefined) {
      tray?.destroy()
      tray = undefined
      return
    }
    event.preventDefault()
    quitting = true
    pluginManager?.dispose()
    tray?.destroy()
    tray = undefined
    void controller.stop().finally(() => { app.quit() })
  })
  app.whenReady().then(startApplication).catch((error: unknown) => {
    logFatalError(error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
}
