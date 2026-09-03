export interface CustomProviderUserAgentTransform {
  source: string
  changed: boolean
}

export function injectCustomProviderUserAgentFactorySource(source: string): CustomProviderUserAgentTransform {
  const replace = (input: string, search: string, replacement: string): string | undefined => {
    const index = input.indexOf(search)
    if (index < 0) return undefined
    return input.slice(0, index) + replacement + input.slice(index + search.length)
  }
  const replaceInFunction = (input: string, name: string, search: string, replacement: string): string | undefined => {
    const start = input.indexOf(`function ${name}`)
    if (start < 0) return undefined
    const next = input.indexOf('\n\t\tfunction ', start + name.length)
    const end = next < 0 ? input.length : next
    const body = input.slice(start, end)
    const changed = replace(body, search, replacement)
    return changed === undefined ? undefined : input.slice(0, start) + changed + input.slice(end)
  }

  let transformed = source
  const replacements: Array<[string, string]> = [
    ['customApiUnset: "Not selected",', 'customApiUnset: "Not selected",\n\t\t\tcustomUserAgent: "User-Agent",'],
    ['customApiUnset: "未选择",', 'customApiUnset: "未选择",\n\t\t\tcustomUserAgent: "User-Agent",'],
  ]
  for (const [search, replacement] of replacements) {
    const changed = replace(transformed, search, replacement)
    if (changed === undefined) return { source, changed: false }
    transformed = changed
  }

  const creationState = replaceInFunction(
    transformed,
    'CustomProviderCard',
    '\t\t\tconst [baseURL, setBaseURL] = (0, react.useState)("");\n\t\t\tconst [protocol, setProtocol]',
    '\t\t\tconst [baseURL, setBaseURL] = (0, react.useState)("");\n\t\t\tconst [userAgent, setUserAgent] = (0, react.useState)("");\n\t\t\tconst [protocol, setProtocol]',
  )
  if (creationState === undefined) return { source, changed: false }
  transformed = creationState

  const creationProfile = replaceInFunction(
    transformed,
    'CustomProviderCard',
    '\t\t\t\t\t\tmodels: models.map((model) => ({ ...model }))\n\t\t\t\t\t};',
    '\t\t\t\t\t\tmodels: models.map((model) => ({ ...model })),\n\t\t\t\t\t\t...userAgent.trim().length === 0 ? {} : { headers: { "User-Agent": userAgent.trim() } }\n\t\t\t\t\t};',
  )
  if (creationProfile === undefined) return { source, changed: false }
  transformed = creationProfile

  const creationApiField = `\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\tclassName: ModelsSection_module_css_default["field"],
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["fieldLabel"],
\t\t\t\t\t\t\tchildren: t("customApi")`
  const creationUserAgentField = `\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\tclassName: ModelsSection_module_css_default["field"],
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["fieldLabel"],
\t\t\t\t\t\t\tchildren: t("customUserAgent")
\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("input", {
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["input"],
\t\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\t\tvalue: userAgent,
\t\t\t\t\t\t\tplaceholder: "User-Agent",
\t\t\t\t\t\t\t"aria-label": t("customUserAgent"),
\t\t\t\t\t\t\tdisabled: profileDisabled,
\t\t\t\t\t\t\tonChange: (event) => {
\t\t\t\t\t\t\t\tsetUserAgent(event.target.value);
\t\t\t\t\t\t\t}
\t\t\t\t\t\t})]
\t\t\t\t\t}),
\t\t\t\t\t`
  const creationField = replaceInFunction(transformed, 'CustomProviderCard', creationApiField, creationUserAgentField + creationApiField)
  if (creationField === undefined) return { source, changed: false }
  transformed = creationField

  const editorState = `\t\t\tconst setField = (key, next) => {
\t\t\t\tconst value = next === void 0 || next.trim().length === 0 ? void 0 : next;
\t\t\t\tsetDraft((current) => value === void 0 ? schema.deletePath(current, [key]) : schema.setPath(current, [key], value));
\t\t\t};`
  const editorUserAgentState = `${editorState}
\t\t\tconst userAgentEntry = (value) => Object.entries(schema.getPath(value, ["headers"]) ?? {}).find(([name]) => name.toLowerCase() === "user-agent");
\t\t\tconst userAgent = typeof userAgentEntry(draft)?.[1] === "string" ? userAgentEntry(draft)[1] : "";
\t\t\tconst setUserAgent = (next) => {
\t\t\t\tconst value = next.trim().length === 0 ? void 0 : next;
\t\t\t\tsetDraft((current) => {
\t\t\t\t\tlet updated = current;
\t\t\t\t\tfor (const name of Object.keys(schema.getPath(updated, ["headers"]) ?? {})) if (name.toLowerCase() === "user-agent") updated = schema.deletePath(updated, ["headers", name]);
\t\t\t\t\treturn value === void 0 ? updated : schema.setPath(updated, ["headers", "User-Agent"], value);
\t\t\t\t});
\t\t\t};`
  const editorStateChanged = replaceInFunction(transformed, 'ProviderEditor', editorState, editorUserAgentState)
  if (editorStateChanged === undefined) return { source, changed: false }
  transformed = editorStateChanged

  const editorModels = '\t\t\t\t\t\t\tfamily === "deepseek" ? (0, react_jsx_runtime.jsx)(DeepSeekModelsEditor, {'
  const editorUserAgentField = `\t\t\t\t\t\t\townsIdentity ? (0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["field"],
\t\t\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["fieldLabel"],
\t\t\t\t\t\t\t\t\tchildren: t("customUserAgent")
\t\t\t\t\t\t\t\t}), (0, react_jsx_runtime.jsx)("input", {
\t\t\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["input"],
\t\t\t\t\t\t\t\t\ttype: "text",
\t\t\t\t\t\t\t\t\tvalue: userAgent,
\t\t\t\t\t\t\t\t\tplaceholder: "User-Agent",
\t\t\t\t\t\t\t\t\t"aria-label": t("customUserAgent"),
\t\t\t\t\t\t\t\t\tdisabled,
\t\t\t\t\t\t\t\t\tonChange: (event) => {
\t\t\t\t\t\t\t\t\t\tsetUserAgent(event.target.value);
\t\t\t\t\t\t\t\t\t}
\t\t\t\t\t\t\t\t})]
\t\t\t\t\t\t\t}) : null,
`
  const editorField = replaceInFunction(transformed, 'ProviderEditor', editorModels, editorUserAgentField + editorModels)
  if (editorField === undefined) return { source, changed: false }
  return { source: editorField, changed: true }
}

export function installCustomProviderUserAgentHook(transformSource: string): string {
  const globalObject = globalThis as any
  const hookKey = '__dshDesktopCustomProviderUserAgentHook'
  if (globalObject[hookKey]?.version === 1) return 'already-installed'
  const loaderHook = globalObject.__dshDesktopConversationReplayHook
  if (typeof loaderHook?.registerModuleFactoryTransform !== 'function') return 'loader-hook-unavailable'
  try {
    const transform = Function(`return (${transformSource})`)()
    const registered = loaderHook.registerModuleFactoryTransform('@deepseek-ai/dsh-client-ui-settings-models', (factory: Function) => {
      const result = transform(Function.prototype.toString.call(factory))
      if (result?.changed !== true || typeof result.source !== 'string') return factory
      try {
        const rebuilt = Function(`return (${result.source})`)()
        return typeof rebuilt === 'function' ? rebuilt : factory
      } catch (error) {
        console.error('桌面壳自定义提供方 User-Agent 注入失败', error)
        return factory
      }
    })
    if (registered !== true) return 'registration-failed'
    Object.defineProperty(globalObject, hookKey, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: Object.freeze({ version: 1 }),
    })
    return 'installed'
  } catch (error) {
    console.error('桌面壳自定义提供方 User-Agent 注入失败', error)
    return 'registration-failed'
  }
}
