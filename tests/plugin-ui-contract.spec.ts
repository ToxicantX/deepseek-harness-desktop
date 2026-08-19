import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const html = readFileSync(join(root, 'assets', 'plugin-manager.html'), 'utf8')
const runtimeHtml = readFileSync(join(root, 'assets', 'runtime.html'), 'utf8')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')

describe('plugin manager UI contract', () => {
  it('ships a script-free local page with every required control', () => {
    for (const id of [
      'plugin-manager-page',
      'plugin-spec',
      'plugin-install',
      'plugin-refresh',
      'plugin-status',
      'plugin-progress',
      'plugin-log-section',
      'plugin-log',
      'plugin-list',
      'plugin-empty',
    ]) expect(html).toContain('id="' + id + '"')
    expect(html).toContain("default-src 'none'")
    expect(html).not.toMatch(/<script|\son[a-z]+=/iu)
  })

  it('keeps all plugin UI behavior in the sandboxed preload without HTML sinks', () => {
    expect(preload).toContain("ipcRenderer.invoke('plugin-manager:list')")
    expect(preload).toContain("ipcRenderer.invoke('plugin-manager:start'")
    expect(preload).toContain("ipcRenderer.invoke('plugin-manager:status'")
    expect(preload).toContain("ipcRenderer.invoke('plugin-manager:restart'")
    expect(preload).toContain("document.querySelector('#plugin-manager-page')")
    expect(preload).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u)
  })

  it('exposes stale local plugin recovery only through the Runtime setup page', () => {
    expect(runtimeHtml).toContain('id="recover-stale-plugins"')
    expect(preload).toContain("ipcRenderer.invoke('runtime:recover-stale-local-plugins')")
    expect(main).toContain('event.sender !== mainWindow.webContents')
    expect(main).toContain("url.protocol !== 'file:'")
    expect(main).toContain('resolve(fileURLToPath(url)) !== resolve(setupPage)')
  })

  it('allows the recovery window only for an installed Runtime and validates IPC senders', () => {
    expect(main).toContain('controller?.installedRuntime() === undefined')
    expect(main).toContain('enabled: controller?.installedRuntime() !== undefined')
    expect(main).toContain('event.sender !== pluginWindow.webContents')
    expect(main).toContain('new PluginManager({ runtime: () => controller?.installedRuntime(), home })')
    expect(main).toContain('pluginManager?.dispose()')
  })
})
