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
  // Compare at the actual design sizes, with live UI and no open fish profile.
  await js("Promise.all(['day','night'].map(name => { const image = new Image(); image.src = 'koi-pond-' + name + '.webp'; return image.decode(); }))");
  win.setContentSize(1723, 913);
  await delay(250);
  await fs.writeFile(join(directory, 'pond-design-day.png'), (await win.webContents.capturePage()).toPNG());
  await js("document.getElementById('light').click()");
  assert.equal(await js("document.body.classList.contains('night')"), true);
  win.setContentSize(1280, 679);
  await delay(250);
  await fs.writeFile(join(directory, 'pond-design-night.png'), (await win.webContents.capturePage()).toPNG());
  await js("document.getElementById('light').click()");
  win.setContentSize(1280, 720);
  await delay(250);
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
    const refract = window.koiWater.refract;
    window.refractionHistory = [];
    window.koiWater.refract = (source, waves) => {
      const start = performance.now(), output = refract(source, waves);
      const duration = performance.now() - start;
      let changed = 0, transparent = 0;
      for (let i = 0; i < output.length; i += 4) {
        if (!output[i + 3]) transparent++;
        else if (output[i] !== source.data[i] || output[i + 1] !== source.data[i + 1] || output[i + 2] !== source.data[i + 2]) changed++;
      }
      window.latestRefraction = { changed, transparent, duration, width: source.width, height: source.height };
      window.refractionHistory.push(window.latestRefraction);
      return output;
    };
    c.drawImage = (...args) => {
      if (args.length === 5 && args[1] === 0 && args[2] === 0) {
        window.pellets = 0; window.feedRings = []; window.latestRefraction = null;
      }
      return draw(...args);
    };
    c.ellipse = (...args) => {
      if (args[2] === 2.5) window.pellets++;
      if (args[0] === 410 && args[1] === 400) window.feedRings.push({ width: c.lineWidth, color: c.strokeStyle });
      return ellipse(...args);
    };
    document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', { clientX: 410, clientY: 400 }));\`);
  await delay(150);
  assert((await js('window.pellets')) > 0, 'Feed must create rendered pellets');
  const feedRings = await js('window.feedRings');
  assert.equal(feedRings.length, 2);
  assert(feedRings.every(ring => ring.width === 1 && ring.color.startsWith('rgba(190, 218, 194,')), 'Feeding must keep its original gentle waves');
  for (let attempt = 0; attempt < 60 && await js('window.pellets') > 0; attempt++) await delay(250);
  assert.equal(await js('window.pellets'), 0, 'Fish must eat pellets before their 25-second expiry');
  for (const theme of ['day', 'night']) {
    if (theme === 'night') await js("document.getElementById('light').click()");
    await js("document.getElementById('ripple').click(); document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', {clientX:610,clientY:400}));");
    await delay(400);
    assert.equal(await js('window.pellets'), 0);
    const refraction = await js('window.latestRefraction');
    assert(refraction.changed > 100, 'The wave must displace actual scene pixels, not draw outlines');
    assert(refraction.transparent > 100, 'Pixels outside the wave must stay untouched');
    assert(refraction.width < 1280 && refraction.height < 720, 'Only the local region should be sampled');
    await fs.writeFile(join(directory, 'pond-ripple-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
    for (let frame = 0; frame < 8; frame++) {
      await fs.writeFile(join(directory, 'refraction-' + theme + '-' + frame + '.png'),
        (await win.webContents.capturePage({ x: 450, y: 270, width: 320, height: 260 })).toPNG());
      await delay(110);
    }
    await delay(2300);
    assert.equal(await js('window.latestRefraction'), null, 'Waves must still expire');
  }
  const timings = await js('window.refractionHistory.map(sample => sample.duration).sort((a,b) => a-b)');
  const refractionTiming = { samples: timings.length, medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.floor(timings.length * .95)] };
  const overlapTiming = await js(\`(() => {
    const source = document.getElementById('pond').getContext('2d').getImageData(430, 250, 360, 320);
    const waves = Array.from({length:24}, (_,i) => ({x:180+(i%4)*5,y:160+Math.floor(i/4)*5,age:1.2}));
    const start = performance.now();
    window.koiWater.refract(source, waves);
    return performance.now() - start;
  })()\`);
  refractionTiming.overlap24KernelMs = overlapTiming;
  await fs.writeFile(join(directory, 'refraction-timing.json'), JSON.stringify(refractionTiming, null, 2));
  await js("document.getElementById('light').click()");
  await js("document.getElementById('feed').click(); document.getElementById('zen').click()");
  assert.equal(await js("document.getElementById('zen').getAttribute('aria-pressed')"), 'true');
  const onlyCanvasVisible = "Array.from(document.querySelector('main').children).filter(e => getComputedStyle(e).display !== 'none').map(e => e.id)";
  assert.deepEqual(await js(onlyCanvasVisible), ['pond']);
  await pond.recordDialogue('smoke', 'one');
  await delay(200);
  assert.deepEqual(await js(onlyCanvasVisible), ['pond'], 'Growth notifications must stay hidden in zen mode');
  assert.equal((await js('window.koiPond.getState()')).dialogues, 1);
  await fs.writeFile(join(directory, 'pond-zen.png'), (await win.webContents.capturePage()).toPNG());
  await js("document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', {button:2,clientX:350,clientY:400}))");
  await delay(100);
  assert.equal(await js('window.pellets'), 0, 'Right-click must not feed the fish');
  assert.equal(await js("document.getElementById('pond').dispatchEvent(new MouseEvent('contextmenu', {button:2,bubbles:true,cancelable:true}))"), false);
  assert.equal(await js("document.getElementById('zen').getAttribute('aria-pressed')"), 'false');
  assert.equal(await js("getComputedStyle(document.querySelector('header')).display"), 'flex');
  assert.equal(await js("getComputedStyle(document.querySelector('aside')).display"), 'block');
  assert.equal(await js("getComputedStyle(document.querySelector('footer')).display"), 'flex');
  assert.equal(await js("document.getElementById('notice').classList.contains('show')"), false);
  assert.equal(await js("document.querySelector('.fish-card[aria-pressed=true] .fish-copy').firstChild.textContent"), '荷风');
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
  assert.equal(await js("getComputedStyle(document.querySelector('aside')).overflowX"), 'hidden');
  await fs.writeFile(join(directory, 'pond-small.png'), (await win.webContents.capturePage()).toPNG());
  await js("document.getElementById('return').click()").catch(() => {});
  await delay(150);
  assert.equal(win.isDestroyed(), true, 'Return must close only the pond window');
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
      'day/night sine refraction changes pixels locally and decays', 'zen hides UI and notifications', 'right-click exits without feeding', 'zen restores UI',
      'day/night artwork decoded', 'design-size screenshots', 'return button',
      'day/night', 'deduplication', 'closed-window growth', 'reopen', 'save reload', 'small viewport'],
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
