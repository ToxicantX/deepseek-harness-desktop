// Node 24; reads an installed split-controller Runtime without changing its files.
// Usage: node scripts/smoke-empty-stream-recovery.mjs --agent-loop-module <runtime dir | dsh-agent-loop/lib/index.js> [--hook]
// --agent-loop-module is required; the script fails explicitly when it is missing.
// --hook imports the built ../lib/shutdown-hook.js (no source fallback) instead
// of installing the source injector directly.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const moduleArg = flag('--agent-loop-module')
assert(moduleArg, 'Pass --agent-loop-module <installed runtime directory or dsh-agent-loop/lib/index.js> explicitly')
const resolved = resolve(moduleArg)
assert(existsSync(resolved), `--agent-loop-module path does not exist: ${resolved}`)
const isDirectory = statSync(resolved).isDirectory()
let dshRoot
let loopFile
if (isDirectory) {
  const pnpm = join(resolved, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '.pnpm')
  const candidates = []
  for (const entry of readdirSync(pnpm)) {
    const file = join(pnpm, entry, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js')
    if (existsSync(file)) candidates.push(file)
  }
  assert(candidates.length > 0, 'No installed dsh-agent-loop found under the runtime')
  candidates.sort()
  loopFile = candidates.at(-1)
  dshRoot = loopFile
} else {
  loopFile = resolved
  dshRoot = resolved
}
// Terminate the ancestor search at the filesystem root instead of looping forever.
for (;;) {
  if (dshRoot.endsWith(join('@deepseek-ai', 'dsh'))) break
  const parent = resolve(dshRoot, '..')
  if (parent === dshRoot) {
    throw new Error(`Could not locate the installed @deepseek-ai/dsh package above: ${dshRoot}`)
  }
  dshRoot = parent
}

if (process.argv.includes('--hook')) {
  await import('../lib/shutdown-hook.js')
} else {
  const { installEmptyStreamRecoveryHook } = await import('../src/empty-stream-recovery-injector.ts')
  installEmptyStreamRecoveryHook()
}

const before = await readFile(loopFile, 'utf8')
const base = createRequire(join(dshRoot, 'package.json'))
const load = name => import(pathToFileURL(base.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { default: Loader } = await load('@deepseek-ai/cordis-plugin-loader')
const { default: Include } = await load('@deepseek-ai/cordis-plugin-include')
const { default: Llm, LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
const { default: Sessions, SessionId } = await load('@deepseek-ai/dsh-session')
const { default: Agents } = await load('@deepseek-ai/dsh-agent')
const { default: Loop } = await load('@deepseek-ai/dsh-agent-loop')
const { default: Prompt } = await load('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await load('@deepseek-ai/dsh-tools')
const { default: Jsonl } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { default: Attachments } = await load('@deepseek-ai/dsh-attachment')
const { default: Projections } = await load('@deepseek-ai/dsh-session-projection')
const Retry = await load('@deepseek-ai/dsh-llm-retry')

// Deterministic stub provider: the first attempt ends with the upstream
// empty-stream failure (zero content, usage metadata only); the second streams
// one text answer. No network, no model calls.
class Adapter extends LlmAdapter {
  requests = []
  alwaysEmpty = false
  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
  async *stream(request) {
    this.requests.push(request)
    if (this.alwaysEmpty || this.requests.length === 1) {
      yield { type: 'usage', usage: { input: 10, output: 0 } }
      yield { type: 'finish', reason: { kind: 'error', failure: {
        message: 'upstream pi-ai returned empty_stream for model mock',
        code: 'PI_AI_ERROR',
      } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'answer' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'answer' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

const directory = await mkdtemp(join(tmpdir(), 'dsh-empty-stream-smoke-'))
const ctx = new Context()
try {
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include, llm: Llm, sessions: Sessions, agents: Agents, loop: Loop,
    prompt: Prompt, tools: Tools, persistence: Jsonl, attachments: Attachments, projections: Projections, retry: Retry,
  })
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['llm', 'sessions', 'agents', 'prompt', 'tools', 'attachments', 'projections'].map(name => ({ name: `cordis:${name}` })),
    { name: 'cordis:persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:retry' },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()

  const adapter = new Adapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const agent = await ctx.agentLoop.create(SessionId('empty-stream-smoke'), { provider: 'mock', model: 'mock' })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user-rpc', requestId: 'smoke' } }))
  await agent.whenIdle()

  // The recovery path re-issued exactly one request and committed a durable
  // assistant message; the failed attempt settled as assistant/attempt.
  assert.equal(adapter.requests.length, 2, 'expected exactly one empty-stream recovery retry')
  const events = agent.session.snapshotEvents()
  const retries = events.filter(event => event.type === 'llm/retry')
  assert.equal(retries.length, 1, 'the real retry plugin must schedule exactly one retry')
  assert.equal(retries[0].data.failure.code, 'EMPTY_RESPONSE')
  assert(events.some(event => event.type === 'llm/retry-started'), 'the retry backoff must complete')
  const attempt = events.find(event => event.type === 'assistant/attempt')
  assert(attempt, 'the failed empty attempt must settle durably')
  assert(attempt.data.stream.every(record => record.type === 'chunk'), 'failed attempt carried no semantic content')
  const message = events.find(event => event.type === 'assistant/message')
  assert(message, 'the recovered attempt must commit an assistant message')
  assert.equal(message.data.message.content[0].text, 'answer')
  const end = events.find(event => event.type === 'turn/end')
  assert.notEqual(end.data.reason.kind, 'error', 'recovered turn must not end in error: ' + JSON.stringify(end.data.reason))

  const persistent = new Adapter()
  persistent.alwaysEmpty = true
  ctx.llm.registerAdapter(['mock-empty'], persistent)
  const failingAgent = await ctx.agentLoop.create(SessionId('empty-stream-persistent'), { provider: 'mock-empty', model: 'mock' })
  failingAgent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user-rpc', requestId: 'persistent-smoke' } }))
  await failingAgent.whenIdle()
  const failures = failingAgent.session.snapshotEvents()
  assert.equal(persistent.requests.length, 3, 'persistent empty streams must stop after two recovery retries')
  assert.equal(failures.filter(event => event.type === 'llm/retry').length, 2)
  assert.equal(failures.filter(event => event.type === 'assistant/attempt').length, 3)
  assert(!failures.some(event => event.type === 'assistant/message'), 'failure must not become a synthetic successful message')
  const failedEnd = failures.find(event => event.type === 'turn/end')
  assert.equal(failedEnd?.data.reason.kind, 'error', 'persistent failure must remain an error')
  assert(JSON.stringify(failedEnd.data.reason).includes('empty_stream'), 'the original empty_stream failure must be retained')
  assert.equal(await readFile(loopFile, 'utf8'), before, 'installed runtime files must remain unchanged')
  console.log('PASS empty-stream recovery: installed agent-loop recovered an upstream empty_stream failure once')
  console.log('PASS persistent empty-stream: stopped after two retries without a synthetic reply')
} finally {
  await ctx.fiber.dispose()
  await rm(directory, { recursive: true, force: true })
}
