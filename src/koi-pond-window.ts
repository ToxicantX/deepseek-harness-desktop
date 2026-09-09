import { BrowserWindow, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { KoiPondStore } from './koi-pond-store.ts'

/** Independent of Runtime and its database: errors here never gate session creation. */
export class KoiPondWindow {
  private window: BrowserWindow | undefined
  private readonly store: KoiPondStore

  constructor(
    savePath: string,
    private readonly page: string,
    private readonly preload: string,
    private readonly report: (error: unknown) => void,
  ) {
    this.store = new KoiPondStore(savePath)
    ipcMain.handle('pond:get-state', event => {
      this.checkSender(event)
      return this.store.view()
    })
    ipcMain.handle('pond:rename', async (event, id: unknown, name: unknown) => {
      this.checkSender(event)
      const changed = await this.store.renameFish(id, name)
      if (changed) await this.publish()
      return changed
    })
  }

  private checkSender(event: IpcMainInvokeEvent): void {
    if (!this.window || this.window.isDestroyed() || event.sender !== this.window.webContents
      || event.senderFrame !== event.sender.mainFrame
      || event.sender.getURL() !== pathToFileURL(this.page).href) throw new Error('鱼塘窗口来源不匹配')
  }

  async open(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) {
      if (this.window.isMinimized()) this.window.restore()
      this.window.show()
      this.window.focus()
      return
    }
    const window = new BrowserWindow({
      title: '后院鱼塘', width: 1280, height: 720, minWidth: 680, minHeight: 520,
      show: false, autoHideMenuBar: true, backgroundColor: '#102d2c',
      webPreferences: {
        preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: true,
        partition: 'persist:koi-pond',
      },
    })
    this.window = window
    window.setMenu(null)
    window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    window.webContents.session.setPermissionCheckHandler(() => false)
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => { event.preventDefault() })
    window.webContents.on('will-attach-webview', event => { event.preventDefault() })
    window.on('closed', () => { if (this.window === window) this.window = undefined })
    window.once('ready-to-show', () => { if (!window.isDestroyed()) window.show() })
    try { await window.loadFile(this.page) }
    catch (error) { window.destroy(); throw error }
  }

  async recordDialogue(sessionId: string, requestId: string): Promise<void> {
    if (await this.store.recordDialogue(sessionId, requestId)) await this.publish()
  }

  private async publish(): Promise<void> {
    const state = await this.store.view()
    if (this.window && !this.window.isDestroyed()) this.window.webContents.send('pond:state', state)
  }

  async stop(): Promise<void> {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
    await this.store.flush().catch(this.report)
  }
}
