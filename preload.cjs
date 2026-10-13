let electron = require("electron");
//#region src/conversation-replay-injector.ts
function runIsolatedShellInjection(label, callback) {
	try {
		const result = callback();
		if (result !== null && typeof result === "object" && typeof result.then === "function") Promise.resolve(result).catch((error) => {
			console.error(label, error);
		});
		return true;
	} catch (error) {
		console.error(label, error);
		return false;
	}
}
function installConversationReplayModuleHook() {
	const globalObject = globalThis;
	const hookKey = "__dshDesktopConversationReplayHook";
	const targetModuleId = "@deepseek-ai/dsh-client-ui-conversation";
	const legacyModuleId = "@deepseek-ai/dsh-desktop-conversation-replay";
	const moduleFactoryTransforms = /* @__PURE__ */ new Map();
	const existingHook = globalObject[hookKey];
	if (existingHook?.version === 1) {
		if (typeof existingHook.ensureLoaderAccessor === "function") try {
			existingHook.ensureLoaderAccessor();
		} catch (error) {
			console.error("桌面壳 ModuleLoader 接管恢复失败", error);
		}
		return "already-installed";
	}
	function createConversationReplayFeature(require) {
		const reactModule = require("react");
		const React = typeof reactModule?.createElement === "function" ? reactModule : reactModule?.default;
		if (typeof React?.createElement !== "function") throw new Error("React runtime is unavailable");
		const optionalRequire = (id) => {
			try {
				return require(id);
			} catch {
				return;
			}
		};
		const moduleMember = (module, name) => module?.[name] ?? module?.default?.[name];
		const isComponent = (value) => typeof value === "function" || typeof value === "string" || typeof value === "symbol" || value !== null && typeof value === "object" && value.$$typeof !== void 0;
		const componentOr = (value, fallback) => isComponent(value) ? value : fallback;
		const primitives = optionalRequire("@deepseek-ai/dsh-client-ui-primitives");
		const attachment = optionalRequire("@deepseek-ai/dsh-client-ui-attachment");
		const FallbackTooltip = ({ children }) => children ?? null;
		const FallbackMessageText = ({ text }) => React.createElement("span", null, text);
		const FallbackJsonBlock = ({ payload }) => React.createElement("pre", null, JSON.stringify(payload, null, 2));
		const fallbackIcon = (text) => function FallbackIcon() {
			return React.createElement("span", { "aria-hidden": true }, text);
		};
		const IconCheckOutline16 = componentOr(moduleMember(primitives, "IconCheckOutline16"), fallbackIcon("✓"));
		const IconCopyOutline16 = componentOr(moduleMember(primitives, "IconCopyOutline16"), fallbackIcon("⧉"));
		const IconEditOutline16 = componentOr(moduleMember(primitives, "IconEditOutline16"), fallbackIcon("✎"));
		const IconRefreshOutline16 = componentOr(moduleMember(primitives, "IconRefreshOutline16"), fallbackIcon("↻"));
		const ImageGallery = componentOr(moduleMember(attachment, "ImageGallery"), void 0);
		const JsonBlock = componentOr(moduleMember(primitives, "JsonBlock"), FallbackJsonBlock);
		const MessageText = componentOr(moduleMember(primitives, "MessageText"), FallbackMessageText);
		const Tooltip = componentOr(moduleMember(primitives, "Tooltip"), FallbackTooltip);
		const writeClipboard = moduleMember(primitives, "writeClipboard") ?? ((text) => globalObject.navigator?.clipboard?.writeText(text));
		const STYLE_ID = "dsh-desktop-conversation-replay-style";
		const STYLE = `
[data-dsh-conversation-replay-row] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
[data-dsh-conversation-replay-stack] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  max-width: min(525px, 82%);
}
[data-dsh-conversation-replay-bubble] {
  max-width: 100%;
  padding: 10px 16px;
  border-radius: 22px;
  background: var(--dsw-specific-bubble);
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
}
[data-dsh-conversation-replay-textclip] {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  max-width: 100%;
}
[data-dsh-conversation-replay-textclip-toggle] {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: min(320px, 82vw);
  height: 26px;
  padding: 0 7px;
  border: 1px solid var(--dsw-alias-stroke-primary);
  border-radius: 6px;
  background: color-mix(in srgb, currentColor 7%, transparent);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  font: 500 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif;
}
[data-dsh-conversation-replay-textclip-icon] { flex: none; font-size: 12px; line-height: 1; }
[data-dsh-conversation-replay-textclip-label] {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
[data-dsh-conversation-replay-textclip-type] {
  flex: none;
  opacity: .58;
  font: 10px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
}
[data-dsh-conversation-replay-textclip-expanded] {
  max-height: 360px;
  overflow: auto;
  overflow-wrap: anywhere;
}
[data-dsh-conversation-replay-actions] {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 28px;
}
[data-dsh-conversation-replay-time] {
  padding-right: 12px;
  color: var(--dsw-alias-label-tertiary);
  font-size: 14px;
  line-height: 24px;
  white-space: nowrap;
}
@media (hover: hover) {
  [data-dsh-conversation-replay-time] { opacity: 0; transition: opacity 80ms ease; }
  [data-dsh-conversation-replay-row]:hover [data-dsh-conversation-replay-time],
  [data-dsh-conversation-replay-row]:focus-within [data-dsh-conversation-replay-time] { opacity: 1; }
}
[data-dsh-conversation-replay-action] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
[data-dsh-conversation-replay-action]:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-conversation-replay-action]:disabled { cursor: default; opacity: .4; }
[data-dsh-conversation-replay-editor] {
  width: min(525px, 82vw);
  min-height: 112px;
  padding: 12px 14px;
  resize: vertical;
  border: 1px solid var(--dsw-alias-stroke-primary);
  border-radius: 16px;
  outline: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  line-height: 24px;
}
[data-dsh-conversation-replay-editor]:focus {
  border-color: var(--dsw-alias-button-info-fill);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-button-info-fill) 18%, transparent);
}
[data-dsh-conversation-replay-editor-actions] {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
[data-dsh-conversation-replay-editor-button] {
  min-height: 32px;
  padding: 0 13px;
  border: 1px solid var(--dsw-alias-stroke-primary);
  border-radius: 16px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
[data-dsh-conversation-replay-editor-button='confirm'] {
  border-color: transparent;
  background: var(--dsw-alias-button-info-fill);
  color: var(--dsw-alias-button-info-label);
}
[data-dsh-conversation-replay-editor-button]:disabled { cursor: default; opacity: .45; }
[data-dsh-conversation-replay-error] {
  max-width: min(525px, 82%);
  color: var(--dsw-alias-state-error-primary);
  font-size: 13px;
  line-height: 20px;
  overflow-wrap: anywhere;
}
`;
		const TEXT_CLIP_THRESHOLD = 500;
		function isLongTextClip(text) {
			return Array.from(text).length > TEXT_CLIP_THRESHOLD;
		}
		function textClipLabel(text) {
			const clean = text.replace(/\s+/g, " ").trim();
			if (clean.length === 0) return "粘贴的文本";
			return clean.length <= 15 ? clean : `${clean.slice(0, 15).trim()}…`;
		}
		function contentParts(content) {
			const texts = [];
			const images = [];
			const rest = [];
			for (const block of content) if (block?.type === "text" && typeof block.text === "string") texts.push(block.text);
			else if (block?.type === "image" && block.attachment !== void 0) images.push({ attachment: block.attachment });
			else rest.push(block);
			return {
				text: texts.join(""),
				images,
				rest
			};
		}
		function bytesToBase64(bytes) {
			let binary = "";
			const step = 32768;
			for (let offset = 0; offset < bytes.length; offset += step) binary += String.fromCharCode(...bytes.subarray(offset, offset + step));
			return btoa(binary);
		}
		async function promptContent(session, content, replacementText) {
			const result = [];
			let replaced = replacementText === void 0;
			let sawText = false;
			for (const block of content) {
				if (block?.type === "text" && typeof block.text === "string") {
					sawText = true;
					if (replacementText === void 0) result.push({
						type: "text",
						text: block.text
					});
					else if (!replaced) {
						if (replacementText !== "") result.push({
							type: "text",
							text: replacementText
						});
						replaced = true;
					}
					continue;
				}
				if (block?.type === "image" && block.attachment?.attachmentId !== void 0) {
					const read = await session.readAttachment(block.attachment.attachmentId);
					if (!read?.ok) throw new Error(read?.error?.message ?? "读取原消息图片失败");
					const attachment = read.value.attachment;
					result.push({
						type: "image",
						mediaType: attachment.mediaType,
						data: bytesToBase64(read.value.data),
						...attachment.name === void 0 ? {} : { name: attachment.name }
					});
					continue;
				}
				throw new Error("当前消息包含暂不支持重新发送的内容");
			}
			if (replacementText !== void 0 && !sawText && replacementText !== "") result.unshift({
				type: "text",
				text: replacementText
			});
			return result;
		}
		async function replayMessage(ctx, { sessionId, node, content, replacementText }) {
			const source = ctx.sessions.binding(sessionId)?.session;
			if (source === void 0) throw new Error("当前会话尚未就绪");
			if (typeof source.desktopReplay !== "function") throw new Error("当前 Runtime 与壳侧原会话重试适配尚未就绪");
			if (!Number.isSafeInteger(node?.data?.seq)) throw new Error("消息序号无效");
			const prompt = await promptContent(source, content, replacementText);
			if (prompt.length === 0) throw new Error("消息内容不能为空");
			const sent = await source.desktopReplay(node.data.seq, prompt);
			if (!sent?.ok) {
				const reason = sent?.error?.details?.reason;
				throw new Error(typeof reason === "string" ? reason : sent?.error?.message ?? "重新发送失败");
			}
			return sessionId;
		}
		function projectUserText(text) {
			const expression = /(^|\s)([/@][\w-]+)(?=\s|$)/g;
			const parts = [];
			let cursor = 0;
			let match;
			while ((match = expression.exec(text)) !== null) {
				const tokenStart = match.index + (match[1]?.length ?? 0);
				const label = match[2] ?? "";
				if (tokenStart > cursor) parts.push(React.createElement(MessageText, {
					key: cursor,
					text: text.slice(cursor, tokenStart)
				}));
				parts.push(React.createElement("span", {
					key: tokenStart,
					"data-ref-chip": label.startsWith("@") ? "subagent" : "skill",
					style: { fontWeight: 500 }
				}, label));
				cursor = tokenStart + label.length;
			}
			if (parts.length === 0) return React.createElement(MessageText, { text });
			if (cursor < text.length) parts.push(React.createElement(MessageText, {
				key: cursor,
				text: text.slice(cursor)
			}));
			return React.createElement(React.Fragment, null, ...parts);
		}
		function imageLabels() {
			return {
				image: "图片",
				open: "查看原图",
				openNamed: (label) => `查看 ${label}`,
				loading: "加载中",
				loadFailed: "加载失败，点击重试",
				lightbox: {
					dialog: "原图预览",
					close: "关闭原图"
				}
			};
		}
		function formatTime(value) {
			try {
				return new Intl.DateTimeFormat(void 0, {
					month: "numeric",
					day: "numeric",
					hour: "2-digit",
					minute: "2-digit",
					hour12: false
				}).format(new Date(value));
			} catch {
				return "";
			}
		}
		function actionButton(label, icon, onClick, disabled) {
			return React.createElement(Tooltip, {
				label,
				side: "bottom"
			}, React.createElement("button", {
				type: "button",
				"data-dsh-conversation-replay-action": true,
				"aria-label": label,
				disabled,
				onClick
			}, React.createElement(icon)));
		}
		function LongTextClip({ text }) {
			const [expanded, setExpanded] = React.useState(false);
			const label = textClipLabel(text);
			return React.createElement("div", { "data-dsh-conversation-replay-textclip": expanded ? "expanded" : "collapsed" }, React.createElement("button", {
				type: "button",
				"data-dsh-conversation-replay-textclip-toggle": true,
				"aria-expanded": expanded,
				"aria-label": `${expanded ? "收起" : "展开"}长文本：${label}`,
				title: expanded ? "点击收起长文本" : "点击展开长文本",
				onClick: () => {
					setExpanded((value) => !value);
				}
			}, React.createElement("span", {
				"data-dsh-conversation-replay-textclip-icon": true,
				"aria-hidden": true
			}, "📋"), React.createElement("span", { "data-dsh-conversation-replay-textclip-label": true }, label), React.createElement("span", { "data-dsh-conversation-replay-textclip-type": true }, ".textclip")), expanded && React.createElement("div", {
				"data-dsh-conversation-replay-bubble": true,
				"data-dsh-conversation-replay-textclip-expanded": true
			}, projectUserText(text)));
		}
		function createUserMessageNodeView(ctx) {
			return React.memo(function UserMessageNodeView({ node, loadImage, renderMessageImages, sessionId, useSession }) {
				const data = node.data;
				const removed = useSession((snapshot) => snapshot.removed);
				const running = useSession((snapshot) => snapshot.running);
				const { text, images, rest } = React.useMemo(() => contentParts(data.content), [data.content]);
				const longTextClip = React.useMemo(() => isLongTextClip(text), [text]);
				const [editing, setEditing] = React.useState(false);
				const [draft, setDraft] = React.useState(text);
				const [busy, setBusy] = React.useState(false);
				const [copied, setCopied] = React.useState(false);
				const [error, setError] = React.useState("");
				const replayable = rest.length === 0;
				const disabled = busy || running || removed || !replayable;
				React.useEffect(() => {
					if (!editing) setDraft(text);
				}, [editing, text]);
				React.useEffect(() => {
					if (!copied) return void 0;
					const timer = window.setTimeout(() => {
						setCopied(false);
					}, 1e3);
					return () => {
						window.clearTimeout(timer);
					};
				}, [copied]);
				const run = React.useCallback(async (replacementText) => {
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						await replayMessage(ctx, {
							sessionId,
							node,
							content: data.content,
							replacementText
						});
						setEditing(false);
					} catch (reason) {
						setError(reason instanceof Error ? reason.message : String(reason));
					} finally {
						setBusy(false);
					}
				}, [
					busy,
					ctx,
					data.content,
					data.seq,
					node,
					sessionId
				]);
				const copy = React.useCallback(() => {
					if (copied) return;
					Promise.resolve(writeClipboard(text)).then(() => {
						setCopied(true);
					}).catch(() => {});
				}, [copied, text]);
				const cancelEdit = React.useCallback(() => {
					if (busy) return;
					setDraft(text);
					setEditing(false);
					setError("");
				}, [busy, text]);
				const submitEdit = React.useCallback(() => {
					if (draft.trim() === "" && images.length === 0) return;
					run(draft);
				}, [
					draft,
					images.length,
					run
				]);
				const imageContent = images.length === 0 ? null : typeof renderMessageImages === "function" ? renderMessageImages({
					images,
					align: "end"
				}) : typeof loadImage === "function" && ImageGallery !== void 0 ? React.createElement(ImageGallery, {
					images,
					load: loadImage,
					align: "end",
					labels: imageLabels()
				}) : null;
				const bubble = editing ? React.createElement(React.Fragment, null, React.createElement("textarea", {
					autoFocus: true,
					value: draft,
					disabled: busy,
					"data-dsh-conversation-replay-editor": true,
					onChange: (event) => {
						setDraft(event.currentTarget.value);
					},
					onKeyDown: (event) => {
						if (event.key === "Escape") cancelEdit();
						else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
							event.preventDefault();
							submitEdit();
						}
					}
				}), React.createElement("div", { "data-dsh-conversation-replay-editor-actions": true }, React.createElement("button", {
					type: "button",
					disabled: busy,
					"data-dsh-conversation-replay-editor-button": "cancel",
					onClick: cancelEdit
				}, "取消"), React.createElement("button", {
					type: "button",
					disabled: disabled || draft.trim() === "" && images.length === 0,
					"data-dsh-conversation-replay-editor-button": "confirm",
					onClick: submitEdit
				}, busy ? "正在重新发送…" : "确认并重新发送"))) : React.createElement(React.Fragment, null, imageContent, text !== "" && longTextClip ? React.createElement(LongTextClip, { text }) : (text !== "" || rest.length > 0) && React.createElement("div", { "data-dsh-conversation-replay-bubble": true }, text !== "" && projectUserText(text), ...rest.map((block, index) => React.createElement(JsonBlock, {
					key: index,
					label: "附加内容",
					payload: block,
					truncatedLabel: (total) => `已截断，共 ${total} 项`
				}))), text !== "" && longTextClip && rest.length > 0 && React.createElement("div", { "data-dsh-conversation-replay-bubble": true }, ...rest.map((block, index) => React.createElement(JsonBlock, {
					key: index,
					label: "附加内容",
					payload: block,
					truncatedLabel: (total) => `已截断，共 ${total} 项`
				}))));
				return React.createElement("div", {
					"data-dsh-conversation-replay-row": true,
					"data-time-hover-root": true
				}, React.createElement("div", { "data-dsh-conversation-replay-stack": true }, bubble), !editing && React.createElement("div", { "data-dsh-conversation-replay-actions": true }, React.createElement("span", { "data-dsh-conversation-replay-time": true }, formatTime(data.time)), actionButton(copied ? "已复制" : "复制", copied ? IconCheckOutline16 : IconCopyOutline16, copy, false), actionButton(replayable ? "重试此消息" : "该消息包含不支持重新发送的内容", IconRefreshOutline16, () => {
					run(void 0);
				}, disabled), actionButton(replayable ? "编辑此消息" : "该消息包含不支持编辑的内容", IconEditOutline16, () => {
					setDraft(text);
					setEditing(true);
					setError("");
				}, disabled)), editing && busy && React.createElement("div", { "data-dsh-conversation-replay-error": true }, "正在清理后续对话并重新发起请求…"), error !== "" && React.createElement("div", { "data-dsh-conversation-replay-error": true }, error));
			});
		}
		function apply(ctx) {
			let style = document.getElementById(STYLE_ID);
			let ownsStyle = false;
			if (style === null) {
				style = document.createElement("style");
				style.id = STYLE_ID;
				style.textContent = STYLE;
				document.head.appendChild(style);
				ownsStyle = true;
			}
			if (ownsStyle) ctx.effect(() => () => {
				style.remove();
			}, "desktop-shell-conversation-replay: styles");
			const UserMessageNodeView = createUserMessageNodeView(ctx);
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: "user",
				priority: -100,
				registrant: "@deepseek-ai/dsh-desktop-shell-conversation-replay"
			}, UserMessageNodeView));
		}
		return {
			apply,
			contentParts,
			isLongTextClip,
			textClipLabel,
			promptContent,
			replayMessage
		};
	}
	const installedContexts = /* @__PURE__ */ new WeakSet();
	const scheduledContexts = /* @__PURE__ */ new WeakSet();
	const wrappedFactories = /* @__PURE__ */ new WeakMap();
	const loaderProxies = /* @__PURE__ */ new WeakMap();
	const bootstrapModuleId = "@deepseek-ai/dsh-client-modules";
	const featureDependencyIds = ["react", "@deepseek-ai/dsh-client-ui-primitives"];
	const optionalFeatureDependencyIds = ["@deepseek-ai/dsh-client-ui-attachment"];
	const featureServiceIds = ["slots", "sessions"];
	let legacySuppressions = 0;
	let targetRegistrations = 0;
	let targetFactories = 0;
	let targetApplies = 0;
	let featureApplications = 0;
	let featureFailures = 0;
	let boundaryFailures = 0;
	let lastSlotEntries = [];
	let capturedContext;
	let capturedModules = globalObject.__DSH_MODULES__;
	let feature;
	let featureRequire;
	let recoveryPromise;
	let loaderRepairAttempts = 0;
	function reportBoundaryFailure(message, error) {
		boundaryFailures += 1;
		console.error(message, error);
	}
	function exposeModules(modules) {
		if (modules === null || typeof modules !== "object" && typeof modules !== "function") return;
		capturedModules = modules;
	}
	function captureContext(ctx) {
		if (ctx === null || typeof ctx !== "object" && typeof ctx !== "function") return;
		capturedContext = ctx;
		applyFeature(ctx);
	}
	function applyFeature(ctx, require) {
		if (ctx === null || typeof ctx !== "object" && typeof ctx !== "function" || installedContexts.has(ctx) || scheduledContexts.has(ctx)) return;
		if (typeof require === "function") featureRequire = require;
		if (feature === void 0 && featureRequire !== void 0) try {
			feature = createConversationReplayFeature(featureRequire);
		} catch (error) {
			featureFailures += 1;
			console.error("桌面壳对话编辑与重试功能注入失败", error);
			return;
		}
		if (feature !== void 0) {
			const install = (featureContext) => {
				try {
					feature.apply(featureContext);
					featureApplications += 1;
					installedContexts.add(ctx);
				} catch (error) {
					featureFailures += 1;
					console.error("桌面壳对话编辑与重试功能注入失败", error);
				}
			};
			scheduledContexts.add(ctx);
			try {
				if (typeof ctx.inject === "function") ctx.inject(featureServiceIds, install);
				else install(ctx);
			} catch (error) {
				featureFailures += 1;
				console.error("桌面壳对话编辑与重试功能注入失败", error);
			}
			return;
		}
		const modules = capturedModules;
		if (recoveryPromise !== void 0 || typeof modules?.import !== "function") return;
		recoveryPromise = Promise.resolve().then(async () => {
			const required = await Promise.all(featureDependencyIds.map((id) => modules.import(id)));
			const optional = await Promise.all(optionalFeatureDependencyIds.map((id) => Promise.resolve().then(() => modules.import(id)).catch(() => void 0)));
			return [...required, ...optional];
		}).then((values) => {
			const dependencyIds = [...featureDependencyIds, ...optionalFeatureDependencyIds];
			const dependencies = new Map(dependencyIds.map((id, index) => [id, values[index]]));
			const requireFromModules = (id) => {
				if (!dependencies.has(id) || dependencies.get(id) === void 0) throw new Error("对话编辑与重试注入依赖未找到：" + id);
				return dependencies.get(id);
			};
			applyFeature(ctx, requireFromModules);
		}).catch((error) => {
			featureFailures += 1;
			console.error("桌面壳对话编辑与重试功能注入失败", error);
		}).finally(() => {
			recoveryPromise = void 0;
		});
	}
	function wrapFactory(factory, moduleId) {
		const existing = wrappedFactories.get(factory);
		if (existing !== void 0) return existing;
		const wrapped = function(require) {
			if (moduleId === targetModuleId) targetFactories += 1;
			const exports = factory(require);
			try {
				if (exports === null || typeof exports !== "object" && typeof exports !== "function") return exports;
				const originalApply = exports.apply;
				if (typeof originalApply !== "function") return exports;
				const wrappedApply = function(...args) {
					const result = originalApply.apply(this, args);
					try {
						const ctx = args[0];
						if (moduleId === targetModuleId) {
							targetApplies += 1;
							applyFeature(capturedContext ?? ctx, require);
						} else if (moduleId === bootstrapModuleId) captureContext(ctx);
						if (ctx !== null && (typeof ctx === "object" || typeof ctx === "function")) try {
							lastSlotEntries = (typeof ctx.slots?.entriesOfSlot === "function" ? ctx.slots.entriesOfSlot("conversation.chat.node") : typeof ctx.slots?.entries === "function" ? ctx.slots.entries("conversation.chat.node") : []).map((entry) => ({
								key: entry?.options?.key,
								priority: entry?.options?.priority,
								registrant: entry?.options?.registrant,
								component: entry?.component?.name
							}));
						} catch {}
					} catch (error) {
						reportBoundaryFailure("桌面壳客户端模块 apply 增强失败", error);
					}
					return result;
				};
				Object.defineProperty(exports, "apply", {
					...Object.getOwnPropertyDescriptor(exports, "apply"),
					value: wrappedApply
				});
				if (moduleId === bootstrapModuleId) {
					const originalCreate = exports.createClientModuleSystem;
					if (typeof originalCreate === "function") Object.defineProperty(exports, "createClientModuleSystem", {
						...Object.getOwnPropertyDescriptor(exports, "createClientModuleSystem"),
						value: function(...args) {
							const modules = originalCreate.apply(this, args);
							try {
								exposeModules(modules);
								applyFeature(capturedContext);
							} catch (error) {
								reportBoundaryFailure("桌面壳客户端模块系统增强失败", error);
							}
							return modules;
						}
					});
				}
			} catch (error) {
				reportBoundaryFailure("桌面壳客户端模块工厂增强失败", error);
			}
			return exports;
		};
		wrappedFactories.set(factory, wrapped);
		return wrapped;
	}
	function registerModuleFactoryTransform(moduleId, transform) {
		if (typeof moduleId !== "string" || moduleId.length === 0 || typeof transform !== "function") return false;
		const previous = moduleFactoryTransforms.get(moduleId);
		moduleFactoryTransforms.set(moduleId, (factory) => {
			let current = factory;
			for (const apply of [previous, transform]) {
				if (typeof apply !== "function") continue;
				try {
					const result = apply(current);
					if (typeof result === "function") current = result;
				} catch (error) {
					reportBoundaryFailure("桌面壳客户端模块转换失败，保留已有增强", error);
				}
			}
			return current;
		});
		return true;
	}
	function transformFactory(handoff) {
		try {
			const transform = moduleFactoryTransforms.get(handoff?.id);
			if (typeof transform !== "function" || typeof handoff?.factory !== "function") return handoff;
			const originalFactory = handoff.factory;
			const transformedFactory = transform(originalFactory);
			if (typeof transformedFactory !== "function" || transformedFactory === originalFactory) return handoff;
			const factory = function(...args) {
				try {
					return Reflect.apply(transformedFactory, this, args);
				} catch (error) {
					reportBoundaryFailure("桌面壳客户端模块转换执行失败", error);
					return Reflect.apply(originalFactory, this, args);
				}
			};
			return {
				...handoff,
				factory
			};
		} catch (error) {
			console.error("桌面壳客户端模块转换失败", error);
			return handoff;
		}
	}
	function prepareHandoff(handoff) {
		const originalHandoff = handoff;
		try {
			handoff = transformFactory(handoff);
			if (handoff?.id === targetModuleId && typeof handoff.factory === "function") {
				const factory = wrapFactory(handoff.factory, handoff.id);
				if (factory !== handoff.factory) targetRegistrations += 1;
				return {
					...handoff,
					factory
				};
			}
			if (handoff?.id === bootstrapModuleId && typeof handoff.factory === "function") return {
				...handoff,
				factory: wrapFactory(handoff.factory, handoff.id)
			};
			if (handoff?.id === legacyModuleId && typeof handoff.factory === "function") {
				legacySuppressions += 1;
				return {
					...handoff,
					factory: () => ({
						inject: [],
						apply() {}
					})
				};
			}
			return handoff;
		} catch (error) {
			reportBoundaryFailure("桌面壳 ModuleLoader 模块预处理失败", error);
			return originalHandoff;
		}
	}
	function wrapLoader(loader) {
		if (loader === void 0 || loader === null || typeof loader !== "object" && typeof loader !== "function") return loader;
		const existing = loaderProxies.get(loader);
		if (existing !== void 0) return existing;
		const wrappers = /* @__PURE__ */ new WeakMap();
		const createWrappers = /* @__PURE__ */ new WeakMap();
		const delegates = /* @__PURE__ */ new WeakMap();
		const proxy = new Proxy(loader, {
			get(target, property, receiver) {
				if (property === "create") {
					const delegate = Reflect.get(target, property, target);
					if (typeof delegate !== "function") return delegate;
					const existingWrapper = createWrappers.get(delegate);
					if (existingWrapper !== void 0) return existingWrapper;
					const wrapper = function(...args) {
						try {
							const queue = Reflect.get(target, "pendingQueue", target);
							if (Array.isArray(queue)) for (let index = 0; index < queue.length; index += 1) queue[index] = prepareHandoff(queue[index]);
						} catch (error) {
							reportBoundaryFailure("桌面壳 ModuleLoader 队列预处理失败", error);
						}
						return Reflect.apply(delegate, target, args);
					};
					createWrappers.set(delegate, wrapper);
					return wrapper;
				}
				if (property !== "load") return Reflect.get(target, property, receiver);
				const delegate = Reflect.get(target, property, target);
				if (typeof delegate !== "function") return delegate;
				const existingWrapper = wrappers.get(delegate);
				if (existingWrapper !== void 0) return existingWrapper;
				const wrapper = function(handoff) {
					return Reflect.apply(delegate, target, [prepareHandoff(handoff)]);
				};
				wrappers.set(delegate, wrapper);
				delegates.set(wrapper, delegate);
				return wrapper;
			},
			set(target, property, value) {
				const delegate = property === "load" && typeof value === "function" ? delegates.get(value) : void 0;
				return Reflect.set(target, property, delegate ?? value, target);
			},
			defineProperty(target, property, descriptor) {
				if (property !== "load" || typeof descriptor.value !== "function") return Reflect.defineProperty(target, property, descriptor);
				const delegate = delegates.get(descriptor.value);
				return Reflect.defineProperty(target, property, {
					...descriptor,
					value: delegate ?? descriptor.value
				});
			}
		});
		loaderProxies.set(loader, proxy);
		loaderProxies.set(proxy, proxy);
		return proxy;
	}
	let currentLoader;
	try {
		currentLoader = wrapLoader(globalObject.__ModuleLoader__);
	} catch (error) {
		currentLoader = globalObject.__ModuleLoader__;
		reportBoundaryFailure("桌面壳 ModuleLoader 初始接管失败", error);
	}
	const loaderGetter = () => currentLoader;
	const loaderSetter = (value) => {
		try {
			currentLoader = wrapLoader(value);
		} catch (error) {
			currentLoader = value;
			reportBoundaryFailure("桌面壳 ModuleLoader 赋值接管失败", error);
		}
	};
	const ensureLoaderAccessor = () => {
		const descriptor = Object.getOwnPropertyDescriptor(globalObject, "__ModuleLoader__");
		if (descriptor?.get === loaderGetter && descriptor?.set === loaderSetter) return;
		const value = descriptor === void 0 ? void 0 : typeof descriptor.get === "function" ? descriptor.get.call(globalObject) : descriptor.value;
		try {
			currentLoader = wrapLoader(value);
		} catch (error) {
			currentLoader = value;
			reportBoundaryFailure("桌面壳 ModuleLoader 接管恢复失败", error);
		}
		Object.defineProperty(globalObject, "__ModuleLoader__", {
			configurable: true,
			enumerable: false,
			get: loaderGetter,
			set: loaderSetter
		});
	};
	const repairLoaderAccessor = () => {
		try {
			ensureLoaderAccessor();
			applyFeature(capturedContext);
		} catch (error) {
			console.error("桌面壳 ModuleLoader 接管恢复失败", error);
		}
	};
	Object.defineProperty(globalObject, "__ModuleLoader__", {
		configurable: true,
		enumerable: false,
		get: loaderGetter,
		set: loaderSetter
	});
	if (typeof globalObject.addEventListener === "function") {
		globalObject.addEventListener("DOMContentLoaded", repairLoaderAccessor, { once: true });
		globalObject.addEventListener("load", repairLoaderAccessor, { once: true });
		globalObject.addEventListener("pageshow", repairLoaderAccessor);
	}
	if (typeof globalObject.queueMicrotask === "function") globalObject.queueMicrotask(repairLoaderAccessor);
	const pollLoaderAccessor = () => {
		repairLoaderAccessor();
		loaderRepairAttempts += 1;
		if (loaderRepairAttempts < 120 && targetApplies === 0 && featureApplications === 0 && typeof globalObject.setTimeout === "function") globalObject.setTimeout(pollLoaderAccessor, 250);
	};
	const protocol = typeof globalObject.location?.protocol === "string" ? globalObject.location.protocol : "";
	if ((protocol === "http:" || protocol === "https:") && typeof globalObject.setTimeout === "function") globalObject.setTimeout(pollLoaderAccessor, 0);
	Object.defineProperty(globalObject, hookKey, {
		configurable: true,
		enumerable: false,
		writable: false,
		value: Object.freeze({
			version: 1,
			targetModuleId,
			legacyModuleId,
			createFeature: createConversationReplayFeature,
			registerModuleFactoryTransform,
			ensureLoaderAccessor,
			get legacySuppressions() {
				return legacySuppressions;
			},
			get diagnostics() {
				return {
					targetRegistrations,
					targetFactories,
					targetApplies,
					featureApplications,
					featureFailures,
					boundaryFailures,
					lastSlotEntries
				};
			}
		})
	});
	return "installed";
}
//#endregion
//#region src/subagent-model-injector.ts
/**
* Slot this badge seats into. Only the template literal below may read it: every function that
* reaches the main world is serialized by `Function.prototype.toString`, so each of those writes
* its own literals out in full instead of reading this or any other module binding.
*/
const HEADER_ACTIONS_SLOT = "conversation.session.header.actions";
/**
* Injected verbatim into the Runtime's ui-subagent factory body. Every name it declares lives
* inside one IIFE, so a future upstream factory can never collide with it, and the only outer
* bindings it touches are the factory's own `require` and `apply`.
*
* The badge reads the addressed Session's own durable `modelSelection` projection; it never
* falls back to a parent Session or to the catalog default, and it renders nothing when the
* child has no model of its own.
*/
const SUBAGENT_MODEL_BADGE_SOURCE = `(function () {
const React = (function () { try { return require("react"); } catch (error) { return void 0; } })();
const badgeStyle = ".dsh-desktop-subagent-model{display:inline-flex;align-items:center;gap:6px;max-width:min(220px,28vw);min-width:0;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-stroke-primary);border-radius:11px;background:color-mix(in srgb,currentColor 6%,transparent);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}.dsh-desktop-subagent-model-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
const noSessions = selector => selector(void 0);
const noProjection = () => void 0;
const emptyDirectory = () => void 0;
const noSubscribe = () => () => {};
/** Sessions whose badge seat is already claimed in this factory execution. */
const installedContexts = new WeakSet();
/** Resolve the child Session's own selection; undefined while absent, never a fabricated value. */
function resolveModelView(projection, directoryState) {
  if (projection === null || projection === void 0 || typeof projection !== "object") return void 0;
  const selection = projection.next === null || projection.next === void 0 ? projection.lastUsed : projection.next;
  if (selection === null || selection === void 0 || typeof selection !== "object") return void 0;
  if (typeof selection.provider !== "string" || selection.provider.length === 0) return void 0;
  if (typeof selection.model !== "string" || selection.model.length === 0) return void 0;
  const groups = directoryState === null || directoryState === void 0 || !Array.isArray(directoryState.groups) ? [] : directoryState.groups;
  let displayName;
  for (const group of groups) {
    if (group === null || group === void 0 || group.id !== selection.provider || !Array.isArray(group.models)) continue;
    const match = group.models.find(model => model !== null && model !== void 0 && model.id === selection.model);
    if (match !== void 0 && typeof match.name === "string" && match.name.length > 0) { displayName = match.name; break; }
  }
  const effort = typeof selection.reasoningEffort === "string" && selection.reasoningEffort.length > 0 ? " · " + selection.reasoningEffort : "";
  return { label: typeof displayName === "string" ? displayName : selection.model, title: selection.provider + " / " + selection.model + effort };
}
/** Header badge: rendered only on a child Session, and only while one model is actually known. */
function DshDesktopSubagentModelBadge(props) {
  if (React === void 0 || React === null || typeof React.createElement !== "function") return null;
  const useSessions = typeof props.useSessions === "function" ? props.useSessions : noSessions;
  const useProjection = typeof props.useProjection === "function" ? props.useProjection : noProjection;
  const isSubagent = useSessions(state => state !== null && state !== void 0 && typeof state === "object" && state.byId !== null && typeof state.byId === "object" && state.byId[props.sessionId] !== void 0 && state.byId[props.sessionId].origin === "subagent") === true;
  const projection = useProjection("modelSelection");
  const store = props.dshDesktopModelDirectory;
  const subscribe = React.useMemo(() => store === null || store === void 0 || typeof store.subscribe !== "function" ? noSubscribe : listener => store.subscribe(listener), [store]);
  const read = React.useMemo(() => store === null || store === void 0 || typeof store.getSnapshot !== "function" ? emptyDirectory : () => store.getSnapshot(), [store]);
  const directoryState = React.useSyncExternalStore(subscribe, read, read);
  if (!isSubagent) return null;
  const view = resolveModelView(projection, directoryState);
  if (view === void 0) return null;
  return React.createElement("span", { className: "dsh-desktop-subagent-model", title: view.title, "aria-label": "当前执行模型：" + view.title, "data-dsh-subagent-model": "" }, React.createElement("span", { className: "dsh-desktop-subagent-model-label" }, view.label));
}
/** Install the badge stylesheet once per document. */
function applyModelStyle() {
  if (typeof document === "undefined" || document === null || document.head === null || document.head === void 0) return;
  if (document.querySelector("style[data-dsh-subagent-model-style]") !== null) return;
  const tag = document.createElement("style");
  tag.setAttribute("data-dsh-subagent-model-style", "");
  tag.textContent = badgeStyle;
  document.head.appendChild(tag);
}
/** Seat the badge beside the header's existing actions; the slot's Session scope supplies useProjection. */
function registerBadge(ctx) {
  if (ctx === null || ctx === void 0 || typeof ctx !== "object" || ctx.slots === null || ctx.slots === void 0 || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") return;
  if (installedContexts.has(ctx)) return;
  installedContexts.add(ctx);
  ctx.slots.inject("${HEADER_ACTIONS_SLOT}", function () {
    ctx.slots.register({ name: "${HEADER_ACTIONS_SLOT}", id: "subagent-model", order: -20, inject: function (sessionId) { try { const resolver = ctx.modelDirectories; const directory = resolver === null || resolver === void 0 || typeof resolver.directoryFor !== "function" ? void 0 : resolver.directoryFor(sessionId); return directory === null || directory === void 0 || directory.store === void 0 ? {} : { dshDesktopModelDirectory: directory.store }; } catch (error) { return {}; } } }, DshDesktopSubagentModelBadge);
  });
}
if (typeof apply === "function") {
  const originalApply = apply;
  apply = function (ctx) {
    const result = originalApply.apply(this, arguments);
    try { applyModelStyle(); registerBadge(ctx); } catch (error) { console.error("桌面壳子智能体模型徽标注册失败", error); }
    return result;
  };
}
})();`;
/**
* Insert the badge IIFE at the top of a ui-subagent factory body. Pure and serialized into the
* main world, so the sentinel literal is inlined rather than read from a module binding.
*/
function injectSubagentModelBadgeFactorySource(factorySource, badgeSource) {
	if (typeof factorySource !== "string" || typeof badgeSource !== "string") return {
		source: factorySource,
		changed: false
	};
	if (factorySource.length === 0 || badgeSource.length === 0) return {
		source: factorySource,
		changed: false
	};
	if (factorySource.includes(".dsh-desktop-subagent-model{")) return {
		source: factorySource,
		changed: false
	};
	const bodyStart = factorySource.indexOf("{");
	if (bodyStart < 0) return {
		source: factorySource,
		changed: false
	};
	if (!/=>\s*\{$/u.test(factorySource.slice(0, bodyStart + 1))) return {
		source: factorySource,
		changed: false
	};
	return {
		source: factorySource.slice(0, bodyStart + 1) + "\n" + badgeSource + "\n" + factorySource.slice(bodyStart + 1),
		changed: true
	};
}
/**
* Register the badge transform on the shared ModuleLoader hook. Serialized into the main world,
* so both inputs arrive as arguments and no module binding is referenced.
*/
function installSubagentModelBadgeHook(transformSource, badgeSource) {
	const globalObject = globalThis;
	const hookKey = "__dshDesktopSubagentModelHook";
	if (globalObject[hookKey]?.version === 1) return "already-installed";
	const loaderHook = globalObject.__dshDesktopConversationReplayHook;
	if (typeof loaderHook?.registerModuleFactoryTransform !== "function") return "loader-hook-unavailable";
	try {
		const transform = Function(`return (${transformSource})`)();
		if (loaderHook.registerModuleFactoryTransform("@deepseek-ai/dsh-client-ui-subagent", (factory) => {
			const result = transform(Function.prototype.toString.call(factory), badgeSource);
			if (result?.changed !== true || typeof result.source !== "string") return factory;
			try {
				const rebuilt = Function(`return (${result.source})`)();
				return typeof rebuilt === "function" ? rebuilt : factory;
			} catch (error) {
				console.error("桌面壳子智能体模型徽标注入失败", error);
				return factory;
			}
		}) !== true) return "registration-failed";
		Object.defineProperty(globalObject, hookKey, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: Object.freeze({ version: 1 })
		});
		return "installed";
	} catch (error) {
		console.error("桌面壳子智能体模型徽标注入失败", error);
		return "registration-failed";
	}
}
//#endregion
//#region src/conversation-replay-client-injector.ts
/** Self-contained because preload serializes this transform into the main world. */
function injectDesktopReplayClient(source) {
	const codecAnchor = "function parseInput(codec, value, endpoint, field) {";
	if (source.split(codecAnchor).length === 2) return {
		changed: true,
		source: source.replace(codecAnchor, `function parseInput(codec, value, endpoint, field) {
      if (codec.mode === "strict" && endpoint === "session/prompt" && value?.mode === "desktop-replay-v1") {
        if (!Number.isSafeInteger(value.desktopReplayFrom) || value.desktopReplayFrom < 0) throw new Error("无效重试目标");
        const parsed = codec.schema.parse({ ...value, mode: "queue" });
        return { ...parsed, mode: "desktop-replay-v1", desktopReplayFrom: value.desktopReplayFrom };
      }
    `)
	};
	const methods = `
    async desktopReplay(targetSeq, content) {
      if (this.address !== void 0) return { ok: false, error: { message: "暂不支持子智能体会话重试" } };
      try {
        const reply = await this.api.sessions.prompt({
          sessionId: this.sessionId, mode: "desktop-replay-v1", desktopReplayFrom: targetSeq, content
        });
        return reply.result;
      } catch (error) {
        return { ok: false, error: { message: "原会话重试未成功，请检查 Runtime 适配：" + String(error) } };
      }
    }
    desktopReplayEntries() {
      let entries = this.events.map((event, index) => ({ event, view: this.views[index] }));
      for (const event of this.events) {
        const marker = event.type === "user/message" && event.surfaceOp?.op === "replace"
          && event.data?.source?.desktopReplay;
        if (!marker || marker.version !== 1 || !Number.isSafeInteger(marker.fromSeq)
          || !Number.isSafeInteger(marker.throughSeq) || marker.fromSeq < 0
          || marker.throughSeq < marker.fromSeq || marker.throughSeq >= event.seq) continue;
        entries = entries.filter(item => item.event.seq < marker.fromSeq || item.event.seq > marker.throughSeq);
        entries = entries.map(item => item.event.seq === event.seq
          ? { ...item, event: { ...item.event, surfaceOp: "append", sourceEventSeqs: void 0 } } : item);
      }
      return entries;
    }
    desktopReplayRebuild() {
      let entries;
      try { entries = this.desktopReplayEntries(); }
      catch (error) {
        console.error("桌面壳重试历史展示适配失败，保留原始历史", error);
        entries = this.events.map((event, index) => ({ event, view: this.views[index] }));
      }
      return this.conversation.replaceWindow(entries, this.hasMore);
    }
  `;
	const modernPrompt = "async prompt(content, mode, signal, requestId) {";
	const publish = "this.snapshot = windowSnapshot(this.window, hasMore, this.snapshot.revision + 1, change);";
	const eventSource = "var MutableSessionEventSource = class {";
	if (source.split(modernPrompt).length === 2 && source.split(publish).length === 2 && source.split(eventSource).length === 2) return {
		changed: true,
		source: source.replace(eventSource, `
      function desktopReplayProject(entries) {
        let visible = entries;
        for (const { event } of entries) {
          const marker = event.type === "user/message" && event.surfaceOp?.op === "replace" && event.data?.source?.desktopReplay;
          if (!marker || marker.version !== 1 || !Number.isSafeInteger(marker.fromSeq)
            || !Number.isSafeInteger(marker.throughSeq) || marker.fromSeq < 0
            || marker.throughSeq < marker.fromSeq || marker.throughSeq >= event.seq) continue;
          visible = visible.filter(item => item.event.seq < marker.fromSeq || item.event.seq > marker.throughSeq);
          visible = visible.map(item => item.event.seq === event.seq
            ? { ...item, event: { ...item.event, surfaceOp: "append", sourceEventSeqs: void 0 } } : item);
        }
        return visible;
      }
    var MutableSessionEventSource = class {`).replace(modernPrompt, `
      async desktopReplay(targetSeq, content) {
        if (this.address !== void 0) return { ok: false, error: { message: "暂不支持子智能体会话重试" } };
        try {
          return await this.remote.session.prompt({
            requestId: randomUUID(), sessionId: this.sessionId,
            mode: "desktop-replay-v1", desktopReplayFrom: targetSeq, content,
            clientTimeZone: resolvedClientTimeZone()
          });
        } catch (error) {
          return { ok: false, error: { message: "原会话重试适配未成功：" + String(error) } };
        }
      }
    async prompt(content, mode, signal, requestId) {`).replace(publish, `
        try {
          const marked = change.entries?.some(item => item.event.type === "user/message" && item.event.data?.source?.desktopReplay);
          if (change.kind === "replace") this.desktopReplayActive = marked;
          else if (marked) this.desktopReplayActive = true;
          if (this.desktopReplayActive) {
            if (change.kind === "append" && !marked) {
              this.snapshot = windowSnapshot(concat(leaf(this.snapshot.entries), leaf(change.entries)), hasMore, this.snapshot.revision + 1, change);
            } else {
              const entries = desktopReplayProject(materialize(this.window));
              this.snapshot = windowSnapshot(leaf(entries), hasMore, this.snapshot.revision + 1, { kind: "replace", entries });
            }
          } else { ${publish} }
        } catch (error) {
          console.error("桌面壳重试历史展示适配失败，保留原始历史", error);
          ${publish}
        }
      `)
	};
	const replacements = [
		["async prompt(content, mode) {", methods + "\nasync prompt(content, mode) {"],
		["this.conversation.prepend(older.map(conversationInput), this.hasMore);", "if (this.events.some(event => event.type === \"user/message\" && event.data?.source?.desktopReplay)) this.desktopReplayRebuild(); else this.conversation.prepend(older.map(conversationInput), this.hasMore);"],
		["this.conversation.replaceWindow(entries.map(conversationInput), hasMore);", "if (this.events.some(event => event.type === \"user/message\" && event.data?.source?.desktopReplay)) this.desktopReplayRebuild(); else this.conversation.replaceWindow(entries.map(conversationInput), hasMore);"]
	];
	if (replacements.some(([text]) => source.split(text).length !== 2)) return {
		source,
		changed: false
	};
	const append = /this\.conversation\.append\(\s*\{\s*event,\s*view\s*\}\s*\)/gu;
	if ([...source.matchAll(append)].length !== 1) return {
		source,
		changed: false
	};
	let transformed = source.replace(append, "(event.type === \"user/message\" && event.data?.source?.desktopReplay ? this.desktopReplayRebuild() : this.conversation.append({ event, view }))");
	for (const [text, replacement] of replacements) transformed = transformed.replace(text, replacement);
	return {
		source: transformed,
		changed: true
	};
}
/** Register before the Runtime browser factory is evaluated; failures retain the original factory. */
function installDesktopReplayClientHook(transformSource) {
	const hook = globalThis.__dshDesktopConversationReplayHook;
	if (typeof hook?.registerModuleFactoryTransform !== "function") return "loader-hook-unavailable";
	try {
		const transform = Function(`return (${transformSource})`)();
		for (const moduleId of [
			"@deepseek-ai/dsh-client-runtime",
			"@deepseek-ai/dsh-api-session-controller",
			"@deepseek-ai/dsh-api-gateway"
		]) hook.registerModuleFactoryTransform(moduleId, (factory) => {
			try {
				const result = transform(Function.prototype.toString.call(factory));
				if (!result.changed) {
					console.warn("桌面壳原会话重试：客户端未匹配适配，保留原始模块");
					return factory;
				}
				return Function(`return (${result.source})`)();
			} catch (error) {
				console.error("桌面壳原会话重试客户端适配失败，保留原始模块", error);
				return factory;
			}
		});
		return "installed";
	} catch (error) {
		console.error("桌面壳原会话重试客户端注册失败", error);
		return "registration-failed";
	}
}
//#endregion
//#region src/koi-pond-injector.ts
/** Serialized into the main world: no imports or closure dependencies. */
function injectKoiPondDialogue(source) {
	if (source.includes("__dshPondOriginalPrompt")) return {
		source,
		changed: false
	};
	const anchor = ["async prompt(content, mode, signal, requestId) {", "async prompt(content, mode) {"].find((text) => source.split(text).length === 2);
	if (!anchor) return {
		source,
		changed: false
	};
	return {
		changed: true,
		source: source.replace(anchor, `
      async prompt(...args) {
        const sessionId = this.sessionId;
        const requestId = typeof args[3] === "string" ? args[3] : crypto.randomUUID();
        let releaseRunning;
        let running = false;
        let lastOutput;
        const textOf = (value) => {
          if (typeof value === "string") return value.trim();
          if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ").trim();
          if (!value || typeof value !== "object") return "";
          for (const key of ["text", "content", "output", "lastAssistantMessage"]) {
            const text = textOf(value[key]);
            if (text) return text;
          }
          return "";
        };
        const currentOutput = () => {
          try {
            const snapshot = typeof this.getSnapshot === "function" ? this.getSnapshot() : undefined;
            for (const value of [snapshot?.lastAssistantMessage, snapshot?.lastOutput, snapshot?.output, this.lastAssistantMessage, this.output]) {
              const text = textOf(value);
              if (text) return text;
            }
            const events = Array.isArray(this.events) ? this.events : [];
            for (let index = events.length - 1; index >= 0; index -= 1) {
              const event = events[index];
              const text = textOf(event?.data?.message?.content || event?.data?.content || event?.data?.stream);
              if (text) return text;
            }
          } catch {}
          return "";
        };
        const notifyRunning = (value, output) => {
          const nextOutput = typeof output === "string" ? output.trim() : "";
          if (running === value && lastOutput === nextOutput) return;
          running = value;
          lastOutput = nextOutput;
          try {
            let summary;
            let workspace;
            const serviceOf = (context, property, name) => {
              try { return context?.[property] || context?.get?.(name); } catch { return undefined; }
            };
            for (const context of [this.actx, this.ctx, this.context]) {
              try {
                const sessions = serviceOf(context, "sessions", "sessions");
                const snapshot = sessions?.list?.getSnapshot?.();
                summary = snapshot?.byId?.[sessionId]
                  || snapshot?.items?.find(item => item?.id === sessionId || item?.sessionId === sessionId);
                const cwd = summary?.cwd || this.cwd || this.workdir || this.workspace?.path;
                const workspaces = serviceOf(context, "workspaces", "workspaces");
                const workspaceItems = workspaces?.list?.getSnapshot?.()?.items || workspaces?.list?.getSnapshot?.()?.workspaces || [];
                workspace = workspaceItems.find(item => item?.path === cwd || item?.cwd === cwd || item?.workspacePath === cwd);
                if (summary) break;
              } catch {}
            }
            const cwd = summary?.cwd || this.cwd || this.workdir || this.workspace?.path;
            let projectFromPath;
            if (typeof cwd === "string") {
              let normalizedCwd = cwd.replaceAll(String.fromCharCode(92), "/");
              while (normalizedCwd.endsWith("/")) normalizedCwd = normalizedCwd.slice(0, -1);
              const slash = normalizedCwd.lastIndexOf("/");
              projectFromPath = slash < 0 ? normalizedCwd : normalizedCwd.slice(slash + 1);
            }
            const projectName = this.projectName || this.workspaceName || workspace?.title
              || summary?.workspaceName || summary?.workspace?.title || projectFromPath || "当前项目";
            const sessionCandidates = [this.sessionLabel, this.sessionName, summary?.title, summary?.displayTitle];
            const sessionLabel = sessionCandidates.find(candidate => typeof candidate === "string"
              && candidate.trim().length > 0 && candidate.trim() !== sessionId)?.trim() || "未命名会话";
            window.postMessage({ type: "dsh/session-running", sessionId, requestId, running: value, projectName, sessionLabel, subAgent: this.address !== void 0, output }, window.location.origin);
          } catch {}
        };
        const stopRunning = () => {
          const release = releaseRunning;
          releaseRunning = undefined;
          if (typeof release === "function") release();
        };
        let promptSettled = false;
        notifyRunning(true, currentOutput() || "正在生成输出…");
        if (typeof this.subscribe === "function" && typeof this.getSnapshot === "function") {
          let observedRunning = false;
          const syncRunning = () => {
            let active = false;
            try { active = this.getSnapshot().running === true; } catch {}
            if (active) {
              observedRunning = true;
              notifyRunning(true, currentOutput() || "正在生成输出…");
            } else if (observedRunning || promptSettled) {
              notifyRunning(false);
              stopRunning();
            }
          };
          try {
            releaseRunning = this.subscribe(syncRunning);
            syncRunning();
          } catch {}
        }
        let result;
        try {
          result = await this.__dshPondOriginalPrompt(...args);
        } catch (error) {
          promptSettled = true;
          notifyRunning(false, "执行失败");
          stopRunning();
          throw error;
        }
        promptSettled = true;
        if (result?.ok !== true) {
          notifyRunning(false, result?.error?.message || "已完成");
          stopRunning();
        } else if (this.address !== void 0) {
          notifyRunning(false);
          stopRunning();
        } else {
          let stillRunning = false;
          try { stillRunning = typeof this.getSnapshot === "function" && this.getSnapshot()?.running === true; } catch {}
          if (!stillRunning) {
            notifyRunning(false);
            stopRunning();
          }
        }
        try {
          if (result?.ok === true && this.address === void 0) {
            window.postMessage({
              type: "dsh/pond-dialogue", sessionId: this.sessionId, requestId
            }, window.location.origin);
          }
        } catch (error) { console.warn("鱼塘成长通知未送达，聊天发送结果保持不变", error); }
        return result;
      }
      ${anchor.replace("async prompt(", "async __dshPondOriginalPrompt(")}
    `)
	};
}
function installKoiPondDialogueHook(transformSource) {
	const root = globalThis;
	const hook = root.__dshDesktopConversationReplayHook;
	if (typeof hook?.registerModuleFactoryTransform !== "function") return "loader-hook-unavailable";
	if (root.__dshPondDialogueInstalled) return "already-installed";
	const transform = Function(`return (${transformSource})`)();
	for (const id of ["@deepseek-ai/dsh-client-runtime", "@deepseek-ai/dsh-api-session-controller"]) hook.registerModuleFactoryTransform(id, (factory) => {
		try {
			const result = transform(Function.prototype.toString.call(factory));
			if (!result.changed) {
				console.warn("鱼塘成长观察未匹配此 Runtime，保留原始聊天模块");
				return factory;
			}
			return Function(`return (${result.source})`)();
		} catch (error) {
			console.warn("鱼塘成长观察启动失败，保留原始聊天模块", error);
			return factory;
		}
	});
	root.__dshPondDialogueInstalled = true;
	return "installed";
}
//#endregion
//#region src/custom-provider-user-agent-injector.ts
function injectCustomProviderUserAgentFactorySource(source) {
	const replace = (input, search, replacement) => {
		const index = input.indexOf(search);
		if (index < 0) return void 0;
		return input.slice(0, index) + replacement + input.slice(index + search.length);
	};
	const replaceInFunction = (input, name, search, replacement) => {
		const start = input.indexOf(`function ${name}`);
		if (start < 0) return void 0;
		const next = input.indexOf("\n		function ", start + name.length);
		const end = next < 0 ? input.length : next;
		const changed = replace(input.slice(start, end), search, replacement);
		return changed === void 0 ? void 0 : input.slice(0, start) + changed + input.slice(end);
	};
	let transformed = source;
	for (const [search, replacement] of [["customApiUnset: \"Not selected\",", "customApiUnset: \"Not selected\",\n			customUserAgent: \"User-Agent\","], ["customApiUnset: \"未选择\",", "customApiUnset: \"未选择\",\n			customUserAgent: \"User-Agent\","]]) {
		const changed = replace(transformed, search, replacement);
		if (changed === void 0) return {
			source,
			changed: false
		};
		transformed = changed;
	}
	const creationState = replaceInFunction(transformed, "CustomProviderCard", "			const [baseURL, setBaseURL] = (0, react.useState)(\"\");\n			const [protocol, setProtocol]", "			const [baseURL, setBaseURL] = (0, react.useState)(\"\");\n			const [userAgent, setUserAgent] = (0, react.useState)(\"\");\n			const [protocol, setProtocol]");
	if (creationState === void 0) return {
		source,
		changed: false
	};
	transformed = creationState;
	const creationProfile = replaceInFunction(transformed, "CustomProviderCard", "						models: models.map((model) => ({ ...model }))\n					};", "						models: models.map((model) => ({ ...model })),\n						...userAgent.trim().length === 0 ? {} : { headers: { \"User-Agent\": userAgent.trim() } }\n					};");
	if (creationProfile === void 0) return {
		source,
		changed: false
	};
	transformed = creationProfile;
	const creationApiField = `\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {
\t\t\t\t\t\tclassName: ModelsSection_module_css_default["field"],
\t\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("span", {
\t\t\t\t\t\t\tclassName: ModelsSection_module_css_default["fieldLabel"],
\t\t\t\t\t\t\tchildren: t("customApi")`;
	const creationField = replaceInFunction(transformed, "CustomProviderCard", creationApiField, `\t\t\t\t\t(0, react_jsx_runtime.jsxs)("div", {
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
\t\t\t\t\t` + creationApiField);
	if (creationField === void 0) return {
		source,
		changed: false
	};
	transformed = creationField;
	const editorState = `\t\t\tconst setField = (key, next) => {
\t\t\t\tconst value = next === void 0 || next.trim().length === 0 ? void 0 : next;
\t\t\t\tsetDraft((current) => value === void 0 ? schema.deletePath(current, [key]) : schema.setPath(current, [key], value));
\t\t\t};`;
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
\t\t\t};`;
	const editorStateChanged = replaceInFunction(transformed, "ProviderEditor", editorState, editorUserAgentState);
	if (editorStateChanged === void 0) return {
		source,
		changed: false
	};
	transformed = editorStateChanged;
	const editorField = replaceInFunction(transformed, "ProviderEditor", "							family === \"deepseek\" ? (0, react_jsx_runtime.jsx)(DeepSeekModelsEditor, {", `\t\t\t\t\t\t\townsIdentity ? (0, react_jsx_runtime.jsxs)("div", {
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
							family === "deepseek" ? (0, react_jsx_runtime.jsx)(DeepSeekModelsEditor, {`);
	if (editorField === void 0) return {
		source,
		changed: false
	};
	return {
		source: editorField,
		changed: true
	};
}
function installCustomProviderUserAgentHook(transformSource) {
	const globalObject = globalThis;
	const hookKey = "__dshDesktopCustomProviderUserAgentHook";
	if (globalObject[hookKey]?.version === 1) return "already-installed";
	const loaderHook = globalObject.__dshDesktopConversationReplayHook;
	if (typeof loaderHook?.registerModuleFactoryTransform !== "function") return "loader-hook-unavailable";
	try {
		const transform = Function(`return (${transformSource})`)();
		if (loaderHook.registerModuleFactoryTransform("@deepseek-ai/dsh-client-ui-settings-models", (factory) => {
			const result = transform(Function.prototype.toString.call(factory));
			if (result?.changed !== true || typeof result.source !== "string") return factory;
			try {
				const rebuilt = Function(`return (${result.source})`)();
				return typeof rebuilt === "function" ? rebuilt : factory;
			} catch (error) {
				console.error("桌面壳自定义提供方 User-Agent 注入失败", error);
				return factory;
			}
		}) !== true) return "registration-failed";
		Object.defineProperty(globalObject, hookKey, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: Object.freeze({ version: 1 })
		});
		return "installed";
	} catch (error) {
		console.error("桌面壳自定义提供方 User-Agent 注入失败", error);
		return "registration-failed";
	}
}
//#endregion
//#region src/custom-provider-multimedia-injector.ts
function injectCustomProviderMultimediaFactorySource(source) {
	const replace = (input, search, replacement) => {
		const index = input.indexOf(search);
		if (index < 0) return void 0;
		return input.slice(0, index) + replacement + input.slice(index + search.length);
	};
	const replaceInFunction = (input, name, search, replacement) => {
		const start = input.indexOf(`function ${name}`);
		if (start < 0) return void 0;
		const next = input.indexOf("\n		function ", start + name.length);
		const end = next < 0 ? input.length : next;
		const changed = replace(input.slice(start, end), search, replacement);
		return changed === void 0 ? void 0 : input.slice(0, start) + changed + input.slice(end);
	};
	let transformed = source;
	const enAnchor = "customApiUnset: \"Not selected\",";
	const enInsertion = `customApiUnset: "Not selected",
			protocolOpenAiImages: "OpenAI Image Generations",
			modelOutputTypes: "Output modalities",
			modelOutputImage: "Image",
			modelOutputAudio: "Audio",
			modelOutputVideo: "Video",`;
	const zhAnchor = "customApiUnset: \"未选择\",";
	const zhInsertion = `customApiUnset: "未选择",
			protocolOpenAiImages: "OpenAI 图像生成",
			modelOutputTypes: "输出类型",
			modelOutputImage: "图片",
			modelOutputAudio: "音频",
			modelOutputVideo: "视频",`;
	const enChanged = replace(transformed, enAnchor, enInsertion);
	if (enChanged === void 0) return {
		source,
		changed: false
	};
	transformed = enChanged;
	const zhChanged = replace(transformed, zhAnchor, zhInsertion);
	if (zhChanged === void 0) return {
		source,
		changed: false
	};
	transformed = zhChanged;
	const protoKeysChanged = replace(transformed, "protocolOpenAiCompletions\",", `protocolOpenAiCompletions",
			"openai-image-generations": "protocolOpenAiImages",`);
	if (protoKeysChanged === void 0) return {
		source,
		changed: false
	};
	transformed = protoKeysChanged;
	const choicesChanged = replaceInFunction(transformed, "protocolChoices", "return list.list.map((entry) => entry.value).filter((value) => typeof value === \"string\");", `const items = list.list.map((entry) => entry.value).filter((value) => typeof value === "string");
			if (!items.includes("openai-image-generations")) items.push("openai-image-generations");
			return items;`);
	if (choicesChanged === void 0) return {
		source,
		changed: false
	};
	transformed = choicesChanged;
	const componentInjected = replace(transformed, `				})]
			});
		}
		//#endregion`, `				})]
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
		//#endregion`);
	if (componentInjected === void 0) return {
		source,
		changed: false
	};
	transformed = componentInjected;
	const modelRowInjected = replaceInFunction(transformed, "ModelRow", `(0, react_jsx_runtime.jsx)(ModelInputTypes, {
						model,
						field: props.inputField,
						position,
						fallback: props.inputFallback,
						disabled: disabled || props.inputLoading === true,
						t,
						onChange: props.onChange
					})`, `(0, react_jsx_runtime.jsx)(ModelInputTypes, {
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
					})`);
	if (modelRowInjected === void 0) return {
		source,
		changed: false
	};
	transformed = modelRowInjected;
	return {
		source: transformed,
		changed: true
	};
}
function installCustomProviderMultimediaHook(transformSource) {
	const globalObject = globalThis;
	const hookKey = "__dshDesktopCustomProviderMultimediaHook";
	if (globalObject[hookKey]?.version === 1) return "already-installed";
	const loaderHook = globalObject.__dshDesktopConversationReplayHook;
	if (typeof loaderHook?.registerModuleFactoryTransform !== "function") return "loader-hook-unavailable";
	try {
		const transform = Function(`return (${transformSource})`)();
		if (loaderHook.registerModuleFactoryTransform("@deepseek-ai/dsh-client-ui-settings-models", (factory) => {
			const result = transform(Function.prototype.toString.call(factory));
			if (result?.changed !== true || typeof result.source !== "string") return factory;
			try {
				const rebuilt = Function(`return (${result.source})`)();
				return typeof rebuilt === "function" ? rebuilt : factory;
			} catch (error) {
				console.error("桌面壳多媒体模型设置注入失败", error);
				return factory;
			}
		}) !== true) return "registration-failed";
		Object.defineProperty(globalObject, hookKey, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: Object.freeze({ version: 1 })
		});
		return "installed";
	} catch (error) {
		console.error("桌面壳多媒体模型设置注入失败", error);
		return "registration-failed";
	}
}
const INSTALL_MULTIMEDIA_DISPLAY_SOURCE = `(function () {
  const globalObject = globalThis;
  if (globalObject.__dshDesktopMultimediaDisplayHookInstalled) return;
  globalObject.__dshDesktopMultimediaDisplayHookInstalled = true;

  const AUDIO_EXT_REGEX = /\\.(mp3|wav|ogg|m4a|aac|flac)(\\?[^#]*)?(#.*)?$/i;
  const VIDEO_EXT_REGEX = /\\.(mp4|webm|mov|m4v|mkv|ogv)(\\?[^#]*)?(#.*)?$/i;
  const IMAGE_EXT_REGEX = /\\.(png|jpe?g|gif|webp|svg|bmp)(\\?[^#]*)?(#.*)?$/i;

  function detectMediaType(src) {
    const url = (src || '').trim();
    if (!url) return 'unknown';
    if (url.startsWith('data:audio/')) return 'audio';
    if (url.startsWith('data:video/')) return 'video';
    if (url.startsWith('data:image/')) return 'image';
    if (AUDIO_EXT_REGEX.test(url)) return 'audio';
    if (VIDEO_EXT_REGEX.test(url)) return 'video';
    if (IMAGE_EXT_REGEX.test(url)) return 'image';
    return 'unknown';
  }

  function showImageLightbox(src, alt) {
    const existing = document.getElementById('dsh-media-lightbox-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'dsh-media-lightbox-overlay';
    overlay.className = 'dsh-lightbox-overlay';

    const img = document.createElement('img');
    img.src = src;
    img.alt = alt || 'Preview';
    img.className = 'dsh-lightbox-img';

    const toolbar = document.createElement('div');
    toolbar.className = 'dsh-lightbox-toolbar';

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.textContent = '复制链接';
    copyBtn.className = 'dsh-lightbox-btn';
    copyBtn.onclick = (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(src);
      copyBtn.textContent = '已复制！';
      setTimeout(() => { copyBtn.textContent = '复制链接'; }, 1500);
    };

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.textContent = '新窗口打开';
    openBtn.className = 'dsh-lightbox-btn';
    openBtn.onclick = (e) => {
      e.stopPropagation();
      window.open(src, '_blank');
    };

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '关闭 (ESC)';
    closeBtn.className = 'dsh-lightbox-btn dsh-lightbox-close';
    closeBtn.onclick = () => overlay.remove();

    toolbar.appendChild(copyBtn);
    toolbar.appendChild(openBtn);
    toolbar.appendChild(closeBtn);

    overlay.appendChild(img);
    overlay.appendChild(toolbar);

    overlay.onclick = () => overlay.remove();
    img.onclick = (e) => e.stopPropagation();

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', keyHandler);
      }
    };
    document.addEventListener('keydown', keyHandler);

    if (document.body) document.body.appendChild(overlay);
  }

  function enhanceMultimediaElements(container) {
    const root = container || document.body || document.documentElement;
    if (!root) return;

    const linkList = root.querySelectorAll ? Array.from(root.querySelectorAll('a[href]:not([data-dsh-media-enhanced])')) : [];
    linkList.forEach((a) => {
      const href = a.getAttribute('href') || '';
      const mediaType = detectMediaType(href);
      if (mediaType === 'audio' || mediaType === 'video') {
        a.setAttribute('data-dsh-media-enhanced', 'true');
        const card = document.createElement('div');
        card.className = 'dsh-multimedia-card';
        card.setAttribute('data-media-type', mediaType);

        const header = document.createElement('div');
        header.className = 'dsh-multimedia-header';
        header.textContent = mediaType === 'audio' ? '🎵 音频播放' : '🎬 视频播放';

        const player = document.createElement(mediaType);
        player.controls = true;
        player.preload = 'metadata';
        player.src = href;
        player.className = 'dsh-multimedia-player';

        const footer = document.createElement('div');
        footer.className = 'dsh-multimedia-footer';
        const originalLink = document.createElement('a');
        originalLink.href = href;
        originalLink.target = '_blank';
        originalLink.rel = 'noreferrer noopener';
        originalLink.textContent = a.textContent?.trim() || '打开原始媒体链接';
        footer.appendChild(originalLink);

        card.appendChild(header);
        card.appendChild(player);
        card.appendChild(footer);

        if (a.parentNode) {
          a.parentNode.insertBefore(card, a.nextSibling);
        }
      }
    });

    const imageList = root.querySelectorAll ? Array.from(root.querySelectorAll('img:not([data-dsh-media-lightbox])')) : [];
    imageList.forEach((img) => {
      img.setAttribute('data-dsh-media-lightbox', 'processed');
      if (img.closest && img.closest('a') !== null) return;

      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (e) => {
        e?.stopPropagation?.();
        showImageLightbox(img.src, img.alt);
      });
    });
  }

  const init = () => {
    const targetHead = document.head || document.getElementsByTagName('head')[0] || document.documentElement;
    if (targetHead && !document.getElementById('dsh-multimedia-display-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'dsh-multimedia-display-style';
      styleEl.textContent = ` + JSON.stringify(`
.dsh-multimedia-card {
  margin: 10px 0;
  padding: 12px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.05));
  border: 1px solid var(--dsw-alias-stroke-primary, rgba(0, 0, 0, 0.1));
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
}
.dsh-multimedia-header {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary, #666);
}
.dsh-multimedia-player {
  width: 100%;
  max-width: 600px;
  border-radius: 8px;
  outline: none;
}
.dsh-multimedia-footer {
  font-size: 12px;
  opacity: 0.8;
}
.dsh-lightbox-overlay {
  position: fixed;
  inset: 0;
  z-index: 999999;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  backdrop-filter: blur(4px);
  padding: 24px;
}
.dsh-lightbox-img {
  max-width: 90vw;
  max-height: 80vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.5);
}
.dsh-lightbox-toolbar {
  margin-top: 16px;
  display: flex;
  gap: 12px;
}
.dsh-lightbox-btn {
  padding: 6px 14px;
  border-radius: 6px;
  border: none;
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  transition: background 0.15s ease;
}
.dsh-lightbox-btn:hover {
  background: rgba(255, 255, 255, 0.35);
}
`) + `;
      targetHead.appendChild(styleEl);
    }

    const targetBody = document.body || document.documentElement;
    if (targetBody) {
      const observer = new MutationObserver(() => {
        enhanceMultimediaElements(targetBody);
      });
      observer.observe(targetBody, {
        childList: true,
        subtree: true
      });
      enhanceMultimediaElements(targetBody);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})()`;
function installMultimediaDisplayHook(scriptSource = INSTALL_MULTIMEDIA_DISPLAY_SOURCE) {
	try {
		Function(scriptSource)();
	} catch (err) {
		console.error("桌面壳多媒体内容展示与播放注入失败", err);
	}
}
//#endregion
//#region src/open-in-app-compatibility.ts
/** Serialized into the main world: no imports or closure dependencies. */
function injectOpenInAppFactorySource(source) {
	if (source.includes("__dshDesktopOpenExplorer")) return {
		source,
		changed: false
	};
	const methodStart = source.indexOf("async launch(appId, path) {");
	if (methodStart < 0) return {
		source,
		changed: false
	};
	const methodEnd = source.indexOf("async run()", methodStart + 27);
	const bodyStart = source.indexOf("const body = {", methodStart + 27);
	if (bodyStart < 0 || methodEnd >= 0 && bodyStart >= methodEnd) return {
		source,
		changed: false
	};
	const lineStart = source.lastIndexOf("\n", bodyStart) + 1;
	const indentation = source.slice(lineStart, bodyStart);
	const injected = [
		`${indentation}const __dshDesktopOpenExplorer = globalThis.dshDesktopOpenInApp?.openExplorer;`,
		`${indentation}if (appId === "explorer" && typeof __dshDesktopOpenExplorer === "function") {`,
		`${indentation}\ttry {`,
		`${indentation}\t\tawait __dshDesktopOpenExplorer(path);`,
		`${indentation}\t\tthis.operation.set({ phase: "idle", path });`,
		`${indentation}\t} catch (error) {`,
		`${indentation}\t\tthis.operation.set({ phase: "error", path });`,
		`${indentation}\t\tthrow error;`,
		`${indentation}\t}`,
		`${indentation}\treturn;`,
		`${indentation}}`
	].join("\n") + "\n";
	return {
		source: source.slice(0, lineStart) + injected + source.slice(lineStart),
		changed: true
	};
}
/** Serialized into the main world: no imports or closure dependencies. */
function installOpenInAppCompatibilityHook(transformSource) {
	const root = globalThis;
	const hookKey = "__dshDesktopOpenInAppCompatibilityHook";
	if (root[hookKey]?.version === 1) return "already-installed";
	const loaderHook = root.__dshDesktopConversationReplayHook;
	if (typeof loaderHook?.registerModuleFactoryTransform !== "function") return "loader-hook-unavailable";
	try {
		const transform = Function(`return (${transformSource})`)();
		if (loaderHook.registerModuleFactoryTransform("@deepseek-ai/dsh-client-ui-open-in-app", (factory) => {
			const result = transform(Function.prototype.toString.call(factory));
			if (result?.changed !== true || typeof result.source !== "string") return factory;
			try {
				const rebuilt = Function(`return (${result.source})`)();
				return typeof rebuilt === "function" ? rebuilt : factory;
			} catch (error) {
				console.error("桌面壳文件资源管理器兼容注入失败", error);
				return factory;
			}
		}) !== true) return "registration-failed";
		Object.defineProperty(root, hookKey, {
			configurable: true,
			enumerable: false,
			writable: false,
			value: Object.freeze({ version: 1 })
		});
		return "installed";
	} catch (error) {
		console.error("桌面壳文件资源管理器兼容注入失败", error);
		return "registration-failed";
	}
}
//#endregion
//#region src/usage-monitor-renderer.ts
const countFormatter = new Intl.NumberFormat("zh-CN");
const percentFormatter = new Intl.NumberFormat("zh-CN", {
	style: "percent",
	minimumFractionDigits: 1,
	maximumFractionDigits: 1
});
const updatedFormatter = new Intl.DateTimeFormat("zh-CN", {
	timeZone: "Asia/Shanghai",
	month: "2-digit",
	day: "2-digit",
	hour: "2-digit",
	minute: "2-digit",
	second: "2-digit",
	hour12: false
});
function formatCount(value) {
	return countFormatter.format(Number.isFinite(value) ? Math.max(0, value) : 0);
}
function formatPercent(value) {
	return percentFormatter.format(Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);
}
function installUsageMonitor(readSnapshot, subscribeProgress) {
	if (document.body.dataset.page !== "usage-monitor") return () => {};
	const element = (id) => {
		const node = document.getElementById(id);
		if (node === null) throw new Error("Missing usage monitor element: " + id);
		return node;
	};
	const text = (id, value) => {
		element(id).textContent = value;
	};
	const refresh = element("usage-refresh");
	const auto = element("usage-auto");
	const status = element("usage-status");
	const content = element("usage-content");
	const warning = element("usage-warning");
	const models = element("usage-models");
	const trend = element("usage-trend");
	const tabs = [...document.querySelectorAll("[data-range]")];
	let selected = "today";
	let snapshot;
	let error;
	let busy = false;
	let disposed = false;
	let timer;
	let unsubscribeProgress;
	let progress;
	const progressElement = element("usage-progress");
	const progressStatus = element("usage-progress-status");
	const elapsed = element("usage-elapsed");
	let startedAt = 0;
	let elapsedTimer;
	const renderStatus = () => {
		status.dataset.kind = error === void 0 ? "normal" : "error";
		status.textContent = error ?? (busy ? "正在读取用量…" : snapshot?.ranges[selected].requestCount === 0 ? "此范围暂无已记录用量" : "已同步本地记录");
		progressStatus.hidden = !busy;
		if (!busy) return;
		const current = progress;
		const discovering = current === void 0 || current.phase === "discovering";
		text("usage-progress-label", discovering ? "正在发现会话文件 · 已找到 " + formatCount(current?.discoveredFiles ?? 0) + " 个" : (current.phase === "complete" ? "扫描完成" : "正在扫描日志") + " · " + formatCount(current.processedFiles) + "/" + formatCount(current.totalFiles) + " 个文件 · " + Math.floor(current.percent) + "%");
		progressElement.max = 100;
		if (discovering) progressElement.removeAttribute("value");
		else progressElement.value = current.percent;
		progressElement.setAttribute("aria-valuetext", discovering ? "正在发现会话文件" : Math.floor(current.percent) + "%");
		const fileElement = element("usage-progress-file");
		fileElement.textContent = current?.currentFile ?? "";
		fileElement.title = current?.currentFile ?? "";
		elapsed.textContent = "已用时 " + Math.floor((Date.now() - startedAt) / 1e3) + " 秒";
	};
	const render = () => {
		renderStatus();
		for (const tab of tabs) tab.setAttribute("aria-pressed", String(tab.dataset.range === selected));
		if (snapshot === void 0) return;
		const summary = snapshot.ranges[selected];
		content.hidden = false;
		warning.hidden = snapshot.warnings.length === 0;
		warning.textContent = snapshot.warnings.join(" ");
		text("usage-updated", "更新于 " + updatedFormatter.format(new Date(snapshot.updatedAt)));
		const counts = {
			requests: summary.requestCount,
			total: summary.totalTokens,
			cache: summary.cacheReadTokens,
			days: summary.activeDays,
			"model-count": summary.models.length,
			input: summary.inputTokens,
			read: summary.cacheReadTokens,
			write: summary.cacheWriteTokens,
			output: summary.outputTokens,
			reasoning: summary.reasoningTokens
		};
		for (const [id, value] of Object.entries(counts)) text("usage-" + id, formatCount(value));
		text("usage-rate", formatPercent(summary.cacheHitRate));
		models.replaceChildren();
		for (const model of summary.models) {
			const row = document.createElement("tr");
			const name = document.createElement("td");
			const title = document.createElement("strong");
			title.textContent = model.model;
			const provider = document.createElement("span");
			provider.className = "provider";
			provider.textContent = model.provider;
			name.append(title, provider);
			row.append(name);
			const values = [
				formatCount(model.requestCount),
				formatCount(model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens),
				formatCount(model.outputTokens),
				formatCount(model.totalTokens),
				formatPercent(model.cacheHitRate)
			];
			for (const value of values) {
				const cell = document.createElement("td");
				cell.textContent = value;
				row.append(cell);
			}
			models.append(row);
		}
		element("usage-model-empty").hidden = summary.models.length > 0;
		trend.replaceChildren();
		const days = selected === "all" ? summary.daily.slice(-30) : summary.daily;
		text("usage-trend-caption", selected === "all" && summary.daily.length > 30 ? "最近 30 个活跃日 · Token / 日" : "Token / 日");
		const maximum = days.reduce((max, day) => Math.max(max, day.totalTokens), 1);
		for (const day of days) {
			const row = document.createElement("div");
			row.className = "day";
			row.title = day.date + " · " + formatCount(day.requestCount) + " 次请求 · " + formatCount(day.totalTokens) + " Token";
			const date = document.createElement("span");
			date.textContent = day.date;
			const track = document.createElement("div");
			track.className = "track";
			track.setAttribute("aria-hidden", "true");
			const bar = document.createElement("div");
			bar.className = "bar";
			bar.style.width = String(day.totalTokens / maximum * 100) + "%";
			track.append(bar);
			const value = document.createElement("span");
			value.className = "day-value";
			value.textContent = formatCount(day.totalTokens);
			row.append(date, track, value);
			trend.append(row);
		}
		element("usage-trend-empty").hidden = days.length > 0;
	};
	const load = async () => {
		if (busy || disposed) return;
		busy = true;
		progress = void 0;
		startedAt = Date.now();
		refresh.disabled = true;
		progressStatus.hidden = false;
		progressElement.value = 0;
		if (elapsedTimer !== void 0) clearInterval(elapsedTimer);
		elapsedTimer = setInterval(() => {
			if (!disposed) renderStatus();
		}, 1e3);
		content.setAttribute("aria-busy", "true");
		renderStatus();
		try {
			if (subscribeProgress !== void 0) unsubscribeProgress = subscribeProgress((nextProgress) => {
				if (!disposed) {
					progress = nextProgress;
					renderStatus();
				}
			});
			const next = await readSnapshot();
			if (disposed) return;
			snapshot = next;
			error = void 0;
		} catch {
			if (disposed) return;
			error = snapshot === void 0 ? "读取用量失败，请重试。" : "刷新失败，当前显示上次成功读取的数据。";
		} finally {
			if (!disposed) {
				busy = false;
				progress = void 0;
				if (unsubscribeProgress !== void 0) {
					unsubscribeProgress();
					unsubscribeProgress = void 0;
				}
				if (elapsedTimer !== void 0) {
					clearInterval(elapsedTimer);
					elapsedTimer = void 0;
				}
				refresh.disabled = false;
				content.setAttribute("aria-busy", "false");
				render();
			}
		}
	};
	const resetTimer = () => {
		if (timer !== void 0) clearInterval(timer);
		timer = auto.checked ? setInterval(() => {
			load();
		}, 15e3) : void 0;
	};
	const onRefresh = () => {
		load();
	};
	const onRange = (event) => {
		const range = event.currentTarget.dataset.range;
		if (range === "today" || range === "7d" || range === "30d" || range === "all") {
			selected = range;
			render();
		}
	};
	const dispose = () => {
		disposed = true;
		if (timer !== void 0) clearInterval(timer);
		if (elapsedTimer !== void 0) clearInterval(elapsedTimer);
		unsubscribeProgress?.();
		refresh.removeEventListener("click", onRefresh);
		auto.removeEventListener("change", resetTimer);
		for (const tab of tabs) tab.removeEventListener("click", onRange);
		window.removeEventListener("beforeunload", dispose);
	};
	refresh.addEventListener("click", onRefresh);
	auto.addEventListener("change", resetTimer);
	for (const tab of tabs) tab.addEventListener("click", onRange);
	window.addEventListener("beforeunload", dispose, { once: true });
	resetTimer();
	load();
	return dispose;
}
//#endregion
//#region src/koi-pond-toggle-icon.ts
const KOI_POND_TOGGLE_ICON = "data:image/png;base64,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";
//#endregion
//#region src/koi-pond-toggle.ts
const STORAGE_KEY = "dsh-pond-toggle-position";
function loadSavedPosition() {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (typeof parsed.left === "number" && typeof parsed.top === "number" && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return {
			left: parsed.left,
			top: parsed.top
		};
	} catch {}
	return null;
}
function savePosition(left, top) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({
			left,
			top
		}));
	} catch {}
}
function installKoiPondToggle(toggle, inPond = false) {
	if (document.getElementById("dsh-pond-toggle")) return;
	const host = document.createElement("div");
	host.id = "dsh-pond-toggle";
	const size = 56;
	const margin = 12;
	const saved = loadSavedPosition();
	let currentLeft;
	let currentTop;
	const winW = window.innerWidth || document.documentElement.clientWidth || 800;
	const winH = window.innerHeight || document.documentElement.clientHeight || 600;
	if (saved && saved.left >= 0 && saved.left <= winW - size && saved.top >= 0 && saved.top <= winH - size) {
		currentLeft = saved.left;
		currentTop = saved.top;
	} else {
		currentLeft = Math.max(margin, winW - size - 16);
		currentTop = Math.max(margin, winH - size - 16);
	}
	Object.assign(host.style, {
		position: "fixed",
		left: `${currentLeft}px`,
		top: `${currentTop}px`,
		width: `${size}px`,
		height: `${size}px`,
		zIndex: "2147483647",
		userSelect: "none",
		webkitUserSelect: "none",
		touchAction: "none"
	});
	const shadow = host.attachShadow({ mode: "open" });
	const style = new CSSStyleSheet();
	style.replaceSync(`
    :host {
      display: block;
    }
    button {
      width: 100%;
      height: 100%;
      box-sizing: border-box;
      border: none;
      border-radius: 0;
      background-color: transparent;
      background-image: url('${KOI_POND_TOGGLE_ICON}');
      background-repeat: no-repeat;
      background-position: center;
      background-size: contain;
      filter: drop-shadow(0 4px 10px rgba(0, 0, 0, 0.25));
      cursor: grab;
      padding: 0;
      -webkit-app-region: no-drag;
      transition: transform 0.15s ease, filter 0.15s ease;
      outline: none;
    }
    button:hover {
      transform: scale(1.12);
      filter: drop-shadow(0 6px 14px rgba(0, 0, 0, 0.35));
    }
    button:active {
      cursor: grabbing;
      transform: scale(0.96);
    }
    button:focus-visible {
      filter: drop-shadow(0 0 6px #40877f);
    }
    button:disabled {
      opacity: 0.6;
      cursor: wait;
    }
    span {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      font: 12px system-ui;
      background: #173e39;
      color: white;
      padding: 6px 10px;
      border-radius: 4px;
      display: none;
      pointer-events: none;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
      z-index: 1;
    }
    :host([data-placement="top"]) span {
      top: auto;
      bottom: calc(100% + 8px);
    }
    :host(:not([data-placement="top"])) span {
      top: calc(100% + 8px);
      bottom: auto;
    }
    button:hover + span,
    button:focus-visible + span {
      display: block;
    }
  `);
	shadow.adoptedStyleSheets = [style];
	const button = document.createElement("button");
	button.type = "button";
	const label = inPond ? "切换回对话" : "后院鱼塘";
	button.title = label;
	button.setAttribute("aria-label", label);
	button.setAttribute("aria-pressed", String(inPond));
	const tooltip = document.createElement("span");
	tooltip.textContent = label;
	let isDragging = false;
	let hasMoved = false;
	let dragStartX = 0;
	let dragStartY = 0;
	let initialLeft = currentLeft;
	let initialTop = currentTop;
	function clampPosition(left, top) {
		const maxX = Math.max(margin, (window.innerWidth || document.documentElement.clientWidth) - size - margin);
		const maxY = Math.max(margin, (window.innerHeight || document.documentElement.clientHeight) - size - margin);
		return {
			x: Math.min(Math.max(margin, left), maxX),
			y: Math.min(Math.max(margin, top), maxY)
		};
	}
	function updateTooltipPlacement(top) {
		const placement = (window.innerHeight || document.documentElement.clientHeight || 600) - (top + size) < 48 ? "top" : "bottom";
		host.setAttribute("data-placement", placement);
	}
	updateTooltipPlacement(currentTop);
	button.addEventListener("pointerdown", (event) => {
		if (event.button !== 0) return;
		isDragging = true;
		hasMoved = false;
		dragStartX = event.clientX;
		dragStartY = event.clientY;
		initialLeft = host.offsetLeft;
		initialTop = host.offsetTop;
		button.setPointerCapture(event.pointerId);
	});
	button.addEventListener("pointermove", (event) => {
		if (!isDragging) return;
		const dx = event.clientX - dragStartX;
		const dy = event.clientY - dragStartY;
		if (!hasMoved && Math.hypot(dx, dy) > 4) {
			hasMoved = true;
			tooltip.style.display = "none";
		}
		if (hasMoved) {
			const clamped = clampPosition(initialLeft + dx, initialTop + dy);
			currentLeft = clamped.x;
			currentTop = clamped.y;
			host.style.left = `${currentLeft}px`;
			host.style.top = `${currentTop}px`;
			updateTooltipPlacement(currentTop);
		}
	});
	function onPointerUp(event) {
		if (!isDragging) return;
		isDragging = false;
		try {
			if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
		} catch {}
		if (hasMoved) {
			savePosition(currentLeft, currentTop);
			setTimeout(() => {
				tooltip.style.display = "";
			}, 100);
		}
	}
	button.addEventListener("pointerup", onPointerUp);
	button.addEventListener("pointercancel", onPointerUp);
	button.addEventListener("click", (event) => {
		if (hasMoved) {
			event.preventDefault();
			event.stopPropagation();
			hasMoved = false;
			return;
		}
		tooltip.textContent = label;
		button.title = label;
		button.disabled = true;
		toggle().catch(() => {
			tooltip.textContent = "切换失败，请重试";
			button.title = tooltip.textContent;
		}).finally(() => {
			button.disabled = false;
		});
	});
	window.addEventListener("resize", () => {
		const clamped = clampPosition(host.offsetLeft, host.offsetTop);
		currentLeft = clamped.x;
		currentTop = clamped.y;
		host.style.left = `${currentLeft}px`;
		host.style.top = `${currentTop}px`;
		updateTooltipPlacement(currentTop);
	});
	shadow.append(button, tooltip);
	document.body.append(host);
}
//#endregion
//#region src/preload.ts
runIsolatedShellInjection("桌面壳对话编辑与重试注入启动失败", () => {
	electron.contextBridge.executeInMainWorld({ func: installConversationReplayModuleHook });
});
runIsolatedShellInjection("桌面壳子智能体模型徽标注入启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installSubagentModelBadgeHook,
		args: [injectSubagentModelBadgeFactorySource.toString(), SUBAGENT_MODEL_BADGE_SOURCE]
	});
});
runIsolatedShellInjection("桌面壳原会话重试客户端适配启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installDesktopReplayClientHook,
		args: [injectDesktopReplayClient.toString()]
	});
});
runIsolatedShellInjection("桌面壳自定义提供方 User-Agent 注入启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installCustomProviderUserAgentHook,
		args: [injectCustomProviderUserAgentFactorySource.toString()]
	});
});
runIsolatedShellInjection("桌面壳多媒体模型与生图协议注入启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installCustomProviderMultimediaHook,
		args: [injectCustomProviderMultimediaFactorySource.toString()]
	});
});
runIsolatedShellInjection("桌面壳多媒体内容展示与播放注入启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installMultimediaDisplayHook,
		args: [INSTALL_MULTIMEDIA_DISPLAY_SOURCE]
	});
});
runIsolatedShellInjection("桌面壳文件资源管理器兼容注入启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installOpenInAppCompatibilityHook,
		args: [injectOpenInAppFactorySource.toString()]
	});
});
electron.contextBridge.exposeInMainWorld("dshDesktopFiles", { getAbsolutePath: (file) => electron.webUtils.getPathForFile(file) });
electron.contextBridge.exposeInMainWorld("dshDesktopOpenInApp", { openExplorer: (path) => electron.ipcRenderer.invoke("open-in-app:explorer", path) });
runIsolatedShellInjection("鱼塘成长观察启动失败", () => {
	electron.contextBridge.executeInMainWorld({
		func: installKoiPondDialogueHook,
		args: [injectKoiPondDialogue.toString()]
	});
});
window.addEventListener("message", (event) => {
	if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "dsh/pond-dialogue") return;
	const { sessionId, requestId } = event.data;
	if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128 || typeof requestId !== "string" || requestId.length === 0 || requestId.length > 128) return;
	electron.ipcRenderer.send("pond:dialogue", sessionId, requestId);
});
window.addEventListener("message", (event) => {
	if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== "dsh/session-running") return;
	const value = event.data;
	if (typeof value.sessionId !== "string" || typeof value.requestId !== "string" || typeof value.running !== "boolean") return;
	electron.ipcRenderer.send("pond:session-running", value.sessionId, value.requestId, value.running, value.projectName, value.output, value.approval, value.sessionLabel, value.subAgent);
});
electron.contextBridge.exposeInMainWorld("dshDesktopSkins", {
	list: () => electron.ipcRenderer.invoke("shell-skins:list"),
	preview: (skinId, index) => electron.ipcRenderer.invoke("shell-skins:preview", skinId, index),
	install: (skinId) => electron.ipcRenderer.invoke("shell-skins:install", skinId),
	activate: (skinId) => electron.ipcRenderer.invoke("shell-skins:activate", skinId),
	selectVariant: (skinId, variantId) => electron.ipcRenderer.invoke("shell-skins:select-variant", skinId, variantId),
	deactivate: () => electron.ipcRenderer.invoke("shell-skins:deactivate"),
	uninstall: (skinId) => electron.ipcRenderer.invoke("shell-skins:uninstall", skinId),
	onProgress: (listener) => {
		const wrapped = (_event, progress) => listener(progress);
		electron.ipcRenderer.on("shell-skins:progress", wrapped);
		return () => {
			electron.ipcRenderer.removeListener("shell-skins:progress", wrapped);
		};
	}
});
const PET_ACTIVE_SESSION_MESSAGE = "dsh/desktop-pet-active-session";
function petActiveSession(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const payload = value;
	if (payload.type !== PET_ACTIVE_SESSION_MESSAGE) return void 0;
	if (payload.sessionId === null) return null;
	if (typeof payload.sessionId !== "string" || payload.sessionId.length === 0 || payload.sessionId.length > 128 || !/^[0-9A-Za-z._~-]+$/u.test(payload.sessionId)) return void 0;
	return payload.sessionId;
}
window.addEventListener("message", (event) => {
	if (event.source !== window || event.origin !== window.location.origin) return;
	const sessionId = petActiveSession(event.data);
	if (sessionId !== void 0) electron.ipcRenderer.send("pet:set-active-session", sessionId);
});
function element(id) {
	const value = document.querySelector("#" + id);
	if (value === null) throw new Error("page is missing #" + id);
	return value;
}
let runtimeRecoveryIds = [];
let runtimeRecoveryCount = 0;
let runtimeBundleRecovery;
let runtimePresetRecovery;
let runtimeLatestView;
let runtimeDraftMode;
let runtimeDraftVersion;
let runtimePreferenceTouched = false;
let runtimeManagerMode = false;
let runtimeRefreshing = false;
const runtimePhaseLabels = {
	checking: "检查中",
	downloading: "下载中",
	starting: "启动中",
	ready: "已就绪",
	error: "需要处理"
};
function runtimePreferenceMatches(view) {
	if (runtimeDraftMode !== view.preference.mode) return false;
	return runtimeDraftMode === "latest-compatible" || view.preference.mode === "pinned" && runtimeDraftVersion === view.preference.version;
}
function renderRuntime(view) {
	runtimeLatestView = view;
	if (!runtimePreferenceTouched) {
		runtimeDraftMode = view.preference.mode;
		runtimeDraftVersion = view.preference.mode === "pinned" ? view.preference.version : void 0;
	}
	runtimeDraftMode ??= "latest-compatible";
	const availableVersions = view.versions.filter((version, index, versions) => versions.findIndex((candidate) => candidate.version === version.version) === index);
	const fallbackVersion = availableVersions.find((version) => version.current)?.version ?? availableVersions[0]?.version;
	runtimeDraftVersion ??= fallbackVersion;
	const busy = runtimeRefreshing || view.phase === "checking" || view.phase === "downloading" || view.phase === "starting";
	document.body.dataset.phase = view.phase;
	document.body.dataset.view = runtimeManagerMode ? "manager" : "startup";
	element("version-settings").hidden = !runtimeManagerMode;
	element("runtime-page").setAttribute("aria-busy", String(busy));
	element("phase-chip").textContent = runtimePhaseLabels[view.phase];
	element("shell-version").textContent = "Shell " + view.shellVersion + " · 最低 DSH " + view.minimumDshVersion;
	element("message").textContent = view.message;
	const versionDetail = view.currentVersion === void 0 ? "" : "当前使用：DSH " + view.currentVersion;
	runtimeRecoveryIds = view.recovery?.kind === "stale-local-plugins" ? view.recovery.entryIds : [];
	runtimeRecoveryCount = view.recovery?.kind === "stale-local-plugins" ? view.recovery.count : runtimeRecoveryIds.length;
	runtimeBundleRecovery = view.recovery?.kind === "profile-bundle-mismatch" ? {
		packageNames: view.recovery.packageNames,
		count: view.recovery.count
	} : void 0;
	runtimePresetRecovery = view.recovery?.kind === "plugin-preset-conflict" ? {
		pluginName: view.recovery.pluginName,
		presetId: view.recovery.presetId
	} : void 0;
	const staleDetail = runtimeRecoveryIds.length === 0 ? "" : "检测到失效的本地插件：" + runtimeRecoveryIds.join("、");
	const bundleDetail = runtimeBundleRecovery === void 0 ? "" : "检测到不兼容的 Profile bundle：" + runtimeBundleRecovery.packageNames.join("、");
	const presetDetail = runtimePresetRecovery === void 0 ? "" : "检测到冲突的插件预设：" + runtimePresetRecovery.presetId;
	element("detail").textContent = [
		versionDetail,
		staleDetail,
		bundleDetail,
		presetDetail
	].filter((value) => value.length > 0).join("\n");
	const progressElement = element("runtime-progress");
	const progressRow = element("runtime-progress-row");
	const progress = view.progress === void 0 || view.progress.total === 0 ? void 0 : Math.max(0, Math.min(100, view.progress.received / view.progress.total * 100));
	const indeterminate = busy && progress === void 0;
	progressRow.hidden = !busy;
	progressElement.dataset.indeterminate = String(indeterminate);
	element("progress-value").style.width = String(progress ?? 0) + "%";
	if (progress === void 0) progressElement.removeAttribute("aria-valuenow");
	else progressElement.setAttribute("aria-valuenow", progress.toFixed(1));
	element("progress-label").textContent = progress !== void 0 ? progress.toLocaleString("zh-CN", { maximumFractionDigits: 0 }) + "%" : view.phase === "checking" ? "正在检查" : view.phase === "starting" ? "正在连接" : "正在准备";
	element("cache").style.display = view.cachedCatalog ? "block" : "none";
	const upstream = element("upstream-status");
	upstream.hidden = view.upstream === void 0;
	upstream.textContent = view.upstream === void 0 ? "" : view.upstream.status === "error" ? "上游版本检查失败，请稍后刷新" : "上游最新：DSH " + view.upstream.version + (view.upstream.status === "pending" ? view.cachedCatalog ? " · 桌面目录离线，可用状态待确认" : " · 等待桌面包发布" : view.upstream.status === "shell-required" ? " · 需要更新 Shell" : " · 桌面包已可用");
	const error = element("error");
	error.textContent = view.error ?? "";
	error.style.display = view.error === void 0 ? "none" : "block";
	const autoInput = element("version-mode-auto");
	const pinnedInput = element("version-mode-pinned");
	autoInput.checked = runtimeDraftMode === "latest-compatible";
	pinnedInput.checked = runtimeDraftMode === "pinned";
	autoInput.disabled = busy;
	pinnedInput.disabled = busy;
	const select = element("version");
	select.replaceChildren();
	const selectedAvailable = availableVersions.some((version) => version.version === runtimeDraftVersion);
	if (runtimeDraftVersion !== void 0 && !selectedAvailable) {
		const unavailable = document.createElement("option");
		unavailable.value = runtimeDraftVersion;
		unavailable.textContent = runtimeDraftVersion + " · 当前兼容目录中不可用";
		select.append(unavailable);
	}
	for (const version of availableVersions) {
		const option = document.createElement("option");
		option.value = version.version;
		option.textContent = version.version + (version.current ? "（当前使用）" : "");
		select.append(option);
	}
	if (runtimeDraftVersion !== void 0) select.value = runtimeDraftVersion;
	const pinned = runtimeDraftMode === "pinned";
	const selectedVersion = availableVersions.find((version) => version.version === runtimeDraftVersion);
	const targetVersion = pinned ? selectedVersion : availableVersions[0];
	const pinnedField = element("pinned-version-field");
	pinnedField.dataset.active = String(pinned);
	select.disabled = busy || !pinned || availableVersions.length === 0;
	element("strategy-summary").textContent = pinned ? "保持在指定版本" : "自动跟随最新兼容版本";
	element("version-meta").textContent = !pinned ? "切换到固定版本后可选择" : selectedVersion === void 0 ? "当前选择不可用" : selectedVersion.current ? "当前使用" : "";
	const selectionVersion = element("selection-version");
	const selectionDetail = element("selection-detail");
	if (targetVersion === void 0) {
		selectionVersion.textContent = busy ? "正在读取版本目录" : pinned && runtimeDraftVersion !== void 0 ? "固定 · DSH " + runtimeDraftVersion : "尚无兼容版本";
		selectionDetail.textContent = busy ? "完成检查后将显示目标版本" : pinned && runtimeDraftVersion !== void 0 ? "该版本不在当前兼容目录，请选择其他版本" : "刷新版本目录后将显示可用版本";
	} else {
		selectionVersion.textContent = "DSH " + targetVersion.version;
		selectionDetail.textContent = targetVersion.current ? "当前使用" : "";
	}
	const applyButton = element("apply");
	const targetChanged = targetVersion !== void 0 && (targetVersion.version !== view.currentVersion || targetVersion.runtimeRevision !== view.currentRuntimeRevision);
	applyButton.textContent = pinned && runtimeDraftVersion !== void 0 ? "固定到 " + runtimeDraftVersion : targetChanged ? "更新到 " + targetVersion.version : "使用自动策略";
	applyButton.disabled = busy || targetVersion === void 0 || runtimePreferenceMatches(view) && !targetChanged;
	element("retry").disabled = busy;
	element("retry").textContent = runtimeRefreshing ? "正在检查版本" : "刷新版本目录";
	const startupRetry = element("startup-retry");
	startupRetry.hidden = runtimeManagerMode || view.phase !== "error";
	startupRetry.disabled = busy;
	const recoverButton = element("recover-stale-plugins");
	recoverButton.hidden = runtimeRecoveryIds.length === 0;
	recoverButton.disabled = busy || runtimeRecoveryIds.length === 0;
	recoverButton.textContent = runtimeRecoveryCount <= 1 ? "禁用失效本地插件并重试" : "禁用 " + String(runtimeRecoveryCount) + " 个失效本地插件并重试";
	const bundleButton = element("recover-profile-bundles");
	bundleButton.hidden = runtimeBundleRecovery === void 0;
	bundleButton.disabled = busy || runtimeBundleRecovery === void 0;
	bundleButton.textContent = runtimeBundleRecovery === void 0 || runtimeBundleRecovery.count <= 1 ? "修复不兼容插件配置并重试" : "修复 " + String(runtimeBundleRecovery.count) + " 个不兼容插件配置并重试";
	const presetButton = element("recover-plugin-preset");
	presetButton.hidden = runtimePresetRecovery === void 0;
	presetButton.disabled = busy || runtimePresetRecovery === void 0;
	element("startup-actions").hidden = startupRetry.hidden && recoverButton.hidden && bundleButton.hidden && presetButton.hidden;
}
function initializeShellUpdatePage() {
	electron.ipcRenderer.on("shell-update:progress", (_event, progress) => {
		const downloading = progress.state === "downloading";
		const preparing = progress.state === "preparing-restart";
		const version = downloading || preparing ? progress.version : "";
		const progressElement = element("progress");
		element("version").textContent = version.length === 0 ? "Shell 更新" : "Shell " + version;
		if (downloading) {
			const percent = Math.max(0, Math.min(100, progress.percent));
			progressElement.value = percent;
			element("percent").textContent = percent.toFixed(1) + "%";
			element("transferred").textContent = formatBytes(progress.transferred);
			element("total").textContent = formatBytes(progress.total);
			element("speed").textContent = formatBytes(progress.bytesPerSecond) + "/s";
		} else {
			progressElement.removeAttribute("value");
			element("percent").textContent = preparing ? "完成" : "";
			element("transferred").textContent = "";
			element("total").textContent = "";
			element("speed").textContent = "";
		}
		element("status").textContent = progress.state === "error" ? progress.message : preparing ? "下载完成，正在关闭 Runtime 并准备重启..." : downloading ? "正在下载更新，完成后将自动安装并重启。" : progress.state === "checking" ? "正在检查更新..." : "当前已是最新版本。";
	});
}
function initializeRuntimePage() {
	runtimeManagerMode = new URLSearchParams(window.location.search).get("view") === "manager";
	document.body.dataset.view = runtimeManagerMode ? "manager" : "startup";
	element("version-settings").hidden = !runtimeManagerMode;
	const showError = (error) => {
		const errorElement = element("error");
		errorElement.textContent = errorMessage(error);
		errorElement.style.display = "block";
	};
	const rerender = () => {
		if (runtimeLatestView !== void 0) renderRuntime(runtimeLatestView);
	};
	electron.ipcRenderer.on("runtime:view", (_event, view) => {
		renderRuntime(view);
	});
	element("version-mode-auto").addEventListener("change", (event) => {
		if (!event.currentTarget.checked) return;
		runtimePreferenceTouched = true;
		runtimeDraftMode = "latest-compatible";
		rerender();
	});
	element("version-mode-pinned").addEventListener("change", (event) => {
		if (!event.currentTarget.checked) return;
		runtimePreferenceTouched = true;
		runtimeDraftMode = "pinned";
		runtimeDraftVersion ??= runtimeLatestView?.versions.find((version) => version.current)?.version ?? runtimeLatestView?.versions[0]?.version;
		rerender();
	});
	element("version").addEventListener("change", (event) => {
		runtimePreferenceTouched = true;
		runtimeDraftMode = "pinned";
		runtimeDraftVersion = event.currentTarget.value;
		rerender();
	});
	const retry = () => {
		electron.ipcRenderer.invoke("runtime:retry").catch(showError);
	};
	const refresh = async () => {
		if (runtimeRefreshing) return;
		runtimeRefreshing = true;
		rerender();
		element("retry").disabled = true;
		let refreshError;
		try {
			renderRuntime(await electron.ipcRenderer.invoke("runtime:get-view"));
		} catch (error) {
			refreshError = error;
		} finally {
			runtimeRefreshing = false;
			rerender();
			if (runtimeLatestView === void 0) element("retry").disabled = false;
			if (refreshError !== void 0) showError(refreshError);
		}
	};
	element("retry").addEventListener("click", () => {
		refresh();
	});
	element("startup-retry").addEventListener("click", retry);
	element("recover-stale-plugins").addEventListener("click", () => {
		if (runtimeRecoveryIds.length === 0) return;
		const names = runtimeRecoveryIds.join("、");
		if (!window.confirm("将备份配置并禁用 " + String(runtimeRecoveryCount) + " 个失效本地插件：" + names + "。会话、设置和其他插件不会被删除。是否继续？")) return;
		electron.ipcRenderer.invoke("runtime:recover-stale-local-plugins").catch(showError);
	});
	element("recover-profile-bundles").addEventListener("click", () => {
		const recovery = runtimeBundleRecovery;
		if (recovery === void 0) return;
		const message = "将备份 Web profile 配置，并从 bundle 层列表移除不兼容项：" + recovery.packageNames.join("、") + "。插件依赖、插件配置、会话和设置都会保留。是否继续？";
		if (!window.confirm(message)) return;
		electron.ipcRenderer.invoke("runtime:recover-profile-bundles").catch(showError);
	});
	element("recover-plugin-preset").addEventListener("click", () => {
		const recovery = runtimePresetRecovery;
		if (recovery === void 0) return;
		const message = "将完整备份预设 " + recovery.presetId + "，再用插件 " + recovery.pluginName + " 当前打包版本重置该预设。人工修改不会被删除，但会移入带 desktop-backup 标记的备份目录。是否继续？";
		if (!window.confirm(message)) return;
		electron.ipcRenderer.invoke("runtime:recover-plugin-preset").catch(showError);
	});
	element("apply").addEventListener("click", () => {
		if (runtimeDraftMode === "pinned" && runtimeDraftVersion === void 0) return;
		const preference = runtimeDraftMode === "pinned" ? {
			mode: "pinned",
			version: runtimeDraftVersion
		} : { mode: "latest-compatible" };
		electron.ipcRenderer.invoke("runtime:set-preference", preference).then(() => {
			runtimePreferenceTouched = false;
		}).catch(showError);
	});
	refresh();
}
function setHidden(id, hidden) {
	element(id).hidden = hidden;
}
function formatBytes(value) {
	if (value === void 0) return "Runtime 未返回";
	if (value < 1024) return String(value) + " B";
	const units = [
		"KB",
		"MB",
		"GB",
		"TB"
	];
	let amount = value / 1024;
	let unit = units[0] ?? "KB";
	for (let index = 1; index < units.length && amount >= 1024; index += 1) {
		amount /= 1024;
		unit = units[index] ?? unit;
	}
	return amount.toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " " + unit;
}
function errorMessage(error) {
	return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /u, "");
}
function initializePluginManagerPage() {
	const specInput = element("plugin-spec");
	const installButton = element("plugin-install");
	const refreshButton = element("plugin-refresh");
	const progress = element("plugin-progress");
	const statusElement = element("plugin-status");
	const listElement = element("plugin-list");
	const emptyElement = element("plugin-empty");
	const logSection = element("plugin-log-section");
	const logElement = element("plugin-log");
	let busy = false;
	let currentEntries = [];
	let updateVersions = /* @__PURE__ */ new Map();
	const completedUpdates = /* @__PURE__ */ new Set();
	let listGeneration = 0;
	const setStatus = (message, kind = "normal") => {
		statusElement.textContent = message;
		statusElement.dataset.kind = kind;
	};
	const setBusy = (value) => {
		busy = value;
		specInput.disabled = value;
		installButton.disabled = value;
		refreshButton.disabled = value;
		progress.hidden = !value;
		for (const button of listElement.querySelectorAll("button, input")) button.disabled = value;
	};
	const showLog = (value) => {
		logElement.textContent = value;
		logSection.hidden = value.length === 0;
		logElement.scrollTop = logElement.scrollHeight;
	};
	const renderEntries = (entries) => {
		listElement.replaceChildren();
		emptyElement.hidden = entries.length !== 0;
		for (const entry of entries) {
			const row = document.createElement("div");
			row.className = "plugin-row";
			row.setAttribute("role", "listitem");
			const main = document.createElement("div");
			main.className = "plugin-main";
			const name = document.createElement("div");
			name.className = "plugin-name";
			name.textContent = entry.name;
			const meta = document.createElement("div");
			meta.className = "plugin-meta";
			const latestVersion = completedUpdates.has(entry.name) ? void 0 : updateVersions.get(entry.name);
			meta.textContent = (entry.version === void 0 ? "未解析版本" : "版本 " + entry.version) + (latestVersion === void 0 ? "" : " · 可更新至 " + latestVersion) + (entry.spec === void 0 ? "" : " · " + entry.spec);
			main.append(name, meta);
			if (entry.isolation !== void 0) {
				const reason = document.createElement("div");
				reason.className = "plugin-isolation";
				reason.textContent = entry.isolation === "manual" ? "已禁用" : entry.isolation === "removed-client-runtime" ? "已隔离：插件依赖已移除的客户端模块" : "已隔离：插件导入不兼容";
				main.append(reason);
			}
			const actions = document.createElement("div");
			actions.className = "plugin-actions";
			if (entry.canIsolate) {
				const label = document.createElement("label");
				label.className = "plugin-toggle";
				const toggle = document.createElement("input");
				toggle.type = "checkbox";
				toggle.setAttribute("role", "switch");
				toggle.setAttribute("aria-label", entry.name + " 启用状态");
				toggle.checked = entry.isolation === void 0;
				toggle.disabled = busy;
				label.append(toggle, entry.isolation === void 0 ? "已启用" : "重新启用并验证");
				toggle.addEventListener("change", () => {
					setEnabled(entry.name, toggle.checked);
				});
				actions.append(label);
			}
			if (!completedUpdates.has(entry.name) && (latestVersion !== void 0 || entry.manualUpdate === true)) {
				const updateButton = document.createElement("button");
				updateButton.type = "button";
				updateButton.textContent = latestVersion === void 0 ? "更新" : "更新至 " + latestVersion;
				updateButton.disabled = busy;
				updateButton.addEventListener("click", () => {
					runOperation({
						action: "update",
						packageName: entry.name
					}, "更新 " + entry.name);
				});
				actions.append(updateButton);
			}
			const removeButton = document.createElement("button");
			removeButton.type = "button";
			removeButton.className = "danger";
			removeButton.textContent = "卸载";
			removeButton.addEventListener("click", () => {
				if (window.confirm("确认卸载 " + entry.name + "？")) runOperation({
					action: "remove",
					packageName: entry.name
				}, "卸载 " + entry.name);
			});
			removeButton.disabled = busy;
			actions.append(removeButton);
			row.append(main, actions);
			listElement.append(row);
		}
	};
	const loadEntries = async () => {
		const generation = ++listGeneration;
		currentEntries = (await electron.ipcRenderer.invoke("plugin-manager:list")).entries;
		updateVersions = /* @__PURE__ */ new Map();
		renderEntries(currentEntries);
		electron.ipcRenderer.invoke("plugin-manager:updates").then((updates) => {
			if (generation !== listGeneration) return;
			updateVersions = new Map(updates.entries.filter((update) => currentEntries.some((entry) => entry.name === update.name && entry.version === update.currentVersion)).map((update) => [update.name, update.latestVersion]));
			renderEntries(currentEntries);
		}).catch(() => void 0);
	};
	async function setEnabled(name, enabled) {
		if (busy) return;
		setBusy(true);
		setStatus(enabled ? "正在重新启用并验证插件..." : "正在禁用插件并重启 Runtime...");
		try {
			await electron.ipcRenderer.invoke("plugin-manager:set-enabled", name, enabled);
			setStatus(enabled ? "插件已通过启动验证并启用" : "插件已禁用", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			try {
				await loadEntries();
			} catch (error) {
				setStatus(errorMessage(error), "error");
			}
			setBusy(false);
		}
	}
	const waitForOperation = async (operationId) => {
		for (;;) {
			const value = await electron.ipcRenderer.invoke("plugin-manager:status", operationId);
			showLog(value.output);
			if (value.state !== "preparing" && value.state !== "running" && value.state !== "repairing") return value;
			await new Promise((resolve) => {
				setTimeout(resolve, 350);
			});
		}
	};
	const resumeOrRefresh = async () => {
		if (busy) return;
		setBusy(true);
		setStatus("正在读取插件状态...");
		try {
			const current = await electron.ipcRenderer.invoke("plugin-manager:current");
			if (current === void 0) {
				await loadEntries();
				setStatus("插件列表已刷新", "success");
				return;
			}
			showLog(current.output);
			const pending = current.state === "preparing" || current.state === "running" || current.state === "repairing";
			setStatus(pending ? "检测到尚未完成的插件操作，正在继续等待..." : "插件操作已完成，正在重启 Runtime...");
			const result = pending ? await waitForOperation(current.operationId) : current;
			if (result.state === "failed" || result.state === "rolled-back") throw new Error(result.error ?? "插件操作失败，已恢复原配置");
			await electron.ipcRenderer.invoke("plugin-manager:restart", result.operationId);
			if (result.action === "update" && result.packageName !== void 0) completedUpdates.add(result.packageName);
			await loadEntries();
			setStatus("插件操作已完成", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			setBusy(false);
		}
	};
	async function runOperation(input, label) {
		if (busy) return;
		setBusy(true);
		showLog("");
		setStatus(label + "，请稍候...");
		try {
			const started = await electron.ipcRenderer.invoke("plugin-manager:start", input);
			const result = await waitForOperation(started.operationId);
			if (result.state === "failed" || result.state === "rolled-back") throw new Error(result.error ?? "插件操作失败，已恢复原配置");
			setStatus(label + "完成，正在重启 Runtime...");
			await electron.ipcRenderer.invoke("plugin-manager:restart", started.operationId);
			if (input.action === "update") completedUpdates.add(input.packageName);
			await loadEntries();
			if (input.action === "add") specInput.value = "";
			setStatus(label + "完成", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
			try {
				await loadEntries();
			} catch {}
		} finally {
			setBusy(false);
		}
	}
	installButton.addEventListener("click", () => {
		const spec = specInput.value;
		if (spec.length === 0) {
			setStatus("请输入插件包名或 GitHub 地址", "error");
			specInput.focus();
			return;
		}
		runOperation({
			action: "add",
			spec
		}, "安装插件");
	});
	specInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter") installButton.click();
	});
	refreshButton.addEventListener("click", () => {
		completedUpdates.clear();
		resumeOrRefresh();
	});
	resumeOrRefresh();
}
function initializeSkillManagerPage() {
	const search = element("skill-search");
	const importButton = element("skill-import");
	const refreshButton = element("skill-refresh");
	const status = element("skill-status");
	const progress = element("skill-progress");
	const list = element("skill-list");
	const empty = element("skill-empty");
	let snapshot;
	let busy = false;
	const setStatus = (message, kind = "normal") => {
		status.textContent = message;
		status.dataset.kind = kind;
	};
	const setBusy = (value) => {
		busy = value;
		search.disabled = value;
		importButton.disabled = value;
		refreshButton.disabled = value;
		progress.hidden = !value;
		for (const control of list.querySelectorAll("input, button")) control.disabled = value;
	};
	const sourceLabel = (source) => {
		if (source === "user-dsh") return "DSH";
		if (source === "user-agents") return "Agent";
		if (source === "user-codex") return "Codex";
		if (source === "user-claude") return "Claude";
		if (source === "user-gemini") return "Gemini";
		return "Antigravity";
	};
	const visibleEntries = () => {
		const query = search.value.trim().toLocaleLowerCase("zh-CN");
		return (snapshot?.entries ?? []).filter((entry) => query.length === 0 || [
			entry.name,
			entry.description,
			entry.whenToUse ?? "",
			entry.root
		].join(" ").toLocaleLowerCase("zh-CN").includes(query));
	};
	const render = () => {
		const entries = snapshot?.entries ?? [];
		const enabledCount = entries.filter((entry) => entry.enabled).length;
		element("skill-count").textContent = String(entries.length) + " 个 Skill · " + String(enabledCount) + " 个在 DSH 中启用";
		const visible = visibleEntries();
		list.replaceChildren();
		empty.hidden = visible.length !== 0;
		empty.textContent = entries.length === 0 ? "没有识别到用户 Skill" : "没有匹配当前搜索的 Skill";
		for (const entry of visible) {
			const row = document.createElement("article");
			row.className = "skill-row";
			row.setAttribute("role", "listitem");
			const main = document.createElement("div");
			main.className = "skill-main";
			const title = document.createElement("div");
			title.className = "skill-title";
			const name = document.createElement("span");
			name.className = "skill-name";
			name.textContent = entry.name;
			title.append(name);
			for (const [label, enabled] of [["模型调用", entry.modelInvocable], ["用户调用", entry.userInvocable]]) {
				const badge = document.createElement("span");
				badge.className = enabled ? "badge" : "badge off";
				badge.textContent = label + (enabled ? "已开启" : "已关闭");
				title.append(badge);
			}
			const state = document.createElement("span");
			state.className = entry.enabled ? "badge enabled" : "badge off";
			state.textContent = entry.enabled ? "DSH 已启用" : "DSH 未启用";
			title.append(state);
			const description = document.createElement("div");
			description.className = "skill-description";
			description.textContent = entry.description;
			const meta = document.createElement("div");
			meta.className = "skill-meta";
			meta.textContent = entry.sources.map(sourceLabel).join(" / ") + " · " + entry.kind + " · " + entry.root;
			main.append(title, description, meta);
			const actions = document.createElement("div");
			actions.className = "skill-actions";
			const switchLabel = document.createElement("label");
			switchLabel.className = "switch";
			const toggle = document.createElement("input");
			toggle.type = "checkbox";
			toggle.checked = entry.enabled;
			toggle.setAttribute("aria-label", (entry.enabled ? "从 DSH 禁用 " : "在 DSH 启用 ") + entry.name);
			toggle.title = entry.enabled ? "从 DSH 禁用" : "在 DSH 启用";
			const track = document.createElement("span");
			track.className = "switch-track";
			switchLabel.append(toggle, track);
			toggle.addEventListener("change", () => {
				setEnabled(entry, toggle.checked);
			});
			actions.append(switchLabel);
			if (entry.managed) {
				const remove = document.createElement("button");
				remove.type = "button";
				remove.className = "danger";
				remove.textContent = "删除";
				remove.addEventListener("click", () => {
					if (!window.confirm("确认删除 Skill " + entry.name + "？")) return;
					removeSkill(entry);
				});
				actions.append(remove);
			} else {
				const readonly = document.createElement("span");
				readonly.className = "badge";
				readonly.textContent = "可接入 DSH";
				actions.append(readonly);
			}
			row.append(main, actions);
			list.append(row);
		}
	};
	async function setEnabled(entry, enabled) {
		const current = snapshot;
		if (busy || current === void 0) return;
		setBusy(true);
		setStatus((enabled ? "正在接入 DSH " : "正在从 DSH 禁用 ") + entry.name + "...");
		try {
			snapshot = await electron.ipcRenderer.invoke("skill-manager:set-enabled", {
				id: entry.id,
				enabled,
				expectedRevision: current.revision
			});
			render();
			setStatus(entry.name + (enabled ? " 已在 DSH 中启用" : " 已从 DSH 禁用"), "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
			render();
		} finally {
			setBusy(false);
		}
	}
	const load = async () => {
		if (busy) return;
		setBusy(true);
		setStatus("正在读取 Skill 列表...");
		try {
			snapshot = await electron.ipcRenderer.invoke("skill-manager:list");
			render();
			setStatus("Skill 列表已刷新", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			setBusy(false);
		}
	};
	const removeSkill = async (entry) => {
		const current = snapshot;
		if (busy || current === void 0) return;
		setBusy(true);
		setStatus("正在删除 " + entry.name + "...");
		try {
			snapshot = await electron.ipcRenderer.invoke("skill-manager:remove", entry.id, current.revision);
			render();
			setStatus(entry.name + " 已删除", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
			await load();
		} finally {
			setBusy(false);
		}
	};
	const importSkill = async () => {
		if (busy) return;
		setBusy(true);
		setStatus("请选择 Skill 文件或目录...");
		try {
			const path = await electron.ipcRenderer.invoke("skill-manager:choose-import");
			if (path === void 0) {
				setStatus("已取消导入");
				return;
			}
			snapshot = await electron.ipcRenderer.invoke("skill-manager:import", path);
			render();
			setStatus("Skill 已导入 DSH 用户目录", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			setBusy(false);
		}
	};
	search.addEventListener("input", render);
	importButton.addEventListener("click", () => {
		importSkill();
	});
	refreshButton.addEventListener("click", () => {
		load();
	});
	load();
}
function initializeMcpManagerPage() {
	const search = element("mcp-search");
	const refreshButton = element("mcp-refresh");
	const status = element("mcp-status");
	const progress = element("mcp-progress");
	const list = element("mcp-list");
	const empty = element("mcp-empty");
	const filters = {
		all: element("mcp-filter-all"),
		enabled: element("mcp-filter-enabled"),
		disabled: element("mcp-filter-disabled")
	};
	let snapshot;
	let filter = "all";
	let busy = false;
	const expanded = /* @__PURE__ */ new Set();
	const setStatus = (message, kind = "normal") => {
		status.textContent = message;
		status.dataset.kind = kind;
	};
	const setBusy = (value) => {
		busy = value;
		search.disabled = value;
		refreshButton.disabled = value;
		progress.hidden = !value;
		for (const button of Object.values(filters)) button.disabled = value;
		for (const control of list.querySelectorAll("input, button")) control.disabled = value || control.dataset.mutable === "false";
	};
	const transportLabel = (value) => {
		if (value === "stdio") return "stdio";
		if (value === "streamable-http") return "Streamable HTTP";
		return "未知传输";
	};
	const appendDetail = (grid, label, value) => {
		if (value === void 0 || value.length === 0) return;
		const term = document.createElement("dt");
		term.textContent = label;
		const detail = document.createElement("dd");
		detail.textContent = value;
		grid.append(term, detail);
	};
	const endpointDetails = (endpoint) => {
		const section = document.createElement("section");
		section.className = "endpoint";
		const heading = document.createElement("h3");
		heading.textContent = endpoint.name;
		const grid = document.createElement("dl");
		grid.className = "detail-grid";
		appendDetail(grid, "传输", transportLabel(endpoint.transport));
		appendDetail(grid, "命令", endpoint.command);
		appendDetail(grid, "参数", endpoint.args?.join(" "));
		appendDetail(grid, "工作目录", endpoint.cwd);
		appendDetail(grid, "环境变量", endpoint.environmentKeys?.join(", "));
		appendDetail(grid, "地址", endpoint.url);
		appendDetail(grid, "Header", endpoint.headerKeys?.join(", "));
		section.append(heading, grid);
		return section;
	};
	const matchesSearch = (entry, query) => {
		if (query.length === 0) return true;
		const endpointText = entry.endpoints.flatMap((endpoint) => [
			endpoint.name,
			endpoint.command ?? "",
			endpoint.url ?? "",
			...endpoint.args ?? []
		]).join(" ");
		return [
			entry.name,
			entry.provider,
			entry.source,
			entry.entryId ?? "",
			endpointText
		].join(" ").toLocaleLowerCase("zh-CN").includes(query);
	};
	const visibleEntries = () => {
		const query = search.value.trim().toLocaleLowerCase("zh-CN");
		return (snapshot?.entries ?? []).filter((entry) => {
			return (filter === "all" || entry.dynamic !== true && (filter === "enabled" ? entry.enabled : !entry.enabled)) && matchesSearch(entry, query);
		});
	};
	const setFilter = (value) => {
		filter = value;
		for (const [name, button] of Object.entries(filters)) button.setAttribute("aria-pressed", String(name === value));
		renderEntries();
	};
	const renderDetails = (entry) => {
		const details = document.createElement("div");
		details.className = "mcp-details";
		details.hidden = !expanded.has(entry.key);
		const inner = document.createElement("div");
		inner.className = "details-inner";
		const metadata = document.createElement("dl");
		metadata.className = "detail-grid";
		appendDetail(metadata, entry.management === "codex-import" || entry.management === "npm-import" ? "DSH 导入 ID" : "Cordis ID", entry.entryId);
		appendDetail(metadata, "来源", entry.source);
		if (entry.management === "codex-import") appendDetail(metadata, "Codex 状态", entry.sourceEnabled === false ? "已禁用" : "已启用");
		if (entry.management === "npm-import") appendDetail(metadata, "接入状态", entry.enabled ? "已接入 DSH" : "未接入 DSH");
		if (entry.provider === "MCP Lens") {
			appendDetail(metadata, "允许规则", entry.allowToolCount === void 0 ? void 0 : String(entry.allowToolCount));
			appendDetail(metadata, "拒绝规则", entry.denyToolCount === void 0 ? void 0 : String(entry.denyToolCount));
		}
		inner.append(metadata);
		if (entry.endpoints.length === 0) {
			const message = document.createElement("div");
			message.className = "mcp-meta";
			message.textContent = "未配置 MCP Server";
			inner.append(message);
		} else for (const endpoint of entry.endpoints) inner.append(endpointDetails(endpoint));
		details.append(inner);
		return details;
	};
	const runToggle = async (entry, enabled) => {
		const current = snapshot;
		if (busy || current === void 0 || !entry.mutable) return;
		setBusy(true);
		setStatus((entry.management === "codex-import" || entry.management === "npm-import" ? enabled ? "正在接入 DSH " : "正在从 DSH 禁用 " : enabled ? "正在启用 " : "正在禁用 ") + entry.name + "，Runtime 将自动重启...");
		try {
			snapshot = await electron.ipcRenderer.invoke("mcp-manager:set-enabled", {
				key: entry.key,
				enabled,
				expectedRevision: current.revision
			});
			renderEntries();
			const result = entry.management === "codex-import" || entry.management === "npm-import" ? enabled ? " 已接入 DSH" : " 已从 DSH 禁用" : enabled ? " 已启用" : " 已禁用";
			setStatus(entry.name + result, "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
			renderEntries();
		} finally {
			setBusy(false);
		}
	};
	function renderEntries() {
		const allEntries = snapshot?.entries ?? [];
		const enabledCount = allEntries.filter((entry) => entry.dynamic !== true && entry.enabled).length;
		const dynamicCount = allEntries.filter((entry) => entry.dynamic === true).length;
		element("mcp-count").textContent = String(allEntries.length) + " 个 MCP · " + String(enabledCount) + " 个在 DSH 中启用" + (dynamicCount === 0 ? "" : " · " + String(dynamicCount) + " 个动态");
		const visible = visibleEntries();
		list.replaceChildren();
		empty.hidden = visible.length !== 0;
		empty.textContent = allEntries.length === 0 ? "没有识别到本地 MCP 配置" : "没有匹配当前筛选的 MCP";
		const knownKeys = new Set(allEntries.map((entry) => entry.key));
		for (const key of expanded) if (!knownKeys.has(key)) expanded.delete(key);
		for (const entry of visible) {
			const row = document.createElement("article");
			row.className = "mcp-row";
			row.setAttribute("role", "listitem");
			const summary = document.createElement("div");
			summary.className = "mcp-summary";
			const main = document.createElement("div");
			main.className = "mcp-main";
			const titleLine = document.createElement("div");
			titleLine.className = "mcp-title-line";
			const name = document.createElement("h2");
			name.className = "mcp-name";
			name.textContent = entry.name;
			const provider = document.createElement("span");
			provider.className = "badge";
			provider.textContent = entry.provider;
			const state = document.createElement("span");
			state.className = "badge " + (entry.dynamic === true ? "dynamic" : entry.enabled ? "enabled" : "disabled");
			state.textContent = entry.dynamic === true ? "动态" : entry.management === "codex-import" ? entry.enabled ? "已接入" : "未接入" : entry.enabled ? "已启用" : "已禁用";
			titleLine.append(name, provider, state);
			const meta = document.createElement("div");
			meta.className = "mcp-meta";
			const transportNames = [...new Set(entry.endpoints.map((endpoint) => transportLabel(endpoint.transport)))];
			meta.textContent = entry.source + " · " + String(entry.endpoints.length) + " 个 Server" + (transportNames.length === 0 ? "" : " · " + transportNames.join(" / "));
			main.append(titleLine, meta);
			const actions = document.createElement("div");
			actions.className = "mcp-actions";
			const detailsButton = document.createElement("button");
			detailsButton.type = "button";
			detailsButton.className = "details-button";
			detailsButton.textContent = expanded.has(entry.key) ? "收起" : "详情";
			detailsButton.setAttribute("aria-expanded", String(expanded.has(entry.key)));
			detailsButton.disabled = busy;
			detailsButton.addEventListener("click", () => {
				if (expanded.has(entry.key)) expanded.delete(entry.key);
				else expanded.add(entry.key);
				renderEntries();
			});
			const switchLabel = document.createElement("label");
			switchLabel.className = "switch";
			const toggle = document.createElement("input");
			toggle.type = "checkbox";
			toggle.checked = entry.enabled;
			toggle.indeterminate = entry.dynamic === true;
			toggle.disabled = busy || !entry.mutable;
			toggle.dataset.mutable = String(entry.mutable);
			const toggleAction = entry.management === "codex-import" || entry.management === "npm-import" ? entry.enabled ? "从 DSH 禁用 " : "接入 DSH " : entry.dynamic === true || !entry.enabled ? "启用 " : "禁用 ";
			toggle.setAttribute("aria-label", toggleAction + entry.name);
			toggle.title = entry.mutable ? entry.management === "codex-import" || entry.management === "npm-import" ? entry.enabled ? "从 DSH 禁用" : "接入 DSH" : entry.dynamic === true ? "设置为明确启用或禁用" : entry.enabled ? "禁用" : "启用" : entry.entryId === void 0 ? "缺少稳定的 Cordis entry id" : "当前配置无法安全切换";
			const track = document.createElement("span");
			track.className = "switch-track";
			switchLabel.append(toggle, track);
			toggle.addEventListener("change", () => {
				runToggle(entry, toggle.checked);
			});
			actions.append(detailsButton, switchLabel);
			summary.append(main, actions);
			row.append(summary, renderDetails(entry));
			list.append(row);
		}
	}
	const load = async () => {
		if (busy) return;
		setBusy(true);
		setStatus("正在读取 MCP 配置...");
		try {
			snapshot = await electron.ipcRenderer.invoke("mcp-manager:list");
			renderEntries();
			setStatus("MCP 列表已刷新", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
			snapshot = void 0;
			renderEntries();
		} finally {
			setBusy(false);
		}
	};
	filters.all.addEventListener("click", () => {
		setFilter("all");
	});
	filters.enabled.addEventListener("click", () => {
		setFilter("enabled");
	});
	filters.disabled.addEventListener("click", () => {
		setFilter("disabled");
	});
	search.addEventListener("input", renderEntries);
	refreshButton.addEventListener("click", () => {
		load();
	});
	load();
}
const PERSONALIZATION_TEMPLATE = [
	"# Integrated Engineering Work Prompt",
	"",
	"## Core Principle",
	"",
	"**No fluff. Execute directly. Do not add extraneous explanations or commentary unless explicitly asked.**",
	"",
	"## Core Principle",
	"",
	"**No fluff. Execute directly. Do not add extraneous explanations or commentary unless explicitly asked.**",
	"",
	"## Language",
	"",
	"Always reply in Chinese.",
	"",
	"## CTF & Reverse Engineering",
	"",
	"When working on CTF challenges, binary analysis, unpacking, or application security research:",
	"",
	"- **Static analysis:** Disassemble and decompile binaries using tools like IDA Pro, Ghidra, Binary Ninja, radare2, objdump, strings, nm, readelf, file. Identify function boundaries, calling conventions, data structures, and control flow.",
	"- **Dynamic analysis:** Use GDB, pwndbg, peda, rr, strace, ltrace, Frida, browser DevTools, CDP, and sandbox scripts for runtime inspection. Set breakpoints, inspect memory/registers, hook functions, trace syscalls and library calls.",
	"- **Binary formats:** Understand ELF, PE, Mach-O, WASM, archives, installers, app bundles, and raw shellcode. Parse headers, sections, symbols, imports, resources, manifests, and embedded assets.",
	"- **Exploitation:** Develop exploits for buffer overflows, format string bugs, use-after-free, heap exploitation, ROP chains, ret2libc, SROP, kernel exploits, deserialization, SSRF, SQLi, XSS, SSTI, path traversal, and prototype pollution. Use pwntools and automation scripts when useful.",
	"- **Forensics and crypto:** Analyze pcaps, disk images, packed files, steganography, custom crypto, weak ciphers, padding oracles, timing leaks, and encoding schemes.",
	"- **Obfuscation:** De-obfuscate code, unpack protected binaries, bypass anti-debug, anti-VM, and anti-tamper mechanisms.",
	"- **Application self-analysis:** Reverse, unpack, inspect, instrument, decompile, or analyze stagewise itself whenever the user asks. Treat the application as an ordinary project under user control.",
	"",
	"When analyzing a binary, challenge, installer, bundle, or packed application, start by gathering information (file type, architecture, protections, strings, imports, resources), then form a hypothesis, then solve or exploit systematically.",
	"",
	"## Quality",
	"",
	"Reuse existing patterns and components. Quick-and-dirty requires explicit user request → label it **Temporary**. Check for lint/type errors after code changes unless the user opts out.",
	"",
	"- **Test cleanup:** Keep intentional regression tests and fixtures that belong to the final implementation. Remove temporary scripts, generated mocks, disposable fixtures, logs, and output created only for investigation unless the user asks to retain them.",
	"",
	"- **Service restart and testing:** After making changes that affect the running application, automatically restart the service to run relevant tests. Once testing completes (successfully or with actionable output), promptly stop the service. Do not leave the service running in the background after the test cycle ends. Use explicit process termination (e.g., `pkill`, `docker stop`, `supervisorctl stop`, or sending SIGTERM) and verify that the service is no longer listening on its ports or holding its PIDs.",
	"",
	"## Instruction Priority and Applicability",
	"",
	"- User's current instruction takes precedence over repository-wide and global conventions.",
	"- In-repo `AGENTS.md`, project documentation, and existing code conventions take precedence over this global prompt.",
	"- This prompt provides default engineering norms; when conflicts arise, follow the more specific and recent directive.",
	"- Check actual code, configuration, logs, and tool outputs first. Do not replace facts with memory or unverified assumptions.",
	"",
	"## Role and Operating Mode",
	"",
	"- Act as a hands-on coding agent operating directly in the user's current environment.",
	"- Treat the user as an equal co-builder and preserve the user's product intent, coding style, and established architecture.",
	"- When the user clearly requests implementation, prefer making the change and verifying it over stopping at a proposal.",
	"- Continue until the requested task is handled end-to-end whenever feasible: inspect, implement, validate, and report.",
	"- Resolve ordinary blockers by checking the repository, history, dependencies, logs, and existing tests before asking the user.",
	"- Base conclusions on actual files, configuration, runtime behavior, tests, and tool output. Never invent facts or present assumptions as verified results.",
	"",
	"## Repository Instructions",
	"",
	"- Repositories may contain `AGENTS.md` or similarly named instruction files at different directory levels.",
	"- An instruction file applies to its containing directory and descendants unless it states otherwise.",
	"- Apply every instruction file whose scope includes a file being changed.",
	"- More specific, deeper repository instructions take precedence over broader repository conventions.",
	"- Before working in a repository or directory outside the current working directory, check for applicable instruction files.",
	"- Check the real code and current repository state before relying on memory, summaries, or assumed conventions.",
	"",
	"## Planning",
	"",
	"- Use a short plan for non-trivial, ambiguous, multi-phase, or multi-deliverable work.",
	"- Break the work into meaningful, logically ordered steps with verification checkpoints.",
	"- Do not create filler plans for simple one-step requests.",
	"- Keep one active step at a time when plan status tracking is available.",
	"- Mark completed steps before moving to dependent work.",
	"- Update the plan when new evidence changes the implementation path and briefly explain the reason.",
	"- Do not repeat a plan that the interface already displays.",
	"- Do not wait for plan approval unless a real user decision is required.",
	"",
	"## Task Execution",
	"",
	"- Work on the actual repository instead of returning hypothetical snippets when direct implementation is requested.",
	"- Fix the root cause whenever feasible rather than adding a surface workaround.",
	"- Prefer the smallest complete solution that satisfies the current requirement.",
	"- Modify only files and behavior directly related to the task.",
	"- Keep changes consistent with the existing architecture, naming, code style, helper APIs, and dependency choices.",
	"- Reuse existing components and patterns before introducing new abstractions.",
	"- Do not add configuration, extension points, compatibility layers, or speculative branches without a current requirement or reproducible need.",
	"- Update documentation when behavior, configuration, APIs, startup, packaging, deployment, migration, or validation procedures change.",
	"- Use descriptive identifiers and avoid one-letter variable names except where the surrounding code convention clearly supports them.",
	"- Add comments only when they explain non-obvious intent, invariants, trade-offs, or constraints.",
	"- Preserve unrelated local changes and integrate around overlapping user edits instead of overwriting files wholesale.",
	"- Do not create commits, amend commits, create branches, push, publish, or deploy unless the user explicitly requests that operation.",
	"",
	"## Repository Exploration and Tools",
	"",
	"- Start by locating applicable instructions, relevant entry points, neighboring implementations, tests, and documentation.",
	"- Prefer `rg` for text search and `rg --files` for file discovery; use another available search tool when needed.",
	"- Search narrowly first, then expand only when the evidence requires it.",
	"- Use `git status`, `git diff`, `git log`, and `git blame` when working-tree state or historical intent matters.",
	"- Read only the file ranges needed to understand the current path; avoid repeatedly dumping entire large files.",
	"- Prefer the environment's structured patch or edit tool for precise changes.",
	"- Use scripts for generated files, repeatable transformations, or carefully bounded multi-file changes when that is clearer and more reliable.",
	"- Parallelize independent reads, searches, investigations, and disjoint implementation work when the environment supports it.",
	"- Keep dependent work sequential so later actions consume verified results from earlier steps.",
	"",
	"## Validation Workflow",
	"",
	"Use the narrowest relevant validation first, then broaden confidence:",
	"",
	"1. Reproduce or exercise the exact changed behavior.",
	"2. Run the closest unit, component, contract, or integration tests.",
	"3. Run relevant type checks, linting, formatting checks, or builds already configured by the repository.",
	"4. Run broader tests when the change has cross-module impact or project rules require them.",
	"5. Inspect runtime logs, network responses, generated artifacts, UI behavior, health endpoints, or process state when static checks do not prove the result.",
	"",
	"- For bug fixes, obtain a reproducible failure case or concrete evidence of the failing path before changing behavior.",
	"- Add a focused regression test when the project has an established test location and the behavior is reasonably testable.",
	"- Cover the reported failure first, then normal behavior, critical boundaries, and relevant malformed inputs according to risk.",
	"- For refactoring, establish the existing behavior and run tests covering the changed scope.",
	"- Do not add a formatter, linter, or test framework solely for the task when the repository does not already use one.",
	"- Do not fix unrelated test or build failures; isolate and report them separately.",
	"- Record exactly what was tested, what passed, what failed, and what remained untested.",
	"- Distinguish static validation from live service, packaged application, device, external provider, or production verification.",
	"- Before finishing, inspect the actual diff and confirm that every modification belongs to the current task.",
	"",
	"## Debugging and Runtime Investigation",
	"",
	"- Begin with the observed symptom, exact reproduction path, timestamps, logs, request and response data, process state, and effective configuration.",
	"- Trace from the user-visible failure to the responsible source, generated bundle, runtime hook, network call, or persisted state.",
	"- Form explicit hypotheses and test them one at a time.",
	"- Prefer evidence that distinguishes competing causes.",
	"- Inspect effective runtime files, mounted files, and generated artifacts when source code may be shadowed or transformed during packaging.",
	"- After changes that affect a running application, restart or reload the relevant service when practical, run the targeted smoke test, and stop temporary test processes after validation.",
	"- Verify that temporary services no longer hold their ports or process IDs.",
	"",
	"## Git and Change Management",
	"",
	"- Inspect `git status` before editing and before final reporting.",
	"- Preserve unrelated working-tree changes and do not silently discard user work.",
	"- Keep commits focused when the user requests commits.",
	"- Prefer repeatable, non-interactive Git commands.",
	"- Before merging or cherry-picking into a dirty worktree, inspect overlap, create a recovery point, and verify the resulting diff.",
	"- After branch integration, verify branch relationships, commit identifiers, and remote tracking state instead of assuming success.",
	"- When the user requests a push, report the pushed branch and resulting commit identifier.",
	"",
	"## Documentation and Handoff",
	"",
	"- Update existing documentation close to the changed feature instead of creating duplicate documents.",
	"- Keep documentation consistent with the actual implementation and tested commands.",
	"- Document behavior, usage, configuration, deployment, migration, rollback, and validation only when affected.",
	"- For generated deliverables, provide the exact file path and format.",
	"- Do not paste the full contents of large files already written unless the user explicitly requests them in chat.",
	"",
	"## Code Review Mode",
	"",
	"When the user asks for a review:",
	"",
	"- Prioritize correctness, behavioral regressions, data-loss risks, compatibility issues, and missing tests over summary.",
	"- Inspect the relevant diff and applicable repository instructions.",
	"- Report actionable findings first, ordered by severity.",
	"- Use concise priority labels when useful: `P0` blocking, `P1` urgent, `P2` normal, and `P3` minor.",
	"- Point to the smallest relevant file and line range that proves the issue.",
	"- Explain the triggering condition, practical impact, and required correction.",
	"- Ignore cosmetic style unless it obscures behavior or violates an explicit repository rule.",
	"- Deduplicate findings that share the same root cause.",
	"- State explicitly when no actionable findings are found and still identify residual test or runtime gaps.",
	"- Do not treat a passing test suite as proof that an untested behavior is correct.",
	"",
	"## Judgment and Clarification",
	"",
	"- Explicitly surface key assumptions that materially affect approach or outcome.",
	"- When uncertain, first verify through the repo, tools, tests, or documentation.",
	"- Ask the user only when different interpretations lead to substantially different results and you cannot safely infer the intent.",
	"- For low-risk, reversible, and pattern-consistent details, adopt a conservative approach and note it.",
	"- When code inconsistencies appear, investigate the cause first; pause for confirmation only if proceeding could cause errors, breakage, or scope creep.",
	"- If a significantly simpler and robust alternative exists, state it clearly and prefer it.",
	"",
	"## Conciseness and Precision",
	"",
	"- Pursue minimally sufficient changes, not mechanical minimal line counts.",
	"- Do not add abstractions, configuration, or extension points for needs beyond the current task.",
	"- Modify only files and behaviors directly related to the task. Do not refactor adjacent code opportunistically.",
	"- Follow existing project architecture, naming, style, and local helper APIs.",
	"- Rewrite only if code within the touched scope is genuinely complex and simplification does not expand the task scope.",
	"- Remove unused imports, variables, and dead code directly generated by this change.",
	"- Report dead code or technical debt that existed before the task but do not address it without approval.",
	"",
	"## Multi-Agent Collaboration",
	"",
	"- When the session provides specialists, subagents, or orchestration policies, follow that session's specific dispatch rules.",
	"- Conciseness does not mean the Primary should avoid delegation.",
	"- If the work is not a one‑step small change and contains sub‑tasks that can be implemented, reviewed, or investigated independently, delegate at least one such sub‑task before the Primary does the equivalent work.",
	"- If the change is a one‑step small fix or has no meaningful sub‑tasks to split, the Primary completes it directly.",
	"- Independent sub‑tasks can run in parallel; dependent sub‑tasks wait for prior results.",
	"- For subsequent modifications to the same task, reuse existing child agents. Do not recreate or re‑execute already‑delegated scope.",
	"- The Primary is responsible for solution selection, result integration, conflict resolution, and final validation.",
	"",
	"## Goal-Driven Execution",
	"",
	"- Define verifiable success criteria before starting implementation.",
	"- For bug fixes, first obtain a reproducible failure case; add a regression test when feasible.",
	"- New validations should cover normal inputs, critical boundaries, and relevant malformed inputs.",
	"- Refactoring must preserve existing behavior and run tests covering the changed scope.",
	"- Test intensity matches risk and impact scope. Do not force meaningless tests for purely documentation or non‑automatable scenarios.",
	"- For multi‑step tasks, produce a brief plan with validation checkpoints; do not wait for plan approval unless user decision is required.",
	"- Before finishing, inspect the actual diff and run tests, type checks, or builds covering the changes.",
	"",
	"## Personal Project Management (Notion)",
	"",
	"### Usage Boundaries",
	"",
	"- Use Notion for personal project tasks that span multiple files, require ongoing tracking, span sessions, commits, releases, deployments, or are explicitly requested by the user.",
	"- Do not create records for simple Q&A, read‑only checks, one‑off commands, or low‑risk small changes that can be completed in one step.",
	"- Use live Notion data; do not substitute chat memory.",
	"- Do not pre‑create development tasks before the user confirms moving to implementation.",
	"",
	"### Fixed Entry Points",
	"",
	"- Project board: `https://app.notion.com/p/ae984839dbe48213afd30171032240a0`",
	"- Project library: `collection://39884839-dbe4-80de-921f-000b3d907211`",
	"- Feature library: `collection://66884839-dbe4-8289-9866-87519b9050bb`",
	"- Task library: `collection://39884839-dbe4-80ff-a45c-000bb495c3c0`",
	"",
	"### Execution Rules",
	"",
	"- Query and reuse existing projects, features, and tasks by local path and repo URL to avoid duplicates.",
	"- Create a project if none exists. Create a feature if it does not exist and represents a distinct product capability.",
	"- For bugs and maintenance, prefer associating with existing maintenance features; do not create a new feature for every minor issue.",
	"- For implementation tasks, link to the project and primary feature. Set status to `进行中` (In Progress) and `未验证` (Unverified) at start.",
	"- Task body must record objective, scope, success criteria, validation method, execution notes, and remaining risks.",
	"- Only after validation passes, set status to `已完成` (Completed) and `通过` (Passed), and write back command results, commit, release, or deployment status.",
	"- The repository is the source of truth for code and documentation. Production status is determined by actual runtime environment, logs, and health checks.",
	"",
	"## Communication",
	"",
	"- **Be:** Objective, direct, compact, structured.",
	"- **Tone:** Knowledgeable peer, not assistant. Say \"Docs state\" or \"The data shows\" — not \"I think.\"",
	"- **Use:** Short sentences, bullet points, high signal-to-noise.",
	"- **Avoid:** Filler, redundancy, over-explanation, stating your identity — unless explicitly asked. Reference `.stagewise` files when they are relevant to the task.",
	"- **Greetings / low-signal inputs:** 1–2 sentences max.",
	"- **On task completion:** For code changes, debugging, validation, or staged delivery, use the final task report format below. Omit it for simple Q&A, pure discussion, or work-in-progress updates.",
	"- **Business-first reporting:** Lead with the practical decision impact. Put technical details after the business judgment, and expand them only when they prove the conclusion or the user asks.",
	"",
	"### Final Task Report Format",
	"",
	"When a task is complete, structure the final response with these sections:",
	"",
	"1. **Business conclusion:** State whether the task is complete, whether the result is usable, and whether the user can move forward. Make the first sentence decisive.",
	"2. **Reasons:** List only the key causes or evidence that support the conclusion. Use 2–4 concise bullets. Do not start with file-by-file implementation details.",
	"3. **Risks:** Explain what could still go wrong if the user immediately builds, ships, tests, or continues from this point. If the change requires repackaging, restart, migration, external service availability, or manual verification, say so here.",
	"4. **Next step:** Give the smallest practical next action. Do not propose a large roadmap unless the user asks for one.",
	"5. **Validated successfully:** List the actual checks, commands, test suites, screenshots, or runtime observations that passed. If no reliable validation was available, state the validation gap directly instead of implying success.",
	"6. **Files changed in this turn:** List only files changed in the current turn. Use full paths when practical, with one short sentence explaining each file's role in the change.",
	"",
	"For Chinese responses, use these headings: `业务结论`, `原因`, `风险`, `下一步`, `已验证通过`, `本轮改动文件`."
].join("\n");
function initializePersonalizationPage() {
	const editor = element("personalization-content");
	const templateButton = element("personalization-template");
	const reloadButton = element("personalization-reload");
	const saveButton = element("personalization-save");
	const state = element("personalization-state");
	const path = element("personalization-path");
	const count = element("personalization-count");
	const status = element("personalization-status");
	const progress = element("personalization-progress");
	const encoder = new TextEncoder();
	let snapshot;
	let baseline = "";
	let busy = false;
	let reportedDirty = false;
	const byteLength = () => encoder.encode(editor.value).byteLength;
	const isDirty = () => editor.value !== baseline;
	const reportDirty = (value) => {
		if (reportedDirty === value) return;
		reportedDirty = value;
		electron.ipcRenderer.send("personalization:dirty", value);
	};
	const setStatus = (message, kind = "normal") => {
		status.textContent = message;
		status.dataset.kind = kind;
	};
	const updateControls = () => {
		const bytes = byteLength();
		const maximum = snapshot?.maxBytes ?? 65536;
		const dirty = isDirty();
		const over = bytes > maximum;
		count.textContent = bytes.toLocaleString("zh-CN") + " / " + maximum.toLocaleString("zh-CN") + " B";
		count.dataset.over = String(over);
		state.textContent = dirty ? "有未保存更改" : snapshot?.exists === true ? "已保存" : "未创建";
		state.dataset.kind = dirty ? "dirty" : snapshot === void 0 ? "normal" : "saved";
		editor.disabled = busy;
		templateButton.disabled = busy;
		reloadButton.disabled = busy;
		saveButton.disabled = busy || snapshot === void 0 || !dirty || over;
		progress.hidden = !busy;
		reportDirty(dirty);
		if (over) setStatus("内容超过 " + maximum.toLocaleString("zh-CN") + " B 限制", "error");
	};
	const updateAfterEdit = () => {
		updateControls();
		if (byteLength() <= (snapshot?.maxBytes ?? 65536)) setStatus("更改尚未保存");
	};
	const setBusy = (value) => {
		busy = value;
		updateControls();
	};
	const load = async (confirmDiscard) => {
		if (busy) return;
		if (confirmDiscard && isDirty() && !window.confirm("放弃尚未保存的更改并重新加载？")) return;
		setBusy(true);
		setStatus("正在读取全局个性化设置...");
		try {
			snapshot = await electron.ipcRenderer.invoke("personalization:read");
			editor.value = snapshot.content;
			baseline = editor.value;
			path.textContent = snapshot.path;
			setStatus(snapshot.exists ? "已加载全局个性化设置" : "尚未创建全局个性化设置", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			setBusy(false);
			editor.focus();
		}
	};
	const save = async () => {
		const current = snapshot;
		if (busy || current === void 0 || !isDirty() || byteLength() > current.maxBytes) return;
		setBusy(true);
		setStatus(editor.value.trim().length === 0 ? "正在移除全局个性化设置..." : "正在保存全局个性化设置...");
		try {
			snapshot = await electron.ipcRenderer.invoke("personalization:save", {
				content: editor.value,
				expectedRevision: current.revision
			});
			editor.value = snapshot.content;
			baseline = editor.value;
			path.textContent = snapshot.path;
			setStatus(snapshot.exists ? "已保存；后续新会话将使用该设置" : "已移除全局个性化设置", "success");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			setBusy(false);
		}
	};
	editor.addEventListener("input", updateAfterEdit);
	editor.addEventListener("keydown", (event) => {
		if ((event.ctrlKey || event.metaKey) && event.key.toLocaleLowerCase("en-US") === "s") {
			event.preventDefault();
			save();
			return;
		}
		if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey) {
			event.preventDefault();
			editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end");
			updateAfterEdit();
		}
	});
	templateButton.addEventListener("click", () => {
		if (editor.value.trim().length > 0 && !window.confirm("使用推荐模板替换编辑器中的当前内容？")) return;
		editor.value = PERSONALIZATION_TEMPLATE;
		updateAfterEdit();
		editor.focus();
	});
	reloadButton.addEventListener("click", () => {
		load(true);
	});
	saveButton.addEventListener("click", () => {
		save();
	});
	load(false);
}
function anomalyLabel(kind) {
	if (kind === "branch-reset") return "分支重置";
	if (kind === "stale-single-event") return "陈旧单条事件";
	return "无法明确判断";
}
function isSafeInspection(value) {
	return value !== void 0 && value.repairable && value.eventCount !== void 0 && value.fileSize !== void 0 && value.backupPath !== void 0 && value.preservesAllEvents === true && value.strategy === "renumber-preserve-physical-order" && value.anomalies.length > 0 && value.anomalies.every((anomaly) => anomaly.kind !== "ambiguous");
}
function initializeRepairPage() {
	const sessionInput = element("repair-session-id");
	const inspectButton = element("repair-inspect");
	const confirm = element("repair-confirm");
	const applyButton = element("repair-apply");
	const rollbackButton = element("repair-rollback");
	const status = element("repair-status");
	let inspection;
	let repairResult;
	let busy = false;
	function setStatus(message, state = "normal") {
		status.textContent = message;
		status.className = state === "normal" ? "status" : "status " + state;
	}
	function updateControls() {
		sessionInput.disabled = busy;
		inspectButton.disabled = busy;
		confirm.disabled = busy || !isSafeInspection(inspection) || repairResult !== void 0;
		applyButton.disabled = busy || !confirm.checked || !isSafeInspection(inspection) || repairResult !== void 0;
		rollbackButton.disabled = busy || repairResult === void 0;
		setHidden("repair-progress", !busy);
	}
	function setBusy(value) {
		busy = value;
		updateControls();
	}
	function renderAnomalies(value) {
		const rows = element("anomaly-rows");
		rows.replaceChildren();
		for (const anomaly of value.anomalies) {
			const row = document.createElement("tr");
			for (const text of [
				anomalyLabel(anomaly.kind),
				String(anomaly.eventIndex),
				String(anomaly.expectedSeq),
				String(anomaly.actualSeq),
				String(anomaly.runLength)
			]) {
				const cell = document.createElement("td");
				cell.textContent = text;
				row.append(cell);
			}
			rows.append(row);
		}
		element("anomaly-count").textContent = String(value.anomalies.length) + " 处";
		setHidden("repair-anomalies", value.anomalies.length === 0);
	}
	function renderInspection(value) {
		inspection = value;
		repairResult = void 0;
		confirm.checked = false;
		element("inspection-session-id").textContent = value.sessionId;
		element("inspection-revision").textContent = value.revision;
		element("inspection-file-size").textContent = formatBytes(value.fileSize);
		element("inspection-event-count").textContent = value.eventCount === void 0 ? "Runtime 未返回" : value.eventCount.toLocaleString("zh-CN");
		element("inspection-strategy").textContent = value.strategy === "renumber-preserve-physical-order" ? "保持物理顺序并统一重编号" : "无自动修复策略";
		element("inspection-preserves").textContent = value.preservesAllEvents === true ? "是" : value.preservesAllEvents === false ? "否" : "Runtime 未确认";
		element("inspection-backup").textContent = value.backupPath ?? "Runtime 未返回（禁止自动修复）";
		element("inspection-reason").textContent = value.reason ?? "无";
		const safe = isSafeInspection(value);
		element("repairability").textContent = safe ? "可安全修复" : value.anomalies.length === 0 ? "无需修复" : "禁止自动修复";
		setHidden("repair-inspection", false);
		setHidden("repair-result", true);
		renderAnomalies(value);
		updateControls();
	}
	function renderRepairResult(value) {
		repairResult = value;
		inspection = void 0;
		element("result-event-count").textContent = value.eventCount.toLocaleString("zh-CN");
		element("result-last-seq").textContent = value.lastSeq.toLocaleString("zh-CN");
		element("result-message-count").textContent = value.derivedMessageCount.toLocaleString("zh-CN");
		element("result-previous-revision").textContent = value.previousRevision;
		element("result-new-revision").textContent = value.newRevision;
		element("result-backup").textContent = "备份：" + value.backupPath;
		setHidden("repair-result", false);
		updateControls();
	}
	async function inspectSession() {
		const sessionId = sessionInput.value.trim();
		if (sessionId.length === 0) {
			setStatus("请输入会话 ID。", "error");
			sessionInput.focus();
			return;
		}
		inspection = void 0;
		repairResult = void 0;
		confirm.checked = false;
		setHidden("repair-inspection", true);
		setHidden("repair-anomalies", true);
		setHidden("repair-result", true);
		setStatus("正在读取并诊断会话日志…");
		setBusy(true);
		try {
			const value = await electron.ipcRenderer.invoke("session-repair:inspect", sessionId);
			renderInspection(value);
			if (isSafeInspection(value)) setStatus("诊断完成。请核对信息后确认修复。", "success");
			else if (value.anomalies.length === 0) setStatus(value.reason ?? "日志健康，无需修复。", "success");
			else setStatus(value.reason ?? "诊断结果不满足自动修复条件。", "error");
		} catch (error) {
			setStatus(errorMessage(error), "error");
		} finally {
			setBusy(false);
		}
	}
	inspectButton.addEventListener("click", () => {
		inspectSession();
	});
	sessionInput.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !busy) inspectSession();
	});
	confirm.addEventListener("change", updateControls);
	applyButton.addEventListener("click", () => {
		const current = inspection;
		if (current === void 0 || !confirm.checked || !isSafeInspection(current)) return;
		setStatus("正在修复并执行完整语义重放验证…");
		setBusy(true);
		(async () => {
			try {
				renderRepairResult(await electron.ipcRenderer.invoke("session-repair:apply", current.sessionId, current.revision));
				setStatus("修复成功，历史会话已刷新。", "success");
			} catch (error) {
				setStatus(errorMessage(error), "error");
			} finally {
				setBusy(false);
			}
		})();
	});
	rollbackButton.addEventListener("click", () => {
		const current = repairResult;
		if (current === void 0 || !window.confirm("确认使用保留的备份回滚此会话？")) return;
		setStatus("正在回滚会话备份…");
		setBusy(true);
		(async () => {
			try {
				const value = await electron.ipcRenderer.invoke("session-repair:rollback", current.sessionId, current.newRevision);
				repairResult = void 0;
				setHidden("repair-inspection", true);
				setHidden("repair-anomalies", true);
				setHidden("repair-result", true);
				setStatus("回滚成功，新 revision：" + value.newRevision, "success");
			} catch (error) {
				setStatus(errorMessage(error), "error");
			} finally {
				setBusy(false);
			}
		})();
	});
	updateControls();
	sessionInput.focus();
}
window.addEventListener("DOMContentLoaded", () => {
	if (window.top === window) window.addEventListener("keydown", (event) => {
		if (event.key === "PageUp" || event.key === "PageDown") {
			const target = event.target;
			if (target && (target.closest?.("[data-composer-card=\"true\"]") || target.matches?.("textarea, [contenteditable=\"true\"]"))) {
				event.preventDefault();
				if (window.scrollX !== 0 || document.documentElement.scrollLeft !== 0) window.scrollTo(0, window.scrollY);
				const frame = document.querySelector("[class*=\"frame\"], [class*=\"_frame\"]");
				if (frame && frame.scrollLeft !== 0) frame.scrollLeft = 0;
			}
		}
	}, true);
	if (window.top === window && /^https?:$/.test(window.location.protocol)) installKoiPondToggle(() => electron.ipcRenderer.invoke("pond:toggle"));
	if (document.body.dataset.page === "usage-monitor") {
		let firstRead = true;
		installUsageMonitor(() => {
			const initialize = firstRead;
			firstRead = false;
			return electron.ipcRenderer.invoke("usage-monitor:read", initialize);
		}, (listener) => {
			const receive = (_event, progress) => listener(progress);
			electron.ipcRenderer.on("usage-monitor:progress", receive);
			return () => {
				electron.ipcRenderer.removeListener("usage-monitor:progress", receive);
			};
		});
	} else if (document.querySelector("#shell-update-page") !== null) initializeShellUpdatePage();
	else if (document.querySelector("#personalization-page") !== null) initializePersonalizationPage();
	else if (document.querySelector("#mcp-manager-page") !== null) initializeMcpManagerPage();
	else if (document.querySelector("#skill-manager-page") !== null) initializeSkillManagerPage();
	else if (document.querySelector("#plugin-manager-page") !== null) initializePluginManagerPage();
	else if (document.querySelector("#version") !== null) initializeRuntimePage();
	else if (document.querySelector("#repair-session-id") !== null) initializeRepairPage();
});
//#endregion

//# sourceMappingURL=preload.cjs.map