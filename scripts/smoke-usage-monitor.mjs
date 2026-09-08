// Run after pnpm run build: node scripts/smoke-usage-monitor.mjs
// Optional screenshots: DSH_USAGE_SCREENSHOT_DIR=<directory>. No server is started.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
async function runElectron() {
  const { app, BrowserWindow, ipcMain } = await import('electron')
  const temporary = process.env.DSH_USAGE_SMOKE_HOME
  assert(temporary, 'Run this smoke through its Node launcher')
  app.setPath('userData', join(temporary, 'electron'))
  const screenshotDirectory = process.env.DSH_USAGE_SCREENSHOT_DIR
  const deadline = setTimeout(() => { console.error('Usage smoke timed out'); app.exit(1) }, 60_000)
  let window
  try {
    const compiled = ts.transpileModule(await readFile(join(root, 'src/usage-monitor.ts'), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2024, module: ts.ModuleKind.ESNext },
    }).outputText
    const module = join(temporary, 'usage.mjs')
    await writeFile(module, compiled)
    const { readUsageSnapshot } = await import(pathToFileURL(module).href)
    const home = join(temporary, 'home')
    const logDirectory = join(home, 'sessions', 'workspace', 'session')
    await mkdir(logDirectory, { recursive: true })
    const now = Date.now()
    const records = [{ type: 'session', id: 'session', version: 2, createdAt: now, isSeeded: false }]
    for (let index = 0; index < 9; index++) {
      records.push({ type: 'assistant/message', seq: index, time: now - index * 86400000,
        data: { message: { source: { kind: 'model', provider: index % 2 ? 'custom-provider' : 'deepseek-official', model: index % 2 ? 'long-custom-model-name-with-a-large-context-window' : 'deepseek-v4-flash' } },
          usage: { inputTokens: 1234567, outputTokens: 32876, cacheReadTokens: 876543, cacheWriteTokens: 1400, reasoningTokens: 1024 } } })
    }
    await writeFile(join(logDirectory, 'session.v2.jsonl'), records.map(record => JSON.stringify(record)).join(String.fromCharCode(10)) + String.fromCharCode(10))
    let fail = false
    let empty = false
    let large = false
    let firstScan = true
    let releaseScan
    ipcMain.handle('usage-monitor:read', async event => {
      if (fail) throw new Error('Intentional smoke-test read failure')
      if (firstScan) {
        firstScan = false
        event.senderFrame.send('usage-monitor:progress', { phase: 'discovering', discoveredFiles: 12, processedFiles: 0, totalFiles: 0, currentFile: '', percent: 0 })
        await new Promise(resolve => { releaseScan = resolve })
      }
      const result = await readUsageSnapshot(empty ? join(temporary, 'empty') : home, progress => event.senderFrame.send('usage-monitor:progress', progress))
      if (large) {
        for (const range of Object.values(result.ranges)) {
          range.totalTokens = 9007199254740991
          for (const model of range.models) model.model = 'very-long-model-name-'.repeat(10)
        }
      }
      return result
    })
    console.log('Fixture ready; waiting for Electron')
    await app.whenReady()
    console.log('Electron ready')
    window = new BrowserWindow({ width: 1000, height: 780, show: true,
      webPreferences: { preload: join(root, 'lib/preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } })
    const failures = []
    window.webContents.on('preload-error', (_event, _path, error) => failures.push(error.message))
    window.webContents.on('console-message', (_event, level, message) => { if (level >= 3 && !message.includes('Intentional')) failures.push(message) })
    const evaluate = source => window.webContents.executeJavaScript(source)
    const waitForRead = () => evaluate('new Promise((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (!document.getElementById("usage-refresh").disabled) resolve(true); else if (Date.now() > end) reject(new Error("read timeout")); else setTimeout(check, 20) }; check() })')
    const refresh = async () => { await evaluate('document.getElementById("usage-refresh").click()'); await waitForRead() }
    await window.loadFile(join(root, 'assets/usage-monitor.html'))
    console.log('Usage page loaded')
    await evaluate('new Promise((resolve, reject) => { const end = Date.now() + 5000; const check = () => { if (document.getElementById("usage-progress-label").textContent.includes("12 个")) resolve(); else if (Date.now() > end) reject(new Error("progress timeout")); else setTimeout(check, 20) }; check() })')
    assert.equal(await evaluate('document.getElementById("usage-progress").hasAttribute("value")'), false)
    window.webContents.mainFrame.send('usage-monitor:progress', { phase: 'scanning', discoveredFiles: 24, processedFiles: 12, totalFiles: 24, currentFile: 'sessions/--E-AI-deepseek-harness-desktop--/session-example/session.v2.jsonl.zstd', percent: 50 })
    await new Promise(resolve => setTimeout(resolve, 1100))
    assert.equal(await evaluate('document.getElementById("usage-progress").value'), 50)
    assert.equal(await evaluate('document.getElementById("usage-progress-file").textContent.includes("session.v2.jsonl.zstd")'), true)
    assert.equal(await evaluate('document.getElementById("usage-elapsed").textContent.includes("1 秒")'), true)
    for (const width of [1000, 640]) {
      window.setContentSize(width, 780)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Progress overflow at ' + width)
      if (screenshotDirectory) {
        await mkdir(screenshotDirectory, { recursive: true })
        await writeFile(join(screenshotDirectory, 'usage-progress-' + width + '.png'), (await window.webContents.capturePage()).toPNG())
      }
    }
    releaseScan()
    await waitForRead()
    assert.equal(await evaluate('document.getElementById("usage-progress-status").hidden'), true)
    assert.equal(await evaluate('document.getElementById("usage-requests").textContent'), '1')
    await evaluate('document.querySelector("[data-range=all]").click()')
    assert.equal(await evaluate('document.getElementById("usage-requests").textContent'), '9')
    assert.equal(await evaluate('document.querySelectorAll("#usage-models tr").length'), 2)
    assert.equal(await evaluate('document.querySelectorAll(".bar").length'), 9)
    assert.equal(await evaluate('document.body.innerText.includes("余额") || document.body.innerText.includes("花费")'), false)
    for (const width of [1000, 640, 390]) {
      window.setContentSize(width, 900)
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Page overflow at ' + width)
      assert.equal(await evaluate('Array.from(document.querySelectorAll(".metric dd, .breakdown dd")).every(node => node.scrollWidth <= node.clientWidth)'), true, 'Metric overflow at ' + width)
      if (screenshotDirectory) {
        await mkdir(screenshotDirectory, { recursive: true })
        await writeFile(join(screenshotDirectory, 'usage-' + width + '.png'), (await window.webContents.capturePage()).toPNG())
      }
    }
    large = true
    await refresh()
    assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true, 'Long labels overflow')
    assert.equal(await evaluate('Array.from(document.querySelectorAll(".metric dd")).every(node => node.scrollWidth <= node.clientWidth)'), true, 'Large counts overflow')
    large = false
    fail = true
    await refresh()
    await evaluate('document.querySelector("[data-range=today]").click()')
    assert.equal(await evaluate('document.getElementById("usage-status").dataset.kind'), 'error')
    assert.equal(await evaluate('document.getElementById("usage-status").textContent.includes("上次成功")'), true)
    fail = false
    empty = true
    await refresh()
    assert.equal(await evaluate('document.getElementById("usage-model-empty").hidden'), false)
    assert.equal(await evaluate('document.getElementById("usage-requests").textContent'), '0')
    await window.reload()
    await waitForRead()
    assert.equal(await evaluate('document.getElementById("usage-status").dataset.kind'), 'normal')
    assert.deepEqual(failures, [])
    console.log('PASS: dynamic progress and elapsed time, v2 logs, sandboxed built preload, local usage IPC, range switching, model values, charts, 1000/640/390px, long content, stale/error/empty states, reload')
  } catch (error) {
    console.error(error)
    process.exitCode = 1
  } finally {
    clearTimeout(deadline)
    if (window && !window.isDestroyed()) window.destroy()
    ipcMain.removeHandler('usage-monitor:read')
    // The Node launcher removes the profile after Electron releases its file handles.
    app.exit(process.exitCode ?? 0)
  }
}

async function launch() {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-usage-smoke-'))
  try {
    const env = { ...process.env, DSH_USAGE_SMOKE_HOME: temporary }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(createRequire(import.meta.url)('electron'), [fileURLToPath(import.meta.url)], { env, stdio: 'inherit' })
    const [code] = await once(child, 'exit')
    process.exitCode = code ?? 1
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
if (process.versions.electron) void runElectron()
else void launch().catch(error => { console.error(error); process.exitCode = 1 })
