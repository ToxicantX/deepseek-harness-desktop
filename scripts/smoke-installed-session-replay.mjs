// Node 24; reads an installed split-controller Runtime without changing its files.
// Usage: node scripts/smoke-installed-session-replay.mjs RUNTIME_DIRECTORY
import assert from 'node:assert/strict'
import { createRequire, registerHooks } from 'node:module'
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { installDesktopReplayHostHook } from '../src/conversation-replay-host-injector.ts'
import { injectDesktopReplayClient } from '../src/conversation-replay-client-injector.ts'

assert(process.argv[2], 'Pass the installed Runtime directory explicitly')
const runtime = resolve(process.argv[2])
const base = createRequire(join(runtime, 'app/node_modules/@deepseek-ai/dsh/package.json'))
const load = name => import(pathToFileURL(base.resolve(name)).href)
const controllerPath = base.resolve('@deepseek-ai/dsh-api-session-controller')
const controllerUrl = pathToFileURL(controllerPath).href
const before = await readFile(controllerPath, 'utf8')
if (process.env.DSH_REPLAY_BUILT_HOOK === '1') await import('../lib/shutdown-hook.js')
else installDesktopReplayHostHook()
const expose = registerHooks({
  load(url, context, nextLoad) {
    const loaded = nextLoad(url, context)
    return url === controllerUrl
      ? { ...loaded, source: String(loaded.source) + '\nexport { SessionCommandController as TestCommands };\n' }
      : loaded
  },
})
const { TestCommands } = await import(controllerUrl)
const { TYPERT } = await import(new URL('./typert.host.js', controllerUrl))
function findPrompt(value) {
  if (value?.method === 'prompt' && value?.namespace === 'session') return value
  if (!value || typeof value !== 'object') return
  for (const child of Object.values(value)) {
    const found = findPrompt(child)
    if (found) return found
  }
}
const descriptor = findPrompt(TYPERT)
assert(descriptor, 'Session prompt descriptor missing')
const schema = descriptor.parameters[0].codec.schema
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: Include } = await load('@deepseek-ai/cordis-plugin-include')
const { default: Llm, LlmAdapter } = await load('@deepseek-ai/dsh-llm')
const { default: Sessions, Session, SessionId } = await load('@deepseek-ai/dsh-session')
const { default: Agents } = await load('@deepseek-ai/dsh-agent')
const { default: Loop } = await load('@deepseek-ai/dsh-agent-loop')
const { default: Prompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: Attachments } = await load('@deepseek-ai/dsh-attachment')
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection')
class Adapter extends LlmAdapter {
  requests = []
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(request) {
    this.requests.push(request)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
const directory = await mkdtemp(join(tmpdir(), 'dsh-installed-replay-smoke-'))
const ctx = new Context()
try {
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: Llm, sessions: Sessions, agents: Agents, loop: Loop,
    prompt: Prompt, tools: Tools, persistence: Jsonl, attachments: Attachments, projections: Projections,
  })
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['llm', 'sessions', 'agents', 'prompt', 'tools', 'attachments', 'projections'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:loop', config: { agents: [] } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('installed-smoke'), { provider: 'mock', model: 'mock' })
  // The text-only controller fixture owns no uploaded files. All admission,
  // agent-loop, surface and persistence operations below are real Runtime code.
  const commandContext = {
    agents: ctx.agents, llm: ctx.llm, attachments: ctx.attachments,
    fileUploads: {
      bindPrompt(_agent, receipts) {
        assert.deepEqual(receipts, [])
        return { commit() {}, [Symbol.dispose]() {} }
      },
    },
  }
  const commands = new TestCommands(commandContext, {
    resolveAgent: async () => ({ agent }),
    selectionFor: () => ({ current: { provider: 'mock', model: 'mock' } }),
  }, directory)
  async function send(text, target) {
    const request = schema.parse({
      requestId: crypto.randomUUID(), sessionId: agent.id,
      mode: target === undefined ? 'queue' : 'desktop-replay-v1',
      content: [{ type: 'text', text }],
      ...(target === undefined ? {} : { desktopReplayFrom: target }),
    })
    assert.equal((await commands.prompt(request)).accepted, true)
    await agent.whenIdle()
  }
  await send('first')
  await send('second')
  const target = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.content[0]?.text === 'second')
  await send('edited', target.seq)
  const texts = request => request.messages.flatMap(message => message.content.filter(part => part.type === 'text').map(part => part.text))
  assert.deepEqual(texts(adapter.requests.at(-1)), ['first', 'answer', 'edited'])
  const first = agent.session.snapshotEvents().find(event => event.type === 'user/message' && event.data.content[0]?.text === 'first')
  await send('restart', first.seq)
  assert.deepEqual(texts(adapter.requests.at(-1)), ['restart'])
  await ctx.sessions.flush(agent.session)
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  const stored = { events: await reader.read() }
  await reader.close()
  assert.deepEqual(Session.create(agent.id, stored.events).deriveMessages(), agent.session.deriveMessages())

  async function clientFactory(name) {
    let factory
    const file = new URL('./client.js', pathToFileURL(base.resolve(name)))
    runInNewContext(await readFile(file, 'utf8'), {
      window: { __ModuleLoader__: { load: descriptor => { factory = descriptor.factory } } },
    })
    const result = injectDesktopReplayClient(factory.toString())
    assert(result.changed, `${name} adapter did not match`)
    return result.source
  }
  const source = await clientFactory('@deepseek-ai/dsh-api-session-controller')
  const exports = Function(`return (${source})`)()(name => {
    if (name === '@deepseek-ai/cordis') return { Service: class {} }
    if (name === '@deepseek-ai/dsh-client-store') return { notifySubscribers: listeners => { for (const listener of listeners) listener() } }
    if (name === '@deepseek-ai/dsh-api-gateway/client') return { RemoteJournalStream: class {} }
    throw new Error(`Unexpected client external: ${name}`)
  })
  const feed = new exports.MutableSessionEventSource()
  const split = stored.events.findIndex(event => event.type === 'user/message' && event.data.source.desktopReplay)
  feed.replace(stored.events.slice(0, split).map(event => ({ event })), false)
  for (const event of stored.events.slice(split)) feed.append({ event })
  const visibleText = () => feed.getSnapshot().entries
    .filter(item => item.event.type === 'user/message' && item.event.surfaceOp === 'append')
    .map(item => item.event.data.content[0]?.text)
  assert.deepEqual(visibleText(), ['restart'])
  feed.replace(stored.events.slice(split).map(event => ({ event })), true)
  feed.prepend(stored.events.slice(0, split).map(event => ({ event })), false)
  assert.deepEqual(visibleText(), ['restart'])
  const gateway = await clientFactory('@deepseek-ai/dsh-api-gateway')
  assert(gateway.includes('desktop-replay-v1'))
  const gatewayExports = Function(`return (${gateway.replace('return module.exports;', 'module.exports.TestParse = parseInput; return module.exports;')})`)()(
    () => ({ Service: class {} }),
  )
  const value = { requestId: crypto.randomUUID(), sessionId: agent.id, mode: 'desktop-replay-v1', desktopReplayFrom: first.seq, content: [{ type: 'text', text: 'next' }] }
  const parsed = gatewayExports.TestParse({ mode: 'strict', schema }, value, 'session/prompt', 'request')
  assert.equal(parsed.mode, 'desktop-replay-v1')
  assert.equal(parsed.desktopReplayFrom, first.seq)
  assert.equal(await readFile(controllerPath, 'utf8'), before)
  console.log('PASS installed Runtime: actual controller/codec/loop/JSONL, client live+reload+pagination; core files unchanged')
} finally {
  await ctx.fiber.dispose()
  expose.deregister()
  assert(relative(tmpdir(), directory).startsWith('dsh-installed-replay-smoke-'))
  await rm(directory, { recursive: true, force: true })
}
