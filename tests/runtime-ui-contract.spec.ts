import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const html = readFileSync(join(root, 'assets', 'runtime.html'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')

describe('runtime startup UI contract', () => {
  it('ships a script-free animated startup surface with reduced-motion support', () => {
    for (const id of [
      'runtime-page',
      'phase-chip',
      'runtime-progress-row',
      'runtime-progress',
      'progress-value',
      'progress-label',
      'startup-actions',
      'startup-retry',
      'version-settings',
      'version-mode-auto',
      'version-mode-pinned',
      'pinned-version-field',
      'version',
      'version-meta',
      'selection-version',
      'selection-detail',
      'apply',
      'retry',
    ]) expect(html).toContain('id="' + id + '"')
    expect(html).toContain('class="activity-ring"')
    expect(html).toContain('data-view="startup"')
    expect(html).toMatch(/<section id="version-settings"[^>]* hidden>/u)
    expect(html).toContain('body[data-view="startup"] .progress-row { margin-top: auto')
    expect(html).toContain('@keyframes shell-enter')
    expect(html).toContain('@keyframes activity-spin')
    expect(html).toContain('@keyframes progress-scan')
    expect(html).toContain('@media (prefers-reduced-motion: reduce)')
    expect(html).toContain("script-src 'none'")
    expect(html).not.toMatch(/<script| on[a-z]+=/iu)
  })

  it('keeps the application menu hidden until the trusted DSH page finishes loading', () => {
    const createWindow = main.slice(main.indexOf('function createWindow'), main.indexOf('function showMainWindow'))
    const setup = main.slice(main.indexOf('async function showSetup'), main.indexOf('function sendView'))
    const sync = main.slice(main.indexOf('function syncMainMenuVisibility'), main.indexOf('function createWindow'))
    expect(createWindow).toContain('window.setMenuBarVisibility(false)')
    expect(createWindow).toContain("window.webContents.on('did-finish-load'")
    expect(createWindow).toContain('syncMainMenuVisibility()')
    expect(setup).toContain('clearMainMenu()')
    expect(sync).toContain("mainUiLoaded && latestView?.phase === 'ready'")
    expect(sync).toContain('new URL(window.webContents.getURL()).origin === trustedOrigin')
    expect(sync).toContain('window.setMenuBarVisibility(trustedPageLoaded)')
    expect(setup).toContain('mainUiLoaded = false')
    expect(main).toContain('await window.loadURL(url.href)')
    expect(main).toContain('mainUiLoaded = true\n      installMenu()')
    expect(main).toContain('Menu.setApplicationMenu(null)')
    expect(main).toContain('if (!mainUiLoaded) {\n    clearMainMenu()\n    return')
    expect(main).toContain('Menu.setApplicationMenu(Menu.buildFromTemplate(template))\n  syncMainMenuVisibility()')
  })

  it('separates automatic and pinned policies without changing the IPC contract', () => {
    expect(html).toContain('value="latest-compatible"')
    expect(html).toContain('value="pinned"')
    expect(html).toContain('自动选择')
    expect(html).toContain('固定版本')
    expect(main).toContain("loadFile(setupPage, { query: { view: 'manager' } })")
    expect(main).toContain('async function retryRuntimeFromMenu()')
    expect(main).toContain('if (mainWindow !== undefined) await showSetup(mainWindow)')
    expect(main).toContain('void retryRuntimeFromMenu().catch(logFatalError)')
    expect(preload).toContain("new URLSearchParams(window.location.search).get('view') === 'manager'")
    expect(preload).toContain("element<HTMLElement>('version-settings').hidden = !runtimeManagerMode")
    expect(preload).toContain("runtimeDraftMode = 'latest-compatible'")
    expect(preload).toContain("runtimeDraftMode = 'pinned'")
    expect(preload).toContain("{ mode: 'latest-compatible' }")
    expect(preload).toContain("{ mode: 'pinned', version: runtimeDraftVersion as string }")
    expect(preload).toContain("ipcRenderer.invoke('runtime:set-preference', preference)")
    expect(preload).toContain("ipcRenderer.invoke('runtime:get-view')")
    expect(main).toContain('return runtimeController.refreshCatalog()')
    expect(preload).toContain('select.disabled = busy || !pinned || availableVersions.length === 0')
    expect(preload).toContain('runtimePreferenceMatches(view)')
    expect(preload).toContain("startupRetry.hidden = runtimeManagerMode || view.phase !== 'error'")
  })

  it('opens the prepared DSH terminal from the Runtime menu', () => {
    expect(main).toContain("label: '打开终端'")
    expect(main).toContain('void openTerminal(cliDirectory, home)')
    expect(main).toContain("dialog.showErrorBox('无法打开终端'")
    expect(main).not.toContain('打开插件管理终端')
  })

  it('authorizes both exact runtime-page windows and no unrelated utility sender', () => {
    const guard = main.slice(main.indexOf('function runtimeClient'), main.indexOf('function pluginService'))
    expect(guard).toContain('event.sender === mainWindow.webContents')
    expect(guard).toContain('event.sender === managerWindow.webContents')
    expect(guard).toContain('if (!fromMainWindow && !fromManagerWindow)')
    expect(guard).toContain('resolve(fileURLToPath(url)) !== resolve(setupPage)')
    expect(guard).not.toContain('pluginWindow.webContents')
    expect(guard).not.toContain('mcpWindow.webContents')
  })

  it('renders trustworthy phase, progress, and version metadata using DOM APIs', () => {
    expect(preload).toContain('document.body.dataset.phase = view.phase')
    expect(preload).toContain("element('runtime-page').setAttribute('aria-busy', String(busy))")
    expect(preload).toContain("progressElement.dataset.indeterminate = String(indeterminate)")
    expect(preload).toContain("progressElement.setAttribute('aria-valuenow', progress.toFixed(1))")
    expect(preload).toContain('versions.findIndex(candidate => candidate.version === version.version) === index')
    expect(preload).toContain("option.textContent = version.version + (version.current ? '（当前使用）' : '')")
    expect(preload).toContain("selectionDetail.textContent = targetVersion.current ? '当前使用' : ''")
    expect(preload).not.toContain('+ String(targetVersion.runtimeRevision)')
    expect(preload).not.toContain('targetVersion.requiredShellRange')
    expect(preload).toContain("'该版本不在当前兼容目录，请选择其他版本'")
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function']) {
      expect(preload).not.toContain(sink)
    }
  })
})
