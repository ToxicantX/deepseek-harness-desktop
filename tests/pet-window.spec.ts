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
    bounds: Bounds

    constructor(readonly options: unknown) {
      super()
      const geometry = options as Partial<Bounds>
      this.bounds = { x: 100, y: 100, width: geometry.width ?? 360, height: geometry.height ?? 240 }
      windows.push(this)
    }
  }

  const fs = {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    rename: vi.fn(),
    rm: vi.fn(),
  }
  const sourceImage = {}
  const nativeImage = { createFromPath: vi.fn(() => sourceImage) }

  return {
    BrowserWindow: FakeBrowserWindow,
    fs,
    nativeImage,
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
    expect(parsePetWindowShape({ x: 335, y: 215, width: 1, height: 1 }, 'small')).toEqual({ x: 335, y: 215, width: 1, height: 1 })
    expect(parsePetWindowShape({ x: 391, y: 271, width: 1, height: 1 }, 'large')).toEqual({ x: 391, y: 271, width: 1, height: 1 })
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
    mocks.nativeImage.createFromPath.mockImplementation(() => mocks.sourceImage)
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
    mocks.nativeImage.createFromPath.mockImplementation(() => mocks.sourceImage)
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

  it('starts with standard size and removes obsolete local skin files', async () => {
    const { controller, window } = await startController()
    expect(controller.size).toBe('standard')
    expect(window.options).toEqual(expect.objectContaining({ width: 360, height: 240, resizable: false }))
    expect(window.webContents.send).toHaveBeenCalledWith('pet:size', 'standard')
    for (const file of [
      'desktop-pet-skin.png', 'desktop-pet-skin.png.tmp', 'desktop-pet-skin.gif', 'desktop-pet-skin.gif.tmp',
    ]) {
      expect(mocks.fs.rm).toHaveBeenCalledWith('C:\\user-data\\' + file, { force: true })
    }
  })

  it('migrates a malformed persisted size to standard geometry', async () => {
    mocks.fs.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1, manuallyHidden: false, size: 'gigantic', x: 40, y: 50, displayId: 1,
    }))
    const { controller, window } = await startController()
    expect(controller.size).toBe('standard')
    expect(window.options).toEqual(expect.objectContaining({ x: 40, y: 50, width: 360, height: 240 }))
    expect(window.webContents.send).toHaveBeenCalledWith('pet:size', 'standard')
  })

  it('restores a persisted large size before creating the native window', async () => {
    mocks.fs.readFile.mockResolvedValueOnce(JSON.stringify({
      version: 1, manuallyHidden: false, size: 'large', x: 40, y: 50, displayId: 1,
    }))
    const { controller, window } = await startController()
    expect(controller.size).toBe('large')
    expect(window.options).toEqual(expect.objectContaining({ x: 40, y: 50, width: 392, height: 272 }))
    expect(window.webContents.send).toHaveBeenCalledWith('pet:size', 'large')
    expect(window.setShape).toHaveBeenCalledWith([{ x: 256, y: 136, width: 128, height: 128 }])
  })

  it('resizes around the mascot center, updates shape, and persists the selected size', async () => {
    const { controller, window } = await startController()
    await controller.setSize('large')
    expect(controller.size).toBe('large')
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 84, y: 84, width: 392, height: 272 }, false)
    expect(window.setShape).toHaveBeenLastCalledWith([{ x: 256, y: 136, width: 128, height: 128 }])
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:size', 'large')
    expect(mocks.fs.writeFile).toHaveBeenLastCalledWith(
      'C:\\user-data\\desktop-pet.json.tmp',
      JSON.stringify({ version: 1, manuallyHidden: false, size: 'large', x: 84, y: 84, displayId: 1 }) + '\n',
      'utf8',
    )

    await controller.setSize('small')
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 112, y: 112, width: 336, height: 216 }, false)
    expect(window.setShape).toHaveBeenLastCalledWith([{ x: 256, y: 136, width: 72, height: 72 }])
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:size', 'small')

    controller.setMainVisible(false)
    controller.startDrag({ x: 500, y: 500 })
    controller.dragTo({ x: 600, y: 600 })
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 212, y: 212, width: 336, height: 216 }, false)
    controller.endDrag()

    window.bounds = { x: 1_800, y: 1_000, width: 1, height: 1 }
    mocks.screen.emit('display-metrics-changed')
    expect(window.setBounds).toHaveBeenLastCalledWith({ x: 1_584, y: 864, width: 336, height: 216 }, false)
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
      JSON.stringify({ version: 1, manuallyHidden: false, size: 'standard', x: 250, y: 220, displayId: 1 }) + '\n',
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
