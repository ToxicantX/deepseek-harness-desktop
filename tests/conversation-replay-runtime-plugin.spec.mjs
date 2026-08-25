import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyNode, inject as nodeInject, name as nodeName } from '../runtime/conversation-replay-plugin/index.js'

const originalWindow = globalThis.window
const originalDocument = globalThis.document
let clientPlugin
const load = vi.fn(registration => {
  clientPlugin = registration.factory(id => {
    if (id === 'react') return {
      Fragment: Symbol('Fragment'),
      createElement: vi.fn(),
      memo: component => component,
      useCallback: value => value,
      useEffect: vi.fn(),
      useMemo: factory => factory(),
      useState: initial => [typeof initial === 'function' ? initial() : initial, vi.fn()],
    }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    if (id === '@deepseek-ai/dsh-client-ui-attachment') return {}
    throw new Error(`unexpected client dependency: ${id}`)
  })
})
globalThis.window = { __ModuleLoader__: { load } }
await import('../runtime/conversation-replay-plugin/client.js')
if (clientPlugin === undefined) throw new Error('conversation replay client bundle did not register')
const {
  apply: applyClient,
  contentParts,
  inject: clientInject,
  isLongTextClip,
  previousCompletedTurnSeq,
  promptContent,
  replayMessage,
  textClipLabel,
} = clientPlugin

const root = join(import.meta.dirname, '..')
const patch = readFileSync(join(root, 'runtime', 'desktop.patch.yml'), 'utf8')
const build = readFileSync(join(root, 'scripts', 'build-runtime.ps1'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'runtime', 'conversation-replay-plugin', 'package.json'), 'utf8'))

function chat(...nodes) {
  const byKey = new Map(nodes.map(node => [node.key, node]))
  return { order: nodes.map(node => node.key), nodes: { get: key => byKey.get(key) } }
}

function user(key, seq, text = 'question') {
  return { key, kind: 'user', data: { seq, time: 1_700_000_000_000, content: [{ type: 'text', text }] } }
}

function tail(key, seq) {
  return { key, kind: 'turn-tail', data: { seq } }
}

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
  if (originalDocument === undefined) delete globalThis.document
  else globalThis.document = originalDocument
})

describe('desktop conversation edit and retry Runtime plugin', () => {
  it('keeps sent text clips collapsed above the same 500-character threshold as the composer', () => {
    expect(isLongTextClip('x'.repeat(500))).toBe(false)
    expect(isLongTextClip('x'.repeat(501))).toBe(true)
    expect(textClipLabel('12345678901234567890')).toBe('123456789012345…')
    expect(textClipLabel('   ')).toBe('粘贴的文本')
  })

  it('locates the completed turn immediately before the selected user message', () => {
    const target = user('user-2', 21)
    const snapshot = chat(user('user-1', 2), tail('tail-1', 12), target, tail('tail-2', 30))
    expect(previousCompletedTurnSeq(snapshot, target)).toBe(12)
    expect(previousCompletedTurnSeq(chat(target, tail('tail-2', 30)), target)).toBeUndefined()
  })

  it('projects text and image content and preserves image bytes for replay', async () => {
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
    const target = user('user-2', 21, 'original')
    const sourceSnapshot = { chat: chat(user('user-1', 2), tail('tail-1', 12), target), hasMore: false }
    const prompt = vi.fn(async () => ({ ok: true, value: { accepted: true } }))
    const source = { getSnapshot: () => sourceSnapshot, loadOlder: vi.fn(), readAttachment: vi.fn() }
    const child = { prompt }
    const fork = vi.fn(async () => 'child-session')
    const open = vi.fn()
    const ctx = {
      sessions: {
        binding: id => ({ session: id === 'source-session' ? source : child }),
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

  it('creates an empty session in the same Workspace when editing the first user turn', async () => {
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
        binding: id => ({ session: id === 'source-session' ? source : child }),
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

  it('shadows the built-in user renderer and packages the plugin in Runtime artifacts', () => {
    const style = { id: '', textContent: '', remove: vi.fn() }
    const appendChild = vi.fn()
    globalThis.document = {
      getElementById: vi.fn(() => null),
      createElement: vi.fn(() => style),
      head: { appendChild },
    }
    const register = vi.fn(() => vi.fn())
    const inject = vi.fn((_name, factory) => factory())
    const effect = vi.fn(factory => factory())
    applyClient({ slots: { inject, register }, effect })
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.chat.node', key: 'user', priority: -100,
    }), expect.any(Function))
    expect(appendChild).toHaveBeenCalledWith(style)
    expect(clientInject).toEqual(['slots', 'sessions', 'workspaces'])
    expect(load).toHaveBeenCalledOnce()
    expect(nodeName).toBe('desktop-conversation-replay')
    expect(nodeInject).toEqual([])
    expect(applyNode()).toBeUndefined()
    expect(manifest.dsh.client.inject).toContain('@deepseek-ai/dsh-client-ui-conversation')
    expect(patch).toContain("name: '@deepseek-ai/dsh-desktop-conversation-replay'")
    expect(build).toContain("$ConversationReplayPluginSource = Join-Path $RepositoryRoot 'runtime/conversation-replay-plugin'")
    expect(build).toContain('"@deepseek-ai/dsh-desktop-conversation-replay": "file:./plugins/conversation-replay"')
  })
})
