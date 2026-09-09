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
  const owner = new BrowserWindow({ width: 1280, height: 720, show: false });
  await owner.loadURL('data:text/html,<textarea>draft retained</textarea>');
  const pond = new KoiPondWindow(join(directory, 'pond.json'), join(root, 'assets/koi-pond.html'),
    join(root, 'lib/koi-pond-preload.cjs'), error => errors.push(String(error)), () => owner);
  await pond.open();
  const view = owner.contentView.children.find(child => child.webContents !== owner.webContents);
  const win = { webContents: view.webContents, setSize: (...args) => owner.setSize(...args), setContentSize: (...args) => owner.setContentSize(...args) };
  win.webContents.setBackgroundThrottling(false);
  win.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  const js = source => win.webContents.executeJavaScript(source);
  await delay(800);
  await js(\`window.RealDate = Date;
    window.setPondDate = (month, hour) => {
      window.Date = class extends window.RealDate {
        constructor(...args) { super(...(args.length ? args : [2026,month,8,hour,0,0])); }
      };
      window.dispatchEvent(new Event('focus'));
    };
    window.setPondHour = hour => window.setPondDate(8, hour);
    window.setPondHour(12);\`);
  for (const [hour, expected] of [[5,'dawn'],[8,'day'],[17,'dusk'],[19,'night'],[0,'night']]) {
    await js('window.setPondHour(' + hour + ')');
    assert.equal(await js('document.body.dataset.period'), expected);
    await delay(100);
    await fs.writeFile(join(directory, 'pond-clock-' + hour + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await js("Promise.all(['koi-event-petals.webp','koi-event-firefly.webp','koi-season-autumn-leaf.webp','koi-season-winter-mist.webp'].map(source => { const image = new Image(); image.src = source; return image.decode(); }))");
  for (const [month, hour, expected, label] of [[2,12,'spring','春景'],[5,20,'summer','夏景'],[8,12,'autumn','秋景'],[11,12,'winter','冬景']]) {
    await js('window.setPondDate(' + month + ',' + hour + ')');
    assert.equal(await js('document.body.dataset.season'), expected);
    assert.equal(await js("document.getElementById('season-name').textContent"), label);
    await delay(350);
    await fs.writeFile(join(directory, 'pond-season-' + expected + '.png'), (await win.webContents.capturePage()).toPNG());
  }
  await js('window.setPondDate(8,12)');
  await js('window.setPondHour(12)');
  for (const manual of ['dawn', 'day', 'dusk', 'night']) {
    await js("document.getElementById('light').value = '" + manual + "'; document.getElementById('light').dispatchEvent(new Event('change')); window.setPondHour(9);");
    assert.equal(await js('document.body.dataset.period'), manual, 'Manual periods must ignore the clock');
  }
  win.webContents.reload();
  await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  await delay(500);
  assert.equal(await js("document.getElementById('light').value"), 'night', 'Manual setting must survive reload');
  assert.equal(await js('document.body.dataset.period'), 'night');
  await js(\`window.RealDate = Date;
    window.setPondHour = hour => {
      window.Date = class extends window.RealDate {
        constructor(...args) { super(...(args.length ? args : [2026,8,8,hour,0,0])); }
      };
      window.dispatchEvent(new Event('focus'));
    };
    document.getElementById('light').value = 'auto';
    document.getElementById('light').dispatchEvent(new Event('change'));
    window.setPondHour(12);\`);
  assert.equal(await js('document.body.dataset.period'), 'day', 'Automatic mode must resume immediately');
  assert.equal(await js("document.querySelectorAll('.fish-card').length"), 4);
  assert.deepEqual(await js("Array.from(document.querySelectorAll('.fish-card small'), node => node.textContent.match(/好奇|胆小|贪吃|安静/)?.[0])"), ['好奇', '胆小', '贪吃', '安静']);
  // Compare at the actual design sizes, with live UI and no open fish profile.
  await js("Promise.all(['koi-pond-day.webp','koi-pond-night.webp','koi-event-petals.webp','koi-event-dragonfly.webp','koi-event-frog.webp','koi-event-firefly.webp','koi-event-splash.webp','koi-season-autumn-leaf.webp','koi-season-winter-mist.webp'].map(source => { const image = new Image(); image.src = source; return image.decode(); }))");
  win.setContentSize(1723, 913);
  await delay(1000);
  await fs.writeFile(join(directory, 'pond-design-day.png'), (await win.webContents.capturePage()).toPNG());
  await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
  assert.equal(await js("document.body.classList.contains('night')"), true);
  win.setContentSize(1280, 679);
  await delay(250);
  await fs.writeFile(join(directory, 'pond-design-night.png'), (await win.webContents.capturePage()).toPNG());
  await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
  win.setContentSize(1280, 720);
  await delay(250);
  await pond.open();
  assert.equal(view.getVisible(), false);
  await pond.open();
  assert.equal(view.getVisible(), true);
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  await js(\`document.querySelector('.fish-card').click();
    document.getElementById('fish-name').value = '荷风';
    document.getElementById('rename-form').requestSubmit();\`);
  await delay(200);
  assert.equal((await js('window.koiPond.getState()')).fish[0].name, '荷风');
  assert((await js("document.getElementById('lineage').textContent")).includes('好奇：会靠近缓慢移动的指针 · 亲密度 0/100'));
  // Count actual rendered pellets per frame, rather than inferring feeding from a button click.
  await js(\`window.pellets = 0;
    const c = document.getElementById('pond').getContext('2d');
    const draw = c.drawImage.bind(c), ellipse = c.ellipse.bind(c);
    const raf = window.requestAnimationFrame.bind(window);
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
      window.latestRefraction = { changed, transparent, duration, waveCount: waves.length, width: source.width, height: source.height };
      window.refractionHistory.push(window.latestRefraction);
      return output;
    };
    window.requestAnimationFrame = callback => raf(time => {
      window.pellets = 0; window.feedRings = []; window.latestRefraction = null;
      callback(time);
    });
    c.drawImage = (...args) => draw(...args);
    c.ellipse = (...args) => {
      if (args[2] === 2.5) window.pellets++;
      if (args[0] === 410 && args[1] === 400) window.feedRings.push({ width: c.lineWidth, color: c.strokeStyle });
      return ellipse(...args);
    };
    document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', { clientX: 410, clientY: 400 }));\`);
  await delay(150);
  assert((await js('window.pellets')) > 0, 'Feed must create rendered pellets');
  const feedRings = await js('window.feedRings');
  assert.equal(feedRings.length, 0, 'Feeding must not draw the old ellipse outlines');
  assert((await js('window.latestRefraction.changed')) > 0, 'Feeding must refract actual scene pixels');
  for (let attempt = 0; attempt < 60 && await js('window.pellets') > 0; attempt++) await delay(250);
  assert.equal(await js('window.pellets'), 0, 'Fish must eat pellets before their 25-second expiry');
  assert((await js("Math.max(0, ...Object.values(JSON.parse(localStorage.getItem('koi-pond-bonds')).fish))")) >= 2, 'Eating one feeding batch must raise affinity once');
  assert(await js('window.refractionHistory.every(sample => sample.waveCount <= 3)'), 'Feeding and eating must share the wave budget');
  await delay(2700);
  for (const theme of ['day', 'night']) {
    if (theme === 'night') await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
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
  await js("for (let i = 0; i < 200; i++) document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', {clientX:610,clientY:400}));");
  await delay(100);
  assert.equal(await js('window.latestRefraction.waveCount'), 1, 'Burst clicks must create only one wave');
  for (let i = 0; i < 3; i++) {
    await delay(510);
    await js("document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', {clientX:610,clientY:400}));");
  }
  await delay(100);
  assert.equal(await js('window.latestRefraction.waveCount'), 3, 'Spaced clicks must respect the active wave cap');
  await delay(2600);
  await js("document.getElementById('pond').dispatchEvent(new PointerEvent('pointerdown', {clientX:610,clientY:400}));");
  await delay(100);
  assert.equal(await js('window.latestRefraction.waveCount'), 1, 'Input must resume after waves expire');
  await delay(2600);
  const timings = await js('window.refractionHistory.map(sample => sample.duration).sort((a,b) => a-b)');
  const refractionTiming = { samples: timings.length, medianMs: timings[Math.floor(timings.length / 2)], p95Ms: timings[Math.floor(timings.length * .95)] };
  const overlapTiming = await js(\`(() => {
    const source = document.getElementById('pond').getContext('2d').getImageData(430, 250, 360, 320);
    const waves = Array.from({length:3}, (_,i) => ({x:180+(i%4)*5,y:160+Math.floor(i/4)*5,age:1.2}));
    const start = performance.now();
    window.koiWater.refract(source, waves);
    return performance.now() - start;
  })()\`);
  refractionTiming.overlap3KernelMs = overlapTiming;
  await fs.writeFile(join(directory, 'refraction-timing.json'), JSON.stringify(refractionTiming, null, 2));
  await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
  await js("document.getElementById('feed').click(); document.getElementById('zen').click()");
  assert.equal(await js("document.getElementById('zen').getAttribute('aria-pressed')"), 'true');
  const onlyCanvasVisible = "Array.from(document.querySelector('main').children).filter(e => getComputedStyle(e).display !== 'none').map(e => e.id)";
  assert.deepEqual(await js(onlyCanvasVisible), ['pond']);
  await pond.recordDialogue('smoke', 'one');
  await delay(200);
  assert(await js("Array.from(document.querySelectorAll('.fish-card small'), node => Number(node.textContent.split('亲密 ')[1])).every(value => value >= 1)"), 'One dialogue must raise every koi affinity');
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
  await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
  assert.equal(await js("document.body.dataset.period"), 'night');
  await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
  await pond.recordDialogue('smoke', 'one');
  await pond.recordDialogue('smoke', 'one');
  assert.equal((await js('window.koiPond.getState()')).dialogues, 1);
  await delay(350);
  await fs.writeFile(join(directory, 'pond-day.png'), (await win.webContents.capturePage()).toPNG());
  await js("window.setPondHour(document.body.dataset.period === 'night' ? 12 : 20)");
  await delay(200);
  await fs.writeFile(join(directory, 'pond-night.png'), (await win.webContents.capturePage()).toPNG());
  win.setSize(680, 520);
  await delay(200);
  assert.equal(await js("document.documentElement.scrollWidth > innerWidth"), false);
  assert.equal(await js("getComputedStyle(document.querySelector('aside')).overflowX"), 'hidden');
  await fs.writeFile(join(directory, 'pond-small.png'), (await win.webContents.capturePage()).toPNG());
  await js("window.koiPond.close()").catch(() => {});
  await delay(150);
  assert.equal(owner.isDestroyed(), false, 'Return must preserve the main window');
  assert.equal(view.getVisible(), false, 'Return must hide the pond view');
  assert.equal(await owner.webContents.executeJavaScript('document.querySelector("textarea").value'), 'draft retained');
  await pond.recordDialogue('smoke', 'closed-window');
  await pond.open();
  assert.equal(owner.contentView.children.includes(view), true);
  win.webContents.setBackgroundThrottling(false);
  await delay(400);
  assert.equal((await js('window.koiPond.getState()')).dialogues, 2);
  assert.equal((await js('window.koiPond.getState()')).fish[0].name, '荷风');
  await js("Promise.all(['koi-event-petals.webp','koi-event-dragonfly.webp','koi-event-frog.webp','koi-event-firefly.webp','koi-event-splash.webp'].map(source => { const image = new Image(); image.src = source; return image.decode(); })); window.eventSpriteDraws = 0; const eventContext = document.getElementById('pond').getContext('2d'); const eventDrawImage = eventContext.drawImage.bind(eventContext); eventContext.drawImage = (...args) => { if (String(args[0]?.src || '').includes('koi-event-')) window.eventSpriteDraws++; return eventDrawImage(...args); }; true;");
  await pond.recordDialogue('smoke', 'garden-event');
  await delay(350);
  assert.equal(await js('document.body.dataset.event'), 'petals', 'The third dialogue must trigger the deterministic petal event');
  assert((await js("document.getElementById('notice').textContent")).includes('花信入池'));
  assert((await js('window.eventSpriteDraws')) > 0, 'The garden event must draw its generated image sprite');
  await fs.writeFile(join(directory, 'pond-event-petals.png'), (await win.webContents.capturePage()).toPNG());
  assert(await js("Object.values(JSON.parse(localStorage.getItem('koi-pond-bonds')).fish).every(value => value >= 2)"), 'Affinity must include dialogue growth while the pond was closed');
  const reloadAtNight = async () => {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    win.webContents.reload();
    await loaded;
    win.webContents.setBackgroundThrottling(false);
    await delay(450);
    await js("window.RealDate = Date; window.Date = class extends window.RealDate { constructor(...args) { super(...(args.length ? args : [2026,8,8,20,0,0])); } }; window.dispatchEvent(new Event('focus')); true;");
  };
  await reloadAtNight();
  await pond.recordDialogue('smoke', 'garden-event-4');
  await pond.recordDialogue('smoke', 'garden-event-5');
  await delay(150);
  assert.equal((await js('window.koiPond.getState()')).dialogues, 5);
  await reloadAtNight();
  await pond.recordDialogue('smoke', 'garden-event-6');
  await pond.recordDialogue('smoke', 'garden-event-7');
  await delay(150);
  assert.equal((await js('window.koiPond.getState()')).dialogues, 7);
  await reloadAtNight();
  await js("(async () => { await Promise.all(['koi-event-firefly.webp'].map(source => { const image = new Image(); image.src = source; return image.decode(); })); window.fireflyDraws = []; window.lastEventTranslate = [0, 0]; const context = document.getElementById('pond').getContext('2d'); const translate = context.translate.bind(context); const drawImage = context.drawImage.bind(context); context.translate = (x, y) => { window.lastEventTranslate = [x, y]; return translate(x, y); }; context.drawImage = (...args) => { if (String(args[0]?.src || '').includes('koi-event-firefly')) { window.fireflyDraws.push(window.lastEventTranslate); if (window.fireflyDraws.length > 200) window.fireflyDraws.shift(); } return drawImage(...args); }; return true; })()");
  await pond.recordDialogue('smoke', 'garden-event-8');
  await delay(250);
  assert.equal(await js('document.body.dataset.event'), 'fireflies', 'The eighth dialogue at night must trigger fireflies');
  const firstFireflyPosition = await js("window.fireflyDraws.length >= 10 ? window.fireflyDraws.slice(-10)[0] : null");
  assert(firstFireflyPosition, 'Fireflies must render a full animated frame');
  await delay(700);
  const nextFireflyPosition = await js("window.fireflyDraws.length >= 10 ? window.fireflyDraws.slice(-10)[0] : null");
  assert(Math.hypot(nextFireflyPosition[0] - firstFireflyPosition[0], nextFireflyPosition[1] - firstFireflyPosition[1]) > 3,
    'Fireflies must visibly change position instead of only blinking');
  await fs.writeFile(join(directory, 'pond-event-fireflies.png'), (await win.webContents.capturePage()).toPNG());
  await pond.stop();
  const { KoiPondStore } = require('./koi-pond-store.cjs');
  const restored = await new KoiPondStore(join(directory, 'pond.json')).view();
  assert.equal(restored.dialogues, 8);
  assert.equal(restored.fish[0].level, 9);
  assert.deepEqual(errors, []);
  await fs.writeFile(join(directory, 'result.json'), JSON.stringify({
    passed: true, checks: ['preload IPC', 'embedded view toggle', 'main window draft retained', 'rename', 'personalities and persistent affinity', 'bounded ambient art and washi UI', 'feeding and eating',
      'day/night sine refraction changes pixels locally and decays', 'zen hides UI and notifications', 'right-click exits without feeding', 'zen restores UI',
      'day/night, event, and seasonal artwork decoded', 'local-date spring/summer/autumn/winter switching', 'design-size screenshots', 'dialogue garden event image sprite', 'random firefly flight', 'floating toggle',
      'day/night', 'deduplication', 'closed-window growth', 'reopen', 'save reload', 'small viewport'],
    directory,
  }, null, 2));
  owner.destroy();
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
`
await writeFile(join(directory, 'runner.cjs'), runner)
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(require('electron'), [join(directory, 'runner.cjs')], { env, windowsHide: true, stdio: 'inherit' })
const timer = setTimeout(() => child.kill(), 90000)
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve) })
clearTimeout(timer)
assert.equal(code, 0, `Electron smoke failed; artifacts: ${directory}`)
console.log(await readFile(join(directory, 'result.json'), 'utf8'))
