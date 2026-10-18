import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'

const LOOP_SUFFIX = '/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
const TOOLS_SUFFIX = '/node_modules/@deepseek-ai/dsh-tools/lib/index.js'
const STATE_KEY = 'dsh.desktop.grok-native-tools.v1'
const LOOP_MARKER = 'desktopGrokNativePresentation'
const TOOLS_MARKER = 'desktopSupportsGrokNativeTools'

interface Adaptation {
  source: string
  changed: boolean
}

function replaceAnchors(source: string, marker: string, edits: readonly (readonly [string, string])[]): Adaptation {
  if (source.includes(marker)) return { source, changed: false }
  if (edits.some(([anchor]) => source.split(anchor).length !== 2)) return { source, changed: false }
  let result = source
  for (const [anchor, replacement] of edits) result = result.replace(anchor, replacement)
  return { source: result, changed: true }
}

// A scope is the agent itself, not its preset or its parent's composition layer.
// The same resolver owns schemas, SDK/collapse sections and execution admission.
export function adaptGrokToolRuntime(source: string): Adaptation {
  const anchor = '	modeFor(scope) {\n\t\tconst layers = this.layers.chainLayers(scope);'
  const replacement = [
    '	desktopSupportsGrokNativeTools() { return true; }',
    '	modeFor(scope) {',
    '		if (scope !== void 0 && Object.hasOwn(scope, Symbol.for(' + JSON.stringify(STATE_KEY) + ')) && scope[Symbol.for(' + JSON.stringify(STATE_KEY) + ')] === true) return "native";',
    '		const layers = this.layers.chainLayers(scope);',
  ].join('\n')
  // Fail closed on unknown registry layouts, including the execution boundary.
  const guards = [
    '				if (mode === "native") return "";',
    '			text: (context) => this.modeFor(context.scope) === "ptc" ? PTC_ONLY_INSTRUCTION : ""',
    '		if (mode === "native") return {\n\t\t\tschemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),',
    '		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);',
  ]
  if (!source.includes(TOOLS_MARKER) && guards.some((guard) => !source.includes(guard))) return { source, changed: false }
  return replaceAnchors(source, TOOLS_MARKER, [[anchor, replacement]])
}

const REQUEST_ANCHOR = '			const { config, preparedCall } = await this.prepareRequest(turn, step, signal);'
const REQUEST_REPLACEMENT = REQUEST_ANCHOR + '\n' + [
  '			const desktopGrokNativePresentation = typeof config.model === "string" && /(?:^|[\\/\\s:_])grok(?:-|$)/i.test(config.model.trim());',
  '			const desktopGrokState = Symbol.for(' + JSON.stringify(STATE_KEY) + ');',
  '			const desktopWasGrok = Object.hasOwn(this, desktopGrokState) && this[desktopGrokState] === true;',
  '			const desktopGrokPresentationChanged = desktopGrokNativePresentation !== desktopWasGrok;',
  '			if (desktopGrokNativePresentation || desktopWasGrok) {',
  '				if (this.loopCtx.tools.desktopSupportsGrokNativeTools?.() !== true) throw new Error("Grok native tools: incompatible tool runtime; no request was sent. Update the desktop/runtime adapter together.");',
  '				Object.defineProperty(this, desktopGrokState, { value: desktopGrokNativePresentation, configurable: true });',
  '				try {',
  '					assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal));',
  '					renderedPrompt = renderPrompt(assembly);',
  '				} catch (error) {',
  '					Object.defineProperty(this, desktopGrokState, { value: desktopWasGrok, configurable: true });',
  '					throw error;',
  '				}',
  '				if (desktopGrokNativePresentation && (desktopGrokPresentationChanged || this.toolsChanged(assembly.tools))) {',
  '					const count = assembly.tools.length;',
  '					const bytes = Buffer.byteLength(JSON.stringify(assembly.tools), "utf8");',
  '					console.info("Grok native tools: " + count + " authorized schemas, " + bytes + " schema bytes; no tools truncated.");',
  '					if (count > 350) console.warn("Grok native tools: " + count + " schemas exceed the documented xAI Responses API maximum of 350. Custom gateways may differ. No automatic PTC fallback or capability removal; provider rejection will be surfaced. Use a provider supporting this full tool set or an explicitly configured capability/discovery policy.");',
  '				}',
  '			}',
].join('\n')

export function adaptGrokAgentLoop(source: string): Adaptation {
  return replaceAnchors(source, LOOP_MARKER, [
    ['		const { assembly } = decision;\n\t\tconst renderedPrompt = renderPrompt(assembly);', '		let { assembly } = decision;\n\t\tlet renderedPrompt = renderPrompt(assembly);'],
    [REQUEST_ANCHOR, REQUEST_REPLACEMENT],
    // Let the host normalize only its system/message nodes on presentation changes,
    // even when this provider normally appends prompt updates in history.
    ['				startsSeries: startsRequestSeries || this.requestSurfaceGeneration', '				startsSeries: desktopGrokPresentationChanged || startsRequestSeries || this.requestSurfaceGeneration'],
  ])
}

function sourceText(source: LoadFnOutput['source']): string | undefined {
  if (source === undefined) return undefined
  if (typeof source === 'string') return source
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  return Buffer.from(source).toString('utf8')
}

export function installGrokNativeToolsHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      let pathname: string
      try {
        const target = new URL(url)
        if (target.protocol !== 'file:') return loaded
        pathname = decodeURIComponent(target.pathname)
      } catch { return loaded }
      const adapter = pathname.endsWith(LOOP_SUFFIX) ? adaptGrokAgentLoop : pathname.endsWith(TOOLS_SUFFIX) ? adaptGrokToolRuntime : undefined
      if (adapter === undefined) return loaded
      const source = sourceText(loaded.source)
      if (source === undefined) {
        console.warn('Grok native tools: runtime source unavailable; original module retained: ' + url)
        return loaded
      }
      const result = adapter(source)
      const marker = adapter === adaptGrokAgentLoop ? LOOP_MARKER : TOOLS_MARKER
      if (!result.changed && !source.includes(marker)) console.warn('Grok native tools: unknown runtime anchors; original module retained: ' + url)
      return result.changed ? { ...loaded, source: result.source } : loaded
    },
  })
}
