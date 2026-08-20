import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyNode, inject as nodeInject, name as nodeName } from '../runtime/pet-bridge-plugin/index.js'

const originalWindow = globalThis.window
let clientPlugin
const load = vi.fn(registration => { clientPlugin = registration.factory() })
globalThis.window = { __ModuleLoader__: { load } }
await import('../runtime/pet-bridge-plugin/client.js')
if (clientPlugin === undefined) throw new Error('pet client bundle did not register')
const { apply: applyClient, inject: clientInject } = clientPlugin
if (originalWindow === undefined) delete globalThis.window
else globalThis.window = originalWindow

const root = join(import.meta.dirname, '..')
const patch = readFileSync(join(root, 'runtime', 'desktop.patch.yml'), 'utf8')
const build = readFileSync(join(root, 'scripts', 'build-runtime.ps1'), 'utf8')
const manifest = JSON.parse(readFileSync(join(root, 'runtime', 'pet-bridge-plugin', 'package.json'), 'utf8'))

afterEach(() => {
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
})

describe('desktop pet Runtime client bridge', () => {
  it('publishes the current session and clears it through same-origin messages', () => {
    let current = 'session-a'
    let listener
    const unsubscribe = vi.fn()
    const postMessage = vi.fn()
    globalThis.window = { location: { origin: 'http://127.0.0.1:43120' }, postMessage }
    const effect = vi.fn(factory => factory())
    applyClient({
      sessions: { list: { getSnapshot: () => ({ current }), subscribe: fn => { listener = fn; return unsubscribe } } },
      effect,
    })
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: 'dsh/desktop-pet-active-session', sessionId: 'session-a' },
      'http://127.0.0.1:43120',
    )
    current = undefined
    listener()
    expect(postMessage).toHaveBeenLastCalledWith(
      { type: 'dsh/desktop-pet-active-session', sessionId: null },
      'http://127.0.0.1:43120',
    )
    expect(effect).toHaveBeenCalledWith(expect.any(Function), 'desktop-pet: active session bridge')
    expect(effect.mock.results[0]?.value).toBe(unsubscribe)
  })

  it('is declared as a Web client plugin and bundled into desktop Runtime artifacts', () => {
    expect(load).toHaveBeenCalledOnce()
    expect(clientInject).toEqual(['sessions'])
    expect(nodeName).toBe('desktop-pet-bridge')
    expect(nodeInject).toEqual([])
    expect(applyNode()).toBeUndefined()
    expect(manifest.dsh.client).toEqual({ inject: ['@deepseek-ai/dsh-client-runtime'], platform: 'web' })
    expect(manifest.exports['./client']).toBe('./client.js')
    expect(manifest.exports['./package.json']).toBe('./package.json')
    expect(patch).toContain("name: '@deepseek-ai/dsh-desktop-pet-bridge'")
    expect(build).toContain("$PetBridgePluginSource = Join-Path $RepositoryRoot 'runtime/pet-bridge-plugin'")
    expect(build).toContain('"@deepseek-ai/dsh-desktop-pet-bridge": "file:./plugins/pet-bridge"')
  })
})
