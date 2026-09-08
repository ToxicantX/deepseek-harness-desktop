// Usage: node scripts/smoke-same-session-replay.mjs PATH_TO_BUILT_UNMODIFIED_DSH
// Uses a temporary JSONL store; never opens the user's session database.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { injectDesktopReplayHost } from '../src/conversation-replay-host-injector.ts'
import { injectDesktopReplayClient } from '../src/conversation-replay-client-injector.ts'

const core = resolve(process.argv[2] ?? '')
assert(process.argv[2], 'Pass the built upstream checkout explicitly')
const base = createRequire(join(core, 'packages/core/agent-loop/package.json'))
const load = name => import(pathToFileURL(base.resolve(name)).href)
const entry = pathToFileURL(join(core, 'packages/host/apiproxy/lib/index.js')).href
const before = await readFile(new URL(entry), 'utf8')
assert(!before.includes('session/rewind'), 'Smoke must use the restored upstream core')
let hostMatched = false
const hook = registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url !== entry) return result
    const transformed = injectDesktopReplayHost(String(result.source))
    assert(transformed.changed, 'Host adapter did not match this core')
    hostMatched = true
    return { ...result, source: transformed.source }
  },
})
const { createApiProxy, toFetchHandler } = await import(entry)
assert(hostMatched)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await import(pathToFileURL(join(core, 'vendor/loader/lib/index.js')).href)
const { default: Include } = await import(pathToFileURL(join(core, 'vendor/include/lib/index.js')).href)
const { default: LlmRuntime, LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const { default: SessionStore, Session, SessionId } = await load('@deepseek-ai/dsh-session')
const { default: AgentRegistry } = await load('@deepseek-ai/dsh-agent')
const { default: AgentLoop } = await import(pathToFileURL(join(core, 'packages/core/agent-loop/lib/index.js')).href)
const { default: SystemPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: Questions } = await import(pathToFileURL(join(core, 'packages/interaction/user-questions/lib/index.js')).href)
class Adapter extends LlmAdapter {
  requests = []
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(options) {
    this.requests.push(options)
    const text = `answer-${this.requests.length}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-replay-smoke-'))
const ctx = new Context()
try {
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: LlmRuntime, sessions: SessionStore, prompt: SystemPrompt,
    tools: Tools, agents: AgentRegistry, loop: AgentLoop, persistence: Jsonl, questions: Questions,
  })
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['llm', 'sessions', 'prompt', 'tools', 'agents', 'questions'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:loop', config: { agents: [] } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = ctx.agentLoop.create(SessionId('shell-replay'), { provider: 'mock', model: 'mock' })
  const originalAppend = agent.session.append
  const handler = toFetchHandler(createApiProxy(ctx, {
    cwd: directory, defaultModelSelection: () => ({ provider: 'mock', model: 'mock' }),
  }))
  async function send(text, target) {
    const response = await handler.fetch('http://fixture/api/session.prompt', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'client-request', rpcId: 'smoke', method: 'session.prompt',
        payload: { sessionId: agent.id, content: [{ type: 'text', text }],
          mode: target === undefined ? 'queue' : 'desktop-replay-v1',
          ...(target === undefined ? {} : { desktopReplayFrom: target }) },
      }),
    })
    const reply = await response.json()
    assert.equal(reply.result.ok, true, JSON.stringify(reply))
    await agent.whenIdle()
  }
  await send('first')
  await send('second')
  const target = agent.session.events.find(event => event.type === 'user/message' && event.data.content[0]?.text === 'second')
  await send('edited', target.seq)
  const texts = request => request.messages.flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
  assert.deepEqual(texts(adapter.requests.at(-1)), ['first', 'answer-1', 'edited'])
  const first = agent.session.events.find(event => event.type === 'user/message' && event.data.content[0]?.text === 'first')
  await send('restart', first.seq)
  assert.deepEqual(texts(adapter.requests.at(-1)), ['restart'])
  assert.equal(agent.session.append, originalAppend)
  assert.equal(agent.id, 'shell-replay')
  await ctx.sessions.flush(agent.session)
  const stored = await ctx.sessionPersistence.readFrom(agent.id, 0)
  const restored = Session.create(agent.id, stored.events)
  assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages())
  assert(stored.events.some(event => event.type === 'user/message' && event.data.content[0]?.text === 'first'))

  let factory
  runInNewContext(await readFile(join(core, 'packages/client/runtime/lib/client.js'), 'utf8'), {
    window: { __ModuleLoader__: { load: descriptor => { factory = descriptor.factory } } },
  })
  const transformed = injectDesktopReplayClient(factory.toString())
  assert(transformed.changed, 'Client adapter did not match this core')
  // Export the actual internal Session only in this smoke, then instantiate it
  // without a live connection to exercise its real history projection methods.
  const exposed = transformed.source.replace('return module.exports;', 'module.exports.TestSession = Session; return module.exports;')
  const clientExports = Function(`return (${exposed})`)()(name => {
    if (name === '@deepseek-ai/cordis') return { Service: class {} }
    if (name === '@deepseek-ai/dsh-client-ui-slots') return { SlotRegistry: class {} }
    throw new Error(`Unexpected client external: ${name}`)
  })
  const client = Object.create(clientExports.TestSession.prototype)
  client.events = stored.events
  client.views = []
  const projected = client.desktopReplayEntries()
  const visible = projected.filter(item => item.event.type === 'user/message' && item.event.surfaceOp === 'append')
  assert.deepEqual(visible.map(item => item.event.data.content[0].text), ['restart'])
  assert.equal(await readFile(new URL(entry), 'utf8'), before, 'Core file was changed')
  console.log('PASS: unmodified core + Loader/fetch/JSONL + actual client factory; same ID, later/first replay, model input and reload')
} finally {
  await ctx.fiber.dispose()
  hook.deregister()
  // Only remove the explicitly created temporary fixture, never a caller path.
  assert(relative(tmpdir(), directory).startsWith('dsh-shell-replay-smoke-'))
  await rm(directory, { recursive: true, force: true })
}
