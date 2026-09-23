// Run after pnpm run build. Uses an isolated Electron profile and fixture IPC only.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const root = resolve(import.meta.dirname, '..')
async function runElectron() {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  assert(process.env.DSH_REFRESH_SMOKE_HOME)
  app.setPath('userData', join(process.env.DSH_REFRESH_SMOKE_HOME, 'electron'))
  const deadline = setTimeout(() => app.exit(1), 60_000)
  let window
  try {
    const version = (value, current = false, runtimeRevision = 1) => ({
      version: value, current, runtimeRevision, installed: current,
      requiredShellRange: '>=0.1.51', sourceTag: 'dsh-v' + value,
    })
    let view = {
      phase: 'ready', message: 'DSH 已启动', shellVersion: '0.1.52', minimumDshVersion: '0.1.0-rc.7',
      currentVersion: '0.1.7-alpha.1', currentRuntimeRevision: 1,
      preference: { mode: 'latest-compatible' }, cachedCatalog: false,
      versions: [version('0.1.7-alpha.1', true)],
      upstream: { version: '0.1.7-alpha.2', status: 'pending' },
    }
    let requests = 0
    let retries = 0
    let fail = false
    let applied
    ipcMain.handle('runtime:get-view', async () => {
      requests++
      await new Promise(resolve => setTimeout(resolve, 100))
      if (fail) throw new Error('Fixture offline')
      return view
    })
    ipcMain.handle('runtime:retry', () => { retries++ })
    ipcMain.handle('runtime:set-preference', (_event, value) => { applied = value })
    await app.whenReady()
    window = new BrowserWindow({ width: 900, height: 840, show: false,
      webPreferences: { preload: join(root, 'lib/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
    const preloadErrors = []
    window.webContents.on('preload-error', (_event, _path, error) => preloadErrors.push(error.message))
    const evaluate = source => window.webContents.executeJavaScript(source)
    const settled = () => evaluate(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const poll = () => !document.getElementById('retry').disabled ? resolve()
        : Date.now() > deadline ? reject(new Error('refresh timeout')) : setTimeout(poll, 20);
      poll();
    })`)
    const refresh = async () => {
      await evaluate("document.getElementById('retry').click()")
      assert.equal(await evaluate("document.getElementById('retry').disabled"), true)
      await settled()
    }
    await window.loadFile(join(root, 'assets/runtime.html'), { query: { view: 'manager' } })
    await settled()
    assert.match(await evaluate("document.getElementById('upstream-status').textContent"), /0\.1\.7-alpha\.2.*等待桌面包/)
    assert.equal(await evaluate("document.getElementById('apply').disabled"), true)
    assert.equal(await evaluate("document.getElementById('version').options.length"), 1)

    view = { ...view, versions: [version('0.1.7-alpha.2'), ...view.versions], upstream: { version: '0.1.7-alpha.2', status: 'available' } }
    await refresh()
    assert.equal(retries, 0, 'Refreshing must not restart the Runtime')
    assert.equal(requests, 2)
    assert.equal(await evaluate("document.getElementById('apply').disabled"), false)
    assert.match(await evaluate("document.getElementById('apply').textContent"), /更新到 0\.1\.7-alpha\.2/)
    await evaluate("document.getElementById('apply').click()")
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.deepEqual(applied, { mode: 'latest-compatible' })

    for (const width of [900, 390]) {
      window.setContentSize(width, 840)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Overflow at ' + width)
      if (process.env.DSH_REFRESH_SCREENSHOT_DIR) {
        await mkdir(process.env.DSH_REFRESH_SCREENSHOT_DIR, { recursive: true })
        await writeFile(join(process.env.DSH_REFRESH_SCREENSHOT_DIR, `runtime-refresh-${width}.png`), (await window.webContents.capturePage()).toPNG())
      }
    }
    await evaluate("document.getElementById('version-mode-pinned').click()")
    await refresh()
    assert.equal(await evaluate("document.getElementById('version-mode-pinned').checked"), true, 'Refresh preserves draft policy')
    fail = true
    await refresh()
    assert.match(await evaluate("document.getElementById('error').textContent"), /Fixture offline/)
    assert.equal(await evaluate("document.getElementById('version').options.length"), 2)
    fail = false
    await refresh()
    assert.equal(await evaluate("document.getElementById('error').style.display"), 'none')

    view = { ...view, currentVersion: '0.1.7-alpha.2', versions: [version('0.1.7-alpha.2', true, 2)] }
    await evaluate("document.getElementById('version-mode-auto').click()")
    await refresh()
    assert.equal(await evaluate("document.getElementById('apply').disabled"), false, 'Revision update must remain applicable')
    assert.deepEqual(preloadErrors, [])
    console.log('PASS: prerelease discovery, pending status, refresh without restart, automatic update, revision update, draft preservation, offline recovery, 900/390px')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    if (window && !window.isDestroyed()) window.destroy()
    app.exit(process.exitCode ?? 0)
  }
}

async function launch() {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-refresh-smoke-'))
  try {
    const env = { ...process.env, DSH_REFRESH_SMOKE_HOME: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url)], { env, stdio: 'inherit', windowsHide: true })
    const [code] = await once(child, 'exit')
    process.exitCode = code ?? 1
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
if (process.versions.electron) void runElectron()
else void launch().catch(error => { console.error(error); process.exitCode = 1 })
