import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const html = readFileSync(join(root, 'assets', 'pet.html'), 'utf8')
const css = readFileSync(join(root, 'assets', 'pet.css'), 'utf8')
const petPreload = readFileSync(join(root, 'src', 'pet-preload.ts'), 'utf8')
const sharedPreload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const petWindow = readFileSync(join(root, 'src', 'pet-window.ts'), 'utf8')
const tsdown = readFileSync(join(root, 'tsdown.config.ts'), 'utf8')

describe('desktop pet renderer contract', () => {
  it('ships a script-free fixed local page with stable controls', () => {
    for (const id of [
      'pet-page', 'bubble', 'session-label', 'hide-pet', 'status-text', 'reply-text',
      'approval', 'approval-tool', 'approval-reason', 'approval-count',
      'reject-approval', 'allow-approval', 'open-main', 'mascot', 'pet-skin', 'state-indicator',
    ]) expect(html).toContain('id="' + id + '"')
    expect(html).toContain("script-src 'none'")
    expect(html).toContain("connect-src 'none'")
    expect(html).toContain("img-src 'self' data:")
    expect(html).toContain('aria-live="polite"')
    expect(html).not.toMatch(/<script|\son[a-z]+=/iu)
  })

  it('keeps layout stable and honors accessibility preferences', () => {
    expect(css).toContain('width: 240px')
    expect(css).toContain('max-height: 204px')
    expect(css).toContain('right: -7px')
    expect(css).toContain('width: 96px')
    expect(css).toContain('object-fit: contain')
    expect(css).toContain('[hidden] { display: none !important; }')
    expect(css).toContain('border-radius: 8px')
    expect(css).toContain('[data-state="idle"] .mascot')
    expect(css).toContain('[data-state="success"] .mascot')
    expect(css).toContain('[data-state="error"] .mascot')
    expect(css).toContain('@media (prefers-reduced-motion: reduce)')
    expect(css).toContain('@media (forced-colors: active)')
    expect(css).toContain(':focus-visible')
    expect(css).not.toContain('linear-gradient')
  })

  it('renders bounded text through a dedicated narrow preload', () => {
    expect(tsdown).toContain("entry: ['src/preload.ts', 'src/pet-preload.ts']")
    expect(petPreload).toContain("ipcRenderer.on('pet:state'")
    expect(petPreload).toContain("ipcRenderer.invoke('pet:respond', pending.id, outcome)")
    expect(petPreload).toContain("ipcRenderer.send('pet:focus-main')")
    expect(petPreload).toContain("ipcRenderer.send('pet:hide')")
    expect(petPreload).toContain("ipcRenderer.send('pet:interaction', interactive)")
    expect(petPreload).toContain("ipcRenderer.send('pet:ready')")
    expect(petPreload).toContain('Array.from(value.replace')
    expect(petPreload).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u)
    expect(petPreload).not.toContain('contextBridge')
  })

  it('accepts foreground session signals only through same-window messages', () => {
    expect(sharedPreload).toContain("const PET_ACTIVE_SESSION_MESSAGE = 'dsh/desktop-pet-active-session'")
    expect(sharedPreload).toContain('event.source !== window || event.origin !== window.location.origin')
    expect(sharedPreload).toContain("ipcRenderer.send('pet:set-active-session', sessionId)")
    expect(main).toContain("state.thinking === true) return { mode: 'thinking'")
    expect(main).toContain('event.sender !== mainWindow.webContents')
    expect(main).toContain('new URL(event.sender.getURL()).origin === trustedOrigin')
  })

  it('shows the pet only while the main window is hidden and keeps manual hiding', () => {
    expect(main).toContain("mainWindow.on('show', () => { petWindow?.setMainVisible(true) })")
    expect(main).toContain("mainWindow.on('hide', () => { petWindow?.setMainVisible(false) })")
    expect(main).toContain('if (!quitting) petWindow?.setMainVisible(false)')
    expect(main).toContain('mainWindow?.hide()')
    expect(main).toContain("label: '桌面宠物', type: 'checkbox'")
    expect(main).toContain("label: '启用桌面宠物'")
    expect(petWindow).toContain('if (!this.mainVisible && !this.settings.manuallyHidden) window.showInactive()')
    expect(petWindow).toContain('const STREAM_UPDATE_MS = 100')
    expect(petWindow).toContain("state.mode === 'speaking'")
    expect(petWindow).toContain("join(options.userData, 'desktop-pet.json')")
    expect(petWindow).not.toContain('DSH_HOME')
  })

  it('configures a bounded persistent skin from the File menu', () => {
    expect(main).toContain("label: '个性化皮肤'")
    expect(main).toContain("label: '选择本地图片...'")
    expect(main).toContain("label: '恢复默认皮肤'")
    expect(main).toContain("extensions: ['png', 'jpg', 'jpeg', 'webp']")
    expect(petWindow).toContain("join(options.userData, 'desktop-pet-skin.png')")
    expect(petWindow).toContain('const MAX_SKIN_SOURCE_BYTES = 8 * 1024 * 1024')
    expect(petWindow).toContain('const MAX_SKIN_RENDER_DIMENSION = 512')
    expect(petWindow).toContain("this.window.webContents.send('pet:skin'")
    expect(petPreload).toContain("ipcRenderer.on('pet:skin'")
    expect(petPreload).toContain("const prefix = 'data:image/png;base64,'")
    expect(petPreload).toContain('MAX_SKIN_DATA_URL_LENGTH')
    expect(petPreload).not.toContain('sourcePath')
  })

  it('keeps pet IPC scoped to its exact window and opaque approval identifier', () => {
    expect(main).toContain('window?.matchesSender(event.sender, petPage)')
    expect(main).toContain("ipcMain.handle('pet:respond'")
    expect(main).toContain('events.decide({ approvalId, outcome })')
    expect(main).not.toContain('events.decide({ approvalId, outcome, rpcId')
    expect(main).toContain("ipcMain.on('pet:hide'")
    expect(main).toContain('await stopPet()')
  })
})
