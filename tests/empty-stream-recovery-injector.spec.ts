import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { adaptEmptyStreamRecovery, installEmptyStreamRecoveryHook } from '../src/empty-stream-recovery-injector.ts'
import { adaptGrokAgentLoop } from '../src/grok-native-tools-injector.ts'
import { fixtureAgentLoopSource } from './fixtures/empty-stream-agent-loop-fixture.ts'

// Two verification worlds. The fixture world always runs: it adapts and
// executes the checked-in production-shaped loop from tests/fixtures, so the
// full classifier/guard/bounds/policy/no-double-dispatch regression is portable
// to any machine with no installed runtime. When an installed DeepSeek Harness
// runtime is discoverable (DSH_DESKTOP_RUNTIME_ROOT, LOCALAPPDATA/USERPROFILE,
// never a committed personal path) — and DSH_EMPTY_STREAM_TEST_RUNTIME is not
// 'none' — the same tests additionally run against the bytes of the actually
// installed dsh-agent-loop step() with the real dsh-llm stream classes.
function locateInstalled(): { loopPath: string; dshRoot: string } | undefined {
  if (process.env.DSH_EMPTY_STREAM_TEST_RUNTIME === 'none') return undefined
  const roots: string[] = []
  if (process.env.DSH_DESKTOP_RUNTIME_ROOT) roots.push(process.env.DSH_DESKTOP_RUNTIME_ROOT)
  const local = process.env.LOCALAPPDATA ?? (process.env.USERPROFILE ? join(process.env.USERPROFILE, 'AppData', 'Local') : undefined)
  if (local) roots.push(join(local, 'DeepSeek Harness', 'runtime-manager', 'runtimes'))
  const candidates: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    for (const version of readdirSync(root)) {
      const pnpm = join(root, version, 'app', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '.pnpm')
      if (!existsSync(pnpm)) continue
      for (const entry of readdirSync(pnpm)) {
        const file = join(pnpm, entry, 'node_modules', '@deepseek-ai', 'dsh-agent-loop', 'lib', 'index.js')
        if (existsSync(file)) candidates.push(file)
      }
    }
  }
  const loopPath = candidates.sort().at(-1)
  if (loopPath === undefined) return undefined
  // Terminate the ancestor search at the filesystem root instead of looping forever.
  let dir = dirname(loopPath)
  for (;;) {
    if (dir.endsWith(join('@deepseek-ai', 'dsh'))) return { loopPath, dshRoot: dir }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// One evaluation of a loop source: the step class and the LlmError class must
// come from the SAME evaluation so the injected instanceof check holds.
interface Evaluation { stepClass: any; LlmError: any }
interface World { name: string; originalSource: string; adapted: Evaluation; unadapted: Evaluation; evaluate: (source: string) => Evaluation }

function extractStep(source: string): string {
  const start = source.indexOf('\tasync step(decision) {')
  expect(start).toBeGreaterThan(0)
  const end = source.indexOf('\n\t/**', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

function extractAssistantStreamAttempt(source: string): string {
  const declaration = source.indexOf('var AssistantStreamAttempt = class {')
  expect(declaration).toBeGreaterThan(0)
  const open = source.indexOf('{', source.indexOf('class', declaration))
  let depth = 0
  let i = open
  for (; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}' && --depth === 0) break
  }
  return source.slice(source.indexOf('class', declaration), i + 1)
}

const fixtureStubMessage = (input: any) => ({ content: input.content, source: input.source })
const fixtureEvaluate = (source: string): Evaluation => {
  const exports = new Function('createAssistantMessage', source + '\nreturn { AgentLoopProbe, LlmError };')(fixtureStubMessage)
  return { stepClass: exports.AgentLoopProbe, LlmError: exports.LlmError }
}
const fixtureAdaptedSource = adaptEmptyStreamRecovery(fixtureAgentLoopSource).source
const fixtureWorld: World = {
  name: 'fixture',
  originalSource: fixtureAgentLoopSource,
  adapted: fixtureEvaluate(fixtureAdaptedSource),
  unadapted: fixtureEvaluate(fixtureAgentLoopSource),
  evaluate: fixtureEvaluate,
}

const installed = locateInstalled()
const installedWorld: World | undefined = installed === undefined ? undefined : await (async () => {
  const base = createRequire(join(installed.dshRoot, 'package.json'))
  const llm: any = await import(pathToFileURL(base.resolve('@deepseek-ai/dsh-llm')).href)
  const originalSource = readFileSync(installed.loopPath, 'utf8')
  const adaptedSource = adaptEmptyStreamRecovery(originalSource).source
  const AssistantStreamAttempt = new Function(
    'AssistantStreamAccumulator', 'BlockAssembler', 'LlmAttemptId',
    'return (' + extractAssistantStreamAttempt(originalSource) + ')',
  )(llm.AssistantStreamAccumulator, llm.BlockAssembler, llm.LlmAttemptId)
  const evaluate = (source: string): Evaluation => ({
    stepClass: new Function(
      'renderPrompt', 'renderContextSections', 'joinContextSections', 'assembleContextFor',
      'AssistantStreamAttempt', 'createAssistantMessage', 'executeToolCalls', 'LlmError',
      'return (class {' + extractStep(source) + '})',
    )(
      (assembly: any) => 'prompt for ' + (assembly?.tools?.length ?? 0) + ' tools',
      (sections: any) => sections,
      (sections: any) => sections,
      () => ({}),
      AssistantStreamAttempt,
      llm.createAssistantMessage,
      vi.fn(async () => ({ concluded: true })),
      llm.LlmError,
    ),
    LlmError: llm.LlmError,
  })
  return { name: 'installed', originalSource, adapted: evaluate(adaptedSource), unadapted: evaluate(originalSource), evaluate }
})()

const worlds: World[] = installedWorld ? [fixtureWorld, installedWorld] : [fixtureWorld]

const decision = { assembly: { tools: [] }, messages: [], startsRequestSeries: false }

interface Attempt {
  chunks?: Array<Record<string, unknown>>
  throw?: { message: string; code: string }
  abortDuring?: () => void
}

const eligibleFailure = { message: 'upstream pi-ai reported empty_stream for model mock', code: 'PI_AI_ERROR' }

function attemptStream(evaluation: Evaluation, attempt: Attempt) {
  return async function* () {
    for (const chunk of attempt.chunks ?? []) {
      yield structuredClone(chunk)
      attempt.abortDuring?.()
    }
    if (attempt.throw) throw new evaluation.LlmError(attempt.throw.message, attempt.throw.code, attempt.throw)
  }
}

interface Harness {
  host: any
  dispatches: Array<{ event: string; payload: any }>
  appended: Array<{ type: string; data: any }>
  streams: number
}

function harness(evaluation: Evaluation, attempts: Attempt[], decide?: (payload: any, index: number) => { kind: 'retry' } | undefined, retryPolicy?: unknown): Harness {
  const dispatches: Array<{ event: string; payload: any }> = []
  const appended: Array<{ type: string; data: any }> = []
  let seq = 0
  let next = 0
  const host: any = new evaluation.stepClass()
  host.phase = { kind: 'running', turn: 7, step: 3, abort: new AbortController() }
  host.session = {
    id: 'spec-session', surface: { contentGeneration: 1 },
    append: vi.fn((type: string, data: any) => { appended.push({ type, data }); return { seq: (seq += 1) } }),
  }
  host.loopCtx = { systemPrompt: { refreshContext: () => 'ctx' } }
  host.runtimeContext = { project: () => undefined }
  host.systemPrompt = { project: () => [] }
  host.toolsChanged = () => false
  host.buildRequest = vi.fn((config: any) => ({ provider: config.provider, model: config.model }))
  host.assistantAttemptCounter = 0
  host.assistantStreamRevision = 0
  host.requestSurfaceGeneration = 1
  host.dispatch = {
    emit: vi.fn(),
    waterfall: vi.fn(async (event: string, payload: any, next: () => Promise<undefined>) => {
      dispatches.push({ event, payload: { ...payload, failure: { ...payload.failure } } })
      return decide?.(payload, dispatches.length) ?? await next()
    }),
  }
  host.inbox = { nextStep: [], splice: vi.fn() }
  host.ctx = {}
  const harnessRef: Harness = { host, dispatches, appended, streams: 0 }
  host.prepareRequest = vi.fn(async () => {
    const attempt = attempts[Math.min(next, attempts.length - 1)]
    if (attempt === undefined) throw new Error('harness: attempt missing')
    if (next < attempts.length) next += 1
    harnessRef.streams += 1
    return {
      config: { provider: 'mock', model: 'mock' },
      preparedCall: { retryPolicy, stream: attemptStream(evaluation, attempt) },
    }
  })
  host.loopCtx.llm = { stream: () => { throw new Error('llm.stream must not be reached: preparedCall.stream is supplied') } }
  return harnessRef
}

const mapped = (h: Harness) => h.dispatches.filter(d => d.payload.failure.code === 'EMPTY_RESPONSE')
const textChunks = (text: string) => [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text },
  { type: 'block-end', index: 0, block: { type: 'text', text } },
  { type: 'finish', reason: { kind: 'stop' } },
]
const errorFinish = (failure: any, extra: Record<string, unknown> = {}) => [
  { type: 'usage', usage: { input: 1, output: 0 } },
  { type: 'finish', reason: { kind: 'error', failure }, ...extra },
]
const alwaysRetry = () => ({ kind: 'retry' } as const)
// A policy shaped like dsh-llm-retry with retryableCodes ["EMPTY_RESPONSE"]: it
// retries the mapped recovery payload and declines the original PI_AI_ERROR.
const retryEmptyResponse = (payload: any): { kind: 'retry' } | undefined => payload.failure.code === 'EMPTY_RESPONSE' ? { kind: 'retry' } : undefined

describe('empty-stream recovery injector', () => {
  it('matches every anchor exactly once, adapts, and is idempotent', () => {
    for (const world of worlds) {
      const adapted = adaptEmptyStreamRecovery(world.originalSource)
      expect(adapted.changed, world.name).toBe(true)
      expect(adapted.source).toContain('desktopEmptyStreamRecoveryCount = 0')
      expect(adapted.source.match(/desktopEmptyStreamRecoveryCount \+= 1/g)).toHaveLength(2)
      expect(adaptEmptyStreamRecovery(adapted.source).changed, world.name).toBe(false)
      new Script(world.name === 'fixture' ? adapted.source : adapted.source.split('\n').filter(line => !/^import |^export /.test(line)).join('\n'))
    }
    expect(fixtureAgentLoopSource.split('\t\tlet firstAttempt = true;\n\t\twhile (true) {')).toHaveLength(2)
  })

  it('reproduces the unadapted empty_stream marker failure', async () => {
    for (const world of worlds) {
      const h = harness(world.unadapted, [{ chunks: errorFinish(eligibleFailure) }])
      await expect(h.host.step(structuredClone(decision)), world.name).rejects.toMatchObject({ failure: eligibleFailure })
      expect(h.dispatches).toHaveLength(1)
      expect(h.dispatches[0]!.payload.failure.code).toBe('PI_AI_ERROR')
      expect(mapped(h)).toHaveLength(0)
    }
  })

  it('recovers an empty stream once, passes the provider retry policy through untouched, and completes durably', async () => {
    for (const world of worlds) {
      const policy = { mode: 'normal', maxRetries: 5, retryableCodes: ['EMPTY_RESPONSE'], initialDelayMs: 20, maxDelayMs: 400, jitterRatio: 0.1 }
      const policySnapshot = structuredClone(policy)
      const h = harness(world.adapted, [{ chunks: errorFinish(eligibleFailure) }, { chunks: textChunks('answer') }], alwaysRetry, policy)
      await expect(h.host.step(structuredClone(decision))).resolves.toEqual({ kind: 'completed' })
      expect(h.streams).toBe(2)
      expect(h.dispatches).toHaveLength(1)
      expect(h.dispatches[0]!.payload.failure).toMatchObject({ code: 'EMPTY_RESPONSE', message: eligibleFailure.message })
      // The waterfall sees the exact provider-configured policy object, unmutated.
      expect(h.dispatches[0]!.payload.retryPolicy).toBe(policy)
      expect(policy).toEqual(policySnapshot)
      const types = h.appended.map(entry => entry.type)
      expect(types.indexOf('assistant/attempt')).toBeLessThan(types.lastIndexOf('assistant/message'))
      expect(h.appended.at(-1)!.data.message.content).toEqual([{ type: 'text', text: 'answer' }])
    }
  })

  it('caps mapped recovery at two extra attempts; the original failure stays eligible for the untouched provider policy', async () => {
    for (const world of worlds) {
      // Retries mapped payloads (max 2 by the desktop counter), then — exactly
      // like stock dsh-llm-retry on the raw PI_AI_ERROR — allows one policy
      // retry of the original failure before declining. This proves the cap
      // governs the mapped path only: no global hard cap is imposed on a
      // provider policy that legitimately retries the original failure.
      let originalRetries = 0
      const decide = (payload: any): { kind: 'retry' } | undefined =>
        payload.failure.code === 'EMPTY_RESPONSE' || (payload.failure.code === 'PI_AI_ERROR' && originalRetries++ < 1) ? { kind: 'retry' } : undefined
      const h = harness(world.adapted, [
        { chunks: errorFinish(eligibleFailure) },
        { chunks: errorFinish(eligibleFailure) },
        { chunks: errorFinish(eligibleFailure) },
        { chunks: errorFinish(eligibleFailure) },
      ], decide)
      await expect(h.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
      expect(mapped(h)).toHaveLength(2)
      expect(h.dispatches.filter(d => d.payload.failure.code === 'PI_AI_ERROR')).toHaveLength(2)
      expect(h.dispatches.at(-1)!.payload.failure).toEqual(eligibleFailure)
      expect(h.streams).toBe(4)
    }
  })

  it('shares one counter across thrown and in-band failures', async () => {
    for (const world of worlds) {
      const h = harness(world.adapted, [
        { throw: eligibleFailure },
        { chunks: errorFinish(eligibleFailure) },
        { chunks: errorFinish(eligibleFailure) },
      ], retryEmptyResponse)
      await expect(h.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
      expect(h.streams).toBe(3)
      expect(mapped(h)).toHaveLength(2)
      expect(h.appended.filter(entry => entry.type === 'assistant/attempt')).toHaveLength(3)
    }
  })

  it('maps an exact EMPTY_STREAM failure code', async () => {
    for (const world of worlds) {
      const failure = { message: 'provider finished with no content', code: 'EMPTY_STREAM' }
      const h = harness(world.adapted, [{ chunks: errorFinish(failure) }, { chunks: textChunks('ok') }], alwaysRetry)
      await expect(h.host.step(structuredClone(decision))).resolves.toEqual({ kind: 'completed' })
      expect(mapped(h)).toHaveLength(1)
      expect(h.dispatches[0]!.payload.failure.message).toBe(failure.message)
    }
  })

  it('leaves unrelated failures and broader markers untouched with the original single dispatch', async () => {
    const cases = [
      { message: 'empty_stream reported', code: 'AUTH' },
      { message: 'empty_stream reported', code: 'INVALID_REQUEST' },
      { message: 'empty_stream reported', code: 'QUOTA_EXCEEDED' },
      { message: 'empty_stream reported', code: 'CONTEXT_WINDOW_EXCEEDED' },
      { message: 'empty_stream reported', code: 'TIMEOUT' },
      { message: 'empty_stream reported', code: 'STREAM_CLOSED' },
      { message: 'empty_stream reported', code: 'TRANSPORT' },
      { message: 'pi-ai stream for model mock ended pending', code: 'PI_AI_ERROR' },
      { message: 'model mock returned empty stream', code: 'PI_AI_ERROR' },
      { message: 'model mock returned empty-stream', code: 'PI_AI_ERROR' },
      { message: 'EMPTY_STREAM_ERROR from gateway', code: 'PI_AI_ERROR' },
      { message: 'provider reported EMPTY_STREAM_ERROR', code: 'EMPTY_STREAM_ERROR' },
      { message: 'nonempty_stream_marker', code: 'PI_AI_ERROR' },
    ]
    for (const world of worlds) {
      for (const failure of cases) {
        const h = harness(world.adapted, [{ chunks: errorFinish(failure) }])
        await expect(h.host.step(structuredClone(decision)), world.name + ' ' + JSON.stringify(failure)).rejects.toMatchObject({ failure })
        expect(h.dispatches).toHaveLength(1)
        expect(h.dispatches[0]!.payload.failure).toEqual(failure)
      }
    }
  })

  it('accepts the standalone token only with boundaries', async () => {
    for (const world of worlds) {
      for (const message of ['empty_stream', 'x empty_stream y', 'empty_stream.', 'ERROR: empty_stream;']) {
        const h = harness(world.adapted, [{ chunks: errorFinish({ message, code: 'PI_AI_ERROR' }) }, { chunks: textChunks('ok') }], alwaysRetry)
        await expect(h.host.step(structuredClone(decision))).resolves.toEqual({ kind: 'completed' })
        expect(mapped(h)).toHaveLength(1)
      }
      for (const message of ['empty stream', 'empty-stream', 'empty_stream_error', 'EMPTY_STREAM_ERROR', 'mystream empty_streamy']) {
        const h = harness(world.adapted, [{ chunks: errorFinish({ message, code: 'PI_AI_ERROR' }) }])
        await expect(h.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: { message, code: 'PI_AI_ERROR' } })
        expect(mapped(h)).toHaveLength(0)
      }
    }
  })

  it('fails closed on partial output, tool calls, reasoning, unknown records and replay state', async () => {
    const cases: Array<[string, Attempt]> = [
      ['text before the error', { chunks: [...textChunks('partial').slice(0, 2), { type: 'finish', reason: { kind: 'error', failure: eligibleFailure } }] }],
      ['reasoning before the error', { chunks: [
        { type: 'block-start', index: 0, blockType: 'reasoning' },
        { type: 'reasoning-delta', index: 0, text: 'hmm' },
        { type: 'finish', reason: { kind: 'error', failure: eligibleFailure } },
      ] }],
      ['tool call before the error', { chunks: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: 'call-1', name: 'run_code', argumentsDelta: '{}' },
        { type: 'finish', reason: { kind: 'error', failure: eligibleFailure } },
      ] }],
      ['unclosed block-start', { chunks: [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'finish', reason: { kind: 'error', failure: eligibleFailure } },
      ] }],
      ['replay state on the finish', { chunks: errorFinish(eligibleFailure, { replayState: { response: {} } }) }],
    ]
    for (const world of worlds) {
      for (const [, attempt] of cases) {
        const h = harness(world.adapted, [attempt], retryEmptyResponse)
        await expect(h.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
        expect(mapped(h)).toHaveLength(0)
        expect(h.dispatches.filter(d => d.payload.failure.code === 'PI_AI_ERROR')).toHaveLength(1)
      }
      // A thrown failure after partial output never reaches any waterfall; the
      // unadapted catch settles and rethrows without dispatching.
      const thrown = harness(world.adapted, [{ chunks: textChunks('partial').slice(0, 2), throw: eligibleFailure }], retryEmptyResponse)
      await expect(thrown.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
      expect(thrown.dispatches).toHaveLength(0)
    }
  })

  it('declines after exactly one mapped dispatch for policy omission, maxRetries 0 and excluded code filter', async () => {
    // The three ways dsh-llm-retry declines: no retryPolicy at all, a policy
    // with maxRetries 0, and a retryableCodes list without EMPTY_RESPONSE. The
    // adapter passes the exact policy object through and throws the original
    // failure without a second dispatch.
    const policies: unknown[] = [
      undefined,
      { mode: 'normal', maxRetries: 0, retryableCodes: ['EMPTY_RESPONSE'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
      { mode: 'normal', maxRetries: 5, retryableCodes: ['TIMEOUT', 'STREAM_CLOSED'], initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
    ]
    for (const world of worlds) {
      for (const policy of policies) {
        const snapshot = policy === undefined ? undefined : structuredClone(policy)
        const h = harness(world.adapted, [{ chunks: errorFinish(eligibleFailure) }], undefined, policy)
        await expect(h.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
        expect(h.dispatches).toHaveLength(1)
        expect(h.dispatches[0]!.payload.failure).toMatchObject({ code: 'EMPTY_RESPONSE', message: eligibleFailure.message })
        expect(h.dispatches[0]!.payload.retryPolicy).toBe(policy)
        expect(policy).toEqual(snapshot)
        expect(h.streams).toBe(1)
      }
    }
  })

  it('cancels recovery when the signal aborts during the decision backoff', async () => {
    for (const world of worlds) {
      const h = harness(world.adapted, [{ chunks: errorFinish(eligibleFailure) }, { chunks: textChunks('answer') }], (payload) => {
        if (payload.failure.code !== 'EMPTY_RESPONSE') return undefined
        h.host.phase.abort.abort()
        return { kind: 'retry' }
      })
      await expect(h.host.step(structuredClone(decision))).rejects.toThrow()
      expect(h.streams).toBe(1)
      expect(mapped(h)).toHaveLength(1)
    }
  })

  it('does not map an aborted stream failure', async () => {
    for (const world of worlds) {
      const h = harness(world.adapted, [{ chunks: [{ type: 'usage', usage: { input: 1, output: 0 } }], abortDuring: () => h.host.phase.abort.abort() }])
      await expect(h.host.step(structuredClone(decision))).rejects.toThrow()
      expect(mapped(h)).toHaveLength(0)
    }
  })

  it('isolates the recovery budget per step invocation on the same agent', async () => {
    const makeAttempts = () => [{ chunks: errorFinish(eligibleFailure) }, { chunks: errorFinish(eligibleFailure) }, { chunks: errorFinish(eligibleFailure) }]
    for (const world of worlds) {
      const h = harness(world.adapted, makeAttempts(), retryEmptyResponse)
      await expect(h.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
      expect(mapped(h)).toHaveLength(2)
      const second = harness(world.adapted, makeAttempts(), retryEmptyResponse)
      await expect(second.host.step(structuredClone(decision))).rejects.toMatchObject({ failure: eligibleFailure })
      expect(mapped(second)).toHaveLength(2)
    }
  })

  it('rewrites only the agent-loop module URL, for string and byte-array sources, idempotently', () => {
    const registered: any = installEmptyStreamRecoveryHook(((hook: any) => hook) as any)
    const load = registered.load
    const loopUrl = 'file:///C:/probe/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js'
    const otherUrl = 'file:///E:/workspace/other/lib/index.js'
    const passthrough = { format: 'module', source: fixtureAgentLoopSource }
    expect(load.call(registered, otherUrl, {}, () => passthrough)).toBe(passthrough)
    expect(load.call(registered, 'data:text/javascript,export const x = 1', {}, () => passthrough)).toBe(passthrough)
    const stringLoad = load.call(registered, loopUrl, {}, () => ({ format: 'module', source: fixtureAgentLoopSource })) as any
    expect(stringLoad.source).toContain('desktopEmptyStreamRecoveryCount = 0')
    const bytes = new TextEncoder().encode(fixtureAgentLoopSource)
    const byteLoad = load.call(registered, loopUrl, {}, () => ({ format: 'module', source: bytes })) as any
    expect(byteLoad.source).toContain('desktopEmptyStreamRecoveryCount = 0')
    const twice = load.call(registered, loopUrl, {}, () => ({ format: 'module', source: stringLoad.source })) as any
    expect(twice.source).toBe(stringLoad.source)
  })

  it('smoke CLI: a missing value or an invalid path exits nonzero promptly with a useful message', () => {
    const smoke = fileURLToPath(new URL('../scripts/smoke-empty-stream-recovery.mjs', import.meta.url))
    const missingValue = spawnSync(process.execPath, [smoke, '--agent-loop-module'], { encoding: 'utf8', timeout: 30000 })
    expect(missingValue.status).not.toBe(0)
    expect(missingValue.status).not.toBe(null)
    expect(missingValue.stderr).toContain('--agent-loop-module')
    const badPath = spawnSync(process.execPath, [smoke, '--agent-loop-module', fileURLToPath(new URL('./fixtures/definitely-missing-runtime', import.meta.url))], { encoding: 'utf8', timeout: 30000 })
    expect(badPath.status).not.toBe(0)
    expect(badPath.stderr.toLowerCase()).toMatch(/exist|not found|invalid|missing/)
  }, 90000)

  if (installedWorld) {
    it('composes with the Grok native-tools adaptation of the installed source in either order', () => {
      const grokFirst = adaptEmptyStreamRecovery(adaptGrokAgentLoop(installedWorld.originalSource).source)
      const recoveryFirst = adaptGrokAgentLoop(adaptEmptyStreamRecovery(installedWorld.originalSource).source)
      for (const result of [grokFirst, recoveryFirst]) {
        expect(result.changed).toBe(true)
        expect(result.source).toContain('desktopEmptyStreamRecoveryCount = 0')
        expect(result.source).toContain('desktopGrokNativePresentation')
        new Script(result.source.split('\n').filter(line => !/^import |^export /.test(line)).join('\n'))
      }
    })
  }
})
