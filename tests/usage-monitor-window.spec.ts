import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')

describe('usage monitor window integration', () => {
  it('defines a singleton local utility window with bounded dimensions', () => {
    expect(main).toContain("const usageMonitorPage = join(app.getAppPath(), 'assets', 'usage-monitor.html')")
    expect(main).toContain("utility?: 'manager' | 'repair' | 'plugin' | 'mcp' | 'personalization' | 'update' | 'usage'")
    expect(main).toContain("usage ? 1000 : 1240")
    expect(main).toContain("usage ? 780 : 820")
    expect(main).toContain("usage ? 640 : 820")
    expect(main).toContain("update ? 220 : 600")
    expect(main).toContain("{ label: '用量监控'")
    expect(main).toContain("if (usageMonitorWindow.isMinimized()) usageMonitorWindow.restore()")
    expect(main).toContain('usageMonitorWindow.show()')
    expect(main).toContain('usageMonitorWindow.focus()')
    expect(main).toContain('usageMonitorWindow = undefined')
  })

  it('restricts usage IPC to the exact main frame and local page', () => {
    expect(main).toContain("ipcMain.handle('usage-monitor:read'")
    expect(main).toContain("event.senderFrame !== event.sender.mainFrame")
    expect(main).toContain("resolve(fileURLToPath(url)) !== resolve(usageMonitorPage)")
    expect(main).toContain("readUsageSnapshot(home, onProgress)")
    expect(main).toContain("usage-monitor:progress")
  })

  it('executes the actual IPC validator against valid and untrusted senders', () => {
    const source = main.slice(main.indexOf('function usageMonitorClient('), main.indexOf('function personalizationService('))
    const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText
    const page = join(root, 'assets', 'usage-monitor.html')
    const frame = {}
    let url = pathToFileURL(page).href
    const sender = { mainFrame: frame, getURL: () => url }
    const owner = { isDestroyed: () => false, webContents: sender }
    const validate = runInNewContext(compiled + '; usageMonitorClient', {
      usageMonitorWindow: owner, usageMonitorPage: page, URL, resolve, fileURLToPath,
    }) as (event: unknown) => void
    expect(() => validate({ sender, senderFrame: frame })).not.toThrow()
    expect(() => validate({ sender, senderFrame: {} })).toThrow('来源无效')
    expect(() => validate({ sender: { ...sender }, senderFrame: frame })).toThrow('来源无效')
    for (const invalid of ['https://example.com', pathToFileURL(join(root, 'assets', 'runtime.html')).href, pathToFileURL(page).href + '?fake=1']) {
      url = invalid
      expect(() => validate({ sender, senderFrame: frame })).toThrow('页面无效')
    }
  })

  it('installs the renderer bridge only on the marked page', () => {
    expect(preload).toContain("import { installUsageMonitor } from './usage-monitor-renderer.ts'")
    expect(preload).toContain("document.body.dataset.page === 'usage-monitor'")
    expect(preload).toContain("ipcRenderer.on('usage-monitor:progress', receive)")
    expect(preload).toContain("ipcRenderer.removeListener('usage-monitor:progress', receive)")
    expect(preload).toContain("ipcRenderer.invoke('usage-monitor:read')")
    expect(main).toContain("event.senderFrame?.send('usage-monitor:progress', progress)")
  })
})