import type { LoadHookSync, RegisterHooksOptions } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { installCustomProviderImageHook, promoteCustomProviderImageInput } from '../src/custom-provider-image-injector.ts'

const originalDefault = 'const DEFAULT_INPUT = ["text"];'
const promotedDefault = 'const DEFAULT_INPUT = ["text", "image"];'

describe('custom provider image injector', () => {
  it('promotes only the omitted pi-ai input default', () => {
    const transformed = promoteCustomProviderImageInput(originalDefault)

    expect(transformed.changed).toBe(true)
    expect(transformed.source).toBe(promotedDefault)
    const resolveInput = new Function(
      'source',
      'entry',
      'base',
      'declaredInput',
      `${transformed.source}
       const defaultInput = [...(source.defaultInput ?? DEFAULT_INPUT)];
       return declaredInput(entry.input) ?? base?.input ?? [...defaultInput]`,
    ) as (
      source: { defaultInput?: string[] },
      entry: { input?: string[] },
      base: { input: string[] } | undefined,
      declaredInput: (input: string[] | undefined) => string[] | undefined,
    ) => string[]
    const declaredInput = (input: string[] | undefined): string[] | undefined => input
    expect(resolveInput({}, {}, undefined, declaredInput)).toEqual(['text', 'image'])
    expect(resolveInput({ defaultInput: ['text'] }, {}, undefined, declaredInput)).toEqual(['text'])
    expect(resolveInput({}, { input: ['text'] }, undefined, declaredInput)).toEqual(['text'])
    expect(resolveInput({}, {}, { input: ['text'] }, declaredInput)).toEqual(['text'])
    expect(promoteCustomProviderImageInput('const DEFAULT_INPUT = ["text", "image"];')).toEqual({
      source: 'const DEFAULT_INPUT = ["text", "image"];',
      changed: false,
    })
    expect(promoteCustomProviderImageInput(transformed.source)).toEqual({ source: transformed.source, changed: false })
  })

  it('transforms only the pi-ai adapter entry through the Node import hook', () => {
    let load: LoadHookSync | undefined
    const register = vi.fn((options: RegisterHooksOptions) => {
      load = options.load
      return { deregister: vi.fn() }
    })
    installCustomProviderImageHook(register)
    expect(load).toBeTypeOf('function')

    const nextLoad = vi.fn(() => ({ format: 'module', source: originalDefault }))
    const context = { conditions: [], format: 'module', importAttributes: {} }
    const target = 'file:///runtime/node_modules/.pnpm/pkg/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'
    const transformed = load?.(target, context, nextLoad)
    expect(transformed?.source).toBe(promotedDefault)

    const unrelated = load?.('file:///runtime/node_modules/other/lib/index.js', context, nextLoad)
    expect(unrelated?.source).toBe(originalDefault)
  })
})
