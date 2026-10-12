import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'

const PI_AI_ENTRY_SUFFIX = '/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'

export function extractPromptFromContext(context: any): string {
  if (!context) return ''
  const msgs = Array.isArray(context.messages) ? context.messages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    if (msg?.role === 'user') {
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
          .map((p: any) => p.text)
        if (textParts.length > 0) return textParts.join('\n')
      }
    }
  }
  return ''
}

export function resolveImageGenerationUrl(baseURL: string): string {
  const trimmed = (baseURL || '').trim()
  if (!trimmed) return '/v1/images/generations'
  const normalized = trimmed.replace(/\/+$/, '')
  if (normalized.endsWith('/v1')) {
    return `${normalized}/images/generations`
  }
  return `${normalized}/v1/images/generations`
}

export function buildImageMarkdown(imageData: { url?: string; b64_json?: string; revised_prompt?: string }, prompt: string): string {
  const alt = (imageData.revised_prompt || prompt || 'Generated Image').replace(/[\[\]]/g, '').trim()
  if (imageData.b64_json) {
    const src = imageData.b64_json.startsWith('data:') ? imageData.b64_json : `data:image/png;base64,${imageData.b64_json}`
    return `![${alt}](${src})`
  }
  if (imageData.url) {
    return `![${alt}](${imageData.url})`
  }
  return '![${alt}]()'
}

export function normalizeImageResponse(data: any, prompt: string): string {
  if (!data) return ''
  const images = Array.isArray(data.data) ? data.data : (Array.isArray(data.images) ? data.images : [])
  if (images.length === 0) {
    if (typeof data.error?.message === 'string') {
      return `生图失败: ${data.error.message}`
    }
    return ''
  }
  return images.map((item: any) => buildImageMarkdown(item, prompt)).join('\n\n')
}

export const OPENAI_IMAGE_GENERATIONS_API_SOURCE = `
const openAIImageGenerationsApi = {
	stream: (model, context, options) => openAIImageGenerationsApi.streamSimple(model, context, options),
	streamSimple: (model, context, options) => {
		async function* generator() {
			const prompt = (() => {
				if (!context) return "";
				const msgs = Array.isArray(context.messages) ? context.messages : [];
				for (let i = msgs.length - 1; i >= 0; i--) {
					const msg = msgs[i];
					if (msg?.role === "user") {
						if (typeof msg.content === "string") return msg.content;
						if (Array.isArray(msg.content)) {
							const textParts = msg.content
								.filter((p) => p?.type === "text" && typeof p.text === "string")
								.map((p) => p.text);
							if (textParts.length > 0) return textParts.join("\\n");
						}
					}
				}
				return "";
			})();

			const startMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending",
				timestamp: Date.now()
			};
			yield { type: "start", partial: startMessage };

			const rawBase = (model.baseUrl || model.baseURL || model.provider?.baseURL || "").trim();
			const base = rawBase.replace(/\\/+$/, "");
			const url = base.endsWith("/v1") ? (base + "/images/generations") : (base ? base + "/v1/images/generations" : "/v1/images/generations");
			
			const apiKey = options?.apiKey || model.apiKey || model.provider?.apiKey || "";
			const customHeaders = options?.headers || model.headers || {};
			const headers = {
				"content-type": "application/json",
				...(apiKey ? { "authorization": "Bearer " + apiKey } : {}),
				...customHeaders
			};

			const isAgnes = model.id.toLowerCase().includes("agnes") || base.toLowerCase().includes("agnes");
			const body = isAgnes
				? JSON.stringify({
						model: model.id,
						prompt: prompt,
						size: "1024x1024",
						return_base64: true,
						extra_body: {
							response_format: "b64_json"
						}
				  })
				: JSON.stringify({
						model: model.id,
						prompt: prompt,
						size: "1024x1024",
						n: 1,
						response_format: "b64_json"
				  });

			try {
				const res = await fetch(url, {
					method: "POST",
					headers,
					body,
					signal: options?.signal
				});
				if (!res.ok) {
					const errText = await res.text();
					let errMsg = errText;
					try {
						const parsed = JSON.parse(errText);
						if (parsed.error?.message) errMsg = parsed.error.message;
						else if (parsed.message) errMsg = parsed.message;
					} catch {}
					const formattedErr = "生图接口请求失败 (" + res.status + "): " + errMsg;
					yield { type: "text_start", contentIndex: 0 };
					yield { type: "text_delta", contentIndex: 0, delta: formattedErr };
					yield { type: "text_end", contentIndex: 0, content: formattedErr };
					yield {
						type: "done",
						message: {
							role: "assistant",
							content: [{ type: "text", text: formattedErr }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							stopReason: "stop",
							usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							timestamp: Date.now()
						}
					};
					return;
				}
				const json = await res.json();
				const images = Array.isArray(json.data) ? json.data : (Array.isArray(json.images) ? json.images : []);
				if (images.length === 0) {
					const noImageMsg = "生图模型未返回图像数据";
					yield { type: "text_start", contentIndex: 0 };
					yield { type: "text_delta", contentIndex: 0, delta: noImageMsg };
					yield { type: "text_end", contentIndex: 0, content: noImageMsg };
					yield {
						type: "done",
						message: {
							role: "assistant",
							content: [{ type: "text", text: noImageMsg }],
							api: model.api,
							provider: model.provider,
							model: model.id,
							stopReason: "stop",
							usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							timestamp: Date.now()
						}
					};
					return;
				}
				const markdown = images.map((item) => {
					const alt = (item.revised_prompt || prompt || "Generated Image").replace(/[\\[\\]]/g, "").trim();
					if (item.b64_json) {
						const src = item.b64_json.startsWith("data:") ? item.b64_json : "data:image/png;base64," + item.b64_json;
						return "![" + alt + "](" + src + ")";
					}
					if (item.url) {
						return "![" + alt + "](" + item.url + ")";
					}
					return "![" + alt + "]()";
				}).join("\\n\\n");

				yield { type: "text_start", contentIndex: 0 };
				yield { type: "text_delta", contentIndex: 0, delta: markdown };
				yield { type: "text_end", contentIndex: 0, content: markdown };
				yield {
					type: "done",
					message: {
						role: "assistant",
						content: [{ type: "text", text: markdown }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
						usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						timestamp: Date.now()
					}
				};
			} catch (err) {
				if (options?.signal?.aborted) {
					yield {
						type: "error",
						error: {
							role: "assistant",
							content: [],
							api: model.api,
							provider: model.provider,
							model: model.id,
							errorMessage: "Aborted",
							stopReason: "aborted",
							usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
							timestamp: Date.now()
						}
					};
					return;
				}
				const errText = "生图请求异常: " + (err?.message || String(err));
				yield { type: "text_start", contentIndex: 0 };
				yield { type: "text_delta", contentIndex: 0, delta: errText };
				yield { type: "text_end", contentIndex: 0, content: errText };
				yield {
					type: "done",
					message: {
						role: "assistant",
						content: [{ type: "text", text: errText }],
						api: model.api,
						provider: model.provider,
						model: model.id,
						stopReason: "stop",
						usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
						timestamp: Date.now()
					}
				};
			}
		}
		return generator();
	}
};
`

export interface ImageGenerationRuntimeTransform {
  source: string
  changed: boolean
}

export function promoteImageGenerationRuntimeInput(source: string): ImageGenerationRuntimeTransform {
  const protocolsSearch = 'const PROTOCOLS = {'
  if (!source.includes(protocolsSearch)) return { source, changed: false }

  let transformed = source
  const injectedApiDefinition = `${OPENAI_IMAGE_GENERATIONS_API_SOURCE}\nconst PROTOCOLS = {\n\t"openai-image-generations": () => openAIImageGenerationsApi,`
  transformed = transformed.replace(protocolsSearch, injectedApiDefinition)

  const listableSearch = 'const LISTABLE_PROTOCOLS = new Set(['
  if (transformed.includes(listableSearch)) {
    const injectedListable = `const LISTABLE_PROTOCOLS = new Set([\n\t"openai-image-generations",`
    transformed = transformed.replace(listableSearch, injectedListable)
  }

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

export function installImageGenerationRuntimeHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!isPiAiEntry(url)) return loaded
      const source = sourceText(loaded.source)
      if (source === undefined) return loaded
      const transformed = promoteImageGenerationRuntimeInput(source)
      return transformed.changed ? { ...loaded, source: transformed.source } : loaded
    },
  })
}
