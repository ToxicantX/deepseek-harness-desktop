import { describe, expect, it, vi } from 'vitest'
import { createClientBundleAdapterScript, createSkinLocaleAdapter, createSkinSessionsAdapter } from '../src/skin-market-injector.ts'

describe('shell skin locale compatibility', () => {
  it('supports namespace binding with language fallback and interpolation', () => {
    const locale = createSkinLocaleAdapter('zh-CN')
    const listener = vi.fn()
    locale.subscribe(listener)
    const dispose = locale.register('dodger-17', {
      zh: { title: '道奇 17 主题', greeting: '你好，{name}' },
      en: { title: 'Dodger 17 theme', greeting: 'Hello, {name}' },
    })
    const t = locale.bind('dodger-17')

    expect(t('title')).toBe('道奇 17 主题')
    expect(t('greeting', { name: 'Shohei' })).toBe('你好，Shohei')
    expect(locale.bind('dodger-17')).toBe(t)
    expect(listener).toHaveBeenCalledTimes(1)

    dispose()
    expect(t('title')).toBe('title')
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('embeds the locale adapter in client activation scripts', () => {
    const bundle = `window.__ModuleLoader__.load({ id: 'locale-probe', factory() { return { apply(ctx) { ctx.locale.register('probe', { en: { title: 'Ready' } }); return ctx.locale.bind('probe')('title') } } } })`
    const script = createClientBundleAdapterScript(bundle, 'example.locale-probe')

    expect(script).toContain('createSkinLocaleAdapter')
    expect(script).toContain("ctx.locale.bind('probe')")
  })
})

describe('shell skin session compatibility', () => {
  it('provides an observable session list and safe session binding', () => {
    const sessions = createSkinSessionsAdapter()
    const listener = vi.fn()
    sessions.list.subscribe(listener)

    expect(sessions.list.getSnapshot()).toEqual({ byId: {} })
    sessions.setCurrent('session-137')
    expect(sessions.list.getSnapshot()).toEqual({
      current: 'session-137',
      byId: { 'session-137': { running: false } },
    })
    expect(sessions.binding('session-137').session.getSnapshot()).toEqual({ lastAgentError: null })
    expect(listener).toHaveBeenCalledTimes(1)

    sessions.setCurrent(null)
    expect(sessions.list.getSnapshot()).toEqual({ byId: {} })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('embeds the sessions adapter in client activation scripts', () => {
    const bundle = `window.__ModuleLoader__.load({ id: 'sessions-probe', factory() { return { apply(ctx) { return ctx.sessions.list.getSnapshot().current } } } })`
    const script = createClientBundleAdapterScript(bundle, 'example.sessions-probe')

    expect(script).toContain('createSkinSessionsAdapter')
    expect(script).toContain('sessions, remote, reflect')
    expect(script).toContain("if (name === 'sessions') return sessions")
  })
})
