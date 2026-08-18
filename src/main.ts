import { appendFileSync, mkdirSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  type MenuItemConstructorOptions,
} from 'electron'
import { MINIMUM_DSH_VERSION, type RuntimePreference } from './catalog.ts'
import { openPluginTerminal } from './cli-shell.ts'
import { RuntimeController, type RuntimeView } from './runtime-controller.ts'
import { RuntimeStore } from './runtime-store.ts'
import { ShellUpdater } from './shell-updater.ts'

const moduleDirectory = dirname(fileURLToPath(import.meta.url))
const setupPage = join(app.getAppPath(), 'assets', 'runtime.html')
const setupUrl = pathToFileURL(setupPage)
const preload = join(moduleDirectory, 'preload.cjs')
const shutdownHook = app.isPackaged
  ? join(process.resourcesPath, 'app.asar.unpacked', 'lib', 'shutdown-hook.js')
  : join(moduleDirectory, 'shutdown-hook.js')

let mainWindow: BrowserWindow | undefined
let managerWindow: BrowserWindow | undefined
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

function createWindow(options: { manager?: boolean } = {}): BrowserWindow {
  const manager = options.manager ?? false
  const window = new BrowserWindow({
    width: manager ? 700 : 1240,
    height: manager ? 720 : 820,
    minWidth: manager ? 480 : 820,
    minHeight: manager ? 560 : 600,
    show: false,
    autoHideMenuBar: manager,
    backgroundColor: '#f5f6f8',
    icon: nativeImage.createFromPath(join(app.getAppPath(), 'assets', 'icon.png')),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const parsed = new URL(url)
    const origin = parsed.origin
    const setupNavigation = parsed.protocol === 'file:' && fileURLToPath(parsed) === fileURLToPath(setupUrl)
    const allowed = setupNavigation || (trustedOrigin !== undefined && origin === trustedOrigin)
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
  managerWindow = createWindow({ manager: true })
  managerWindow.on('closed', () => { managerWindow = undefined })
  await managerWindow.loadFile(setupPage)
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
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
        { label: '检查 Shell 更新', click: () => { void updater?.check(true) } },
        { label: '桌面项目', click: () => { void shell.openExternal('https://github.com/ToxicantX/deepseek-harness-desktop') } },
        { label: 'DSH 上游项目', click: () => { void shell.openExternal('https://github.com/deepseek-ai/deepseek-harness') } },
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
  })
  updater = new ShellUpdater(mainWindow, async () => { await controller?.stop() })
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
