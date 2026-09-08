import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installConversationReplayModuleHook, runIsolatedShellInjection } from '../src/conversation-replay-injector.ts'

const originalLoaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__ModuleLoader__')
const originalHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopConversationReplayHook')
const originalDocument = globalThis.document

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as Record<string, unknown>)[name]
  if (descriptor !== undefined) Object.defineProperty(globalThis, name, descriptor)
}

afterEach(() => {
  restoreGlobal('__ModuleLoader__', originalLoaderDescriptor)
  restoreGlobal('__dshDesktopConversationReplayHook', originalHookDescriptor)
  globalThis.document = originalDocument
  vi.restoreAllMocks()
})

function reactRuntime() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: vi.fn((type, props, ...children) => ({ type, props: { ...props, children } })),
    memo: vi.fn(component => component),
    useCallback: vi.fn(callback => callback),
    useEffect: vi.fn(),
    useMemo: vi.fn(factory => factory()),
    useState: vi.fn(value => [value, vi.fn()]),
  }
}

function clientRequire() {
  const React = reactRuntime()
  const primitives = {
    IconCheckOutline16: () => null,
    IconCopyOutline16: () => null,
    IconEditOutline16: () => null,
    IconRefreshOutline16: () => null,
    JsonBlock: () => null,
    MessageText: () => null,
    Tooltip: () => null,
    writeClipboard: vi.fn(),
  }
  const attachment = { ImageGallery: () => null }
  return {
    React,
    require: vi.fn((id: string) => {
      if (id === 'react') return React
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return primitives
      if (id === '@deepseek-ai/dsh-client-ui-attachment') return attachment
      throw new Error('unexpected client require: ' + id)
    }),
  }
}

function feature() {
  installConversationReplayModuleHook()
  const hook = (globalThis as any).__dshDesktopConversationReplayHook
  return hook.createFeature(clientRequire().require)
}

function user(key: string, seq: number, text = key) {
  return { key, kind: 'user', data: { seq, content: [{ type: 'text', text }] } }
}

describe('desktop shell conversation replay injector', () => {
  it('keeps the main-world installer self-contained after serialization', () => {
    const serialized = Function(`return (${installConversationReplayModuleHook.toString()})`)()
    expect(serialized()).toBe('installed')
  })

  it('contains preload injection failures and continues startup', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const after = vi.fn()

    expect(runIsolatedShellInjection('测试注入', () => { throw new Error('broken injection') })).toBe(false)
    expect(runIsolatedShellInjection('异步测试注入', () => Promise.reject(new Error('broken async injection')))).toBe(true)
    after()
    await Promise.resolve()

    expect(after).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith('测试注入', expect.any(Error))
    expect(error).toHaveBeenCalledWith('异步测试注入', expect.any(Error))
  })

  it('installs before ModuleLoader assignment and wraps only the conversation module', () => {
    expect(installConversationReplayModuleHook()).toBe('installed')
    expect(installConversationReplayModuleHook()).toBe('already-installed')
    expect((globalThis as any).__ModuleLoader__).toBeUndefined()

    const loader: { load?: (handoff: unknown) => unknown } = {}
    ;(globalThis as any).__ModuleLoader__ = loader
    const exposedLoader = (globalThis as any).__ModuleLoader__
    expect(exposedLoader).not.toBe(loader)

    const rawLoad = vi.fn()
    loader.load = rawLoad
    const unrelated = { id: 'unrelated', factory: vi.fn() }
    exposedLoader.load(unrelated)
    expect(rawLoad).toHaveBeenLastCalledWith(unrelated)

    const temporaryLoad = vi.fn()
    const interceptedLoad = exposedLoader.load
    exposedLoader.load = temporaryLoad
    exposedLoader.load(unrelated)
    expect(temporaryLoad).toHaveBeenCalledWith(unrelated)
    exposedLoader.load = interceptedLoad

    const legacyFactory = vi.fn(() => ({ apply: vi.fn() }))
    exposedLoader.load({ id: '@deepseek-ai/dsh-desktop-conversation-replay', factory: legacyFactory })
    const legacyHandoff = rawLoad.mock.calls[1]?.[0]
    const legacyExports = legacyHandoff.factory(clientRequire().require)
    expect(legacyFactory).not.toHaveBeenCalled()
    expect(legacyExports.inject).toEqual([])
    expect(legacyExports.apply()).toBeUndefined()
    expect((globalThis as any).__dshDesktopConversationReplayHook.legacySuppressions).toBe(1)

    const originalApply = vi.fn(() => 'upstream-result')
    const originalInject = ['slots', 'sessions', 'workspaces']
    const originalFactory = vi.fn(() => ({ apply: originalApply, inject: originalInject }))
    exposedLoader.load({ id: '@deepseek-ai/dsh-client-ui-conversation', factory: originalFactory })
    const wrappedHandoff = rawLoad.mock.calls[2]?.[0]
    expect(wrappedHandoff.factory).not.toBe(originalFactory)

    const style = { id: '', textContent: '', remove: vi.fn() }
    const appendChild = vi.fn()
    globalThis.document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => style),
      head: { appendChild },
    } as any
    const register = vi.fn(() => vi.fn())
    const inject = vi.fn((_name, factory) => factory())
    const disposers: Array<() => void> = []
    const effect = vi.fn(factory => {
      const dispose = factory()
      disposers.push(dispose)
      return dispose
    })
    const ctx = { slots: { inject, register }, effect, sessions: {}, workspaces: {} }
    const { require } = clientRequire()
    const exports = wrappedHandoff.factory(require)

    expect(exports.inject).toBe(originalInject)
    expect(exports.apply(ctx)).toBe('upstream-result')
    expect(originalApply).toHaveBeenCalledWith(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.node',
      key: 'user',
      priority: -100,
      registrant: '@deepseek-ai/dsh-desktop-shell-conversation-replay',
    }), expect.any(Function))
    expect(appendChild).toHaveBeenCalledWith(style)

    exports.apply(ctx)
    expect(originalApply).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledTimes(1)
    expect(disposers).toHaveLength(1)
    disposers[0]?.()
    expect(style.remove).toHaveBeenCalledOnce()
  })

  it('runs the upstream apply before a failing shell enhancement', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installConversationReplayModuleHook()
    const rawLoad = vi.fn()
    ;(globalThis as any).__ModuleLoader__ = { load: rawLoad }
    const exposedLoader = (globalThis as any).__ModuleLoader__
    const order: string[] = []
    const originalApply = vi.fn(() => {
      order.push('core')
      return 'core-result'
    })
    exposedLoader.load({
      id: '@deepseek-ai/dsh-client-ui-conversation',
      factory: () => ({ inject: ['slots'], apply: originalApply }),
    })
    const wrapped = rawLoad.mock.calls[0]?.[0].factory(clientRequire().require)
    globalThis.document = {
      getElementById: vi.fn(() => {
        order.push('shell')
        throw new Error('shell style failure')
      }),
    } as any

    expect(wrapped.apply({ slots: {}, effect: vi.fn(), sessions: {}, workspaces: {} })).toBe('core-result')
    expect(order).toEqual(['core', 'shell'])
    expect(originalApply).toHaveBeenCalledOnce()
  })

  it('keeps immutable upstream exports usable when wrapping is rejected', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installConversationReplayModuleHook()
    const rawLoad = vi.fn()
    ;(globalThis as any).__ModuleLoader__ = { load: rawLoad }
    const exposedLoader = (globalThis as any).__ModuleLoader__
    const originalApply = vi.fn(() => 'core-result')
    const immutableExports: Record<string, unknown> = { inject: ['slots'] }
    Object.defineProperty(immutableExports, 'apply', {
      configurable: false,
      enumerable: true,
      writable: false,
      value: originalApply,
    })
    exposedLoader.load({
      id: '@deepseek-ai/dsh-client-ui-conversation',
      factory: () => immutableExports,
    })

    const loaded = rawLoad.mock.calls[0]?.[0].factory(clientRequire().require)
    expect(loaded).toBe(immutableExports)
    expect(loaded.apply({})).toBe('core-result')
  })

  it('passes through loader handoffs when shell inspection throws', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installConversationReplayModuleHook()
    const rawLoad = vi.fn((_handoff: unknown) => 'core-loaded')
    const poisonedHandoff = { factory: vi.fn() }
    Object.defineProperty(poisonedHandoff, 'id', {
      get() { throw new Error('unsupported handoff shape') },
    })
    const rawLoader = {
      pendingQueue: [poisonedHandoff],
      load: rawLoad,
      create: vi.fn(() => 'core-created'),
    }
    ;(globalThis as any).__ModuleLoader__ = rawLoader
    const exposedLoader = (globalThis as any).__ModuleLoader__

    expect(exposedLoader.load(poisonedHandoff)).toBe('core-loaded')
    expect(rawLoad.mock.calls[0]?.[0]).toBe(poisonedHandoff)
    expect(exposedLoader.create()).toBe('core-created')
    expect(rawLoader.create).toHaveBeenCalledOnce()
  })

  it('falls back to the upstream factory when a registered transform crashes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installConversationReplayModuleHook()
    const hook = (globalThis as any).__dshDesktopConversationReplayHook
    const originalExports = { apply: vi.fn() }
    const originalFactory = vi.fn(() => originalExports)
    hook.registerModuleFactoryTransform('shell-transform-target', () => () => {
      throw new Error('transformed factory failure')
    })
    const rawLoad = vi.fn()
    ;(globalThis as any).__ModuleLoader__ = { load: rawLoad }

    ;(globalThis as any).__ModuleLoader__.load({ id: 'shell-transform-target', factory: originalFactory })
    const transformedHandoff = rawLoad.mock.calls[0]?.[0]
    expect(transformedHandoff.factory(vi.fn())).toBe(originalExports)
    expect(originalFactory).toHaveBeenCalledOnce()
    expect(hook.diagnostics.boundaryFailures).toBe(1)
  })

  it('keeps one loader proxy across temporary takeover and repairs a replaced accessor', () => {
    expect(installConversationReplayModuleHook()).toBe('installed')
    const rawLoad = vi.fn()
    const rawLoader = { load: rawLoad }
    ;(globalThis as any).__ModuleLoader__ = rawLoader
    const hookedLoader = (globalThis as any).__ModuleLoader__

    ;(globalThis as any).__ModuleLoader__ = { load: vi.fn() }
    ;(globalThis as any).__ModuleLoader__ = hookedLoader
    expect((globalThis as any).__ModuleLoader__).toBe(hookedLoader)

    Object.defineProperty(globalThis, '__ModuleLoader__', {
      configurable: true,
      value: rawLoader,
    })
    expect(installConversationReplayModuleHook()).toBe('already-installed')
    const repairedLoader = (globalThis as any).__ModuleLoader__
    expect(repairedLoader).not.toBe(rawLoader)

    const factory = vi.fn(() => ({ apply: vi.fn() }))
    repairedLoader.load({ id: '@deepseek-ai/dsh-client-ui-conversation', factory })
    expect(rawLoad).toHaveBeenCalledWith(expect.objectContaining({
      id: '@deepseek-ai/dsh-client-ui-conversation',
      factory: expect.any(Function),
    }))
    expect(rawLoad.mock.calls[0]?.[0].factory).not.toBe(factory)
  })

  it('wraps queued module handoffs before the loader enters live mode', () => {
    expect(installConversationReplayModuleHook()).toBe('installed')
    const originalFactory = vi.fn(() => ({ apply: vi.fn() }))
    const queue = [{ id: '@deepseek-ai/dsh-client-ui-conversation', factory: originalFactory }]
    const rawLoader: any = {
      mode: 'queue',
      pendingQueue: queue,
      create: vi.fn(function (this: any) {
        this.mode = 'live'
        return this.pendingQueue
      }),
    }
    ;(globalThis as any).__ModuleLoader__ = rawLoader
    const hookedLoader = (globalThis as any).__ModuleLoader__

    const drained = hookedLoader.create()
    expect(drained).toBe(queue)
    expect(drained[0]?.factory).not.toBe(originalFactory)
    const { require } = clientRequire()
    expect(drained[0]?.factory(require)).toEqual(expect.objectContaining({ apply: expect.any(Function) }))
    expect((globalThis as any).__dshDesktopConversationReplayHook.diagnostics).toMatchObject({
      targetRegistrations: 1,
      targetFactories: 1,
    })
  })

  it('recovers from a live module system by applying through the captured root context', async () => {
    expect(installConversationReplayModuleHook()).toBe('installed')
    const style = { id: '', textContent: '', remove: vi.fn() }
    const appendChild = vi.fn()
    globalThis.document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => style),
      head: { appendChild },
    } as any
    const register = vi.fn(() => vi.fn())
    const inject = vi.fn((_name, factory) => factory())
    const effect = vi.fn(factory => factory())
    const injectedCtx = { slots: { inject, register }, effect, sessions: {}, workspaces: {} }
    const injectServices = vi.fn((_dependencies, callback) => callback(injectedCtx))
    const ctx = new Proxy({ inject: injectServices }, {
      get(target, property, receiver) {
        if (property === 'slots' || property === 'sessions' || property === 'workspaces') {
          throw new Error(`cannot get property "${String(property)}" without inject`)
        }
        return Reflect.get(target, property, receiver)
      },
    })
    const dependencies = clientRequire()
    const modules = {
      import: vi.fn(async (id: string) => {
        if (id === 'react') return dependencies.React
        if (id === '@deepseek-ai/dsh-client-ui-primitives') return {
          IconCheckOutline16: () => null,
          IconCopyOutline16: () => null,
          IconEditOutline16: () => null,
          IconRefreshOutline16: () => null,
          JsonBlock: () => null,
          MessageText: () => null,
          Tooltip: () => null,
          writeClipboard: vi.fn(),
        }
        if (id === '@deepseek-ai/dsh-client-ui-attachment') return { ImageGallery: () => null }
        throw new Error('unexpected module import: ' + id)
      }),
    }
    const bootstrapApply = vi.fn()
    const bootstrapFactory = vi.fn(() => ({
      createClientModuleSystem: vi.fn(() => modules),
      apply: bootstrapApply,
    }))
    const queue = [{ id: '@deepseek-ai/dsh-client-modules', factory: bootstrapFactory }]
    const rawLoader: any = {
      mode: 'queue',
      pendingQueue: queue,
      create: vi.fn(function (this: any) {
        const handoff = this.pendingQueue.shift()
        const exports = handoff.factory(() => { throw new Error('bootstrap require should not run') })
        this.mode = 'live'
        this.load = vi.fn()
        this.bootstrapExports = exports
        return exports.createClientModuleSystem(this)
      }),
    }
    ;(globalThis as any).__ModuleLoader__ = rawLoader
    const hookedLoader = (globalThis as any).__ModuleLoader__
    hookedLoader.create()
    rawLoader.bootstrapExports.apply(ctx)
    rawLoader.bootstrapExports.apply(ctx)
    await Promise.resolve()
    await Promise.resolve()
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(modules.import).toHaveBeenCalledWith('react')
    expect(injectServices).toHaveBeenCalledWith(['slots', 'sessions'], expect.any(Function))
    expect(injectServices).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.node',
      key: 'user',
      registrant: '@deepseek-ai/dsh-desktop-shell-conversation-replay',
    }), expect.any(Function))
    expect((globalThis as any).__dshDesktopConversationReplayHook.diagnostics).toMatchObject({
      featureApplications: 1,
      featureFailures: 0,
    })
  })

  it('falls back when optional UI exports are removed', () => {
    installConversationReplayModuleHook()
    const React = reactRuntime()
    const require = vi.fn((id: string) => {
      if (id === 'react') return { default: React }
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return { default: {} }
      throw new Error('module is unavailable: ' + id)
    })
    const hook = (globalThis as any).__dshDesktopConversationReplayHook
    const replay = hook.createFeature(require)
    const register = vi.fn()
    const ctx = {
      slots: {
        inject: vi.fn((_name, callback) => callback()),
        register,
      },
      effect: vi.fn(factory => factory()),
      sessions: {},
      workspaces: {},
    }
    globalThis.document = {
      getElementById: vi.fn(() => ({ remove: vi.fn() })),
      createElement: vi.fn(),
      head: { appendChild: vi.fn() },
    } as any

    replay.apply(ctx)
    const UserMessageNodeView = register.mock.calls[0]?.[1]
    const fallbackNode = user('user-fallback', 1, 'hello')
    fallbackNode.data.content.push({ type: 'image', attachment: { attachmentId: 'image-fallback' } } as any)
    const tree = UserMessageNodeView({
      node: fallbackNode,
      sessionId: 'session-fallback',
      loadImage: vi.fn(),
      useSession: (selector: (snapshot: { removed: boolean }) => unknown) => selector({ removed: false }),
    })

    expect(tree).toBeDefined()
    expect(React.createElement.mock.calls.some(([type]) => type === undefined || type === null)).toBe(false)
  })

  it('folds only text longer than 500 characters and keeps a short label', () => {
    const { isLongTextClip, textClipLabel } = feature()
    expect(isLongTextClip('a'.repeat(500))).toBe(false)
    expect(isLongTextClip('a'.repeat(501))).toBe(true)
    expect(isLongTextClip('😀'.repeat(500))).toBe(false)
    expect(isLongTextClip('😀'.repeat(501))).toBe(true)
    expect(textClipLabel('  first   line\nsecond line with more words  ')).toBe('first line seco…')
    expect(textClipLabel(' \n ')).toBe('粘贴的文本')
  })

  it('reconstructs image blocks and replaces only the text when editing', async () => {
    const { contentParts, promptContent } = feature()
    const content = [
      { type: 'text', text: 'before' },
      { type: 'image', attachment: { attachmentId: 'image-1' } },
      { type: 'text', text: 'after' },
    ]
    expect(contentParts(content)).toMatchObject({ text: 'beforeafter', images: [{ attachment: { attachmentId: 'image-1' } }], rest: [] })
    const session = {
      readAttachment: vi.fn(async () => ({
        ok: true,
        value: {
          attachment: { attachmentId: 'image-1', mediaType: 'image/png', name: 'shot.png' },
          data: new Uint8Array([65, 66, 67]),
        },
      })),
    }
    await expect(promptContent(session, content, undefined)).resolves.toEqual([
      { type: 'text', text: 'before' },
      { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'shot.png' },
      { type: 'text', text: 'after' },
    ])
    await expect(promptContent(session, content, 'edited')).resolves.toEqual([
      { type: 'text', text: 'edited' },
      { type: 'image', mediaType: 'image/png', data: 'QUJD', name: 'shot.png' },
    ])
  })

  it.each([2, 21])('replays message %s in the original session without opening or creating a session', async (seq) => {
    const { replayMessage } = feature()
    const target = user('target', seq, 'original')
    const replay = vi.fn(async () => ({ ok: true }))
    const ctx = { sessions: { binding: () => ({ session: { desktopReplay: replay } }), create: vi.fn(), fork: vi.fn(), open: vi.fn() } }
    await expect(replayMessage(ctx, {
      sessionId: 'original-session', node: target, content: target.data.content, replacementText: 'edited',
    })).resolves.toBe('original-session')
    expect(replay).toHaveBeenCalledWith(seq, [{ type: 'text', text: 'edited' }])
    expect(ctx.sessions.create).not.toHaveBeenCalled()
    expect(ctx.sessions.fork).not.toHaveBeenCalled()
    expect(ctx.sessions.open).not.toHaveBeenCalled()
  })

  it('reports unsupported or rejected replay without falling back to a new session', async () => {
    const { replayMessage } = feature()
    const target = user('target', 2)
    const source: any = {}
    const ctx = { sessions: { binding: () => ({ session: source }), create: vi.fn() } }
    const request = { sessionId: 'original', node: target, content: target.data.content }
    await expect(replayMessage(ctx, request)).rejects.toThrow('Runtime')
    source.desktopReplay = vi.fn(async () => ({ ok: false, error: { message: 'busy' } }))
    await expect(replayMessage(ctx, request)).rejects.toThrow('busy')
    expect(ctx.sessions.create).not.toHaveBeenCalled()
  })

  it('retries the complete original text and images on the same session', async () => {
    const { replayMessage } = feature()
    const target = user('target', 2, 'original\n' + 'long text '.repeat(100))
    const content = [...target.data.content, { type: 'image', attachment: { attachmentId: 'image-1' } }]
    const replay = vi.fn(async () => ({ ok: true }))
    const source = {
      desktopReplay: replay,
      readAttachment: vi.fn(async () => ({ ok: true, value: {
        attachment: { mediaType: 'image/png', name: 'image.png' }, data: new Uint8Array([65, 66, 67]),
      } })),
    }
    const ctx = { sessions: { binding: () => ({ session: source }) } }
    await expect(replayMessage(ctx, { sessionId: 'original', node: target, content })).resolves.toBe('original')
    expect(replay).toHaveBeenCalledWith(2, [
      ...target.data.content, { type: 'image', mediaType: 'image/png', name: 'image.png', data: 'QUJD' },
    ])
  })

  it('ships the injector in preload and removes the Runtime plugin wiring', () => {
    const root = join(import.meta.dirname, '..')
    const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')
    const patch = readFileSync(join(root, 'runtime', 'desktop.patch.yml'), 'utf8')
    const build = readFileSync(join(root, 'scripts', 'build-runtime.ps1'), 'utf8')
    const executeIndex = preload.indexOf('func: installConversationReplayModuleHook')
    const exposeIndex = preload.indexOf("contextBridge.exposeInMainWorld('dshDesktopFiles'")

    expect(executeIndex).toBeGreaterThanOrEqual(0)
    expect(executeIndex).toBeLessThan(exposeIndex)
    expect(preload.slice(0, exposeIndex)).toContain("runIsolatedShellInjection('桌面壳对话编辑与重试注入启动失败'")
    expect(preload.slice(0, exposeIndex)).toContain("runIsolatedShellInjection('桌面壳自定义提供方 User-Agent 注入启动失败'")
    expect(patch).not.toContain('desktop-conversation-replay')
    expect(build).not.toContain('ConversationReplayPlugin')
    expect(build).not.toContain('dsh-desktop-conversation-replay')
    const normalizationIndex = build.indexOf("normalize-runtime-dependencies.mjs') $DshPackage")
    const deployPathIndex = build.indexOf("$DshPackage = Join-Path $App 'node_modules/@deepseek-ai/dsh'")
    const deployIndex = build.indexOf("pnpm --filter '@deepseek-ai/dsh' deploy --prod --legacy $DshPackage")
    const moveIndex = build.indexOf('Move-Item $DshPackage')
    const recursiveDshCopyIndex = build.indexOf("Copy-Item (Join-Path $DshPackage '*') $App -Recurse -Force")
    const copiedManifestValidationIndex = build.indexOf("$CopiedDshManifest = Join-Path $DshPackage 'package.json'")
    const pluginSetupIndex = build.indexOf("$RepairPlugin = Join-Path $DshPackage 'node_modules/@deepseek-ai/dsh-desktop-session-repair'")
    expect(normalizationIndex).toBeGreaterThanOrEqual(0)
    expect(deployPathIndex).toBeGreaterThanOrEqual(0)
    expect(deployIndex).toBeGreaterThan(deployPathIndex)
    expect(normalizationIndex).toBeGreaterThan(deployIndex)
    expect(moveIndex).toBe(-1)
    expect(recursiveDshCopyIndex).toBe(-1)
    expect(copiedManifestValidationIndex).toBeGreaterThan(normalizationIndex)
    expect(pluginSetupIndex).toBeGreaterThan(copiedManifestValidationIndex)
    expect(existsSync(join(root, 'runtime', 'conversation-replay-plugin'))).toBe(false)
  })
})
