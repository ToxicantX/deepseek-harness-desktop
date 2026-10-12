import { describe, expect, it } from 'vitest'
import {
  injectCustomProviderMultimediaFactorySource,
  installCustomProviderMultimediaHook,
} from '../src/custom-provider-multimedia-injector.ts'

describe('custom-provider-multimedia-injector', () => {
  const sampleModuleSource = "\n\t\tfunction protocolChoices(namespace, schema) {\n\t\t\tif (namespace === void 0) return [];\n\t\t\tconst list = schema.nodeAtPath(schema.rehydrate(namespace.schema), [\"providers\", PROBE_ROUTE, \"api\"]);\n\t\t\tif (list?.type !== \"union\" || list.list === void 0) return [];\n\t\t\treturn list.list.map((entry) => entry.value).filter((value) => typeof value === \"string\");\n\t\t}\n\t\tconst PROTOCOL_LABEL_KEYS = {\n\t\t\t\"openai-completions\": \"protocolOpenAiCompletions\",\n\t\t\t\"openai-responses\": \"protocolOpenAiResponses\",\n\t\t\t\"anthropic-messages\": \"protocolAnthropicMessages\"\n\t\t};\n\t\tfunction ModelInputTypes({ model, field, position, disabled, fallback, t, onChange }) {\n\t\t\treturn (0, react_jsx_runtime.jsxs)(\"fieldset\", {\n\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)(\"div\", {\n\t\t\t\t\tchildren: []\n\t\t\t\t})]\n\t\t\t});\n\t\t}\n\t\t//#endregion\n\t\tfunction ModelRow(props) {\n\t\t\tconst { model, position, t, disabled } = props;\n\t\t\treturn (0, react_jsx_runtime.jsxs)(\"div\", {\n\t\t\t\tchildren: [\n\t\t\t\t\t(0, react_jsx_runtime.jsx)(ModelInputTypes, {\n\t\t\t\t\t\tmodel,\n\t\t\t\t\t\tfield: props.inputField,\n\t\t\t\t\t\tposition,\n\t\t\t\t\t\tfallback: props.inputFallback,\n\t\t\t\t\t\tdisabled: disabled || props.inputLoading === true,\n\t\t\t\t\t\tt,\n\t\t\t\t\t\tonChange: props.onChange\n\t\t\t\t\t})\n\t\t\t\t]\n\t\t\t});\n\t\t}\n\t\tconst en = {\n\t\t\tcustomApiUnset: \"Not selected\",\n\t\t\tprotocolOpenAiCompletions: \"OpenAI Chat Completions\",\n\t\t\totherKey: \"Other\"\n\t\t};\n\t\tconst zh = {\n\t\t\tcustomApiUnset: \"未选择\",\n\t\t\tprotocolOpenAiCompletions: \"OpenAI Chat Completions\",\n\t\t\totherKey: \"其他\"\n\t\t};\n"

  it('transforms module source to inject protocol and output modalities', () => {
    const result = injectCustomProviderMultimediaFactorySource(sampleModuleSource)
    expect(result.changed).toBe(true)
    expect(result.source).toContain('openai-image-generations')
    expect(result.source).toContain('protocolOpenAiImages')
    expect(result.source).toContain('ModelOutputTypes')
    expect(result.source).toContain('OpenAI Image Generations')
    expect(result.source).toContain('OpenAI 图像生成')
    expect(result.source).toContain('outputModalities')
  })

  it('handles source that does not match expected patterns gracefully', () => {
    const result = injectCustomProviderMultimediaFactorySource('function notMatching() {}')
    expect(result.changed).toBe(false)
    expect(result.source).toBe('function notMatching() {}')
  })

  it('prevents duplicate hook registration with guard key', () => {
    const g = globalThis as any
    g.__dshDesktopCustomProviderMultimediaHook = { version: 1 }
    const status = installCustomProviderMultimediaHook('() => {}')
    expect(status).toBe('already-installed')
    delete g.__dshDesktopCustomProviderMultimediaHook
  })
})
