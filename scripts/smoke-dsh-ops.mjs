// Offline host smoke: real installed DSH services and released OPS worker.
// Usage: node scripts/smoke-dsh-ops.mjs --runtime-root <runtime> --plugin-root <unpacked dsh-ops> [--hook]
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

function argument(name) {
  const index = process.argv.indexOf(name)
  const value = index < 0 ? undefined : process.argv[index + 1]
  assert(value && !value.startsWith('--'), `Pass ${name} explicitly`)
  return resolve(value)
}
const runtimeRoot = argument('--runtime-root')
const pluginRoot = argument('--plugin-root')
const dshRoot = join(runtimeRoot, 'app', 'node_modules', '@deepseek-ai', 'dsh')
const runtimeRequire = createRequire(join(dshRoot, 'package.json'))
const load = name => import(pathToFileURL(runtimeRequire.resolve(name)).href)
const runtime = JSON.parse(await readFile(join(dshRoot, 'package.json'), 'utf8'))
const plugin = JSON.parse(await readFile(join(pluginRoot, 'package.json'), 'utf8'))
assert.equal(plugin.name, 'dsh-ops')
assert.equal(plugin.version, '0.4.4', 'smoke was reviewed against the released 0.4.4 package')
const { satisfies } = await import('semver')
assert(satisfies(runtime.version, plugin.engines.dsh, { includePrerelease: true }), 'Runtime is outside the plugin declared host range')
const worker = join(pluginRoot, 'runtime', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'dsh-ops-worker.exe' : 'dsh-ops-worker')
const provenance = JSON.parse(await readFile(join(pluginRoot, 'runtime', `${process.platform}-${process.arch}`, 'provenance.json'), 'utf8'))
const workerBytes = await readFile(worker)
const workerHash = createHash('sha256').update(workerBytes).digest('hex')
assert.equal(workerHash, provenance.sha256, 'released worker provenance must match')

const directory = await mkdtemp(join(tmpdir(), 'dsh-ops-host-smoke-'))
const priorHome = process.env.DSH_HOME
process.env.DSH_HOME = join(directory, 'home')
const pluginPrefix = pathToFileURL(pluginRoot).href + '/'
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(pluginPrefix) && specifier.startsWith('@deepseek-ai/')) {
      return nextResolve(pathToFileURL(runtimeRequire.resolve(specifier)).href, context)
    }
    return nextResolve(specifier, context)
  },
})
const contexts = []
try {
  if (process.argv.includes('--hook')) await import('../lib/shutdown-hook.js')
  const { Context } = await load('@deepseek-ai/cordis')
  const { default: Agents } = await load('@deepseek-ai/dsh-agent')
  const { default: Sessions, SessionId } = await load('@deepseek-ai/dsh-session')
  const { default: Projections } = await load('@deepseek-ai/dsh-session-projection')
  const { default: Prompt } = await load('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await load('@deepseek-ai/dsh-tools')
  const { default: Policy, setSandboxMode } = await load('@deepseek-ai/dsh-sandbox-policy')
  const { default: Subprocess } = await load('@deepseek-ai/dsh-subprocess-local')
  const { default: Sandbox } = await load('@deepseek-ai/dsh-sandbox-local')
  const { default: FileSystem } = await load('@deepseek-ai/dsh-fs-local')
  const { default: WorkingDirectory } = await load('@deepseek-ai/dsh-working-directory')
  const { default: NodePtc } = await load('@deepseek-ai/dsh-ptc-runtime-node')
  const { createScope } = await load('@deepseek-ai/dsh-scope')
  const file = await import(pathToFileURL(join(pluginRoot, 'lib', 'components', 'file', 'index.js')).href)
  const ptc = await import(pathToFileURL(join(pluginRoot, 'lib', 'ptc', 'index.js')).href)
  const { invoke } = await import(pathToFileURL(join(pluginRoot, 'lib', 'file', 'worker.js')).href)
  const source = join(directory, 'source.txt')
  await writeFile(source, 'alpha\nbeta\nalpha\n')

  async function host(id, presentation) {
    const ctx = new Context()
    contexts.push(ctx)
    for (const component of [Agents, Sessions, Projections]) await ctx.plugin(component, {})
    await ctx.plugin(Prompt, {})
    await ctx.plugin(Tools, { mode: 'native' })
    await ctx.plugin(Policy, { mode: 'workspace-write', workspaceRoot: directory })
    await ctx.plugin(Subprocess)
    await ctx.plugin(Sandbox)
    await ctx.plugin(FileSystem, { cwd: directory })
    await ctx.plugin(WorkingDirectory, {})
    const session = ctx.sessions.create(SessionId(id), { meta: { cwd: directory } })
    setSandboxMode(session, 'workspace-write')
    const agent = { id, session }
    agent.ctx = createScope(ctx, agent).ctx
    if (presentation === 'ptc') {
      await ctx.plugin(NodePtc, {})
      await agent.ctx.plugin({ inject: ['tools'], apply(inner) { inner.tools.presentAs('ptc') } })
    }
    return { ctx, agent }
  }

  const native = await host('ops-native-smoke', 'native')
  await native.ctx.plugin(file, { binaryPath: worker, required: true })
  await native.ctx.serial('agent/created', { agent: native.agent })
  for (let retry = 0; retry < 100 && !native.ctx.get('tools').get('ops_read_files', native.agent); retry++) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const nativeTool = native.ctx.get('tools').get('ops_read_files', native.agent)
  assert(nativeTool, 'released file component must publish its resident reader')
  const signal = new AbortController().signal
  const readArgs = { files: [{ path: source }] }
  const read = await native.ctx.get('tools').execute({
    name: 'ops_read_files', callId: 'read-smoke', agent: native.agent, signal, arguments: readArgs,
  })
  assert.notEqual(read.isError, true, JSON.stringify(read))
  assert(JSON.stringify(read).includes('alpha'), 'actual resident tool must return fixture bytes: ' + JSON.stringify(read))

  const exec = { agent: native.agent, signal, callId: 'worker-smoke' }
  const config = { binaryPath: worker }
  const grep = await invoke(native.ctx, worker, 'grep', { pattern: 'alpha', path: directory }, exec, signal, config)
  assert.equal(grep.status, 'completed', JSON.stringify(grep))
  assert(JSON.stringify(grep).includes('source.txt'), 'grep must find the fixture')
  const original = await readFile(source, 'utf8')
  const revision = createHash('sha256').update(original).digest('hex')
  const ambiguous = await invoke(native.ctx, worker, 'edit_file', {
    path: source, expectedRevision: revision, edits: [{ oldText: 'alpha', newText: 'changed' }],
  }, exec, signal, config)
  assert.equal(ambiguous.status, 'error', JSON.stringify(ambiguous))
  assert.equal(ambiguous.error.code, 'EDIT_CONFLICT')
  assert.equal(await readFile(source, 'utf8'), original, 'ambiguous edits must preserve fixture bytes')
  const edited = await invoke(native.ctx, worker, 'edit_file', {
    path: source, expectedRevision: revision, edits: [{ oldText: 'beta', newText: 'changed' }],
  }, exec, signal, config)
  assert.equal(edited.status, 'completed', JSON.stringify(edited))
  assert.equal(await readFile(source, 'utf8'), 'alpha\nchanged\nalpha\n')
  const stale = await invoke(native.ctx, worker, 'edit_file', {
    path: source, expectedRevision: revision, edits: [{ oldText: 'changed', newText: 'stale overwrite' }],
  }, exec, signal, config)
  assert.equal(stale.status, 'error', JSON.stringify(stale))
  assert.equal(stale.error.code, 'REVISION_CONFLICT')
  assert.equal(await readFile(source, 'utf8'), 'alpha\nchanged\nalpha\n')
  console.log('PASS native: registry read, host/worker grep, successful edit, ambiguous/stale edit rejection')

  const typed = await host('ops-ptc-smoke', 'ptc')
  await typed.ctx.plugin(ptc, { binaryPath: worker, required: true, alwaysLoaded: ['batch'] })
  await typed.ctx.serial('agent/created', { agent: typed.agent })
  for (let retry = 0; retry < 100 && !typed.ctx.get('tools').get('ops_result', typed.agent); retry++) {
    await typed.ctx.get('systemPrompt').assemble({ scope: typed.agent })
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert(typed.ctx.get('tools').get('ops_result', typed.agent), 'PTC result API must become available')
  const result = await typed.ctx.get('tools').execute({
    name: 'run_code', callId: 'ptc-smoke', agent: typed.agent, signal,
    arguments: {
      description: 'Verify the released OPS PTC result contract',
      code: "const stored = await tools.ops_result({action:'put',items:[{n:1},{n:2}]}); if(stored.status !== 'completed') return stored; const page = await tools.ops_result({action:'page',id:stored.data.id}); return {stored:stored.status,page:page.status,items:page.data.items};",
    },
  })
  assert.notEqual(result.isError, true, JSON.stringify(result))
  assert.equal(result.value.result.stored, 'completed', JSON.stringify(result))
  assert.equal(result.value.result.page, 'completed', JSON.stringify(result))
  assert.deepEqual(result.value.result.items, [{ n: 1 }, { n: 2 }])
  console.log('PASS PTC: real run_code -> OPS native result put/page -> typed Outcome')
  console.log(JSON.stringify({ runtime: runtime.version, plugin: plugin.version, workerSha256: workerHash, modelNetworkCalls: 0 }))
} finally {
  for (const ctx of contexts.reverse()) await ctx.fiber.dispose()
  hook.deregister()
  if (priorHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = priorHome
  await rm(directory, { recursive: true, force: true })
}
