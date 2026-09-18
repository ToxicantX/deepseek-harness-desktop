import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Cookie } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { pruneRuntimeAuthCookies } from '../src/runtime-auth-cookies.ts'

const nameFor = (host: string) => 'dsh-auth-' + createHash('sha256').update(host).digest('base64url')
const cookieFor = (host: string): Cookie => ({
  name: nameFor(host), value: 'x'.repeat(174), domain: '127.0.0.1', path: '/',
  hostOnly: true, httpOnly: true, secure: false, session: false, sameSite: 'lax',
})
function jar(initial: Cookie[]) {
  const values = [...initial]
  return {
    values,
    get: vi.fn(async () => [...values]),
    remove: vi.fn(async (_url: string, name: string) => {
      values.splice(values.findIndex(cookie => cookie.name === name), 1)
    }),
  }
}

describe('runtime browser authentication cookies', () => {
  it('recovers plugin requests that exceed Node headers after repeated random-port launches', async () => {
    const server = createServer((_req, res) => { res.end('plugins') })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const url = new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/?token=launch`)
    const current = cookieFor(url.host)
    const cookies = jar([...Array.from({ length: 65 }, (_, index) => cookieFor(`127.0.0.1:${index + 10000}`)), current])
    const request = () => fetch(new URL('/plugins/?ids=' + 'a'.repeat(2800), url), {
      headers: { cookie: cookies.values.map(cookie => `${cookie.name}=${cookie.value}`).join('; ') },
    })
    try {
      expect((await request()).status).toBe(431)
      await pruneRuntimeAuthCookies(cookies, url)
      expect((await request()).status).toBe(200)
      expect(cookies.values).toEqual([current])
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })

  it('preserves current authentication, other cookies, paths and domains', async () => {
    const url = new URL('http://127.0.0.1:41111/?token=launch')
    const old = cookieFor('127.0.0.1:40000')
    const retained = [cookieFor(url.host),
      { ...old, name: 'settings' }, { ...old, name: 'dsh-auth-unrecognized' },
      { ...old, domain: 'localhost' }, { ...old, path: '/other' }]
    const cookies = jar([old, ...retained])
    await pruneRuntimeAuthCookies(cookies, url)
    expect(cookies.values).toEqual(retained)
    expect(cookies.get).toHaveBeenCalledWith({ url: url.origin + '/' })
    expect(cookies.remove).toHaveBeenCalledExactlyOnceWith(url.origin + '/', old.name)
  })

  it.each(['https://example.com/?token=launch', 'http://localhost:40000/?token=launch', 'http://127.0.0.1:40000/'])('does not touch cookies outside authenticated local launches: %s', async value => {
    const cookies = jar([cookieFor('127.0.0.1:40000')])
    await pruneRuntimeAuthCookies(cookies, new URL(value))
    expect(cookies.get).not.toHaveBeenCalled()
    expect(cookies.remove).not.toHaveBeenCalled()
  })
})
