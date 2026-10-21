import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { registerHooks } from 'node:module'
import { adaptSearchRuntime, installSearchRuntimeHook } from '../src/search-runtime-injector.ts'

// Matches the upstream service boundary; tools keep their original schemas and renderers.
const source = `
class WebError extends Error { constructor(message, code) { super(message); this.code = code; } }
class WebRuntime {
  searchProviders = new Map();
  searchProviderId = 'deepseek-official';
  async search(request, signal) {
    return capSources(await resolveProvider({
      providers: this.searchProviders,
      ...this.searchProviderId !== void 0 ? { configuredId: this.searchProviderId } : {}
    }).search(request, signal), request.maxResults);
  }
}
function resolveProvider({ providers, configuredId }) {
  const provider = providers.get(configuredId);
  if (!provider) throw new WebError('missing provider', 'WEB_PROVIDER_CONFIGURED_MISSING');
  if (!provider.available()) throw new WebError('unavailable provider', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE');
  return provider;
}
function capSources(result, maxResults) {
  if (maxResults === undefined || result.sources.length <= maxResults) return result;
  return { ...result, sources: result.sources.slice(0, maxResults), truncated: true };
}
`.replace(/^ {2}/gm, '\t').replace(/^\t {2}/gm, '\t\t').replace(/^\t\t {2}/gm, '\t\t\t')

function fixture(adapted = true) {
  const result = adapted ? adaptSearchRuntime(source) : { source }
  return new (new Function('process', result.source + '; return WebRuntime;')(process))() as {
    searchProviders: Map<string, any>; searchProviderId?: string
    search(request: { query: string; maxResults?: number }, signal?: AbortSignal): Promise<any>
  }
}
const provider = (id: string, value = { sources: [], truncated: false }) => ({ id, available: () => true, search: vi.fn(async () => value) })
const config = (value: unknown) => { vi.stubEnv('DSH_DESKTOP_SEARCH_CONFIG', JSON.stringify(value)) }
const response = () => new Response(JSON.stringify({ results: [
  { url: 'https://example.com/1', title: 'First', highlights: ['Excerpt'], publishedDate: '2026-10-21' },
  { url: 'https://example.com/2', text: 'Full text' },
] }), { headers: { 'content-type': 'application/json' } })

beforeEach(() => {
  vi.stubEnv('DSH_DESKTOP_SEARCH_CONFIG', '{}'); vi.stubEnv('EXA_API_KEY', ''); vi.stubEnv('PERPLEXITY_API_KEY', '')
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network access in unit test') }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('desktop search routing', () => {
  it('reproduces missing DeepSeek credentials and uses configured Exa instead', async () => {
    config({ provider: 'auto', exa: { apiKey: 'test-key', baseURL: 'https://api.exa.ai' } })
    const original = fixture(false), web = fixture()
    const deepseek = provider('deepseek-official')
    deepseek.search.mockRejectedValue(Object.assign(new Error('no key'), { code: 'WEB_PROVIDER_CREDENTIAL_MISSING' }))
    original.searchProviders.set(deepseek.id, deepseek); web.searchProviders.set(deepseek.id, deepseek)
    await expect(original.search({ query: 'test' })).rejects.toThrow('no key')
    const fetch = vi.fn<typeof globalThis.fetch>(async () => response()); vi.stubGlobal('fetch', fetch)
    const result = await web.search({ query: 'test', maxResults: 1 })
    expect(result).toEqual({ sources: [{ url: 'https://example.com/1', title: 'First', snippet: 'Excerpt', publishedAt: '2026-10-21' }], truncated: true })
    expect(fetch).toHaveBeenCalledWith('https://api.exa.ai/search', expect.objectContaining({ redirect: 'error', headers: expect.objectContaining({ 'x-api-key': 'test-key' }) }))
    expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string)).toMatchObject({ query: 'test', numResults: 1, type: 'auto' })
  })

  it('uses any available registered search plugin when the configured one is absent', async () => {
    const web = fixture(), plugin = provider('custom-search')
    web.searchProviders.set(plugin.id, plugin)
    await web.search({ query: 'test' })
    expect(plugin.search).toHaveBeenCalledOnce()
  })

  it('preserves working configured Runtime providers and explicit provider selection', async () => {
    config({ provider: 'auto', exa: { apiKey: 'key' } })
    const web = fixture(), deepseek = provider('deepseek-official')
    web.searchProviders.set(deepseek.id, deepseek)
    await web.search({ query: 'test' }); expect(deepseek.search).toHaveBeenCalledOnce()
    config({ provider: 'exa' })
    await expect(web.search({ query: 'test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE' })
    expect(deepseek.search).toHaveBeenCalledOnce()
  })

  it('provides configuration guidance when no channel has credentials', async () => {
    await expect(fixture().search({ query: 'test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_UNAVAILABLE', message: expect.stringContaining('搜索设置') })
  })

  it('preserves native plugin configuration when only an ambient Exa key exists', async () => {
    vi.stubEnv('EXA_API_KEY', 'ambient-key')
    const web = fixture(), native = provider('exa')
    web.searchProviders.set(native.id, native)
    await web.search({ query: 'test' })
    expect(native.search).toHaveBeenCalledOnce()
    expect(fetch).not.toHaveBeenCalled()
    config({ provider: 'runtime', exa: { apiKey: 'shell-key' } })
    delete web.searchProviderId
    await web.search({ query: 'test' })
    expect(native.search).toHaveBeenCalledTimes(2)
  })

  it('honors cancellation during HTTP work and the per-request timeout', async () => {
    config({ provider: 'exa', exa: { apiKey: 'key' } })
    const network = vi.fn<typeof globalThis.fetch>(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }))
    vi.stubGlobal('fetch', network)
    const cancellation = new AbortController()
    const pending = fixture().search({ query: 'test' }, cancellation.signal)
    cancellation.abort()
    await expect(pending).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    const timeout = new AbortController()
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal)
    const timed = fixture().search({ query: 'test' })
    timeout.abort()
    await expect(timed).rejects.toMatchObject({ code: 'WEB_TIMEOUT' })
  })

  it('reads reactive Runtime provider selection on every search', async () => {
    const reactive = source.replace('\t\treturn capSources(await resolveProvider({', '\t\tconst configuredId = this.config.searchProvider.get() ?? this.searchProviderEnv;\n\t\treturn capSources(await resolveProvider({')
      .replace('...this.searchProviderId !== void 0 ? { configuredId: this.searchProviderId }', '...configuredId !== void 0 ? { configuredId }')
    const adapted = adaptSearchRuntime(reactive)
    expect(adapted.changed).toBe(true)
    const web = new (new Function('process', adapted.source + '; return WebRuntime;')(process))()
    let selected = 'one'
    web.config = { searchProvider: { get: () => selected } }
    const one = provider('one'), two = provider('two')
    web.searchProviders.set('one', one); web.searchProviders.set('two', two)
    await web.search({ query: 'test' }); selected = 'two'; await web.search({ query: 'test' })
    expect(one.search).toHaveBeenCalledOnce(); expect(two.search).toHaveBeenCalledOnce()
  })

  it('does not hide HTTP failures or cancellation by silently trying another channel', async () => {
    config({ provider: 'exa', exa: { apiKey: 'secret' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('private server detail', { status: 401 })))
    await expect(fixture().search({ query: 'test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('401') })
    const signal = AbortSignal.abort()
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
    await expect(fixture().search({ query: 'test' }, signal)).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('normalizes Perplexity results without inventing sources or snippets', async () => {
    config({ provider: 'perplexity', perplexity: { apiKey: 'key', baseURL: 'https://api.perplexity.ai/' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: 'Answer' } }], citations: ['https://example.com'] }))))
    expect(await fixture().search({ query: 'test' })).toEqual({ content: 'Answer', sources: [{ url: 'https://example.com' }], truncated: false })
  })

  it('rejects malformed success responses, retains valid empty results, and bounds waiting', async () => {
    config({ provider: 'exa', exa: { apiKey: 'key' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}')))
    await expect(fixture().search({ query: 'test' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"results":[]}')))
    expect(await fixture().search({ query: 'test' })).toEqual({ sources: [], truncated: false })
  })

  it('applies once, retains unknown layouts, and only hooks the web service module', () => {
    const adapted = adaptSearchRuntime(source)
    expect(adapted.changed).toBe(true)
    expect(adaptSearchRuntime(adapted.source).changed).toBe(false)
    expect(adaptSearchRuntime(source.replace('async search(', 'async other(')).changed).toBe(false)
    const register = vi.fn<typeof registerHooks>(() => ({ deregister: vi.fn() }))
    installSearchRuntimeHook(register)
    const load = register.mock.calls[0]![0]!.load!
    const next = vi.fn(() => ({ source: Buffer.from(source), format: 'module' }))
    const context = { conditions: [], format: 'module', importAttributes: {} }
    expect(load('file:///runtime/node_modules/@deepseek-ai/dsh-web/lib/index.js', context, next).source).not.toEqual(Buffer.from(source))
    expect(load('file:///runtime/node_modules/@deepseek-ai/dsh-web-fetch-http/lib/index.js', context, next).source).toEqual(Buffer.from(source))
  })
})
