import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RuntimeStore } from '../src/runtime-store.ts'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function store(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-catalog-refresh-'))
  directories.push(directory)
  return new RuntimeStore(directory)
}

describe('runtime catalog refresh', () => {
  it('bypasses cached redirects on each refresh while preserving existing URL parameters', async () => {
    const value = { schemaVersion: 1, generatedAt: '2026-09-23T00:00:00Z', releases: [] }
    const request = vi.fn(async () => Response.json(value))
    vi.stubGlobal('fetch', request)
    const runtimeStore = await store()
    await runtimeStore.loadCatalog('https://example.test/catalog.json?channel=alpha')
    await runtimeStore.loadCatalog('https://example.test/catalog.json?channel=alpha')
    const calls = request.mock.calls as unknown as [string, RequestInit][]
    const urls = calls.map(([url]) => new URL(url))
    expect(urls[0]!.searchParams.get('channel')).toBe('alpha')
    expect(urls[0]!.searchParams.get('_refresh')).toBeTruthy()
    expect(urls[0]!.href).not.toBe(urls[1]!.href)
    expect(calls[0]![1].cache).toBe('no-store')
  })

  it('explicitly reports an offline cached catalog', async () => {
    const runtimeStore = await store()
    const catalog = { schemaVersion: 1, generatedAt: '2026-09-22T00:00:00Z', releases: [] }
    await writeFile(runtimeStore.catalogFile, JSON.stringify(catalog))
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(runtimeStore.loadCatalog()).resolves.toEqual({ catalog, cached: true })
  })
})
