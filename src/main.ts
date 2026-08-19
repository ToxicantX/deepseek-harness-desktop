import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { MINIMUM_DSH_VERSION, type RuntimePreference } from './catalog.ts'
import { openPluginTerminal } from './cli-shell.ts'
import { RuntimeController, type RuntimeView } from './runtime-controller.ts'
import { SessionRepairClient } from './session-repair.ts'
import { SettingsDocumentClient } from './settings-document.ts'
import { RuntimeStore } from './runtime-store.ts'
import { ShellUpdater, type ShellUpdateProgress } from './shell-updater.ts'
import { allowDshWebPermission } from './window-security.ts'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const setupPage = join(app.getAppPath(), 'assets', 'runtime.html')
const repairPage = join(app.getAppPath(), 'assets', 'session-repair.html')
const shellUpdatePage = join(app.getAppPath(), 'assets', 'shell-update.html')
const allowedLocalPages = new Set([setupPage, repairPage, shellUpdatePage])
const preload = join(moduleDirectory, 'preload.cjs')
const shutdownHook = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'lib', 'shutdown-hook.js')
  : join(moduleDirectory, 'shutdown-hook.js')

let mainWindow: BrowserWindow | undefined
let managerWindow: BrowserWindow | undefined
let repairWindow: BrowserWindow | undefined
let updateWindow: BrowserWindow | undefined
let latestUpdateProgress: ShellUpdateProgress | undefined
let controller: RuntimeController | undefined
let updater: ShellUpdater | undefined
let latestView: RuntimeView | undefined
let cliDirectory: string | undefined
let trustedOrigin: string | undefined
let quitting = false

function runtimeRoot(): string {
  if (process.env.DSH_DESKTOP_RUNTIME_ROOT !== undefined) return process.env.DSH_DESKTOP_RUNTIME_ROOT
  const local = process.env.LOCALAPPDATA
  if (local === undefined || local.length === 0) throw new Error('LOCALAPPDATA is unavailable')
  return join(local, 'DeepSeek Harness', 'runtime-manager')
}

function createWindow(options: { utility?: 'manager' | 'repair' | 'update' } = {}): BrowserWindow {
  const utility = options.utility
  const manager = utility === 'manager'
  const repair = utility === 'repair'
  const update = utility === 'update'
  const window = new BrowserWindow({
    ...(update && mainWindow !== undefined ? { parent: mainWindow, modal: true } : {}),
    width: manager ? 700 : repair ? 760 : update ? 480 : 1240,
    height: manager ? 720 : repair ? 780 : update ? 250 : 820,
    minWidth: manager || repair ? 480 : update ? 420 : 820,
    minHeight: manager ? 560 : update ? 220 : 600,
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
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    const origin = parsed.origin
    const localNavigation = parsed.protocol === 'file:' && allowedLocalPages.has(fileURLToPath(parsed))
    const allowed = localNavigation || (trustedOrigin !== undefined && origin === trustedOrigin)
    if (!allowed) {
      event.preventDefault()
      if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    }
  })
  window.once('ready-to-show', () => { window.show() })
  window.webContents.on('did-finish-load', () => { sendView(window) })
  return window
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
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: 'Runtime',
      submenu: [
        { label: '管理 DSH 版本', click: () => { void openVersionManager() } },
        { label: '刷新并应用版本策略', click: () => { void controller?.retry() } },
        { type: 'separator' },
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
    { label: '视图', submenu: [{ role: 'reload', label: '重新加载' }, { role: 'toggleDevTools', label: '开发者工具' }, { type: 'separator' }, { role: 'resetZoom', label: '实际大小' }, { role: 'zoomIn', label: '放大' }, { role: 'zoomOut', label: '缩小' }, { role: 'togglefullscreen', label: '全屏' }] },
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
  mainWindow.on('closed', () => { mainWindow = undefined })
  await mainWindow.loadFile(setupPage)
  const store = new RuntimeStore(runtimeRoot())
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
  updater = new ShellUpdater(mainWindow, async () => {
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

ipcMain.handle('runtime:get-view', () => latestView)
ipcMain.handle('runtime:retry', async () => {
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await controller?.retry()
})
ipcMain.handle('runtime:set-preference', async (_event, value: unknown) => {
  if (mainWindow !== undefined) await showSetup(mainWindow)
  await controller?.setPreference(parsePreference(value))
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
    if (mainWindow === undefined) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })
  app.on('before-quit', (event) => {
    if (quitting || controller === undefined) return
    event.preventDefault()
    quitting = true
    void controller.stop().finally(() => { app.quit() })
  })
  app.whenReady().then(startApplication).catch((error: unknown) => {
    logFatalError(error)
    dialog.showErrorBox('DeepSeek Harness 启动失败', error instanceof Error ? error.message : String(error))
    app.quit()
  })
  app.on('window-all-closed', () => { app.quit() })
}
