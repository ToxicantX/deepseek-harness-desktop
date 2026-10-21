// Run after build. Use --playwright <module path> when Playwright is not installed locally.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

async function runElectron() {
  const { app, BrowserWindow, ipcMain, safeStorage } = await import('electron')
  app.setPath('userData', join(process.env.DSH_SEARCH_SMOKE_HOME, 'electron'))
  await app.whenReady()
  const module = join(process.env.DSH_SEARCH_SMOKE_HOME, 'search-settings.mjs')
  const { SearchSettings } = await import(pathToFileURL(module).href)
  const path = join(process.env.DSH_SEARCH_SMOKE_HOME, 'search.bin')
  const settings = new SearchSettings(path, safeStorage)
  globalThis.searchSmoke = { approve: true, fail: false, writes: 0 }
  ipcMain.handle('search-settings:read', () => settings.read())
  ipcMain.handle('search-settings:save', async (_event, value) => {
    if (globalThis.searchSmoke.fail) throw new Error('Intentional save failure')
    if (!globalThis.searchSmoke.approve) return { saved: false, settings: await settings.read() }
    const view = await settings.save(value)
    globalThis.searchSmoke.writes++
    assert.equal((await readFile(path)).includes(Buffer.from('fixture-exa-key')), false)
    return { saved: true, settings: view }
  })
  const window = new BrowserWindow({ width: 640, height: 720, show: false,
    webPreferences: { preload: resolve('lib/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } })
  await window.loadFile(resolve('assets/search-settings.html'))
}

async function launch() {
  const output = resolve('output/playwright/search-settings')
  await mkdir(output, { recursive: true })
  const temporary = await mkdtemp(join(output, '.smoke-'))
  let application
  try {
    await mkdir(join(temporary, 'electron'))
    await writeFile(join(temporary, 'search-settings.mjs'), ts.transpileModule(await readFile(new URL('../src/search-settings.ts', import.meta.url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText)
    const index = process.argv.indexOf('--playwright')
    const module = index >= 0 ? pathToFileURL(resolve(process.argv[index + 1])).href : 'playwright'
    const { _electron } = await import(module)
    const env = { ...process.env, DSH_SEARCH_SMOKE_HOME: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    const flags = process.argv.includes('--no-sandbox') ? ['--no-sandbox', '--disable-gpu'] : []
    application = await _electron.launch({ executablePath: createRequire(import.meta.url)('electron'), args: [...flags, fileURLToPath(import.meta.url)], env, timeout: 30_000 })
    const page = await application.firstWindow()
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.waitForSelector('#search-save:not(:disabled)')
    assert.equal(await page.locator('#search-provider').inputValue(), 'auto')
    await page.locator('#search-provider').selectOption('exa')
    await page.locator('#search-exa-key').fill('fixture-exa-key')
    await page.locator('#search-save').click()
    await page.waitForSelector('#search-status[data-kind="success"]')
    assert.equal(await page.locator('#search-exa-key').inputValue(), '')
    assert.match(await page.locator('#search-exa-key').getAttribute('placeholder'), /已保存/)
    await application.evaluate(() => { globalThis.searchSmoke.approve = false })
    await page.locator('#search-provider').selectOption('auto')
    await page.locator('#search-save').click()
    await page.waitForFunction(() => document.querySelector('#search-status').textContent.includes('已取消'))
    assert.equal(await application.evaluate(() => globalThis.searchSmoke.writes), 1)
    await page.locator('#search-reload').click()
    await page.waitForFunction(() => document.querySelector('#search-provider').value === 'exa')
    await application.evaluate(() => { globalThis.searchSmoke.fail = true })
    await page.locator('#search-save').click()
    await page.waitForSelector('#search-status[data-kind="error"]')
    await application.evaluate(() => { globalThis.searchSmoke.fail = false; globalThis.searchSmoke.approve = true })
    await page.locator('#search-provider').selectOption('perplexity')
    assert.equal(await page.locator('#search-perplexity-details').getAttribute('open'), '')
    await page.locator('#search-perplexity-key').fill('fixture-perplexity-key')
    await page.locator('#search-save').click()
    await page.waitForSelector('#search-status[data-kind="success"]')
    await page.locator('#search-exa-remove').check()
    await page.locator('#search-save').click()
    await page.waitForFunction(() => document.querySelector('#search-exa-key').placeholder === '未保存密钥')
    for (const width of [640, 380]) {
      await page.setViewportSize({ width, height: 760 })
      await page.waitForFunction(width => innerWidth === width, width)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
      assert.equal(await page.evaluate(() => [...document.querySelectorAll('input, select, button')].every(node => node.getBoundingClientRect().right <= innerWidth)), true)
      await page.screenshot({ path: join(output, 'search-' + width + '.png'), fullPage: true })
    }
    assert.deepEqual(errors, [])
    console.log('PASS: Playwright Electron, context-isolated built preload, real Windows encrypted storage, save/preserve/remove keys, cancel, failure, reload, provider selection, 640/380px screenshots; Chromium sandbox=' + !process.argv.includes('--no-sandbox'))
  } finally {
    await application?.close()
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}

if (process.versions.electron) void runElectron().catch(async error => { console.error(error); (await import('electron')).app.exit(1) })
else void launch().catch(error => { console.error(error); process.exitCode = 1 })
