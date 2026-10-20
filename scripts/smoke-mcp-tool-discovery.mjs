import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Actual-runtime regression for the injected MCP discovery helpers.
 *
 * The desktop shell splices `search_mcp_tools` / `get_mcp_tool_schema` straight into the
 * visible tool view, bypassing `defineTool` and `register`, so the engine validates their
 * canonical value against the RAW JsonSchemaNode they declare. `{ type: 'json' }` is the
 * authoring DSL only and made the real output validator throw
 * `unreachable variant in JsonSchemaType: "json"`; `{}` is the unconstrained raw form that
 * accepts both the object hits and the `null` miss.
 *
 * This smoke loads the adapted *installed* dsh-tools registry and drives its real
 * execute/scheduler (`prepare` -> `dispatch` -> `createSuccessResult` -> `post-execute` ->
 * finalize) over a deterministic in-memory MCP fixture. No DSH services, agents, model calls,
 * network, MCP servers, or file writes are involved.
 *
 * Usage:
 *   node scripts/smoke-mcp-tool-discovery.mjs --tools-module <@deepseek-ai/dsh-tools/lib/index.js> [--hook <path>]
 *
 * `--hook` is a module that either exports `installMcpToolDiscoveryHook` (the source injector)
 * or installs its hooks as an import side effect (the built `lib/shutdown-hook.js`). An explicit
 * `--hook` is authoritative: a hook that does not inject the helpers fails the run, and the
 * source injector is never installed as a silent fallback behind a built hook.
 *
 * A missing or wrong `--tools-module` stops the run with a clear error; actual execution is
 * never skipped, because passing this smoke must mean the engine really validated a value.
 */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

function usage(message) {
  const lines = [
    message,
    '',
    'Usage: node scripts/smoke-mcp-tool-discovery.mjs --tools-module <path> [--hook <path>]',
    '',
    '  --tools-module  Installed @deepseek-ai/dsh-tools/lib/index.js to adapt and execute.',
    '  --hook          Injector entry to install: the source injector module',
    '                  (src/mcp-tool-discovery-injector.ts) or the built lib/shutdown-hook.js.',
    '                  Defaults to the source injector next to this script.',
  ].filter(line => line !== undefined)
  throw new Error(lines.join('\n'))
}

function parseArgs(argv) {
  const options = { toolsModule: undefined, hook: resolve(SCRIPT_DIR, '..', 'src', 'mcp-tool-discovery-injector.ts') }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--help' || argument === '-h') usage('MCP discovery actual-runtime smoke')
    if (argument === '--tools-module' || argument === '--hook') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) usage(`Missing value for ${argument}`)
      options[argument === '--tools-module' ? 'toolsModule' : 'hook'] = resolve(process.cwd(), value)
      index += 1
      continue
    }
    usage(`Unrecognized argument: ${argument}`)
  }
  if (options.toolsModule === undefined) {
    usage('Missing --tools-module: the installed @deepseek-ai/dsh-tools/lib/index.js path is required for actual execution')
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
for (const [label, path] of [['tools module', options.toolsModule], ['hook', options.hook]]) {
  if (!existsSync(path)) {
    usage(`MCP discovery actual-runtime smoke: ${label} not found: ${path}`)
  }
}

// Install the discovery hook before the tools module is loaded: the hook adapts it at load time.
const hookModule = await import(pathToFileURL(options.hook).href)
if (typeof hookModule.installMcpToolDiscoveryHook === 'function') {
  hookModule.installMcpToolDiscoveryHook()
} else if (hookModule.installShutdownHook === undefined) {
  throw new Error(`MCP discovery actual-runtime smoke: ${options.hook} exports neither installMcpToolDiscoveryHook nor a shutdown-hook entry point; refusing to guess and refusing to fall back to the source injector`)
}

// Resolve cordis through the tools module's own dependency graph: the Context must be the exact
// instance dsh-tools uses for its scope symbols and Service registration.
const toolsPath = options.toolsModule
const requireFromTools = createRequire(toolsPath)
let cordisEntry
try {
  cordisEntry = requireFromTools.resolve('@deepseek-ai/cordis')
} catch (error) {
  throw new Error(`MCP discovery actual-runtime smoke: ${toolsPath} cannot resolve @deepseek-ai/cordis (${error.message}). Point --tools-module at an installed dsh-tools package.`)
}
const { Context } = await import(pathToFileURL(cordisEntry).href)
const tools = await import(pathToFileURL(toolsPath).href)

assert.equal(typeof tools.ToolRuntime, 'function', 'dsh-tools must export the ToolRuntime service')
assert.equal(typeof tools.defineTool, 'function', 'dsh-tools must export defineTool')

/** Deterministic in-memory registry: real ToolRuntime service, stub prompt registration only. */
function createRuntime() {
  const context = new Context()
  context.provide('systemPrompt', {
    tools() {},
    section() { return {} },
    getSectionOrder() { return 0 },
  })
  return new tools.ToolRuntime(context, { mode: 'native' })
}

const FIXTURE_NAME = 'mcp__fixture__echo_read'
const FIXTURE_DESCRIPTION = 'Deterministic local read-only MCP fixture tool (no network, no side effects)'
const runtime = createRuntime()
const fixtureCalls = []

// A genuine MCP-shaped definition authored through the public defineTool path: the authoring
// `json` output root is compiled to the enforced raw subset, exactly like a real MCP tool.
const fixture = tools.defineTool({
  name: FIXTURE_NAME,
  description: FIXTURE_DESCRIPTION,
  parameters: { input: { type: 'string', description: 'text echoed back unchanged' } },
  output: {
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }, { type: 'text', text: 'fixture-content-retained' }],
    presentationMeta: (_args, value) => ({ origin: value.originalName }),
  },
  async execute(args) {
    fixtureCalls.push(args)
    return { originalName: FIXTURE_NAME, args }
  },
})
runtime.register(fixture)

const visibleNames = [...runtime.view(undefined).visible.keys()]
for (const helper of ['search_mcp_tools', 'get_mcp_tool_schema']) {
  assert.ok(visibleNames.includes(helper), `${options.hook} did not inject ${helper} into the loaded dsh-tools runtime; the hook entry does not match this runtime version`)
}
assert.ok(visibleNames.includes(FIXTURE_NAME), 'the local MCP fixture must be visible in the same native view')

let callId = 0

/**
 * One real registry call through the public ToolRuntime.execute pipeline only: the engine's own
 * scheduler runs prepare -> dispatch -> createSuccessResult (output validation) -> post-execute
 * -> finalize, so a bad output contract fails here exactly as it does in the shell.
 */
async function execute(name, args) {
  const result = await runtime.execute({
    callId: `mcp-discovery-smoke-${++callId}`,
    name,
    arguments: args,
    signal: new AbortController().signal,
  })
  assert.ok(result && typeof result === 'object', `${name} returned no canonical result`)
  assert.equal(typeof result.isError, 'boolean', `${name} result must declare isError`)
  assert.ok(Array.isArray(result.content) && result.content.length > 0, `${name} result must carry content blocks`)
  for (const block of result.content) assert.equal(typeof block.type, 'string', `${name} content blocks must be typed`)
  return result
}

const failure = result => `${result.error?.message ?? JSON.stringify(result.content)}`

// --- The injected helpers, executed by the real engine ---------------------------------------
const search = await execute('search_mcp_tools', { query: 'echo' })
assert.equal(search.isError, false, `search_mcp_tools failed under the real output validator: ${failure(search)}`)
assert.equal(search.value.query, 'echo')
assert.equal(search.value.total, 1)
assert.deepEqual(search.value.items.map(item => item.name), [FIXTURE_NAME])
assert.deepEqual(search.value.items.map(item => item.server), ['fixture'])
assert.ok(search.value.items[0].description.length <= 240)
assert.equal(search.value.limit, 5)
assert.deepEqual(search.value.items[0].name, FIXTURE_NAME)
assert.equal(search.content[0].type, 'text')
assert.deepEqual(JSON.parse(search.content[0].text), search.value, 'rendered content must mirror the canonical object value')
assert.equal(Object.isFrozen(search.value), true, 'the engine must freeze the canonical helper value')

const lookup = await execute('get_mcp_tool_schema', { name: FIXTURE_NAME })
assert.equal(lookup.isError, false, `get_mcp_tool_schema failed under the real output validator: ${failure(lookup)}`)
assert.equal(lookup.value.name, FIXTURE_NAME)
assert.equal(lookup.value.server, 'fixture')
assert.equal(lookup.value.description, FIXTURE_DESCRIPTION)
assert.equal(Object.hasOwn(lookup.value, 'parameters'), false, 'lookup must not leak the registry parameter field')
assert.deepEqual(lookup.value.inputSchema, fixture.parameters, 'the original MCP input schema must be preserved byte for byte')
assert.notEqual(lookup.value.inputSchema, fixture.parameters, 'the lookup must hand back a detached copy')
assert.deepEqual(lookup.value.output, fixture.output.schema, 'the original MCP output schema must be preserved')
assert.deepEqual(JSON.parse(lookup.content[0].text), lookup.value)

// A miss is `null`: the unconstrained raw schema is what makes that value acceptable at all.
const missing = await execute('get_mcp_tool_schema', { name: 'mcp__fixture__absent' })
assert.equal(missing.isError, false, `a missing lookup must not fail output validation: ${failure(missing)}`)
assert.equal(missing.value, null)
assert.equal(missing.content.length, 1)
assert.equal(missing.content[0].type, 'text')
assert.equal(missing.content[0].text, 'null')

// --- The original read-only MCP tool still runs after discovery ------------------------------
const original = await execute(FIXTURE_NAME, { input: 'still-native' })
assert.equal(original.isError, false, `the original MCP tool failed after discovery: ${failure(original)}`)
assert.equal(original.value.originalName, FIXTURE_NAME)
assert.deepEqual(original.value.args, { input: 'still-native' })
assert.deepEqual(original.content, [
  { type: 'text', text: JSON.stringify(original.value) },
  { type: 'text', text: 'fixture-content-retained' },
], 'the original tool must keep its own renderer content')
assert.deepEqual(original.meta, { origin: FIXTURE_NAME }, 'the original tool must keep its own presentation projection')
assert.equal(runtime.get(FIXTURE_NAME), fixture, 'the original definition identity must be unchanged by discovery')
assert.equal(fixtureCalls.length, 1)
assert.deepEqual([...runtime.view(undefined).visible.keys()].includes(FIXTURE_NAME), true)

// --- Negative control: the exact removed bug must still be rejected by the ENGINE ------------
// The helpers bypass register(), so substituting their injected raw output schema is the only way
// to prove the failure happens in post-body output validation rather than registration.
const helper = runtime.get('search_mcp_tools')
assert.ok(helper, 'search_mcp_tools must resolve from the adapted registry')
assert.deepEqual(helper.output.schema, {}, 'the injected helper must declare the unconstrained raw schema')
const validSchema = helper.output.schema
const validExecute = helper.execute
let bodyReached = false
helper.execute = async (args, exec) => {
  bodyReached = true
  return validExecute(args, exec)
}
helper.output.schema = { type: 'json' }
let negative
try {
  negative = await execute('search_mcp_tools', { query: 'echo' })
} finally {
  helper.output.schema = validSchema
  helper.execute = validExecute
}
assert.equal(bodyReached, true, 'the negative control must reach the helper body, proving post-body output validation')
assert.equal(negative.isError, true, 'the engine must reject the authoring-only { type: "json" } raw output schema')
assert.match(
  negative.error.message,
  /unreachable variant in JsonSchemaType: "json"|must be one of object\/array\/string\/number\/integer\/boolean\/null/,
  `unexpected negative-control error: ${negative.error.message}`,
)
assert.equal(negative.value, undefined, 'a rejected output contract yields no canonical value')
assert.equal(runtime.get('search_mcp_tools').output.schema, validSchema, 'the negative control must restore the helper contract')
const recovered = await execute('search_mcp_tools', { query: 'echo' })
assert.equal(recovered.isError, false, 'discovery must work again once the valid raw schema is restored')
assert.equal(recovered.value.total, 1)

console.log(JSON.stringify({
  toolsModule: toolsPath,
  hook: options.hook,
  runtime: 'real adapted dsh-tools ToolRuntime.execute (native, actual scheduler + output validation)',
  search: 'canonical object value, rendered content mirror, frozen by the engine',
  exactSchemaLookup: 'original input/output schemas preserved and detached; no registry parameter leak',
  missingLookup: 'null accepted by the unconstrained raw schema',
  originalTool: 'read-only MCP fixture still executes with its own content and presentation meta',
  negativeControl: 'authoring-only { type: "json" } raw schema reached the body then failed engine output validation',
  scope: 'in-memory fixture only; no agents, model calls, network, MCP servers, or file writes',
}, null, 2))
