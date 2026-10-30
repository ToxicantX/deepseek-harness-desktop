import { describe, expect, it, vi } from 'vitest'
import { apply } from '../resources/compaction-reasoning/index.mjs'

const levels = ['off', 'low', 'medium', 'high', 'xhigh', 'max']
function fixture(previous = { provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort: 'high' }, offered = levels) {
  let listener
  const resolveModelInfo = vi.fn(async () => ({ reasoning: { efforts: offered.map(id => ({ id })) } }))
  apply({
    on: (event, callback) => { expect(event).toBe('llm/stream'); listener = callback },
    sessions: { get: () => previous && ({ requestHeader: () => ({ config: previous }) }) },
    llm: { resolveModelInfo },
  })
  const options = { purpose: 'compaction', provider: 'chatgpt', model: 'gpt-6.1-sol', sessionId: 'fixture' }
  const next = vi.fn(async function* () { yield 'original-stream' })
  return { options, next, resolveModelInfo, run: () => Array.fromAsync(listener(options, next)) }
}

describe('Shell compaction reasoning plugin', () => {
  it('reproduces the implicit none rejection and inherits the same model conversation effort', async () => {
    const value = fixture()
    const dispatch = options => {
      const wire = options.reasoningEffort ?? 'none'
      if (wire === 'none') throw new Error("Unsupported value: 'none' is not supported with the 'gpt-6.1-sol' model")
      return wire
    }
    expect(() => dispatch(value.options)).toThrow('Unsupported value')
    expect(await value.run()).toEqual(['original-stream'])
    expect(dispatch(value.options)).toBe('high')
    expect(value.next).toHaveBeenCalledOnce()
  })

  it.each([undefined, 'off', 'none', 'unsupported'])('falls back to offered low for gpt-6.1-sol when prior effort is %s', async reasoningEffort => {
    const value = fixture({ provider: 'chatgpt', model: 'gpt-6.1-sol', reasoningEffort })
    await value.run()
    expect(value.options.reasoningEffort).toBe('low')
  })

  it('never copies effort across provider/model routes', async () => {
    const value = fixture({ provider: 'other', model: 'gpt-6.1-sol', reasoningEffort: 'max' })
    await value.run()
    expect(value.options.reasoningEffort).toBe('low')
  })

  it('supports a separate summarization model without an active session', async () => {
    const value = fixture(null)
    await value.run()
    expect(value.options.reasoningEffort).toBe('low')
  })

  it('does not invent a level absent from model metadata', async () => {
    const value = fixture(null, ['off'])
    await value.run()
    expect(value.options.reasoningEffort).toBeUndefined()
  })

  it('preserves ordinary chat, title, and explicit compaction effort without resolving metadata', async () => {
    for (const fields of [{ purpose: 'chat' }, { purpose: 'title' }, { reasoningEffort: 'off' }, { reasoningEffort: 'max' }]) {
      const value = fixture()
      Object.assign(value.options, fields)
      await value.run()
      expect(value.options).toMatchObject(fields)
      expect(value.resolveModelInfo).not.toHaveBeenCalled()
      expect(value.next).toHaveBeenCalledOnce()
    }
  })

  it('preserves other models defaults but inherits their supported conversation effort', async () => {
    const unchanged = fixture(null)
    unchanged.options.model = 'other-model'
    await unchanged.run()
    expect(unchanged.options.reasoningEffort).toBeUndefined()
    expect(unchanged.resolveModelInfo).not.toHaveBeenCalled()
    const inherited = fixture({ provider: 'chatgpt', model: 'other-model', reasoningEffort: 'medium' })
    inherited.options.model = 'other-model'
    await inherited.run()
    expect(inherited.options.reasoningEffort).toBe('medium')
  })

  it('preserves model lookup errors and cancellation before downstream dispatch', async () => {
    const value = fixture()
    const failure = new Error('model lookup failed')
    value.resolveModelInfo.mockRejectedValue(failure)
    await expect(value.run()).rejects.toBe(failure)
    expect(value.next).not.toHaveBeenCalled()
    const cancelled = fixture()
    cancelled.options.signal = AbortSignal.abort(new Error('cancelled'))
    await expect(cancelled.run()).rejects.toThrow('cancelled')
    expect(cancelled.resolveModelInfo).not.toHaveBeenCalled()
    expect(cancelled.next).not.toHaveBeenCalled()
  })

  it('preserves downstream stream failures after yielding partial output', async () => {
    const value = fixture()
    const failure = new Error('provider connection lost')
    value.next.mockImplementation(async function* () { yield 'partial'; throw failure })
    await expect(value.run()).rejects.toBe(failure)
    expect(value.next).toHaveBeenCalledOnce()
  })

  it('checks cancellation again after model resolution', async () => {
    const value = fixture()
    const abort = new AbortController()
    value.options.signal = abort.signal
    value.resolveModelInfo.mockImplementation(async () => {
      abort.abort(new Error('cancelled during lookup'))
      return { reasoning: { efforts: [{ id: 'high' }] } }
    })
    await expect(value.run()).rejects.toThrow('cancelled during lookup')
    expect(value.next).not.toHaveBeenCalled()
  })
})
