import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { admitDesktopReplay, injectDesktopReplayHost, injectDesktopReplayController, injectDesktopReplayCodec, installDesktopReplayHostHook } from '../src/conversation-replay-host-injector.ts'
import { injectDesktopReplayClient } from '../src/conversation-replay-client-injector.ts'

const require = createRequire(import.meta.url)
function message(text: string) {
  return { id: text, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] } as any
}
function fixture() {
  const session = Session.create(SessionId('original'))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', message('original'), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  let queued: any
  let idle!: () => void
  const done = new Promise<void>(resolve => { idle = resolve })
  const agent = {
    session, inbox: { nextTurn: [], nextStep: [] },
    runMaintenance: (job: any) => job(new AbortController().signal),
    followup: vi.fn((value: any) => { queued = value }),
    whenIdle: () => done,
  }
  return {
    session, agent, idle,
    land() {
      session.append('turn/start', { turn: 2 })
      session.append('user/message', queued, { surfaceOp: 'append' })
      session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      idle()
    },
  }
}

// A minimal original client class pins the exact changed call sites. The opt-in
// built smoke separately checks the complete Runtime browser factory.
function clientClass() {
  const source = `() => class {
    async prompt(content, mode) {}
    older(older) { this.conversation.prepend(older.map(conversationInput), this.hasMore); }
    install(entries, hasMore) { this.conversation.replaceWindow(entries.map(conversationInput), hasMore); }
    live(event, view) { return this.conversation.append({ event, view }); }
  }`
  const result = injectDesktopReplayClient(source)
  expect(result.changed).toBe(true)
  return Function(`return (${result.source})`)()()
}

describe('shell-only same-session replay', () => {
  it('uses existing replacement records readable by the unmodified core', async () => {
    const { session, agent, land } = fixture()
    const originalAppend = session.append
    await admitDesktopReplay(agent, message('edited'), 1)
    expect(session.events).toHaveLength(3)
    land()
    expect(session.append).toBe(originalAppend)
    expect(session.id).toBe('original')
    expect(session.deriveMessages().map(item => item.content)).toEqual([message('edited').content])
    const restored = Session.create(session.id, JSON.parse(JSON.stringify(session.events)))
    expect(restored.deriveMessages()).toEqual(session.deriveMessages())
    expect(restored.events.some(event => event.type === ('session/rewind' as any))).toBe(false)
    expect(restored.events[1]?.data).toMatchObject({ content: message('original').content })
  })

  it('restores the method when pre-step drops the queued message', async () => {
    const { session, agent, idle } = fixture()
    const original = session.append
    await admitDesktopReplay(agent, message('edited'), 1)
    idle()
    await Promise.resolve()
    expect(session.append).toBe(original)
    expect(session.events).toHaveLength(3)
  })

  it('rejects invalid targets, queued work and empty messages without changing history', async () => {
    for (const kind of ['target', 'queue', 'empty', 'busy']) {
      const { session, agent } = fixture()
      if (kind === 'queue') (agent.inbox.nextTurn as unknown[]).push({})
      if (kind === 'busy') agent.runMaintenance = () => { throw new Error('busy') }
      await expect(admitDesktopReplay(agent, message(kind === 'empty' ? ' ' : 'edited'), kind === 'target' ? 90 : 1)).rejects.toThrow()
      expect(session.events).toHaveLength(3)
      expect(agent.followup).not.toHaveBeenCalled()
    }
  })

  it('projects live, reload and paginated history without discarded messages', async () => {
    const { session, agent, land } = fixture()
    await admitDesktopReplay(agent, message('edited'), 1)
    land()
    const client = new (clientClass())()
    client.events = session.events
    client.views = []
    client.hasMore = false
    const replaceWindow = vi.fn()
    client.conversation = { replaceWindow, append: vi.fn() }
    const replacement = session.events[4]
    client.live(replacement)
    expect(replaceWindow.mock.calls[0]?.[0].map((item: any) => item.event.seq)).toEqual([3, 4, 5])
    expect(replaceWindow.mock.calls[0]?.[0][1].event.surfaceOp).toBe('append')
    client.events = session.events.slice(3)
    client.install([], true)
    client.events = session.events
    client.older([])
    expect(replaceWindow.mock.calls.at(-1)?.[0].map((item: any) => item.event.seq)).toEqual([3, 4, 5])
    expect(session.events[4]).toMatchObject({ surfaceOp: { op: 'replace' } })
  })

  it('sends an explicitly rejected-by-old-host mode and the original ID', async () => {
    const client = new (clientClass())()
    client.sessionId = 'original'
    const prompt = vi.fn(async () => ({ result: { ok: true } }))
    client.api = { sessions: { prompt } }
    await expect(client.desktopReplay(1, message('edited').content)).resolves.toEqual({ ok: true })
    expect(prompt).toHaveBeenCalledWith({
      sessionId: 'original', mode: 'desktop-replay-v1', desktopReplayFrom: 1, content: message('edited').content,
    })
  })

  it('keeps ordinary events on the original path and contains projection failures', () => {
    const client = new (clientClass())()
    const append = vi.fn()
    const replaceWindow = vi.fn()
    client.conversation = { append, replaceWindow }
    client.events = [{ type: 'user/message', seq: 1, data: message('original') }]
    client.views = []
    client.live(client.events[0])
    expect(append).toHaveBeenCalledOnce()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    client.desktopReplayEntries = () => { throw new Error('projection changed') }
    client.desktopReplayRebuild()
    expect(replaceWindow).toHaveBeenCalledWith([{ event: client.events[0], view: undefined }], undefined)
    expect(error).toHaveBeenCalledOnce()
    error.mockRestore()
  })

  it('adapts the installed upstream host atomically and leaves unknown layouts untouched', () => {
    const source = readFileSync(require.resolve('@deepseek-ai/dsh-host-apiproxy'), 'utf8')
    expect(injectDesktopReplayHost(source).changed).toBe(true)
    const changed = source.replace('if (mode === "steer") agent.steer(message);', 'unsupported();')
    expect(injectDesktopReplayHost(changed)).toEqual({ source: changed, changed: false })
    expect(injectDesktopReplayClient('() => ({ core: true })').changed).toBe(false)
  })

  it('keeps original modules when the optional adapter encounters unexpected input', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let hooks: any
    installDesktopReplayHostHook(((value: any) => { hooks = value }) as any)
    const loaded = { format: 'module', source: 'original' }
    expect(hooks.load('invalid-url', {}, () => loaded)).toBe(loaded)
    vi.restoreAllMocks()
  })

  it('recognizes the split controller and codec while rejecting unknown signatures', () => {
    const controller = 'if (request.mode === "steer") agent.steer(message); else agent.followup(message);'
    const codec = `'mode': z.union([z.literal("queue"), z.literal("steer")]).readonly(),`
    expect(injectDesktopReplayController(controller).source).toContain('request.desktopReplayFrom')
    expect(injectDesktopReplayCodec(codec).source).toContain('desktop-replay-v1')
    expect(injectDesktopReplayController('unrecognized')).toEqual({ source: 'unrecognized', changed: false })
    expect(injectDesktopReplayCodec('unrecognized')).toEqual({ source: 'unrecognized', changed: false })
  })

  it('extends only replay input in the modern client gateway, preserving normal codec validation', () => {
    const original = '() => { function parseInput(codec, value, endpoint, field) { return codec.schema.parse(value); } return parseInput; }'
    const result = injectDesktopReplayClient(original)
    const parse = Function(`return (${result.source})`)()()
    const codec = { mode: 'strict', schema: { parse: vi.fn(value => value) } }
    const input = { mode: 'desktop-replay-v1', desktopReplayFrom: 3, content: [{ type: 'text', text: '完整内容' }] }
    expect(parse(codec, input, 'session/prompt', 'request')).toEqual(input)
    expect(codec.schema.parse).toHaveBeenLastCalledWith({ ...input, mode: 'queue' })
    const normal = { mode: 'queue', content: [] }
    expect(parse(codec, normal, 'session/prompt', 'request')).toBe(normal)
    expect(codec.schema.parse).toHaveBeenLastCalledWith(normal)
    expect(() => parse(codec, { ...input, desktopReplayFrom: -1 }, 'session/prompt', 'request')).toThrow()
  })
})
