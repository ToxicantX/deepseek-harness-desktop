import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'
import { createMcpToolDiscovery } from './mcp-tool-discovery.ts'

const TOOLS_SUFFIX = '/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const MARKER = 'desktopMcpDiscoveryState'

// Serialized with the helper into the installed module; no desktop imports at runtime.
function createRuntimeDiscovery(registry: any, discover: typeof createMcpToolDiscovery) {
  const active = new WeakMap<object, Map<string, any>>()
  const clone = (value: any) => JSON.parse(JSON.stringify(value))
  const isAgent = (scope: any): scope is object => scope !== null && (typeof scope === 'object' || typeof scope === 'function')
  const prune = (scope: any, visible: Map<string, any>) => {
    const entries = isAgent(scope) ? active.get(scope) : undefined
    if (entries) for (const [name, definition] of entries) {
      if (visible.get(name) !== definition) entries.delete(name)
    }
    return entries
  }
  const index = (visible: Map<string, any>) => discover([...visible.values()]
    .filter(definition => definition.name.startsWith('mcp__'))
    .map(definition => ({ name: definition.name, description: definition.description ?? '', inputSchema: definition.parameters })))
  const guidance = 'Search MCP tools, then get the exact schema. Call the original name: PTC tools[name](args); native call on the next step.'
  // These definitions bypass defineTool/register and enter the visible view directly, so the
  // engine validates their canonical value against this RAW JsonSchemaNode — never the authoring
  // DSL, whose `{ type: 'json' }` has no raw counterpart (the validator throws "unreachable
  // variant in JsonSchemaType"). `{}` is the unconstrained raw form: any lossless JSON value,
  // object for search/lookup hits and null for a missing schema lookup. Renderers are unchanged.
  const definitions = [
    {
      name: 'search_mcp_tools', description: 'Search visible MCP tool summaries with pagination. ' + guidance,
      parameters: { query: { type: 'string' }, server: { type: 'string' }, limit: { type: 'integer' }, offset: { type: 'integer' } },
      output: { schema: {}, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args: any, exec: any) {
        const visible = registry.view(exec.agent).visible
        prune(exec.agent, visible)
        return index(visible).search(args)
      },
    },
    {
      name: 'get_mcp_tool_schema', description: 'Get one exact visible MCP schema and activate its native definition (five most recent schema lookups per agent). ' + guidance,
      parameters: { name: { type: 'string', required: true } },
      output: { schema: {}, render: (_args: any, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
      execute(args: any, exec: any) {
        const visible = registry.view(exec.agent).visible
        prune(exec.agent, visible)
        const result = index(visible).getSchema(args.name)
        if (result === null) return null
        const definition = visible.get(result.name)
        const detached = { ...result, output: clone(definition.output.schema) }
        if (Object.hasOwn(result, 'inputSchema')) detached.inputSchema = clone(result.inputSchema)
        if (isAgent(exec.agent)) {
          let entries = active.get(exec.agent)
          if (!entries) active.set(exec.agent, entries = new Map())
          entries.delete(result.name)
          entries.set(result.name, definition)
          while (entries.size > 5) entries.delete(entries.keys().next().value!)
        }
        return detached
      },
    },
  ]
  return {
    definitions,
    present(scope: any, visible: Map<string, any>) {
      const entries = prune(scope, visible)
      return [...visible.values()].filter(definition => !definition.name.startsWith('mcp__') || entries?.get(definition.name) === definition)
    },
  }
}

export function adaptMcpToolDiscoveryRuntime(source: string): { source: string; changed: boolean } {
  if (source.includes(MARKER)) return { source, changed: false }
  const method = '\tsdkSection() {'
  const sdk = '\t\t\t\treturn render(this.sdkSchemas(context.scope), runtime.programFormat);'
  const wire = '\t\tif (mode === "native") return {\n\t\t\tschemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),'
  const view = '\t\tif (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requirePtcTransport());\n\t\treturn {\n\t\t\tvisible,\n\t\t\tknownNames,\n\t\t\trestrictableNames\n\t\t};'
  const guards = [
    '\twireSchemas(scope) {',
    '\tview(scope) {',
    '\tschemas(scope) {\n\t\treturn [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));',
    '\tsdkSchemas(scope) {\n\t\treturn [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {',
    '\tresolveExecution(name, scope, nested) {\n\t\tconst tool = this.get(name, scope);',
  ]
  const edits: [string, string][] = [
    [method, '\tdesktopMcpDiscoveryState() {\n\t\tconst key = Symbol.for("dsh.desktop.mcp-discovery.v1");\n\t\tif (!Object.hasOwn(this, key)) Object.defineProperty(this, key, { value: (' + createRuntimeDiscovery.toString() + ')(this, (' + createMcpToolDiscovery.toString() + ')) });\n\t\treturn this[key];\n\t}\n' + method],
    [sdk, '\t\t\t\treturn render(this.sdkSchemas(context.scope).filter((schema) => !schema.name.startsWith("mcp__")), runtime.programFormat);'],
    [wire, '\t\tif (mode === "native") return {\n\t\t\tschemas: this.desktopMcpDiscoveryState().present(scope, view.visible).map((definition) => this.schemaOf(definition, false)),'],
    [view, view.replace('\n\t\treturn {', '\n\t\tfor (const definition of this.desktopMcpDiscoveryState().definitions) {\n\t\t\tif (!visible.has(definition.name)) visible.set(definition.name, definition);\n\t\t\tknownNames.add(definition.name);\n\t\t}\n\t\treturn {')],
  ]
  if ([...edits.map(([anchor]) => anchor), ...guards].some(anchor => source.split(anchor).length !== 2)) return { source, changed: false }
  let adapted = source
  for (const [anchor, replacement] of edits) adapted = adapted.replace(anchor, () => replacement)
  return { source: adapted, changed: true }
}

function sourceText(source: LoadFnOutput['source']): string | undefined {
  if (source === undefined) return undefined
  if (typeof source === 'string') return source
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  return Buffer.from(source).toString('utf8')
}

export function installMcpToolDiscoveryHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      try {
        const target = new URL(url)
        if (target.protocol !== 'file:' || !decodeURIComponent(target.pathname).endsWith(TOOLS_SUFFIX)) return loaded
      } catch { return loaded }
      const source = sourceText(loaded.source)
      if (source === undefined) {
        console.warn('MCP discovery: runtime source unavailable; original module retained: ' + url)
        return loaded
      }
      const result = adaptMcpToolDiscoveryRuntime(source)
      if (!result.changed && !source.includes(MARKER)) console.warn('MCP discovery: unknown runtime anchors; original module retained: ' + url)
      return result.changed ? { ...loaded, source: result.source } : loaded
    },
  })
}
