import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const main = readFileSync(join(import.meta.dirname, '..', 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(import.meta.dirname, '..', 'src', 'preload.ts'), 'utf8')

describe('skin market shell integration', () => {
  it('injects only into the trusted main DSH page after every load', () => {
    expect(main).toContain('createSkinMarketInjectorScript')
    expect(main).toContain('createClientBundleAdapterScript')
    expect(main).toContain("import { ShellSkinStore } from './shell-skin-store.ts'")
    expect(main).toContain("ipcMain.handle('shell-skins:list'")
    expect(main).toContain("ipcMain.handle('shell-skins:preview'")
    expect(main).toContain('skinService(event).preview(String(skinId), Number(index))')
    expect(preload).toContain("preview: (skinId: string, index: number) => ipcRenderer.invoke('shell-skins:preview', skinId, index)")
    expect(main).toContain('function injectSkinMarket(window: BrowserWindow): void')
    expect(main).toContain('window !== mainWindow || trustedOrigin === undefined || window.isDestroyed()')
    expect(main).toContain('new URL(window.webContents.getURL()).origin !== trustedOrigin')
    expect(main).toContain('window.webContents.executeJavaScript(createSkinMarketInjectorScript())')
    expect(main).toContain("'skin-react-runtime.global.iife.js'")
    expect(main).toContain('if (!window.__dshDesktopReactRuntime)')
    expect(main).toContain('getSkinReactRuntimeSource()')
    expect(main).toContain("window.webContents.on('did-finish-load'")
    expect(main).toContain('injectSkinMarket(window)')
  })

  it('opens the renderer-owned market from View > Theme without a floating renderer control', () => {
    expect(main).toContain("{ label: '主题'")
    expect(main).toContain('click: openSkinMarket')
    expect(main).toContain("__dshDesktopOpenSkinMarket")
    expect(main).not.toContain('dss-toggle')
    expect(main).not.toContain('swatchbook')
  })

  it('does not let injector failures interrupt the DSH UI', () => {
    expect(main).toContain('.catch(logFatalError)')
  })
})
