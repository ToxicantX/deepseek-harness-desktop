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
  // The injected hook caches its document state on the global object, so each test
  // must start from a document with no published running set.
  delete (globalThis as Record<string, unknown>).__dshPondRunning
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
    const css = await readFile(new URL('../assets/koi-pond.css', import.meta.url), 'utf8')
    expect(css).toMatch(/aside\s*\{[^}]*overflow-y:\s*auto/)
    expect(html).toContain('id="running-sessions"')
    expect(html).not.toContain('id="return"')
    expect(main).toContain("ipcMain.on('pond:session-running-set'")
  })

  it('wires the pond clear controls through the shell down to the running list', async () => {
    const html = await readFile(new URL('../assets/koi-pond.html', import.meta.url), 'utf8')
    const script = await readFile(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
    const css = await readFile(new URL('../assets/koi-pond.css', import.meta.url), 'utf8')
    const preload = await readFile(new URL('../src/koi-pond-preload.ts', import.meta.url), 'utf8')
    const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
    const windowSource = await readFile(new URL('../src/koi-pond-window.ts', import.meta.url), 'utf8')
    expect(html).toContain('<button id="clear-running-sessions" class="running-clear-all" title="清空执行任务">清空</button>')
    expect(script).toContain("remove.className = 'running-item-remove'")
    expect(script).toContain("remove.title = '移除此项'")
    expect(script).toContain('bridge?.clearRunningSession?.(item.id)')
    expect(script).toContain('bridge?.clearAllRunningSessions?.()')
    expect(css).toContain('.running-item-remove')
    expect(preload).toContain("ipcRenderer.send('pond:clear-running-session', sessionId)")
    expect(preload).toContain("ipcRenderer.send('pond:clear-all-running-sessions')")
    expect(main).toContain("ipcMain.on('pond:clear-running-session'")
    expect(main).toContain("ipcMain.on('pond:clear-all-running-sessions'")
    expect(main).toContain("koiPond?.clearRunningSession(sessionId)")
    expect(main).toContain("koiPond?.clearAllRunningSessions()")
    const clearOne = /clearRunningSession\(sessionId: string\): void \{[\s\S]*?sendRunningSessions\(\)/.exec(windowSource)?.[0]
    const clearAll = /clearAllRunningSessions\(\): void \{[\s\S]*?sendRunningSessions\(\)/.exec(windowSource)?.[0]
    expect(clearOne).toContain('this.runningSessions.filter(session => session.id !== sessionId)')
    expect(clearAll).toContain('this.runningSessions = []')
    // Dismissing a row no longer deletes anything inside the shell: it hides that run until the
    // session genuinely runs again, so the clear handlers only forward to the pond window.
    expect(main).not.toContain('runningSessions.delete')
    expect(main).not.toContain('runningSessions.clear()')
    // A reloaded chat page resets the tracked set, and stale frames can never revive a session.
    expect(main).toContain("runningSnapshot = { epoch: '', seq: -1, sessions: [] }")
    expect(main).toContain('seq <= runningSnapshot.seq')
    expect(main).toContain("ipcMain.on('pond:session-running-set'")
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
  /**
   * The Runtime's session list projection: the hook reads the authoritative running bit from
   * here, exactly as the installed controller exposes it (projectList -> byId[id].running).
   */
  /** `extra` is shared by every listed id, or computed per id for mixed main/child sets. */
  function runtimeList(ids: string[] = [], extra: Record<string, unknown> | ((id: string) => Record<string, unknown>) = {}) {
    const listeners = new Set<() => void>()
    const state = { running: true, ids, extra }
    const list = {
      getSnapshot: () => {
        const byId: Record<string, unknown> = {}
        for (const id of state.ids) {
          byId[id] = { id, running: state.running, ...(typeof state.extra === 'function' ? state.extra(id) : state.extra) }
        }
        return { byId }
      },
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
    return { state, list, notify: () => { for (const listener of [...listeners]) listener() } }
  }
  /** Mirrors the runtime controller: the pond hook only sees what subscribe/getSnapshot report. */
  function runtimeClient(body: string, binding?: ReturnType<typeof runtimeList>) {
    const source = `() => class {
      sessionId = 'runtime-session';
      running = false;
      getSnapshot() { return { running: this.running }; }
      subscribe(listener) { this.listener = listener; return () => { this.listener = undefined; }; }
      async prompt(content, mode, signal, requestId) { ${body} }
    }`
    const transformed = injectKoiPondDialogue(source)
    expect(transformed.changed).toBe(true)
    const session = new (Function(`return (${transformed.source})`)()())()
    if (binding) session.actx = { sessions: { list: binding.list } }
    return session
  }
  const runningSets = (postMessage: ReturnType<typeof vi.fn>) => postMessage.mock.calls
    .map(([data]) => data)
    .filter(data => data?.type === 'dsh/session-running-set')
  const lastSet = (postMessage: ReturnType<typeof vi.fn>) => runningSets(postMessage).at(-1)
  const lastIds = (postMessage: ReturnType<typeof vi.fn>) =>
    (lastSet(postMessage)?.sessions ?? []).map((session: any) => session.id).sort()

  it.each(['content, mode', 'content, mode, signal, requestId'])('observes accepted main-session messages: %s', async signature => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const binding = runtimeList()
    const session = client('return { ok: true };', signature)
    session.sessionId = 'main'
    session.actx = { sessions: { list: binding.list } }
    expect(await session.prompt('hello', 'queue', undefined, 'request')).toEqual({ ok: true })
    expect(postMessage).toHaveBeenCalledWith({ type: 'dsh/pond-dialogue', sessionId: 'main', requestId: 'request' }, 'https://fixture.invalid')
    // A main session that the Runtime does not report as running must never be listed.
    expect(lastIds(postMessage)).toEqual([])
    expect(lastSet(postMessage)).toMatchObject({ sessions: [] })
    // Once the Runtime reports it running, the complete set lists exactly that session.
    binding.state.ids = ['main']
    binding.notify()
    expect(lastIds(postMessage)).toEqual(['main'])
    expect(lastSet(postMessage)).toMatchObject({ seq: expect.any(Number), epoch: expect.any(String) })
  })

  it('uses the current session workspace and title for pond running entries', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const session = client()
    session.sessionId = 'main'
    session.actx = {
      sessions: {
        list: {
          getSnapshot: () => ({ byId: {
            main: { id: 'main', running: true, cwd: 'C:\\Users\\wsx\\deepseek-project', title: '修复模型选择' },
          } }),
          subscribe: () => () => {},
        },
      },
      workspaces: {
        list: {
          getSnapshot: () => ({ items: [
            { path: 'C:\\Users\\wsx\\deepseek-project', title: '深度项目' },
          ] }),
        },
      },
    }
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastSet(postMessage).sessions).toEqual([expect.objectContaining({
      id: 'main', projectName: '深度项目', sessionLabel: '修复模型选择',
    })])
  })

  it('reads names through the runtime context service and never uses the session id as a label', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const session = client()
    session.sessionId = 'session-123'
    const services = new Map([
      ['sessions', { list: { getSnapshot: () => ({ byId: { 'session-123': { id: 'session-123', running: true, cwd: 'C:\\work\\named-project', displayTitle: '有名称的会话' } } }), subscribe: () => () => {} } }],
      ['workspaces', { list: { getSnapshot: () => ({ items: [{ path: 'C:\\work\\named-project', title: '命名项目' }] }) } }],
    ])
    session.actx = { get: (name: string) => services.get(name) }
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastSet(postMessage).sessions).toEqual([expect.objectContaining({ projectName: '命名项目', sessionLabel: '有名称的会话' })])

    // A running session with no usable title falls back to a placeholder: the session id is
    // never reused as a display label.
    delete (globalThis as Record<string, unknown>).__dshPondRunning
    const unnamed = client()
    unnamed.sessionId = 'session-id-only'
    unnamed.actx = { sessions: { list: { getSnapshot: () => ({ byId: {
      'session-id-only': { id: 'session-id-only', running: true },
    } }), subscribe: () => () => {} } } }
    await unnamed.prompt('hello', 'queue', undefined, 'request-2')
    expect(lastSet(postMessage).sessions).toEqual([
      expect.objectContaining({ id: 'session-id-only', sessionLabel: '未命名会话' }),
    ])
    expect(lastSet(postMessage).sessions[0].sessionLabel).not.toBe('session-id-only')
  })

  it('publishes the latest assistant output for the pond card only while it runs', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const binding = runtimeList(['main'])
    const session = client()
    session.sessionId = 'main'
    session.actx = { sessions: { list: binding.list } }
    session.events = [{ data: { message: { content: [{ text: '最后一条输出' }] } } }]
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastSet(postMessage).sessions).toEqual([expect.objectContaining({ id: 'main', output: '最后一条输出' })])

    // The session stops running: neither its historical output nor a stale row may remain.
    binding.state.ids = []
    binding.notify()
    expect(lastSet(postMessage).sessions).toEqual([])
  })

  it('renders a project title for one running session and session titles for shared projects', async () => {
    const script = await readFile(new URL('../assets/koi-pond.js', import.meta.url), 'utf8')
    const css = await readFile(new URL('../assets/koi-pond.css', import.meta.url), 'utf8')
    expect(script).toContain('const title = items.length === 1 ? project : (item.sessionLabel ||')
    expect(script).toContain('if (items.length > 1)')
    expect(script).toContain("item.approval ? '审批' : '正在思考'")
    expect(css).toContain('-webkit-line-clamp: 2')
    expect(css).toContain('align-items: flex-start')
    expect(css).toContain('flex: 1 1 auto')
  })

  it('does not count failed or child-session prompts; preserves errors and arguments', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const failed = client('return { ok: false, args: [...arguments] };')
    expect(await failed.prompt('hello', 'queue', 1, 'id')).toEqual({ ok: false, args: ['hello', 'queue', 1, 'id'] })
    const child = client(); child.address = 'child'
    await child.prompt('hello')
    await expect(client('throw new Error("send failed");').prompt('hello')).rejects.toThrow('send failed')
    // A failed send and a failed throw never report a running set of their own.
    expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'dsh/pond-dialogue' }), 'https://fixture.invalid')
    expect(runningSets(postMessage)).toEqual([])
  })

  it('keeps a session listed while the Runtime reports it running and drops it on completion', async () => {
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
    const binding = runtimeList(['running-session'])
    const session = new (Function(`return (${transformed.source})`)()())()
    session.actx = { sessions: { list: binding.list } }
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastIds(postMessage)).toEqual(['running-session'])
    expect(lastSet(postMessage).sessions[0]).toMatchObject({ id: 'running-session' })
    expect(lastSet(postMessage).sessions[0].subAgent).toBeUndefined()
    // Completion is the Runtime's verdict, not this page's own guess.
    binding.state.ids = []
    binding.notify()
    session.running = false
    session.listener()
    expect(lastIds(postMessage)).toEqual([])
  })

  it('excludes a child agent session from the pond while the main session runs', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    // A child row is indistinguishable from a main row except for its lineage origin, so the
    // origin marker is the only thing that may keep the child out.
    const binding = runtimeList(['main-session', 'child-a'], id => id === 'main-session'
      ? { title: '主会话', parentId: undefined }
      : { origin: 'subagent', parentId: 'main-session' })
    const session = runtimeClient('return { ok: true };', binding)
    session.sessionId = 'main-session'
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastIds(postMessage)).toEqual(['main-session'])
    // No published set ever carried the child, not merely the newest one.
    expect(runningSets(postMessage).every(set => set.sessions.every((item: any) => item.id !== 'child-a'))).toBe(true)
  })

  it('lists nothing when only child agent sessions are running', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const binding = runtimeList(['child-a', 'child-b'], { origin: 'subagent' })
    const session = runtimeClient('return { ok: true };', binding)
    session.sessionId = 'main-session'
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastSet(postMessage).sessions).toEqual([])
    expect(runningSets(postMessage).every(set => set.sessions.length === 0)).toBe(true)
  })

  it('drops the main row on completion even while a child of it still runs', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const binding = runtimeList(['main-session'], id => (id === 'child-a' ? { origin: 'subagent' } : {}))
    const session = runtimeClient('return { ok: true };', binding)
    session.sessionId = 'main-session'
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastIds(postMessage)).toEqual(['main-session'])
    // The parent turn finished; the child it started keeps running and must not hold the row.
    binding.state.ids = ['child-a']
    binding.notify()
    expect(lastSet(postMessage).sessions).toEqual([])
  })

  it('keeps a main session listed from a page that is itself a child session', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    const binding = runtimeList(['child-a', 'main-session'], id => id === 'child-a'
      ? { origin: 'subagent', parentId: 'main-session' }
      : { title: '主会话' })
    const session = runtimeClient('return { ok: true };', binding)
    session.sessionId = 'child-a'
    session.address = 'child'
    await session.prompt('hello', 'queue', undefined, 'request')
    // Both the origin marker and this instance's own child address exclude the child, while the
    // main session it is running for stays listed.
    expect(lastIds(postMessage)).toEqual(['main-session'])
  })

  it('does not list a main prompt the Runtime never reports as running', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    // The page's own send is not evidence of a running turn: only the Runtime's bit is.
    const binding = runtimeList([])
    const session = runtimeClient('return { ok: true };', binding)
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(runningSets(postMessage).every(set => set.sessions.length === 0)).toBe(true)
    binding.state.ids = ['runtime-session']
    binding.notify()
    expect(lastIds(postMessage)).toEqual(['runtime-session'])
  })

  it('keeps listing a main session until the Runtime stops reporting it running', async () => {
    const postMessage = vi.fn()
    vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
    // The runtime flips to busy from inside the prompt, so the first observation stays idle.
    const binding = runtimeList(['runtime-session'])
    const session = runtimeClient('this.running = true; return { ok: true };', binding)
    await session.prompt('hello', 'queue', undefined, 'request')
    expect(lastIds(postMessage)).toEqual(['runtime-session'])
    session.running = false
    session.listener()
    // Its own snapshot going idle is not enough: the session stays until the Runtime agrees.
    expect(lastIds(postMessage)).toEqual(['runtime-session'])
    binding.state.ids = []
    binding.notify()
    expect(lastIds(postMessage)).toEqual([])
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
