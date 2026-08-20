import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, nativeImage, screen, type Rectangle, type WebContents } from 'electron'
import { clampPetBounds, defaultPetBounds } from './desktop-pet.ts'
import { DEFAULT_PET_SIZE, PET_SIZE_SPECS, parsePetSize, type PetSize } from './pet-size.ts'

const EDGE_GAP = 16
const SAVE_DELAY_MS = 250
const STREAM_UPDATE_MS = 100
const LEGACY_SKIN_FILES = [
  'desktop-pet-skin.png',
  'desktop-pet-skin.png.tmp',
  'desktop-pet-skin.gif',
  'desktop-pet-skin.gif.tmp',
] as const

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

interface PetDragState {
  pointerX: number
  pointerY: number
  bounds: Rectangle
}

interface StoredPetSettings {
  version: 1
  manuallyHidden: boolean
  x?: number
  y?: number
  displayId?: number
  size: PetSize
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

export function parsePetWindowShape(value: unknown, size: PetSize = DEFAULT_PET_SIZE): Rectangle | undefined {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('pet shape must be a rectangle')
  const input = value as Record<string, unknown>
  const spec = PET_SIZE_SPECS[size]
  if (typeof input.x !== 'number' || !Number.isSafeInteger(input.x) || input.x < 0
    || typeof input.y !== 'number' || !Number.isSafeInteger(input.y) || input.y < 0
    || typeof input.width !== 'number' || !Number.isSafeInteger(input.width) || input.width <= 0
    || typeof input.height !== 'number' || !Number.isSafeInteger(input.height) || input.height <= 0
    || input.x + input.width > spec.windowWidth || input.y + input.height > spec.windowHeight) {
    throw new Error('pet shape is outside the window')
  }
  return { x: input.x, y: input.y, width: input.width, height: input.height }
}

function parseSettings(value: unknown): StoredPetSettings {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { version: 1, manuallyHidden: false, size: DEFAULT_PET_SIZE }
  }
  const input = value as Record<string, unknown>
  const x = finiteInteger(input.x)
  const y = finiteInteger(input.y)
  const displayId = finiteInteger(input.displayId)
  return {
    version: 1,
    manuallyHidden: input.manuallyHidden === true,
    size: parsePetSize(input.size),
    ...(x === undefined ? {} : { x }),
    ...(y === undefined ? {} : { y }),
    ...(displayId === undefined ? {} : { displayId }),
  }
}

export class PetWindowController {
  private readonly settingsPath: string
  private window: BrowserWindow | undefined
  private settings: StoredPetSettings = { version: 1, manuallyHidden: false, size: DEFAULT_PET_SIZE }
  private state: PetRendererState = { mode: 'unavailable', status: 'DSH 正在启动' }
  private mainVisible = true
  private rendererReady = false
  private hoverInteractive = false
  private dragState: PetDragState | undefined
  private bubbleShape: Rectangle | undefined
  private disposing = false
  private saveTimer: NodeJS.Timeout | undefined
  private stateTimer: NodeJS.Timeout | undefined
  private savePromise: Promise<void> = Promise.resolve()
  private crashTimes: number[] = []
  private readonly displayChanged = (): void => { this.reclamp() }

  constructor(private readonly options: PetWindowOptions) {
    this.settingsPath = join(options.userData, 'desktop-pet.json')
  }

  async start(): Promise<void> {
    this.settings = await this.readSettings()
    await Promise.all(LEGACY_SKIN_FILES.map(file => rm(join(this.options.userData, file), { force: true })))
      .catch(error => { this.options.onFatal(error) })
    this.createWindow()
    screen.on('display-added', this.displayChanged)
    screen.on('display-removed', this.displayChanged)
    screen.on('display-metrics-changed', this.displayChanged)
  }

  get enabled(): boolean { return !this.settings.manuallyHidden }
  get size(): PetSize { return this.settings.size }
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

  async setSize(size: PetSize): Promise<void> {
    if (size === this.settings.size) return
    const previous = PET_SIZE_SPECS[this.settings.size]
    const next = PET_SIZE_SPECS[size]
    this.settings = { ...this.settings, size }
    const window = this.window
    if (window !== undefined && !window.isDestroyed()) {
      const bounds = window.getBounds()
      const centerX = bounds.x + previous.mascotX + previous.mascotSize / 2
      const centerY = bounds.y + previous.mascotY + previous.mascotSize / 2
      const candidate = {
        x: Math.round(centerX - next.mascotX - next.mascotSize / 2),
        y: Math.round(centerY - next.mascotY - next.mascotSize / 2),
        width: next.windowWidth,
        height: next.windowHeight,
      }
      const display = screen.getDisplayMatching(bounds)
      window.setBounds(clampPetBounds(candidate, display.workArea), false)
      this.applyWindowShape()
      this.sendSize()
      await this.captureAndSave()
      return
    }
    await this.save()
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

  setBubbleShape(shape: Rectangle | undefined): void {
    this.bubbleShape = shape
    this.applyWindowShape()
  }

  startDrag(point: { x: number; y: number }): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || !window.isVisible()) return
    this.dragState = { pointerX: point.x, pointerY: point.y, bounds: window.getBounds() }
    this.applyMousePolicy()
  }

  dragTo(point: { x: number; y: number }): void {
    const window = this.window
    const drag = this.dragState
    if (window === undefined || window.isDestroyed() || drag === undefined) return
    const spec = PET_SIZE_SPECS[this.settings.size]
    const candidate = {
      x: Math.round(drag.bounds.x + point.x - drag.pointerX),
      y: Math.round(drag.bounds.y + point.y - drag.pointerY),
      width: spec.windowWidth,
      height: spec.windowHeight,
    }
    const display = screen.getDisplayNearestPoint({ x: point.x, y: point.y })
    window.setBounds(clampPetBounds(candidate, display.workArea), false)
  }

  endDrag(): void {
    if (this.dragState === undefined) return
    this.dragState = undefined
    this.scheduleSave()
    this.applyMousePolicy()
  }

  rendererDidLoad(): void {
    this.rendererReady = true
    this.clearStateTimer()
    this.sendSize()
    this.sendState()
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
    this.dragState = undefined
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
    this.applyWindowShape()
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
    this.dragState = undefined
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
    const spec = PET_SIZE_SPECS[this.settings.size]
    const windowSize = { width: spec.windowWidth, height: spec.windowHeight }
    const fallback = defaultPetBounds(display.workArea, windowSize, EDGE_GAP)
    const candidate = this.settings.x === undefined || this.settings.y === undefined
      ? fallback
      : { x: this.settings.x, y: this.settings.y, ...windowSize }
    return clampPetBounds(candidate, display.workArea)
  }

  private reclamp(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    const bounds = window.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const spec = PET_SIZE_SPECS[this.settings.size]
    const next = clampPetBounds({ ...bounds, width: spec.windowWidth, height: spec.windowHeight }, display.workArea)
    if (next.x !== bounds.x || next.y !== bounds.y || next.width !== bounds.width || next.height !== bounds.height) {
      window.setBounds(next, false)
    }
    this.scheduleSave()
  }

  private reconcileVisibility(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || !this.rendererReady) return
    if (!this.mainVisible && !this.settings.manuallyHidden) {
      this.applyMousePolicy()
      window.showInactive()
      this.sendVisibility(true)
    } else {
      this.dragState = undefined
      this.hoverInteractive = false
      this.applyMousePolicy()
      this.sendVisibility(false)
      window.hide()
    }
  }

  private sendVisibility(visible: boolean): void {
    if (this.rendererReady && this.window !== undefined && !this.window.isDestroyed()) {
      this.window.webContents.send('pet:visibility', visible)
    }
  }

  private clearStateTimer(): void {
    if (this.stateTimer !== undefined) { clearTimeout(this.stateTimer); this.stateTimer = undefined }
  }

  private sendState(): void {
    if (this.rendererReady && this.window !== undefined && !this.window.isDestroyed()) this.window.webContents.send('pet:state', this.state)
  }

  private sendSize(): void {
    if (this.rendererReady && this.window !== undefined && !this.window.isDestroyed()) {
      this.window.webContents.send('pet:size', this.settings.size)
    }
  }

  private applyWindowShape(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || (process.platform !== 'win32' && process.platform !== 'linux')) return
    const spec = PET_SIZE_SPECS[this.settings.size]
    const mascotShape = {
      x: spec.mascotX,
      y: spec.mascotY,
      width: spec.mascotSize,
      height: spec.mascotSize,
    }
    window.setShape(this.bubbleShape === undefined ? [mascotShape] : [mascotShape, this.bubbleShape])
  }

  private applyMousePolicy(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed()) return
    if (process.platform === 'win32' || process.platform === 'linux') {
      window.setIgnoreMouseEvents(false)
      return
    }
    const forced = this.state.approval !== undefined || (this.state.reply?.length ?? 0) > 0 || (this.state.status?.length ?? 0) > 0
    window.setIgnoreMouseEvents(!(forced || this.hoverInteractive || this.dragState !== undefined), { forward: true })
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
    catch { return { version: 1, manuallyHidden: false, size: DEFAULT_PET_SIZE } }
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
