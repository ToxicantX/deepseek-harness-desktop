import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'

const PI_AI_ENTRY_SUFFIX = '/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
const DEFAULT_INPUT_DECLARATION = /const DEFAULT_INPUT\s*=\s*\["text"\];/u
const IMAGE_CAPABLE_DEFAULT_INPUT = 'const DEFAULT_INPUT = ["text", "image"];'
const REQUEST_HEADERS_DECLARATION = `function requestHeaders(headers) {
\tconst attribution = attributionHeaders();
\tconst reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
\treturn {
\t\t...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
\t\t...attribution
\t};
}`
const USER_AGENT_OVERRIDE_REQUEST_HEADERS = `function requestHeaders(headers) {
\tconst attribution = attributionHeaders();
\tconst reserved = new Set(Object.keys(attribution).map((name) => name.toLowerCase()));
\tconst customUserAgent = Object.entries(headers ?? {}).findLast(([name]) => name.toLowerCase() === "user-agent")?.[1];
\treturn {
\t\t...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
\t\t...attribution,
\t\t...(customUserAgent === void 0 ? {} : { "user-agent": customUserAgent })
\t};
}`

export interface CustomProviderImageTransform {
  source: string
  changed: boolean
}

export function promoteCustomProviderImageInput(source: string): CustomProviderImageTransform {
  let transformed = source
  transformed = transformed.replace(DEFAULT_INPUT_DECLARATION, IMAGE_CAPABLE_DEFAULT_INPUT)
  transformed = transformed.replace(REQUEST_HEADERS_DECLARATION, USER_AGENT_OVERRIDE_REQUEST_HEADERS)
  return { source: transformed, changed: transformed !== source }
}

function isPiAiEntry(url: string): boolean {
  try {
    const target = new URL(url)
    return target.protocol === 'file:' && decodeURIComponent(target.pathname).endsWith(PI_AI_ENTRY_SUFFIX)
  } catch {
    return false
  }
}

function sourceText(source: LoadFnOutput['source']): string | undefined {
  if (typeof source === 'string') return source
  if (source === undefined) return undefined
  if (ArrayBuffer.isView(source)) return Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('utf8')
  return Buffer.from(source).toString('utf8')
}

export function installCustomProviderImageHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!isPiAiEntry(url)) return loaded
      const source = sourceText(loaded.source)
      if (source === undefined) return loaded
      const transformed = promoteCustomProviderImageInput(source)
      return transformed.changed ? { ...loaded, source: transformed.source } : loaded
    },
  })
}
