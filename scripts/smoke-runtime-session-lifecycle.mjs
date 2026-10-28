// DSH 0.2.2 subagent-control regression; all sessions and writes use a disposable store.
// Usage: node scripts/smoke-runtime-session-lifecycle.mjs <runtime-root> [--hook]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'

assert(process.argv[2], 'Pass the installed Runtime root explicitly')
const runtime = resolve(process.argv[2])
const dshPackage = join(runtime, 'app/node_modules/@deepseek-ai/dsh/package.json')
const base = createRequire(dshPackage)
const load = name => import(pathToFileURL(base.resolve(name)).href)
const plugin = async name => {
  const module = await load(name)
  return module.default ?? module
}
const directory = await mkdtemp(join(tmpdir(), 'dsh-session-lifecycle-'))
const previousHome = process.env.DSH_HOME
process.env.DSH_HOME = join(directory, 'home')
let ctx
try {
  if (process.argv.includes('--hook')) await import('../lib/shutdown-hook.js')
  const { Context } = await load('@deepseek-ai/cordis')
  const Loader = await plugin('@deepseek-ai/cordis-plugin-loader')
  const Include = await plugin('@deepseek-ai/cordis-plugin-include')
  const { LlmAdapter, createUserMessage } = await load('@deepseek-ai/dsh-llm')
  const { Session, SessionId } = await load('@deepseek-ai/dsh-session')
  ctx = new Context()
  await ctx.plugin(Loader)
  const modules = {
    include: Include,
    llm: await plugin('@deepseek-ai/dsh-llm'),
    sessions: await plugin('@deepseek-ai/dsh-session'),
    agents: await plugin('@deepseek-ai/dsh-agent'),
    projections: await plugin('@deepseek-ai/dsh-session-projection'),
    prompt: await plugin('@deepseek-ai/dsh-system-prompt'),
    tools: await plugin('@deepseek-ai/dsh-tools'),
    nativeExecutor: await plugin('@deepseek-ai/dsh-tool-executor-native'),
    persistence: await plugin('@deepseek-ai/dsh-session-persistence-jsonl'),
    attachments: await plugin('@deepseek-ai/dsh-attachment'),
    loop: await plugin('@deepseek-ai/dsh-agent-loop'),
    workingDirectory: await plugin('@deepseek-ai/dsh-working-directory'),
    fs: await plugin('@deepseek-ai/dsh-fs-local'),
    subagents: await plugin('@deepseek-ai/dsh-subagent'),
    presets: await plugin('@deepseek-ai/dsh-agent-preset-registry'),
    control: await plugin('@deepseek-ai/dsh-tool-subagent-control'),
  }
  Object.assign(ctx.loader.builtins, modules)
  const config = join(directory, 'cordis.yml')
  await writeFile(config, JSON.stringify([
    ...['llm', 'sessions', 'agents', 'projections', 'prompt', 'tools', 'nativeExecutor', 'attachments', 'fs', 'workingDirectory', 'subagents']
      .map(name => ({ name: 'cordis:' + name })),
    { name: 'cordis:persistence', config: { root: join(directory, 'sessions'), compression: 'none' } },
    { name: 'cordis:presets', config: { default: 'fixed-control' } },
    { name: 'cordis:loop', config: { agents: [] } },
  ]))
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(config).href } })
  await ctx.loader.await()
  assert(ctx.get('agentPresets'), 'preset registry must be active')

  const presetArgument = name => {
    const index = process.argv.indexOf(name)
    return index < 0 ? undefined : process.argv[index + 1]
  }
  async function controlRows(file, defaults) {
    if (!file) return defaults
    const rows = parse(await readFile(file, 'utf8'), {
      customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => ({ __jsExpr: value }) }],
    })
    const found = []
    const visit = entries => {
      for (const row of entries) {
        if (row.name === '@deepseek-ai/dsh-tool-subagent-control') found.push({ ...row, name: 'cordis:control' })
        if (row.name === '@deepseek-ai/dsh-tool-subagent-control/list-agents') found.push(row)
        if (row.group === true && Array.isArray(row.config)) visit(row.config)
      }
    }
    visit(rows)
    assert.equal(found.length, 2, 'expected the actual shared-control and legacy list-agents rows')
    return found
  }
  const oldRows = await controlRows(presetArgument('--old-control-preset'), [
    { id: 'tool-subagent-control', name: 'cordis:control' },
    { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
  ])
  await ctx.agentPresets.register({ id: 'broken-control', plugins: oldRows })
  const broken = (await ctx.agentPresets.compositionInventory()).find(item => item.id === 'broken-control')
  assert(broken.broken?.includes('tool-subagent-list-agents'), JSON.stringify(broken))
  assert.throws(() => base.resolve('@deepseek-ai/dsh-tool-subagent-control/list-agents'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
  console.log('PASS reproduction: the removed list-agents subpath makes its preset invalid')

  const newRows = await controlRows(presetArgument('--new-control-preset'), [
    { id: 'tool-subagent-control', name: 'cordis:control' },
    { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents', disabled: true },
  ])
  await ctx.agentPresets.register({ id: 'fixed-control', plugins: newRows })
  const fixed = (await ctx.agentPresets.compositionInventory()).find(item => item.id === 'fixed-control')
  assert.equal(fixed.broken, undefined, JSON.stringify(fixed))
  class Adapter extends LlmAdapter {
    requests = 0
    resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }
    async *stream() {
      this.requests++
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'fixture reply' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: 'fixture reply' } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  const adapter = new Adapter()
  ctx.llm.registerAdapter(['mock'], adapter)
  const create = preset => ctx.agents.create({
    sessionId: SessionId('lifecycle-' + preset),
    agentOptions: { provider: 'mock', model: 'mock' },
    meta: { cwd: directory, agentPreset: preset },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, preset) },
  })
  await assert.rejects(create('broken-control'), error => error.code === 'agent-preset/invalid')
  const handle = await create('fixed-control')
  const { agent } = handle
  for (const name of ['list_agents', 'send_message', 'interrupt_agent']) assert(ctx.tools.get(name, agent), 'missing shared subagent tool: ' + name)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user-rpc', requestId: 'lifecycle-fixture' } }))
  await agent.whenIdle()
  const events = agent.session.snapshotEvents()
  assert.equal(adapter.requests, 1, JSON.stringify(events.at(-1)))
  assert(events.some(event => event.type === 'assistant/message'))
  assert.notEqual(events.at(-1)?.data.reason?.kind, 'error')
  await ctx.sessions.flush(agent.session)
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  const stored = await reader.read()
  await reader.close()
  const savedEvents = Array.isArray(stored) ? stored : stored.events
  const restored = Session.create(agent.id, savedEvents)
  assert.deepEqual(restored.deriveMessages(), agent.session.deriveMessages())
  const expectedMessages = agent.session.deriveMessages()
  await handle.dispose()
  assert.equal(ctx.agents.get(agent.id), undefined)
  const listing = await ctx.sessionPersistence.list()
  assert(listing.some(entry => entry.header.id === agent.id), 'closed session must remain discoverable')
  const resumed = await ctx.agents.resume({
    resumeSessionId: agent.id,
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'fixed-control') },
  })
  assert.deepEqual(resumed.agent.session.deriveMessages(), expectedMessages)
  for (const name of ['list_agents', 'send_message', 'interrupt_agent']) assert(ctx.tools.get(name, resumed.agent))
  await resumed.dispose()
  console.log('PASS fixed preset: new session, actual subagent control tools, fixture reply, persisted history listing and cold resume')
  console.log(JSON.stringify({ runtime: JSON.parse(await readFile(dshPackage, 'utf8')).version, hook: process.argv.includes('--hook'), modelNetworkCalls: 0 }))
} finally {
  await ctx?.fiber.dispose()
  if (previousHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousHome
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}
