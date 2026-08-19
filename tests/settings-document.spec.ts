import { describe, expect, it, vi } from 'vitest'
import { SettingsDocumentClient } from '../src/settings-document.ts'

describe('SettingsDocumentClient', () => {
  it('sends the pathless privileged DSH method and validates its result', async () => {
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value: { opened: true } } }), { headers: { 'content-type': 'application/json' } })
    })
    const client = new SettingsDocumentClient(new URL('http://127.0.0.1:43120/'), fetcher)
    await client.open()
    expect(fetcher).toHaveBeenCalledOnce()
    const call = fetcher.mock.calls[0]
    if (call === undefined) throw new Error('fetcher was not called')
    const [url, init] = call
    expect(String(url)).toBe('http://127.0.0.1:43120/api/settings.openDocument')
    expect(JSON.parse(String(init?.body))).toMatchObject({ method: 'settings.openDocument', payload: {} })
  })

  it('rejects non-loopback origins and business failures', async () => {
    expect(() => new SettingsDocumentClient(new URL('http://localhost:43120/'))).toThrow('loopback')
    const fetcher = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body))
      return new Response(JSON.stringify({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { message: 'open failed' } } }))
    })
    await expect(new SettingsDocumentClient(new URL('http://127.0.0.1:43120/'), fetcher).open()).rejects.toThrow('open failed')
  })
})
