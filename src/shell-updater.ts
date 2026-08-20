import { app, dialog, type BrowserWindow } from 'electron'
import updaterPackage from 'electron-updater'

const { autoUpdater } = updaterPackage

export type ShellUpdateProgress =
  | { state: 'checking' }
  | { state: 'downloading'; version: string; percent: number; transferred: number; total: number; bytesPerSecond: number }
  | { state: 'preparing-restart'; version: string }
  | { state: 'error'; message: string }
  | { state: 'idle' }

interface DownloadProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export class ShellUpdater {
  private pending: Promise<void> | undefined

  constructor(
    private readonly window: BrowserWindow,
    private readonly stopRuntime: () => Promise<void>,
    private readonly onProgress: (progress: ShellUpdateProgress) => void = () => {},
  ) {
    autoUpdater.logger = null
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false
    autoUpdater.allowPrerelease = app.getVersion().includes('-')
  }

  check(manual: boolean): Promise<void> {
    if (this.pending !== undefined) return this.pending
    this.pending = this.run(manual).finally(() => { this.pending = undefined })
    return this.pending
  }

  private withUpdaterErrors<T>(operation: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const finish = (callback: () => void): void => {
        if (settled) return
        settled = true
        autoUpdater.off('error', onError)
        callback()
      }
      const onError = (error: Error): void => { finish(() => { reject(error) }) }
      autoUpdater.once('error', onError)
      void operation().then(
        value => { finish(() => { resolve(value) }) },
        (error: unknown) => { finish(() => { reject(error instanceof Error ? error : new Error(String(error))) }) },
      )
    })
  }

  private async run(manual: boolean): Promise<void> {
    if (!app.isPackaged) {
      this.onProgress({ state: 'idle' })
      if (manual) await this.info('开发版本不执行 Shell 更新检查。', 'Shell ' + app.getVersion())
      return
    }

    this.onProgress({ state: 'checking' })
    let result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
    try {
      result = await this.withUpdaterErrors(() => autoUpdater.checkForUpdates())
    } catch (error: unknown) {
      this.onProgress({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      if (manual) await this.failure(error)
      this.onProgress({ state: 'idle' })
      return
    }

    if (result === null || result.updateInfo.version === app.getVersion()) {
      this.onProgress({ state: 'idle' })
      if (manual) await this.info('当前 Shell 已是最新版本。', 'Shell ' + app.getVersion())
      return
    }

    const version = result.updateInfo.version
    const choice = await dialog.showMessageBox(this.window, {
      type: 'info',
      title: 'Shell 更新',
      message: 'DeepSeek Harness Shell ' + version + ' 已发布。',
      detail: 'DSH Runtime、插件、会话和配置不会被覆盖。下载完成后将自动安装并重启。',
      buttons: ['下载安装并重启', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response !== 0) {
      this.onProgress({ state: 'idle' })
      return
    }

    const onDownloadProgress = (progress: DownloadProgress): void => {
      this.onProgress({ state: 'downloading', version, ...progress })
    }
    autoUpdater.on('download-progress', onDownloadProgress)
    this.onProgress({ state: 'downloading', version, percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 })
    try {
      await this.withUpdaterErrors(() => autoUpdater.downloadUpdate())
      this.onProgress({ state: 'preparing-restart', version })
      await this.stopRuntime()
      autoUpdater.quitAndInstall(true, true)
    } catch (error: unknown) {
      this.onProgress({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      await this.failure(error)
      this.onProgress({ state: 'idle' })
    } finally {
      autoUpdater.off('download-progress', onDownloadProgress)
    }
  }

  private async info(message: string, detail: string): Promise<void> {
    await dialog.showMessageBox(this.window, { type: 'info', title: 'Shell 更新', message, detail })
  }

  private async failure(error: unknown): Promise<void> {
    await dialog.showMessageBox(this.window, {
      type: 'error',
      title: 'Shell 更新失败',
      message: '无法检查、下载或安装 Shell 更新。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
