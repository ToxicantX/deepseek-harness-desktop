import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BrowserWindow, nativeImage, screen, type NativeImage, type Rectangle, type WebContents } from 'electron'
import { GifReader } from 'omggif'
import { clampPetBounds, defaultPetBounds } from './desktop-pet.ts'

const WIDTH = 360
const HEIGHT = 240
const EDGE_GAP = 16
const MASCOT_SHAPE: Rectangle = { x: 256, y: 136, width: 96, height: 96 }
const SAVE_DELAY_MS = 250
const STREAM_UPDATE_MS = 100
const MAX_SKIN_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_SKIN_SOURCE_DIMENSION = 4_096
const MAX_SKIN_RENDER_DIMENSION = 512
const MAX_SKIN_PNG_BYTES = 2 * 1024 * 1024
const MAX_ANIMATED_SKIN_BYTES = 2 * 1024 * 1024
const MAX_ANIMATED_SKIN_DIMENSION = 512
const MAX_ANIMATED_SKIN_FRAMES = 120
const MAX_ANIMATED_SKIN_FRAME_PIXELS = 16 * 1024 * 1024
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

interface PetSkinSource {
  dataUrl: string
  reducedMotionDataUrl?: string
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

function hasGifSignature(bytes: Buffer): boolean {
  if (bytes.byteLength < 6) return false
  const signature = bytes.subarray(0, 6).toString('ascii')
  return signature === 'GIF87a' || signature === 'GIF89a'
}

function countGifFramesBounded(bytes: Buffer): number {
  if (!hasGifSignature(bytes) || bytes.byteLength < 13) throw new Error('所选文件不是有效的动态 GIF')
  let offset = 13
  const logicalPacked = bytes[10]
  if (logicalPacked === undefined) throw new Error('所选文件不是有效的动态 GIF')
  if ((logicalPacked & 0x80) !== 0) offset += 3 * (1 << ((logicalPacked & 0x07) + 1))
  const skipSubBlocks = (): void => {
    while (offset < bytes.byteLength) {
      const size = bytes[offset]
      if (size === undefined) throw new Error('所选文件不是有效的动态 GIF')
      offset += 1
      if (size === 0) return
      if (offset + size > bytes.byteLength) throw new Error('所选文件不是有效的动态 GIF')
      offset += size
    }
    throw new Error('所选文件不是有效的动态 GIF')
  }
  let frameCount = 0
  while (offset < bytes.byteLength) {
    const marker = bytes[offset]
    offset += 1
    if (marker === 0x3b) return frameCount
    if (marker === 0x21) {
      if (offset >= bytes.byteLength) throw new Error('所选文件不是有效的动态 GIF')
      offset += 1
      skipSubBlocks()
      continue
    }
    if (marker !== 0x2c || offset + 9 > bytes.byteLength) throw new Error('所选文件不是有效的动态 GIF')
    frameCount += 1
    if (frameCount > MAX_ANIMATED_SKIN_FRAMES) throw new Error('动态 GIF 不能超过 120 帧')
    const imagePacked = bytes[offset + 8]
    if (imagePacked === undefined) throw new Error('所选文件不是有效的动态 GIF')
    offset += 9
    if ((imagePacked & 0x80) !== 0) offset += 3 * (1 << ((imagePacked & 0x07) + 1))
    if (offset >= bytes.byteLength) throw new Error('所选文件不是有效的动态 GIF')
    offset += 1
    skipSubBlocks()
  }
  throw new Error('所选文件不是有效的动态 GIF')
}

function animatedGifSkin(bytes: Buffer): PetSkinSource {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_ANIMATED_SKIN_BYTES) {
    throw new Error('动态 GIF 皮肤不能超过 2 MB')
  }
  const scannedFrameCount = countGifFramesBounded(bytes)
  if (scannedFrameCount < 2) throw new Error('动态 GIF 至少需要 2 帧')
  let reader: GifReader
  try { reader = new GifReader(bytes) }
  catch { throw new Error('所选文件不是有效的动态 GIF') }
  if (reader.width <= 0 || reader.height <= 0
    || reader.width > MAX_ANIMATED_SKIN_DIMENSION || reader.height > MAX_ANIMATED_SKIN_DIMENSION) {
    throw new Error('动态 GIF 画布尺寸必须在 1 到 512 像素之间')
  }
  const frameCount = reader.numFrames()
  if (frameCount !== scannedFrameCount) throw new Error('动态 GIF 帧元数据不一致')
  let framePixels = 0
  for (let index = 0; index < frameCount; index += 1) {
    const frame = reader.frameInfo(index)
    if (frame.width <= 0 || frame.height <= 0 || frame.x < 0 || frame.y < 0
      || frame.x + frame.width > reader.width || frame.y + frame.height > reader.height) {
      throw new Error('动态 GIF 包含无效帧区域')
    }
    framePixels += frame.width * frame.height
    if (framePixels > MAX_ANIMATED_SKIN_FRAME_PIXELS) throw new Error('动态 GIF 的总帧像素过大')
  }
  const firstFrame = Buffer.alloc(reader.width * reader.height * 4)
  try { reader.decodeAndBlitFrameBGRA(0, firstFrame) }
  catch { throw new Error('无法解码动态 GIF 首帧') }
  const poster = normalizedSkin(nativeImage.createFromBitmap(firstFrame, {
    width: reader.width,
    height: reader.height,
    scaleFactor: 1,
  }))
  const dataUrl = 'data:image/gif;base64,' + bytes.toString('base64')
  if (dataUrl.length > MAX_SKIN_DATA_URL_LENGTH) throw new Error('动态 GIF 皮肤编码后过大')
  return { dataUrl, reducedMotionDataUrl: poster.dataUrl }
}

export function parsePetWindowShape(value: unknown): Rectangle | undefined {
  if (value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('pet shape must be a rectangle')
  const input = value as Record<string, unknown>
  if (typeof input.x !== 'number' || !Number.isSafeInteger(input.x) || input.x < 0
    || typeof input.y !== 'number' || !Number.isSafeInteger(input.y) || input.y < 0
    || typeof input.width !== 'number' || !Number.isSafeInteger(input.width) || input.width <= 0
    || typeof input.height !== 'number' || !Number.isSafeInteger(input.height) || input.height <= 0
    || input.x + input.width > WIDTH || input.y + input.height > HEIGHT) throw new Error('pet shape is outside the window')
  return { x: input.x, y: input.y, width: input.width, height: input.height }
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
  private readonly animatedSkinPath: string
  private window: BrowserWindow | undefined
  private settings: StoredPetSettings = { version: 1, manuallyHidden: false }
  private skin: PetSkinSource | undefined
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
  private skinMutationPromise: Promise<void> = Promise.resolve()
  private crashTimes: number[] = []
  private readonly displayChanged = (): void => { this.reclamp() }

  constructor(private readonly options: PetWindowOptions) {
    this.settingsPath = join(options.userData, 'desktop-pet.json')
    this.skinPath = join(options.userData, 'desktop-pet-skin.png')
    this.animatedSkinPath = join(options.userData, 'desktop-pet-skin.gif')
  }

  async start(): Promise<void> {
    this.settings = await this.readSettings()
    this.skin = await this.readSkin()
    this.createWindow()
    screen.on('display-added', this.displayChanged)
    screen.on('display-removed', this.displayChanged)
    screen.on('display-metrics-changed', this.displayChanged)
  }

  get enabled(): boolean { return !this.settings.manuallyHidden }
  get customSkinConfigured(): boolean { return this.skin !== undefined }
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

  setCustomSkin(sourcePath: string): Promise<void> {
    return this.mutateSkin(async () => {
      const source = await stat(sourcePath)
      if (!source.isFile() || source.size <= 0 || source.size > MAX_SKIN_SOURCE_BYTES) {
        throw new Error('宠物皮肤文件必须是不超过 8 MB 的本地文件')
      }
      const bytes = await readFile(sourcePath)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKIN_SOURCE_BYTES) {
        throw new Error('宠物皮肤文件必须是不超过 8 MB 的本地文件')
      }
      if (hasGifSignature(bytes)) {
        const skin = animatedGifSkin(bytes)
        await this.persistSkin(this.animatedSkinPath, bytes, this.skinPath)
        this.skin = skin
      } else {
        const skin = normalizedSkin(nativeImage.createFromBuffer(bytes))
        await this.persistSkin(this.skinPath, skin.png, this.animatedSkinPath)
        this.skin = { dataUrl: skin.dataUrl }
      }
      this.sendSkin()
    })
  }

  resetCustomSkin(): Promise<void> {
    return this.mutateSkin(async () => {
      await Promise.all([rm(this.skinPath, { force: true }), rm(this.animatedSkinPath, { force: true })])
      this.skin = undefined
      this.sendSkin()
    })
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
    const candidate = {
      x: Math.round(drag.bounds.x + point.x - drag.pointerX),
      y: Math.round(drag.bounds.y + point.y - drag.pointerY),
      width: WIDTH,
      height: HEIGHT,
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
    await this.skinMutationPromise
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

  private sendSkin(): void {
    if (this.rendererReady && this.window !== undefined && !this.window.isDestroyed()) {
      this.window.webContents.send('pet:skin', {
        dataUrl: this.skin?.dataUrl ?? null,
        reducedMotionDataUrl: this.skin?.reducedMotionDataUrl ?? null,
      })
    }
  }

  private applyWindowShape(): void {
    const window = this.window
    if (window === undefined || window.isDestroyed() || (process.platform !== 'win32' && process.platform !== 'linux')) return
    window.setShape(this.bubbleShape === undefined ? [MASCOT_SHAPE] : [MASCOT_SHAPE, this.bubbleShape])
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
    catch { return { version: 1, manuallyHidden: false } }
  }

  private mutateSkin(operation: () => Promise<void>): Promise<void> {
    const result = this.skinMutationPromise.then(async () => {
      if (this.disposing) throw new Error('桌面宠物正在关闭，无法修改皮肤')
      await operation()
    })
    this.skinMutationPromise = result.catch(() => undefined)
    return result
  }

  private async persistSkin(target: string, content: Buffer, stale: string): Promise<void> {
    const temporary = target + '.tmp'
    try {
      await writeFile(temporary, content)
      await rename(temporary, target)
      try { await rm(stale, { force: true }) }
      catch (error: unknown) {
        await rm(target, { force: true }).catch(() => undefined)
        throw error
      }
    } catch (error: unknown) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async readSkin(): Promise<PetSkinSource | undefined> {
    try {
      const source = await stat(this.animatedSkinPath)
      if (source.isFile() && source.size > 0 && source.size <= MAX_ANIMATED_SKIN_BYTES) {
        const bytes = await readFile(this.animatedSkinPath)
        if (hasGifSignature(bytes)) return animatedGifSkin(bytes)
      }
    } catch {
      // Invalid animated skins fall back to a persisted static skin or the default icon.
    }
    try {
      const source = await stat(this.skinPath)
      if (!source.isFile() || source.size <= 0 || source.size > MAX_SKIN_PNG_BYTES) return undefined
      const bytes = await readFile(this.skinPath)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKIN_PNG_BYTES) return undefined
      return { dataUrl: normalizedSkin(nativeImage.createFromBuffer(bytes)).dataUrl }
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
