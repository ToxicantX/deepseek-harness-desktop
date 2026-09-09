// After build: DSH_PLAYWRIGHT_PATH=<playwright package> node scripts/smoke-startup-surfaces.mjs <runtime directory>
// Uses a fresh DSH home and Electron profile. Never sends model requests.
import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
async function runElectron() {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const temporary = process.env.DSH_SURFACE_HOME
  assert(temporary)
  app.setPath('userData', join(temporary, 'electron'))
  const { KoiPondWindow } = require(join(temporary, 'koi-pond-window.cjs'))
  const { UsageMonitorService } = require(join(temporary, 'usage-monitor-service.cjs'))
  const { readUsageSnapshot } = require(join(temporary, 'usage-monitor.cjs'))
  let scans = 0
  const service = new UsageMonitorService(join(temporary, 'home'), (...args) => { scans++; return readUsageSnapshot(...args) })
  const initialized = service.initialize()
  let owner, usage
  const pond = new KoiPondWindow(join(temporary, 'pond.json'), join(root, 'assets/koi-pond.html'),
    join(root, 'lib/koi-pond-preload.cjs'), console.error, () => owner)
  const webPreferences = { preload: join(root, 'lib/preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  ipcMain.handle('pond:toggle', async event => {
    assert.equal(event.sender, owner.webContents)
    assert.equal(event.senderFrame, event.sender.mainFrame)
    return pond.open()
  })
  ipcMain.handle('usage-monitor:read', (event, initialize) => {
    assert.equal(event.sender, usage.webContents)
    const progress = value => event.senderFrame.send('usage-monitor:progress', value)
    return initialize ? service.initialize(progress) : service.read(progress)
  })
  await app.whenReady()
  globalThis.surfaceSmoke = {
    initialized, scans: () => scans,
    pondVisible: () => owner.contentView.children.some(view => view.webContents !== owner.webContents && view.getVisible()),
    openUsage: async () => {
      usage = new BrowserWindow({ width: 1000, height: 780, webPreferences })
      await usage.loadFile(join(root, 'assets/usage-monitor.html'))
    },
  }
  owner = new BrowserWindow({ width: 1240, height: 820, minWidth: 820, minHeight: 600, webPreferences })
  owner.setMenu(null)
  owner.on('closed', () => { void pond.stop() })
  await owner.loadURL(process.env.DSH_SURFACE_URL)
}
if (process.versions.electron) {
  void runElectron().catch(error => { console.error(error); require('electron').app.exit(1) })
} else {
  assert(process.argv[2], 'Pass an installed runtime directory')
  const { _electron } = await import(process.env.DSH_PLAYWRIGHT_PATH
    ? pathToFileURL(join(process.env.DSH_PLAYWRIGHT_PATH, 'index.mjs')).href : 'playwright')
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-startup-surfaces-'))
  const output = join(root, 'output/playwright')
  await mkdir(output, { recursive: true })
  for (const name of ['koi-pond-store', 'koi-pond-window', 'usage-monitor', 'usage-monitor-service']) {
    const source = (await readFile(join(root, 'src', name + '.ts'), 'utf8')).replaceAll('./koi-pond-store.ts', './koi-pond-store.cjs').replaceAll('./usage-monitor.ts', './usage-monitor.cjs')
    await writeFile(join(temporary, name + '.cjs'), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.CommonJS },
    }).outputText)
  }
  for (const name of ['preload', 'koi-pond-preload']) {
    assert.doesNotMatch(await readFile(join(root, 'lib', name + '.cjs'), 'utf8'), /require\(["']\.\//, 'Sandboxed preloads must be self-contained')
  }
  const home = join(temporary, 'home')
  const logs = join(home, 'sessions', 'fixture', 'usage')
  await mkdir(logs, { recursive: true })
  const log = join(logs, 'session.v2.jsonl')
  const record = seq => JSON.stringify({ type: 'assistant/message', seq, time: Date.now(), data: {
    message: { source: { kind: 'model', provider: 'fixture', model: 'fixture-model' } }, usage: { inputTokens: 10, outputTokens: 5 },
  } }) + '\n'
  await writeFile(log, JSON.stringify({ type: 'session', id: 'usage', version: 2, createdAt: Date.now() }) + '\n' + record(1))
  const directory = resolve(process.argv[2])
  const manifest = JSON.parse(await readFile(join(directory, 'runtime-manifest.json'), 'utf8'))
  const runtime = { directory, manifest, nodeExecutable: resolve(directory, manifest.paths.node),
    pnpmExecutable: resolve(directory, manifest.paths.pnpm), dshBin: resolve(directory, manifest.paths.dsh) }
  const { startBackend, desktopEnvironment } = await import('../lib/backend.js')
  let backend, electron
  try {
    const runtimeHome = join(temporary, 'runtime-home')
    await mkdir(runtimeHome)
    backend = await startBackend({ runtime, shutdownHook: resolve(root, 'lib/shutdown-hook.js'), cwd: runtimeHome,
      env: desktopEnvironment(runtime, { ...process.env, DSH_HOME: runtimeHome }) })
    const env = { ...process.env, DSH_SURFACE_HOME: temporary, DSH_SURFACE_URL: backend.url.href }
    delete env.ELECTRON_RUN_AS_NODE
    electron = await _electron.launch({ executablePath: require('electron'), args: [fileURLToPath(import.meta.url)], cwd: root, env })
    const page = await electron.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const toggle = page.getByRole('button', { name: '后院鱼塘', exact: true })
    await toggle.waitFor()
    const toggleBox = await toggle.boundingBox()
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert(toggleBox && toggleBox.x + toggleBox.width > viewport.width - 80 && toggleBox.y + toggleBox.height > viewport.height - 80)
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByRole('button', { name: '稍后配置', exact: true }).click()
    const waitForPond = async visible => {
      for (let attempt = 0; attempt < 100; attempt++) {
        if (await electron.evaluate(() => globalThis.surfaceSmoke.pondVisible()) === visible) return
        await new Promise(resolve => setTimeout(resolve, 30))
      }
      throw new Error('Pond visibility did not become ' + visible)
    }
    await page.screenshot({ path: join(output, 'startup-main.png') })
    console.log('MAIN UI:', (await page.locator('body').innerText()).slice(0, 1200))
    await electron.evaluate(async () => { await globalThis.surfaceSmoke.initialized })
    assert.equal(await electron.evaluate(() => globalThis.surfaceSmoke.scans()), 1)
    // Keep the same page and verify that toggling never navigates or creates a window.
    const url = page.url()
    const opened = electron.context().waitForEvent('page')
    await toggle.click()
    const pond = await opened
    await pond.waitForURL('**/koi-pond.html')
    const pondToggle = pond.getByRole('button', { name: '切换回对话', exact: true })
    await pondToggle.waitFor()
    const pondToggleBox = await pondToggle.boundingBox()
    const pondViewport = await pond.evaluate(() => ({ width: innerWidth, height: innerHeight }))
    assert(pondToggleBox && pondToggleBox.x + pondToggleBox.width > pondViewport.width - 80 && pondToggleBox.y + pondToggleBox.height > pondViewport.height - 80)
    await waitForPond(true)
    const waitForCanvas = () => pond.waitForFunction(() => {
      const canvas = document.querySelector('#pond')
      return canvas.width > 0 && canvas.getContext('2d').getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data[3] > 0
    })
    await waitForCanvas()
    await pond.evaluate(() => {
      window.surfaceDraws = 0
      const context = document.querySelector('#pond').getContext('2d')
      const draw = context.drawImage.bind(context)
      context.drawImage = (...args) => { window.surfaceDraws++; return draw(...args) }
    })
    assert.equal(await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1)
    await pond.screenshot({ path: join(output, 'startup-pond.png') })
    await pondToggle.click()
    await waitForPond(false)
    await new Promise(resolve => setTimeout(resolve, 100))
    const pausedDraws = await pond.evaluate(() => window.surfaceDraws)
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.equal(await pond.evaluate(() => window.surfaceDraws), pausedDraws, 'Hidden pond must stop drawing')
    assert.equal(page.url(), url)
    await toggle.click()
    await waitForPond(true)
    await waitForCanvas()
    await pond.waitForFunction(paused => window.surfaceDraws > paused, pausedDraws)
    await pondToggle.focus()
    await pond.keyboard.press('Escape')
    await waitForPond(false)
    await electron.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(820, 600))
    await page.screenshot({ path: join(output, 'startup-main-small.png') })
    await toggle.click()
    await waitForPond(true)
    await waitForCanvas()
    await pond.screenshot({ path: join(output, 'startup-pond-small.png') })
    await pondToggle.click()
    await electron.evaluate(() => globalThis.surfaceSmoke.openUsage())
    const usage = electron.context().pages().find(current => current.url().endsWith('/usage-monitor.html'))
    assert(usage)
    await usage.waitForFunction(() => document.querySelector('#usage-requests').textContent === '1')
    assert.equal(await electron.evaluate(() => globalThis.surfaceSmoke.scans()), 1, 'Opening must reuse startup scan')
    await appendFile(log, record(2))
    await usage.locator('#usage-refresh').click()
    await usage.waitForFunction(() => document.querySelector('#usage-requests').textContent === '2')
    assert.equal(await electron.evaluate(() => globalThis.surfaceSmoke.scans()), 2)
    await usage.screenshot({ path: join(output, 'startup-usage.png') })
    assert.deepEqual(errors, [])
    console.log('PASS: startup once, open reuses snapshot, refresh reads new usage, real DSH floating entry, one native window, return/Escape/reopen, nonblank canvas, animation pauses/resumes, 1240/820px')
  } finally {
    await electron?.close()
    await backend?.stop()
    console.log('Isolated profile retained:', temporary)
  }
}
