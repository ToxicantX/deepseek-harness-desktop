import { registerHooks, type LoadFnOutput, type ModuleHooks } from 'node:module'

const PI_AI_ENTRY_SUFFIX = '/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js'

export function extractPromptFromContext(context: any): string {
  if (!context || !Array.isArray(context.messages)) return ''
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const msg = context.messages[i]
    if (msg?.role === 'user') {
      if (typeof msg.content === 'string') return msg.content
      if (Array.isArray(msg.content)) {
        const textPart = msg.content.find((p: any) => p?.type === 'text' && typeof p.text === 'string')
        if (textPart) return textPart.text
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
				if (!context || !Array.isArray(context.messages)) return "";
				for (let i = context.messages.length - 1; i >= 0; i--) {
					const msg = context.messages[i];
					if (msg?.role === "user") {
						if (typeof msg.content === "string") return msg.content;
						if (Array.isArray(msg.content)) {
							const textPart = msg.content.find((p) => p?.type === "text" && typeof p.text === "string");
							if (textPart) return textPart.text;
						}
					}
				}
				return "";
			})();

			const startMessage = {
				role: "assistant",
				content: [],
				usage: { input: 0, output: 0, totalTokens: 0 }
			};
			yield { type: "start", partial: startMessage };

			const rawBase = (model.baseUrl || model.provider?.baseURL || "").trim();
			const base = rawBase.replace(/\\/+$/, "");
			const url = base.endsWith("/v1") ? (base + "/images/generations") : (base ? base + "/v1/images/generations" : "/v1/images/generations");
			
			const apiKey = options?.apiKey || model.provider?.apiKey || "";
			const headers = {
				"content-type": "application/json",
				...(apiKey ? { "authorization": "Bearer " + apiKey } : {}),
				...(options?.headers || {})
			};

			const body = JSON.stringify({
				model: model.id,
				prompt: prompt,
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
					} catch {}
					yield {
						type: "error",
						error: {
							message: "生图接口请求失败 (" + res.status + "): " + errMsg,
							stopReason: "error",
							usage: { input: 0, output: 0, totalTokens: 0 }
						}
					};
					return;
				}
				const json = await res.json();
				const images = Array.isArray(json.data) ? json.data : (Array.isArray(json.images) ? json.images : []);
				if (images.length === 0) {
					yield {
						type: "error",
						error: {
							message: "生图模型未返回图像数据",
							stopReason: "error",
							usage: { input: 0, output: 0, totalTokens: 0 }
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
						stopReason: "stop",
						usage: { input: 0, output: 0, totalTokens: 0 }
					}
				};
			} catch (err) {
				if (options?.signal?.aborted) {
					yield {
						type: "error",
						error: {
							message: "Aborted",
							stopReason: "aborted",
							usage: { input: 0, output: 0, totalTokens: 0 }
						}
					};
					return;
				}
				yield {
					type: "error",
					error: {
						message: "生图请求异常: " + (err?.message || String(err)),
						stopReason: "error",
						usage: { input: 0, output: 0, totalTokens: 0 }
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
  const injectedApiDefinition = `${OPENAI_IMAGE_GENERATIONS_API_SOURCE}\nconst PROTOCOLS = {\n\t"openai-image-generations": openAIImageGenerationsApi,`
  transformed = transformed.replace(protocolsSearch, injectedApiDefinition)

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
