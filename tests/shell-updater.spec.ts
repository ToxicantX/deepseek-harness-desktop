import { EventEmitter } from 'node:events'
import { describe, expect, it, vi, beforeEach } from 'vitest'

const updater = new EventEmitter() as EventEmitter & Record<string, any>
updater.checkForUpdates = vi.fn()
updater.downloadUpdate = vi.fn()
updater.quitAndInstall = vi.fn()
updater.autoDownload = false
updater.autoInstallOnAppQuit = false
updater.allowPrerelease = false
const app = { isPackaged: true, getVersion: vi.fn(() => '1.0.0') }
const dialog = { showMessageBox: vi.fn() }
vi.mock('electron', () => ({ app, dialog }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: updater } }))
const { ShellUpdater } = await import('../src/shell-updater.ts')

describe('ShellUpdater', () => {
  beforeEach(() => { vi.clearAllMocks(); updater.removeAllListeners(); app.isPackaged = true; updater.checkForUpdates.mockResolvedValue({ updateInfo: { version: '2.0.0' } }); updater.downloadUpdate.mockResolvedValue([]); dialog.showMessageBox.mockResolvedValue({ response: 0 }) })
  it('uses the combined download and restart prompt', async () => { await new ShellUpdater({} as any, vi.fn(async () => {})).check(true); expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ buttons: ['下载安装并重启', '稍后'] })) ; expect(dialog.showMessageBox).toHaveBeenCalledTimes(1) })
  it('forwards download progress and removes listeners after install', async () => { const progress = vi.fn(); updater.downloadUpdate.mockImplementation(async () => { updater.emit('download-progress', { percent: 42, transferred: 10, total: 20, bytesPerSecond: 5 }); return [] }); await new ShellUpdater({} as any, vi.fn(async () => {}), progress).check(false); expect(progress).toHaveBeenCalledWith(expect.objectContaining({ state: 'downloading', percent: 42 })); expect(updater.listenerCount('download-progress')).toBe(0) })
  it('stops runtime and installs after one confirmation', async () => { const stop = vi.fn(async () => {}); await new ShellUpdater({} as any, stop).check(true); expect(stop).toHaveBeenCalledOnce(); expect(updater.quitAndInstall).toHaveBeenCalledWith(false, true); expect(dialog.showMessageBox).toHaveBeenCalledTimes(1) })
  it('cleans up listeners on download failure', async () => { updater.downloadUpdate.mockRejectedValue(new Error('failed')); await new ShellUpdater({} as any, vi.fn(async () => {})).check(false); expect(updater.listenerCount('download-progress')).toBe(0); expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'error' })) })
  it('coalesces concurrent checks', async () => { let resolveCheck!: (value: unknown) => void; updater.checkForUpdates.mockReturnValue(new Promise(resolve => { resolveCheck = resolve })); const client = new ShellUpdater({} as any, vi.fn(async () => {})); const first = client.check(false); const second = client.check(false); expect(first).toBe(second); resolveCheck(null); await first; expect(updater.checkForUpdates).toHaveBeenCalledOnce() })
})
