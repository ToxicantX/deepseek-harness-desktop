import { WebContentsView, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { pathToFileURL } from 'node:url'
import { KoiPondStore } from './koi-pond-store.ts'

/** One session the shell currently reports as executing. */
export interface RunningSession {
  id: string
  /** Per-session run counter: advances only when that session starts a genuinely new run. */
  runSeq: number
  startedAt: number
  projectName?: string
  sessionLabel?: string
  output?: string
  approval?: boolean
  subAgent?: boolean
}
/** A complete running set carries the generation that produced it, so an older set never overwrites a newer one. */
export interface RunningSet {
  epoch: string
  seq: number
  sessions: RunningSession[]
}
export interface RunningListEntry {
  id: string
  /** Per-session run counter: it advances only when that session starts a genuinely new run. */
  seq: number
  startedAt?: number
  projectName?: string
  sessionLabel?: string
  output?: string
  approval?: boolean
  subAgent?: boolean
}

const bounded = (value: unknown, limit: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length === 0 ? undefined : trimmed.slice(0, limit)
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9A-Za-z._~-]{1,128}$/u.test(value)

function entryOf(value: unknown): RunningListEntry | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (!identity(raw.id)) return undefined
  // Without a run counter a row cannot be distinguished from the same session's
  // previous run, so an unidentified entry is dropped instead of being trusted.
  if (typeof raw.seq !== 'number' || !Number.isSafeInteger(raw.seq) || raw.seq < 1) return undefined
  const projectName = bounded(raw.projectName, 120)
  const sessionLabel = bounded(raw.sessionLabel, 120)
  const output = bounded(raw.output, 240)
  return {
    id: raw.id,
    seq: raw.seq,
    ...(typeof raw.startedAt === 'number' && Number.isFinite(raw.startedAt) ? { startedAt: raw.startedAt } : {}),
    ...(projectName === undefined ? {} : { projectName }),
    ...(sessionLabel === undefined ? {} : { sessionLabel }),
    ...(output === undefined ? {} : { output }),
    ...(typeof raw.subAgent === 'boolean' ? { subAgent: raw.subAgent } : {}),
    ...(typeof raw.approval === 'boolean' ? { approval: raw.approval } : {}),
  }
}

/** The document generation a running set belongs to, plus every generation already retired. */
export interface RunningGeneration {
  epoch: string
  seq: number
  retired: Set<string>
}

/**
 * Accepts a complete running set only when its document generation is current and
 * still live, and (within one generation) only when it advances the sequence.
 * Returns undefined for a stale or retired set, so the authoritative list stands.
 */
export function applyRunningSnapshot(sessions: unknown, seq: number, generation: RunningGeneration, epoch?: string): RunningSet | undefined {
  if (!Array.isArray(sessions) || !Number.isSafeInteger(seq) || seq < 0) return undefined
  if (epoch === undefined) return undefined
  // A retired generation is a document that has already been replaced: its frames are
  // late by definition, and accepting one would revive the list it was resetting.
  if (generation.retired.has(epoch)) return undefined
  // Within one live generation the sequence must advance; a new generation restarts it.
  if (epoch === generation.epoch && seq <= generation.seq) return undefined
  const accepted: RunningSession[] = []
  const seen = new Set<string>()
  for (const value of sessions) {
    const entry = entryOf(value)
    if (!entry || seen.has(entry.id)) continue
    seen.add(entry.id)
    accepted.push({
      id: entry.id,
      runSeq: entry.seq,
      startedAt: entry.startedAt ?? Date.now(),
      ...(entry.projectName === undefined ? {} : { projectName: entry.projectName }),
      ...(entry.sessionLabel === undefined ? {} : { sessionLabel: entry.sessionLabel }),
      ...(entry.output === undefined ? {} : { output: entry.output }),
      ...(entry.subAgent === undefined ? {} : { subAgent: entry.subAgent }),
      ...(entry.approval === undefined ? {} : { approval: entry.approval }),
    })
  }
  accepted.sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : 1))
  return { epoch, seq, sessions: accepted }
}

/** The local view overlays the chat without navigating its WebContents. */
export class KoiPondWindow {
  private view: WebContentsView | undefined
  private owner: BrowserWindow | undefined
  private visible = false
  private loading: Promise<void> | undefined
  private disposing = false
  private readonly store: KoiPondStore
  private runningSessions: RunningSession[] = []
  /** The live document generation and its sequence, plus every generation already retired. */
  private readonly generation: RunningGeneration = { epoch: '', seq: -1, retired: new Set() }
  /** Rows the user dismissed, keyed by session, remembered until that session starts a new run. */
  private readonly dismissed = new Map<string, string>()

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
    ipcMain.handle('pond:get-live-weather', async (event, config?: { host?: string; key?: string }) => {
      this.checkSender(event)
      return this.fetchQWeather(config)
    })
  }

  private async fetchQWeather(config?: { host?: string; key?: string }): Promise<{
    icon: string
    text: string
    precip: number
    temp?: string
    weatherCode?: number
    rain?: number
    snowfall?: number
  } | null> {
    try {
      let lat = 31.23, lon = 121.47
      try {
        const geoRes = await fetch('http://ip-api.com/json', { signal: AbortSignal.timeout(5000) })
        if (geoRes.ok) {
          const geo = await geoRes.json() as { lat?: number; lon?: number }
          if (typeof geo.lat === 'number' && typeof geo.lon === 'number') {
            lat = geo.lat; lon = geo.lon
          }
        }
      } catch {
        try {
          const whoRes = await fetch('https://ipwho.is/', { signal: AbortSignal.timeout(4000) })
          if (whoRes.ok) {
            const who = await whoRes.json() as { latitude?: number; longitude?: number }
            if (typeof who.latitude === 'number' && typeof who.longitude === 'number') {
              lat = who.latitude; lon = who.longitude
            }
          }
        } catch {}
      }

      let host = typeof config?.host === 'string' ? config.host.trim() : ''
      const key = typeof config?.key === 'string' ? config.key.trim() : ''
      if (!host || !key) return null
      if (!/^https?:\/\//i.test(host)) {
        host = `https://${host}`
      }
      host = host.replace(/\/+$/, '')
      const location = `${lon.toFixed(2)},${lat.toFixed(2)}`
      const url = `${host}/v7/weather/now?location=${encodeURIComponent(location)}&key=${encodeURIComponent(key)}`
      const weatherRes = await fetch(url, { signal: AbortSignal.timeout(8000) })
      if (!weatherRes.ok) return null
      const data = await weatherRes.json() as {
        code?: string
        now?: {
          icon?: string
          text?: string
          precip?: string
          temp?: string
        }
      }
      if (!data || data.code !== '200' || !data.now) return null

      const precip = Number(data.now.precip) || 0
      const icon = String(data.now.icon || '')
      const text = String(data.now.text || '')

      return {
        icon,
        text,
        precip,
        rain: precip,
        ...(data.now.temp ? { temp: String(data.now.temp) } : {}),
      }
    } catch {
      return null
    }
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

  /**
   * Replaces the running list with one complete authoritative set. A set from a
   * previous document generation or an older sequence is ignored, so late frames
   * cannot revive a session that already stopped.
   */
  setRunningSessions(set: { epoch?: unknown; seq?: unknown; sessions?: unknown }): void {
    const epoch = typeof set?.epoch === 'string' && set.epoch.length > 0 ? set.epoch : undefined
    const seq = typeof set?.seq === 'number' ? set.seq : undefined
    if (seq === undefined) return
    // Validate before any state change: a refused set (stale sequence, retired or malformed
    // frame) must leave the live generation and the user's dismissals exactly as they were.
    const accepted = applyRunningSnapshot(set?.sessions, seq, this.generation, epoch)
    if (!accepted) return
    // Only an accepted frame from a new document generation retires the current one, so a
    // late frame cannot restore the list it reset and cannot retire the generation it lost to.
    if (epoch !== undefined && epoch !== this.generation.epoch) {
      if (this.generation.epoch !== '') this.generation.retired.add(this.generation.epoch)
      this.dismissed.clear()
    }
    for (const [dismissedId, dismissedRun] of [...this.dismissed]) {
      const current = accepted.sessions.find(session => session.id === dismissedId)
      // Forget a dismissal once the session leaves the list or starts a genuinely new run.
      if (!current || String(current.runSeq) !== dismissedRun) this.dismissed.delete(dismissedId)
    }
    this.generation.epoch = accepted.epoch
    this.generation.seq = accepted.seq
    this.runningSessions = accepted.sessions.filter(session => this.dismissed.get(session.id) !== String(session.runSeq))
    this.sendRunningSessions()
  }

  /**
   * Retires the current document generation and clears the list. Called when the chat
   * page reloads: its in-page hook is gone, so every tracked entry is already stale and
   * the reloaded page must republish before anything is shown again.
   */
  resetRunningSessions(): void {
    if (this.generation.epoch !== '') this.generation.retired.add(this.generation.epoch)
    this.generation.epoch = ''
    this.generation.seq = -1
    this.dismissed.clear()
    if (this.runningSessions.length === 0) return
    this.runningSessions = []
    this.sendRunningSessions()
  }

  /** Drops one stuck entry so the pond stops showing it as still thinking. */
  clearRunningSession(sessionId: string): void {
    const dismissed = this.runningSessions.find(session => session.id === sessionId)
    if (dismissed) this.dismissed.set(sessionId, String(dismissed.runSeq))
    const remaining = this.runningSessions.filter(session => session.id !== sessionId)
    if (remaining.length === this.runningSessions.length) return
    this.runningSessions = remaining
    this.sendRunningSessions()
  }

  clearAllRunningSessions(): void {
    for (const session of this.runningSessions) this.dismissed.set(session.id, String(session.runSeq))
    if (this.runningSessions.length > 0) this.runningSessions = []
    this.sendRunningSessions()
  }

  private sendRunningSessions(): void {
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('pond:running-sessions', this.runningSessions)
  }

  private async publish(): Promise<void> {
    const state = await this.store.view()
    if (this.view && !this.view.webContents.isDestroyed()) this.view.webContents.send('pond:state', state)
    this.sendRunningSessions()
  }

  async stop(): Promise<void> {
    this.disposeView()
    await this.store.flush().catch(this.report)
  }
}
