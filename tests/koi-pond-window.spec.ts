import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const handles = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => handles.set(name, callback) },
  WebContentsView: class {
    visible = false
    bounds: unknown = {}
    webContents = Object.assign(new EventEmitter(), {
      destroyed: false, mainFrame: {}, url: '',
      isDestroyed() { return this.destroyed },
      getURL() { return this.url },
      loadFile: vi.fn(async (path: string) => { this.webContents.url = pathToFileURL(path).href }),
      executeJavaScript: vi.fn(async () => undefined),
      close() { this.destroyed = true },
      focus: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    })
    setVisible(value: boolean) { this.visible = value }
    setBounds(value: unknown) { this.bounds = value }
    setBackgroundColor() {}
  },
}))
import { KoiPondWindow } from '../src/koi-pond-window.ts'

let directory: string
let pond: KoiPondWindow
const makeOwner = () => Object.assign(new EventEmitter(), {
  destroyed: false,
  isDestroyed() { return this.destroyed },
  getContentBounds: () => ({ width: 900, height: 640 }),
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, focus: vi.fn() }),
})
let owner: ReturnType<typeof makeOwner>
const view = (): any => owner.contentView.addChildView.mock.calls.at(-1)?.[0]
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-pond-view-'))
  owner = makeOwner()
  pond = new KoiPondWindow(join(directory, 'pond.json'), join(directory, 'pond.html'), 'preload.cjs', vi.fn(), () => owner as unknown as BrowserWindow)
})
afterEach(async () => {
  await pond.stop()
  handles.clear()
  await rm(directory, { recursive: true, force: true })
})

it('reuses one embedded view and returns focus without unloading it', async () => {
  await Promise.all([pond.open(), pond.open()])
  const current = view()
  expect(owner.contentView.addChildView).toHaveBeenCalledTimes(1)
  expect(current.bounds).toEqual({ x: 0, y: 0, width: 900, height: 640 })
  expect(current.visible).toBe(true)
  expect(current.webContents.send).toHaveBeenCalledWith('pond:visibility', true)
  await pond.open()
  expect(current.visible).toBe(false)
  expect(current.webContents.send).toHaveBeenCalledWith('pond:visibility', false)
  expect(owner.webContents.focus).toHaveBeenCalled()
  await pond.open()
  expect(view()).toBe(current)
  expect(current.webContents.loadFile).toHaveBeenCalledTimes(1)
  owner.getContentBounds = () => ({ width: 640, height: 480 })
  owner.emit('resize')
  expect(current.bounds).toMatchObject({ width: 640, height: 480 })
})

it('supports return and rejects foreign frames or navigated pages', async () => {
  await pond.open()
  const current = view()
  const event = { sender: current.webContents, senderFrame: current.webContents.mainFrame }
  const close = handles.get('pond:close')!
  expect(() => close({ ...event, senderFrame: {} })).toThrow('来源不匹配')
  expect(() => close({ ...event, sender: owner.webContents })).toThrow('来源不匹配')
  const url = current.webContents.url
  current.webContents.url = 'https://example.com'
  expect(() => close(event)).toThrow('来源不匹配')
  current.webContents.url = url
  close(event)
  expect(current.visible).toBe(false)
})

it('hides for full main navigation only, and disposes on close before a new owner opens', async () => {
  await pond.open()
  const current = view()
  owner.webContents.emit('did-start-navigation', {}, 'url', true, true)
  owner.webContents.emit('did-start-navigation', {}, 'url', false, false)
  expect(current.visible).toBe(true)
  owner.webContents.emit('did-start-navigation', {}, 'url', false, true)
  expect(current.visible).toBe(false)
  await pond.open()
  const oldOwner = owner
  owner.destroyed = true
  owner.emit('closed')
  expect(current.webContents.isDestroyed()).toBe(true)
  expect(oldOwner.listenerCount('resize')).toBe(0)
  owner = makeOwner()
  await pond.open()
  expect(view()).not.toBe(current)
  expect(view().visible).toBe(true)
})

it('does not throw when Electron objects are already destroyed during cleanup', async () => {
  await pond.open()
  const current = view()
  owner.contentView.removeChildView.mockImplementation(() => { throw new TypeError('Object has been destroyed') })
  current.setVisible = () => { throw new TypeError('Object has been destroyed') }
  current.webContents.close = () => { throw new TypeError('Object has been destroyed') }
  owner.webContents.removeListener = () => { throw new TypeError('Object has been destroyed') }
  expect(() => owner.emit('closed')).not.toThrow()
  expect(current.webContents.isDestroyed()).toBe(false)
})

it('ignores repeated disposal calls', async () => {
  await pond.open()
  owner.emit('closed')
  expect(() => owner.emit('closed')).not.toThrow()
  await pond.stop()
})
