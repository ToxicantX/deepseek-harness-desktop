import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'

const PI_AI_ENTRY_SUFFIX = '/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
const DEFAULT_INPUT_DECLARATION = /const DEFAULT_INPUT\s*=\s*\["text"\];/u
const IMAGE_CAPABLE_DEFAULT_INPUT = 'const DEFAULT_INPUT = ["text", "image"];'

export interface CustomProviderImageTransform {
  source: string
  changed: boolean
}

export function promoteCustomProviderImageInput(source: string): CustomProviderImageTransform {
  if (!DEFAULT_INPUT_DECLARATION.test(source)) return { source, changed: false }
  return { source: source.replace(DEFAULT_INPUT_DECLARATION, IMAGE_CAPABLE_DEFAULT_INPUT), changed: true }
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
