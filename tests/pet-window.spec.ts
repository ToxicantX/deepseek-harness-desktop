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
  const nativeImage = { createFromPath: vi.fn(() => sourceImage) }

  return {
    BrowserWindow: FakeBrowserWindow,
    fs,
    nativeImage,
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

const { PetWindowController } = await import('../src/pet-window.ts')

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
    mocks.fs.stat.mockRejectedValue(new Error('skin missing'))
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

    controller.setMainVisible(false)
    expect(window.showInactive).toHaveBeenCalledOnce()
    expect(window.isVisible()).toBe(true)

    controller.setMainVisible(true)
    expect(window.hide).toHaveBeenCalled()
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
    mocks.nativeImage.createFromPath.mockImplementation(() => mocks.sourceImage)
  })

  afterEach(() => {
    mocks.screen.removeAllListeners()
    mocks.windows.splice(0)
    vi.useRealTimers()
  })

  it('normalizes, persists, publishes, and resets a selected skin', async () => {
    const { controller, window } = await startController()
    expect(controller.customSkinConfigured).toBe(false)
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: 1_024 })

    await controller.setCustomSkin('C:\\selected.webp')

    expect(mocks.nativeImage.createFromPath).toHaveBeenCalledWith('C:\\selected.webp')
    expect(mocks.sourceImage.resize).toHaveBeenCalledWith({ width: 512, height: 256, quality: 'best' })
    expect(mocks.fs.writeFile).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.png.tmp', Buffer.from('skin'))
    expect(mocks.fs.rename).toHaveBeenCalledWith(
      'C:\\user-data\\desktop-pet-skin.png.tmp',
      'C:\\user-data\\desktop-pet-skin.png',
    )
    expect(controller.customSkinConfigured).toBe(true)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:skin', { dataUrl: 'data:image/png;base64,c2tpbg==' })

    await controller.resetCustomSkin()
    expect(mocks.fs.rm).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.png', { force: true })
    expect(controller.customSkinConfigured).toBe(false)
    expect(window.webContents.send).toHaveBeenLastCalledWith('pet:skin', { dataUrl: null })
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
    mocks.sourceImage.getSize.mockReturnValueOnce({ width: 4_097, height: 512 })

    await expect(controller.setCustomSkin('C:\\too-wide.png')).rejects.toThrow('4096')
    expect(mocks.fs.writeFile).not.toHaveBeenCalled()
    expect(controller.customSkinConfigured).toBe(false)
  })

  it('restores a valid persisted skin when the controller starts', async () => {
    mocks.fs.stat.mockResolvedValue({ isFile: () => true, size: 1_024 })
    const { controller, window } = await startController()

    expect(controller.customSkinConfigured).toBe(true)
    expect(mocks.nativeImage.createFromPath).toHaveBeenCalledWith('C:\\user-data\\desktop-pet-skin.png')
    expect(window.webContents.send).toHaveBeenCalledWith('pet:skin', { dataUrl: 'data:image/png;base64,c2tpbg==' })
  })
})
