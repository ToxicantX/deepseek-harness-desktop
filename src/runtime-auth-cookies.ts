import { createHash } from 'node:crypto'
import type { Cookies } from 'electron'

export async function pruneRuntimeAuthCookies(cookies: Pick<Cookies, 'get' | 'remove'>, url: URL): Promise<void> {
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.searchParams.has('token')) return
  const origin = url.origin + '/'
  // Runtime cookies are named by authority, but browsers send them across all ports.
  const current = 'dsh-auth-' + createHash('sha256').update(url.host).digest('base64url')
  for (const cookie of await cookies.get({ url: origin })) {
    if (cookie.domain !== url.hostname || cookie.path !== '/' || cookie.name === current
      || !/^dsh-auth-[A-Za-z0-9_-]{43}$/u.test(cookie.name)) continue
    await cookies.remove(origin, cookie.name)
  }
}
