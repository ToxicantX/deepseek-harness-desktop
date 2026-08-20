import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, nativeImage, screen, type NativeImage, type Rectangle, type WebContents } from 'electron'
import { clampPetBounds, defaultPetBounds } from './desktop-pet.ts'

const WIDTH = 360
const HEIGHT = 240
const EDGE_GAP = 16
const SAVE_DELAY_MS = 250
const STREAM_UPDATE_MS = 100
const MAX_SKIN_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_SKIN_SOURCE_DIMENSION = 4_096
const MAX_SKIN_RENDER_DIMENSION = 512
const MAX_SKIN_PNG_BYTES = 2 * 1024 * 1024
const MAX_SKIN_DATA_URL_LENGTH = 3_000_000

export type PetMode = 'idle' | 'thinking' | 'speaking' | 'approval' | 'success' | 'error' | 'unavailable'

export interface PetApprovalView {
  id: string
  toolName: string
  sessionLabel: string
  reason?: string
  pendingCount: number
  responding: boolean
}

export interface PetRendererState {
  mode: PetMode
  status?: string
  reply?: string
  sessionLabel?: string
  approval?: PetApprovalView
}

interface StoredPetSettings {
  version: 1
  manuallyHidden: boolean
  x?: number
  y?: number
  displayId?: number
}

export interface PetWindowOptions {
  page: string
  preload: string
  icon: string
  userData: string
  onFatal(error: unknown): void
}

function finiteInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined
}

function normalizedSkin(image: NativeImage): { png: Buffer; dataUrl: string } {
  if (image.isEmpty()) throw new Error('所选文件不是有效的宠物皮肤图片')
  const { width, height } = image.getSize()
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0
    || width > MAX_SKIN_SOURCE_DIMENSION || height > MAX_SKIN_SOURCE_DIMENSION) {
    throw new Error('宠物皮肤图片尺寸必须在 1 到 4096 像素之间')
  }
  const scale = Math.min(1, MAX_SKIN_RENDER_DIMENSION / width, MAX_SKIN_RENDER_DIMENSION / height)
  const rendered = scale === 1 ? image : image.resize({
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    quality: 'best',
  })
  const png = rendered.toPNG()
  if (png.byteLength === 0 || png.byteLength > MAX_SKIN_PNG_BYTES) throw new Error('规范化后的宠物皮肤图片不能超过 2 MB')
  const dataUrl = rendered.toDataURL()
  if (!dataUrl.startsWith('data:image/png;base64,') || dataUrl.length > MAX_SKIN_DATA_URL_LENGTH) {
    throw new Error('无法生成安全的宠物皮肤图片')
  }
  return { png, dataUrl }
}

function parseSettings(value: unknown): StoredPetSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { version: 1, manuallyHidden: false }
  const input = value as Record<string, unknown>
  const x = finiteInteger(input.x)
  const y = finiteInteger(input.y)
  const displayId = finiteInteger(input.displayId)
  return {
    version: 1,
    manuallyHidden: input.manuallyHidden === true,
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(displayId === undefined ? {} : { displayId }),
  }
}

export class PetWindowController {
  private readonly settingsPath: string
  private readonly skinPath: string
  private window: BrowserWindow | undefined
  private settings: StoredPetSettings = { version: 1, manuallyHidden: false }
  private skinDataUrl: string | undefined
  private state: PetRendererState = { mode: 'unavailable', status: 'DSH 正在启动' }
  private mainVisible = true
  private rendererReady = false
  private hoverInteractive = false
  private disposing = false
  private saveTimer: NodeJS.Timeout | undefined
  private stateTimer: NodeJS.Timeout | undefined
  private savePromise: Promise<void> = Promise.resolve()
  private crashTimes: number[] = []
  private readonly displayChanged = (): void => { this.reclamp() }

  constructor(private readonly options: PetWindowOptions) {
    this.settingsPath = join(options.userData, 'desktop-pet.json')
    this.skinPath = join(options.userData, 'desktop-pet-skin.png')
  }

  async start(): Promise<void> {
    this.settings = await this.readSettings()
    this.skinDataUrl = await this.readSkin()
    this.createWindow()
    screen.on('display-added', this.displayChanged)
    screen.on('display-removed', this.displayChanged)
    screen.on('display-metrics-changed', this.displayChanged)
  }

  get enabled(): boolean { return !this.settings.manuallyHidden }
  get customSkinConfigured(): boolean { return this.skinDataUrl !== undefined }
  get visible(): boolean { return this.window?.isVisible() ?? false }
  get webContents(): WebContents | undefined { return this.window?.webContents }

  setMainVisible(visible: boolean): void {
    this.mainVisible = visible
    this.reconcileVisibility()
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.settings.manuallyHidden = !enabled
    this.reconcileVisibility()
    await this.save()
  }

  async setCustomSkin(sourcePath: string): Promise<void> {
    const source = await stat(sourcePath)
    if (!source.isFile() || source.size <= 0 || source.size > MAX_SKIN_SOURCE_BYTES) {
      throw new Error('宠物皮肤图片必须是不超过 8 MB 的本地文件')
    }
    const skin = normalizedSkin(nativeImage.createFromPath(sourcePath))
    const temporary = this.skinPath + '.tmp'
    try {
      await writeFile(temporary, skin.png)
      await rename(temporary, this.skinPath)
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
    this.skinDataUrl = skin.dataUrl
    this.sendSkin()
  }

  async resetCustomSkin(): Promise<void> {
    await rm(this.skinPath, { force: true })
    this.skinDataUrl = undefined
    this.sendSkin()
  }

  setState(state: PetRendererState): void {
    this.state = state
    if (state.mode === 'speaking') {
      if (this.stateTimer === undefined) {
        this.stateTimer = setTimeout(() => { this.stateTimer = undefined; this.sendState() }, STREAM_UPDATE_MS)
        this.stateTimer.unref()
      }
    } else {
      this.clearStateTimer()
      this.sendState()
    }
    this.applyMousePolicy()
  }

  setInteraction(interactive: boolean): void {
    this.hoverInteractive = interactive
    this.applyMousePolicy()
  }

  rendererDidLoad(): void {
    this.rendererReady = true
    this.clearStateTimer()
    this.sendState()
    this.sendSkin()
    this.applyMousePolicy()
    this.reconcileVisibility()
  }

  matchesSender(contents: WebContents, page: string): boolean {
    if (this.window === undefined || this.window.isDestroyed() || contents !== this.window.webContents) return false
    try {
      const url = new URL(contents.getURL())
      return url.protocol === 'file:' && resolve(fileURLToPath(url)) === resolve(page)
    } catch {
      return false
    }
  }

  async dispose(): Promise<void> {
    if (this.disposing) return
    this.disposing = true
    screen.off('display-added', this.displayChanged)
    screen.off('display-removed', this.displayChanged)
    screen.off('display-metrics-changed', this.displayChanged)
    if (this.saveTimer !== undefined) { clearTimeout(this.saveTimer); this.saveTimer = undefined }
    this.clearStateTimer()
    await this.captureAndSave()
    if (this.window !== undefined && !this.window.isDestroyed()) this.window.destroy()
    this.window = undefined
  }

  private createWindow(): void {
    const bounds = this.initialBounds()
    const window = new BrowserWindow({
      ...bounds,
      width: WIDTH,
      height: HEIGHT,
      minWidth: WIDTH,
      maxWidth: WIDTH,
      minHeight: HEIGHT,
      maxHeight: HEIGHT,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      backgroundColor: '#00000000',
      icon: nativeImage.createFromPath(this.options.icon),
      webPreferences: {
        preload: this.options.preload,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    this.window = window
    this.rendererReady = false
    window.setAlwaysOnTop(true, 'floating')
    window.setMenu(null)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event, url) => { if (url !== window.webContents.getURL()) event.preventDefault() })
    window.webContents.on('did-finish-load', () => { this.rendererDidLoad() })
    window.webContents.on('render-process-gone', (_event, details) => {
      if (!this.disposing && details.reason !== 'clean-exit') this.recoverRenderer(new Error('pet renderer exited: ' + details.reason))
    })
    window.on('unresponsive', () => { if (!this.disposing) this.recoverRenderer(new Error('pet renderer became unresponsive')) })
    window.on('move', () => { this.scheduleSave() })
    window.on('close', (event) => {
      if (this.disposing) return
      event.preventDefault()
      void this.setEnabled(false)
    })
    window.on('closed', () => { if (this.window === window) this.window = undefined })
    void window.loadFile(this.options.page).catch(error => { this.options.onFatal(error) })
  }

  private recoverRenderer(error: unknown): void {
    const failed = this.window
    if (failed === undefined) return
    this.window = undefined
    this.options.onFatal(error)
    const now = Date.now()
    this.crashTimes = this.crashTimes.filter(time => now - time < 60_000)
    this.crashTimes.push(now)
    if (this.crashTimes.length > 3) {
      this.settings.manuallyHidden = true
      if (!failed.isDestroyed()) failed.destroy()
      void this.save()
      return
    }
    if (!failed.isDestroyed()) failed.destroy()
    setTimeout(() => { if (!this.disposing && this.window === undefined) this.createWindow() }, this.crashTimes.length * 500).unref()
  }

  private initialBounds(): Rectangle {
    const displays = screen.getAllDisplays()
    const display = displays.find(candidate => candidate.id === this.settings.displayId) ?? screen.getPrimaryDisplay()
    const fallback = defaultPetBounds(display.workArea, { width: WIDTH, height: HEIGHT }, EDGE_GAP)
    const candidate = this.settings.x === undefined || this.settings.y === undefined
      ? fallback
      : { x: this.settings.x, y: this.settings.y, width: WIDTH, height: HEIGHT }
    return clampPetBounds(candidate, display.workArea)
  }

  private reclamp(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const next = clampPetBounds(bounds, display.workArea)
    if (next.x !== bounds.x || next.y !== bounds.y) window.setBounds(next, false)
    this.scheduleSave()
  }

  private reconcileVisibility(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || !this.rendererReady) return
    if (!this.mainVisible && !this.settings.manuallyHidden) window.showInactive()
    else window.hide()
  }

  private clearStateTimer(): void {
    if (this.stateTimer !== undefined) { clearTimeout(this.stateTimer); this.stateTimer = undefined }
  }

  private sendState(): void {
    if (this.rendererReady && this.window !== undefined && !this.window.isDestroyed()) this.window.webContents.send('pet:state', this.state)
  }

  private sendSkin(): void {
    if (this.rendererReady && this.window !== undefined && !this.window.isDestroyed()) {
      this.window.webContents.send('pet:skin', { dataUrl: this.skinDataUrl ?? null })
    }
  }

  private applyMousePolicy(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    const forced = this.state.approval !== undefined || (this.state.reply?.length ?? 0) > 0 || (this.state.status?.length ?? 0) > 0
    window.setIgnoreMouseEvents(!(forced || this.hoverInteractive), { forward: true })
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => { this.saveTimer = undefined; void this.captureAndSave() }, SAVE_DELAY_MS)
    this.saveTimer.unref()
  }

  private async captureAndSave(): Promise<void> {
    const window = this.window
    if (window !== undefined && !window.isDestroyed()) {
      const bounds = window.getBounds()
      const display = screen.getDisplayMatching(bounds)
      this.settings = { ...this.settings, x: bounds.x, y: bounds.y, displayId: display.id }
    }
    await this.save()
  }

  private async readSettings(): Promise<StoredPetSettings> {
    try { return parseSettings(JSON.parse(await readFile(this.settingsPath, 'utf8')) as unknown) }
    catch { return { version: 1, manuallyHidden: false } }
  }

  private async readSkin(): Promise<string | undefined> {
    try {
      const source = await stat(this.skinPath)
      if (!source.isFile() || source.size <= 0 || source.size > MAX_SKIN_SOURCE_BYTES) return undefined
      return normalizedSkin(nativeImage.createFromPath(this.skinPath)).dataUrl
    } catch {
      return undefined
    }
  }

  private async save(): Promise<void> {
    const value = JSON.stringify(this.settings) + '\n'
    const temporary = this.settingsPath + '.tmp'
    this.savePromise = this.savePromise.then(async () => {
      await writeFile(temporary, value, 'utf8')
      await rename(temporary, this.settingsPath)
    }).catch(error => { this.options.onFatal(error) })
    await this.savePromise
  }
}
