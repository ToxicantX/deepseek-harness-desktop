window.__ModuleLoader__.load({
  id: '@deepseek-ai/dsh-desktop-pet-bridge',
  factory: () => {
    const module = { exports: {} }
    const inject = ['sessions']

    function apply(ctx) {
      const publish = () => {
        const sessionId = ctx.sessions.list.getSnapshot().current ?? null
        window.postMessage({ type: 'dsh/desktop-pet-active-session', sessionId }, window.location.origin)
      }
      publish()
      ctx.effect(() => ctx.sessions.list.subscribe(publish), 'desktop-pet: active session bridge')
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
