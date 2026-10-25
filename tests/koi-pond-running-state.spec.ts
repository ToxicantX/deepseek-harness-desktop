import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'

const handles = vi.hoisted(() => new Map<string, (...args: any[]) => any>())
vi.mock('electron', () => ({
  ipcMain: { handle: (name: string, callback: (...args: any[]) => any) => handles.set(name, callback) },
  WebContentsView: class {
    visible = false
    bounds: unknown = {}
    webContents = Object.assign(new EventEmitter(), {
      destroyed: false, mainFrame: {}, url: '',
      isDestroyed() { return this.destroyed },
      getURL() { return this.url },
      loadFile: vi.fn(async (path: string) => { this.webContents.url = pathToFileURL(path).href }),
      executeJavaScript: vi.fn(async () => undefined),
      close() { this.destroyed = true },
      focus: vi.fn(), send: vi.fn(), setWindowOpenHandler: vi.fn(),
      session: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
    })
    setVisible(value: boolean) { this.visible = value }
    setBounds(value: unknown) { this.bounds = value }
    setBackgroundColor() {}
  },
}))

import { injectKoiPondDialogue } from '../src/koi-pond-injector.ts'
import { applyRunningSnapshot, KoiPondWindow, type RunningGeneration } from '../src/koi-pond-window.ts'

/** Mirrors the installed Runtime Session contract verified against 0.2.1-alpha.2. */
const sessionSource = [
  '() => class {',
  "  sessionId = 'seed'",
  '  running = false',
  '  events = []',
  '  constructor() { this.listeners = new Set(); this.snapshot = undefined; this.refresh() }',
  '  refresh() { this.snapshot = { sessionId: this.sessionId, running: this.running } }',
  '  getSnapshot() { this.refresh(); return this.snapshot }',
  '  subscribe(listener) { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }',
  '  handleRunning(value) {',
  '    if (this.running === value) return',
  '    this.running = value',
  '    this.refresh()',
  '    for (const listener of [...this.listeners]) listener()',
  '  }',
  // The real host prompt resolves at admission while the turn keeps running, so the
  // fixture resolves through a gate the test controls instead of resolving instantly.
  '  async prompt(content, mode, signal, requestId) { await this.gate; return { ok: true } }',
  '}',
].join('\n')

function injectedClassSource() {
  const transformed = injectKoiPondDialogue(sessionSource)
  expect(transformed.changed).toBe(true)
  return transformed.source
}

/** The Runtime's own session-list projection: the single source of running truth. */
function makeList() {
  const listeners = new Set<() => void>()
  const state = { runningIds: [] as string[], labels: {} as Record<string, any> }
  const list = {
    getSnapshot: () => {
      const byId: Record<string, any> = {}
      for (const id of state.runningIds) byId[id] = { id, running: true, ...(state.labels[id] || {}) }
      return { byId }
    },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const notify = () => { for (const listener of [...listeners]) listener() }
  return { state, list, notify }
}

function makeSession(sessionId: string, binding?: ReturnType<typeof makeList>) {
  const factory = Function('return (' + injectedClassSource() + ')()')()
  const session = new factory()
  session.sessionId = sessionId
  session.gate = new Promise<void>(resolve => { session.releaseTurn = resolve })
  if (binding) session.actx = { sessions: { list: binding.list } }
  return session
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const messages = (postMessage: any, type: string): any[] =>
  postMessage.mock.calls.map((call: any[]) => call[0]).filter((data: any) => data && data.type === type)
const lastSet = (postMessage: any): any => messages(postMessage, 'dsh/session-running-set').at(-1)
const listedIds = (set: any): string[] => (set ? set.sessions.map((entry: any) => entry.id).sort() : [])

function stubWindow() {
  const postMessage = vi.fn()
  vi.stubGlobal('window', { postMessage, location: { origin: 'https://fixture.invalid' } })
  // Each test drives one freshly injected document, so the shared document state must start empty.
  delete (globalThis as Record<string, unknown>).__dshPondRunning
  return postMessage
}

it('publishes one ordered authoritative set for a start and its stop', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  const session = makeSession('session-a', binding)
  const prompt = session.prompt('hello', 'queue', undefined, 'request-1')
  await settle()
  // The host starts the turn: the authoritative projection and the session agree.
  binding.state.runningIds = ['session-a']
  session.handleRunning(true)
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-a'])
  binding.state.runningIds = []
  session.handleRunning(false)
  session.releaseTurn()
  await prompt
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([])
})

it('keeps a session listed while several requests are in flight and drops it after the last settles', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  const session = makeSession('session-b', binding)
  binding.state.runningIds = ['session-b']
  session.handleRunning(true)
  await settle()
  const first = session.prompt('one', 'queue', undefined, 'request-1')
  await settle()
  const second = session.prompt('two', 'queue', undefined, 'request-2')
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-b'])

  // The turn is still running, so one admitted request must not drop the session.
  session.releaseTurn()
  await first
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-b'])

  binding.state.runningIds = []
  session.handleRunning(false)
  await second
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([])
})

it('drops a session that only carried historical output and never ran', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  const session = makeSession('session-c', binding)
  session.events = [{ data: { message: { content: [{ text: '很久以前的回答' }] } } }]
  const prompt = session.prompt('hello', 'queue', undefined, 'request-1')
  await settle()
  session.releaseTurn()
  await prompt
  await settle()
  // Historical output is not evidence of a running turn, so the row never appears.
  expect(listedIds(lastSet(postMessage))).toEqual([])
})

it('keeps the main row when a child session of it finishes first', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  // A child is a normal list row except for its lineage origin; only that marker hides it.
  binding.state.labels['session-child'] = { origin: 'subagent' }
  binding.state.runningIds = ['session-main', 'session-child']
  const main = makeSession('session-main', binding)
  const child = makeSession('session-child', binding)
  child.address = 'child'
  const mainPrompt = main.prompt('hello', 'queue', undefined, 'request-main')
  const childPrompt = child.prompt('hello', 'queue', undefined, 'request-child')
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-main'])

  // The child turn ends while the main turn it was started for keeps running.
  binding.state.runningIds = ['session-main']
  binding.notify()
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-main'])

  // The main turn ending is what removes the row - not the child's end.
  binding.state.runningIds = []
  binding.notify()
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([])

  child.releaseTurn()
  main.releaseTurn()
  await Promise.all([mainPrompt, childPrompt])
  await settle()
})

it('publishes nothing when only child agent sessions run', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  binding.state.labels['child-a'] = { origin: 'subagent' }
  binding.state.labels['child-b'] = { origin: 'subagent' }
  // A child must be excluded on its own origin marker, without a running main session to
  // compare against and without a parent id to look up.
  const session = makeSession('child-a', binding)
  session.address = 'child'
  const prompt = session.prompt('hello', 'queue', undefined, 'request-child')
  await settle()
  binding.state.runningIds = ['child-a', 'child-b']
  binding.notify()
  await settle()
  expect(lastSet(postMessage).sessions).toEqual([])
  session.releaseTurn()
  await prompt
  await settle()
})

it('drops this page\'s own child session in the fallback while keeping a main submission', async () => {
  const postMessage = stubWindow()
  // No usable Runtime list: the page falls back to its own submissions, which is the only
  // path where a child session could still become a row.
  const main = makeSession('session-main')
  const child = makeSession('session-child')
  child.address = 'child'
  const mainPrompt = main.prompt('hello', 'queue', undefined, 'request-main')
  const childPrompt = child.prompt('hello', 'queue', undefined, 'request-child')
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-main'])
  child.releaseTurn()
  await childPrompt
  await settle()
  // The child finished and the main submission is untouched by its own end.
  expect(listedIds(lastSet(postMessage))).toEqual(['session-main'])
  main.releaseTurn()
  await mainPrompt
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([])
})

it('publishes nothing from the fallback when only this page\'s own child session submits', async () => {
  const postMessage = stubWindow()
  const child = makeSession('session-child')
  child.address = 'child'
  const prompt = child.prompt('hello', 'queue', undefined, 'request-child')
  await settle()
  expect(lastSet(postMessage).sessions).toEqual([])
  child.releaseTurn()
  await prompt
  await settle()
  expect(lastSet(postMessage).sessions).toEqual([])
})

it('keeps another context\'s child hidden when a main prompt publishes the fallback set', async () => {
  const postMessage = stubWindow()
  // Both instances share one injected document, so they share the fallback submission map,
  // but each prompt publishes from its own scope and can only see itself as the child.
  const child = makeSession('session-child')
  child.address = 'child'
  const main = makeSession('session-main')
  const childPrompt = child.prompt('hello', 'queue', undefined, 'request-child')
  await settle()
  expect(lastSet(postMessage).sessions).toEqual([])

  // The main prompt republishes that shared map from its own scope: the child id it can still
  // see must not come back as a main row.
  const mainPrompt = main.prompt('hello', 'queue', undefined, 'request-main')
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-main'])
  expect(messages(postMessage, 'dsh/session-running-set').every((set: any) =>
    set.sessions.every((item: any) => item.id !== 'session-child'))).toBe(true)

  child.releaseTurn()
  main.releaseTurn()
  await Promise.all([childPrompt, mainPrompt])
  await settle()
})

it('never republishes interleaved child submissions and keeps every main submission', async () => {
  const postMessage = stubWindow()
  const childA = makeSession('child-a')
  childA.address = 'child'
  const childB = makeSession('child-b')
  childB.address = 'child'
  const mainA = makeSession('main-a')
  const mainB = makeSession('main-b')
  const pending = [
    childA.prompt('hello', 'queue', undefined, 'request-1'),
    mainA.prompt('hello', 'queue', undefined, 'request-2'),
    childB.prompt('hello', 'queue', undefined, 'request-3'),
    mainB.prompt('hello', 'queue', undefined, 'request-4'),
  ]
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['main-a', 'main-b'])

  // A second interleaved round: the children keep submitting between the main prompts without
  // ever entering a published set.
  pending.push(
    childA.prompt('again', 'queue', undefined, 'request-5'),
    mainA.prompt('again', 'queue', undefined, 'request-6'),
  )
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['main-a', 'main-b'])
  expect(messages(postMessage, 'dsh/session-running-set').every((set: any) => set.sessions.every((item: any) =>
    item.id === 'main-a' || item.id === 'main-b'))).toBe(true)

  // The interleaved children finish first; the main rows must not be dropped by their end.
  for (const session of [childA, childB]) session.releaseTurn()
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['main-a', 'main-b'])
  for (const session of [mainA, mainB]) session.releaseTurn()
  await Promise.all(pending)
  await settle()
  expect(lastSet(postMessage).sessions).toEqual([])
})

it('documents the binding limitation: no set is published before a session first prompts', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  // A page whose in-page hook has not yet run a prompt cannot observe the Runtime list,
  // so a session already running elsewhere stays unlisted until some session prompts here.
  binding.state.runningIds = ['session-already-running']
  const session = makeSession('session-idle', binding)
  expect(lastSet(postMessage)).toBeUndefined()

  // The first prompt binds the Runtime list, and from then on every running session is
  // visible - including the one that never prompted on this page.
  const prompt = session.prompt('hello', 'queue', undefined, 'request-1')
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-already-running'])

  // Under-reporting is the safe direction: nothing is invented while unbound.
  session.releaseTurn()
  await prompt
  await settle()
})

it('advances the run counter when a session runs again after a gap', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  const session = makeSession('session-a', binding)
  const runSeqOf = () => lastSet(postMessage).sessions.find((item: any) => item.id === 'session-a').seq

  // The first prompt is what installs the page's observation of the Runtime list.
  const prompt = session.prompt('hello', 'queue', undefined, 'request-1')
  await settle()
  binding.state.runningIds = ['session-a']
  session.handleRunning(true)
  await settle()
  const firstRun = runSeqOf()
  expect(firstRun).toBeGreaterThanOrEqual(1)

  // The turn stops and the row leaves the list entirely.
  binding.state.runningIds = []
  session.handleRunning(false)
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([])

  // A later turn for the same session is a genuinely new run, not the old one.
  binding.state.runningIds = ['session-a']
  session.handleRunning(true)
  await settle()
  expect(runSeqOf()).toBeGreaterThan(firstRun)
  expect(listedIds(lastSet(postMessage))).toEqual(['session-a'])
  session.releaseTurn()
  await prompt
  await settle()
})

it('drops rows the Runtime no longer reports as running, then leaves only the real one', async () => {
  const postMessage = stubWindow()
  const binding = makeList()
  const ids = ['session-a', 'session-b', 'session-c', 'session-d', 'session-e', 'session-f']
  const sessions = ids.map(id => makeSession(id, binding))
  binding.state.runningIds = [...ids]
  const prompts = sessions.map((session, index) => session.prompt('hello', 'queue', undefined, 'request-' + index))
  await settle()
  for (const session of sessions) session.handleRunning(true)
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([...ids].sort())

  // Five finished without a usable stop frame; the Runtime's projection is the truth.
  const publishedBefore = messages(postMessage, 'dsh/session-running-set').length
  binding.state.runningIds = ['session-a']
  binding.notify()
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual(['session-a'])
  // Every set published after the shrink lists only the session still running, so the
  // five stale rows are gone rather than merely filtered out of one frame.
  const afterShrink = messages(postMessage, 'dsh/session-running-set').slice(publishedBefore)
  expect(afterShrink.length).toBeGreaterThan(0)
  expect(afterShrink.every((set: any) => set.sessions.every((item: any) => item.id === 'session-a'))).toBe(true)

  binding.state.runningIds = []
  binding.notify()
  await settle()
  expect(listedIds(lastSet(postMessage))).toEqual([])

  for (const session of sessions) session.releaseTurn()
  await Promise.all(prompts)
  await settle()
})

function generation(epoch: string): RunningGeneration {
  return { epoch, seq: -1, retired: new Set() }
}
/** Mirrors the caller contract: an accepted set becomes the generation's current position. */
function records(gen: RunningGeneration, sessions: unknown, seq: number, epoch = gen.epoch) {
  const accepted = applyRunningSnapshot(sessions, seq, gen, epoch)
  if (accepted) { gen.epoch = epoch; gen.seq = seq }
  return accepted
}

it('ignores an older set that arrives after a newer one', () => {
  const gen = generation('generation-1')
  const first = records(gen, [entry('session-a', 4)], 4)
  expect(first?.sessions.map(s => s.id)).toEqual(['session-a'])
  expect(records(gen, [], 2)).toBeUndefined()
  expect(records(gen, [entry('session-b', 1)], 1)).toBeUndefined()
  expect(records(gen, [entry('session-a', 4)], 4)).toBeUndefined()
  const newer = records(gen, [entry('session-b', 5), entry('session-c', 6)], 9)
  expect(newer?.sessions.map(s => s.id).sort()).toEqual(['session-b', 'session-c'])
  expect(newer?.seq).toBe(9)
})

it('leaves only the still-running session once two sessions, one stops', () => {
  const gen = generation('generation-1')
  const both = records(gen, [entry('left', 1), entry('right', 2)], 3)
  expect(both?.sessions.map(s => s.id).sort()).toEqual(['left', 'right'])
  const oneLeft = records(gen, [entry('left', 1)], 4)
  expect(oneLeft?.sessions.map(s => s.id)).toEqual(['left'])
  expect(oneLeft?.sessions.some(s => s.id === 'right')).toBe(false)
  expect(records(gen, [], 5)?.sessions).toEqual([])
})

it('rejects malformed snapshot entries instead of trusting them', () => {
  const gen = generation('generation-1')
  const applied = records(
    gen,
    [entry('ok', 1), { id: 'no-seq' }, { id: '', seq: 2 }, null, { id: 'bad-seq', seq: 0 }],
    2 * 7,
  )
  expect(applied?.sessions.map(s => s.id)).toEqual(['ok'])
})

it('treats a reloaded document generation as a fresh sequence space', () => {
  const gen = generation('generation-1')
  const first = records(gen, [entry('stale', 1)], 5)
  expect(first?.sessions.map(s => s.id)).toEqual(['stale'])
  // The reloaded page restarts its own counter, so a lower sequence from a new generation is current.
  const reloaded = records(gen, [], 1, 'generation-2')
  expect(reloaded?.sessions).toEqual([])
  expect(reloaded?.epoch).toBe('generation-2')
  expect(records(gen, [entry('stale', 1)], 1, 'generation-2')).toBeUndefined()
})

it('refuses a set whose document generation was already retired', () => {
  const gen = generation('generation-1')
  records(gen, [entry('stale', 1)], 5)
  gen.retired.add('generation-1')
  // A and B are both live pages; the reset retired A, so A's late frame must not restore its list.
  const b = records(gen, [], 1, 'generation-2')
  expect(b?.sessions).toEqual([])
  expect(applyRunningSnapshot([entry('stale', 1)], 6, gen, 'generation-1')).toBeUndefined()
  expect(applyRunningSnapshot([entry('stale', 1)], 0, gen, 'generation-1')).toBeUndefined()
})

function entry(id: string, seq: number) {
  return { id, seq, startedAt: seq, projectName: '项目', sessionLabel: '会话 ' + id }
}

let directory: string
let pond: KoiPondWindow
const makeOwner = () => Object.assign(new EventEmitter(), {
  destroyed: false,
  isDestroyed() { return this.destroyed },
  getContentBounds: () => ({ width: 900, height: 640 }),
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
  webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, focus: vi.fn() }),
})
let owner: ReturnType<typeof makeOwner>
const view = (): any => owner.contentView.addChildView.mock.calls.at(-1)?.[0]
const sentLists = (): any[][] => view().webContents.send.mock.calls
  .filter((call: any[]) => call[0] === 'pond:running-sessions')
  .map((call: any[]) => call[1])
const lastSent = (): any[] => sentLists().at(-1) ?? []

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-pond-running-'))
  owner = makeOwner()
  pond = new KoiPondWindow(join(directory, 'pond.json'), join(directory, 'pond.html'), 'preload.cjs', vi.fn(), () => owner as unknown as BrowserWindow)
})
afterEach(async () => {
  await pond.stop()
  handles.clear()
  await rm(directory, { recursive: true, force: true })
})

const runningSet = (sessions: any[], seq: number, epoch = 'generation-1') => ({ epoch, seq, sessions })
const sentIds = (): string[] => lastSent().map((session: any) => session.id).sort()

it('clears the list on an explicit reload reset and refuses the retired generation afterwards', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 1), entry('session-b', 2)], 3, 'page-a'))
  expect(sentIds()).toEqual(['session-a', 'session-b'])

  // Reload: the shell retires page-a and clears, so nothing is shown before the new page speaks.
  pond.resetRunningSessions()
  expect(lastSent()).toEqual([])

  // The reloaded page restarts its own sequence counter at 1 and is accepted.
  pond.setRunningSessions(runningSet([entry('session-c', 1)], 1, 'page-b'))
  expect(sentIds()).toEqual(['session-c'])

  // A late frame from the retired page-a must never restore the list it reset.
  pond.setRunningSessions(runningSet([entry('session-a', 1), entry('session-b', 2)], 4, 'page-a'))
  expect(sentIds()).toEqual(['session-c'])
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 99, 'page-a'))
  expect(sentIds()).toEqual(['session-c'])
})

it('shows nothing until a live page publishes after a reset', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 2, 'page-a'))
  expect(sentIds()).toEqual(['session-a'])
  pond.resetRunningSessions()
  // Repeating the reset is idempotent and never resurrects the cleared list.
  pond.resetRunningSessions()
  expect(lastSent()).toEqual([])
  // A stale frame from the current-but-reset generation is refused as well.
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 2, ''))
  expect(lastSent()).toEqual([])
})

it('accepts the live generation again after a late frame from the retired one', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 3, 'page-a'))
  expect(sentIds()).toEqual(['session-a'])
  pond.setRunningSessions(runningSet([entry('session-b', 1)], 1, 'page-b'))
  expect(sentIds()).toEqual(['session-b'])

  // A late frame from retired page-a must be refused...
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 4, 'page-a'))
  expect(sentIds()).toEqual(['session-b'])

  // ...and refusing it must not retire the live page-b, so page-b's next set is accepted.
  pond.setRunningSessions(runningSet([entry('session-b', 1), entry('session-c', 2)], 2, 'page-b'))
  expect(sentIds()).toEqual(['session-b', 'session-c'])

  // A stale sequence from the live page is still refused.
  pond.setRunningSessions(runningSet([entry('session-b', 1)], 2, 'page-b'))
  expect(sentIds()).toEqual(['session-b', 'session-c'])
})

it('keeps dismissals when a refused frame arrives', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 1), entry('session-b', 2)], 3, 'page-a'))
  pond.clearRunningSession('session-a')
  expect(sentIds()).toEqual(['session-b'])

  // A malformed frame from a different generation is refused, so it must not clear the
  // dismissal: the same run of session-a stays hidden on the live page's next set.
  pond.setRunningSessions({ epoch: 'page-b', seq: 1, sessions: 'not-an-array' })
  expect(sentIds()).toEqual(['session-b'])
  pond.setRunningSessions(runningSet([entry('session-a', 1), entry('session-b', 2)], 4, 'page-a'))
  expect(sentIds()).toEqual(['session-b'])

  // A genuinely new generation does clear dismissals, so that session shows again there.
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 1, 'page-b'))
  expect(sentIds()).toEqual(['session-a'])
})

it('rejects a malformed cross-generation set without retiring the live generation', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 1), entry('session-b', 2)], 5, 'page-a'))
  pond.clearRunningSession('session-a')
  expect(sentIds()).toEqual(['session-b'])

  // Not an array, a non-integer sequence and a missing epoch are all refused.
  pond.setRunningSessions({ epoch: 'page-b', seq: 1, sessions: 'not-an-array' })
  pond.setRunningSessions({ epoch: 'page-b', seq: 1.5, sessions: [] })
  pond.setRunningSessions({ seq: 1, sessions: [] })
  expect(sentIds()).toEqual(['session-b'])

  // The live page-a generation survived, so its next set is accepted and the dismissal holds.
  pond.setRunningSessions(runningSet([entry('session-a', 1), entry('session-b', 2), entry('session-d', 3)], 6, 'page-a'))
  expect(sentIds()).toEqual(['session-b', 'session-d'])

  // And a genuinely new generation is still accepted afterwards.
  pond.setRunningSessions(runningSet([entry('session-c', 1)], 1, 'page-b'))
  expect(sentIds()).toEqual(['session-c'])
})

it('hides a dismissed row until that session starts a genuinely new run', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 3), entry('session-b', 4)], 1))
  expect(sentIds()).toEqual(['session-a', 'session-b'])
  pond.clearRunningSession('session-a')
  expect(sentIds()).toEqual(['session-b'])
  // The same run must not reappear on the next snapshot.
  pond.setRunningSessions(runningSet([entry('session-a', 3), entry('session-b', 4)], 2))
  expect(sentIds()).toEqual(['session-b'])
  // A new run for that session is a genuinely new execution and shows again.
  pond.setRunningSessions(runningSet([entry('session-a', 9), entry('session-b', 4)], 3))
  expect(sentIds()).toEqual(['session-a', 'session-b'])
})

it('re-sends the current list when the pond reopens after a page reconnect', async () => {
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 1))
  await pond.open()
  expect(sentIds()).toEqual(['session-a'])
  pond.clearAllRunningSessions()
  expect(lastSent()).toEqual([])
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 2))
  expect(lastSent()).toEqual([])
})

it('ignores a set published by an older document generation', async () => {
  await pond.open()
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 5, 'generation-1'))
  expect(sentIds()).toEqual(['session-a'])
  pond.setRunningSessions(runningSet([], 1, 'generation-2'))
  expect(lastSent()).toEqual([])
  pond.setRunningSessions(runningSet([entry('session-a', 1)], 1, 'generation-2'))
  expect(lastSent()).toEqual([])
})
