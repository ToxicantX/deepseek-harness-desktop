// Run after build with Node 24: node scripts/smoke-koi-pond.mjs [INSTALLED_RUNTIME_DIRECTORY]
// Uses a hidden, separate Electron process and temporary saves, never the user's pond or chats.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { injectKoiPondDialogue } from '../src/koi-pond-injector.ts'
import { injectDesktopReplayClient } from '../src/conversation-replay-client-injector.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const directory = await mkdtemp(join(tmpdir(), 'dsh-koi-smoke-'))
const require = createRequire(import.meta.url)
if (process.argv[2]) {
  const base = createRequire(join(resolve(process.argv[2]), 'app/node_modules/@deepseek-ai/dsh/package.json'))
  const path = join(dirname(base.resolve('@deepseek-ai/dsh-api-session-controller')), 'client.js')
  const original = await readFile(path, 'utf8')
  let handoff
  runInNewContext(original, { window: { __ModuleLoader__: { load: value => { handoff = value } } } })
  assert(handoff, 'Installed client factory was not registered')
  const replay = injectDesktopReplayClient(handoff.factory.toString())
  assert(replay.changed, 'Existing replay adapter did not match')
  const pond = injectKoiPondDialogue(replay.source)
  assert(pond.changed, 'Pond observer did not match the installed client after replay')
  const factory = Function(`return (${pond.source})`)()
  assert.equal(typeof factory, 'function')
  // Execute the exact original prompt body, with only its API/notifier dependencies stubbed.
  const marker = 'async __dshPondOriginalPrompt(content, mode, signal, requestId) {'
  const start = pond.source.indexOf(marker)
  assert(start >= 0)
  let depth = 1, end = start + marker.length
  // The installed method has no braces in string literals; full factory parsing above guards syntax.
  for (; depth && end < pond.source.length; end++) {
    if (pond.source[end] === '{') depth++
    if (pond.source[end] === '}') depth--
  }
  const body = pond.source.slice(start + marker.length, end - 1)
  const posts = []
  const make = Function('window', 'resolvedClientTimeZone', 'randomUUID', `return ${injectKoiPondDialogue(
    `() => class { async prompt(content, mode, signal, requestId) {${body}} }`,
  ).source}`)
  const Client = make({ postMessage: message => posts.push(message), location: { origin: 'fixture' } }, () => 'Asia/Shanghai', () => 'generated')()
  const client = new Client()
  Object.assign(client, {
    sessionId: 'smoke', notifier: { markDirty() {} },
    remote: { session: { prompt: async () => ({ ok: true, value: { accepted: true } }) } },
  })
  assert.equal((await client.prompt([{ type: 'text', text: 'hello' }], 'queue', undefined, 'one')).ok, true)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].requestId, 'one')
  assert.equal(await readFile(path, 'utf8'), original)
  console.log('Installed Runtime: composed factory parses; real prompt body returns success and emits one growth event.')
}
for (const name of ['koi-pond-store', 'koi-pond-window']) {
  let source = (await readFile(join(root, 'src', name + '.ts'), 'utf8')).replace('./koi-pond-store.ts', './koi-pond-store.cjs')
  // A genuinely hidden native window throttles rAF even during automation.
  // Only the temporary test copy enables Electron's offscreen renderer.
  if (name === 'koi-pond-window') source = source.replace('webPreferences: {', 'webPreferences: { offscreen: true, backgroundThrottling: false,')
  await writeFile(join(directory, name + '.cjs'), ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText)
}
const runner = `
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { KoiPondWindow } = require('./koi-pond-window.cjs');
const root = ${JSON.stringify(root)}, directory = ${JSON.stringify(directory)};
app.setPath('userData', join(directory, 'electron'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
BrowserWindow.prototype.show = function() {};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const errors = [];
  const pond = new KoiPondWindow(join(directory, 'pond.json'), join(root, 'assets/koi-pond.html'),
    join(root, 'lib/koi-pond-preload.cjs'), error => errors.push(String(error)));
  await pond.open();
  let win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const js = source => win.webContents.executeJavaScript(source);
  await delay(800);
  assert.equal(await js("document.querySelectorAll('.fish-card').length"), 4);
  await pond.open();
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await js(\`document.querySelector('.fish-card').click();
    document.getElementById('fish-name').value = '荷风';
    document.getElementById('rename-form').requestSubmit();\`);
  await delay(200);
  assert.equal((await js('window.koiPond.getState()')).fish[0].name, '荷风');
  // Count actual rendered pellets per frame, rather than inferring feeding from a button click.
  await js(\`window.pellets = 0;
    const c = document.getElementById('pond').getContext('2d');
    const draw = c.drawImage.bind(c), ellipse = c.ellipse.bind(c);
    c.drawImage = (...args) => { window.pellets = 0; return draw(...args); };
    c.ellipse = (...args) => { if (args[2] === 2.5) window.pellets++; return ellipse(...args); };
    document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', { clientX: 410, clientY: 400 }));\`);
  await delay(150);
  assert((await js('window.pellets')) > 0, 'Feed must create rendered pellets');
  await delay(7500);
  assert.equal(await js('window.pellets'), 0, 'Fish must eat pellets before their 25-second expiry');
  await js("document.getElementById('ripple').click(); document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', {clientX:350,clientY:400}));");
  await delay(100);
  assert.equal(await js('window.pellets'), 0);
  await js("document.getElementById('light').click()");
  assert.equal(await js("document.getElementById('light').getAttribute('aria-pressed')"), 'true');
  await js("document.getElementById('light').click()");
  await pond.recordDialogue('smoke', 'one');
  await pond.recordDialogue('smoke', 'one');
  assert.equal((await js('window.koiPond.getState()')).dialogues, 1);
  await delay(350);
  await fs.writeFile(join(directory, 'pond-day.png'), (await win.webContents.capturePage()).toPNG());
  await js("document.getElementById('light').click()");
  await delay(200);
  await fs.writeFile(join(directory, 'pond-night.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(680, 520);
  await delay(200);
  assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
  await fs.writeFile(join(directory, 'pond-small.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  await pond.recordDialogue('smoke', 'closed-window');
  await pond.open();
  win = BrowserWindow.getAllWindows()[0];
  win.webContents.setBackgroundThrottling(false);
  await delay(400);
  assert.equal((await js('window.koiPond.getState()')).dialogues, 2);
  assert.equal((await js('window.koiPond.getState()')).fish[0].name, '荷风');
  await pond.stop();
  const { KoiPondStore } = require('./koi-pond-store.cjs');
  const restored = await new KoiPondStore(join(directory, 'pond.json')).view();
  assert.equal(restored.dialogues, 2);
  assert.equal(restored.fish[0].level, 3);
  assert.deepEqual(errors, []);
  await fs.writeFile(join(directory, 'result.json'), JSON.stringify({
    passed: true, checks: ['preload IPC', 'singleton window', 'rename', 'feeding and eating',
      'ripples', 'day/night', 'deduplication', 'closed-window growth', 'reopen', 'save reload', 'small viewport'],
    directory,
  }, null, 2));
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`
await writeFile(join(directory, 'runner.cjs'), runner)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [join(directory, 'runner.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timer = setTimeout(() => child.kill(), 45000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer)
assert.equal(code, 0, `Electron smoke failed; artifacts: ${directory}`)
console.log(await readFile(join(directory, 'result.json'), 'utf8'))
