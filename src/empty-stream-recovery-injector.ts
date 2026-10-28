import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'

const LOOP_SUFFIX = '/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
const STATE_MARKER = 'desktopEmptyStreamRecovery'

interface Adaptation {
  source: string
  changed: boolean
}

// The anchors below are exact bytes of the installed dsh-agent-loop step()
// method (0.2.1-rc.3). Each must appear exactly once; otherwise the module is
// left untouched so an unrelated upstream edit fails open instead of corrupting
// the loop. The stream guard uses the real compact record format produced by
// dsh-llm's AssistantStreamAccumulator.snapshot(): only records of type
// "chunk" whose chunk type is "usage" or "finish" are metadata; every other
// record (text-chunks / reasoning-chunks / tool-call-chunks / block-start /
// block-end / degenerate tool-call-delta) carries semantic content and fails
// closed, as does any replayState on the attempt.
const COUNTER_ANCHOR = '\t\tlet firstAttempt = true;\n\t\twhile (true) {'

const COUNTER_REPLACEMENT = [
  '\t\tlet firstAttempt = true;',
  '\t\tlet desktopEmptyStreamRecoveryCount = 0;',
  '\t\tconst desktopEmptyStreamToken = /(?:^|[^\\p{L}\\p{N}_])empty_stream(?:$|[^\\p{L}\\p{N}_])/iu;',
  '\t\tconst desktopEmptyStreamRecovery = (failure, live, signal) => {',
  '\t\t\tif (desktopEmptyStreamRecoveryCount >= 2 || signal.aborted) return void 0;',
  '\t\t\tif (failure === null || typeof failure !== "object") return void 0;',
  '\t\t\tconst code = typeof failure.code === "string" ? failure.code : "";',
  '\t\t\tconst message = typeof failure.message === "string" ? failure.message : "";',
  '\t\t\tconst eligible = (code === "PI_AI_ERROR" && desktopEmptyStreamToken.test(message)) || code === "EMPTY_STREAM";',
  '\t\t\tif (!eligible) return void 0;',
  '\t\t\ttry {',
  '\t\t\t\tif (live.replayState !== void 0) return void 0;',
  '\t\t\t\tconst stream = live.stream;',
  '\t\t\t\tif (!Array.isArray(stream)) return void 0;',
  '\t\t\t\tfor (const record of stream) {',
  '\t\t\t\t\tif (record === null || typeof record !== "object" || record.type !== "chunk") return void 0;',
  '\t\t\t\t\tconst chunkType = record.chunk?.type;',
  '\t\t\t\t\tif (chunkType !== "usage" && chunkType !== "finish") return void 0;',
  '\t\t\t\t}',
  '\t\t\t} catch { return void 0; }',
  '\t\t\treturn { ...failure, code: "EMPTY_RESPONSE" };',
  '\t\t};',
  '\t\twhile (true) {',
].join('\n')

const THROWN_ANCHOR = [
  '\t\t\t\t} catch (settlementError) {',
  '\t\t\t\t\tthrow new AggregateError([error, settlementError], "Assistant stream failed and its durable settlement was rejected", { cause: error });',
  '\t\t\t\t}',
  '\t\t\t\tthrow error;',
].join('\n')

const THROWN_REPLACEMENT = [
  '\t\t\t\t} catch (settlementError) {',
  '\t\t\t\t\tthrow new AggregateError([error, settlementError], "Assistant stream failed and its durable settlement was rejected", { cause: error });',
  '\t\t\t\t}',
  '\t\t\t\tif (started && !signal.aborted && error instanceof LlmError) {',
  '\t\t\t\t\tconst desktopMapped = desktopEmptyStreamRecovery(error.failure, live, signal);',
  '\t\t\t\t\tif (desktopMapped !== void 0) {',
  '\t\t\t\t\t\tconst desktopAction = await this.dispatch.waterfall("agent/request-error", {',
  '\t\t\t\t\t\t\tturn,',
  '\t\t\t\t\t\t\tstep,',
  '\t\t\t\t\t\t\tprovider: request.provider,',
  '\t\t\t\t\t\t\tfailure: desktopMapped,',
  '\t\t\t\t\t\t\tretryPolicy: preparedCall?.retryPolicy,',
  '\t\t\t\t\t\t\tsignal',
  '\t\t\t\t\t\t}, () => Promise.resolve(void 0));',
  '\t\t\t\t\t\tsignal.throwIfAborted();',
  '\t\t\t\t\t\tif (desktopAction?.kind === "retry") {',
  '\t\t\t\t\t\t\tdesktopEmptyStreamRecoveryCount += 1;',
  '\t\t\t\t\t\t\tcontinue;',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t}',
  '\t\t\t\t}',
  '\t\t\t\tthrow error;',
].join('\n')

const INBAND_ANCHOR = [
  '\t\t\t\t\t}).seq);',
  '\t\t\t\t\tconst action = await this.dispatch.waterfall("agent/request-error", {',
].join('\n')

const INBAND_REPLACEMENT = [
  '\t\t\t\t\t}).seq);',
  '\t\t\t\t\tif (finish.kind === "error") {',
  '\t\t\t\t\t\tconst desktopMapped = desktopEmptyStreamRecovery(finish.failure, live, signal);',
  '\t\t\t\t\t\tif (desktopMapped !== void 0) {',
  '\t\t\t\t\t\t\tconst desktopAction = await this.dispatch.waterfall("agent/request-error", {',
  '\t\t\t\t\t\t\t\tturn,',
  '\t\t\t\t\t\t\t\tstep,',
  '\t\t\t\t\t\t\t\tprovider: request.provider,',
  '\t\t\t\t\t\t\t\tfailure: desktopMapped,',
  '\t\t\t\t\t\t\t\tretryPolicy: preparedCall?.retryPolicy,',
  '\t\t\t\t\t\t\t\tsignal',
  '\t\t\t\t\t\t\t}, () => Promise.resolve(void 0));',
  '\t\t\t\t\t\t\tsignal.throwIfAborted();',
  '\t\t\t\t\t\t\tif (desktopAction?.kind === "retry") {',
  '\t\t\t\t\t\t\t\tdesktopEmptyStreamRecoveryCount += 1;',
  '\t\t\t\t\t\t\t\tcontinue;',
  '\t\t\t\t\t\t\t}',
  '\t\t\t\t\t\t\tthrow new LlmError(finish.failure.message, finish.failure.code, finish.failure);',
  '\t\t\t\t\t\t}',
  '\t\t\t\t\t}',
  '\t\t\t\t\tconst action = await this.dispatch.waterfall("agent/request-error", {',
].join('\n')

const EDITS: readonly (readonly [string, string])[] = [
  [COUNTER_ANCHOR, COUNTER_REPLACEMENT],
  [THROWN_ANCHOR, THROWN_REPLACEMENT],
  [INBAND_ANCHOR, INBAND_REPLACEMENT],
]

/**
 * Rewrite the installed dsh-agent-loop so an eligible empty-stream failure —
 * an upstream `PI_AI_ERROR` whose message carries the explicit standalone
 * token `empty_stream`, or an exact `EMPTY_STREAM` failure code — is remapped
 * to the canonical `EMPTY_RESPONSE` recovery payload before the original
 * `agent/request-error` waterfall runs. The untouched dsh-llm-retry policy
 * (code filter, maxRetries, mode) decides whether to retry; a per-step local
 * counter shared by the thrown and in-band paths caps recovery at two extra
 * attempts and is never reset inside the retry loop. Eligibility additionally
 * requires zero semantic content: only `usage`/`finish` compact records with
 * no replayState. A capped or otherwise ineligible mapping falls back to
 * exactly the unadapted behavior, and a mapped-then-declined failure throws
 * the original error without a second dispatch. All-or-nothing: any anchor
 * that does not appear exactly once leaves the source untouched.
 */
export function adaptEmptyStreamRecovery(source: string): Adaptation {
  if (source.includes(STATE_MARKER)) return { source, changed: false }
  if (EDITS.some(([anchor]) => source.split(anchor).length !== 2)) return { source, changed: false }
  let result = source
  for (const [anchor, replacement] of EDITS) result = result.replace(anchor, replacement)
  return { source: result, changed: true }
}

function sourceText(source: LoadFnOutput['source']): string | undefined {
  if (source === undefined) return undefined
  if (typeof source === 'string') return source
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  return Buffer.from(source).toString('utf8')
}

/**
 * Install the agent-loop load hook. Only the exact decoded file URL of the
 * installed `dsh-agent-loop/lib/index.js` is rewritten; every other module and
 * every unknown anchor layout falls through to the original bytes with a
 * warning. Compatible with registerHooks composition: registered after the
 * Grok native-tools hook (as shutdown-hook.ts does), this runs outermost and
 * rewrites the already Grok-adapted source; the anchors are disjoint.
 */
export function installEmptyStreamRecoveryHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      let pathname: string
      try {
        const target = new URL(url)
        if (target.protocol !== 'file:') return loaded
        pathname = decodeURIComponent(target.pathname)
      } catch { return loaded }
      if (!pathname.endsWith(LOOP_SUFFIX)) return loaded
      const source = sourceText(loaded.source)
      if (source === undefined) {
        console.warn('Empty-stream recovery: runtime source unavailable; original module retained: ' + url)
        return loaded
      }
      const result = adaptEmptyStreamRecovery(source)
      if (!result.changed && !source.includes(STATE_MARKER)) console.warn('Empty-stream recovery: unknown runtime anchors; original module retained: ' + url)
      return result.changed ? { ...loaded, source: result.source } : loaded
    },
  })
}
