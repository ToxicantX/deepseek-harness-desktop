import { app, dialog, type BrowserWindow } from 'electron'
import updaterPackage from 'electron-updater'

const { autoUpdater } = updaterPackage

export class ShellUpdater {
  private pending: Promise<void> | undefined

  constructor(
    private readonly window: BrowserWindow,
    private readonly stopRuntime: () => Promise<void>,
  ) {
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
        (value) => { finish(() => { resolve(value) }) },
        (error: unknown) => {
          const reason = error instanceof Error ? error : new Error(String(error))
          finish(() => { reject(reason) })
        },
      )
    })
  }

  private async run(manual: boolean): Promise<void> {
    if (!app.isPackaged) {
      if (manual) await this.info('开发版本不执行 Shell 更新检查。', `Shell ${app.getVersion()}`)
      return
    }
    let result: Awaited<ReturnType<typeof autoUpdater.checkForUpdates>>
    try {
      result = await this.withUpdaterErrors(() => autoUpdater.checkForUpdates())
    } catch (error: unknown) {
      if (manual) await this.failure(error)
      return
    }
    if (result === null || result.updateInfo.version === app.getVersion()) {
      if (manual) await this.info('当前 Shell 已是最新版本。', `Shell ${app.getVersion()}`)
      return
    }
    const choice = await dialog.showMessageBox(this.window, {
      type: 'info',
      title: 'Shell 更新',
      message: `DeepSeek Harness Shell ${result.updateInfo.version} 已发布。`,
      detail: 'DSH runtime、插件、会话和配置不会被覆盖。',
      buttons: ['下载更新', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (choice.response !== 0) return
    try {
      await this.withUpdaterErrors(() => autoUpdater.downloadUpdate())
    } catch (error: unknown) {
      await this.failure(error)
      return
    }
    const install = await dialog.showMessageBox(this.window, {
      type: 'info',
      title: 'Shell 更新已下载',
      message: `Shell ${result.updateInfo.version} 已准备好安装。`,
      buttons: ['重启并安装', '稍后'],
      defaultId: 0,
      cancelId: 1,
    })
    if (install.response !== 0) return
    await this.stopRuntime()
    autoUpdater.quitAndInstall(false, true)
  }

  private async info(message: string, detail: string): Promise<void> {
    await dialog.showMessageBox(this.window, { type: 'info', title: 'Shell 更新', message, detail })
  }

  private async failure(error: unknown): Promise<void> {
    await dialog.showMessageBox(this.window, {
      type: 'error',
      title: 'Shell 更新失败',
      message: '无法检查或下载 Shell 更新。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
}
