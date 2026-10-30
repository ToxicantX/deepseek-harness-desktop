export const name = 'desktop-compaction-reasoning'
export const inject = ['llm', 'sessions']

export function apply(ctx) {
  ctx.on('llm/stream', async function* (options, next) {
    if (options.purpose !== 'compaction' || options.reasoningEffort !== undefined) { yield* next(); return }
    options.signal?.throwIfAborted()
    const previous = ctx.sessions.get(options.sessionId)?.requestHeader()?.config
    const sameTarget = previous?.provider === options.provider && previous?.model === options.model
    const inherited = sameTarget ? previous.reasoningEffort : undefined
    // This model rejects the adapter's implicit off -> none default even when
    // its configured capability still advertises off. Only use offered levels.
    const fallback = options.model === 'gpt-6.1-sol' ? 'low' : undefined
    if (inherited === undefined && fallback === undefined) { yield* next(); return }
    const info = await ctx.llm.resolveModelInfo(options.provider, options.model, options.signal)
    options.signal?.throwIfAborted()
    const effort = [inherited, fallback].find(value => value !== undefined
      && value !== 'off' && value !== 'none'
      && info.reasoning?.efforts.some(item => item.id === value))
    if (effort !== undefined && !Object.isFrozen(options)) options.reasoningEffort = effort
    yield* next()
  })
}
