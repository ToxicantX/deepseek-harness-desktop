// Actual Runtime compaction transactions with a deterministic offline provider.
// Usage: node scripts/smoke-compaction-reasoning.mjs <runtime-root>
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { prepareCompactionOverlay } from '../src/compaction-overlay.ts'

assert(process.argv[2], 'Pass the installed Runtime root explicitly')
const runtime = resolve(process.argv[2])
const dshPackage = join(runtime, 'app/node_modules/@deepseek-ai/dsh/package.json')
const base = createRequire(dshPackage)
const runtimeVersion = JSON.parse(await readFile(dshPackage, 'utf8')).version
const moduleHashes = new Map()
const digest = async file => createHash('sha256').update(await readFile(file)).digest('hex')
const load = async name => {
  const file = base.resolve(name)
  moduleHashes.set(file, await digest(file))
  return import(pathToFileURL(file).href)
}
const plugin = async name => {
  const module = await load(name)
  return module.default ?? module
}
const directory = await mkdtemp(join(tmpdir(), 'dsh-compaction-reasoning-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = join(directory, 'home')
let ctx
try {
  const { Context } = await load('@deepseek-ai/cordis')
  const Loader = await plugin('@deepseek-ai/cordis-plugin-loader')
  const { LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
  const { Session, SessionId } = await load('@deepseek-ai/dsh-session')
  ctx = new Context()
  await ctx.plugin(Loader)
  const modules = {
    include: await plugin('@deepseek-ai/cordis-plugin-include'),
    llm: await plugin('@deepseek-ai/dsh-llm'),
    sessions: await plugin('@deepseek-ai/dsh-session'),
    agents: await plugin('@deepseek-ai/dsh-agent'),
    projections: await plugin('@deepseek-ai/dsh-session-projection'),
    prompt: await plugin('@deepseek-ai/dsh-system-prompt'),
    tools: await plugin('@deepseek-ai/dsh-tools'),
    executor: await plugin('@deepseek-ai/dsh-tool-executor-native'),
    attachments: await plugin('@deepseek-ai/dsh-attachment'),
    persistence: await plugin('@deepseek-ai/dsh-session-persistence-jsonl'),
    loop: await plugin('@deepseek-ai/dsh-agent-loop'),
    meter: await plugin('@deepseek-ai/dsh-token-meter'),
    compact: await plugin('@deepseek-ai/dsh-compaction-basic'),
  }
  Object.assign(ctx.loader.builtins, modules)
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['llm', 'sessions', 'agents', 'projections', 'prompt', 'tools', 'executor', 'attachments', 'meter']
      .map(name => ({ name: 'cordis:' + name })),
    { name: 'cordis:persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:loop', config: { agents: [] } },
    { name: 'cordis:compact', config: { thresholdRatio: 0.6, headroomTokens: 128, retainTokens: 128, maxTokens: 512, compactionRetries: 0 } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  assert(ctx.get('compaction'), 'actual compaction backend must activate')

  const unsupported = 'chatgpt API error (400): {"code":"unsupported_value","message":"Unsupported value: \'none\' is not supported with the \'gpt-6.1-sol\' model.","param":"reasoning.effort","type":"invalid_request_error"}'
  class Adapter extends LlmAdapter {
    requests = []
    mode = 'success'
    entered
    resolveModel(provider, model) {
      return Promise.resolve({
        provider, id: model, name: model,
        context: { contextWindow: 16000 },
        reasoning: {
          efforts: ['off', 'low', 'medium', 'high', 'xhigh', 'max'].map(id => ({ id, name: id })),
          defaultEffort: 'off',
        },
      })
    }
    async *stream(request) {
      this.requests.push(request)
      if (request.purpose === 'compaction') {
        if (!request.reasoningEffort || ['off', 'none'].includes(request.reasoningEffort)) {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PI_AI_ERROR', message: unsupported } } }
          return
        }
        if (this.mode === 'quota') {
          yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE_QUOTA', message: 'fixture quota exceeded' } } }
          return
        }
        if (this.mode === 'wait') {
          this.entered?.()
          await new Promise((resolveWait, reject) => {
            if (request.signal.aborted) reject(request.signal.reason)
            else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
          })
          return
        }
      }
      const text = request.purpose === 'compaction' ? 'Checkpoint: preserve the fixture task and continue.' : 'fixture reply'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['chatgpt'], adapter)
  const agentOptions = { provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'high', maxTokens: 512 }
  const create = async (id, parent, reasoningEffort = 'high') => ctx.agents.create({
    sessionId: SessionId('compaction-' + id), agentOptions: { ...agentOptions, reasoningEffort },
    ...(parent ? { parentAgent: parent } : {}),
    meta: { cwd: directory, ...(parent ? { parentSession: parent.id, origin: 'subagent', delegationDepth: 1 } : {}) },
  })
  const converse = async (agent, characters = 12000) => {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: 'fixture history '.repeat(Math.ceil(characters / 16)) }],
      source: { kind: 'user-rpc', requestId: 'fixture-' + agent.session.seq },
    }))
    await agent.whenIdle()
    const reason = agent.session.snapshotEvents().at(-1)?.data.reason
    assert.notEqual(reason?.kind, 'error', JSON.stringify(reason))
  }
  const summaries = agent => agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')
  const lastEnd = agent => agent.session.snapshotEvents().findLast(event => event.type === 'compaction/end')
  const baseline = await create('baseline')
  await converse(baseline.agent)
  await assert.rejects(ctx.compaction.compactNow(baseline.agent, new AbortController().signal, 'fixture-before'), error => {
    assert.equal(error.code, 'summary')
    assert.match(error.cause?.message ?? '', /reasoning\.effort/)
    return true
  })
  assert.equal(adapter.requests.at(-1).reasoningEffort, 'off')
  assert.match(lastEnd(baseline.agent).data.error, /reasoning\.effort/)
  assert.equal(summaries(baseline.agent).length, 0)
  console.log('PASS reproduction: actual manual compaction defaults to off/none and records the provider 400')

  const overlay = await prepareCompactionOverlay({
    runtime: { manifest: { dshVersion: runtimeVersion } },
    pluginFile: fileURLToPath(new URL('../resources/compaction-reasoning/index.mjs', import.meta.url)),
    directory: join(directory, 'overlays'),
  })
  assert(overlay, 'the installed Runtime must support the compaction overlay')
  const patches = parse(await readFile(overlay.path, 'utf8'))
  assert.equal(patches[0].insert[0].id, 'desktop-compaction-reasoning')
  assert.match(patches[0].insert[0].name, /^file:/)
  const recoveryConfig = join(directory, 'recovery.yml')
  await writeFile(recoveryConfig, '[]')
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(recoveryConfig).href, patches } })
  await ctx.loader.await()
  const requestsBefore = adapter.requests.length
  const manual = await ctx.compaction.compactNow(baseline.agent, new AbortController().signal, 'fixture-after')
  assert(manual, 'manual compaction must make a real surface replacement')
  assert.equal(adapter.requests.length, requestsBefore + 1)
  assert.equal(adapter.requests.at(-1).reasoningEffort, 'high')
  assert.equal(lastEnd(baseline.agent).data.error, undefined)
  assert.equal(lastEnd(baseline.agent).data.sourceCommandId, 'fixture-after')
  assert.equal(summaries(baseline.agent).length, 1)
  console.log('PASS overlay/manual: Shell-generated patch loads the resource file through actual Include; high is reused and a real checkpoint is committed')

  const automatic = await create('automatic')
  await converse(automatic.agent, 48000)
  await converse(automatic.agent, 2048)
  const beforeAuto = summaries(automatic.agent).length
  const beforePressure = ctx.tokenMeter.measure(automatic.agent.session).totalTokens
  await converse(automatic.agent, 100)
  assert(summaries(automatic.agent).length > beforeAuto, 'pre-step must automatically compact above threshold with a retainable recent tail: ' + JSON.stringify({ beforePressure, measured: ctx.tokenMeter.measure(automatic.agent.session).totalTokens, ends: automatic.agent.session.snapshotEvents().filter(event => event.type === 'compaction/end') }))
  assert.equal(lastEnd(automatic.agent).data.error, undefined)
  assert.equal(lastEnd(automatic.agent).data.sourceCommandId, undefined)
  assert.equal(typeof lastEnd(automatic.agent).data.turn, 'number')
  console.log('PASS automatic: real pre-step pressure compacts inside an active turn')

  const fallback = await create('fallback', undefined, 'off')
  await converse(fallback.agent)
  assert.equal(adapter.requests.at(-1).reasoningEffort, 'off', 'ordinary requests must keep their selected effort')
  const fallbackResult = await ctx.compaction.compactNow(fallback.agent, new AbortController().signal)
  assert(fallbackResult)
  assert.equal(adapter.requests.at(-1).reasoningEffort, 'low')
  assert.equal(lastEnd(fallback.agent).data.error, undefined)
  console.log('PASS fallback: compaction uses metadata-supported low when the routed effort is off')

  const child = await create('child', baseline.agent)
  await converse(child.agent)
  const childResult = await ctx.compaction.compactNow(child.agent, new AbortController().signal, 'fixture-child')
  assert(childResult)
  assert.equal(child.agent.session.header.parentSession, baseline.agent.id)
  assert.equal(child.agent.session.header.origin, 'subagent')
  assert.equal(adapter.requests.at(-1).reasoningEffort, 'high')
  assert.equal(lastEnd(child.agent).data.error, undefined)
  console.log('PASS child: the shared middleware also repairs a parent-owned subagent-origin session')

  const quota = await create('quota')
  await converse(quota.agent)
  adapter.mode = 'quota'
  await assert.rejects(ctx.compaction.compactNow(quota.agent, new AbortController().signal), error => {
    assert.equal(error.cause?.code, 'FIXTURE_QUOTA')
    return true
  })
  assert.equal(summaries(quota.agent).length, 0)
  assert.match(lastEnd(quota.agent).data.error, /fixture quota exceeded/)
  adapter.mode = 'success'
  console.log('PASS errors: a real adapter failure remains a failed durable compaction with its original cause')

  const cancelled = await create('cancelled')
  await converse(cancelled.agent)
  adapter.mode = 'wait'
  const entered = new Promise(resolveEntered => { adapter.entered = resolveEntered })
  const controller = new AbortController()
  const operation = ctx.compaction.compactNow(cancelled.agent, controller.signal)
  const rejected = assert.rejects(operation, /fixture compaction cancelled/)
  await entered
  controller.abort(new Error('fixture compaction cancelled'))
  await rejected
  assert.equal(summaries(cancelled.agent).length, 0)
  assert.match(lastEnd(cancelled.agent).data.error, /fixture compaction cancelled/)
  adapter.mode = 'success'
  console.log('PASS cancellation: abort reaches the adapter and no success summary is synthesized')

  for (const handle of [baseline, automatic, fallback, child]) {
    const agent = handle.agent
    await ctx.sessions.flush(agent.session)
    const expectedMessages = agent.session.deriveMessages()
    const expectedSummaryCount = summaries(agent).length
    const reader = await ctx.sessionPersistence.open(agent.id, 'read')
    const stored = await reader.read()
    await reader.close()
    const events = Array.isArray(stored) ? stored : stored.events
    const restored = Session.create(agent.id, events)
    assert.equal(events.filter(event => event.type === 'compaction/summary').length, expectedSummaryCount)
    assert.deepEqual(restored.deriveMessages(), expectedMessages)
    await handle.dispose()
    const resumed = await ctx.agents.resume({ resumeSessionId: agent.id, agentOptions })
    assert.deepEqual(resumed.agent.session.deriveMessages(), expectedMessages)
    assert.equal(summaries(resumed.agent).length, expectedSummaryCount)
    await resumed.dispose()
  }
  await quota.dispose()
  await cancelled.dispose()
  console.log('PASS persistence: manual, automatic, fallback and child summaries survive stored readback and cold agent resume')
  for (const [file, expected] of moduleHashes) assert.equal(await digest(file), expected, 'Runtime module changed: ' + file)
  console.log(JSON.stringify({
    runtime: runtimeVersion,
    runtimeModuleHashesVerified: moduleHashes.size,
    compactionRequests: adapter.requests.filter(request => request.purpose === 'compaction').length,
    ordinaryRequests: adapter.requests.filter(request => request.purpose !== 'compaction').length,
    modelNetworkCalls: 0,
  }))
} finally {
  await ctx?.fiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
