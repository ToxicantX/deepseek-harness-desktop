import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KoiPondStore, POND_CAPACITY, type PondState } from '../src/koi-pond-store.ts'
import { injectKoiPondDialogue, installKoiPondDialogueHook } from '../src/koi-pond-injector.ts'
import { installConversationReplayModuleHook } from '../src/conversation-replay-injector.ts'

const directories: string[] = []
async function fixture(level?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'koi-pond-test-'))
  directories.push(directory)
  const path = join(directory, 'pond.json')
  const store = new KoiPondStore(path)
  await store.view()
  if (level !== undefined) {
    const saved: PondState = JSON.parse(await readFile(path, 'utf8'))
    saved.fish.forEach(f => { f.level = level })
    await writeFile(path, JSON.stringify(saved))
    return { store: new KoiPondStore(path), path }
  }
  return { store, path }
}
afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

describe('shell koi persistence and growth', () => {
  it('creates four named fish and returns an isolated view without deduplication IDs', async () => {
    const { store } = await fixture()
    const view = await store.view()
    expect(view.fish.map(f => f.name)).toEqual(['丹枫', '墨雪', '小金', '浅葱'])
    expect(view).not.toHaveProperty('recentIds')
    view.fish[0]!.level = 999
    expect((await store.view()).fish[0]!.level).toBe(0)
  })

  it('serializes successful messages, deduplicates by session/request, and survives reopening', async () => {
    const { store, path } = await fixture()
    expect(await Promise.all([
      store.recordDialogue('a', '1'), store.recordDialogue('a', '1'),
      store.recordDialogue('a', '2'), store.recordDialogue('b', '1'),
    ])).toEqual([true, false, true, true])
    const restored = new KoiPondStore(path)
    expect(await restored.recordDialogue('a', '1')).toBe(false)
    expect(await restored.view()).toMatchObject({ dialogues: 3, fish: Array.from({ length: 4 }, () => ({ level: 3 })) })
  })

  it('retains valid long and escaped request IDs across restarts', async () => {
    const { store, path } = await fixture()
    await store.recordDialogue('"'.repeat(128), '\\'.repeat(128))
    expect((await new KoiPondStore(path).view()).dialogues).toBe(1)
    expect(await store.recordDialogue('', 'x')).toBe(false)
    expect(await store.recordDialogue('a', 'x'.repeat(129))).toBe(false)
  })

  it('pairs mature opposite sexes once and hatches after five additional dialogues', async () => {
    const { store } = await fixture(498)
    await store.recordDialogue('a', '1')
    expect((await store.view()).eggs).toHaveLength(0)
    await store.recordDialogue('a', '2')
    const born = await store.view()
    expect(born.eggs).toHaveLength(2)
    expect(born.eggs.every(e => e.remaining === 5)).toBe(true)
    for (let i = 0; i < 4; i++) await store.recordDialogue('a', `incubate-${i}`)
    expect((await store.view()).fish).toHaveLength(4)
    await store.recordDialogue('a', 'hatch')
    const hatched = await store.view()
    expect(hatched.eggs).toHaveLength(0)
    expect(hatched.fish).toHaveLength(6)
    expect(hatched.fish.slice(4).every(f => f.level === 0 && f.generation === 2)).toBe(true)
    await store.recordDialogue('a', 'after')
    expect((await store.view()).eggs).toHaveLength(0)
  })

  it('does not breed same-sex fish or exceed the combined fish and egg capacity', async () => {
    const { path } = await fixture(500)
    const saved: PondState = JSON.parse(await readFile(path, 'utf8'))
    saved.fish.forEach(f => { f.sex = 'female' })
    await writeFile(path, JSON.stringify(saved))
    const females = new KoiPondStore(path)
    await females.recordDialogue('a', 'female')
    expect((await females.view()).eggs).toHaveLength(0)
    saved.fish = Array.from({ length: POND_CAPACITY - 1 }, (_, i) => ({
      ...saved.fish[0]!, id: `fish-${i}`, sex: i % 2 ? 'male' : 'female',
    }))
    await writeFile(path, JSON.stringify(saved))
    const crowded = new KoiPondStore(path)
    await crowded.recordDialogue('a', 'crowded')
    expect((await crowded.view()).eggs).toHaveLength(1)
    for (let i = 0; i < 6; i++) await crowded.recordDialogue('a', `${i}`)
    expect((await crowded.view()).fish).toHaveLength(16)
    expect((await crowded.view()).eggs).toHaveLength(0)
  })

  it('persists names and rejects empty, overlong and control-character names', async () => {
    const { store, path } = await fixture()
    const id = (await store.view()).fish[0]!.id
    for (const name of ['', ' ', '鱼'.repeat(17), '鱼\n塘']) expect(await store.renameFish(id, name)).toBe(false)
    expect(await store.renameFish('missing', '小鱼')).toBe(false)
    expect(await store.renameFish(id, ' 荷风 ')).toBe(true)
    expect((await new KoiPondStore(path).view()).fish[0]!.name).toBe('荷风')
  })

  it('preserves corrupt files rather than silently resetting progress', async () => {
    const { path } = await fixture()
    await writeFile(path, '{broken')
    const store = new KoiPondStore(path)
    await expect(store.view()).rejects.toThrow()
    await expect(store.recordDialogue('a', '1')).rejects.toThrow()
    expect(await readFile(path, 'utf8')).toBe('{broken')
  })

  it('keeps in-memory progress unchanged after failed writes and accepts a later retry', async () => {
    const { store, path } = await fixture()
    await mkdir(path + '.tmp')
    await expect(store.recordDialogue('a', '1')).rejects.toThrow()
    expect((await store.view()).dialogues).toBe(0)
    await rm(path + '.tmp', { recursive: true })
    expect(await store.recordDialogue('a', '1')).toBe(true)
    expect((await store.view()).dialogues).toBe(1)
  })
})

describe('koi dialogue observer', () => {
  it('ships both painted scenes and the ornamental UI as local packaged assets', async () => {
    const html = await readFile(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    const css = await readFile(new URL('../assets/koi-pond.css', import.meta.url), 'utf8')
    for (const theme of ['day', 'night']) {
      const image = await readFile(new URL(`../assets/koi-pond-${theme}.webp`, import.meta.url))
      expect(image.toString('ascii', 0, 4)).toBe('RIFF')
      expect(image.toString('ascii', 8, 12)).toBe('WEBP')
      expect(html).toContain(`href="koi-pond-${theme}.webp"`)
    }
    for (const decoration of ['lotus', 'frame']) {
      const name = `koi-pond-${decoration}.svg`
      expect(css).toContain(name)
      expect(await readFile(new URL(`../assets/${name}`, import.meta.url), 'utf8')).toContain('<svg')
    }
    expect(html).not.toContain('id="return"')
    expect(html).toContain('id="running-sessions"')
    expect(html).toContain('id="zen"')
    expect(html).toContain('id="light"')
    const windowSource = await readFile(new URL('../src/koi-pond-window.ts', import.meta.url), 'utf8')
    expect(windowSource).toContain("partition: 'persist:koi-pond'")
  })

  it('uses a trusted floating entry and includes the local page and preload in packaging', async () => {
    const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
    expect(main).not.toContain("{ label: '后院鱼塘', click:")
    expect(main).toContain("ipcMain.handle('pond:toggle'")
    expect(main).toContain("if (!fromTrustedDshWindow(event) || event.senderFrame !== event.sender.mainFrame) throw new Error('鱼塘切换来源无效')")
    const preload = await readFile(new URL('../src/preload.ts', import.meta.url), 'utf8')
    expect(preload).toContain("installKoiPondToggle(() => ipcRenderer.invoke('pond:toggle'))")
    const config = await readFile(new URL('../tsdown.config.ts', import.meta.url), 'utf8')
    expect(config).toContain("'src/koi-pond-preload.ts'")
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(manifest.build.files).toContain('assets/*')
    expect(manifest.build.files).toContain('lib/*.cjs')
    const html = await readFile(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    expect(html).toContain('src="koi-pond.js"')
    expect(html).toContain('href="koi-pond.css"')
    expect(html).toContain('id="running-sessions"')
    expect(html).not.toContain('id="return"')
    expect(main).toContain("ipcMain.on('pond:session-running'")
  })

  it('uses the koi pond image asset for the floating toggle', async () => {
    const source = await readFile(new URL('../src/koi-pond-toggle.ts', import.meta.url), 'utf8')
    expect(source).toContain("import { KOI_POND_TOGGLE_ICON } from './koi-pond-toggle-icon.ts'")
    expect(source).toContain('background-image: url(')
    expect(source).not.toContain("button.textContent = '\\u6c60'")
  })

  function client(body = 'return { ok: true };', signature = 'content, mode, signal, requestId') {
    const source = `() => class { async prompt(${signature}) { ${body} } }`
    const transformed = injectKoiPondDialogue(source)
    expect(transformed.changed).toBe(true)
    expect(injectKoiPondDialogue(transformed.source).changed).toBe(false)
    return new (Function(`return (${transformed.source})`)()())()
  }
  it.each(['content, mode', 'content, mode, signal, requestId'])('observes accepted main-session messages: %s', async signature => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const session = client('return { ok: true };', signature)
    session.sessionId = 'main'
    expect(await session.prompt('hello', 'queue', undefined, 'request')).toEqual({ ok: true })
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh/pond-dialogue', sessionId: 'main', requestId: 'request' }, 'https://fixture.invalid')
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh/session-running', sessionId: 'main', requestId: 'request', running: true }, 'https://fixture.invalid')
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh/session-running', sessionId: 'main', requestId: 'request', running: false }, 'https://fixture.invalid')
  })

  it('does not count failed or child-session prompts; preserves errors and arguments', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const failed = client('return { ok: false, args: [...arguments] };')
    expect(await failed.prompt('hello', 'queue', 1, 'id')).toEqual({ ok: false, args: ['hello', 'queue', 1, 'id'] })
    const child = client(); child.address = 'child'
    await child.prompt('hello')
    await expect(client('throw new Error("send failed");').prompt('hello')).rejects.toThrow('send failed')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'dsh/session-running', running: true }), 'https://fixture.invalid')
    expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'dsh/session-running', running: false }), 'https://fixture.invalid')
  })

  it('keeps a session visible until its running snapshot reports completion', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const source = `() => class {
      sessionId = 'running-session';
      running = true;
      getSnapshot() { return { running: this.running }; }
      subscribe(listener) { this.listener = listener; return () => { this.listener = undefined; }; }
      async prompt(content, mode, signal, requestId) { return { ok: true }; }
    }`
    const transformed = injectKoiPondDialogue(source)
    expect(transformed.changed).toBe(true)
    const session = new (Function(`return (${transformed.source})`)()())()
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh/session-running', sessionId: 'running-session', requestId: 'request', running: true }, 'https://fixture.invalid')
    session.running = false
    session.listener()
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh/session-running', sessionId: 'running-session', requestId: 'request', running: false }, 'https://fixture.invalid')
  })

  it('keeps accepted messages successful if the pond observer breaks', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('window', { postMessage: () => { throw Error('observer failed') }, location: { origin: 'fixture' } })
    expect(await client().prompt('hello')).toEqual({ ok: true })
    expect(injectKoiPondDialogue('unmatched runtime').changed).toBe(false)
  })

  it('composes with existing factory transforms and retains them if a later transform fails', () => {
    vi.stubGlobal('__ModuleLoader__', undefined)
    vi.stubGlobal('__dshDesktopConversationReplayHook', undefined)
    vi.stubGlobal('__dshPondDialogueInstalled', undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installConversationReplayModuleHook()
    const root = globalThis as any
    const hook = root.__dshDesktopConversationReplayHook
    hook.registerModuleFactoryTransform('@deepseek-ai/dsh-client-runtime', (factory: Function) =>
      Function(`return (${factory.toString().replace('"original"', '"earlier"')})`)())
    const serialized = Function(`return (${installKoiPondDialogueHook.toString()})`)()
    expect(serialized(injectKoiPondDialogue.toString())).toBe('installed')
    hook.registerModuleFactoryTransform('@deepseek-ai/dsh-client-runtime', () => { throw Error('bad later transform') })
    const load = vi.fn()
    root.__ModuleLoader__ = { load }
    root.__ModuleLoader__.load({
      id: '@deepseek-ai/dsh-client-runtime',
      factory: Function('return () => class { name = "original"; async prompt(content, mode) { return {ok: true}; } }')(),
    })
    const factory = load.mock.calls[0]![0].factory
    expect(new (factory())().name).toBe('earlier')
    expect(new (factory())().__dshPondOriginalPrompt).toBeTypeOf('function')
  })
})
