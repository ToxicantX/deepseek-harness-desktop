import { WebContentsView, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { KoiPondStore } from './koi-pond-store.ts'

/** The local view overlays the chat without navigating its WebContents. */
export class KoiPondWindow {
  private view: WebContentsView | undefined
  private owner: BrowserWindow | undefined
  private visible = false
  private loading: Promise<void> | undefined
  private disposing = false
  private readonly store: KoiPondStore
  private runningSessions: Array<{ id: string; startedAt: number }> = []

  constructor(
    savePath: string,
    private readonly page: string,
    private readonly preload: string,
    private readonly report: (error: unknown) => void,
    private readonly getOwner: () => BrowserWindow | undefined,
  ) {
    this.store = new KoiPondStore(savePath)
    ipcMain.handle('pond:close', event => {
      this.checkSender(event)
      this.hide()
    })
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
    if (!this.view || this.view.webContents.isDestroyed() || event.sender !== this.view.webContents
      || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('鱼塘窗口来源不匹配')
    }
    const senderUrl = event.sender.getURL()
    const expectedUrl = pathToFileURL(this.page).href
    if (senderUrl !== expectedUrl) {
      try {
        const u1 = new URL(senderUrl)
        const u2 = new URL(expectedUrl)
        if (u1.protocol !== 'file:' || decodeURIComponent(u1.pathname).toLowerCase() !== decodeURIComponent(u2.pathname).toLowerCase()) {
          throw new Error('鱼塘窗口来源不匹配')
        }
      } catch {
        throw new Error('鱼塘窗口来源不匹配')
      }
    }
  }

  async open(): Promise<void> {
    if (this.visible) {
      this.hide()
      return
    }
    if (this.loading) return this.loading
    const owner = this.getOwner()
    if (!owner || owner.isDestroyed()) throw new Error('主窗口尚未就绪')
    if (!this.view || this.view.webContents.isDestroyed()) {
      this.view = this.createView(owner)
      const view = this.view
      this.loading = view.webContents.loadFile(this.page).catch(error => {
        this.disposeView()
        throw error
      }).finally(() => { this.loading = undefined })
      await this.loading
    }
    if (owner.isDestroyed() || !this.view || this.view.webContents.isDestroyed()) return
    owner.contentView.addChildView(this.view)
    this.visible = true
    this.resize()
    this.view.setVisible(true)
    await this.view.webContents.executeJavaScript('window.dispatchEvent(new Event("resize"))')
    this.view.webContents.send('pond:visibility', true)
    this.view.webContents.focus()
    await this.publish()
  }

  private readonly resize = (): void => {
    if (!this.owner || this.owner.isDestroyed() || !this.view) return
    const { width, height } = this.owner.getContentBounds()
    this.view.setBounds({ x: 0, y: 0, width, height })
  }

  private readonly hide = (): void => {
    if (!this.visible || !this.view || !this.owner || this.owner.isDestroyed()) return
    this.owner.contentView.removeChildView(this.view)
    this.view.setVisible(false)
    this.view.webContents.send('pond:visibility', false)
    this.visible = false
    this.owner.webContents.focus()
  }

  private readonly onNavigation = (_event: Electron.Event, _url: string, inPlace: boolean, mainFrame: boolean): void => {
    if (mainFrame && !inPlace) this.hide()
  }

  private createView(owner: BrowserWindow): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        preload: this.preload, nodeIntegration: false, contextIsolation: true, sandbox: true,
        partition: 'persist:koi-pond',
      },
    })
    view.setVisible(false)
    const { width, height } = owner.getContentBounds()
    view.setBounds({ x: 0, y: 0, width, height })
    view.setBackgroundColor('#102d2c')
    view.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false) })
    view.webContents.session.setPermissionCheckHandler(() => false)
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    view.webContents.on('will-navigate', event => { event.preventDefault() })
    view.webContents.on('will-attach-webview', event => { event.preventDefault() })
    this.owner = owner
    owner.on('resize', this.resize)
    owner.webContents.on('did-start-navigation', this.onNavigation)
    owner.once('closed', this.disposeView)
    return view
  }

  private readonly disposeView = (): void => {
    if (this.disposing) return
    this.disposing = true
    const owner = this.owner
    const view = this.view
    const wasVisible = this.visible
    this.view = undefined
    this.owner = undefined
    this.visible = false
    try { owner?.removeListener('resize', this.resize) } catch (error) { this.report(error) }
    try { owner?.removeListener('closed', this.disposeView) } catch (error) { this.report(error) }
    try { owner?.webContents.removeListener('did-start-navigation', this.onNavigation) } catch (error) { this.report(error) }
    if (wasVisible && owner && view) {
      try { owner.contentView.removeChildView(view) } catch (error) { this.report(error) }
    }
    try { view?.setVisible(false) } catch (error) { this.report(error) }
    try { view?.webContents.close() } catch (error) { this.report(error) }
    this.disposing = false
  }

  async recordDialogue(sessionId: string, requestId: string): Promise<void> {
    if (await this.store.recordDialogue(sessionId, requestId)) await this.publish()
  }

  setRunningSessions(sessions: Array<{ id: string; startedAt: number }>): void {
    this.runningSessions = sessions.map(session => ({ ...session }))
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('pond:running-sessions', this.runningSessions)
  }

  private async publish(): Promise<void> {
    const state = await this.store.view()
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('pond:state', state)
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('pond:running-sessions', this.runningSessions)
  }

  async stop(): Promise<void> {
    this.disposeView()
    await this.store.flush().catch(this.report)
  }
}
