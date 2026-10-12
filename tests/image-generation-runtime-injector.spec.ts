import { describe, expect, it } from 'vitest'
import {
  extractPromptFromContext,
  resolveImageGenerationUrl,
  buildImageMarkdown,
  normalizeImageResponse,
  promoteImageGenerationRuntimeInput,
} from '../src/image-generation-runtime-injector.ts'

describe('image-generation-runtime-injector', () => {
  it('extracts prompt from user context message', () => {
    const context = {
      messages: [
        { role: 'system', content: 'You are an artist.' },
        { role: 'user', content: 'Draw a cute koi fish.' }
      ]
    }
    expect(extractPromptFromContext(context)).toBe('Draw a cute koi fish.')
  })

  it('extracts prompt from multipart content', () => {
    const context = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'A futuristic city' }
          ]
        }
      ]
    }
    expect(extractPromptFromContext(context)).toBe('A futuristic city')
  })

  it('resolves correct images generation URLs', () => {
    expect(resolveImageGenerationUrl('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/images/generations')
    expect(resolveImageGenerationUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/images/generations')
    expect(resolveImageGenerationUrl('https://api.example.com')).toBe('https://api.example.com/v1/images/generations')
  })

  it('builds image markdown from b64 and url correctly', () => {
    expect(buildImageMarkdown({ url: 'https://example.com/koi.png' }, 'koi'))
      .toBe('![koi](https://example.com/koi.png)')
    expect(buildImageMarkdown({ b64_json: 'abcd123' }, 'koi'))
      .toBe('![koi](data:image/png;base64,abcd123)')
  })

  it('normalizes image response data', () => {
    const data = {
      data: [
        { url: 'https://img.com/1.png' },
        { b64_json: 'abc' }
      ]
    }
    const md = normalizeImageResponse(data, 'test prompt')
    expect(md).toContain('![test prompt](https://img.com/1.png)')
    expect(md).toContain('![test prompt](data:image/png;base64,abc)')
  })

  it('transforms pi-ai index source to inject openai-image-generations protocol', () => {
    const samplePiAi = 'const PROTOCOLS = {\n\t"openai-completions": openAICompletionsApi,\n};'
    const result = promoteImageGenerationRuntimeInput(samplePiAi)
    expect(result.changed).toBe(true)
    expect(result.source).toContain('openai-image-generations')
    expect(result.source).toContain('openAIImageGenerationsApi')
  })
})
