import { GifWriter } from 'omggif'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { PetRendererState } from '../src/pet-window.ts'

type Listener = (...args: unknown[]) => void
type Bounds = { x: number; y: number; width: number; height: number }

const mocks = vi.hoisted(() => {
  class MiniEmitter {
    private readonly listeners = new Map<string, Set<Listener>>()

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? new Set<Listener>()
      listeners.add(listener)
      this.listeners.set(event, listeners)
      return this
    }

    off(event: string, listener: Listener): this {
      this.listeners.get(event)?.delete(listener)
      return this
    }

    emit(event: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(event)
      if (listeners === undefined) return false
      for (const listener of listeners) listener(...args)
      return listeners.size > 0
    }

    removeAllListeners(event?: string): this {
      if (event === undefined) this.listeners.clear()
      else this.listeners.delete(event)
      return this
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.size ?? 0
    }
  }

  const primaryDisplay = { id: 1, workArea: { x: 0, y: 0, width: 1_920, height: 1_080 } }
  const screen = Object.assign(new MiniEmitter(), {
    getAllDisplays: vi.fn(() => [primaryDisplay]),
    getPrimaryDisplay: vi.fn(() => primaryDisplay),
    getDisplayMatching: vi.fn(() => primaryDisplay),
    getDisplayNearestPoint: vi.fn(() => primaryDisplay),
  })

  class FakeWebContents extends MiniEmitter {
    readonly send = vi.fn()
    readonly setWindowOpenHandler = vi.fn()
    readonly getURL = vi.fn(() => 'file:///pet.html')
  }

  const windows: FakeBrowserWindow[] = []

  class FakeBrowserWindow extends MiniEmitter {
    readonly webContents = new FakeWebContents()
    readonly setAlwaysOnTop = vi.fn()
    readonly setMenu = vi.fn()
    readonly showInactive = vi.fn(() => { this.visible = true })
    readonly hide = vi.fn(() => { this.visible = false })
    readonly loadFile = vi.fn(async (_page: string) => undefined)
    readonly setIgnoreMouseEvents = vi.fn()
    readonly setShape = vi.fn()
    readonly getBounds = vi.fn(() => ({ ...this.bounds }))
    readonly setBounds = vi.fn((next: Bounds) => { this.bounds = { ...next } })
    readonly isVisible = vi.fn(() => this.visible)
    readonly isDestroyed = vi.fn(() => this.destroyed)
    readonly destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
    visible = false
    destroyed = false
    bounds: Bounds = { x: 100, y: 100, width: 360, height: 240 }

    constructor(readonly options: unknown) {
      super()
      windows.push(this)
    }
  }

  const fs = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
    stat: vi.fn(),
  }
  const renderedSkin = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 512, height: 256 })),
    resize: vi.fn(),
    toPNG: vi.fn(() => Buffer.from('skin')),
    toDataURL: vi.fn(() => 'data:image/png;base64,c2tpbg=='),
  }
  const sourceImage = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 1_024, height: 512 })),
    resize: vi.fn(() => renderedSkin),
    toPNG: vi.fn(() => Buffer.from('skin')),
    toDataURL: vi.fn(() => 'data:image/png;base64,c2tpbg=='),
  }
  const posterImage = {
    isEmpty: vi.fn(() => false),
    getSize: vi.fn(() => ({ width: 2, height: 2 })),
    resize: vi.fn(),
    toPNG: vi.fn(() => Buffer.from('poster')),
    toDataURL: vi.fn(() => 'data:image/png;base64,cG9zdGVy'),
  }
  const nativeImage = {
    createFromPath: vi.fn(() => sourceImage),
    createFromBuffer: vi.fn(() => sourceImage),
    createFromBitmap: vi.fn(() => posterImage),
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    fs,
    nativeImage,
    posterImage,
    renderedSkin,
    sourceImage,
    screen,
    windows,
  }
})

vi.mock('electron', () => ({
  BrowserWindow: mocks.BrowserWindow,
  nativeImage: mocks.nativeImage,
  screen: mocks.screen,
}))
vi.mock('node:fs/promises', () => mocks.fs)

const { parsePetWindowShape, PetWindowController } = await import('../src/pet-window.ts')

function makeState(mode: PetRendererState['mode'], reply?: string): PetRendererState {
  return reply === undefined ? { mode } : { mode, reply }
}

function animatedGif(frameCount = 2, width = 2, height = 2): Buffer {
  const output = Buffer.alloc(Math.max(1_024, frameCount * 64 + width * height * 2))
  const writer = new GifWriter(output, width, height, { loop: 0, palette: [0x000000, 0xffffff] })
  for (let index = 0; index < frameCount; index += 1) {
    writer.addFrame(0, 0, width, height, Array<number>(width * height).fill(index % 2), { delay: 10 })
  }
  return output.subarray(0, writer.end())
}

async function startController(): Promise<{ controller: InstanceType<typeof PetWindowController>; window: (typeof mocks.windows)[number] }> {
  const controller = new PetWindowController({
    page: 'C:\\pet.html',
    preload: 'C:\\pet-preload.cjs',
    icon: 'C:\\icon.png',
    userData: 'C:\\user-data',
    onFatal: vi.fn(),
  })
  await controller.start()
  const window = mocks.windows[0]
  if (window === undefined) throw new Error('fake pet window was not created')
  controller.rendererDidLoad()
  return { controller, window }
}

describe('parsePetWindowShape', () => {
  it('accepts null and bounded pet rectangles', () => {
    expect(parsePetWindowShape(null)).toBeUndefined()
    expect(parsePetWindowShape({ x: 8, y: 8, width: 248, height: 204 })).toEqual({ x: 8, y: 8, width: 248, height: 204 })
    expect(parsePetWindowShape({ x: 359, y: 239, width: 1, height: 1 })).toEqual({ x: 359, y: 239, width: 1, height: 1 })
  })

  it.each([
    undefined,
    [],
    { x: -1, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 359, y: 0, width: 2, height: 1 },
    { x: 0, y: 239, width: 1, height: 2 },
    { x: Number.NaN, y: 0, width: 1, height: 1 },
  ])('rejects invalid or out-of-window geometry: %j', value => {
    expect(() => parsePetWindowShape(value)).toThrow()
  })
})

describe('PetWindowController state delivery', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.windows.splice(0)
    mocks.screen.removeAllListeners()
    mocks.fs.readFile.mockRejectedValue(new Error('settings missing'))
    mocks.fs.writeFile.mockResolvedValue(undefined)
    mocks.fs.rename.mockResolvedValue(undefined)
    mocks.fs.rm.mockResolvedValue(undefined)
    mocks.fs.stat.mockRejectedValue(new Error('skin missing'))
    mocks.sourceImage.getSize.mockImplementation(() => ({ width: 1_024, height: 512 }))
    mocks.posterImage.getSize.mockImplementation(() => ({ width: 2, height: 2 }))
    mocks.nativeImage.createFromPath.mockImplementation(() => mocks.sourceImage)
    mocks.nativeImage.createFromBuffer.mockImplementation(() => mocks.sourceImage)
    mocks.nativeImage.createFromBitmap.mockImplementation(() => mocks.posterImage)
  })

  afterEach(() => {
    mocks.screen.removeAllListeners()
    mocks.windows.splice(0)
    vi.useRealTimers()
  })

  it('coalesces speaking updates and sends only the latest state at 100ms', async () => {
    const { controller, window } = await startController()
    const initialSends = window.webContents.send.mock.calls.length

    controller.setState(makeState('speaking', 'first'))
    controller.setState(makeState('speaking', 'latest'))
    expect(window.webContents.send).toHaveBeenCalledTimes(initialSends)

    vi.advanceTimersByTime(99)
    expect(window.webContents.send).toHaveBeenCalledTimes(initialSends)

    vi.advanceTimersByTime(1)
    expect(window.webContents.send).toHaveBeenCalledTimes(initialSends + 1)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:state', makeState('speaking', 'latest'))
  })

  it('flushes a final state immediately and cancels the pending speaking timer', async () => {
    const { controller, window } = await startController()
    const initialSends = window.webContents.send.mock.calls.length

    controller.setState(makeState('speaking', 'partial'))
    controller.setState(makeState('success', 'final'))
    expect(window.webContents.send).toHaveBeenCalledTimes(initialSends + 1)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:state', makeState('success', 'final'))

    vi.advanceTimersByTime(100)
    expect(window.webContents.send).toHaveBeenCalledTimes(initialSends + 1)
  })
})

describe('PetWindowController visibility and disposal', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.windows.splice(0)
    mocks.screen.removeAllListeners()
    mocks.fs.readFile.mockRejectedValue(new Error('settings missing'))
    mocks.fs.writeFile.mockResolvedValue(undefined)
    mocks.fs.rename.mockResolvedValue(undefined)
    mocks.fs.rm.mockResolvedValue(undefined)
    mocks.fs.stat.mockRejectedValue(new Error('skin missing'))
    mocks.sourceImage.getSize.mockImplementation(() => ({ width: 1_024, height: 512 }))
    mocks.posterImage.getSize.mockImplementation(() => ({ width: 2, height: 2 }))
    mocks.nativeImage.createFromPath.mockImplementation(() => mocks.sourceImage)
    mocks.nativeImage.createFromBuffer.mockImplementation(() => mocks.sourceImage)
    mocks.nativeImage.createFromBitmap.mockImplementation(() => mocks.posterImage)
  })

  afterEach(() => {
    mocks.screen.removeAllListeners()
    mocks.windows.splice(0)
    vi.useRealTimers()
  })

  it('hides while the main window is visible, shows when hidden and enabled, and respects manual disable', async () => {
    const { controller, window } = await startController()
    expect(window.hide).toHaveBeenCalled()
    expect(window.isVisible()).toBe(false)
    expect(window.webContents.send).toHaveBeenCalledWith('pet:visibility', false)

    controller.setMainVisible(false)
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.webContents.send).toHaveBeenCalledWith('pet:visibility', true)
    expect(window.isVisible()).toBe(true)

    controller.setMainVisible(true)
    expect(window.hide).toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:visibility', false)
    expect(window.isVisible()).toBe(false)

    controller.setMainVisible(false)
    await controller.setEnabled(false)
    expect(controller.enabled).toBe(false)
    expect(window.hide).toHaveBeenCalled()
    expect(window.isVisible()).toBe(false)

    await controller.setEnabled(true)
    expect(controller.enabled).toBe(true)
    expect(window.showInactive).toHaveBeenCalledTimes(3)
    expect(window.isVisible()).toBe(true)
  })

  it('keeps transparent areas click-through and supports bounded interactive dragging', async () => {
    const { controller, window } = await startController()
    controller.setMainVisible(false)
    controller.setState(makeState('idle'))
    expect(window.setShape).toHaveBeenCalledWith([{ x: 256, y: 136, width: 96, height: 96 }])
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)

    controller.setBubbleShape({ x: 8, y: 8, width: 240, height: 80 })
    expect(window.setShape).toHaveBeenLastCalledWith([
      { x: 256, y: 136, width: 96, height: 96 },
      { x: 8, y: 8, width: 240, height: 80 },
    ])
    controller.setInteraction(true)
    controller.setInteraction(false)
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)

    controller.startDrag({ x: 500, y: 500 })
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    controller.dragTo({ x: 650, y: 620 })
    expect(mocks.screen.getDisplayNearestPoint).toHaveBeenCalledWith({ x: 650, y: 620 })
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 250, y: 220, width: 360, height: 240 }, false)

    controller.endDrag()
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false)
    await vi.advanceTimersByTimeAsync(250)
    expect(mocks.fs.writeFile).toHaveBeenLastCalledWith(
      'C:\\user-data\\desktop-pet.json.tmp',
      JSON.stringify({ version: 1, manuallyHidden: false, x: 250, y: 220, displayId: 1 }) + '\n',
      'utf8',
    )
  })

  it('moves across a negative-coordinate display and clamps to its work area', async () => {
    const { controller, window } = await startController()
    const leftDisplay = { id: 2, workArea: { x: -1_280, y: 0, width: 1_280, height: 1_024 } }
    mocks.screen.getDisplayNearestPoint.mockReturnValueOnce(leftDisplay)
    controller.setMainVisible(false)
    controller.startDrag({ x: 500, y: 500 })
    controller.dragTo({ x: -100, y: 400 })

    expect(window.setBounds).toHaveBeenLastCalledWith({ x: -500, y: 0, width: 360, height: 240 }, false)
  })

  it('cancels an active drag when the main window shows and ignores later moves', async () => {
    const { controller, window } = await startController()
    controller.setMainVisible(false)
    controller.startDrag({ x: 500, y: 500 })
    controller.setMainVisible(true)

    controller.dragTo({ x: 650, y: 620 })
    expect(window.setBounds).not.toHaveBeenCalled()
    expect(window.isVisible()).toBe(false)
  })

  it('clears state/save timers and display listeners during dispose', async () => {
    const { controller, window } = await startController()
    controller.setState(makeState('speaking', 'pending'))
    window.emit('move')
    expect(mocks.screen.listenerCount('display-added')).toBe(1)
    expect(mocks.screen.listenerCount('display-removed')).toBe(1)
    expect(mocks.screen.listenerCount('display-metrics-changed')).toBe(1)

    await controller.dispose()
    const writesAfterDispose = mocks.fs.writeFile.mock.calls.length
    const sendsAfterDispose = window.webContents.send.mock.calls.length
    expect(window.destroy).toHaveBeenCalledOnce()
    expect(mocks.screen.listenerCount('display-added')).toBe(0)
    expect(mocks.screen.listenerCount('display-removed')).toBe(0)
    expect(mocks.screen.listenerCount('display-metrics-changed')).toBe(0)

    vi.advanceTimersByTime(500)
    expect(mocks.fs.writeFile).toHaveBeenCalledTimes(writesAfterDispose)
    expect(window.webContents.send).toHaveBeenCalledTimes(sendsAfterDispose)
  })
})

describe('PetWindowController custom skin', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    mocks.windows.splice(0)
    mocks.screen.removeAllListeners()
    mocks.fs.readFile.mockRejectedValue(new Error('settings missing'))
    mocks.fs.writeFile.mockResolvedValue(undefined)
    mocks.fs.rename.mockResolvedValue(undefined)
    mocks.fs.rm.mockResolvedValue(undefined)
    mocks.fs.stat.mockRejectedValue(new Error('skin missing'))
    mocks.sourceImage.getSize.mockImplementation(() => ({ width: 1_024, height: 512 }))
    mocks.posterImage.getSize.mockImplementation(() => ({ width: 2, height: 2 }))
    mocks.nativeImage.createFromPath.mockImplementation(() => mocks.sourceImage)
    mocks.nativeImage.createFromBuffer.mockImplementation(() => mocks.sourceImage)
    mocks.nativeImage.createFromBitmap.mockImplementation(() => mocks.posterImage)
  })

  afterEach(() => {
    mocks.screen.removeAllListeners()
    mocks.windows.splice(0)
    vi.useRealTimers()
  })

  it('normalizes, persists, publishes, and resets a selected static skin', async () => {
    const { controller, window } = await startController()
    expect(controller.customSkinConfigured).toBe(false)
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: 1_024 })
    mocks.fs.readFile.mockResolvedValue(Buffer.from('static image'))

    await controller.setCustomSkin('C:\\selected.webp')

    expect(mocks.nativeImage.createFromBuffer).toHaveBeenCalledWith(Buffer.from('static image'))
    expect(mocks.sourceImage.resize).toHaveBeenCalledWith({ width: 512, height: 256, quality: 'best' })
    expect(mocks.fs.writeFile).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.png.tmp', Buffer.from('skin'))
    expect(mocks.fs.rename).toHaveBeenCalledWith(
      'C:\\user-data\\desktop-pet-skin.png.tmp',
      'C:\\user-data\\desktop-pet-skin.png',
    )
    expect(controller.customSkinConfigured).toBe(true)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:skin', {
      dataUrl: 'data:image/png;base64,c2tpbg==',
      reducedMotionDataUrl: null,
    })

    await controller.resetCustomSkin()
    expect(mocks.fs.rm).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.png', { force: true })
    expect(mocks.fs.rm).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.gif', { force: true })
    expect(controller.customSkinConfigured).toBe(false)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:skin', { dataUrl: null, reducedMotionDataUrl: null })
  })

  it('rejects oversized source files without replacing the current skin', async () => {
    const { controller } = await startController()
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: 8 * 1024 * 1024 + 1 })

    await expect(controller.setCustomSkin('C:\\oversized.png')).rejects.toThrow('8 MB')
    expect(mocks.fs.writeFile).not.toHaveBeenCalled()
    expect(controller.customSkinConfigured).toBe(false)
  })

  it('rejects source images beyond the decoded dimension limit', async () => {
    const { controller } = await startController()
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: 1_024 })
    mocks.fs.readFile.mockResolvedValue(Buffer.from('static image'))
    mocks.sourceImage.getSize.mockReturnValueOnce({ width: 4_097, height: 512 })

    await expect(controller.setCustomSkin('C:\\too-wide.png')).rejects.toThrow('4096')
    expect(mocks.fs.writeFile).not.toHaveBeenCalled()
    expect(controller.customSkinConfigured).toBe(false)
  })

  it('preserves, persists, and publishes a validated animated GIF with a reduced-motion poster', async () => {
    const gif = animatedGif()
    const { controller, window } = await startController()
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: gif.byteLength })
    mocks.fs.readFile.mockResolvedValue(gif)

    await controller.setCustomSkin('C:\\animated.gif')

    expect(mocks.nativeImage.createFromBitmap).toHaveBeenCalledWith(expect.any(Buffer), { width: 2, height: 2, scaleFactor: 1 })
    expect(mocks.fs.writeFile).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.gif.tmp', gif)
    expect(mocks.fs.rename).toHaveBeenCalledWith(
      'C:\\user-data\\desktop-pet-skin.gif.tmp',
      'C:\\user-data\\desktop-pet-skin.gif',
    )
    expect(mocks.fs.rm).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.png', { force: true })
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:skin', {
      dataUrl: 'data:image/gif;base64,' + gif.toString('base64'),
      reducedMotionDataUrl: 'data:image/png;base64,cG9zdGVy',
    })
  })

  it.each([
    ['single-frame GIF', animatedGif(1), '至少需要 2 帧'],
    ['too many GIF frames', animatedGif(121), '不能超过 120 帧'],
    ['oversized GIF canvas', animatedGif(2, 513, 1), '1 到 512'],
    ['damaged GIF', Buffer.from('GIF89a-broken'), '动态 GIF'],
  ])('rejects %s before replacing the current skin', async (_case, gif, error) => {
    const { controller, window } = await startController()
    const sends = window.webContents.send.mock.calls.length
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: gif.byteLength })
    mocks.fs.readFile.mockResolvedValue(gif)

    await expect(controller.setCustomSkin('C:\\invalid.gif')).rejects.toThrow(error)
    expect(mocks.fs.writeFile).not.toHaveBeenCalled()
    expect(controller.customSkinConfigured).toBe(false)
    expect(window.webContents.send).toHaveBeenCalledTimes(sends)
  })

  it('restores a persisted animated GIF before any stale static skin', async () => {
    const gif = animatedGif()
    mocks.fs.stat.mockImplementation(async (path: string) => {
      if (path.endsWith('desktop-pet-skin.gif')) return { isFile: () => true, size: gif.byteLength }
      throw new Error('missing')
    })
    mocks.fs.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('desktop-pet-skin.gif')) return gif
      throw new Error('settings missing')
    })

    const { controller, window } = await startController()

    expect(controller.customSkinConfigured).toBe(true)
    expect(window.webContents.send).toHaveBeenCalledWith('pet:skin', {
      dataUrl: 'data:image/gif;base64,' + gif.toString('base64'),
      reducedMotionDataUrl: 'data:image/png;base64,cG9zdGVy',
    })
  })

  it('serializes a reset behind an in-flight skin replacement', async () => {
    const { controller, window } = await startController()
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: 12 })
    mocks.fs.readFile.mockResolvedValue(Buffer.from('static image'))
    let releaseWrite!: () => void
    let markWriteStarted!: () => void
    const writeStarted = new Promise<void>(resolve => { markWriteStarted = resolve })
    mocks.fs.writeFile.mockImplementation(async (path: string) => {
      if (!path.endsWith('desktop-pet-skin.png.tmp')) return
      markWriteStarted()
      await new Promise<void>(resolve => { releaseWrite = resolve })
    })

    const selecting = controller.setCustomSkin('C:\\selected.png')
    await writeStarted
    let resetSettled = false
    const resetting = controller.resetCustomSkin().then(() => { resetSettled = true })
    await Promise.resolve()
    expect(resetSettled).toBe(false)

    releaseWrite()
    await selecting
    await resetting
    expect(controller.customSkinConfigured).toBe(false)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:skin', { dataUrl: null, reducedMotionDataUrl: null })
  })

  it('restores a valid persisted skin from the same bounded bytes', async () => {
    const persisted = Buffer.from('persisted static image')
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: persisted.byteLength })
    mocks.fs.readFile.mockImplementation(async (path: string) => {
      if (path.endsWith('desktop-pet-skin.png')) return persisted
      throw new Error('settings missing')
    })
    const { controller, window } = await startController()

    expect(controller.customSkinConfigured).toBe(true)
    expect(mocks.nativeImage.createFromBuffer).toHaveBeenCalledWith(persisted)
    expect(window.webContents.send).toHaveBeenCalledWith('pet:skin', {
      dataUrl: 'data:image/png;base64,c2tpbg==',
      reducedMotionDataUrl: null,
    })
  })
})
