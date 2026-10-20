import { stripTypeScriptTypes, type registerHooks } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adaptMcpToolDiscoveryRuntime, installMcpToolDiscoveryHook } from '../src/mcp-tool-discovery-injector.ts'
import { installGrokNativeToolsHook } from '../src/grok-native-tools-injector.ts'

// Production-shaped registry: all bindings flow through prepare/dispatch, never the presenter.
const source = String.raw`
class Registry {
  constructor() {
    this.definitions = new Map(); this.defaultMode = "native";
    this.layers = { chainLayers: scope => scope?.layers ?? [] };
    this.denied = new Set(); this.prepared = new WeakMap(); this.audit = [];
    this.transport = { name: "run_code", parameters: {}, output: { schema: {} } };
  }
  modeFor(scope) {
    const layers = this.layers.chainLayers(scope);
    return scope?.mode ?? this.defaultMode;
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
        const runtime = this.requirePtcRuntime(mode);
        const render = JSON.stringify;
        return render(this.sdkSchemas(context.scope), runtime.programFormat);
      }
    };
  }
  requirePtcRuntime() { return { programFormat: undefined }; }
  requirePtcTransport() { return this.transport; }
  wireSchemas(scope) {
    const view = this.view(scope);
    const mode = this.modeFor(scope);
    if (mode === "native") return {
      schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
      knownNames: [...view.knownNames]
    };
    return { schemas: [this.schemaOf(this.transport)], knownNames: [RUN_CODE_NAME] };
  }
  view(scope) {
    const visible = new Map(this.definitions);
    for (const layer of this.layers.chainLayers(scope)) for (const name of visible.keys()) {
      if (layer.deny?.includes(name) || layer.allow && !layer.allow.includes(name)) visible.delete(name);
    }
    for (const [name, definition] of scope?.ownTools ?? []) visible.set(name, definition);
    const knownNames = new Set(this.definitions.keys()), restrictableNames = new Set(this.definitions.keys());
    if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requirePtcTransport());
    return {
      visible,
      knownNames,
      restrictableNames
    };
  }
  get(name, scope) { return this.view(scope).visible.get(name); }
  resolveExecution(name, scope, nested) {
    const tool = this.get(name, scope);
    if (!nested && this.modeFor(scope) === "ptc" && name !== RUN_CODE_NAME) return undefined;
    return tool;
  }
  schemas(scope) {
    return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
  }
  sdkSchemas(scope) {
    return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
      return { ...this.schemaOf(definition, true), output: structuredClone(definition.output.schema) };
    });
  }
  schemaOf(definition, detach) {
    return { name: definition.name, description: definition.description, parameters: detach ? structuredClone(definition.parameters) : definition.parameters };
  }
  async prepare(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
    this.audit.push(["validate", exec.name]);
    if (!tool) throw new Error("UNKNOWN_TOOL");
    if (this.denied.has(exec.name)) throw new Error("POLICY_DENIED");
    if (exec.signal?.aborted) throw new Error("CANCELLED");
    this.audit.push(["approval", exec.name]);
    this.prepared.set(exec, tool); return exec;
  }
  async dispatch(exec) {
    const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
    if (tool !== this.prepared.get(exec)) throw new Error("identity changed");
    this.audit.push(["timeout", tool.timeoutMs], ["execute", exec.name]);
    const value = await tool.execute(exec.arguments, exec);
    return { value, content: tool.output.render(exec.arguments, value), meta: tool.output.presentationMeta?.(exec.arguments, value) };
  }
  async call(name, args, agent, options = {}) {
    return this.dispatch(await this.prepare({ name, arguments: args, agent, ...options }));
  }
  bindings(agent) {
    return Object.fromEntries(this.sdkSchemas(agent).map(schema => [schema.name, args => this.call(schema.name, args, agent, { parent: {} })]));
  }
}
`.replace(/^ +/gm, spaces => '	'.repeat(spaces.length / 2))

const helperNames = ['search_mcp_tools', 'get_mcp_tool_schema']
function definition(name: string) {
  return { name, description: 'Tool ' + name + ' x'.repeat(400), parameters: { input: { type: 'string', required: true } }, timeoutMs: 123,
    output: { schema: {}, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }, { type: 'image', data: 'retained' }], presentationMeta: () => ({ original: true }) },
    execute: vi.fn(async (args: any) => ({ originalName: name, args })),
  }
}
function fixture(adapt = true, count = 512) {
  const result = adapt ? adaptMcpToolDiscoveryRuntime(source) : { source }
  const Registry = new Function('RUN_CODE_NAME', 'PTC_ONLY_INSTRUCTION', result.source + '; return Registry;')('run_code', 'PTC only')
  const registry = new Registry()
  registry.definitions.set('local', definition('local'))
  for (let i = 0; i < count; i++) registry.definitions.set('mcp__server__tool_' + i, definition('mcp__server__tool_' + i))
  return registry
}
const nativeNames = (r: any, agent: any) => r.wireSchemas(agent).schemas.map((schema: any) => schema.name)
const mcpNames = (r: any, agent: any) => nativeNames(r, agent).filter((name: string) => name.startsWith('mcp__'))
const lookup = async (r: any, agent: any, name: string) => (await r.call('get_mcp_tool_schema', { name }, agent, agent?.mode === 'ptc' ? { parent: {} } : {})).value

afterEach(() => vi.restoreAllMocks())
describe('MCP runtime discovery presentation', () => {
  it('reproduces growing native and SDK context, then bounds both at 512 without removing bindings', () => {
    const baseline = fixture(false), adapted = fixture(), agent = {}, ptc = { mode: 'ptc' }
    expect(nativeNames(baseline, agent)).toHaveLength(513)
    expect(baseline.sdkSection().text({ scope: ptc }).length).toBeGreaterThan(100_000)
    baseline.definitions.set('mcp__new__late', definition('mcp__new__late'))
    expect(baseline.sdkSection().text({ scope: ptc }).length).toBeGreaterThan(100_000)
    expect(nativeNames(adapted, agent)).toEqual(['local', ...helperNames])
    const rendered = JSON.parse(adapted.sdkSection().text({ scope: ptc }))
    expect(rendered.map((schema: any) => schema.name)).toEqual(['local', ...helperNames])
    expect(JSON.stringify(rendered).length).toBeLessThan(4000)
    expect(adapted.wireSchemas(ptc).schemas.map((s: any) => s.name)).toEqual(['run_code'])
    expect(adapted.schemas(agent)).toHaveLength(515)
    expect(adapted.sdkSchemas()).toHaveLength(515)
    expect(Object.keys(adapted.bindings(ptc))).toHaveLength(515)
    expect(adapted.definitions.size).toBe(513)
    expect(adapted.get('mcp__server__tool_511', agent)).toBe(adapted.definitions.get('mcp__server__tool_511'))
  })

  // These helpers bypass defineTool/register and are spliced straight into the visible view, so
  // the engine validates their canonical value against the RAW JsonSchemaNode they declare — not
  // the authoring DSL. `{ type: 'json' }` has no raw counterpart and threw "unreachable variant
  // in JsonSchemaType: json" from the real output validator. `{}` is the unconstrained raw form:
  // it accepts the object hits and the null miss, so both helpers must declare exactly that.
  it('declares both injected helpers with an unconstrained raw output schema', () => {
    // A mocked dispatch accepts anything, so also pin the injected helper source itself: the
    // authoring-only `json` output root must never reappear in the serialized runtime helper.
    const adapted = adaptMcpToolDiscoveryRuntime(source).source
    expect(adapted).not.toMatch(/output:\s*\{\s*schema:\s*\{\s*type:\s*['"]json['"]/)
    const r = fixture(), ptc = { mode: 'ptc' }
    for (const scope of [undefined, {}, ptc]) {
      for (const name of helperNames) {
        const definition = r.get(name, scope)
        expect(definition.output.schema).toEqual({})
        expect(definition.output.schema).not.toHaveProperty('type')
        expect(Object.keys(definition.output.schema)).toEqual([])
        expect(JSON.parse(JSON.stringify(definition.output.schema))).toEqual({})
        expect(definition.output.render({}, { total: 0, items: [] })).toEqual([{ type: 'text', text: '{"total":0,"items":[]}' }])
        expect(definition.output.render({ name: 'missing' }, null)).toEqual([{ type: 'text', text: 'null' }])
      }
    }
  })

  it('uses fresh scoped summaries and detached exact schema lookup with five-entry LRU and agent/service isolation', async () => {
    const r = fixture(), agent = {}, child = Object.create(agent), other = fixture()
    const search = (await r.call('search_mcp_tools', { offset: 1, limit: 99 }, agent)).value
    expect(search).toMatchObject({ total: 512, offset: 1, limit: 10 })
    expect(search.items).toHaveLength(10)
    for (const item of search.items) { expect(Object.keys(item).sort()).toEqual(['description', 'name', 'server']); expect(item.description.length).toBeLessThanOrEqual(240) }
    expect(await lookup(r, agent, 'tool_0')).toBeNull()
    expect(await lookup(r, agent, 'local')).toBeNull()
    expect(mcpNames(r, agent)).toEqual([])
    for (let i = 0; i < 5; i++) await lookup(r, agent, 'mcp__server__tool_' + i)
    await lookup(r, agent, 'mcp__server__tool_0')
    const result = await lookup(r, agent, 'mcp__server__tool_5')
    expect(mcpNames(r, agent)).toEqual([0, 2, 3, 4, 5].map(i => 'mcp__server__tool_' + i))
    expect(mcpNames(r, child)).toEqual([])
    expect(mcpNames(other, agent)).toEqual([])
    expect(mcpNames(r, undefined)).toEqual([])
    expect(result).not.toHaveProperty('parameters')
    expect(result.inputSchema).toEqual(r.get(result.name, agent).parameters)
    expect(result.output).toEqual(r.get(result.name, agent).output.schema)
    result.inputSchema.input.type = 'boolean'; result.output.type = 'string'
    expect(r.get(result.name, agent).parameters.input.type).toBe('string')
    expect(r.get(result.name, agent).output.schema).toEqual({})
    const odd = 'mcp__Mixed-Server__Name.With.Dots'
    r.definitions.set(odd, definition(odd))
    expect((await lookup(r, child, odd)).name).toBe(odd)
    expect(await lookup(r, child, odd.toLowerCase())).toBeNull()
  })

  it('keeps PTC declarations identical after lookups and native-to-PTC switches without filtering bindings', async () => {
    const r = fixture(true, 2), ptc = { mode: 'ptc' }, switching = { mode: 'native' }, name = 'mcp__server__tool_1'
    const before = r.sdkSection().text({ scope: ptc })
    await lookup(r, ptc, name)
    expect(r.sdkSection().text({ scope: ptc })).toBe(before)
    await lookup(r, switching, name)
    expect(mcpNames(r, switching)).toEqual([name])
    switching.mode = 'ptc'
    expect(r.sdkSection().text({ scope: switching })).toBe(before)
    expect(JSON.parse(before).map((schema: any) => schema.name)).toEqual(['local', ...helperNames])
    const called = await r.bindings(switching)[name]({ input: 'still bound' })
    expect(called.value).toEqual({ originalName: name, args: { input: 'still bound' } })
  })

  it('invalidates denied, removed and replaced identities and respects current scoped shadows', async () => {
    const r = fixture(true, 3), agent: any = {}, name = 'mcp__server__tool_0'
    await lookup(r, agent, name)
    agent.layers = [{ deny: [name] }]
    expect(await lookup(r, agent, name)).toBeNull()
    expect((await r.call('search_mcp_tools', {}, agent)).value.total).toBe(2)
    agent.layers = []
    expect(mcpNames(r, agent)).toEqual([])
    await lookup(r, agent, name)
    r.definitions.set(name, definition(name))
    expect(mcpNames(r, agent)).toEqual([])
    await lookup(r, agent, name)
    r.definitions.delete(name)
    expect(mcpNames(r, agent)).toEqual([])
    const shadow = definition(name); shadow.description = 'scoped shadow'
    agent.ownTools = new Map([[name, shadow]])
    expect((await lookup(r, agent, name)).description).toBe('scoped shadow')
    expect(r.get(name, agent)).toBe(shadow)
    agent.ownTools.clear()
    expect(mcpNames(r, agent)).toEqual([])
    expect((await r.call('search_mcp_tools', { query: 'zzzzzzunfindable' }, agent)).value.items).toEqual([])
  })

  it('keeps synthetic identity and original native/PTC policy, cancellation, scheduling and content callbacks', async () => {
    const r = fixture(true, 2), agent = {}, ptc = { mode: 'ptc' }, name = 'mcp__server__tool_1'
    const cached = r.get('get_mcp_tool_schema', agent)
    expect(r.get('get_mcp_tool_schema', ptc)).toBe(cached)
    const pending = await r.prepare({ name: 'get_mcp_tool_schema', arguments: { name }, agent })
    r.view(agent); r.wireSchemas(agent)
    await r.dispatch(pending)
    const original = r.definitions.get(name)
    const native = await r.call(name, { input: 'native' }, agent)
    const nested = await r.bindings(ptc)[name]({ input: 'nested' })
    expect(original.execute).toHaveBeenCalledTimes(2)
    expect(native.content[1]).toEqual({ type: 'image', data: 'retained' })
    expect(nested.meta).toEqual({ original: true })
    expect(r.audit).toContainEqual(['execute', name])
    expect(r.audit).toContainEqual(['timeout', 123])
    expect(r.audit).toContainEqual(['approval', name])
    await expect(r.call(name, {}, ptc)).rejects.toThrow('UNKNOWN_TOOL')
    r.denied.add(name)
    await expect(r.bindings(ptc)[name]({})).rejects.toThrow('POLICY_DENIED')
    r.denied.clear()
    await expect(r.call(name, {}, agent, { signal: AbortSignal.abort() })).rejects.toThrow('CANCELLED')
    r.denied.add('get_mcp_tool_schema')
    await expect(lookup(r, {}, name)).rejects.toThrow('POLICY_DENIED')
    expect(original.execute).toHaveBeenCalledTimes(2)
  })

  it('requires all unique anchors, is idempotent, and rejects partial layouts', () => {
    const result = adaptMcpToolDiscoveryRuntime(source)
    expect(result.changed).toBe(true)
    expect(adaptMcpToolDiscoveryRuntime(result.source)).toEqual({ source: result.source, changed: false })
    expect(adaptMcpToolDiscoveryRuntime(source + source).changed).toBe(false)
    for (const anchor of ['sdkSection()', 'wireSchemas(scope)', 'schemas(scope)', 'sdkSchemas(scope)', 'resolveExecution(name, scope, nested)', 'restrictableNames\n']) {
      const broken = source.replace(anchor, 'unknown')
      expect(adaptMcpToolDiscoveryRuntime(broken)).toEqual({ source: broken, changed: false })
    }
    expect(() => stripTypeScriptTypes(result.source)).not.toThrow()
  })

  it('loads decoded tools URLs only, passes binary source through Grok first, and retains loader metadata', () => {
    const registered: Parameters<typeof registerHooks>[0][] = []
    const register = ((hooks: Parameters<typeof registerHooks>[0]) => { registered.push(hooks); return {} }) as typeof registerHooks
    installGrokNativeToolsHook(register)
    installMcpToolDiscoveryHook(register)
    const context = { format: 'module' as const, conditions: [], importAttributes: {} }
    const url = 'file:///C:/DeepSeek%20Harness/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
    const loaded = { format: 'module', source: Buffer.from(source), custom: 'metadata' }
    const next = vi.fn(() => loaded)
    const grok = registered[0]!.load!, mcp = registered[1]!.load!
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const composed = mcp(url, context, (u, c) => grok(u, { ...context, ...c }, next))
    expect(composed.source).toContain('desktopSupportsGrokNativeTools')
    expect(composed.source).toContain('desktopMcpDiscoveryState')
    expect(composed).toMatchObject({ format: 'module', custom: 'metadata' })
    expect(next).toHaveBeenCalledOnce()
    expect(warn).not.toHaveBeenCalled()
    expect(mcp(url, context, () => composed)).toBe(composed)
    for (const invalid of [url + '.map', url.replace('file:', 'https:'), 'not a url']) expect(mcp(invalid, context, () => loaded)).toBe(loaded)
    const unknown = { format: 'module', source: 'export {}' }
    expect(mcp(url, context, () => unknown)).toBe(unknown)
    expect(mcp(url, context, () => ({ format: 'module' })).source).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(2)
  })


})
