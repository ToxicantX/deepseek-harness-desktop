import { afterEach, describe, expect, it, vi } from 'vitest'
import { latestUpstreamVersion, loadLatestUpstreamVersion, UPSTREAM_RELEASES_URL } from '../src/upstream-releases.ts'

afterEach(() => vi.unstubAllGlobals())

describe('upstream release discovery', () => {
  it('includes alpha releases, ignores drafts and other packages, and sorts by semver', () => {
    expect(latestUpstreamVersion([
      { tag_name: 'dsh-v0.1.7-alpha.2', draft: false, prerelease: true },
      { tag_name: 'dsh-v0.1.7-alpha.10', draft: false, prerelease: true },
      { tag_name: 'dsh-v0.1.6', draft: false, prerelease: false },
      { tag_name: 'dsh-v0.1.8', draft: true },
      { tag_name: 'other-v9.0.0', draft: false },
      { tag_name: 'dsh-vinvalid', draft: false },
      null,
    ])).toBe('0.1.7-alpha.10')
    expect(latestUpstreamVersion([
      { tag_name: 'dsh-v0.1.7-rc.1', draft: false },
      { tag_name: 'dsh-v0.1.7', draft: false },
    ])).toBe('0.1.7')
  })

  it('rejects empty or malformed responses instead of claiming the current version is latest', () => {
    expect(() => latestUpstreamVersion({ message: 'rate limited' })).toThrow()
    expect(() => latestUpstreamVersion([])).toThrow()
  })

  it('queries the release list rather than the stable-only latest endpoint', async () => {
    const request = vi.fn(async () => Response.json([{ tag_name: 'dsh-v0.1.7-alpha.2', draft: false }]))
    vi.stubGlobal('fetch', request)
    await expect(loadLatestUpstreamVersion()).resolves.toBe('0.1.7-alpha.2')
    expect(request).toHaveBeenCalledWith(UPSTREAM_RELEASES_URL, expect.objectContaining({ cache: 'no-store', signal: expect.any(AbortSignal) }))
  })

  it('reports a rate limit without interpreting the error document as release data', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 403 })))
    await expect(loadLatestUpstreamVersion()).rejects.toThrow('HTTP 403')
  })
})
