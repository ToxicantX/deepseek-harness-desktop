import { describe, expect, it, vi } from 'vitest'
import {
  GoalNoProgressTracker,
  apply,
  normalizeAssistantText,
} from '../resources/goal-no-progress-guard/index.js'

const completed = { kind: 'completed' }

function goalRound(round, goalId = 'goal-1', revision = 1) {
  return {
    type: 'user/message',
    data: { source: { kind: 'goal', goalId, revision, round } },
  }
}

function assistant(text, turn = 1, extra = {}) {
  return {
    type: 'assistant/message',
    data: {
      turn,
      message: { content: [{ type: 'text', text }] },
      ...extra,
    },
  }
}

function end(turn = 1, reason = completed) {
  return { type: 'turn/end', data: { turn, reason } }
}

function finish(tracker, key, round, text, events = [], options = {}) {
  tracker.observe(key, goalRound(round, options.goalId, options.revision))
  tracker.observe(key, assistant(text, round, options.assistantExtra))
  for (const event of events) tracker.observe(key, event)
  return tracker.observe(key, end(round, options.reason ?? completed))
}

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function adapterHarness({ flush = vi.fn(async () => {}), pause = vi.fn() } = {}) {
  const listeners = new Map()
  const cleanups = []
  const session = { id: 'session-1' }
  const agent = { id: 'agent-1', session }
  let goal = {
    id: 'goal-1',
    revision: 1,
    phase: 'active',
    activation: 'armed',
    roundsStarted: 2,
  }
  const disarm = vi.fn(() => { goal = { ...goal, activation: 'disarmed' }; return goal })
  const pauseGoal = vi.fn((...args) => {
    const result = pause(...args)
    goal = { ...goal, phase: 'paused', activation: 'disarmed', revision: goal.revision + 1 }
    return result
  })
  const ctx = {
    agents: { get: vi.fn(id => id === session.id || id === agent.id ? agent : undefined) },
    goals: { get: vi.fn(() => ({ ...goal })), disarm, pause: pauseGoal },
    sessions: { flush },
    logger: { warn: vi.fn() },
    on(name, listener) {
      const group = listeners.get(name) ?? []
      group.push(listener)
      listeners.set(name, group)
    },
    effect(factory) {
      const iterator = factory()
      const value = iterator.next().value
      if (typeof value === 'function') cleanups.push(value)
    },
  }
  apply(ctx)
  const emit = (name, ...args) => {
    for (const listener of listeners.get(name) ?? []) listener(...args)
  }
  const sessionEvent = event => emit('session/event', session, event)
  const round = (number, text) => {
    sessionEvent(goalRound(number))
    sessionEvent(assistant(text, number))
    sessionEvent(end(number))
  }
  return { agent, cleanups, ctx, disarm, emit, flush, pause: pauseGoal, round, session, sessionEvent }
}

describe('GoalNoProgressTracker', () => {
  it('normalizes stable whitespace without erasing meaningful line structure', () => {
    expect(normalizeAssistantText('Ａ  \r\n\r\n\r\nB \t')).toBe('A\n\nB')
  })

  it('pauses after the second consecutive identical no-progress round', () => {
    const tracker = new GoalNoProgressTracker()
    expect(finish(tracker, 'a', 1, 'waiting  \r\n')).toBeUndefined()
    expect(finish(tracker, 'a', 2, 'waiting\n')).toEqual({ goalId: 'goal-1', revision: 1, round: 2 })
  })

  it.each([
    ['tool call', [{ type: 'tool/call', data: { turn: 2 } }], {}],
    ['goal change', [{ type: 'goal/change', data: { operation: 'edit' } }], {}],
    ['durable custom progress', [{ type: 'todo/write', data: { todos: [] } }], {}],
    ['competing user input', [{ type: 'user/message', data: { source: { kind: 'user' } } }], {}],
    ['aborted turn', [], { reason: { kind: 'aborted', reason: { kind: 'user' } } }],
    ['interrupted assistant', [], { assistantExtra: { interrupted: true } }],
  ])('resets the streak on %s', (_label, events, options) => {
    const tracker = new GoalNoProgressTracker()
    finish(tracker, 'a', 1, 'same')
    expect(finish(tracker, 'a', 2, 'same', events, options)).toBeUndefined()
    expect(finish(tracker, 'a', 3, 'same')).toBeUndefined()
    expect(finish(tracker, 'a', 4, 'same')).toEqual({ goalId: 'goal-1', revision: 1, round: 4 })
  })

  it('uses changed output as the baseline of a new streak', () => {
    const tracker = new GoalNoProgressTracker()
    finish(tracker, 'a', 1, 'first')
    expect(finish(tracker, 'a', 2, 'second')).toBeUndefined()
    expect(finish(tracker, 'a', 3, 'second')).toEqual({ goalId: 'goal-1', revision: 1, round: 3 })
  })

  it('isolates agents, goals, revisions, and non-consecutive rounds', () => {
    const tracker = new GoalNoProgressTracker()
    finish(tracker, 'a', 1, 'same')
    finish(tracker, 'b', 1, 'same')
    expect(finish(tracker, 'a', 2, 'same', [], { goalId: 'goal-2' })).toBeUndefined()
    expect(finish(tracker, 'b', 2, 'same')).toEqual({ goalId: 'goal-1', revision: 1, round: 2 })
    expect(finish(tracker, 'a', 3, 'same', [], { goalId: 'goal-2', revision: 2 })).toBeUndefined()
    expect(finish(tracker, 'a', 5, 'same', [], { goalId: 'goal-2', revision: 2 })).toBeUndefined()
  })
})

describe('desktop goal no-progress adapter', () => {
  it('disarms synchronously before flushing and durably pauses after the checkpoint', async () => {
    const value = adapterHarness()
    value.round(1, 'same')
    value.round(2, 'same')
    expect(value.disarm).toHaveBeenCalledOnce()
    expect(value.pause).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(value.pause).toHaveBeenCalledOnce() })
    expect(value.flush).toHaveBeenCalledWith(value.session)
    expect(value.pause).toHaveBeenCalledWith(value.agent, { id: 'goal-1', revision: 1 })
  })

  it('resets when competing input is queued before it reaches persistence', async () => {
    const value = adapterHarness()
    value.round(1, 'same')
    value.emit('agent/inbox/inserted', { agent: value.agent, message: { source: { kind: 'user' } } })
    value.round(2, 'same')
    await Promise.resolve()
    expect(value.disarm).not.toHaveBeenCalled()
  })

  it('cancels a pending pause when new input arrives during the durability checkpoint', async () => {
    const gate = deferred()
    const value = adapterHarness({ flush: vi.fn(() => gate.promise) })
    value.round(1, 'same')
    value.round(2, 'same')
    expect(value.disarm).toHaveBeenCalledOnce()
    value.emit('agent/inbox/inserted', { agent: value.agent, message: { source: { kind: 'user' } } })
    gate.resolve()
    await vi.waitFor(() => { expect(value.flush).toHaveBeenCalledOnce() })
    await Promise.resolve()
    expect(value.pause).not.toHaveBeenCalled()
  })

  it('fails closed when flush or pause fails', async () => {
    const failedFlush = adapterHarness({ flush: vi.fn(async () => { throw new Error('disk unavailable') }) })
    failedFlush.round(1, 'same')
    failedFlush.round(2, 'same')
    await vi.waitFor(() => { expect(failedFlush.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('disk unavailable')) })
    expect(failedFlush.disarm).toHaveBeenCalledOnce()
    expect(failedFlush.pause).not.toHaveBeenCalled()

    const failedPause = adapterHarness({ pause: vi.fn(() => { throw new Error('stale revision') }) })
    failedPause.round(1, 'same')
    failedPause.round(2, 'same')
    await vi.waitFor(() => { expect(failedPause.ctx.logger.warn).toHaveBeenCalledWith(expect.stringContaining('stale revision')) })
    expect(failedPause.disarm).toHaveBeenCalledOnce()
    expect(failedPause.pause).toHaveBeenCalledOnce()
  })

  it('does not commit a pause after teardown wins a pending flush', async () => {
    const gate = deferred()
    const value = adapterHarness({ flush: vi.fn(() => gate.promise) })
    value.round(1, 'same')
    value.round(2, 'same')
    const cleaning = value.cleanups[0]()
    gate.resolve()
    await cleaning
    expect(value.disarm).toHaveBeenCalledOnce()
    expect(value.pause).not.toHaveBeenCalled()
  })
})