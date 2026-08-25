import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installConversationReplayModuleHook } from '../src/conversation-replay-injector.ts'

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

function chat(...nodes: any[]) {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  return { order: nodes.map(node => node.key), nodes: byKey }
}

function user(key: string, seq: number, text = key) {
  return { key, kind: 'user', data: { seq, content: [{ type: 'text', text }] } }
}

function tail(key: string, seq: number) {
  return { key, kind: 'turn-tail', data: { seq } }
}

describe('desktop shell conversation replay injector', () => {
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

  it('finds the completed turn immediately before a user message', () => {
    const { previousCompletedTurnSeq } = feature()
    const target = user('user-3', 31)
    const snapshot = chat(
      user('user-1', 2),
      { key: 'step-1', kind: 'assistant-step', data: { seq: 3 } },
      tail('tail-1', 14),
      user('user-2', 17),
      target,
    )
    expect(previousCompletedTurnSeq(snapshot, target)).toBe(14)
    expect(previousCompletedTurnSeq(chat(target), target)).toBeUndefined()
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

  it('forks before an older user turn, sends the edited content, then opens the child', async () => {
    const { replayMessage } = feature()
    const target = user('user-2', 21, 'original')
    const sourceSnapshot = { chat: chat(user('user-1', 2), tail('tail-1', 12), target), hasMore: false }
    const prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const source = { getSnapshot: () => sourceSnapshot, loadOlder: vi.fn(), readAttachment: vi.fn() }
    const child = { prompt }
    const fork = vi.fn(async () => 'child-session')
    const open = vi.fn()
    const ctx = {
      sessions: {
        binding: (id: string) => ({ session: id === 'source-session' ? source : child }),
        fork,
        open,
        list: { getSnapshot: () => ({ byId: {} }) },
      },
      workspaces: { list: { getSnapshot: () => ({ items: [] }) } },
    }
    await expect(replayMessage(ctx, {
      sessionId: 'source-session', node: target, content: target.data.content, replacementText: 'edited',
    })).resolves.toBe('child-session')
    expect(fork).toHaveBeenCalledWith({ sessionId: 'source-session', atSeq: 12, increaseTitle: false })
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'edited' }], 'queue')
    expect(open).toHaveBeenCalledWith('child-session')
  })

  it('creates an empty session in the same Workspace when replaying the first user turn', async () => {
    const { replayMessage } = feature()
    const target = user('user-1', 2, 'first')
    const source = {
      getSnapshot: () => ({ chat: chat(target), hasMore: false }),
      loadOlder: vi.fn(),
      readAttachment: vi.fn(),
    }
    const prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const child = { prompt }
    const create = vi.fn(async () => 'fresh-session')
    const open = vi.fn()
    const ctx = {
      sessions: {
        binding: (id: string) => ({ session: id === 'source-session' ? source : child }),
        create,
        open,
        list: { getSnapshot: () => ({ byId: { 'source-session': { cwd: 'D:\\project' } } }) },
      },
      workspaces: {
        list: { getSnapshot: () => ({ items: [{ workspaceId: 'workspace-1', path: 'D:\\project', sessionIds: ['source-session'] }] }) },
      },
    }
    await replayMessage(ctx, {
      sessionId: 'source-session', node: target, content: target.data.content, replacementText: undefined,
    })
    expect(create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
    expect(prompt).toHaveBeenCalledWith([{ type: 'text', text: 'first' }], 'queue')
    expect(open).toHaveBeenCalledWith('fresh-session')
  })

  it('ships the injector in preload and removes the Runtime plugin wiring', () => {
    const root = join(import.meta.dirname, '..')
    const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')
    const patch = readFileSync(join(root, 'runtime', 'desktop.patch.yml'), 'utf8')
    const build = readFileSync(join(root, 'scripts', 'build-runtime.ps1'), 'utf8')
    const executeIndex = preload.indexOf('contextBridge.executeInMainWorld({ func: installConversationReplayModuleHook })')
    const exposeIndex = preload.indexOf("contextBridge.exposeInMainWorld('dshDesktopFiles'")

    expect(executeIndex).toBeGreaterThanOrEqual(0)
    expect(executeIndex).toBeLessThan(exposeIndex)
    expect(patch).not.toContain('desktop-conversation-replay')
    expect(build).not.toContain('ConversationReplayPlugin')
    expect(build).not.toContain('dsh-desktop-conversation-replay')
    expect(existsSync(join(root, 'runtime', 'conversation-replay-plugin'))).toBe(false)
  })
})
