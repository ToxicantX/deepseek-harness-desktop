export interface CustomProviderMultimediaTransform {
  source: string
  changed: boolean
}

export function injectCustomProviderMultimediaFactorySource(source: string): CustomProviderMultimediaTransform {
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

  // 1. Add translations for protocol and output types in en and zh locales
  const enAnchor = 'customApiUnset: "Not selected",'
  const enInsertion = `customApiUnset: "Not selected",
			protocolOpenAiImages: "OpenAI Image Generations",
			modelOutputTypes: "Output modalities",
			modelOutputImage: "Image",
			modelOutputAudio: "Audio",
			modelOutputVideo: "Video",`

  const zhAnchor = 'customApiUnset: "未选择",'
  const zhInsertion = `customApiUnset: "未选择",
			protocolOpenAiImages: "OpenAI 图像生成",
			modelOutputTypes: "输出类型",
			modelOutputImage: "图片",
			modelOutputAudio: "音频",
			modelOutputVideo: "视频",`

  const enChanged = replace(transformed, enAnchor, enInsertion)
  if (enChanged === undefined) return { source, changed: false }
  transformed = enChanged

  const zhChanged = replace(transformed, zhAnchor, zhInsertion)
  if (zhChanged === undefined) return { source, changed: false }
  transformed = zhChanged

  // 2. Extend PROTOCOL_LABEL_KEYS
  const protocolKeysSearch = 'protocolOpenAiCompletions",'
  const protocolKeysReplace = `protocolOpenAiCompletions",
			"openai-image-generations": "protocolOpenAiImages",`
  const protoKeysChanged = replace(transformed, protocolKeysSearch, protocolKeysReplace)
  if (protoKeysChanged === undefined) return { source, changed: false }
  transformed = protoKeysChanged

  // 3. Extend protocolChoices to include "openai-image-generations"
  const protocolChoicesSearch = 'return list.list.map((entry) => entry.value).filter((value) => typeof value === "string");'
  const protocolChoicesReplace = `const items = list.list.map((entry) => entry.value).filter((value) => typeof value === "string");
			if (!items.includes("openai-image-generations")) items.push("openai-image-generations");
			return items;`
  const choicesChanged = replaceInFunction(transformed, 'protocolChoices', protocolChoicesSearch, protocolChoicesReplace)
  if (choicesChanged === undefined) return { source, changed: false }
  transformed = choicesChanged

  // 4. Inject ModelOutputTypes component after ModelInputTypes
  const modelInputEnd = `				})]
			});
		}
		//#endregion`
  const modelOutputComponent = `				})]
			});
		}
		function ModelOutputTypes({ model, field, position, disabled, t, onChange }) {
			const fieldKey = field || "outputModalities";
			const modalities = Array.isArray(model[fieldKey]) ? model[fieldKey] : [];
			const choices = [
				{ id: "image", labelKey: "modelOutputImage" },
				{ id: "audio", labelKey: "modelOutputAudio" },
				{ id: "video", labelKey: "modelOutputVideo" }
			];
			return (0, react_jsx_runtime.jsxs)("fieldset", {
				className: ModelsSection_module_css_default["modelInputTypes"],
				"aria-label": t("modelOutputTypes") + " " + String(position),
				children: [(0, react_jsx_runtime.jsx)("legend", {
					className: ModelsSection_module_css_default["modelFieldLabel"],
					children: t("modelOutputTypes")
				}), (0, react_jsx_runtime.jsx)("div", {
					className: ModelsSection_module_css_default["modelInputChoices"],
					children: choices.map((choice) => (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
						label: t(choice.labelKey),
						checked: modalities.includes(choice.id),
						disabled: disabled,
						onChange: (checked) => {
							const nextModalities = checked
								? (modalities.includes(choice.id) ? modalities : [...modalities, choice.id])
								: modalities.filter((id) => id !== choice.id);
							const next = {
								...model,
								[fieldKey]: nextModalities
							};
							onChange(next);
						}
					}, choice.id))
				})]
			});
		}
		//#endregion`

  const componentInjected = replace(transformed, modelInputEnd, modelOutputComponent)
  if (componentInjected === undefined) return { source, changed: false }
  transformed = componentInjected

  // 5. In ModelRow, place ModelOutputTypes right after ModelInputTypes
  const modelRowRenderInput = `(0, react_jsx_runtime.jsx)(ModelInputTypes, {
						model,
						field: props.inputField,
						position,
						fallback: props.inputFallback,
						disabled: disabled || props.inputLoading === true,
						t,
						onChange: props.onChange
					})`
  const modelRowRenderOutput = `(0, react_jsx_runtime.jsx)(ModelInputTypes, {
						model,
						field: props.inputField,
						position,
						fallback: props.inputFallback,
						disabled: disabled || props.inputLoading === true,
						t,
						onChange: props.onChange
					}), (0, react_jsx_runtime.jsx)(ModelOutputTypes, {
						model,
						field: "outputModalities",
						position,
						disabled,
						t,
						onChange: props.onChange
					})`

  const modelRowInjected = replaceInFunction(transformed, 'ModelRow', modelRowRenderInput, modelRowRenderOutput)
  if (modelRowInjected === undefined) return { source, changed: false }
  transformed = modelRowInjected

  return { source: transformed, changed: true }
}

export function installCustomProviderMultimediaHook(transformSource: string): string {
  const globalObject = globalThis as any
  const hookKey = '__dshDesktopCustomProviderMultimediaHook'
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
        console.error('桌面壳多媒体模型设置注入失败', error)
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
    console.error('桌面壳多媒体模型设置注入失败', error)
    return 'registration-failed'
  }
}
