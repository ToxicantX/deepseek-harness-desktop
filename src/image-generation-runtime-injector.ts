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
						let raw = "";
						if (typeof msg.content === "string") raw = msg.content;
						else if (Array.isArray(msg.content)) {
							const textParts = msg.content
								.filter((p) => p?.type === "text" && typeof p.text === "string")
								.map((p) => p.text);
							if (textParts.length > 0) raw = textParts.join("\\n");
						}
						if (raw) {
							const cleaned = raw.replace(new RegExp("<system-reminder>[\\s\\S]*?</system-reminder>", "gi"), "").trim();
							return cleaned || raw.trim();
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

			const headerAdminKey = (customHeaders && (customHeaders["x-sub2api-admin-key"] || customHeaders["X-Sub2API-Admin-Key"])) || "";
			const envAdminKey = (typeof process !== "undefined" && process.env && (process.env.SUB2API_ADMIN_KEY || process.env.X_SUB2API_ADMIN_KEY)) || "";
			const sub2apiAdminKey = String(headerAdminKey || envAdminKey || "").trim();
			let targetUrl = url;
			let upstreamApiKey = apiKey;
			let bridgeHint = "";

			const isAgnes = model.id.toLowerCase().includes("agnes") || base.toLowerCase().includes("agnes");
			const isVideoModel = model.id.toLowerCase().includes("video") || model.id.toLowerCase().includes("v2.0");
			const isSub2apiTarget = base.toLowerCase().includes("pickstar.asia") || headerAdminKey !== "" || (isAgnes && base.toLowerCase().includes("subapi.pickstar.asia"));
			if (isSub2apiTarget) {
				if (!sub2apiAdminKey) {
					if (isAgnes) bridgeHint = "提示: 未配置 Sub2API 管理 Key, 将直连请求; 如需自动调度生图上游, 请在自定义模型配置中填写 Sub2API 管理 Key。";
				} else {
					try {
						const adminBase = (() => {
							try { return new URL(base).origin; } catch { return base.replace(/\\/v1\\/?$/, ""); }
						})();
						const adminHeaders = { "x-api-key": sub2apiAdminKey };
						const grpRes = await fetch(adminBase + "/api/v1/admin/groups?page_size=100", { headers: adminHeaders, signal: options?.signal });
						const grpJson = await grpRes.json().catch(() => null);
						const groups = Array.isArray(grpJson?.data?.items) ? grpJson.data.items : (Array.isArray(grpJson?.items) ? grpJson.items : (Array.isArray(grpJson?.data) ? grpJson.data : []));
						const modelLower = String(model.id || "").toLowerCase();
						const matchedGroup = groups.find((g) => {
							const name = String(g?.name || "").toLowerCase();
							const groupModels = Array.isArray(g?.models) ? g.models.map((m) => String(m).toLowerCase()) : [];
							return groupModels.includes(modelLower) || (isAgnes && (name.includes("agnes") || name.includes("agnes-ai")));
						}) || null;
						if (matchedGroup) {
							const accRes = await fetch(adminBase + "/api/v1/admin/accounts?page_size=200", { headers: adminHeaders, signal: options?.signal });
							const accJson = await accRes.json().catch(() => null);
							const accounts = Array.isArray(accJson?.data?.items) ? accJson.data.items : (Array.isArray(accJson?.items) ? accJson.items : (Array.isArray(accJson?.data) ? accJson.data : []));
							const gid = matchedGroup?.id ?? matchedGroup?.group_id;
							const candidates = accounts.filter((a) => {
								const gids = Array.isArray(a?.group_ids) ? a.group_ids.map((id) => String(id)) : (Array.isArray(a?.groups) ? a.groups.map((g) => String(g?.id ?? g)) : []);
								const isMatch = gids.includes(String(gid)) || String(a?.group_id ?? a?.group ?? "") === String(gid ?? "");
								return isMatch && (a?.status === "active" || a?.enabled === true);
							});
							const candidate = candidates.find((a) => {
								const k = a?.credentials?.api_key || a?.credentials?.apiKey || a?.api_key || (typeof a?.notes === "string" ? a.notes.trim() : "");
								return k && k.length > 10;
							}) || candidates[0] || null;
							const creds = candidate?.credentials || {};
							const notesKey = typeof candidate?.notes === "string" && candidate.notes.trim().length > 0 ? candidate.notes.trim() : "";
							const resolvedUpstreamKey = creds.api_key || creds.apiKey || candidate?.api_key || notesKey || "";
							if (resolvedUpstreamKey) {
								upstreamApiKey = String(resolvedUpstreamKey);
								const ub = String(candidate?.base_url || creds.base_url || "").replace(/\\/+$/, "");
								if (ub) {
									const originBase = ub.endsWith("/v1") ? ub : (ub + "/v1");
									targetUrl = isVideoModel ? (originBase + "/videos") : (originBase + "/images/generations");
								} else if (isAgnes) {
									targetUrl = isVideoModel ? "https://apihub.agnes-ai.com/v1/videos" : "https://apihub.agnes-ai.com/v1/images/generations";
								}
							}
						}
					} catch (bridgeErr) {
						bridgeHint = "";
					}
				}
			}
			const bridged = targetUrl !== url;
			const isVideoTarget = targetUrl.endsWith("/videos") || isVideoModel;
			const body = isVideoTarget
				? JSON.stringify({
						model: model.id.includes("agnes-video") ? "agnes-video-2.5" : model.id,
						prompt: prompt,
						seconds: "4",
						mode: "text",
						size: "720P",
						aspect_ratio: "16:9"
				  })
				: (bridged && isAgnes
				? JSON.stringify({
						model: "agnes-image-2.5-flash",
						prompt: prompt,
						size: "1024x1024"
				  })
				: isAgnes
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
				  }));

			try {
				if (bridgeHint) {
					yield { type: "text_start", contentIndex: 0 };
					yield { type: "text_delta", contentIndex: 0, delta: bridgeHint };
					yield { type: "text_end", contentIndex: 0, content: bridgeHint };
				}
				const reqHeaders = { ...headers };
				if (upstreamApiKey) reqHeaders["authorization"] = "Bearer " + upstreamApiKey;
				const res = await fetch(targetUrl, {
					method: "POST",
					headers: reqHeaders,
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
					const formattedErr = (isVideoTarget ? "视频生成接口请求失败 (" : "生图接口请求失败 (") + res.status + "): " + errMsg;
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
				if (isVideoTarget) {
					const videoId = json.video_id || json.id || json.task_id;
					if (!videoId) {
						const noVideoIdMsg = "视频任务创建成功但未返回有效任务 ID";
						yield { type: "text_start", contentIndex: 0 };
						yield { type: "text_delta", contentIndex: 0, delta: noVideoIdMsg };
						yield { type: "text_end", contentIndex: 0, content: noVideoIdMsg };
						yield {
							type: "done",
							message: {
								role: "assistant",
								content: [{ type: "text", text: noVideoIdMsg }],
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
					let progressHint = "🎬 视频生成任务已提交 (ID: " + videoId + ")，正在生成中...";
					yield { type: "text_start", contentIndex: 0 };
					yield { type: "text_delta", contentIndex: 0, delta: progressHint };
					yield { type: "text_end", contentIndex: 0, content: progressHint };
					const pollQueryUrl = (() => {
						try {
							const u = new URL(targetUrl);
							return u.origin + "/agnesapi?video_id=" + encodeURIComponent(videoId) + "&model_name=" + encodeURIComponent(json.model || "agnes-video-2.5");
						} catch {
							return "https://apihub.agnes-ai.com/agnesapi?video_id=" + encodeURIComponent(videoId) + "&model_name=" + encodeURIComponent(json.model || "agnes-video-2.5");
						}
					})();
					let finalVideoUrl = "";
					const maxPollCount = 120;
					let pollCount = 0;
					let lastProgress = 0;
					while (pollCount < maxPollCount) {
						await new Promise((r) => setTimeout(r, 2000));
						if (options?.signal?.aborted) return;
						pollCount++;
						try {
							const qRes = await fetch(pollQueryUrl, {
								headers: reqHeaders,
								signal: options?.signal
							});
							if (!qRes.ok) continue;
							const qJson = await qRes.json();
							const p = typeof qJson.progress === "number" ? qJson.progress : lastProgress;
							if (p > lastProgress) {
								lastProgress = p;
								const deltaP = "\\n> ⏳ 渲染进度: " + String(p) + "%";
								yield { type: "text_start", contentIndex: 0 };
								yield { type: "text_delta", contentIndex: 0, delta: deltaP };
								yield { type: "text_end", contentIndex: 0, content: deltaP };
							}
							if (qJson.status === "completed" && qJson.url) {
								finalVideoUrl = qJson.url;
								break;
							}
							if (qJson.status === "failed") {
								throw new Error(qJson.error?.message || "视频生成失败");
							}
						} catch (qErr) {
							if (pollCount >= maxPollCount || (qErr?.message && !qErr.message.includes("fetch"))) {
								throw qErr;
							}
						}
					}
					if (!finalVideoUrl) {
						throw new Error("视频生成超时或未获取到播放链接");
					}
					const altPrompt = (prompt || "Generated Video")
						.replace(new RegExp("<system-reminder>[\\s\\S]*?</system-reminder>", "gi"), "")
						.replace(/[\\[\\]]/g, "")
						.trim();
					const alt = altPrompt.length > 50 ? altPrompt.slice(0, 50) + "..." : (altPrompt || "Generated Video");
					const videoMarkdown = "\\n\\n[" + alt + "](" + finalVideoUrl + ")";
					yield { type: "text_start", contentIndex: 0 };
					yield { type: "text_delta", contentIndex: 0, delta: videoMarkdown };
					yield { type: "text_end", contentIndex: 0, content: videoMarkdown };
					yield {
						type: "done",
						message: {
							role: "assistant",
							content: [{ type: "text", text: progressHint + "\\n> ⏳ 渲染进度: 100%" + videoMarkdown }],
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
					const altPrompt = (item.revised_prompt || prompt || "Generated Image")
						.replace(new RegExp("<system-reminder>[\\s\\S]*?</system-reminder>", "gi"), "")
						.replace(/[\\[\\]]/g, "")
						.trim();
					const alt = altPrompt.length > 50 ? altPrompt.slice(0, 50) + "..." : (altPrompt || "Generated Image");
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
