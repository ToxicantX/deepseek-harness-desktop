import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  injectCustomProviderUserAgentFactorySource,
  installCustomProviderUserAgentHook,
} from '../src/custom-provider-user-agent-injector.ts'
import { installConversationReplayModuleHook } from '../src/conversation-replay-injector.ts'

const originalLoaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__ModuleLoader__')
const originalConversationHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopConversationReplayHook')
const originalHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopCustomProviderUserAgentHook')

const fixtureFactory = `(require) => {
\t\tfunction CustomProviderCard(props) {
\t\t\tconst [baseURL, setBaseURL] = (0, react.useState)("");
\t\t\tconst [protocol, setProtocol] = (0, react.useState)("");
\t\t\tconst createOnce = async () => {
\t\t\t\tconst profile = {
\t\t\t\t\t\tmodels: models.map((model) => ({ ...model }))
\t\t\t\t\t};
\t\t\t};
\t\t\treturn (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tchildren: [
\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\tclassName: ModelsSection_module_css_default["field"],
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["fieldLabel"],
\t\t\t\t\t\t\tchildren: t("customApi")
\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("select", {})]
\t\t\t\t\t})
\t\t\t\t]
\t\t\t});
\t\t}
\t\tfunction ProviderEditor(props) {
\t\t\tconst stringAt = (source, key) => schema.getPath(source, [key]);
\t\t\tconst setField = (key, next) => {
\t\t\t\tconst value = next === void 0 || next.trim().length === 0 ? void 0 : next;
\t\t\t\tsetDraft((current) => value === void 0 ? schema.deletePath(current, [key]) : schema.setPath(current, [key], value));
\t\t\t};
\t\t\tconst curatedFields = (family) => (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\tchildren: [
\t\t\t\t\t\t\tfamily === "deepseek" ? (0, react_jsx_runtime.jsx)(DeepSeekModelsEditor, {}) : null
\t\t\t\t]
\t\t\t});
\t\t}
\t\tconst en = { customApiUnset: "Not selected", };
\t\tconst zh = { customApiUnset: "未选择", };
}`

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as Record<string, unknown>)[name]
  if (descriptor !== undefined) Object.defineProperty(globalThis, name, descriptor)
}

afterEach(() => {
  restoreGlobal('__ModuleLoader__', originalLoaderDescriptor)
  restoreGlobal('__dshDesktopConversationReplayHook', originalConversationHookDescriptor)
  restoreGlobal('__dshDesktopCustomProviderUserAgentHook', originalHookDescriptor)
  vi.restoreAllMocks()
})

describe('custom provider User-Agent injector', () => {
  it('adds the field and persists the header for creation and editing', () => {
    const transformed = injectCustomProviderUserAgentFactorySource(fixtureFactory)

    expect(transformed.changed).toBe(true)
    expect(transformed.source).toContain('customUserAgent: "User-Agent"')
    expect(transformed.source).toContain('const [userAgent, setUserAgent] = (0, react.useState)("");')
    expect(transformed.source).toContain('headers: { "User-Agent": userAgent.trim() }')
    expect(transformed.source).toContain('schema.setPath(updated, ["headers", "User-Agent"], value)')
    expect(transformed.source).toContain('name.toLowerCase() === "user-agent"')
    expect(transformed.source.match(/t\("customUserAgent"\)/g)?.length).toBe(4)
    expect(transformed.source).toContain('value: userAgent')
  })

  it('leaves an incompatible upstream factory unchanged', () => {
    expect(injectCustomProviderUserAgentFactorySource('(require) => ({ apply() {} })')).toEqual({
      source: '(require) => ({ apply() {} })',
      changed: false,
    })
  })

  it('registers a factory transform with the shared ModuleLoader hook', () => {
    expect(installConversationReplayModuleHook()).toBe('installed')
    const serializedInstaller = Function(`return (${installCustomProviderUserAgentHook.toString()})`)() as typeof installCustomProviderUserAgentHook
    expect(serializedInstaller(injectCustomProviderUserAgentFactorySource.toString())).toBe('installed')
    const rawLoad = vi.fn()
    ;(globalThis as any).__ModuleLoader__ = { load: rawLoad }
    const targetFactory = Function(`return (${fixtureFactory})`)()
    ;(globalThis as any).__ModuleLoader__.load({ id: '@deepseek-ai/dsh-client-ui-settings-models', factory: targetFactory })
    const handoff = rawLoad.mock.calls[0]?.[0]
    expect(handoff.factory).not.toBe(targetFactory)
    expect(handoff.factory.toString()).toContain('customUserAgent')
    expect(serializedInstaller(injectCustomProviderUserAgentFactorySource.toString())).toBe('already-installed')
  })
})
