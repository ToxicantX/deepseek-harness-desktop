import { registerHooks, type ModuleHooks } from 'node:module'

const MARKER = 'desktopSearchWithFallback'
const SEARCH = '\tasync search(request, signal) {\n\t\treturn capSources(await resolveProvider({\n\t\t\tproviders: this.searchProviders,\n\t\t\t...this.searchProviderId !== void 0 ? { configuredId: this.searchProviderId } : {}\n\t\t}).search(request, signal), request.maxResults);\n\t}'
const REACTIVE_SEARCH = '\tasync search(request, signal) {\n\t\tconst configuredId = this.config.searchProvider.get() ?? this.searchProviderEnv;\n\t\treturn capSources(await resolveProvider({\n\t\t\tproviders: this.searchProviders,\n\t\t\t...configuredId !== void 0 ? { configuredId } : {}\n\t\t}).search(request, signal), request.maxResults);\n\t}'

// Serialized into ctx.web so the standard web_search schema, policy and rendering stay intact.
async function desktopSearchWithFallback(web: any, request: any, signal: AbortSignal | undefined, WebError: any): Promise<any> {
  const fail = (message: string, code = 'WEB_PROVIDER_ERROR') => new WebError(message, code)
  const aborted = () => { if (signal?.aborted) throw fail('搜索已取消', 'WEB_ABORTED') }
  aborted()
  const settings = JSON.parse(process.env.DSH_DESKTOP_SEARCH_CONFIG ?? '{}')
  const preferred = settings.provider ?? 'auto'
  const configuredId = web.config?.searchProvider?.get?.() ?? web.searchProviderId ?? web.searchProviderEnv
  const providers = new Map<string, any>(web.searchProviders)
  for (const id of ['exa', 'perplexity']) {
    if (preferred === 'runtime') break
    const options = settings[id] ?? {}
    const apiKey = options.apiKey || process.env[id === 'exa' ? 'EXA_API_KEY' : 'PERPLEXITY_API_KEY']
    if (typeof apiKey !== 'string' || apiKey.trim() === '') continue
    if (!options.apiKey && providers.get(id)?.available()) continue
    const baseURL = options.baseURL || (id === 'exa' ? 'https://api.exa.ai' : 'https://api.perplexity.ai')
    providers.set(id, {
      available: () => true,
      async search() {
        const timeout = AbortSignal.timeout(30_000)
        const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
        const url = baseURL.replace(/\/+$/, '') + (id === 'exa' ? '/search' : '/chat/completions')
        let data: any
        try {
          const response = await fetch(url, {
            method: 'POST', redirect: 'error', signal: operationSignal,
            headers: { 'content-type': 'application/json', ...(id === 'exa' ? { 'x-api-key': apiKey } : { authorization: 'Bearer ' + apiKey }) },
            body: JSON.stringify(id === 'exa'
              ? { query: request.query, type: 'auto', numResults: Math.min(request.maxResults ?? 8, 100), contents: { highlights: true } }
              : { model: 'sonar', messages: [{ role: 'user', content: request.query }], max_tokens: 1024 }),
          })
          if (!response.ok) throw fail(id + ' 搜索请求失败（HTTP ' + response.status + '），请检查搜索设置中的密钥、地址和配额。')
          data = await response.json()
        } catch (error: any) {
          aborted()
          if (timeout.aborted) throw fail(id + ' 搜索超时，请重试。', 'WEB_TIMEOUT')
          if (error instanceof WebError) throw error
          throw fail(id + ' 搜索请求失败，请检查网络和搜索设置。')
        }
        const rows = id === 'exa' ? data?.results : data?.search_results
          ?? (Array.isArray(data?.citations) ? data.citations.map((url: string) => ({ url })) : data?.citations)
        const content = id === 'perplexity' ? data?.choices?.[0]?.message?.content : undefined
        if ((rows !== undefined && !Array.isArray(rows))
          || (rows === undefined && !(id === 'perplexity' && typeof content === 'string'))
          || (rows ?? []).some((row: any) => !row || typeof row.url !== 'string' || !/^https?:\/\//i.test(row.url))) {
          throw fail(id + ' 返回了无效的搜索结果，请检查接口地址。')
        }
        return {
          ...(typeof content === 'string' ? { content } : {}),
          sources: (rows ?? []).map((row: any) => {
            const snippet = id === 'exa' ? (Array.isArray(row.highlights) ? row.highlights.find((s: unknown) => typeof s === 'string' && s.trim() !== '') : undefined) ?? row.text : row.snippet
            const publishedAt = id === 'exa' ? row.publishedDate : row.date
            return { url: row.url, ...(typeof row.title === 'string' ? { title: row.title } : {}),
              ...(typeof snippet === 'string' ? { snippet: snippet.slice(0, 4000) } : {}),
              ...(typeof publishedAt === 'string' ? { publishedAt } : {}) }
          }), truncated: false,
        }
      },
    })
  }
  const runtimeIds = configuredId === undefined ? [...web.searchProviders.keys()].filter(id => web.searchProviders.get(id).available()) : [configuredId]
  if (preferred === 'runtime' && runtimeIds.length > 1) throw fail('DSH 存在多个可用搜索渠道，请在 DSH 配置中指定一个，或改用自动选择。', 'WEB_PROVIDER_AMBIGUOUS')
  const ids = preferred === 'auto'
    ? [...new Set([configuredId, 'exa', 'perplexity', ...[...providers.keys()].sort()])]
    : preferred === 'runtime' ? runtimeIds : [preferred]
  for (const id of ids) {
    const provider = providers.get(id)
    if (!provider?.available()) continue
    aborted()
    try {
      const result = await provider.search(request, signal)
      aborted()
      return result
    } catch (error: any) {
      aborted()
      // Only missing configuration permits switching channels. Real failures remain visible.
      if (preferred === 'auto' && ['WEB_PROVIDER_CREDENTIAL_MISSING', 'WEB_PROVIDER_UNAVAILABLE', 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE'].includes(error?.code)) continue
      throw error
    }
  }
  throw fail('没有可用的搜索渠道。请在 Runtime → 搜索设置中配置 Exa 或 Perplexity，或配置 DSH 原有的搜索提供商。', 'WEB_PROVIDER_UNAVAILABLE')
}

export function adaptSearchRuntime(source: string): { source: string; changed: boolean } {
  const anchors = [SEARCH, REACTIVE_SEARCH].filter(anchor => source.split(anchor).length === 2)
  if (source.includes(MARKER) || anchors.length !== 1) return { source, changed: false }
  return {
    source: source.replace(anchors[0]!, '\tasync search(request, signal) {\n\t\treturn capSources(await desktopSearchWithFallback(this, request, signal, WebError), request.maxResults);\n\t}')
      + '\n' + desktopSearchWithFallback.toString(),
    changed: true,
  }
}

export function installSearchRuntimeHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      try {
        const target = new URL(url)
        if (target.protocol !== 'file:' || !decodeURIComponent(target.pathname).endsWith('/node_modules/@deepseek-ai/dsh-web/lib/index.js')) return loaded
      } catch { return loaded }
      if (loaded.source === undefined) return loaded
      const source = typeof loaded.source === 'string' ? loaded.source
        : (ArrayBuffer.isView(loaded.source)
          ? Buffer.from(loaded.source.buffer, loaded.source.byteOffset, loaded.source.byteLength)
          : Buffer.from(loaded.source)).toString('utf8')
      const result = adaptSearchRuntime(source)
      if (!result.changed && !source.includes(MARKER)) console.warn('Desktop search: unknown runtime layout; original search service retained.')
      return result.changed ? { ...loaded, source: result.source } : loaded
    },
  })
}
