export const name = 'desktop-goal-no-progress-guard'
export const inject = ['agents', 'goals', 'sessions']

const ROUTINE_EVENT_TYPES = new Set([
  'turn/start',
  'agent/inbox/spliced',
  'step/start',
  'assistant/chunk',
  'assistant/message',
  'step/end',
  'turn/end',
  'request/header',
  'request/context',
  'user/message',
])

export function normalizeAssistantText(value) {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

function assistantText(message) {
  if (message === null || typeof message !== 'object' || !Array.isArray(message.content)) return undefined
  const text = []
  let hasToolCall = false
  for (const block of message.content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') text.push(block.text)
    if (block.type === 'tool-call') hasToolCall = true
  }
  return { text: text.join('\n'), hasToolCall }
}

function goalSource(event) {
  if (event.type !== 'user/message') return undefined
  const source = event.data?.source
  if (source?.kind !== 'goal' || !Number.isSafeInteger(source.round) || source.round < 1) return undefined
  if (typeof source.goalId !== 'string' || !Number.isSafeInteger(source.revision) || source.revision < 1) return undefined
  return source
}

export class GoalNoProgressTracker {
  #active = new Map()
  #history = new Map()

  reset(key) {
    this.#active.delete(key)
    this.#history.delete(key)
  }

  delete(key) {
    this.reset(key)
  }

  clear() {
    this.#active.clear()
    this.#history.clear()
  }

  observe(key, event) {
    const source = goalSource(event)
    if (source !== undefined) {
      this.#active.set(key, {
        turn: undefined,
        goalId: source.goalId,
        revision: source.revision,
        round: source.round,
        assistantSeen: false,
        assistant: [],
        toolCall: false,
        goalChange: false,
        durableProgress: false,
        competingInput: false,
      })
      return undefined
    }

    const active = this.#active.get(key)
    if (event.type === 'turn/start') {
      if (active !== undefined) this.reset(key)
      return undefined
    }
    if (active === undefined) return undefined

    if (event.type === 'user/message') {
      active.competingInput = true
      return undefined
    }
    if (event.type === 'tool/call') {
      active.toolCall = true
      return undefined
    }
    if (event.type === 'goal/change') {
      active.goalChange = true
      return undefined
    }
    if (event.type === 'assistant/message') {
      const value = assistantText(event.data?.message)
      if (value === undefined || event.data?.interrupted === true) {
        active.durableProgress = true
        return undefined
      }
      active.assistantSeen = true
      active.assistant.push(value.text)
      active.toolCall ||= value.hasToolCall
      if (active.turn === undefined && Number.isSafeInteger(event.data?.turn)) active.turn = event.data.turn
      return undefined
    }
    if (event.type !== 'turn/end') {
      if (!ROUTINE_EVENT_TYPES.has(event.type)) active.durableProgress = true
      return undefined
    }

    this.#active.delete(key)
    if (active.turn !== undefined && event.data?.turn !== active.turn) {
      this.#history.delete(key)
      return undefined
    }
    if (event.data?.reason?.kind !== 'completed'
      || !active.assistantSeen
      || active.toolCall
      || active.goalChange
      || active.durableProgress
      || active.competingInput) {
      this.#history.delete(key)
      return undefined
    }

    const text = normalizeAssistantText(active.assistant.join('\n'))
    const previous = this.#history.get(key)
    const repeated = previous !== undefined
      && previous.goalId === active.goalId
      && previous.revision === active.revision
      && previous.round + 1 === active.round
      && previous.text === text
    const sameCount = repeated ? previous.sameCount + 1 : 1
    this.#history.set(key, {
      goalId: active.goalId,
      revision: active.revision,
      round: active.round,
      text,
      sameCount,
    })
    if (sameCount < 2) return undefined
    this.#history.delete(key)
    return {
      goalId: active.goalId,
      revision: active.revision,
      round: active.round,
    }
  }
}

function renderThrown(value) {
  return value instanceof Error ? value.message : String(value)
}

function sameGoal(goal, decision) {
  return goal !== undefined
    && goal.id === decision.goalId
    && goal.revision === decision.revision
    && goal.phase === 'active'
    && goal.roundsStarted >= decision.round
}

export function apply(ctx) {
  const tracker = new GoalNoProgressTracker()
  const pending = new Set()
  const epochs = new WeakMap()
  let stopping = false

  function liveAgent(session) {
    const agent = ctx.agents.get(session.id)
    return agent?.session === session ? agent : undefined
  }

  function advanceEpoch(agent) {
    const next = (epochs.get(agent) ?? 0) + 1
    epochs.set(agent, next)
    return next
  }

  function resetAgent(agent) {
    advanceEpoch(agent)
    tracker.reset(agent)
  }

  function pauseAfterCheckpoint(agent, session, decision, epoch) {
    let goal
    try {
      goal = ctx.goals.get(agent)
      if (!sameGoal(goal, decision) || goal.activation !== 'armed') return
      // Close the race with goal-round-driver before its idle handler can queue another round.
      ctx.goals.disarm(agent)
    } catch (error) {
      ctx.logger.warn(`desktop-goal-no-progress-guard: could not disarm agent "${agent.id}": ${renderThrown(error)}`)
      return
    }

    const task = Promise.resolve().then(async () => {
      await ctx.sessions.flush(session)
      if (stopping
        || epochs.get(agent) !== epoch
        || ctx.agents.get(agent.id) !== agent
        || agent.session !== session) return
      const latest = ctx.goals.get(agent)
      if (!sameGoal(latest, decision) || latest.activation !== 'disarmed') return
      ctx.goals.pause(agent, { id: latest.id, revision: latest.revision })
      ctx.logger.warn(`desktop-goal-no-progress-guard: paused goal "${latest.id}" after two identical rounds without progress`)
    }).catch(error => {
      ctx.logger.warn(`desktop-goal-no-progress-guard: fail-closed pause for agent "${agent.id}" did not commit: ${renderThrown(error)}`)
    }).finally(() => {
      pending.delete(task)
    })
    pending.add(task)
  }

  ctx.effect(function* () {
    ctx.on('session/event', (session, event) => {
      if (stopping) return
      const agent = liveAgent(session)
      if (agent === undefined) return
      const epoch = advanceEpoch(agent)
      const decision = tracker.observe(agent, event)
      if (decision !== undefined) pauseAfterCheckpoint(agent, session, decision, epoch)
    })
    ctx.on('goal/changed', ({ agent }) => { resetAgent(agent) })
    ctx.on('agent/session-start', ({ agent }) => { resetAgent(agent) })
    ctx.on('agent/error', ({ agent }) => { resetAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => { tracker.delete(agent) })
    ctx.on('agent/inbox/inserted', ({ agent, message }) => {
      advanceEpoch(agent)
      if (message.source?.kind !== 'goal' || message.source.round <= 0) tracker.reset(agent)
    })
    yield async () => {
      stopping = true
      tracker.clear()
      await Promise.allSettled([...pending])
      pending.clear()
    }
  }, 'desktop goal no-progress guard lifecycle')
}
