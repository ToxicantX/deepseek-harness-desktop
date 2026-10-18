import { stripTypeScriptTypes, type registerHooks } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adaptGrokAgentLoop, adaptGrokToolRuntime, installGrokNativeToolsHook } from '../src/grok-native-tools-injector.ts'

// Executable host fixture: production-shaped anchors and a single registry view
// feeding both schema assembly and staged execution, with inherited restrictions.
const toolsSource = String.raw`
class Registry {
  modeFor(scope) {
    const layers = this.layers.chainLayers(scope);
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const mode = layers[index]?.mode;
      if (mode !== void 0) return mode;
    }
    return this.defaultMode;
  }
  collapseSection() {
    return {
      text: (context) => this.modeFor(context.scope) === "ptc" ? PTC_ONLY_INSTRUCTION : ""
    };
  }
  sdkSection() {
    return {
      text: (context) => {
        const mode = this.modeFor(context.scope);
        if (mode === "native") return "";
        return "SDK_PROGRAM_INSTRUCTIONS: " + [...this.view(context.scope).visible.keys()].join(",");
      }
    };
  }
  wireSchemas(scope) {
    const view = this.view(scope);
    const mode = this.modeFor(scope);
    if (mode === "native") return {
      schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
      knownNames: [...view.knownNames]
    };
    return { schemas: [this.schemaOf(this.transport)], knownNames: ["run_code"] };
  }
  schemaOf(definition) { return definition.schema; }
  view(scope) {
    const layers = this.layers.chainLayers(scope);
    const visible = new Map(this.definitions);
    for (const layer of layers) for (const name of visible.keys()) {
      if (layer.allow && !layer.allow.includes(name)) visible.delete(name);
    }
    for (const [name, definition] of scope?.ownTools ?? []) visible.set(name, definition);
    if (this.modeFor(scope) !== "native") visible.set("run_code", this.transport);
    return { visible, knownNames: new Set(this.definitions.keys()) };
  }
  resolveExecution(name, scope, nested) {
    if (!nested && this.modeFor(scope) === "ptc" && name !== "run_code") return undefined;
    return this.view(scope).visible.get(name);
  }
  async prepare(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
    if (!tool) return { kind: "error", error: "UNKNOWN_TOOL" };
    if (this.denied.has(exec.name)) return { kind: "error", error: "POLICY_DENIED" };
    const prepared = { ...exec };
    this.executions.set(prepared, tool);
    return { kind: "dispatch", exec: prepared };
  }
  async dispatch(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
    if (tool !== this.executions.get(exec)) throw new Error("execution identity changed");
    return tool.execute(exec.arguments, exec);
  }
}
`.replace(/^ +/gm, spaces => '\t'.repeat(spaces.length / 2))

const loopSource = String.raw`
class Agent {
  async step(decision) {
    const signal = new AbortController().signal;
    const turn = 1, step = 1;
    const { assembly } = decision;
    const renderedPrompt = renderPrompt(assembly);
    let firstAttempt = true;
    while (true) {
      const { config, preparedCall } = await this.prepareRequest(turn, step, signal);
      const startsRequestSeries = firstAttempt && decision.startsRequestSeries === true;
      const commits = this.systemPrompt.project(renderedPrompt, {
        inHistory: preparedCall?.systemPromptUpdate === "in-history",
        startsSeries: startsRequestSeries || this.requestSurfaceGeneration !== this.session.surface.contentGeneration || preparedCall?.toolUpdate === void 0 && this.toolsChanged(assembly.tools)
      });
      this.commits.push(commits);
      firstAttempt = false;
      const request = this.buildRequest(config, assembly.tools, renderedPrompt);
      if (this.retry && this.retry()) continue;
      return request;
    }
  }
  async prepareRequest() { return { config: { model: this.actualModel }, preparedCall: { systemPromptUpdate: "in-history", toolUpdate: "in-history" } }; }
  toolsChanged(tools) { return JSON.stringify(tools) !== JSON.stringify(this.lastTools); }
  buildRequest(config, tools, prompt) { this.lastTools = tools; return { config, tools, prompt, history: this.history }; }
}
`.replace(/^ +/gm, spaces => '\t'.repeat(spaces.length / 2))

function fixture(adapt = true) {
  const registryResult = adapt ? adaptGrokToolRuntime(toolsSource) : { source: toolsSource, changed: false }
  const loopResult = adapt ? adaptGrokAgentLoop(loopSource) : { source: loopSource, changed: false }
  if (adapt) {
    expect(registryResult.changed).toBe(true)
    expect(loopResult.changed).toBe(true)
  }
  const Registry = new Function('PTC_ONLY_INSTRUCTION', registryResult.source + '\nreturn Registry;')('only run_code')
  const Agent = new Function('renderPrompt', 'assembleContextFor', loopResult.source + '\nreturn Agent;')(
    (assembly: any) => assembly.prompt,
    (agent: any, signal: AbortSignal) => ({ agent, scope: agent, signal }),
  )
  const registry = new Registry()
  registry.defaultMode = 'ptc'
  registry.definitions = new Map()
  registry.denied = new Set()
  registry.executions = new WeakMap()
  registry.layers = { chainLayers: (scope: any): any[] => scope ? [...registry.layers.chainLayers(scope.parent), ...(scope.layer ? [scope.layer] : [])] : [] }
  const add = (name: string) => {
    const execute = vi.fn(async (args: unknown, exec: unknown) => ({ args, exec, name }))
    const definition = { schema: { name, description: name, parameters: { type: 'object', properties: {} } }, execute }
    registry.definitions.set(name, definition)
    return definition
  }
  registry.transport = { schema: { name: 'run_code' }, execute: vi.fn() }
  const assemble = vi.fn(async ({ scope }: any) => ({
    tools: registry.wireSchemas(scope).schemas,
    prompt: ['base system', registry.collapseSection().text({ scope }), registry.sdkSection().text({ scope })].filter(Boolean).join('\n'),
  }))
  const makeAgent = (actualModel: string, parent?: any) => {
    const agent = new Agent()
    Object.assign(agent, {
      actualModel, parent, options: { model: 'intentionally-not-the-request-model' },
      loopCtx: { tools: registry, systemPrompt: { assemble } },
      requestSurfaceGeneration: 0, session: { surface: { contentGeneration: 0 } },
      systemPrompt: { project: vi.fn((text, input) => ({ text, input })) },
      history: [{ role: 'user', content: 'User text: only run_code / SDK_PROGRAM_INSTRUCTIONS' }], commits: [],
    })
    return agent
  }
  const run = async (agent: any) => agent.step({ assembly: await assemble({ scope: agent }) })
  return { registry, add, makeAgent, run, assemble }
}

const names = (request: any) => request.tools.map((tool: any) => tool.name)
afterEach(() => vi.restoreAllMocks())

describe('Grok native presentation adapter', () => {
  it('reproduces the PTC direct-call rejection without adaptation', async () => {
    const f = fixture(false)
    f.add('read')
    const agent = f.makeAgent('grok-4.7')
    expect(names(await f.run(agent))).toEqual(['run_code'])
    expect(await f.registry.prepare({ name: 'read', agent })).toEqual({ kind: 'error', error: 'UNKNOWN_TOOL' })
  })

  it.each(['grok-4.7', 'xapi/grok-4.7', 'xai:grok-4.7-thinking', 'provider:GROK-4.7'])('uses actual config.model %s and executes the identical authorized registration', async model => {
    const f = fixture()
    const read = f.add('read')
    f.add('mcp__allowed')
    const agent = f.makeAgent(model)
    const result = await f.run(agent)
    expect(names(result)).toEqual(['read', 'mcp__allowed'])
    expect(result.tools[0]).toBe(read.schema)
    expect(result.prompt).toBe('base system')
    expect(result.prompt).not.toMatch(/only run_code|SDK_PROGRAM_INSTRUCTIONS/)
    expect(result.history).toBe(agent.history)
    expect(agent.commits[0].input.startsSeries).toBe(true)
    const prepared = await f.registry.prepare({ name: 'read', agent, arguments: { file_path: 'example' } })
    expect(prepared.kind).toBe('dispatch')
    const returned = await f.registry.dispatch(prepared.exec)
    expect(read.execute).toHaveBeenCalledWith({ file_path: 'example' }, prepared.exec)
    expect(returned.exec).toBe(prepared.exec)
    expect(await f.registry.prepare({ name: 'run_code', agent })).toEqual({ kind: 'error', error: 'UNKNOWN_TOOL' })
  })

  it('preserves the entire non-Grok flow including preset/native defaults and lookalikes', async () => {
    for (const model of ['gpt-5', 'not-grok-4.7', 'grokish', 'openai/gpt-5']) {
      const original = fixture(false)
      const adapted = fixture()
      for (const f of [original, adapted]) f.add('read')
      const a = original.makeAgent(model), b = adapted.makeAgent(model)
      expect(await adapted.run(b)).toEqual(await original.run(a))
      expect(adapted.assemble.mock.calls).toHaveLength(1)
      expect(Reflect.ownKeys(b).filter(key => typeof key === 'symbol')).toHaveLength(0)
      b.layer = { mode: 'native' }
      expect(names(await adapted.run(b))).toEqual(['read'])
    }
  })

  it('isolates parent/child presentation and restores preset mode on same-agent switching', async () => {
    const f = fixture()
    f.add('read')
    const parent = f.makeAgent('gpt-5')
    const child = f.makeAgent('grok-4.7', parent)
    expect(names(await f.run(parent))).toEqual(['run_code'])
    expect(names(await f.run(child))).toEqual(['read'])
    expect(names(await f.run(parent))).toEqual(['run_code'])
    parent.actualModel = 'grok-4.7'
    child.actualModel = 'gpt-5'
    expect(names(await f.run(parent))).toEqual(['read'])
    expect(names(await f.run(child))).toEqual(['run_code'])
    parent.actualModel = 'gpt-5'
    expect(names(await f.run(parent))).toEqual(['run_code'])
    expect(parent.commits.at(-1).input.startsSeries).toBe(true)
    expect((await f.run(parent)).prompt).toContain('SDK_PROGRAM_INSTRUCTIONS')
    expect(f.registry.modeFor(undefined)).toBe('ptc')
  })

  it('retains inherited allowlists, child-owned tools and monotonic policy denial without inventing read', async () => {
    const f = fixture()
    const denied = f.add('pwsh')
    f.add('mcp__not_allowed')
    const parent = f.makeAgent('gpt-5')
    parent.layer = { allow: ['pwsh'] }
    const child = f.makeAgent('grok-4.7', parent)
    child.ownTools = new Map([['answer', { schema: { name: 'answer' }, execute: vi.fn() }]])
    f.registry.denied.add('pwsh')
    expect(names(await f.run(child))).toEqual(['pwsh', 'answer'])
    expect(await f.registry.prepare({ name: 'mcp__not_allowed', agent: child })).toMatchObject({ error: 'UNKNOWN_TOOL' })
    expect(await f.registry.prepare({ name: 'read', agent: child })).toMatchObject({ error: 'UNKNOWN_TOOL' })
    expect(await f.registry.prepare({ name: 'pwsh', agent: child })).toMatchObject({ error: 'POLICY_DENIED' })
    expect(denied.execute).not.toHaveBeenCalled()
  })

  it('re-evaluates actual model on a retry and preserves empty native capability sets', async () => {
    const f = fixture()
    const agent = f.makeAgent('grok-4.7')
    let retries = 0
    agent.retry = () => { agent.actualModel = 'gpt-5'; return retries++ === 0 }
    expect(names(await f.run(agent))).toEqual(['run_code'])
    agent.retry = undefined
    agent.actualModel = 'grok-4.7'
    expect(names(await f.run(agent))).toEqual([])
  })

  it('does not truncate 350/351 capabilities or silently fall back at the Responses API limit', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const count of [350, 351]) {
      const f = fixture()
      for (let i = 0; i < count; i++) f.add('mcp__' + i)
      const result = await f.run(f.makeAgent('grok-4.7'))
      expect(result.tools).toHaveLength(count)
      expect(names(result)).not.toContain('run_code')
      expect(info).toHaveBeenLastCalledWith(expect.stringContaining(count + ' authorized schemas'))
    }
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('maximum of 350'))
  })

  it('fails before sending when only the loop adapter matches and restores state after assembly failure', async () => {
    const f = fixture()
    const agent = f.makeAgent('grok-4.7')
    f.registry.desktopSupportsGrokNativeTools = undefined
    await expect(f.run(agent)).rejects.toThrow('incompatible tool runtime; no request was sent')
    expect(agent.commits).toEqual([])
    f.registry.desktopSupportsGrokNativeTools = () => true
    f.assemble.mockRejectedValueOnce(new Error('fixture assembly failed'))
    await expect(agent.step({ assembly: { tools: [], prompt: 'old' } })).rejects.toThrow('fixture assembly failed')
    expect(f.registry.modeFor(agent)).toBe('ptc')
  })

  it('requires unique complete anchors and is idempotent', () => {
    for (const [adapter, source] of [[adaptGrokAgentLoop, loopSource], [adaptGrokToolRuntime, toolsSource]] as const) {
      const result = adapter(source)
      expect(result.changed).toBe(true)
      expect(adapter(result.source)).toEqual({ source: result.source, changed: false })
      expect(adapter(source + '\n' + source)).toEqual({ source: source + '\n' + source, changed: false })
      expect(adapter(source.replace('modeFor(scope)', 'unknownMode(scope)').replace('renderPrompt(assembly);', 'unknownRender(assembly);'))).toMatchObject({ changed: false })
      expect(() => stripTypeScriptTypes(result.source)).not.toThrow()
    }
  })

  it('loads only exact decoded module URLs, supports byte sources, warns only for unknown layouts', () => {
    let hooks: Parameters<typeof registerHooks>[0] = {}
    installGrokNativeToolsHook(((value: Parameters<typeof registerHooks>[0]) => { hooks = value; return {} }) as typeof registerHooks)
    const load = hooks.load!
    const context = { format: 'module' as const, conditions: [], importAttributes: {} }
    const loaded = { format: 'module', source: Buffer.from(loopSource) }
    const url = 'file:///C:/DeepSeek%20Harness/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
    const next = vi.fn(() => loaded)
    expect(load(url + '.map', context, next)).toBe(loaded)
    const result = load(url, context, next)
    expect(result.source).toContain('desktopGrokNativePresentation')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(load(url, context, () => result)).toBe(result)
    expect(warn).not.toHaveBeenCalled()
    const unknown = { format: 'module', source: 'export {}' }
    expect(load(url, context, () => unknown)).toBe(unknown)
    expect(warn).toHaveBeenCalledOnce()
  })
})
