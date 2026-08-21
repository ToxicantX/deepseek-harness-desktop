import { a as compatibleReleases, i as MINIMUM_DSH_VERSION, o as isReleaseCompatible, s as selectRuntime, t as RuntimeStore } from "./runtime-store-KYPcv6XO.js";
import { desktopEnvironment, startBackend } from "./backend.js";
import { spawn } from "node:child_process";
import { appendFileSync, constants, mkdirSync, readFileSync } from "node:fs";
import { access, copyFile, cp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { BrowserWindow, Menu, Tray, app, dialog, ipcMain, nativeImage, protocol, screen, shell } from "electron";
import { gt, valid } from "semver";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import extract from "extract-zip";
import updaterPackage from "electron-updater";
//#region src/desktop-pet.ts
const MAX_PET_TEXT_BYTES = 4096;
const MAX_PET_TEXT_CHARACTERS = 2e3;
const MAX_PET_REASON_BYTES = 1024;
const PET_REPLY_HOLD_MS = 5e3;
const PET_EVENTS_PATH = "/api/events.mux";
const PET_RESPOND_PATH = "/api/respond";
const DEFAULT_RECONNECT_BASE_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 5e3;
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
function isRecord$3(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isBoundedIdentifier(value) {
	return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function isSafeIndex(value) {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function sanitizeText(value) {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
}
function utf8ByteLength(value) {
	return Buffer.byteLength(value, "utf8");
}
function projectPetText(value, maximumBytes = MAX_PET_TEXT_BYTES, maximumCharacters = MAX_PET_TEXT_CHARACTERS) {
	if (typeof value !== "string") return void 0;
	const sanitized = sanitizeText(value);
	let text = "";
	let bytes = 0;
	let characters = 0;
	let truncated = false;
	for (const character of sanitized) {
		if (characters >= maximumCharacters || bytes + utf8ByteLength(character) > maximumBytes) {
			truncated = true;
			break;
		}
		text += character;
		bytes += utf8ByteLength(character);
		characters += 1;
	}
	return {
		text,
		truncated
	};
}
function appendProjectedText(current, addition, separator = "") {
	const next = projectPetText(current.text + (current.text.length === 0 ? "" : separator) + addition);
	if (next === void 0) return current;
	return {
		text: next.text,
		truncated: current.truncated || next.truncated
	};
}
function projectReason(value) {
	const projection = projectPetText(value, MAX_PET_REASON_BYTES, MAX_PET_REASON_BYTES);
	if (projection === void 0 || projection.text.length === 0) return void 0;
	return projection.text;
}
function projectToolName(value) {
	const projection = projectPetText(value, 256, 256);
	if (projection === void 0 || projection.text.length === 0) return void 0;
	return projection.text;
}
function parseSessionEvent(value) {
	if (!isRecord$3(value) || typeof value.type !== "string" || !isRecord$3(value.data)) return { kind: "ignored" };
	const data = value.data;
	if (!isSafeIndex(data.turn)) return { kind: "ignored" };
	if (value.type === "turn/start") return {
		kind: "turn-start",
		turn: data.turn
	};
	if (value.type === "turn/end") return {
		kind: "turn-end",
		turn: data.turn
	};
	if (!isSafeIndex(data.step)) return { kind: "ignored" };
	if (value.type === "assistant/chunk") {
		if (!isRecord$3(data.chunk) || data.chunk.type !== "text-delta") return { kind: "ignored" };
		const text = projectPetText(data.chunk.text);
		if (text === void 0 || text.text.length === 0) return { kind: "ignored" };
		return {
			kind: "text-delta",
			turn: data.turn,
			step: data.step,
			text: text.text,
			truncated: text.truncated
		};
	}
	if (value.type === "assistant/message") {
		if (!isRecord$3(data.message) || !Array.isArray(data.message.content)) return { kind: "ignored" };
		let text = {
			text: "",
			truncated: false
		};
		for (const block of data.message.content) {
			if (!isRecord$3(block) || block.type !== "text") continue;
			const blockText = projectPetText(block.text);
			if (blockText === void 0 || blockText.text.length === 0) continue;
			const next = appendProjectedText(text, blockText.text, "\n");
			text = {
				text: next.text,
				truncated: text.truncated || blockText.truncated || next.truncated
			};
		}
		if (text.text.length === 0) return { kind: "ignored" };
		return {
			kind: "final",
			turn: data.turn,
			step: data.step,
			text: text.text,
			truncated: text.truncated
		};
	}
	return { kind: "ignored" };
}
function parseMuxPayload(value, rpcId) {
	if (!isRecord$3(value) || typeof value.type !== "string") return void 0;
	if (value.type === "session/event") {
		if (!isBoundedIdentifier(value.sessionId) || !isRecord$3(value.event) || !isSafeIndex(value.event.seq)) return void 0;
		return {
			type: "session/event",
			sessionId: value.sessionId,
			seq: value.event.seq,
			event: parseSessionEvent(value.event)
		};
	}
	if (value.type === "session/subscribed") {
		if (!isBoundedIdentifier(value.sessionId) || !isSafeIndex(value.lastSeq)) return void 0;
		return {
			type: "session/subscribed",
			sessionId: value.sessionId,
			lastSeq: value.lastSeq
		};
	}
	if (value.type === "approval/requested") {
		const toolName = projectToolName(value.toolName);
		if (!isBoundedIdentifier(value.sessionId) || !isBoundedIdentifier(value.approvalId) || toolName === void 0) return void 0;
		const reason = projectReason(value.reason);
		return {
			type: "approval/requested",
			sessionId: value.sessionId,
			approvalId: value.approvalId,
			rpcId,
			toolName,
			...reason === void 0 ? {} : { reason }
		};
	}
	if (value.type === "approval/resolved") {
		if (!isBoundedIdentifier(value.sessionId) || !isBoundedIdentifier(value.approvalId)) return void 0;
		if (value.outcome !== "allowed-once" && value.outcome !== "rejected" && value.outcome !== "cancelled" && value.outcome !== "unavailable") return void 0;
		return {
			type: "approval/resolved",
			sessionId: value.sessionId,
			approvalId: value.approvalId,
			outcome: value.outcome
		};
	}
	if (value.type === "stream/error") {
		if (!isRecord$3(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string") return void 0;
		return { type: "stream/error" };
	}
}
function parsePetWebSocketFrame(value) {
	if (!isRecord$3(value) || value.type !== "server-request" || !isBoundedIdentifier(value.rpcId) || !isBoundedIdentifier(value.method) || !isRecord$3(value.payload)) return void 0;
	if (value.method !== value.payload.type || typeof value.payload.type !== "string") return void 0;
	return parseMuxPayload(value.payload, value.rpcId);
}
function parsePetWebSocketMessage(value) {
	if (typeof value !== "string" || utf8ByteLength(value) > 65536) return void 0;
	try {
		return parsePetWebSocketFrame(JSON.parse(value));
	} catch {
		return;
	}
}
function parsePetDecision(value) {
	if (!isRecord$3(value) || Object.keys(value).some((key) => key !== "approvalId" && key !== "outcome")) return void 0;
	if (!isBoundedIdentifier(value.approvalId)) return void 0;
	if (value.outcome !== "allowed-once" && value.outcome !== "rejected") return void 0;
	return {
		approvalId: value.approvalId,
		outcome: value.outcome
	};
}
function trustedLoopbackOrigin(value) {
	let url;
	try {
		url = new URL(value);
	} catch (error) {
		throw new TypeError("desktop pet requires a valid DSH origin", { cause: error });
	}
	if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") throw new TypeError("desktop pet requires a trusted loopback DSH origin");
	return url;
}
function socketUrl(origin) {
	const url = new URL(PET_EVENTS_PATH, origin);
	url.protocol = "ws:";
	return url.href;
}
function validPositiveNumber(value, name) {
	if (!Number.isFinite(value) || value <= 0) throw new TypeError(name + " must be a positive finite number");
	return value;
}
function validRect(value, name) {
	if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new TypeError(name + " origin must be finite");
	return {
		x: Math.round(value.x),
		y: Math.round(value.y),
		width: Math.max(1, Math.round(validPositiveNumber(value.width, name + ".width"))),
		height: Math.max(1, Math.round(validPositiveNumber(value.height, name + ".height")))
	};
}
function clampPetBounds(bounds, workArea) {
	const area = validRect(workArea, "workArea");
	if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) throw new TypeError("bounds origin must be finite");
	const width = Math.min(Math.max(1, Math.round(validPositiveNumber(bounds.width, "bounds.width"))), area.width);
	const height = Math.min(Math.max(1, Math.round(validPositiveNumber(bounds.height, "bounds.height"))), area.height);
	const minX = area.x;
	const minY = area.y;
	const maxX = area.x + area.width - width;
	const maxY = area.y + area.height - height;
	return {
		x: Math.min(maxX, Math.max(minX, Math.round(bounds.x))),
		y: Math.min(maxY, Math.max(minY, Math.round(bounds.y))),
		width,
		height
	};
}
function defaultPetBounds(workArea, size, margin = 24) {
	if (!Number.isFinite(margin) || margin < 0) throw new TypeError("margin must be a nonnegative finite number");
	const area = validRect(workArea, "workArea");
	const width = validPositiveNumber(size.width, "size.width");
	const height = validPositiveNumber(size.height, "size.height");
	return clampPetBounds({
		x: area.x + area.width - width - Math.round(margin),
		y: area.y + area.height - height - Math.round(margin),
		width,
		height
	}, area);
}
function defaultFetch(input, init) {
	return globalThis.fetch(input, init);
}
var DesktopPetController = class {
	fetcher;
	reconnectBaseMs;
	reconnectMaxMs;
	listeners = /* @__PURE__ */ new Set();
	approvals = /* @__PURE__ */ new Map();
	responseControllers = /* @__PURE__ */ new Map();
	socket;
	reconnectTimer;
	replyTimer;
	origin;
	activeSessionId;
	activeDraftKey;
	activeLastSeq;
	activeDraft = {
		text: "",
		truncated: false
	};
	reply;
	thinking = false;
	connection = "stopped";
	message;
	reconnectAttempt = 0;
	generation = 0;
	stopped = true;
	constructor(options) {
		this.options = options;
		this.fetcher = options.fetcher ?? defaultFetch;
		this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
		this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
		if (!Number.isFinite(this.reconnectBaseMs) || this.reconnectBaseMs <= 0) throw new TypeError("reconnectBaseMs must be positive");
		if (!Number.isFinite(this.reconnectMaxMs) || this.reconnectMaxMs < this.reconnectBaseMs) throw new TypeError("reconnectMaxMs must be at least reconnectBaseMs");
	}
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	snapshot() {
		const firstApproval = this.approvals.values().next().value;
		const state = {
			connection: this.connection,
			queuedApprovals: Math.max(0, this.approvals.size - (firstApproval === void 0 ? 0 : 1))
		};
		if (this.reply !== void 0) state.reply = { ...this.reply };
		if (this.thinking) state.thinking = true;
		if (firstApproval !== void 0) state.approval = {
			approvalId: firstApproval.approvalId,
			toolName: firstApproval.toolName,
			...firstApproval.reason === void 0 ? {} : { reason: firstApproval.reason },
			sessionLabel: firstApproval.sessionId === this.activeSessionId ? "当前会话" : "后台会话",
			status: firstApproval.status
		};
		if (this.message !== void 0) state.message = this.message;
		return state;
	}
	setActiveSession(sessionId) {
		if (sessionId !== void 0 && !isBoundedIdentifier(sessionId)) throw new TypeError("active session must be a bounded opaque identifier");
		if (sessionId === this.activeSessionId) return;
		this.activeSessionId = sessionId;
		this.activeLastSeq = void 0;
		this.activeDraftKey = void 0;
		this.activeDraft = {
			text: "",
			truncated: false
		};
		this.clearReplyTimer();
		this.reply = void 0;
		this.thinking = false;
		this.emit();
	}
	start(origin) {
		const trusted = trustedLoopbackOrigin(origin);
		if (!this.stopped && this.origin?.href === trusted.href) return;
		this.stop();
		this.origin = trusted;
		this.stopped = false;
		this.connection = "connecting";
		this.message = void 0;
		this.reconnectAttempt = 0;
		this.emit();
		this.openSocket();
	}
	stop() {
		this.stopped = true;
		this.generation += 1;
		this.clearReconnectTimer();
		this.clearReplyTimer();
		this.disposeSocket();
		for (const controller of this.responseControllers.values()) controller.abort();
		this.responseControllers.clear();
		this.origin = void 0;
		this.approvals.clear();
		this.activeLastSeq = void 0;
		this.activeDraftKey = void 0;
		this.activeDraft = {
			text: "",
			truncated: false
		};
		this.reply = void 0;
		this.thinking = false;
		this.connection = "stopped";
		this.message = void 0;
		this.emit();
	}
	async decide(value) {
		const decision = parsePetDecision(value);
		if (decision === void 0) return {
			accepted: false,
			reason: "invalid-decision"
		};
		const pending = this.approvals.get(decision.approvalId);
		if (pending === void 0) return {
			accepted: false,
			reason: "not-pending"
		};
		if (pending.status !== "pending") return {
			accepted: false,
			reason: "in-flight"
		};
		const origin = this.origin;
		if (this.stopped || origin === void 0) return {
			accepted: false,
			reason: "stopped"
		};
		pending.status = "responding";
		const responseController = new AbortController();
		this.responseControllers.set(decision.approvalId, responseController);
		this.emit();
		const body = {
			type: "client-response",
			rpcId: pending.rpcId,
			result: {
				ok: true,
				value: {
					sessionId: pending.sessionId,
					approvalId: pending.approvalId,
					outcome: decision.outcome
				}
			}
		};
		let response;
		try {
			response = await this.fetcher(new URL(PET_RESPOND_PATH, origin), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: responseController.signal
			});
		} catch {
			this.responseControllers.delete(decision.approvalId);
			if (this.approvals.get(decision.approvalId) === pending) {
				pending.status = "pending";
				this.message = "Approval response failed";
				this.emit();
			}
			return {
				accepted: false,
				reason: "transport"
			};
		}
		this.responseControllers.delete(decision.approvalId);
		if (this.approvals.get(decision.approvalId) !== pending) return {
			accepted: false,
			reason: "not-pending"
		};
		if (!response.ok) {
			pending.status = "pending";
			this.message = "Approval response failed";
			this.emit();
			return {
				accepted: false,
				reason: "transport"
			};
		}
		let result;
		try {
			result = await response.json();
		} catch {
			pending.status = "pending";
			this.message = "Invalid approval response";
			this.emit();
			return {
				accepted: false,
				reason: "bad-response"
			};
		}
		if (isRecord$3(result) && result.accepted === true) {
			this.message = void 0;
			this.emit();
			return { accepted: true };
		}
		if (isRecord$3(result) && result.accepted === false && result.reason === "not-pending") {
			this.approvals.delete(decision.approvalId);
			this.message = "Approval expired";
			this.emit();
			return {
				accepted: false,
				reason: "not-pending"
			};
		}
		pending.status = "pending";
		this.message = "Invalid approval response";
		this.emit();
		return {
			accepted: false,
			reason: "bad-response"
		};
	}
	openSocket() {
		const origin = this.origin;
		if (this.stopped || origin === void 0) return;
		const generation = this.generation;
		let socket;
		try {
			socket = this.options.webSocketFactory(socketUrl(origin));
		} catch {
			this.handleConnectionFailure(generation);
			return;
		}
		const handle = {
			socket,
			onOpen: () => {
				if (!this.isCurrentSocket(handle, generation)) return;
				this.reconnectAttempt = 0;
				for (const controller of this.responseControllers.values()) controller.abort();
				this.responseControllers.clear();
				this.approvals.clear();
				this.connection = "connected";
				this.message = void 0;
				this.emit();
			},
			onMessage: (event) => {
				if (!this.isCurrentSocket(handle, generation)) return;
				const frame = parsePetWebSocketMessage(event.data);
				if (frame !== void 0) this.handleFrame(frame);
			},
			onClose: () => {
				if (!this.isCurrentSocket(handle, generation)) return;
				this.finishSocket(handle);
				this.handleConnectionFailure(generation);
			},
			onError: () => {
				if (!this.isCurrentSocket(handle, generation)) return;
				this.finishSocket(handle);
				this.handleConnectionFailure(generation);
			}
		};
		this.socket = handle;
		socket.addEventListener("open", handle.onOpen);
		socket.addEventListener("message", handle.onMessage);
		socket.addEventListener("close", handle.onClose);
		socket.addEventListener("error", handle.onError);
		if (socket.readyState === SOCKET_OPEN) handle.onOpen({});
		else if (socket.readyState !== SOCKET_CONNECTING) handle.onClose({});
	}
	isCurrentSocket(handle, generation) {
		return !this.stopped && this.generation === generation && this.socket === handle;
	}
	finishSocket(handle) {
		if (this.socket !== handle) return;
		this.socket = void 0;
		handle.socket.removeEventListener("open", handle.onOpen);
		handle.socket.removeEventListener("message", handle.onMessage);
		handle.socket.removeEventListener("close", handle.onClose);
		handle.socket.removeEventListener("error", handle.onError);
	}
	disposeSocket() {
		const handle = this.socket;
		if (handle === void 0) return;
		this.finishSocket(handle);
		try {
			handle.socket.close();
		} catch {}
	}
	handleConnectionFailure(generation, failureMessage = "DSH connection lost; retrying") {
		if (this.stopped || this.generation !== generation) return;
		this.connection = "reconnecting";
		this.message = failureMessage;
		this.emit();
		this.scheduleReconnect();
	}
	scheduleReconnect() {
		if (this.stopped || this.reconnectTimer !== void 0) return;
		const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt);
		this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 30);
		const timer = setTimeout(() => {
			this.reconnectTimer = void 0;
			if (!this.stopped) this.openSocket();
		}, delay);
		this.reconnectTimer = timer;
		if (typeof timer === "object" && timer !== null && "unref" in timer && typeof timer.unref === "function") timer.unref();
	}
	clearReconnectTimer() {
		if (this.reconnectTimer === void 0) return;
		clearTimeout(this.reconnectTimer);
		this.reconnectTimer = void 0;
	}
	handleFrame(frame) {
		if (frame.type === "session/event") {
			this.handleSessionEvent(frame);
			return;
		}
		if (frame.type === "approval/requested") {
			this.handleApprovalRequested(frame);
			return;
		}
		if (frame.type === "approval/resolved") {
			this.handleApprovalResolved(frame);
			return;
		}
		if (frame.type === "stream/error") {
			this.message = "DSH event stream unavailable";
			this.emit();
			const handle = this.socket;
			if (handle !== void 0) {
				this.finishSocket(handle);
				try {
					handle.socket.close();
				} catch {}
			}
			this.handleConnectionFailure(this.generation, "DSH event stream unavailable");
		}
	}
	handleSessionEvent(frame) {
		if (frame.sessionId !== this.activeSessionId) return;
		if (this.activeLastSeq !== void 0 && frame.seq <= this.activeLastSeq) return;
		this.activeLastSeq = frame.seq;
		if (frame.event.kind === "ignored") return;
		if (frame.event.kind === "turn-start") {
			this.activeDraftKey = void 0;
			this.activeDraft = {
				text: "",
				truncated: false
			};
			this.clearReplyTimer();
			this.reply = void 0;
			this.thinking = true;
			this.emit();
			return;
		}
		if (frame.event.kind === "turn-end") {
			this.thinking = false;
			if (this.reply?.streaming === true) {
				this.reply = {
					...this.reply,
					streaming: false
				};
				this.scheduleReplyClear();
			}
			this.emit();
			return;
		}
		const key = String(frame.event.turn) + ":" + String(frame.event.step);
		if (frame.event.kind === "text-delta") {
			this.clearReplyTimer();
			this.thinking = false;
			if (this.activeDraftKey !== key) {
				this.activeDraftKey = key;
				this.activeDraft = {
					text: "",
					truncated: false
				};
			}
			const next = projectPetText(this.activeDraft.text + frame.event.text);
			if (next !== void 0) this.activeDraft = {
				text: next.text,
				truncated: this.activeDraft.truncated || frame.event.truncated || next.truncated
			};
			if (this.activeDraft.text.length === 0) return;
			this.reply = {
				text: this.activeDraft.text,
				streaming: true,
				truncated: this.activeDraft.truncated
			};
			this.emit();
			return;
		}
		this.activeDraftKey = key;
		this.activeDraft = {
			text: frame.event.text,
			truncated: frame.event.truncated
		};
		this.reply = {
			text: frame.event.text,
			streaming: false,
			truncated: frame.event.truncated
		};
		this.scheduleReplyClear();
		this.thinking = false;
		this.message = void 0;
		this.emit();
	}
	scheduleReplyClear() {
		this.clearReplyTimer();
		this.replyTimer = setTimeout(() => {
			this.replyTimer = void 0;
			if (this.reply?.streaming === false) {
				this.reply = void 0;
				this.emit();
			}
		}, PET_REPLY_HOLD_MS);
		this.replyTimer.unref();
	}
	clearReplyTimer() {
		if (this.replyTimer === void 0) return;
		clearTimeout(this.replyTimer);
		this.replyTimer = void 0;
	}
	handleApprovalRequested(frame) {
		const existing = this.approvals.get(frame.approvalId);
		if (existing !== void 0) {
			if (existing.sessionId !== frame.sessionId || existing.rpcId !== frame.rpcId) return;
			return;
		}
		if (this.approvals.size >= 64) return;
		this.approvals.set(frame.approvalId, {
			approvalId: frame.approvalId,
			rpcId: frame.rpcId,
			sessionId: frame.sessionId,
			toolName: frame.toolName,
			...frame.reason === void 0 ? {} : { reason: frame.reason },
			status: "pending"
		});
		this.emit();
	}
	handleApprovalResolved(frame) {
		const existing = this.approvals.get(frame.approvalId);
		if (existing === void 0 || existing.sessionId !== frame.sessionId) return;
		this.approvals.delete(frame.approvalId);
		this.message = void 0;
		this.emit();
	}
	emit() {
		const state = this.snapshot();
		for (const listener of this.listeners) try {
			listener(state);
		} catch {}
	}
};
//#endregion
//#region src/cli-shell.ts
function cmdLiteral(value) {
	return value.replaceAll("%", "%%");
}
function renderCliShim(runtime) {
	return [
		"@echo off",
		"setlocal",
		`set "PATH=${cmdLiteral(dirname(runtime.pnpmExecutable))};${cmdLiteral(dirname(runtime.nodeExecutable))};%PATH%"`,
		`"${cmdLiteral(runtime.nodeExecutable)}" "${cmdLiteral(runtime.dshBin)}" %*`,
		"exit /b %ERRORLEVEL%",
		""
	].join("\r\n");
}
async function prepareCliShim(runtime, userData) {
	const directory = join(userData, "cli");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "dsh.cmd"), renderCliShim(runtime), "utf8");
	return directory;
}
async function openPluginTerminal(cliDirectory, cwd, inherited = process.env) {
	const environment = {
		...inherited,
		Path: `${cliDirectory};${inherited.Path ?? inherited.PATH ?? ""}`
	};
	environment.PATH = environment.Path;
	const command = [
		"$Host.UI.RawUI.WindowTitle = 'DeepSeek Harness 插件管理'",
		"Write-Host 'dsh plugin --profile web list' -ForegroundColor Cyan",
		"Write-Host 'dsh plugin --profile web add <package-spec>' -ForegroundColor DarkGray"
	].join("; ");
	await new Promise((resolve, reject) => {
		const child = spawn("powershell.exe", [
			"-NoExit",
			"-Command",
			command
		], {
			cwd,
			env: environment,
			detached: true,
			stdio: "ignore",
			windowsHide: false
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	});
}
//#endregion
//#region src/codex-mcp.ts
const MAX_CODEX_SERVERS = 100;
const MAX_NAME_LENGTH = 256;
function keyParts(key) {
	return key.keys.map((part) => part.type === "TOMLBare" ? part.name : part.value);
}
function field(table, name) {
	return table.body.find((item) => {
		const parts = keyParts(item.key);
		return parts.length === 1 && parts[0] === name;
	})?.value;
}
function staticValue(value) {
	return value === void 0 ? void 0 : getStaticTOMLValue(value);
}
function stringField$1(table, name) {
	const value = staticValue(field(table, name));
	return typeof value === "string" ? value : void 0;
}
function stringArrayField(table, name) {
	const value = staticValue(field(table, name));
	if (!Array.isArray(value) || value.length > 256 || !value.every((item) => typeof item === "string")) return void 0;
	return value;
}
function booleanField(table, name) {
	const value = staticValue(field(table, name));
	return typeof value === "boolean" ? value : void 0;
}
function inlineStrings(value) {
	if (value?.type !== "TOMLInlineTable") return {};
	return Object.fromEntries(value.body.flatMap((item) => {
		const parts = keyParts(item.key);
		const resolved = staticValue(item.value);
		return parts.length === 1 && parts[0] !== void 0 && typeof resolved === "string" ? [[parts[0], resolved]] : [];
	}));
}
function tableStrings(table) {
	if (table === void 0) return {};
	return Object.fromEntries(table.body.flatMap((item) => {
		const parts = keyParts(item.key);
		const resolved = staticValue(item.value);
		return parts.length === 1 && parts[0] !== void 0 && typeof resolved === "string" ? [[parts[0], resolved]] : [];
	}));
}
function parseProgram(source, path) {
	try {
		return parseTOML(source, {
			filePath: path,
			tomlVersion: "latest"
		});
	} catch (error) {
		throw new Error("Codex MCP 配置 TOML 无效：" + path, { cause: error });
	}
}
function tables(program) {
	return program.body[0].body.filter((item) => item.type === "TOMLTable");
}
function parseCodexMcpEntries(source, path) {
	const allTables = tables(parseProgram(source, path));
	const serverTables = allTables.filter((table) => {
		const parts = table.resolvedKey;
		return parts.length === 2 && parts[0] === "mcp_servers" && typeof parts[1] === "string";
	});
	if (serverTables.length > MAX_CODEX_SERVERS) throw new Error("Codex MCP Server 数量超过安全上限");
	return serverTables.flatMap((table) => {
		const namePart = table.resolvedKey[1];
		if (typeof namePart !== "string" || namePart.length === 0 || namePart.length > MAX_NAME_LENGTH) return [];
		const nested = (kind) => allTables.find((candidate) => {
			const parts = candidate.resolvedKey;
			return parts.length === 3 && parts[0] === "mcp_servers" && parts[1] === namePart && parts[2] === kind;
		});
		const command = stringField$1(table, "command");
		const url = stringField$1(table, "url");
		const configuredType = stringField$1(table, "type");
		const transport = configuredType === "stdio" || command !== void 0 ? "stdio" : configuredType === "http" || configuredType === "streamable-http" || url !== void 0 ? "streamable-http" : "unknown";
		const environment = {
			...inlineStrings(field(table, "env")),
			...tableStrings(nested("env"))
		};
		const headers = {
			...inlineStrings(field(table, "headers")),
			...inlineStrings(field(table, "http_headers")),
			...tableStrings(nested("headers")),
			...tableStrings(nested("http_headers"))
		};
		const args = stringArrayField(table, "args");
		const cwd = stringField$1(table, "cwd");
		return [{
			name: namePart,
			enabled: booleanField(table, "enabled") !== false,
			transport,
			...command === void 0 ? {} : { command },
			...args === void 0 ? {} : { args },
			...cwd === void 0 ? {} : { cwd },
			environment,
			...url === void 0 ? {} : { url },
			headers
		}];
	});
}
//#endregion
//#region src/mcp-manager.ts
const MAX_PACKAGE_BYTES = 256 * 1024;
const MAX_PATCH_BYTES = 1024 * 1024;
const MAX_BUNDLES = 100;
const SECRET_FLAG = /(?:api[-_]?key|auth|bearer|credential|password|secret|token)/iu;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u;
function isRecord$2(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function own(value, key) {
	return Object.prototype.hasOwnProperty.call(value, key);
}
function boundedText$1(value, limit = 4096) {
	return typeof value === "string" && value.length > 0 && value.length <= limit ? value : void 0;
}
function stringArray(value, limit = 256) {
	if (!Array.isArray(value) || value.length > limit) return [];
	return value.flatMap((item) => typeof item === "string" && item.length <= 4096 ? [item] : []);
}
function recordKeys(value) {
	if (!isRecord$2(value)) return [];
	return Object.keys(value).filter((key) => key.length <= 256).sort((left, right) => left.localeCompare(right));
}
function sanitizeUrl(value) {
	const text = boundedText$1(value);
	if (text === void 0) return void 0;
	try {
		const url = new URL(text);
		url.username = "";
		url.password = "";
		url.search = "";
		url.hash = "";
		return url.href;
	} catch {
		return;
	}
}
function sanitizeArgs(value) {
	const args = stringArray(value);
	let hideNext = false;
	return args.map((argument) => {
		if (hideNext) {
			hideNext = false;
			return "[hidden]";
		}
		const separator = argument.indexOf("=");
		if (separator > 0 && SECRET_FLAG.test(argument.slice(0, separator))) return argument.slice(0, separator + 1) + "[hidden]";
		if (argument.startsWith("-") && SECRET_FLAG.test(argument)) hideNext = true;
		if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(argument)) return sanitizeUrl(argument) ?? "[invalid URL]";
		return argument;
	});
}
function transport(value) {
	return value === "stdio" || value === "streamable-http" ? value : "unknown";
}
function endpoint(value, fallbackName) {
	if (!isRecord$2(value)) return void 0;
	const name = boundedText$1(value.name, 128) ?? boundedText$1(value.serverName, 128) ?? fallbackName;
	const selectedTransport = transport(value.transport);
	if (selectedTransport === "stdio") {
		const command = boundedText$1(value.command);
		const cwd = boundedText$1(value.cwd);
		return {
			name,
			transport: selectedTransport,
			...command === void 0 ? {} : { command },
			...own(value, "args") ? { args: sanitizeArgs(value.args) } : {},
			...cwd === void 0 ? {} : { cwd },
			...own(value, "env") ? { environmentKeys: recordKeys(value.env) } : {}
		};
	}
	if (selectedTransport === "streamable-http") {
		const url = sanitizeUrl(value.url);
		return {
			name,
			transport: selectedTransport,
			...url === void 0 ? {} : { url },
			...own(value, "headers") ? { headerKeys: recordKeys(value.headers) } : {}
		};
	}
	return {
		name,
		transport: selectedTransport
	};
}
function isDirectClientName(value) {
	return value === "@deepseek-ai/dsh-mcp-client";
}
function isLensEntry(value) {
	return value.name === "dsh-mcp-lens";
}
function keyFor(provider, id, source, index) {
	return createHash("sha256").update(provider).update("\0").update(id ?? "").update("\0").update(source).update("\0").update(String(index)).digest("hex").slice(0, 24);
}
function revision$1(sources) {
	const hash = createHash("sha256");
	for (const source of sources) hash.update(String(Buffer.byteLength(source, "utf8"))).update(":").update(source);
	return hash.digest("hex");
}
function parsePatch(source, path) {
	if (Buffer.byteLength(source, "utf8") > MAX_PATCH_BYTES) throw new Error("MCP 配置文件超过 1 MiB，拒绝读取：" + path);
	const document = parseDocument(source.trim().length === 0 ? "[]\n" : source);
	if (document.errors.length > 0) throw new Error("MCP 配置 YAML 无效：" + document.errors[0]?.message);
	const data = document.toJS({ maxAliasCount: 100 });
	if (!Array.isArray(data)) throw new Error("MCP 配置必须是顶层 YAML 数组：" + path);
	return {
		document,
		data
	};
}
function applyOverrides(target, patch, control, lockLayer) {
	if (typeof patch.name === "string" && target.name !== void 0 && patch.name !== target.name) return;
	if (own(patch, "config")) target.config = patch.config;
	if (own(patch, "disabled")) {
		target.disabled = patch.disabled;
		if (lockLayer) target.locked = true;
	}
	if (control !== void 0) target.control = control;
}
function entryFrom(value, source, control, locked) {
	const id = boundedText$1(value.id, 256);
	const name = boundedText$1(value.name, 512);
	return {
		...id === void 0 ? {} : { id },
		...name === void 0 ? {} : { name },
		...own(value, "config") ? { config: value.config } : {},
		...own(value, "disabled") ? { disabled: value.disabled } : {},
		source,
		...control === void 0 ? {} : { control },
		...locked ? { locked: true } : {}
	};
}
function applyPatchLayer(data, source, entries, anonymous, options = {}) {
	const lockLayer = options.lockLayer === true;
	const controlAt = (path) => {
		return path === void 0 || options.controlLayer === void 0 ? void 0 : {
			layer: options.controlLayer,
			path
		};
	};
	const addEntry = (value, path) => {
		if (!isRecord$2(value)) return;
		const configEntry = entryFrom(value, source, controlAt(path), lockLayer);
		if (configEntry.id === void 0) anonymous.push(configEntry);
		else entries.set(configEntry.id, configEntry);
		if (value.group === true && Array.isArray(value.config)) value.config.forEach((child, index) => addEntry(child, path === void 0 ? void 0 : [
			...path,
			"config",
			index
		]));
	};
	data.forEach((value, index) => {
		if (!isRecord$2(value)) return;
		if (Array.isArray(value.insert)) {
			value.insert.forEach((inserted, insertedIndex) => addEntry(inserted, [
				index,
				"insert",
				insertedIndex
			]));
			return;
		}
		const id = boundedText$1(value.id, 256);
		if (id === void 0) return;
		const target = entries.get(id);
		if (target !== void 0) applyOverrides(target, value, controlAt([index]), lockLayer);
	});
}
function toInternalEntry(value, index) {
	if (isDirectClientName(value.name)) {
		const config = isRecord$2(value.config) ? value.config : {};
		const server = endpoint(config, value.id ?? "MCP Server");
		const displayName = boundedText$1(config.serverName, 128) ?? value.id ?? "MCP Server";
		const dynamic = value.disabled !== void 0 && value.disabled !== null && typeof value.disabled !== "boolean";
		return {
			view: {
				key: keyFor("direct", value.id, value.source, index),
				...value.id === void 0 ? {} : { entryId: value.id },
				name: displayName,
				provider: "DSH MCP Client",
				management: "dsh",
				enabled: !dynamic && value.disabled !== true,
				...dynamic ? { dynamic: true } : {},
				mutable: value.id !== void 0 && value.locked !== true,
				source: value.source,
				endpoints: server === void 0 ? [] : [server]
			},
			...value.id === void 0 ? {} : { entryId: value.id },
			...value.name === void 0 ? {} : { entryName: value.name },
			...value.control === void 0 ? {} : { control: value.control }
		};
	}
	if (!isLensEntry(value)) return void 0;
	const config = isRecord$2(value.config) ? value.config : {};
	const endpoints = (Array.isArray(config.servers) ? config.servers : []).flatMap((server, serverIndex) => {
		const result = endpoint(server, "Server " + String(serverIndex + 1));
		return result === void 0 ? [] : [result];
	});
	const dynamic = value.disabled !== void 0 && value.disabled !== null && typeof value.disabled !== "boolean";
	return {
		view: {
			key: keyFor("lens", value.id, value.source, index),
			...value.id === void 0 ? {} : { entryId: value.id },
			name: "MCP Lens",
			provider: "MCP Lens",
			management: "dsh",
			enabled: !dynamic && value.disabled !== true,
			...dynamic ? { dynamic: true } : {},
			mutable: value.id !== void 0 && value.locked !== true,
			source: value.source,
			endpoints,
			...Array.isArray(config.allowTools) ? { allowToolCount: config.allowTools.length } : {},
			...Array.isArray(config.denyTools) ? { denyToolCount: config.denyTools.length } : {}
		},
		...value.id === void 0 ? {} : { entryId: value.id },
		...value.name === void 0 ? {} : { entryName: value.name },
		...value.control === void 0 ? {} : { control: value.control }
	};
}
function codexImportId(name) {
	return "desktop-codex-" + createHash("sha256").update(name).digest("hex").slice(0, 16);
}
function codexServerName(name) {
	return /^[A-Za-z0-9_-]{1,32}$/u.test(name) ? name : "codex_" + createHash("sha256").update(name).digest("hex").slice(0, 12);
}
function codexDshConfig(value) {
	const serverName = codexServerName(value.name);
	if (value.transport === "stdio" && value.command !== void 0) return {
		serverName,
		transport: "stdio",
		command: value.command,
		...value.args === void 0 ? {} : { args: value.args },
		...Object.keys(value.environment).length === 0 ? {} : { env: value.environment },
		...value.cwd === void 0 ? {} : { cwd: value.cwd }
	};
	if (value.transport === "streamable-http" && value.url !== void 0) return {
		serverName,
		transport: "streamable-http",
		url: value.url,
		...Object.keys(value.headers).length === 0 ? {} : { headers: value.headers }
	};
}
function toInternalCodexEntry(value, target, index) {
	const entryId = codexImportId(value.name);
	const imported = target?.name === "@deepseek-ai/dsh-mcp-client";
	const identityConflict = target !== void 0 && !imported;
	const dynamic = imported && target.disabled !== void 0 && target.disabled !== null && typeof target.disabled !== "boolean";
	const config = codexDshConfig(value);
	const server = endpoint({
		name: value.name,
		transport: value.transport,
		...value.command === void 0 ? {} : { command: value.command },
		...value.args === void 0 ? {} : { args: value.args },
		...value.cwd === void 0 ? {} : { cwd: value.cwd },
		...Object.keys(value.environment).length === 0 ? {} : { env: value.environment },
		...value.url === void 0 ? {} : { url: value.url },
		...Object.keys(value.headers).length === 0 ? {} : { headers: value.headers }
	}, value.name);
	return {
		view: {
			key: keyFor("codex", entryId, "Codex 配置", index),
			entryId,
			name: value.name,
			provider: "Codex MCP",
			management: "codex-import",
			enabled: imported && !dynamic && target.disabled !== true,
			sourceEnabled: value.enabled,
			...dynamic ? { dynamic: true } : {},
			mutable: config !== void 0 && !identityConflict && target?.locked !== true,
			source: imported ? "Codex → DSH" : "Codex 配置（未接入 DSH）",
			endpoints: server === void 0 ? [] : [server]
		},
		entryId,
		entryName: "@deepseek-ai/dsh-mcp-client",
		...target?.control === void 0 ? {} : { control: target.control },
		codexImported: imported,
		...config === void 0 ? {} : { codexConfig: config }
	};
}
function parseSetEnabledInput(value) {
	if (!isRecord$2(value)) throw new TypeError("MCP 开关请求无效");
	const key = boundedText$1(value.key, 64);
	const expectedRevision = boundedText$1(value.expectedRevision, 64);
	if (key === void 0 || !/^[a-f0-9]{24}$/u.test(key) || typeof value.enabled !== "boolean" || expectedRevision === void 0 || !/^[a-f0-9]{64}$/u.test(expectedRevision)) throw new TypeError("MCP 开关请求无效");
	return {
		key,
		enabled: value.enabled,
		expectedRevision
	};
}
function retryableRename(error) {
	const code = error?.code;
	return code === "EACCES" || code === "EBUSY" || code === "EPERM";
}
async function atomicWrite(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const temporary = path + ".desktop-" + randomUUID() + ".tmp";
	try {
		await writeFile(temporary, content, {
			encoding: "utf8",
			flag: "wx",
			mode: 384
		});
		for (let attempt = 0;; attempt += 1) try {
			await rename(temporary, path);
			return;
		} catch (error) {
			if (attempt >= 9 || !retryableRename(error)) throw error;
			await setTimeout$1(50);
		}
	} finally {
		await rm(temporary, { force: true }).catch(() => {});
	}
}
async function readBounded(path, limit, optional = false) {
	let value;
	try {
		value = await readFile(path, "utf8");
	} catch (error) {
		if (optional && error?.code === "ENOENT") return void 0;
		throw error;
	}
	if (Buffer.byteLength(value, "utf8") > limit) throw new Error("配置文件过大，拒绝读取：" + path);
	return value;
}
var McpManager = class {
	profileDirectory;
	patchPath;
	homePatchPath;
	codexConfigPath;
	overlayPaths;
	constructor(options) {
		const profile = options.profile ?? "web";
		if (!/^[a-z0-9][a-z0-9._-]*$/u.test(profile)) throw new TypeError("invalid DSH profile name");
		this.profileDirectory = join(options.home, "profiles", profile);
		this.patchPath = join(this.profileDirectory, "cordis.patch.yml");
		this.homePatchPath = join(options.home, "cordis.patch.yml");
		this.codexConfigPath = options.codexConfigPath;
		this.overlayPaths = options.overlayPaths ?? (() => []);
	}
	async list() {
		const state = await this.load();
		return {
			revision: state.revision,
			entries: state.entries.map((entry) => entry.view)
		};
	}
	async setEnabled(value) {
		const input = parseSetEnabledInput(value);
		const state = await this.load();
		if (state.revision !== input.expectedRevision) throw new Error("MCP 配置已被其他程序修改，请刷新后重试");
		const target = state.entries.find((entry) => entry.view.key === input.key);
		if (target === void 0) throw new Error("MCP 配置项已不存在，请刷新后重试");
		if (target.entryId === void 0) throw new Error("该 MCP 缺少稳定的 Cordis entry id，无法安全切换");
		if (!target.view.mutable) {
			if (target.view.management === "codex-import") throw new Error("该 Codex MCP 无法安全接入 DSH，请检查传输配置或 Entry ID 冲突");
			throw new Error("该 MCP 状态由更高优先级的桌面 Runtime overlay 控制");
		}
		if (target.view.dynamic !== true && target.view.enabled === input.enabled) return {
			revision: state.revision,
			entries: state.entries.map((entry) => entry.view)
		};
		const selected = target.control?.layer === "home" ? state.homeDocument : state.profileDocument;
		if (selected === void 0) throw new Error("MCP 全局配置文件已不存在，请刷新后重试");
		const document = selected.document;
		if (target.view.management === "codex-import" && target.codexImported !== true) {
			if (target.codexConfig === void 0) throw new Error("该 Codex MCP 的传输配置无法转换为 DSH MCP Client");
			if (!isSeq(document.contents)) throw new Error("MCP 配置必须是顶层 YAML 数组");
			document.contents.flow = false;
			document.contents.add({ insert: [{
				id: target.entryId,
				name: target.entryName,
				config: target.codexConfig,
				disabled: false
			}] });
		} else if (target.control !== void 0) {
			const disabledPath = [...target.control.path, "disabled"];
			document.setIn(disabledPath, !input.enabled);
			const disabledNode = document.getIn(disabledPath, true);
			if (isScalar(disabledNode)) delete disabledNode.tag;
		} else {
			if (!isSeq(document.contents)) throw new Error("MCP 配置必须是顶层 YAML 数组");
			document.contents.flow = false;
			document.contents.add({
				id: target.entryId,
				...target.entryName === void 0 ? {} : { name: target.entryName },
				disabled: !input.enabled
			});
		}
		const output = String(document);
		parsePatch(output, selected.path);
		await atomicWrite(selected.path, output);
		return this.list();
	}
	async load() {
		const profileSource = await readBounded(this.patchPath, MAX_PATCH_BYTES, true) ?? "[]\n";
		const profilePatch = parsePatch(profileSource, this.patchPath);
		const homeSource = await readBounded(this.homePatchPath, MAX_PATCH_BYTES, true);
		const homePatch = homeSource === void 0 ? void 0 : parsePatch(homeSource, this.homePatchPath);
		const codexSource = this.codexConfigPath === void 0 ? void 0 : await readBounded(this.codexConfigPath, MAX_PATCH_BYTES, true);
		const codexEntries = codexSource === void 0 || this.codexConfigPath === void 0 ? [] : parseCodexMcpEntries(codexSource, this.codexConfigPath);
		const entries = /* @__PURE__ */ new Map();
		const anonymous = [];
		const revisionSources = [
			this.patchPath,
			profileSource,
			this.homePatchPath,
			homeSource ?? "<missing>"
		];
		if (this.codexConfigPath !== void 0) revisionSources.push(this.codexConfigPath, codexSource ?? "<missing>");
		await this.loadBundleLayers(entries, anonymous, revisionSources);
		applyPatchLayer(profilePatch.data, "Profile 配置", entries, anonymous, { controlLayer: "profile" });
		if (homePatch !== void 0) applyPatchLayer(homePatch.data, "全局配置", entries, anonymous, { controlLayer: "home" });
		const overlayPaths = [...new Set(this.overlayPaths())];
		if (overlayPaths.length > MAX_BUNDLES) throw new Error("桌面 Runtime overlay 数量超过安全上限");
		for (const overlayPath of overlayPaths) {
			const source = await readBounded(overlayPath, MAX_PATCH_BYTES, true);
			revisionSources.push(overlayPath, source ?? "<missing>");
			if (source === void 0) continue;
			applyPatchLayer(parsePatch(source, overlayPath).data, basename(overlayPath), entries, anonymous, { lockLayer: true });
		}
		const codexIds = new Set(codexEntries.map((entry) => codexImportId(entry.name)));
		const dshResolved = [...entries.values(), ...anonymous].filter((entry) => entry.id === void 0 || !codexIds.has(entry.id) || !isDirectClientName(entry.name)).map((entry, index) => toInternalEntry(entry, index)).filter((entry) => entry !== void 0);
		const codexResolved = codexEntries.map((entry, index) => {
			return toInternalCodexEntry(entry, entries.get(codexImportId(entry.name)), index);
		});
		const resolved = [...dshResolved, ...codexResolved].sort((left, right) => left.view.name.localeCompare(right.view.name, "zh-CN"));
		return {
			revision: revision$1(revisionSources),
			profileDocument: {
				path: this.patchPath,
				document: profilePatch.document
			},
			...homePatch === void 0 ? {} : { homeDocument: {
				path: this.homePatchPath,
				document: homePatch.document
			} },
			entries: resolved
		};
	}
	async loadBundleLayers(entries, anonymous, revisionSources) {
		const manifestPath = join(this.profileDirectory, "package.json");
		const source = await readBounded(manifestPath, MAX_PACKAGE_BYTES, true);
		revisionSources.push(manifestPath, source ?? "<missing>");
		if (source === void 0) return;
		let manifest;
		try {
			manifest = JSON.parse(source);
		} catch (error) {
			throw new Error("DSH Profile package.json 无效", { cause: error });
		}
		if (!isRecord$2(manifest) || !isRecord$2(manifest.dsh) || !isRecord$2(manifest.dsh.profile) || !Array.isArray(manifest.dsh.profile.bundles)) return;
		const bundles = manifest.dsh.profile.bundles;
		if (bundles.length > MAX_BUNDLES) throw new Error("DSH Profile Bundle 数量超过安全上限");
		for (const bundle of bundles) {
			if (typeof bundle !== "string" || !PACKAGE_NAME.test(bundle)) continue;
			const packageRoot = join(this.profileDirectory, "node_modules", ...bundle.split("/"));
			const packagePath = join(packageRoot, "package.json");
			const packageSource = await readBounded(packagePath, MAX_PACKAGE_BYTES, true);
			revisionSources.push(packagePath, packageSource ?? "<missing>");
			if (packageSource === void 0) continue;
			let packageManifest;
			try {
				packageManifest = JSON.parse(packageSource);
			} catch {
				continue;
			}
			if (!isRecord$2(packageManifest) || !isRecord$2(packageManifest.dsh) || !isRecord$2(packageManifest.dsh.bundle)) continue;
			const patch = boundedText$1(packageManifest.dsh.bundle.patch, 512);
			if (patch === void 0) continue;
			const patchPath = resolve(packageRoot, patch);
			const pathFromRoot = relative(resolve(packageRoot), patchPath);
			if (pathFromRoot.startsWith("..") || isAbsolute(pathFromRoot)) continue;
			const patchSource = await readBounded(patchPath, MAX_PATCH_BYTES, true);
			revisionSources.push(patchPath, patchSource ?? "<missing>");
			if (patchSource === void 0) continue;
			applyPatchLayer(parsePatch(patchSource, patchPath).data, bundle, entries, anonymous);
		}
	}
};
//#endregion
//#region src/mcp-restart.ts
async function mutateMcpWithRuntime(options) {
	let result;
	let failure;
	try {
		await options.pause();
		result = await options.mutate();
	} catch (error) {
		failure = error;
	}
	try {
		await options.retry();
	} catch (error) {
		failure = failure === void 0 ? error : new AggregateError([failure, error], "MCP 配置写入和 Runtime 恢复均失败");
	}
	if (failure !== void 0) throw failure;
	if (result === void 0) throw new Error("MCP 操作未返回结果");
	return result;
}
//#endregion
//#region src/personalization-manager.ts
const PERSONALIZATION_MAX_BYTES = 65536;
function revision(state) {
	return createHash("sha256").update(state.exists ? "present\0" : "missing\0").update(state.bytes).digest("hex");
}
function parseSaveInput(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("个性化设置保存参数无效");
	const input = value;
	const keys = Object.keys(input).sort();
	if (keys.length !== 2 || keys[0] !== "content" || keys[1] !== "expectedRevision") throw new Error("个性化设置保存参数无效");
	if (typeof input.content !== "string" || typeof input.expectedRevision !== "string") throw new Error("个性化设置保存参数无效");
	if (!/^[a-f0-9]{64}$/u.test(input.expectedRevision)) throw new Error("个性化设置 revision 无效");
	if (input.content.includes("\0")) throw new Error("个性化设置不能包含 NUL 字符");
	if (Buffer.byteLength(input.content, "utf8") > 65536) throw new Error("个性化设置不能超过 " + PERSONALIZATION_MAX_BYTES.toLocaleString("zh-CN") + " B");
	return {
		content: input.content,
		expectedRevision: input.expectedRevision
	};
}
var PersonalizationManager = class {
	path;
	mutationQueue = Promise.resolve();
	constructor(options) {
		if (options === null || typeof options !== "object" || typeof options.home !== "string" || options.home.length === 0) throw new Error("个性化设置目录无效");
		this.path = join(options.home, "AGENTS.md");
	}
	async read() {
		return this.toDocument(await this.readState());
	}
	save(value) {
		const operation = this.mutationQueue.then(() => this.saveLocked(parseSaveInput(value)));
		this.mutationQueue = operation.then(() => void 0, () => void 0);
		return operation;
	}
	async saveLocked(input) {
		if (revision(await this.readState()) !== input.expectedRevision) throw new Error("个性化设置已被其他程序修改，请重新加载后再保存");
		if (input.content.trim().length === 0) {
			if (revision(await this.readState()) !== input.expectedRevision) throw new Error("个性化设置已被其他程序修改，请重新加载后再保存");
			await rm(this.path, { force: true });
			return this.read();
		}
		await mkdir(dirname(this.path), { recursive: true });
		const temporary = join(dirname(this.path), ".AGENTS.md." + randomUUID() + ".tmp");
		try {
			await writeFile(temporary, input.content, {
				encoding: "utf8",
				flag: "wx",
				mode: 384
			});
			if (revision(await this.readState()) !== input.expectedRevision) throw new Error("个性化设置已被其他程序修改，请重新加载后再保存");
			await rename(temporary, this.path);
		} finally {
			await rm(temporary, { force: true }).catch(() => void 0);
		}
		return this.read();
	}
	async readState() {
		try {
			return {
				bytes: await readFile(this.path),
				exists: true
			};
		} catch (error) {
			if (error.code === "ENOENT") return {
				bytes: Buffer.alloc(0),
				exists: false
			};
			throw error;
		}
	}
	toDocument(state) {
		const content = state.bytes.toString("utf8");
		if (!Buffer.from(content, "utf8").equals(state.bytes)) throw new Error("个性化设置文件不是有效的 UTF-8 文本");
		return {
			path: this.path,
			content,
			exists: state.exists,
			revision: revision(state),
			maxBytes: PERSONALIZATION_MAX_BYTES
		};
	}
};
//#endregion
//#region src/pet-size.ts
const DEFAULT_PET_SIZE = "standard";
const PET_SIZE_SPECS = {
	small: {
		mascotSize: 72,
		mascotX: 256,
		mascotY: 136,
		windowWidth: 336,
		windowHeight: 216
	},
	standard: {
		mascotSize: 96,
		mascotX: 256,
		mascotY: 136,
		windowWidth: 360,
		windowHeight: 240
	},
	large: {
		mascotSize: 128,
		mascotX: 256,
		mascotY: 136,
		windowWidth: 392,
		windowHeight: 272
	}
};
function parsePetSize(value) {
	return value === "small" || value === "large" ? value : DEFAULT_PET_SIZE;
}
//#endregion
//#region src/pet-window.ts
const EDGE_GAP = 16;
const SAVE_DELAY_MS = 250;
const STREAM_UPDATE_MS = 100;
const LEGACY_SKIN_FILES = [
	"desktop-pet-skin.png",
	"desktop-pet-skin.png.tmp",
	"desktop-pet-skin.gif",
	"desktop-pet-skin.gif.tmp"
];
function finiteInteger(value) {
	return typeof value === "number" && Number.isSafeInteger(value) ? value : void 0;
}
function parsePetWindowShape(value, size = DEFAULT_PET_SIZE) {
	if (value === null) return void 0;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("pet shape must be a rectangle");
	const input = value;
	const spec = PET_SIZE_SPECS[size];
	if (typeof input.x !== "number" || !Number.isSafeInteger(input.x) || input.x < 0 || typeof input.y !== "number" || !Number.isSafeInteger(input.y) || input.y < 0 || typeof input.width !== "number" || !Number.isSafeInteger(input.width) || input.width <= 0 || typeof input.height !== "number" || !Number.isSafeInteger(input.height) || input.height <= 0 || input.x + input.width > spec.windowWidth || input.y + input.height > spec.windowHeight) throw new Error("pet shape is outside the window");
	return {
		x: input.x,
		y: input.y,
		width: input.width,
		height: input.height
	};
}
function parseSettings(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {
		version: 1,
		manuallyHidden: false,
		size: DEFAULT_PET_SIZE
	};
	const input = value;
	const x = finiteInteger(input.x);
	const y = finiteInteger(input.y);
	const displayId = finiteInteger(input.displayId);
	return {
		version: 1,
		manuallyHidden: input.manuallyHidden === true,
		size: parsePetSize(input.size),
		...x === void 0 ? {} : { x },
		...y === void 0 ? {} : { y },
		...displayId === void 0 ? {} : { displayId }
	};
}
var PetWindowController = class {
	settingsPath;
	window;
	settings = {
		version: 1,
		manuallyHidden: false,
		size: DEFAULT_PET_SIZE
	};
	state = {
		mode: "unavailable",
		status: "DSH 正在启动"
	};
	mainVisible = true;
	rendererReady = false;
	hoverInteractive = false;
	dragState;
	bubbleShape;
	disposing = false;
	saveTimer;
	stateTimer;
	savePromise = Promise.resolve();
	crashTimes = [];
	displayChanged = () => {
		this.reclamp();
	};
	constructor(options) {
		this.options = options;
		this.settingsPath = join(options.userData, "desktop-pet.json");
	}
	async start() {
		this.settings = await this.readSettings();
		await Promise.all(LEGACY_SKIN_FILES.map((file) => rm(join(this.options.userData, file), { force: true }))).catch((error) => {
			this.options.onFatal(error);
		});
		this.createWindow();
		screen.on("display-added", this.displayChanged);
		screen.on("display-removed", this.displayChanged);
		screen.on("display-metrics-changed", this.displayChanged);
	}
	get enabled() {
		return !this.settings.manuallyHidden;
	}
	get size() {
		return this.settings.size;
	}
	get visible() {
		return this.window?.isVisible() ?? false;
	}
	get webContents() {
		return this.window?.webContents;
	}
	setMainVisible(visible) {
		this.mainVisible = visible;
		this.reconcileVisibility();
	}
	async setEnabled(enabled) {
		this.settings.manuallyHidden = !enabled;
		this.reconcileVisibility();
		await this.save();
	}
	async setSize(size) {
		if (size === this.settings.size) return;
		const previous = PET_SIZE_SPECS[this.settings.size];
		const next = PET_SIZE_SPECS[size];
		this.settings = {
			...this.settings,
			size
		};
		const window = this.window;
		if (window !== void 0 && !window.isDestroyed()) {
			const bounds = window.getBounds();
			const centerX = bounds.x + previous.mascotX + previous.mascotSize / 2;
			const centerY = bounds.y + previous.mascotY + previous.mascotSize / 2;
			const candidate = {
				x: Math.round(centerX - next.mascotX - next.mascotSize / 2),
				y: Math.round(centerY - next.mascotY - next.mascotSize / 2),
				width: next.windowWidth,
				height: next.windowHeight
			};
			const display = screen.getDisplayMatching(bounds);
			window.setBounds(clampPetBounds(candidate, display.workArea), false);
			this.applyWindowShape();
			this.sendSize();
			await this.captureAndSave();
			return;
		}
		await this.save();
	}
	setState(state) {
		this.state = state;
		if (state.mode === "speaking") {
			if (this.stateTimer === void 0) {
				this.stateTimer = setTimeout(() => {
					this.stateTimer = void 0;
					this.sendState();
				}, STREAM_UPDATE_MS);
				this.stateTimer.unref();
			}
		} else {
			this.clearStateTimer();
			this.sendState();
		}
		this.applyMousePolicy();
	}
	setInteraction(interactive) {
		this.hoverInteractive = interactive;
		this.applyMousePolicy();
	}
	setBubbleShape(shape) {
		this.bubbleShape = shape;
		this.applyWindowShape();
	}
	startDrag(point) {
		const window = this.window;
		if (window === void 0 || window.isDestroyed() || !window.isVisible()) return;
		this.dragState = {
			pointerX: point.x,
			pointerY: point.y,
			bounds: window.getBounds()
		};
		this.applyMousePolicy();
	}
	dragTo(point) {
		const window = this.window;
		const drag = this.dragState;
		if (window === void 0 || window.isDestroyed() || drag === void 0) return;
		const spec = PET_SIZE_SPECS[this.settings.size];
		const candidate = {
			x: Math.round(drag.bounds.x + point.x - drag.pointerX),
			y: Math.round(drag.bounds.y + point.y - drag.pointerY),
			width: spec.windowWidth,
			height: spec.windowHeight
		};
		const display = screen.getDisplayNearestPoint({
			x: point.x,
			y: point.y
		});
		window.setBounds(clampPetBounds(candidate, display.workArea), false);
	}
	endDrag() {
		if (this.dragState === void 0) return;
		this.dragState = void 0;
		this.scheduleSave();
		this.applyMousePolicy();
	}
	rendererDidLoad() {
		this.rendererReady = true;
		this.clearStateTimer();
		this.sendSize();
		this.sendState();
		this.applyMousePolicy();
		this.reconcileVisibility();
	}
	matchesSender(contents, page) {
		if (this.window === void 0 || this.window.isDestroyed() || contents !== this.window.webContents) return false;
		try {
			const url = new URL(contents.getURL());
			return url.protocol === "file:" && resolve(fileURLToPath(url)) === resolve(page);
		} catch {
			return false;
		}
	}
	async dispose() {
		if (this.disposing) return;
		this.disposing = true;
		this.dragState = void 0;
		screen.off("display-added", this.displayChanged);
		screen.off("display-removed", this.displayChanged);
		screen.off("display-metrics-changed", this.displayChanged);
		if (this.saveTimer !== void 0) {
			clearTimeout(this.saveTimer);
			this.saveTimer = void 0;
		}
		this.clearStateTimer();
		await this.captureAndSave();
		if (this.window !== void 0 && !this.window.isDestroyed()) this.window.destroy();
		this.window = void 0;
	}
	createWindow() {
		const window = new BrowserWindow({
			...this.initialBounds(),
			frame: false,
			transparent: true,
			resizable: false,
			movable: true,
			alwaysOnTop: true,
			skipTaskbar: true,
			hasShadow: false,
			show: false,
			backgroundColor: "#00000000",
			icon: nativeImage.createFromPath(this.options.icon),
			webPreferences: {
				preload: this.options.preload,
				nodeIntegration: false,
				contextIsolation: true,
				sandbox: true
			}
		});
		this.window = window;
		this.rendererReady = false;
		window.setAlwaysOnTop(true, "floating");
		window.setMenu(null);
		this.applyWindowShape();
		window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		window.webContents.on("will-navigate", (event, url) => {
			if (url !== window.webContents.getURL()) event.preventDefault();
		});
		window.webContents.on("did-finish-load", () => {
			this.rendererDidLoad();
		});
		window.webContents.on("render-process-gone", (_event, details) => {
			if (!this.disposing && details.reason !== "clean-exit") this.recoverRenderer(/* @__PURE__ */ new Error("pet renderer exited: " + details.reason));
		});
		window.on("unresponsive", () => {
			if (!this.disposing) this.recoverRenderer(/* @__PURE__ */ new Error("pet renderer became unresponsive"));
		});
		window.on("move", () => {
			this.scheduleSave();
		});
		window.on("close", (event) => {
			if (this.disposing) return;
			event.preventDefault();
			this.setEnabled(false);
		});
		window.on("closed", () => {
			if (this.window === window) this.window = void 0;
		});
		window.loadFile(this.options.page).catch((error) => {
			this.options.onFatal(error);
		});
	}
	recoverRenderer(error) {
		const failed = this.window;
		if (failed === void 0) return;
		this.dragState = void 0;
		this.window = void 0;
		this.options.onFatal(error);
		const now = Date.now();
		this.crashTimes = this.crashTimes.filter((time) => now - time < 6e4);
		this.crashTimes.push(now);
		if (this.crashTimes.length > 3) {
			this.settings.manuallyHidden = true;
			if (!failed.isDestroyed()) failed.destroy();
			this.save();
			return;
		}
		if (!failed.isDestroyed()) failed.destroy();
		setTimeout(() => {
			if (!this.disposing && this.window === void 0) this.createWindow();
		}, this.crashTimes.length * 500).unref();
	}
	initialBounds() {
		const display = screen.getAllDisplays().find((candidate) => candidate.id === this.settings.displayId) ?? screen.getPrimaryDisplay();
		const spec = PET_SIZE_SPECS[this.settings.size];
		const windowSize = {
			width: spec.windowWidth,
			height: spec.windowHeight
		};
		const fallback = defaultPetBounds(display.workArea, windowSize, EDGE_GAP);
		return clampPetBounds(this.settings.x === void 0 || this.settings.y === void 0 ? fallback : {
			x: this.settings.x,
			y: this.settings.y,
			...windowSize
		}, display.workArea);
	}
	reclamp() {
		const window = this.window;
		if (window === void 0 || window.isDestroyed()) return;
		const bounds = window.getBounds();
		const display = screen.getDisplayMatching(bounds);
		const spec = PET_SIZE_SPECS[this.settings.size];
		const next = clampPetBounds({
			...bounds,
			width: spec.windowWidth,
			height: spec.windowHeight
		}, display.workArea);
		if (next.x !== bounds.x || next.y !== bounds.y || next.width !== bounds.width || next.height !== bounds.height) window.setBounds(next, false);
		this.scheduleSave();
	}
	reconcileVisibility() {
		const window = this.window;
		if (window === void 0 || window.isDestroyed() || !this.rendererReady) return;
		if (!this.mainVisible && !this.settings.manuallyHidden) {
			this.applyMousePolicy();
			window.showInactive();
			this.sendVisibility(true);
		} else {
			this.dragState = void 0;
			this.hoverInteractive = false;
			this.applyMousePolicy();
			this.sendVisibility(false);
			window.hide();
		}
	}
	sendVisibility(visible) {
		if (this.rendererReady && this.window !== void 0 && !this.window.isDestroyed()) this.window.webContents.send("pet:visibility", visible);
	}
	clearStateTimer() {
		if (this.stateTimer !== void 0) {
			clearTimeout(this.stateTimer);
			this.stateTimer = void 0;
		}
	}
	sendState() {
		if (this.rendererReady && this.window !== void 0 && !this.window.isDestroyed()) this.window.webContents.send("pet:state", this.state);
	}
	sendSize() {
		if (this.rendererReady && this.window !== void 0 && !this.window.isDestroyed()) this.window.webContents.send("pet:size", this.settings.size);
	}
	applyWindowShape() {
		const window = this.window;
		if (window === void 0 || window.isDestroyed() || process.platform !== "win32" && process.platform !== "linux") return;
		const spec = PET_SIZE_SPECS[this.settings.size];
		const mascotShape = {
			x: spec.mascotX,
			y: spec.mascotY,
			width: spec.mascotSize,
			height: spec.mascotSize
		};
		window.setShape(this.bubbleShape === void 0 ? [mascotShape] : [mascotShape, this.bubbleShape]);
	}
	applyMousePolicy() {
		const window = this.window;
		if (window === void 0 || window.isDestroyed()) return;
		if (process.platform === "win32" || process.platform === "linux") {
			window.setIgnoreMouseEvents(false);
			return;
		}
		const forced = this.state.approval !== void 0 || (this.state.reply?.length ?? 0) > 0;
		window.setIgnoreMouseEvents(!(forced || this.hoverInteractive || this.dragState !== void 0), { forward: true });
	}
	scheduleSave() {
		if (this.saveTimer !== void 0) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = void 0;
			this.captureAndSave();
		}, SAVE_DELAY_MS);
		this.saveTimer.unref();
	}
	async captureAndSave() {
		const window = this.window;
		if (window !== void 0 && !window.isDestroyed()) {
			const bounds = window.getBounds();
			const display = screen.getDisplayMatching(bounds);
			this.settings = {
				...this.settings,
				x: bounds.x,
				y: bounds.y,
				displayId: display.id
			};
		}
		await this.save();
	}
	async readSettings() {
		try {
			return parseSettings(JSON.parse(await readFile(this.settingsPath, "utf8")));
		} catch {
			return {
				version: 1,
				manuallyHidden: false,
				size: DEFAULT_PET_SIZE
			};
		}
	}
	async save() {
		const value = JSON.stringify(this.settings) + "\n";
		const temporary = this.settingsPath + ".tmp";
		this.savePromise = this.savePromise.then(async () => {
			await writeFile(temporary, value, "utf8");
			await rename(temporary, this.settingsPath);
		}).catch((error) => {
			this.options.onFatal(error);
		});
		await this.savePromise;
	}
};
//#endregion
//#region src/plugin-manager.ts
const MAX_PACKAGE_NAME = 214;
const MAX_PACKAGE_SPEC = 512;
const MAX_LIST_BYTES = 1024 * 1024;
const MAX_OUTPUT_CHARS = 64 * 1024;
const MAX_ENTRIES = 1e3;
const OPERATION_TIMEOUT_MS = 15 * 6e4;
const UPDATE_CHECK_TIMEOUT_MS = 8e3;
const MAX_UPDATE_BYTES = 256 * 1024;
const VIRTUAL_STORE_MISMATCH = "ERR_PNPM_VIRTUAL_STORE_DIR_MAX_LENGTH_DIFF";
function defaultRunProcess(command, args, options) {
	const child = spawn(command, [...args], {
		cwd: options.cwd,
		env: options.env,
		shell: options.shell,
		windowsHide: options.windowsHide,
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		]
	});
	if (child.stdout === null || child.stderr === null) throw new Error("plugin process pipes are unavailable");
	return child;
}
function object(value, label) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(label + " must be an object");
	return value;
}
function exactKeys(value, keys, label) {
	const allowed = new Set(keys);
	if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(label + " has unsupported fields");
}
function boundedText(value, label, limit, allowEmpty = false) {
	if (typeof value !== "string" || value.length > limit || !allowEmpty && value.length === 0) throw new Error(label + " is invalid");
	return value;
}
function validatePackageName(value) {
	const name = boundedText(value, "packageName", MAX_PACKAGE_NAME);
	if (!(/* @__PURE__ */ new RegExp("^(?:[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?|@[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?/[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?)$")).test(name)) throw new Error("packageName is invalid");
	return name;
}
function validatePackageSpec(value) {
	const spec = boundedText(value, "spec", MAX_PACKAGE_SPEC);
	if (spec.trim() !== spec || /[\s\u0000-\u001f\u007f]/u.test(spec) || spec.startsWith("-")) throw new Error("spec is invalid");
	if (!(/* @__PURE__ */ new RegExp("^(?:[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?|@[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?/[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?)(?:@[0-9A-Za-z](?:[0-9A-Za-z._+-]*[0-9A-Za-z])?)?$")).test(spec) && !/^(?:github:|(?:git\+)?https:\/\/github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?(?:#[A-Za-z0-9._\/-]+)?$/u.test(spec)) throw new Error("spec must be an npm package or GitHub HTTPS reference");
	return spec;
}
function parseStartInput(value) {
	const input = object(value, "plugin operation");
	if (input.action === "add") {
		exactKeys(input, ["action", "spec"], "plugin operation");
		return {
			action: "add",
			spec: validatePackageSpec(input.spec)
		};
	}
	if (input.action === "update" || input.action === "remove") {
		exactKeys(input, ["action", "packageName"], "plugin operation");
		return {
			action: input.action,
			packageName: validatePackageName(input.packageName)
		};
	}
	throw new Error("plugin action is invalid");
}
function sanitizeOutput(value) {
	return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "").replace(/\r\n?/gu, "\n").replace(/[^\t\n\x20-\x7e\u0080-\uffff]/gu, "");
}
function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
function redactPaths(value, paths) {
	let result = sanitizeOutput(value);
	for (const path of paths) {
		const variants = new Set([
			path,
			path.replaceAll("\\", "/"),
			path.replaceAll("/", "\\")
		]);
		for (const variant of variants) {
			if (variant.length === 0) continue;
			result = result.replace(new RegExp(escapeRegExp(variant) + "(?:[\\\\/][^\\s\"'<>|]*)?", "giu"), "[路径已隐藏]");
		}
	}
	return result;
}
function appendOutput(previous, chunk) {
	const next = previous + sanitizeOutput(String(chunk));
	if (next.length <= MAX_OUTPUT_CHARS) return next;
	return "[较早的输出已省略]\n" + next.slice(-(MAX_OUTPUT_CHARS - 11));
}
function stringField(value, label, limit) {
	if (value === void 0) return void 0;
	return boundedText(value, label, limit);
}
function versionField(value, label) {
	const version = stringField(value, label, 256);
	return version === void 0 ? void 0 : valid(version) ?? version;
}
async function readInstalledPluginVersion(profilePath, name, readText) {
	try {
		const text = await readText(join(profilePath, "node_modules", ...name.split("/"), "package.json"));
		if (Buffer.byteLength(text, "utf8") > MAX_LIST_BYTES) return void 0;
		const manifest = object(JSON.parse(text), "installed plugin manifest");
		if (stringField(manifest.name, "installed plugin name", MAX_PACKAGE_NAME) !== name) return void 0;
		return versionField(manifest.version, "installed plugin version");
	} catch {
		return;
	}
}
async function parsePluginList(stdout, expectedProfilePath, readText) {
	if (Buffer.byteLength(stdout, "utf8") > MAX_LIST_BYTES) throw new Error("plugin list output is too large");
	const parsed = JSON.parse(stdout);
	if (!Array.isArray(parsed) || parsed.length !== 1) throw new Error("plugin list must contain one profile");
	const profile = object(parsed[0], "plugin profile");
	const profilePath = boundedText(profile.path, "plugin profile path", 32768);
	if (!isAbsolute(profilePath) || resolve(profilePath).toLowerCase() !== resolve(expectedProfilePath).toLowerCase()) throw new Error("plugin profile path is invalid");
	const listed = profile.dependencies === void 0 ? {} : object(profile.dependencies, "listed dependencies");
	const manifestText = await readText(join(profilePath, "package.json"));
	if (Buffer.byteLength(manifestText, "utf8") > MAX_LIST_BYTES) throw new Error("plugin profile manifest is too large");
	const manifest = object(JSON.parse(manifestText), "plugin profile manifest");
	const dependencies = manifest.dependencies === void 0 ? {} : object(manifest.dependencies, "plugin dependencies");
	const names = Object.keys(dependencies);
	if (names.length > MAX_ENTRIES) throw new Error("plugin dependency list is too large");
	const entries = [];
	for (const name of names) {
		validatePackageName(name);
		const dependencySpec = boundedText(dependencies[name], "plugin dependency spec", MAX_PACKAGE_SPEC);
		let spec;
		try {
			spec = validatePackageSpec(dependencySpec);
		} catch {
			spec = void 0;
		}
		const detailValue = listed[name];
		const detail = detailValue === void 0 ? void 0 : object(detailValue, "listed plugin");
		const version = (detail === void 0 ? void 0 : versionField(detail.version, "plugin version")) ?? await readInstalledPluginVersion(profilePath, name, readText);
		entries.push({
			name,
			...spec === void 0 ? {} : { spec },
			...version === void 0 ? {} : { version }
		});
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { entries };
}
function parsePluginUpdates(stdout) {
	if (stdout.trim().length === 0) return { entries: [] };
	if (Buffer.byteLength(stdout, "utf8") > MAX_LIST_BYTES) throw new Error("plugin update output is too large");
	const parsed = object(JSON.parse(stdout), "plugin update list");
	const names = Object.keys(parsed);
	if (names.length > MAX_ENTRIES) throw new Error("plugin update list is too large");
	const entries = [];
	for (const name of names) {
		validatePackageName(name);
		const detail = object(parsed[name], "plugin update");
		const currentValue = stringField(detail.current, "current plugin version", 256);
		const latestValue = stringField(detail.wanted ?? detail.latest, "latest plugin version", 256);
		if (currentValue === void 0 || latestValue === void 0) continue;
		const currentVersion = valid(currentValue);
		const latestVersion = valid(latestValue);
		if (currentVersion === null || latestVersion === null || !gt(latestVersion, currentVersion)) continue;
		entries.push({
			name,
			currentVersion,
			latestVersion
		});
	}
	entries.sort((left, right) => left.name.localeCompare(right.name));
	return { entries };
}
var PluginManager = class {
	runtimeProvider;
	home;
	environment;
	runProcess;
	readText;
	removeFile;
	onOperationFinished;
	operations = /* @__PURE__ */ new Map();
	activeOperationId;
	pendingRestartOperationId;
	disposed = false;
	constructor(options) {
		if (!isAbsolute(options.home)) throw new Error("DSH home must be absolute");
		this.runtimeProvider = options.runtime;
		this.home = options.home;
		this.environment = options.environment ?? process.env;
		this.runProcess = options.runProcess ?? defaultRunProcess;
		this.readText = options.readText ?? (async (filename) => readFile(filename, "utf8"));
		this.removeFile = options.removeFile ?? (async (filename) => rm(filename, { force: true }));
		this.onOperationFinished = options.onOperationFinished ?? (() => {});
	}
	async list() {
		this.assertAvailable();
		if (this.activeOperationId !== void 0) throw new Error("plugin operation is already running");
		const runtime = this.requireRuntime();
		try {
			const result = await this.execute(runtime, [
				"plugin",
				"--profile",
				"web",
				"list",
				"--depth",
				"0",
				"--json"
			], MAX_LIST_BYTES);
			if (result.code !== 0) throw new Error(this.processFailure("list", result));
			return await parsePluginList(result.stdout, join(this.home, "profiles", "web"), this.readText);
		} catch (error) {
			throw new Error(this.redact(error instanceof Error ? error.message : String(error)));
		}
	}
	async updates() {
		this.assertAvailable();
		if (this.activeOperationId !== void 0) return { entries: [] };
		const runtime = this.requireRuntime();
		try {
			const result = await this.execute(runtime, [
				"plugin",
				"--profile",
				"web",
				"outdated",
				"--format",
				"json",
				"--prod",
				"--compatible",
				"--silent"
			], MAX_UPDATE_BYTES, UPDATE_CHECK_TIMEOUT_MS, "plugin update check");
			if (result.code !== 0 && result.code !== 1) throw new Error("plugin update check failed");
			return parsePluginUpdates(result.stdout);
		} catch {
			throw new Error("无法检查插件更新");
		}
	}
	async start(value, prepare = async () => {}) {
		this.assertAvailable();
		if (this.activeOperationId !== void 0 || this.pendingRestartOperationId !== void 0) throw new Error("plugin operation is already running");
		const input = parseStartInput(value);
		const runtime = this.requireRuntime();
		const operationId = randomUUID();
		const argument = input.action === "add" ? input.spec : input.packageName;
		const args = [
			"plugin",
			"--profile",
			"web",
			input.action,
			argument
		];
		const record = {
			operationId,
			state: "running",
			action: input.action,
			output: ""
		};
		this.operations.set(operationId, record);
		this.activeOperationId = operationId;
		this.trimOperations();
		let settled = false;
		let repairAttempted = false;
		const finish = (state, error) => {
			if (settled) return;
			settled = true;
			if (record.timer !== void 0) clearTimeout(record.timer);
			delete record.timer;
			delete record.child;
			record.state = state;
			if (state === "succeeded") this.pendingRestartOperationId = operationId;
			if (error === void 0) delete record.error;
			else record.error = error;
			if (this.activeOperationId === operationId) this.activeOperationId = void 0;
			if (!this.disposed) try {
				this.onOperationFinished(this.status(operationId));
			} catch {}
		};
		const runAttempt = () => {
			if (settled) return;
			if (this.disposed) {
				finish("failed", "plugin manager is disposed");
				return;
			}
			try {
				const child = this.spawn(runtime, args);
				record.child = child;
				child.stdout.on("data", (chunk) => {
					record.output = appendOutput(record.output, chunk);
				});
				child.stderr.on("data", (chunk) => {
					record.output = appendOutput(record.output, chunk);
				});
				child.once("error", (error) => {
					finish("failed", "无法启动插件管理进程：" + error.message);
				});
				child.once("close", (code, signal) => {
					if (settled) return;
					delete record.child;
					if (code === 0) {
						finish("succeeded");
						return;
					}
					if (signal === null && !repairAttempted && !this.disposed && this.activeOperationId === operationId && record.output.includes(VIRTUAL_STORE_MISMATCH)) {
						repairAttempted = true;
						record.output = appendOutput(record.output, "\n检测到旧版 pnpm 元数据不兼容，正在重建后重试...\n");
						const metadata = join(this.home, "profiles", "web", "node_modules", ".modules.yaml");
						this.removeFile(metadata).then(() => {
							if (this.disposed || this.activeOperationId !== operationId) return;
							runAttempt();
						}, (error) => {
							finish("failed", "无法重建旧插件目录：" + (error instanceof Error ? error.message : String(error)));
						});
						return;
					}
					finish("failed", signal === null ? "插件操作退出码：" + String(code ?? "unknown") : "插件操作被终止：" + signal);
				});
			} catch (error) {
				finish("failed", error instanceof Error ? error.message : String(error));
			}
		};
		record.timer = setTimeout(() => {
			record.child?.kill("SIGTERM");
			finish("failed", "插件操作超时");
		}, OPERATION_TIMEOUT_MS);
		record.timer.unref();
		try {
			await prepare();
		} catch (error) {
			finish("failed", "无法准备插件变更：" + (error instanceof Error ? error.message : String(error)));
		}
		runAttempt();
		return { operationId };
	}
	status(value) {
		this.assertAvailable();
		const operationId = boundedText(value, "operationId", 128);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(operationId)) throw new Error("operationId is invalid");
		const record = this.operations.get(operationId);
		if (record === void 0) throw new Error("plugin operation was not found");
		return {
			operationId: record.operationId,
			state: record.state,
			action: record.action,
			output: this.redact(record.output),
			...record.error === void 0 ? {} : { error: this.redact(record.error) }
		};
	}
	current() {
		this.assertAvailable();
		const operationId = this.activeOperationId ?? this.pendingRestartOperationId;
		return operationId === void 0 ? void 0 : this.status(operationId);
	}
	markRestarted(value) {
		const operation = this.status(value);
		if (this.pendingRestartOperationId !== operation.operationId) throw new Error("plugin operation is not pending Runtime restart");
		this.pendingRestartOperationId = void 0;
	}
	dispose() {
		if (this.disposed) return;
		this.disposed = true;
		const active = this.activeOperationId === void 0 ? void 0 : this.operations.get(this.activeOperationId);
		if (active?.timer !== void 0) clearTimeout(active.timer);
		active?.child?.kill("SIGTERM");
		this.activeOperationId = void 0;
	}
	execute(runtime, args, limit, timeoutMs = 6e4, label = "plugin list") {
		return this.collect(this.spawn(runtime, args), limit, timeoutMs, label);
	}
	collect(child, limit, timeoutMs, label) {
		return new Promise((resolve, reject) => {
			let stdout = "";
			let stderr = "";
			let settled = false;
			const timer = setTimeout(() => {
				child.kill("SIGTERM");
				finish(/* @__PURE__ */ new Error(label + " timed out"));
			}, timeoutMs);
			timer.unref();
			const finish = (error, result) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (error !== void 0) reject(error);
				else resolve(result);
			};
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
				if (Buffer.byteLength(stdout, "utf8") > limit) {
					child.kill("SIGTERM");
					finish(/* @__PURE__ */ new Error(label + " output is too large"));
				}
			});
			child.stderr.on("data", (chunk) => {
				stderr = appendOutput(stderr, chunk);
			});
			child.once("error", (error) => {
				finish(error);
			});
			child.once("close", (code, signal) => {
				finish(void 0, {
					stdout,
					stderr,
					code,
					signal
				});
			});
		});
	}
	spawn(runtime, args) {
		return this.runProcess(runtime.nodeExecutable, [runtime.dshBin, ...args], this.processOptions(runtime, this.home));
	}
	processOptions(runtime, cwd) {
		const inheritedPath = Object.entries(this.environment).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
		const path = [
			dirname(runtime.pnpmExecutable),
			dirname(runtime.nodeExecutable),
			inheritedPath
		].filter((value) => value.length > 0).join(delimiter);
		const env = { ...this.environment };
		for (const key of Object.keys(env)) if (key.toUpperCase() === "PATH") delete env[key];
		return {
			cwd,
			env: {
				...env,
				DSH_HOME: this.home,
				PATH: path
			},
			shell: false,
			windowsHide: true
		};
	}
	processFailure(operation, result) {
		const detail = this.redact(result.stderr).trim();
		const reason = result.signal === null ? "exit code " + String(result.code ?? "unknown") : "signal " + result.signal;
		return detail.length === 0 ? "plugin " + operation + " failed with " + reason : "plugin " + operation + " failed with " + reason + ": " + detail;
	}
	redact(value) {
		const runtime = this.runtimeProvider();
		return redactPaths(value, [
			this.home,
			runtime?.directory ?? "",
			runtime?.nodeExecutable ?? "",
			runtime?.pnpmExecutable ?? "",
			runtime?.dshBin ?? ""
		]);
	}
	requireRuntime() {
		const runtime = this.runtimeProvider();
		if (runtime === void 0) throw new Error("DSH Runtime 尚未安装");
		return runtime;
	}
	assertAvailable() {
		if (this.disposed) throw new Error("plugin manager is disposed");
	}
	trimOperations() {
		while (this.operations.size > 16) {
			const oldest = this.operations.keys().next().value;
			if (oldest === void 0 || oldest === this.activeOperationId) return;
			this.operations.delete(oldest);
		}
	}
};
//#endregion
//#region src/plugin-restart.ts
async function restartRuntimeAfterPluginMutation(operationId, options) {
	if (options.status(operationId).state !== "succeeded") throw new Error("插件操作尚未成功完成");
	await options.showSetup();
	await options.retry();
	const view = options.currentView();
	if (view?.phase !== "ready") throw new Error(view?.error ?? "DSH Runtime 重启失败");
	return view;
}
var PluginRestartCoordinator = class {
	active;
	restart(operationId, options, completed) {
		if (this.active !== void 0) {
			if (this.active.operationId === operationId) return this.active.promise;
			return Promise.reject(/* @__PURE__ */ new Error("另一个插件操作正在重启 Runtime"));
		}
		const promise = restartRuntimeAfterPluginMutation(operationId, options).then((view) => {
			completed(operationId);
			return view;
		});
		this.active = {
			operationId,
			promise
		};
		const clear = () => {
			if (this.active?.promise === promise) this.active = void 0;
		};
		promise.then(clear, clear);
		return promise;
	}
};
//#endregion
//#region src/plugin-preset-recovery.ts
const PLUGIN_NAME = "dsh-multi-model-orchestrator";
const PRESET_ID = "multi-model-orchestrator";
const MARKER_NAME = ".dsh-multi-model-orchestrator.json";
const MANAGED_FILES = ["agent.cordis.yml", "preset.yml"];
const INSTALL_TIMEOUT_MS = 2 * 6e4;
const DIAGNOSTIC_PATTERN$1 = /failed to apply loader entry multi-model-orchestrator-settings \(dsh-multi-model-orchestrator\): Refusing to modify preset target ([^\r\n]{1,32768}?): (?:(?:agent\.cordis\.yml|preset\.yml) (?:does not match the packaged preset|has changed since it was managed)\.|the management marker is (?:invalid|foreign or invalid)\.) Use --force to replace it\./gu;
function canonicalPath$1(value) {
	const normalized = win32.isAbsolute(value) ? win32.resolve(value) : resolve(value);
	return process.platform === "win32" || win32.isAbsolute(value) ? normalized.toLowerCase() : normalized;
}
function sha256(value) {
	return createHash("sha256").update(value).digest("hex");
}
async function defaultRunInstaller(invocation) {
	await new Promise((resolvePromise, reject) => {
		let child;
		try {
			child = spawn(invocation.command, [...invocation.args], {
				cwd: invocation.cwd,
				env: invocation.env,
				shell: false,
				windowsHide: true,
				stdio: "ignore"
			});
		} catch (error) {
			reject(error);
			return;
		}
		let settled = false;
		const finish = (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error === void 0) resolvePromise();
			else reject(error);
		};
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(/* @__PURE__ */ new Error("插件预设重置超时"));
		}, INSTALL_TIMEOUT_MS);
		timer.unref();
		child.once("error", (error) => {
			finish(error);
		});
		child.once("close", (code, signal) => {
			if (code === 0) finish();
			else finish(/* @__PURE__ */ new Error(signal === null ? "插件预设重置退出码：" + String(code ?? "unknown") : "插件预设重置被终止：" + signal));
		});
	});
}
async function readPackageName(manifest) {
	try {
		const value = JSON.parse(await readFile(manifest, "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
		const name = value.name;
		return typeof name === "string" ? name : void 0;
	} catch {
		return;
	}
}
async function validateResetTarget(source, target) {
	const sources = /* @__PURE__ */ new Map();
	for (const name of MANAGED_FILES) {
		const sourceContent = await readFile(join(source, name));
		const targetContent = await readFile(join(target, name));
		if (!sourceContent.equals(targetContent)) throw new Error("插件预设重置结果与安装包不一致");
		sources.set(name, sourceContent);
	}
	const markerValue = JSON.parse(await readFile(join(target, MARKER_NAME), "utf8"));
	if (markerValue === null || typeof markerValue !== "object" || Array.isArray(markerValue)) throw new Error("插件预设管理标记无效");
	const marker = markerValue;
	const files = marker.files;
	if (marker.schema !== 1 || marker.managedBy !== PLUGIN_NAME || files === null || typeof files !== "object" || Array.isArray(files)) throw new Error("插件预设管理标记无效");
	for (const name of MANAGED_FILES) if (files[name] !== sha256(sources.get(name))) throw new Error("插件预设管理标记无效");
}
function diagnosticTargets(diagnostics) {
	return [...diagnostics.matchAll(DIAGNOSTIC_PATTERN$1)].map((match) => match[1]);
}
async function inspectPluginPresetRecovery(input, options = {}) {
	if (!isAbsolute(input.home) && !win32.isAbsolute(input.home)) return void 0;
	const target = join(input.home, ".agent-presets", PRESET_ID);
	const targets = diagnosticTargets(input.diagnostics);
	if (targets.length === 0 || targets.some((value) => canonicalPath$1(value) !== canonicalPath$1(target))) return void 0;
	const packageRoot = join(input.home, "profiles", "web", "node_modules", PLUGIN_NAME);
	const source = join(packageRoot, "preset");
	const installer = join(packageRoot, "src", "install.mjs");
	if (await readPackageName(join(packageRoot, "package.json")) !== PLUGIN_NAME) return void 0;
	try {
		await Promise.all([
			readFile(installer),
			...MANAGED_FILES.map(async (name) => readFile(join(source, name))),
			readFile(join(target, "agent.cordis.yml"))
		]);
	} catch {
		return;
	}
	const runInstaller = options.runInstaller ?? defaultRunInstaller;
	let applied = false;
	return {
		pluginName: PLUGIN_NAME,
		presetId: PRESET_ID,
		async apply() {
			if (applied) throw new Error("插件预设恢复计划已执行");
			const backup = target + ".desktop-backup-" + Date.now().toString(36) + "-" + randomUUID();
			await rename(target, backup);
			try {
				const env = {
					...input.environment ?? process.env,
					DSH_HOME: input.home
				};
				await runInstaller({
					command: input.runtime.nodeExecutable,
					args: [
						installer,
						"--force",
						"--target",
						target
					],
					cwd: packageRoot,
					env
				});
				await validateResetTarget(source, target);
				applied = true;
				return {
					pluginName: PLUGIN_NAME,
					presetId: PRESET_ID
				};
			} catch (error) {
				let rollbackError;
				try {
					await rm(target, {
						recursive: true,
						force: true
					});
					await rename(backup, target);
				} catch (value) {
					rollbackError = value;
				}
				if (rollbackError !== void 0) throw new AggregateError([error, rollbackError], "插件预设重置失败，且自动回滚未完整完成");
				throw error;
			}
		}
	};
}
//#endregion
//#region src/stale-local-plugin-recovery.ts
const PATCH_FILES = [join("profiles", "web", "cordis.patch.yml"), "cordis.patch.yml"];
const DIAGNOSTIC_PATTERN = /failed to import loader entry ([^()\r\n]{1,256}?) \((file:\/\/\/[^)\r\n]+)\): Cannot find module ['"]([^'"\r\n]+)['"]/gu;
const GROUP_MODULES = new Set(["cordis:group", "cordis:include"]);
const defaultFileSystem = {
	readText: async (file) => readFile(file, "utf8"),
	writeNew: async (file, content) => writeFile(file, content, {
		encoding: "utf8",
		flag: "wx"
	}),
	copyExclusive: async (source, destination) => copyFile(source, destination, constants.COPYFILE_EXCL),
	replace: async (source, destination) => rename(source, destination),
	remove: async (file) => rm(file, { force: true }),
	async exists(file) {
		try {
			await access(file);
			return true;
		} catch (error) {
			if (isFileNotFound(error)) return false;
			throw error;
		}
	}
};
function isFileNotFound(error) {
	return error instanceof Error && "code" in error && error.code === "ENOENT";
}
function canonicalPath(value) {
	const normalized = /^[A-Za-z]:[\\/]/u.test(value) ? win32.resolve(value) : resolve(value);
	return process.platform === "win32" || /^[A-Za-z]:[\\/]/u.test(value) ? normalized.toLowerCase() : normalized;
}
function absoluteLocalPath(value) {
	try {
		if (value.startsWith("file:")) {
			const url = new URL(value);
			if (url.protocol !== "file:") return void 0;
			return fileURLToPath(url);
		}
	} catch {
		return;
	}
	return isAbsolute(value) || win32.isAbsolute(value) ? value : void 0;
}
function missingReferences(diagnostics) {
	const unique = /* @__PURE__ */ new Map();
	for (const match of diagnostics.matchAll(DIAGNOSTIC_PATTERN)) {
		const id = match[1]?.trim();
		const urlPath = match[2] === void 0 ? void 0 : absoluteLocalPath(match[2]);
		const modulePath = match[3] === void 0 ? void 0 : absoluteLocalPath(match[3]);
		if (id === void 0 || id.length === 0 || /[\u0000-\u001f\u007f]/u.test(id) || urlPath === void 0 || modulePath === void 0) continue;
		const urlKey = canonicalPath(urlPath);
		const moduleKey = canonicalPath(modulePath);
		if (urlKey !== moduleKey) continue;
		const key = id + "\0" + moduleKey;
		unique.set(key, {
			id,
			path: modulePath,
			key
		});
	}
	return [...unique.values()];
}
function scalarString(map, key) {
	const value = map.get(key);
	return typeof value === "string" ? value : void 0;
}
function matchingReference(entry, references) {
	const id = scalarString(entry, "id");
	const name = scalarString(entry, "name");
	if (id === void 0 || name === void 0) return void 0;
	const localPath = absoluteLocalPath(name);
	if (localPath === void 0) return void 0;
	return references.get(id + "\0" + canonicalPath(localPath));
}
function scanLoaderEntries(sequence, references, removals, seen) {
	sequence.items.forEach((node, index) => {
		if (!isMap(node)) return;
		const match = matchingReference(node, references);
		if (match !== void 0 && !seen.has(node)) {
			seen.add(node);
			removals.push({
				sequence,
				index,
				id: match.id
			});
		}
		const name = scalarString(node, "name");
		const config = node.get("config", true);
		if (name !== void 0 && GROUP_MODULES.has(name) && isSeq(config)) scanMixedSequence(config, references, removals, seen);
	});
}
function scanMixedSequence(sequence, references, removals, seen) {
	sequence.items.forEach((node, index) => {
		if (!isMap(node)) return;
		const insert = node.get("insert", true);
		if (isSeq(insert)) {
			scanLoaderEntries(insert, references, removals, seen);
			const config = node.get("config", true);
			if (isSeq(config)) scanMixedSequence(config, references, removals, seen);
			return;
		}
		const match = matchingReference(node, references);
		if (match !== void 0 && !seen.has(node)) {
			seen.add(node);
			removals.push({
				sequence,
				index,
				id: match.id
			});
		}
		const name = scalarString(node, "name");
		const config = node.get("config", true);
		if (name !== void 0 && GROUP_MODULES.has(name) && isSeq(config)) scanMixedSequence(config, references, removals, seen);
	});
}
function scanPatchDocument(contents, references) {
	if (!isSeq(contents)) return [];
	const removals = [];
	const seen = /* @__PURE__ */ new WeakSet();
	for (const node of contents.items) {
		if (!isMap(node)) continue;
		const insert = node.get("insert", true);
		if (isSeq(insert)) scanLoaderEntries(insert, references, removals, seen);
		const config = node.get("config", true);
		if (isSeq(config)) scanMixedSequence(config, references, removals, seen);
	}
	return removals;
}
function applyRemovals(removals) {
	const grouped = /* @__PURE__ */ new Map();
	for (const removal of removals) {
		const indexes = grouped.get(removal.sequence) ?? [];
		indexes.push(removal.index);
		grouped.set(removal.sequence, indexes);
	}
	for (const [sequence, indexes] of grouped) for (const index of [...new Set(indexes)].sort((left, right) => right - left)) sequence.items.splice(index, 1);
}
async function optionalText(file, fileSystem) {
	try {
		return await fileSystem.readText(file);
	} catch (error) {
		if (isFileNotFound(error)) return void 0;
		throw error;
	}
}
function safeEntryIds(values) {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
async function rollback(changed, backups, fileSystem) {
	const failures = [];
	for (const update of [...changed].reverse()) {
		if (backups.get(update.file) === void 0) continue;
		try {
			const rollbackFile = update.file + ".rollback-source-" + randomUUID();
			await fileSystem.writeNew(rollbackFile, update.original);
			await fileSystem.replace(rollbackFile, update.file);
		} catch (error) {
			failures.push(error instanceof Error ? error : new Error(String(error)));
		}
	}
	return failures;
}
async function inspectStaleLocalPluginRecovery(input, options = {}) {
	const fileSystem = {
		...defaultFileSystem,
		...options.fileSystem
	};
	const references = missingReferences(input.diagnostics);
	if (references.length === 0) return void 0;
	const missing = await Promise.all(references.map(async (reference) => ({
		reference,
		missing: !await fileSystem.exists(reference.path)
	})));
	const missingReferencesByKey = new Map(missing.filter((value) => value.missing).map((value) => [value.reference.key, value.reference]));
	if (missingReferencesByKey.size === 0) return void 0;
	const updates = [];
	for (const relative of PATCH_FILES) {
		const file = join(input.home, relative);
		const original = await optionalText(file, fileSystem);
		if (original === void 0) continue;
		const document = parseDocument(original);
		if (document.errors.length > 0) continue;
		const removals = scanPatchDocument(document.contents, missingReferencesByKey);
		if (removals.length === 0) continue;
		applyRemovals(removals);
		updates.push({
			file,
			original,
			replacement: document.toString(),
			ids: removals.map((value) => value.id)
		});
	}
	if (updates.length === 0) return void 0;
	const entryIds = safeEntryIds(updates.flatMap((update) => update.ids));
	const count = updates.reduce((total, update) => total + update.ids.length, 0);
	let applied = false;
	return {
		entryIds,
		count,
		async apply() {
			if (applied) throw new Error("失效本地插件恢复计划已执行");
			for (const update of updates) if (await fileSystem.readText(update.file) !== update.original) throw new Error("插件配置已更改，请重新诊断");
			const backups = /* @__PURE__ */ new Map();
			const temps = [];
			const changed = [];
			try {
				for (const update of updates) {
					const backup = update.file + ".desktop-backup-" + Date.now().toString(36) + "-" + randomUUID();
					await fileSystem.copyExclusive(update.file, backup);
					if (await fileSystem.readText(backup) !== update.original) throw new Error("插件配置已更改，请重新诊断");
					backups.set(update.file, backup);
				}
				for (const update of updates) {
					const temp = join(dirname(update.file), "." + randomUUID() + ".desktop-recovery.tmp");
					temps.push(temp);
					await fileSystem.writeNew(temp, update.replacement);
					await fileSystem.replace(temp, update.file);
					changed.push(update);
				}
				applied = true;
				return {
					removedEntryIds: entryIds,
					count
				};
			} catch (error) {
				const rollbackFailures = await rollback(changed, backups, fileSystem);
				if (rollbackFailures.length > 0) throw new AggregateError([error, ...rollbackFailures], "插件配置恢复失败，且自动回滚未完整完成");
				throw error;
			} finally {
				await Promise.allSettled(temps.map(async (temp) => {
					await fileSystem.remove(temp);
				}));
			}
		}
	};
}
//#endregion
//#region src/runtime-controller.ts
var RuntimeController = class {
	shellVersion;
	store;
	shutdownHook;
	userData;
	catalogUrl;
	environment;
	inspectStaleLocalPlugins;
	inspectPluginPreset;
	onView;
	onReady;
	onOpenSettingsDocument;
	catalog;
	state = {
		schemaVersion: 1,
		preference: { mode: "latest-compatible" }
	};
	backend;
	selectedRuntime;
	recoveryPlan;
	expectedStop = false;
	currentRuntimeRevision;
	installedVersions = /* @__PURE__ */ new Set();
	phase = "checking";
	message = "正在检查可用的 DSH 版本";
	error;
	progress;
	cachedCatalog = false;
	pending = Promise.resolve();
	constructor(options) {
		this.shellVersion = options.shellVersion;
		this.store = options.store;
		this.shutdownHook = options.shutdownHook;
		this.userData = options.userData;
		this.catalogUrl = options.catalogUrl ?? "https://github.com/ToxicantX/deepseek-harness-desktop/releases/download/runtime-catalog/runtime-catalog.json";
		this.environment = options.environment ?? process.env;
		this.inspectStaleLocalPlugins = options.inspectStaleLocalPlugins ?? inspectStaleLocalPluginRecovery;
		this.inspectPluginPreset = options.inspectPluginPreset ?? inspectPluginPresetRecovery;
		this.onView = options.onView;
		this.onReady = options.onReady;
		this.onOpenSettingsDocument = options.onOpenSettingsDocument;
	}
	start() {
		return this.enqueue(async () => {
			await this.boot();
		});
	}
	retry() {
		return this.enqueue(async () => {
			await this.boot();
		});
	}
	recoverStaleLocalPlugins() {
		return this.enqueue(async () => {
			const recovery = this.recoveryPlan;
			if (recovery?.kind !== "stale-local-plugins") throw new Error("没有可恢复的失效本地插件");
			await recovery.plan.apply();
			this.recoveryPlan = void 0;
			await this.boot();
		});
	}
	recoverPluginPreset() {
		return this.enqueue(async () => {
			const recovery = this.recoveryPlan;
			if (recovery?.kind !== "plugin-preset-conflict") throw new Error("没有可恢复的冲突插件预设");
			await recovery.plan.apply();
			this.recoveryPlan = void 0;
			await this.boot();
		});
	}
	pauseForPluginMutation() {
		return this.enqueue(async () => {
			await this.stopBackend();
			this.update("starting", "正在应用插件变更");
		});
	}
	setPreference(preference) {
		return this.enqueue(async () => {
			this.state = await this.store.setPreference(preference);
			await this.stopBackend();
			await this.boot();
		});
	}
	stop() {
		return this.enqueue(async () => {
			await this.stopBackend();
		});
	}
	installedRuntime() {
		return this.selectedRuntime;
	}
	snapshot() {
		const versions = this.catalog === void 0 ? [] : compatibleReleases(this.catalog, this.shellVersion).map((release) => ({
			version: release.dshVersion,
			runtimeRevision: release.runtimeRevision,
			requiredShellRange: release.requiredShellRange,
			sourceTag: release.source.tag,
			installed: this.installedVersions.has(release.dshVersion),
			current: this.state.currentVersion === release.dshVersion
		}));
		return {
			phase: this.phase,
			message: this.message,
			shellVersion: this.shellVersion,
			minimumDshVersion: MINIMUM_DSH_VERSION,
			...this.state.currentVersion === void 0 ? {} : { currentVersion: this.state.currentVersion },
			...this.currentRuntimeRevision === void 0 ? {} : { currentRuntimeRevision: this.currentRuntimeRevision },
			preference: this.state.preference,
			versions,
			cachedCatalog: this.cachedCatalog,
			...this.progress === void 0 ? {} : { progress: this.progress },
			...this.phase !== "error" || this.recoveryPlan === void 0 ? {} : { recovery: this.recoveryPlan.kind === "stale-local-plugins" ? {
				kind: "stale-local-plugins",
				entryIds: [...this.recoveryPlan.plan.entryIds],
				count: this.recoveryPlan.plan.count
			} : {
				kind: "plugin-preset-conflict",
				pluginName: this.recoveryPlan.plan.pluginName,
				presetId: this.recoveryPlan.plan.presetId
			} },
			...this.error === void 0 ? {} : { error: this.error }
		};
	}
	enqueue(operation) {
		const next = this.pending.catch(() => {}).then(operation);
		this.pending = next;
		return next;
	}
	async boot() {
		this.recoveryPlan = void 0;
		this.update("checking", "正在检查可用的 DSH 版本");
		this.state = await this.store.readState();
		let target;
		let selectedVersion;
		try {
			const loaded = await this.store.loadCatalog(this.catalogUrl);
			this.catalog = loaded.catalog;
			this.cachedCatalog = loaded.cached;
			await this.refreshInstalledVersions();
			const selected = selectRuntime(loaded.catalog, this.shellVersion, this.state.preference);
			selectedVersion = selected.dshVersion;
			target = await this.store.installed(selected.dshVersion);
			if (target === void 0 || target.manifest.runtimeRevision !== selected.runtimeRevision || target.manifest.archive.sha256 !== selected.archive.sha256) {
				const previous = target;
				await this.stopBackend();
				this.update("downloading", `正在下载 DSH ${selected.dshVersion}`);
				try {
					target = await this.store.install(selected, (progress) => {
						this.progress = progress;
						this.emit();
					});
					this.installedVersions.add(selected.dshVersion);
				} catch (error) {
					if (previous !== void 0 && isReleaseCompatible(previous.manifest, this.shellVersion)) {
						const message = `DSH ${selected.dshVersion} 更新未完成，继续使用 DSH ${previous.manifest.dshVersion}`;
						await this.launch(previous, message);
						return;
					}
					throw error;
				}
			}
			await this.launch(target);
			return;
		} catch (error) {
			const primaryError = error instanceof Error ? error.message : String(error);
			const fallback = await this.fallbackRuntime(selectedVersion);
			if (fallback !== void 0) try {
				await this.launch(fallback, `DSH 更新未完成，继续使用 ${fallback.manifest.dshVersion}`);
				return;
			} catch (fallbackError) {
				const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
				this.fail(`${primaryError}\n\n回退版本启动失败：${detail}`);
				return;
			}
			this.fail(primaryError);
		}
	}
	async fallbackRuntime(excludedVersion) {
		const current = this.state.currentVersion;
		if (current === void 0 || current === excludedVersion) return void 0;
		const installed = await this.store.installed(current);
		if (installed === void 0 || !isReleaseCompatible(installed.manifest, this.shellVersion)) return void 0;
		return installed;
	}
	async launch(runtime, message = `正在启动 DSH ${runtime.manifest.dshVersion}`) {
		await this.stopBackend();
		this.selectedRuntime = runtime;
		this.update("starting", message);
		const home = this.environment.DSH_HOME ?? join(homedir(), ".dsh");
		await mkdir(home, { recursive: true });
		let backend;
		try {
			backend = await startBackend({
				runtime,
				shutdownHook: this.shutdownHook,
				cwd: home,
				env: desktopEnvironment(runtime, this.environment),
				onOpenSettingsDocument: this.onOpenSettingsDocument
			});
		} catch (error) {
			const diagnostics = error instanceof Error ? error.message : String(error);
			await this.detectRecovery(home, runtime, diagnostics);
			throw error;
		}
		this.recoveryPlan = void 0;
		this.backend = backend;
		this.expectedStop = false;
		this.state = await this.store.promote(runtime.manifest.dshVersion);
		this.currentRuntimeRevision = runtime.manifest.runtimeRevision;
		const cliDirectory = await prepareCliShim(runtime, this.userData);
		this.update("ready", `DSH ${runtime.manifest.dshVersion} 已启动`);
		await this.onReady(backend.url, runtime, cliDirectory);
		backend.done.then((exit) => {
			if (this.backend !== backend || this.expectedStop) return;
			this.backend = void 0;
			const reason = exit.error?.message ?? `退出码 ${exit.exitCode ?? "unknown"}`;
			this.fail(exit.diagnostics.length === 0 ? `DSH runtime 意外退出：${reason}` : `DSH runtime 意外退出：${reason}\n\n${exit.diagnostics}`);
		});
	}
	async detectRecovery(home, runtime, diagnostics) {
		try {
			const plan = await this.inspectStaleLocalPlugins({
				home,
				diagnostics
			});
			if (plan !== void 0) {
				this.recoveryPlan = {
					kind: "stale-local-plugins",
					plan
				};
				return;
			}
		} catch {}
		try {
			const plan = await this.inspectPluginPreset({
				home,
				runtime,
				diagnostics,
				environment: this.environment
			});
			if (plan !== void 0) this.recoveryPlan = {
				kind: "plugin-preset-conflict",
				plan
			};
		} catch {}
	}
	async stopBackend() {
		const backend = this.backend;
		if (backend === void 0) return;
		this.expectedStop = true;
		this.backend = void 0;
		await backend.stop();
	}
	async refreshInstalledVersions() {
		this.installedVersions = /* @__PURE__ */ new Set();
		if (this.catalog === void 0) return;
		await Promise.all(this.catalog.releases.map(async (release) => {
			if (await this.store.installed(release.dshVersion) !== void 0) this.installedVersions.add(release.dshVersion);
		}));
	}
	update(phase, message) {
		this.phase = phase;
		this.message = message;
		this.error = void 0;
		this.progress = void 0;
		this.emit();
	}
	fail(message) {
		this.phase = "error";
		this.message = "无法启动 DSH";
		this.error = message;
		this.progress = void 0;
		this.emit();
	}
	emit() {
		this.onView(this.snapshot());
	}
};
//#endregion
//#region src/session-repair.ts
const MAX_SESSION_ID_LENGTH = 256;
const MAX_REVISION_LENGTH = 512;
function isRecord$1(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requiredString(value, name, maximum = 32768) {
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) throw new Error("Malformed session repair response: " + name + " must be a nonempty bounded string");
	return value;
}
function nonnegativeInteger(value, name) {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Malformed session repair response: " + name + " must be a nonnegative integer");
	return value;
}
function validateSessionId(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_SESSION_ID_LENGTH || value.trim() !== value || /[\\/\u0000-\u001f]/u.test(value)) throw new TypeError("sessionId must be a nonempty bounded identifier, not a file path");
	return value;
}
function validateRevision(value) {
	if (typeof value !== "string" || value.length === 0 || value.length > MAX_REVISION_LENGTH || value.trim() !== value || /[\u0000-\u001f]/u.test(value)) throw new TypeError("expectedRevision must be a nonempty bounded string");
	return value;
}
function parseAnomaly(value) {
	if (!isRecord$1(value) || value.kind !== "branch-reset" && value.kind !== "stale-single-event" && value.kind !== "ambiguous") throw new Error("Malformed session repair response: invalid anomaly");
	return {
		eventIndex: nonnegativeInteger(value.eventIndex, "anomaly.eventIndex"),
		expectedSeq: nonnegativeInteger(value.expectedSeq, "anomaly.expectedSeq"),
		actualSeq: nonnegativeInteger(value.actualSeq, "anomaly.actualSeq"),
		runLength: nonnegativeInteger(value.runLength, "anomaly.runLength"),
		kind: value.kind
	};
}
function parseInspection(value) {
	if (!isRecord$1(value) || typeof value.repairable !== "boolean" || !Array.isArray(value.anomalies)) throw new Error("Malformed session repair response: invalid inspection");
	const anomalies = value.anomalies.map(parseAnomaly);
	let strategy;
	if (value.strategy !== void 0) {
		if (value.strategy !== "renumber-preserve-physical-order") throw new Error("Malformed session repair response: invalid repair strategy");
		strategy = value.strategy;
	}
	let preservesAllEvents;
	if (value.preservesAllEvents !== void 0) {
		if (typeof value.preservesAllEvents !== "boolean") throw new Error("Malformed session repair response: preservesAllEvents must be a boolean");
		preservesAllEvents = value.preservesAllEvents;
	}
	if (value.repairable && (anomalies.length === 0 || anomalies.some((anomaly) => anomaly.kind === "ambiguous") || value.eventCount === void 0 || value.fileSize === void 0 || typeof value.backupPath !== "string" || preservesAllEvents !== true || strategy !== "renumber-preserve-physical-order")) throw new Error("Malformed session repair response: unsafe repairability claim");
	return {
		sessionId: requiredString(value.sessionId, "sessionId", MAX_SESSION_ID_LENGTH),
		revision: requiredString(value.revision, "revision", MAX_REVISION_LENGTH),
		repairable: value.repairable,
		anomalies,
		...value.eventCount === void 0 ? {} : { eventCount: nonnegativeInteger(value.eventCount, "eventCount") },
		...value.fileSize === void 0 ? {} : { fileSize: nonnegativeInteger(value.fileSize, "fileSize") },
		...value.backupPath === void 0 ? {} : { backupPath: requiredString(value.backupPath, "backupPath") },
		...preservesAllEvents === void 0 ? {} : { preservesAllEvents },
		...strategy === void 0 ? {} : { strategy },
		...value.reason === void 0 ? {} : { reason: requiredString(value.reason, "reason") }
	};
}
function parseResult(value) {
	if (!isRecord$1(value)) throw new Error("Malformed session repair response: invalid repair result");
	return {
		sessionId: requiredString(value.sessionId, "sessionId", MAX_SESSION_ID_LENGTH),
		previousRevision: requiredString(value.previousRevision, "previousRevision", MAX_REVISION_LENGTH),
		newRevision: requiredString(value.newRevision, "newRevision", MAX_REVISION_LENGTH),
		backupPath: requiredString(value.backupPath, "backupPath"),
		eventCount: nonnegativeInteger(value.eventCount, "eventCount"),
		lastSeq: nonnegativeInteger(value.lastSeq, "lastSeq"),
		derivedMessageCount: nonnegativeInteger(value.derivedMessageCount, "derivedMessageCount")
	};
}
function parseRollbackResult(value) {
	if (!isRecord$1(value)) throw new Error("Malformed session repair response: invalid rollback result");
	return {
		sessionId: requiredString(value.sessionId, "sessionId", MAX_SESSION_ID_LENGTH),
		previousRevision: requiredString(value.previousRevision, "previousRevision", MAX_REVISION_LENGTH),
		newRevision: requiredString(value.newRevision, "newRevision", MAX_REVISION_LENGTH),
		backupPath: requiredString(value.backupPath, "backupPath")
	};
}
var SessionRepairClient = class {
	baseUrl;
	fetcher;
	constructor(baseUrl, fetcher = globalThis.fetch) {
		if (baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1" || baseUrl.username !== "" || baseUrl.password !== "") throw new TypeError("session repair API must use the trusted loopback runtime origin");
		this.baseUrl = new URL(baseUrl.origin);
		this.fetcher = fetcher;
	}
	async inspect(sessionIdValue) {
		const sessionId = validateSessionId(sessionIdValue);
		const result = await this.call("session.repair.inspect", { sessionId }, parseInspection);
		this.assertSession(result.sessionId, sessionId);
		return result;
	}
	async apply(sessionIdValue, revisionValue) {
		const sessionId = validateSessionId(sessionIdValue);
		const expectedRevision = validateRevision(revisionValue);
		const result = await this.call("session.repair.apply", {
			sessionId,
			expectedRevision
		}, parseResult);
		this.assertSession(result.sessionId, sessionId);
		return result;
	}
	async rollback(sessionIdValue, revisionValue) {
		const sessionId = validateSessionId(sessionIdValue);
		const expectedRevision = validateRevision(revisionValue);
		const result = await this.call("session.repair.rollback", {
			sessionId,
			expectedRevision
		}, parseRollbackResult);
		this.assertSession(result.sessionId, sessionId);
		return result;
	}
	assertSession(actual, expected) {
		if (actual !== expected) throw new Error("Malformed session repair response: sessionId mismatch");
	}
	async call(method, payload, parse) {
		const rpcId = randomUUID();
		let response;
		try {
			response = await this.fetcher(new URL("/api/" + method, this.baseUrl), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					type: "client-request",
					rpcId,
					method,
					payload
				})
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw new Error("Session repair runtime request failed: " + detail, { cause: error });
		}
		if (response.status === 404) throw new Error("当前 DSH Runtime 不支持历史会话修复，请升级 Runtime 后重试");
		if (!response.ok) throw new Error("Session repair runtime request failed with HTTP " + response.status);
		let body;
		try {
			body = await response.json();
		} catch (error) {
			throw new Error("Malformed session repair response: invalid JSON", { cause: error });
		}
		if (!isRecord$1(body) || body.type !== "server-response" || body.rpcId !== rpcId || !isRecord$1(body.result)) throw new Error("Malformed session repair response: invalid RPC envelope");
		if (body.result.ok === false) {
			const error = isRecord$1(body.result.error) ? body.result.error : {};
			const message = typeof error.message === "string" ? error.message : typeof error.code === "string" ? error.code : "unknown RPC error";
			throw new Error("Session repair failed: " + message);
		}
		if (body.result.ok !== true || !Object.hasOwn(body.result, "value")) throw new Error("Malformed session repair response: invalid RPC result");
		return parse(body.result.value);
	}
};
//#endregion
//#region src/settings-document.ts
function isRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
var SettingsDocumentClient = class {
	constructor(baseUrl, fetcher = fetch) {
		this.baseUrl = baseUrl;
		this.fetcher = fetcher;
		if (baseUrl.protocol !== "http:" || baseUrl.hostname !== "127.0.0.1" || baseUrl.pathname !== "/" || baseUrl.search !== "" || baseUrl.hash !== "") throw new TypeError("settings document client requires a trusted loopback DSH origin");
	}
	async open() {
		const rpcId = randomUUID();
		const method = "settings.openDocument";
		const response = await this.fetcher(new URL("/api/" + method, this.baseUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				type: "client-request",
				rpcId,
				method,
				payload: {}
			})
		});
		if (!response.ok) throw new Error("DSH settings request returned HTTP " + String(response.status));
		let body;
		try {
			body = await response.json();
		} catch (error) {
			throw new Error("DSH settings response is not valid JSON", { cause: error });
		}
		if (!isRecord(body) || body.type !== "server-response" || body.rpcId !== rpcId || !isRecord(body.result)) throw new Error("DSH settings response has an invalid RPC envelope");
		if (body.result.ok === false) {
			const failure = isRecord(body.result.error) ? body.result.error : {};
			throw new Error(typeof failure.message === "string" ? failure.message : "DSH refused to open its settings document");
		}
		if (body.result.ok !== true || !isRecord(body.result.value) || body.result.value.opened !== true) throw new Error("DSH settings response did not confirm the document was opened");
	}
};
//#endregion
//#region src/shell-updater.ts
const { autoUpdater } = updaterPackage;
var ShellUpdater = class {
	pending;
	constructor(window, stopRuntime, onProgress = () => {}) {
		this.window = window;
		this.stopRuntime = stopRuntime;
		this.onProgress = onProgress;
		autoUpdater.logger = null;
		autoUpdater.autoDownload = false;
		autoUpdater.autoInstallOnAppQuit = false;
		autoUpdater.allowPrerelease = app.getVersion().includes("-");
	}
	check(manual) {
		if (this.pending !== void 0) return this.pending;
		this.pending = this.run(manual).finally(() => {
			this.pending = void 0;
		});
		return this.pending;
	}
	withUpdaterErrors(operation) {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (callback) => {
				if (settled) return;
				settled = true;
				autoUpdater.off("error", onError);
				callback();
			};
			const onError = (error) => {
				finish(() => {
					reject(error);
				});
			};
			autoUpdater.once("error", onError);
			operation().then((value) => {
				finish(() => {
					resolve(value);
				});
			}, (error) => {
				finish(() => {
					reject(error instanceof Error ? error : new Error(String(error)));
				});
			});
		});
	}
	async run(manual) {
		if (!app.isPackaged) {
			this.onProgress({ state: "idle" });
			if (manual) await this.info("开发版本不执行 Shell 更新检查。", "Shell " + app.getVersion());
			return;
		}
		this.onProgress({ state: "checking" });
		let result;
		try {
			result = await this.withUpdaterErrors(() => autoUpdater.checkForUpdates());
		} catch (error) {
			this.onProgress({
				state: "error",
				message: error instanceof Error ? error.message : String(error)
			});
			if (manual) await this.failure(error);
			this.onProgress({ state: "idle" });
			return;
		}
		if (result === null || result.updateInfo.version === app.getVersion()) {
			this.onProgress({ state: "idle" });
			if (manual) await this.info("当前 Shell 已是最新版本。", "Shell " + app.getVersion());
			return;
		}
		const version = result.updateInfo.version;
		if ((await dialog.showMessageBox(this.window, {
			type: "info",
			title: "Shell 更新",
			message: "DeepSeek Harness Shell " + version + " 已发布。",
			detail: "DSH Runtime、插件、会话和配置不会被覆盖。下载完成后将自动安装并重启。",
			buttons: ["下载安装并重启", "稍后"],
			defaultId: 0,
			cancelId: 1
		})).response !== 0) {
			this.onProgress({ state: "idle" });
			return;
		}
		const onDownloadProgress = (progress) => {
			this.onProgress({
				state: "downloading",
				version,
				...progress
			});
		};
		autoUpdater.on("download-progress", onDownloadProgress);
		this.onProgress({
			state: "downloading",
			version,
			percent: 0,
			transferred: 0,
			total: 0,
			bytesPerSecond: 0
		});
		try {
			await this.withUpdaterErrors(() => autoUpdater.downloadUpdate());
			this.onProgress({
				state: "preparing-restart",
				version
			});
			await this.stopRuntime();
			autoUpdater.quitAndInstall(true, true);
		} catch (error) {
			this.onProgress({
				state: "error",
				message: error instanceof Error ? error.message : String(error)
			});
			await this.failure(error);
			this.onProgress({ state: "idle" });
		} finally {
			autoUpdater.off("download-progress", onDownloadProgress);
		}
	}
	async info(message, detail) {
		await dialog.showMessageBox(this.window, {
			type: "info",
			title: "Shell 更新",
			message,
			detail
		});
	}
	async failure(error) {
		await dialog.showMessageBox(this.window, {
			type: "error",
			title: "Shell 更新失败",
			message: "无法检查、下载或安装 Shell 更新。",
			detail: error instanceof Error ? error.message : String(error)
		});
	}
};
//#endregion
//#region src/file-context-injector.ts
function createFileContextInjectorScript() {
	return String.raw`(() => {
  'use strict';
  const key = '__dshDesktopFileContext';
  const previous = window[key];
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  const MAX_BYTES = 8 * 1024 * 1024;
  const MAX_INLINE_CHARS = 500;
  const BINARY_EXTENSIONS = /\.(?:7z|avi|bin|bmp|class|db|dll|dmg|doc|docx|eot|exe|gif|ico|iso|jar|jpeg|jpg|lib|m4a|mov|mp3|mp4|msi|otf|pdf|png|ppt|pptx|rar|so|sqlite|sys|tar|tif|tiff|ttf|wav|webm|webp|woff|woff2|xls|xlsx|zip)$/i;
  const disposers = [];
  const clips = new Map();
  let clipSequence = 0;
  let busy = false;
  const findEditor = () => [...document.querySelectorAll('textarea,[contenteditable="true"]')].find(node => node instanceof HTMLElement && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0) || null;
  const readValue = node => node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement ? node.value : node.innerText;
  const writeValue = (node, value) => {
    if (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) {
      const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(node), 'value');
      if (descriptor && descriptor.set) descriptor.set.call(node, value); else node.value = value;
    } else node.innerText = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
  };
  const appendText = text => {
    const editor = findEditor();
    if (!editor) throw new Error('未找到 DSH 对话输入框');
    const current = readValue(editor);
    const length = Array.from(text).length;
    if (length <= MAX_INLINE_CHARS) { writeValue(editor, current + text); return; }
    const id = 'clip-' + (++clipSequence);
    const preview = text.replace(/\s+/g, ' ').trim().slice(0, 80);
    const token = '【已折叠粘贴文本 · ' + length + ' 字符 · ' + id + '】' + (preview ? ' ' + preview + (length > 80 ? '…' : '') : '');
    clips.set(token, text);
    writeValue(editor, current + token);
  };
  const appendContext = (name, text) => {
    const editor = findEditor();
    if (!editor) throw new Error('未找到 DSH 对话输入框');
    const marker = '--- 用户粘贴文件：' + name + ' ---';
    const current = readValue(editor);
    if (current.includes(marker)) return;
    const prefix = '\n\n' + marker + '\n';
    const suffix = '\n--- 用户粘贴文件结束 ---';
    const length = Array.from(text).length;
    if (length <= MAX_INLINE_CHARS) {
      writeValue(editor, current + prefix + text + suffix);
      return;
    }
    const id = 'clip-' + (++clipSequence);
    const token = '【已折叠粘贴文件 · ' + name + ' · ' + length + ' 字符 · ' + id + '】';
    clips.set(token, text);
    writeValue(editor, current + prefix + token + suffix);
  };
  const expandClips = () => {
    const editor = findEditor();
    if (!editor || clips.size === 0) return;
    let value = readValue(editor);
    let changed = false;
    for (const [token, text] of clips) {
      if (value.includes(token)) { value = value.split(token).join(text); changed = true; }
    }
    if (changed) writeValue(editor, value);
  };
  const readTextFile = async file => {
    if (file.size > MAX_BYTES) throw new Error('粘贴文件超过 8 MB 限制');
    const text = await file.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BYTES) throw new Error('文件 UTF-8 内容超过 8 MB 限制');
    if (text.slice(0, 8192).includes('\0')) return null;
    return text;
  };
  const handleFile = async file => {
    const name = file.name || 'clipboard-file';
    if (file.type.startsWith('image/') || BINARY_EXTENSIONS.test(name)) return;
    if (/^(?:audio|video|font)\//i.test(file.type) || /^(?:application\/(?:pdf|zip|gzip|x-7z-compressed|x-rar-compressed|java-archive|msdownload)|binary\/)/i.test(file.type)) return;
    const text = await readTextFile(file);
    if (text !== null) appendContext(name, text);
  };
  const onPaste = event => {
    const items = event.clipboardData && event.clipboardData.items;
    if (!items || busy) return;
    const files = [];
    for (const item of items) if (item.kind === 'file') { const file = item.getAsFile(); if (file) files.push(file); }
    if (files.length === 0) {
      const text = event.clipboardData.getData('text/plain') || '';
      if (Array.from(text).length <= MAX_INLINE_CHARS) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      appendText(text);
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    busy = true;
    Promise.all(files.map(handleFile)).catch(error => console.error('[dsh file context]', error)).finally(() => { busy = false; });
  };
  const onSubmit = event => { if (event.type === 'keydown' && (event.key !== 'Enter' || event.shiftKey || event.isComposing)) return; expandClips(); };
  window.addEventListener('paste', onPaste, true);
  document.addEventListener('paste', onPaste, true);
  document.addEventListener('keydown', onSubmit, true);
  document.addEventListener('submit', onSubmit, true);
  disposers.push(() => window.removeEventListener('paste', onPaste, true), () => document.removeEventListener('paste', onPaste, true), () => document.removeEventListener('keydown', onSubmit, true), () => document.removeEventListener('submit', onSubmit, true));
  window[key] = { dispose() { for (const dispose of disposers.splice(0)) dispose(); clips.clear(); delete window[key]; } };
  return { ok: true };
  })();`;
}
//#endregion
//#region src/skin-market-injector.ts
function createClientBundleAdapterScript(bundle, skinId, requestedVariant) {
	if (!/window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(\s*\{/.test(bundle.replace(/^\uFEFF/, ""))) throw new Error("unsupported skin client bundle: missing ModuleLoader wrapper for " + skinId);
	const id = JSON.stringify(skinId);
	const profile = {
		"caoyiwei850.dsh-client-ui-skins": {
			storageKey: "dsh-skins.active",
			defaultValue: "skin-mint-clean",
			variants: [
				"skin-ocean-deep",
				"skin-sakura-pink",
				"skin-mint-clean",
				"skin-amber-glow"
			]
		},
		"zhijun-dai.catppuccin": {
			storageKey: "dsh-catppuccin:skin",
			defaultValue: "catppuccin-mocha",
			variants: [
				"catppuccin-latte",
				"catppuccin-frappe",
				"catppuccin-macchiato",
				"catppuccin-mocha"
			]
		},
		"jungeer.dsh-theme-stardew": {
			storageKey: "dsh.ui-stardew.enabled",
			defaultValue: "on"
		}
	}[skinId];
	if (requestedVariant !== void 0 && !/^[a-z0-9][a-z0-9._-]{1,120}$/i.test(requestedVariant)) throw new Error("invalid skin variant for " + skinId);
	if (requestedVariant !== void 0 && profile?.variants !== void 0 && !profile.variants.includes(requestedVariant)) throw new Error("unsupported skin variant for " + skinId + ": " + requestedVariant);
	const requestedTheme = JSON.stringify(requestedVariant ?? null);
	const shellThemeStorageKey = JSON.stringify("dsh-desktop.skin-variant." + skinId);
	const activationDefault = JSON.stringify(profile === void 0 ? null : [profile.storageKey, requestedVariant ?? profile.defaultValue]);
	const forceActivationDefault = requestedVariant !== void 0;
	const protocolBase = "dsh-skin://" + skinId;
	const assetPathPattern = /(["'])\/(?!\/)([a-z0-9._-]+\/(?:[^"']*?\.(?:png|jpe?g|webp|gif|svg|avif|woff2?|ttf)))(["'])/gi;
	const visualAssetUrls = [];
	const rewrittenAssets = bundle.replace(assetPathPattern, (_match, quote, path) => {
		const url = protocolBase + "/" + path;
		if (/\.(?:png|jpe?g|webp|gif|svg|avif)$/i.test(path)) visualAssetUrls.push(url);
		return quote + url + quote;
	});
	return `(async () => {
  'use strict';
  try {
  const registryKey = '__dshDesktopSkinRuntime';
  const activationDefault = ${activationDefault};
  const requestedTheme = ${requestedTheme};
  const shellThemeStorageKey = ${shellThemeStorageKey};
  const forceActivationDefault = ${forceActivationDefault};
  if (activationDefault) { const saved = localStorage.getItem(activationDefault[0]); if (forceActivationDefault || saved === null || saved === 'system' || saved === 'off') localStorage.setItem(activationDefault[0], activationDefault[1]); }
  const backgroundAssetUrl = ${JSON.stringify(visualAssetUrls.find((url) => /(?:wallpaper|background|(?:^|[-_/])bg(?:[-_.\/]|$))/i.test(url)) ?? visualAssetUrls[0] ?? null)};
  const supportsCustomBackground = true;
  const customBackgroundStorageKey = ${JSON.stringify("dsh-desktop.skin-background.global")};
  const legacyCustomBackgroundStorageKey = ${JSON.stringify("dsh-desktop.skin-background." + skinId)};
  if (localStorage.getItem(customBackgroundStorageKey) === null) { const legacyBackground = localStorage.getItem(legacyCustomBackgroundStorageKey); if (legacyBackground !== null) localStorage.setItem(customBackgroundStorageKey, legacyBackground); }
  const previous = window[registryKey];
  if (previous && typeof previous.dispose === 'function') previous.dispose();
  const beforeAttrs = new Map([...document.documentElement.attributes].map(attribute => [attribute.name, attribute.value])); const beforeBodyAttrs = new Map(document.body ? [...document.body.attributes].map(attribute => [attribute.name, attribute.value]) : []); const beforeStyles = new Set([...document.querySelectorAll('style,link[rel="stylesheet"]')]);
  const beforeMetrics = { styles: document.querySelectorAll('style').length, bodyStyle: document.body ? document.body.style.length : 0, rootStyle: document.documentElement.style.length };
  const disposers = [];
  let backgroundFix;
  const applyShellBackground = url => { if (backgroundFix) { backgroundFix.remove(); backgroundFix = undefined; } if (!url) return; backgroundFix = document.createElement('style'); backgroundFix.setAttribute('data-dsh-skin-background-fix', ${id}); backgroundFix.textContent = 'html{background-color:#0b0f26!important}html,body{--dsw-alias-bg-base:rgba(9,13,32,.34)!important;--dsw-alias-bg-layer-1:rgba(17,24,52,.52)!important;--dsw-alias-bg-layer-2:rgba(24,32,66,.60)!important;--dsw-specific-sidebar-fill:rgba(11,16,40,.44)!important}body{background-color:transparent!important;background-image:url("' + url + '")!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;background-attachment:fixed!important}body::before{z-index:-1!important}'; document.head.append(backgroundFix); };
  let customBackgroundUrl = localStorage.getItem(customBackgroundStorageKey);
  if (customBackgroundUrl && !/^data:image\\/(?:png|jpeg|webp|gif);base64,/i.test(customBackgroundUrl)) { localStorage.removeItem(customBackgroundStorageKey); customBackgroundUrl = null; }
  applyShellBackground(customBackgroundUrl || backgroundAssetUrl);
  disposers.push(() => { if (backgroundFix) backgroundFix.remove(); });
  let exported;
  const originalLoader = window.__ModuleLoader__;
  const dshModules = window.__DSH_MODULES__;
  const loadReal = async (name, fallback) => { try { const value = dshModules && typeof dshModules.import === 'function' ? await dshModules.import(name) : undefined; return value || fallback; } catch { return fallback; } };
  const noop = () => {};
  const vnode = (type, props, key) => ({ type, key, props: props || {} });
  const fallbackReact = { createElement: (type, props, ...children) => vnode(type, { ...(props || {}), children: children.length <= 1 ? children[0] : children }), Fragment: Symbol.for('react.fragment'), useState: initial => { let value = typeof initial === 'function' ? initial() : initial; return [value, next => { value = typeof next === 'function' ? next(value) : next; }]; }, useEffect: effect => { const dispose = effect(); if (typeof dispose === 'function') disposers.push(dispose); }, useMemo: factory => factory(), useCallback: value => value, useRef: value => ({ current: value }), useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(), memo: value => value, forwardRef: render => render, useLayoutEffect: effect => { const dispose=effect(); if(typeof dispose==='function')disposers.push(dispose); }, useId: () => 'dsh-skin-' + Math.random().toString(36).slice(2) };
  const shellReact = window.__dshDesktopReactRuntime || {};
  const react = await loadReal('react', shellReact.React || fallbackReact);
  const jsxRuntime = await loadReal('react/jsx-runtime', shellReact.jsxRuntime || { jsx: vnode, jsxs: vnode, Fragment: react.Fragment });
  const reactDom = await loadReal('react-dom', shellReact.ReactDOM || {});
  const reactDomClient = await loadReal('react-dom/client', shellReact.ReactDOMClient || {});
  const platform = await loadReal('@deepseek-ai/dsh-client-runtime/client', {});
  const createSnapshotStore = (initial, options) => { let state = initial; const listeners = new Set(); const persistName = options && options.persist && options.persist.name; if (persistName) { try { const saved = localStorage.getItem(persistName); if (saved !== null) state = JSON.parse(saved); } catch {} } const emit = () => { if (persistName) { try { localStorage.setItem(persistName, JSON.stringify(state)); } catch {} } listeners.forEach(listener => listener()); }; return { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, update(mutator) { if (state && typeof state === 'object') { const draft = Array.isArray(state) ? state.slice() : { ...state }; const result = mutator(draft); state = result === undefined ? draft : result; } else { const result = mutator(state); if (result !== undefined) state = result; } emit(); }, set(next) { state = next; emit(); } }; };
  const defineStore = definition => { let state = typeof definition.state === 'function' ? definition.state() : (definition.state || {}); const listeners = new Set(); const api = { getState: () => state, setState: update => { state = { ...state, ...(typeof update === 'function' ? update(state) : update) }; listeners.forEach(listener => listener()); }, subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); } }; return api; };
  const lazyProxy = new Proxy(function(){}, { get: (_target, property) => property === 'defineStore' ? defineStore : property === 'default' ? react : () => null, apply: () => null });
  const requireCompat = name => name === 'react' ? react : name === 'react/jsx-runtime' ? jsxRuntime : name === 'react-dom' ? reactDom : name === 'react-dom/client' ? reactDomClient : name === '@deepseek-ai/dsh-client-runtime/client' ? { ...platform, defineStore: platform.defineStore || defineStore, createSnapshotStore: platform.createSnapshotStore || createSnapshotStore } : lazyProxy;
  window.__ModuleLoader__ = { load(definition) { exported = definition.factory(requireCompat); } };
  try {
${skinId === "d-dev0101.open-sea-skin" ? rewrittenAssets.replaceAll("'/open-sea-skin/' + path", "'dsh-skin://d-dev0101.open-sea-skin/' + path") : rewrittenAssets}
  } finally { window.__ModuleLoader__ = originalLoader; }
  if (!exported || typeof exported.apply !== 'function') throw new Error('skin client apply export is missing: ' + ${id});
  const listeners = new Map();
  const on = (name, listener) => { const group = listeners.get(name) || new Set(); group.add(listener); listeners.set(name, group); const off = () => group.delete(listener); disposers.push(off); return off; };
  const owned = []; const roots = []; const hosts = new Map(); let activeSlotName = null; let settingsDrawer; let settingsToggle;
  const ownHost = (name, style) => { const host = document.createElement('div'); host.setAttribute('data-dsh-skin-owned', ${id}); host.setAttribute('data-dsh-skin-slot', name); Object.assign(host.style, style); (document.body || document.documentElement).appendChild(host); owned.push(host); return host; };
  const ensureSettings = () => { if (settingsDrawer) return settingsDrawer; settingsDrawer = ownHost('settings.drawer', {position:'fixed',top:'64px',right:'24px',bottom:'76px',width:'min(440px,calc(100vw - 48px))',display:'none',zIndex:'2147483002',overflow:'auto',padding:'18px',border:'1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35))',borderRadius:'12px',background:'var(--dsw-alias-bg-layer-1,Canvas)',color:'var(--dsw-alias-fg-default,CanvasText)',boxShadow:'0 18px 56px rgba(0,0,0,.35)'}); settingsToggle = ownHost('settings.toggle', {position:'fixed',right:'22px',bottom:'22px',width:'38px',height:'38px',boxSizing:'border-box',display:'none',placeItems:'center',zIndex:'2147483003',padding:'0',border:'1px solid var(--dsw-alias-border-default,rgba(127,127,127,.35))',borderRadius:'9px',background:'var(--dsw-alias-bg-layer-1,Canvas)',color:'var(--dsw-alias-fg-default,CanvasText)',font:'13px ui-sans-serif,system-ui',cursor:'pointer'}); settingsToggle.setAttribute('role','button');settingsToggle.setAttribute('tabindex','0');settingsToggle.setAttribute('title','插件设置');settingsToggle.setAttribute('aria-label','插件设置');const settingsNs=['http','www.w3.org','2000','svg'].join('://');const settingsIcon=document.createElementNS(settingsNs,'svg');settingsIcon.setAttribute('viewBox','0 0 24 24');settingsIcon.setAttribute('width','20');settingsIcon.setAttribute('height','20');settingsIcon.setAttribute('fill','none');settingsIcon.setAttribute('stroke','currentColor');settingsIcon.setAttribute('stroke-width','2');settingsIcon.setAttribute('stroke-linecap','round');settingsIcon.setAttribute('stroke-linejoin','round');settingsIcon.setAttribute('aria-hidden','true');settingsIcon.setAttribute('data-icon','settings');const settingsPath=document.createElementNS(settingsNs,'path');settingsPath.setAttribute('d','M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.09a2 2 0 0 1 1 1.74v.5a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.38a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z');const settingsCircle=document.createElementNS(settingsNs,'circle');settingsCircle.setAttribute('cx','12');settingsCircle.setAttribute('cy','12');settingsCircle.setAttribute('r','3');settingsIcon.append(settingsPath,settingsCircle);settingsToggle.appendChild(settingsIcon); const updateSettingsVisibility=()=>{const mounts=[...settingsDrawer.querySelectorAll('[data-dsh-skin-slot$=".mount"]')];const hasContent=mounts.some(mount=>mount.childElementCount>0||(mount.textContent||'').trim().length>0);settingsToggle.style.display=hasContent?'grid':'none';if(!hasContent)settingsDrawer.style.display='none'};const settingsObserver=new MutationObserver(updateSettingsVisibility);settingsObserver.observe(settingsDrawer,{childList:true,subtree:true,characterData:true});disposers.push(()=>settingsObserver.disconnect());const toggleDrawer=()=>{if(settingsToggle.style.display==='none')return;settingsDrawer.style.display=settingsDrawer.style.display==='none'?'block':'none'};settingsToggle.onclick=toggleDrawer;settingsToggle.onkeydown=event=>{if(event.key==='Enter'||event.key===' ')toggleDrawer()};queueMicrotask(updateSettingsVisibility); return settingsDrawer; };
  const ensureHost = name => { if (String(name).startsWith('settings.')) return ensureSettings(); if (hosts.has(name)) return hosts.get(name); const style = name === 'shell.overlay' ? {position:'fixed',inset:'0',zIndex:'2147482000',pointerEvents:'none'} : name === 'conversation.view' ? {position:'fixed',top:'0',right:'0',bottom:'0',left:'var(--dsh-sidebar-width,280px)',zIndex:'2147481900',overflow:'auto'} : name === 'sidebar.footer.action' ? {position:'fixed',left:'12px',bottom:'56px',width:'min(250px,calc(100vw - 24px))',zIndex:'2147482100'} : {position:'fixed',inset:'0',zIndex:'2147481800',pointerEvents:'none'}; const host=ownHost(name,style); hosts.set(name,host); return host; };
  const slots = { inject(name, register) { const previousSlot=activeSlotName; activeSlotName=String(name); try { const result=typeof register==='function' ? register() : noop; if(typeof result==='function')disposers.push(result); return result; } finally { activeSlotName=previousSlot; } }, register(config, Component) { const name=String(config?.name || activeSlotName || 'shell.overlay'); if (typeof Component!=='function' && typeof Component!=='object') return noop; const target=ensureHost(name); const mount=document.createElement('div'); mount.setAttribute('data-dsh-skin-owned',${id}); mount.setAttribute('data-dsh-skin-slot',name+'.mount'); Object.assign(mount.style,{position:'relative',width:'100%',height:name==='conversation.view'?'100%':'auto',pointerEvents:'auto'}); target.appendChild(mount); owned.push(mount); let props={}; if (typeof config?.inject==='function') { try { props=config.inject({sync:noop}) || {}; } catch (error) { console.warn('[dsh skin slot inject]',error); } } const makeStoreHook=(store,fallback)=>selector=>{const getSnapshot=()=>store&&typeof store.getSnapshot==='function'?store.getSnapshot():fallback;const subscribe=listener=>store&&typeof store.subscribe==='function'?store.subscribe(listener):noop;const snapshot=react.useSyncExternalStore(subscribe,getSnapshot,getSnapshot);return typeof selector==='function'?selector(snapshot):snapshot;}; for(const [hookName,store] of Object.entries(props.hooks||{})){const propName='use'+hookName.charAt(0).toUpperCase()+hookName.slice(1);props[propName]=makeStoreHook(store,{});} let slotStore;try{slotStore=config?.store&&typeof config.store.create==='function'?config.store.create('dsh-desktop-shell'):null;}catch{} if(slotStore){props.useStore=makeStoreHook(slotStore,{});props.actions=slotStore.actions||{};} const emptySession={nodes:[],partial:null,running:false,blank:true,runningCalls:[],pending:[],promptError:null};props.useSession ||= makeStoreHook(null,emptySession);props.inputActions ||= {setDraft:noop,submit:noop};props.actions ||= new Proxy({}, {get:()=>noop}); try { const createRoot=reactDomClient.createRoot || reactDom.createRoot; if (typeof createRoot!=='function') throw new Error('ReactDOM createRoot is unavailable'); const root=createRoot(mount); roots.push(root); root.render(react.createElement(Component,props)); let disposed=false; return () => { if (disposed) return; disposed=true; try { root.unmount(); } catch {} mount.remove(); }; } catch (error) { mount.remove(); console.warn('[dsh skin slot mount]',error); return noop; } } };
  let activeLocale = document.documentElement.lang || 'en'; const localeListeners = new Set(); const locale = { getLocale: () => ({ active: activeLocale }), subscribe(listener) { localeListeners.add(listener); return () => localeListeners.delete(listener); }, register() { return noop; }, t: key => key };
  let activeTheme = { id: 'system' }; const registeredThemes = new Map();
  const appliedTokenKeys = new Set();
  const applyTokens = tokens => { for (const [key, value] of Object.entries(tokens || {})) { const name = key.startsWith('--') ? key : '--' + key; appliedTokenKeys.add(name); document.documentElement.style.setProperty(name, String(value)); if (document.body) document.body.style.setProperty(name, String(value)); } };
  const theme = { register(definition) { registeredThemes.set(definition.id, definition); return () => registeredThemes.delete(definition.id); }, overrideTokens(_id, tokens) { applyTokens(tokens); return () => { for (const key of Object.keys(tokens || {})) document.documentElement.style.removeProperty(key.startsWith('--') ? key : '--' + key); }; }, getTheme: () => ({ active: { ...activeTheme, ...(registeredThemes.get(activeTheme.id) || {}) }, preference: activeTheme.id, themes: [...registeredThemes.values()] }), setTheme(id) { activeTheme = { id }; const definition = registeredThemes.get(id); if (definition) { applyTokens(definition.tokens); if (document.body) { if (definition.colorScheme === 'dark') document.body.setAttribute('data-ds-dark-theme', 'true'); else document.body.removeAttribute('data-ds-dark-theme'); } } const group = listeners.get('theme/change'); if (group) group.forEach(listener => listener(theme.getTheme())); } };
  const timer = { timeout(callback, ms) { const handle = setTimeout(callback, ms); return () => clearTimeout(handle); }, interval(callback, ms) { const handle = setInterval(callback, ms); return () => clearInterval(handle); } };
  const initialWhaleState = () => ({version:1,xp:0,level:1,turns:0,sessions:0,tools:0,streak:0,longestStreak:0,checkpoints:[],achievements:[],skin:'ocean',position:{x:.03,y:.08},updatedAt:0}); let whaleState=initialWhaleState(); try { whaleState={...whaleState,...(JSON.parse(localStorage.getItem('dsh-desktop.whale-companion') || 'null') || {})}; } catch {} const saveWhale=()=>localStorage.setItem('dsh-desktop.whale-companion',JSON.stringify(whaleState));
  const whaleCompanion = ${id} === 'leemancheung.dsh-whale-companion' ? { async get(){return {ok:true,value:whaleState}}, async setSkin(value){whaleState={...whaleState,skin:value,updatedAt:Date.now()};saveWhale();return {ok:true,value:whaleState}}, async setPosition(value){whaleState={...whaleState,position:value,updatedAt:Date.now()};saveWhale();return {ok:true,value:whaleState}}, async export(){return {ok:true,value:JSON.stringify(whaleState)}}, async import(payload){try{whaleState={...initialWhaleState(),...JSON.parse(payload),updatedAt:Date.now()};saveWhale();return {ok:true,value:whaleState}}catch(error){return {ok:false,error:{message:error&&error.message?error.message:String(error)}}}}, async reset(){whaleState=initialWhaleState();saveWhale();return {ok:true,value:whaleState}} } : null;
  const remote = { async $mount() { return noop; }, ...(whaleCompanion ? { whaleCompanion } : {}) }; const reflect = { get() { return undefined; } };
  const context = { theme, slots, locale, remote, reflect, effect(register) { try { const result = register(); if (result && typeof result.then === 'function') { result.then(disposer => { if (typeof disposer === 'function') disposers.push(disposer); }).catch(error => console.warn('[dsh skin optional effect]', error)); return noop; } if (typeof result === 'function') disposers.push(result); return result; } catch (error) { console.warn('[dsh skin optional effect]', error); return noop; } }, on, once(name, listener) { let off = noop; off = on(name, (...args) => { off(); listener(...args); }); return off; }, timeout: timer.timeout, interval: timer.interval, get(name) { if (name === 'slots') return slots; if (name === 'timer') return timer; if (name === 'theme') return theme; if (name === 'locale') return locale; if (name === 'remote') return remote; if (name === 'remote.whaleCompanion') return whaleCompanion || undefined; if (name === 'reflect') return reflect; return undefined; }, plugin: noop };
  const applyResult = await exported.apply(context); if (typeof applyResult === 'function') disposers.push(applyResult);
  const persistedTheme = requestedTheme || localStorage.getItem(shellThemeStorageKey);
  const selectedTheme = persistedTheme && registeredThemes.has(persistedTheme) ? persistedTheme : (activationDefault && registeredThemes.has(activationDefault[1]) ? activationDefault[1] : (registeredThemes.size > 1 ? registeredThemes.keys().next().value : null));
  if (selectedTheme) { localStorage.setItem(shellThemeStorageKey, selectedTheme); theme.setTheme(selectedTheme); }
  const availableThemes = [...registeredThemes.values()].map(definition => ({ id: String(definition.id), name: typeof definition.name === 'string' ? definition.name : String(definition.id), colorScheme: definition.colorScheme === 'dark' ? 'dark' : definition.colorScheme === 'light' ? 'light' : undefined }));
  for (const node of [...document.querySelectorAll('style,link[rel="stylesheet"]')]) if (!beforeStyles.has(node)) disposers.push(() => node.remove());
  const changedHtmlAttrs = new Set([...new Set([...beforeAttrs.keys(), ...[...document.documentElement.attributes].map(attribute=>attribute.name)])].filter(name=>document.documentElement.getAttribute(name)!==(beforeAttrs.has(name)?beforeAttrs.get(name):null))); const changedBodyAttrs = new Set(document.body ? [...new Set([...beforeBodyAttrs.keys(), ...[...document.body.attributes].map(attribute=>attribute.name)])].filter(name=>document.body.getAttribute(name)!==(beforeBodyAttrs.has(name)?beforeBodyAttrs.get(name):null)) : []);
  const afterMetrics = { styles: document.querySelectorAll('style').length, bodyStyle: document.body ? document.body.style.length : 0, rootStyle: document.documentElement.style.length };
  const diagnostics = { before: beforeMetrics, after: afterMetrics, registeredThemes: [...registeredThemes.keys()], selectedVariant: selectedTheme };
  window[registryKey] = { id: ${id}, activationDefault, diagnostics, availableThemes, selectedTheme, supportsCustomBackground, customBackgroundUrl, setCustomBackground(dataUrl) { if (typeof dataUrl !== 'string' || !/^data:image\\/(?:png|jpeg|webp|gif);base64,/i.test(dataUrl)) throw new Error('背景图片格式无效'); try { localStorage.setItem(customBackgroundStorageKey, dataUrl); } catch { throw new Error('背景图片过大，请选择更小的图片'); } customBackgroundUrl = dataUrl; this.customBackgroundUrl = dataUrl; applyShellBackground(dataUrl); return true; }, clearCustomBackground() { localStorage.removeItem(customBackgroundStorageKey); customBackgroundUrl = null; this.customBackgroundUrl = null; applyShellBackground(backgroundAssetUrl); return true; }, selectTheme(themeId) { if (typeof themeId !== 'string' || !registeredThemes.has(themeId)) throw new Error('主题未注册：' + String(themeId)); localStorage.setItem(shellThemeStorageKey, themeId); theme.setTheme(themeId); this.selectedTheme = themeId; this.diagnostics.selectedVariant = themeId; return themeId; }, dispose() { for (let index = disposers.length - 1; index >= 0; index -= 1) { try { disposers[index](); } catch {} } for (const key of appliedTokenKeys) { document.documentElement.style.removeProperty(key); if (document.body) document.body.style.removeProperty(key); } disposers.length = 0; for (const root of roots.splice(0)) { try { root.unmount?.(); } catch {} } for (const node of owned.splice(0)) node.remove(); for (const name of changedHtmlAttrs) { if (beforeAttrs.has(name)) document.documentElement.setAttribute(name,beforeAttrs.get(name)); else document.documentElement.removeAttribute(name); } if (document.body) for (const name of changedBodyAttrs) { if (beforeBodyAttrs.has(name)) document.body.setAttribute(name,beforeBodyAttrs.get(name)); else document.body.removeAttribute(name); } } };
  return { ok: true, diagnostics };
  } catch (error) { return { ok: false, error: { stage: 'client-adapter', name: error && error.name ? String(error.name) : 'Error', message: error && error.message ? String(error.message) : String(error), stack: error && error.stack ? String(error.stack) : undefined } }; }
})();`;
}
function createSkinDisposerScript() {
	return `(() => { const runtime = window.__dshDesktopSkinRuntime; if (runtime && typeof runtime.dispose === 'function') runtime.dispose(); delete window.__dshDesktopSkinRuntime; })();`;
}
/** Build the context-isolated, shell-owned skin marketplace UI. */
function createSkinMarketInjectorScript() {
	return String.raw`(() => {
  'use strict';
  const ROOT_ID = 'dsh-shell-skin-market';
  if (document.getElementById(ROOT_ID)) return;
  const api = window.dshDesktopSkins;
  if (!api) return;
  const root = document.createElement('div'); root.id = ROOT_ID;
  const globalBackgroundStorageKey='dsh-desktop.skin-background.global';let persistentBackgroundStyle;const applyPersistentBackground=dataUrl=>{if(persistentBackgroundStyle){persistentBackgroundStyle.remove();persistentBackgroundStyle=undefined}if(!dataUrl)return;persistentBackgroundStyle=document.createElement('style');persistentBackgroundStyle.setAttribute('data-dsh-global-background','true');persistentBackgroundStyle.textContent='html{background-color:#0b0f26!important}html,body{--dsw-alias-bg-base:rgba(9,13,32,.34)!important;--dsw-alias-bg-layer-1:rgba(17,24,52,.52)!important;--dsw-alias-bg-layer-2:rgba(24,32,66,.60)!important;--dsw-specific-sidebar-fill:rgba(11,16,40,.44)!important}body{background-color:transparent!important;background-image:url("'+dataUrl+'")!important;background-size:cover!important;background-position:center!important;background-repeat:no-repeat!important;background-attachment:fixed!important}';document.head.appendChild(persistentBackgroundStyle)};let persistentBackgroundUrl=localStorage.getItem(globalBackgroundStorageKey);if(persistentBackgroundUrl&&!/^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(persistentBackgroundUrl)){localStorage.removeItem(globalBackgroundStorageKey);persistentBackgroundUrl=null}applyPersistentBackground(persistentBackgroundUrl);
  const style = document.createElement('style');
  style.textContent = '#dsh-shell-skin-market{all:initial;position:fixed!important;z-index:2147483647!important;font-family:ui-sans-serif,system-ui,sans-serif!important;color:var(--dss-fg,CanvasText)!important}#dsh-shell-skin-market *{box-sizing:border-box;font-family:inherit}.dss-panel{display:none;position:fixed!important;left:50%!important;top:50%!important;right:auto!important;bottom:auto!important;transform:translate(-50%,-50%)!important;width:min(720px,calc(100vw - 32px))!important;height:min(780px,calc(100vh - 32px))!important;max-height:calc(100vh - 32px)!important;min-height:min(560px,calc(100vh - 32px))!important;overflow:hidden!important;padding:18px!important;border:1px solid var(--dss-border,rgba(127,127,127,.28))!important;border-radius:18px!important;background:var(--dss-surface,Canvas)!important;color:var(--dss-fg,CanvasText)!important;box-shadow:0 24px 70px #0007!important;backdrop-filter:blur(22px) saturate(1.18)!important}.dss-panel.open{display:flex!important;flex-direction:column!important}.dss-head{flex:0 0 auto}.dss-status{flex:0 0 auto;padding:8px 10px!important;border:1px solid light-dark(#0000001c,#ffffff20)!important;border-radius:9px!important;background:var(--dss-elevated,Canvas)!important;box-shadow:0 5px 16px #0002!important;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.dss-grid{flex:1 1 auto!important;min-height:0!important;overflow-y:auto!important;overflow-x:hidden!important;padding:2px 8px 14px 2px!important;align-content:start!important}.dss-head{display:flex;align-items:center;justify-content:space-between;gap:12px}.dss-head h2{margin:0;font-size:19px;color:CanvasText!important}.dss-status{min-height:20px;margin:8px 0;color:light-dark(#555,#bbb)!important;font-size:12px}.dss-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}.dss-card{display:flex!important;flex-direction:column!important;overflow:hidden;padding:0!important;height:455px!important;min-height:455px!important;max-height:455px!important;border:1px solid light-dark(#0000001f,#ffffff22)!important;border-radius:14px;background:var(--dss-card,var(--dss-elevated,Canvas))!important;color:var(--dss-fg,CanvasText)!important}.dss-preview{position:relative;width:100%;height:215px!important;min-height:215px!important;max-height:215px!important;aspect-ratio:auto!important;flex:0 0 215px!important;overflow:hidden;background:linear-gradient(135deg,light-dark(#e8e8e8,#303033),light-dark(#f8f8f8,#1d1d20));border-bottom:1px solid light-dark(#00000018,#ffffff1c)}.dss-preview img{display:block!important;width:100%!important;height:100%!important;object-fit:cover!important;transition:transform .25s ease!important}.dss-card:hover .dss-preview img{transform:scale(1.025)}.dss-preview-fallback{position:absolute;inset:0;display:grid;place-items:center;color:light-dark(#777,#aaa);font-size:13px}.dss-card-body{display:block!important;position:relative!important;flex:1 0 240px!important;height:240px!important;min-height:240px!important;max-height:240px!important;padding:14px 14px 62px!important;overflow:hidden!important}.dss-card h3{margin:0 0 5px;font-size:15px;color:CanvasText!important;white-space:nowrap!important;overflow:hidden!important;text-overflow:ellipsis!important}.dss-card p{margin:5px 0;color:light-dark(#555,#c5c5c5)!important;font-size:12px;line-height:1.45}.dss-description{height:48px!important;min-height:48px!important;max-height:48px!important;margin:4px 0!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:3!important;overflow:hidden!important;text-overflow:ellipsis!important}.dss-compat-error{height:32px!important;min-height:32px!important;max-height:32px!important;margin:3px 0!important;display:-webkit-box!important;-webkit-box-orient:vertical!important;-webkit-line-clamp:2!important;overflow:hidden!important;color:light-dark(#9b3140,#ff9ca9)!important}.dss-meta{color:light-dark(#176b7c,#76d7e8)!important}.dss-actions{display:flex!important;position:absolute!important;left:14px!important;right:14px!important;bottom:14px!important;height:36px!important;min-height:36px!important;max-height:36px!important;flex-wrap:nowrap!important;gap:7px!important;margin:0!important;padding:0!important;visibility:visible!important;opacity:1!important}.dss-actions button{display:inline-flex!important;align-items:center!important;justify-content:center!important;min-height:34px!important;visibility:visible!important;opacity:1}.dss-variant-label{display:block!important;margin:5px 0!important;font-size:12px!important;font-weight:650!important;color:light-dark(#145f6d,#8ee4ef)!important}.dss-variant{display:block!important;width:100%!important;height:30px!important;margin:5px 0!important;padding:3px 8px!important;border:1px solid light-dark(#0000002e,#ffffff30)!important;border-radius:8px!important;background:var(--dss-elevated,Canvas)!important;color:var(--dss-fg,CanvasText)!important}.dss-background-controls{display:flex!important;position:absolute!important;left:14px!important;right:14px!important;bottom:54px!important;height:30px!important;gap:7px!important}.dss-background-controls button{flex:1!important;height:30px!important;padding:4px 8px!important;border:1px solid light-dark(#0000002e,#ffffff30)!important;border-radius:8px!important;background:var(--dss-elevated,Canvas)!important;color:var(--dss-fg,CanvasText)!important;cursor:pointer!important}.dss-card-body.has-background-controls .dss-description{height:24px!important;min-height:24px!important;max-height:24px!important;-webkit-line-clamp:1!important}.dss-actions button,.dss-close{border:1px solid light-dark(#0000002e,#ffffff30)!important;border-radius:9px!important;background:var(--dss-elevated,Canvas)!important;color:var(--dss-fg,CanvasText)!important;padding:7px 11px!important;cursor:pointer!important}.dss-actions button.primary{background:light-dark(#1d6f7e,#397f8d)!important;border-color:transparent!important;color:#fff!important}.dss-actions button.danger{color:light-dark(#a52638,#ff9ba8)!important}.dss-actions button:disabled{opacity:.5;cursor:wait}.dss-wallpaper-controls{display:flex!important;align-items:center!important;gap:8px!important;flex:0 0 auto!important;margin:0 0 10px!important;padding:8px 10px!important;border:1px solid var(--dss-border,rgba(127,127,127,.28))!important;border-radius:9px!important;background:var(--dss-elevated,Canvas)!important}.dss-wallpaper-controls strong{margin-right:auto!important;font-size:12px!important;color:var(--dss-fg,CanvasText)!important}.dss-wallpaper-controls button{height:32px!important;padding:5px 10px!important;border:1px solid var(--dss-border,rgba(127,127,127,.28))!important;border-radius:8px!important;background:var(--dss-surface,Canvas)!important;color:var(--dss-fg,CanvasText)!important;cursor:pointer!important}.dss-wallpaper-controls button:disabled{opacity:.5!important;cursor:default!important}';
  const panel=document.createElement('section'); panel.className='dss-panel'; panel.setAttribute('role','dialog'); panel.setAttribute('aria-label','壳内皮肤市场');
  const head=document.createElement('div'); head.className='dss-head'; const title=document.createElement('h2'); title.textContent='皮肤市场'; const close=document.createElement('button'); close.className='dss-close'; close.type='button'; close.textContent='关闭'; head.append(title,close);
  const status=document.createElement('div'); status.className='dss-status';const wallpaperControls=document.createElement('div');wallpaperControls.className='dss-wallpaper-controls';const wallpaperLabel=document.createElement('strong');wallpaperLabel.textContent='自定义背景';const wallpaperInput=document.createElement('input');wallpaperInput.type='file';wallpaperInput.accept='image/png,image/jpeg,image/webp,image/gif';wallpaperInput.hidden=true;const wallpaperChoose=document.createElement('button');wallpaperChoose.type='button';wallpaperChoose.textContent='选择背景图片';const wallpaperClear=document.createElement('button');wallpaperClear.type='button';wallpaperClear.textContent='移除背景';wallpaperClear.disabled=!persistentBackgroundUrl;wallpaperChoose.addEventListener('click',()=>wallpaperInput.click());wallpaperInput.addEventListener('change',async()=>{const file=wallpaperInput.files&&wallpaperInput.files[0];if(!file)return;setStatus('正在处理背景图片…');try{const dataUrl=await prepareBackground(file);localStorage.setItem(globalBackgroundStorageKey,dataUrl);persistentBackgroundUrl=dataUrl;applyPersistentBackground(dataUrl);const runtime=window.__dshDesktopSkinRuntime;if(runtime&&typeof runtime.setCustomBackground==='function')runtime.setCustomBackground(dataUrl);wallpaperClear.disabled=false;setStatus('背景图片已应用')}catch(error){setStatus(error&&error.message?error.message:String(error))}finally{wallpaperInput.value=''}});wallpaperClear.addEventListener('click',()=>{localStorage.removeItem(globalBackgroundStorageKey);persistentBackgroundUrl=null;applyPersistentBackground(null);const runtime=window.__dshDesktopSkinRuntime;if(runtime&&typeof runtime.clearCustomBackground==='function')runtime.clearCustomBackground();wallpaperClear.disabled=true;setStatus('背景图片已移除')});wallpaperControls.append(wallpaperLabel,wallpaperInput,wallpaperChoose,wallpaperClear); const grid=document.createElement('div'); grid.className='dss-grid'; panel.append(head,status,wallpaperControls,grid); root.append(style,panel); (document.body||document.documentElement).appendChild(root);
  let snapshot={skins:[],activeSkinId:null}; let busy=false; let activeOperationStarted=0;
  const setStatus=(text)=>{status.textContent=text};
  if (typeof api.onProgress === 'function') api.onProgress(progress=>{ if (!progress || !busy) return; const seconds=Math.floor(Number(progress.elapsedMs||0)/1000); const detail=progress.detail?' · '+String(progress.detail):''; setStatus(String(progress.message||progress.phase)+' · '+String(seconds)+' 秒'+detail); });
  const operation=async(label,work)=>{if(busy)return;busy=true;activeOperationStarted=Date.now();setStatus(label+'… · 0 秒');render();try{await work();snapshot=await api.list();setStatus(label+'完成')}catch(error){setStatus(error&&error.message?error.message:String(error))}finally{busy=false;render()}};
  const prepareBackground=file=>new Promise((resolve,reject)=>{if(!file||!/^image\/(?:png|jpeg|webp|gif)$/i.test(file.type)){reject(new Error('请选择 JPG、PNG、WebP 或 GIF 图片'));return}const reader=new FileReader();reader.onerror=()=>reject(new Error('读取背景图片失败'));reader.onload=()=>{const image=new Image();image.onerror=()=>reject(new Error('无法解析背景图片'));image.onload=()=>{const max=1920;const scale=Math.min(1,max/Math.max(image.naturalWidth,image.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));const context=canvas.getContext('2d');if(!context){reject(new Error('无法创建图片画布'));return}context.drawImage(image,0,0,canvas.width,canvas.height);try{resolve(canvas.toDataURL('image/webp',.82))}catch{resolve(reader.result)}};image.src=String(reader.result)};reader.readAsDataURL(file)});
  const previewTargets=new WeakMap();let previewObserver;
  const loadPreview=async image=>{const target=previewTargets.get(image);if(!target)return;const skin=target.skin,index=target.index;try{const trustedDataUrl=await api.preview(skin.id,index);if(typeof trustedDataUrl!=='string'||!/^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(trustedDataUrl))throw new Error('预览图数据无效');image.src = trustedDataUrl}catch{image.remove()}};
  function render(){if(previewObserver)previewObserver.disconnect();previewObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries){if(!entry.isIntersecting)continue;previewObserver.unobserve(entry.target);void loadPreview(entry.target)}},{root:grid,rootMargin:'260px'}):null;grid.replaceChildren(); for(const skin of snapshot.skins){const card=document.createElement('article');card.className='dss-card';const preview=document.createElement('div');preview.className='dss-preview';const fallback=document.createElement('span');fallback.className='dss-preview-fallback';fallback.textContent='暂无预览图';preview.append(fallback);const hasScreenshot=Array.isArray(skin.screenshots)&&skin.screenshots.length>0;if(hasScreenshot){const image=document.createElement('img');image.alt=((skin.name&&skin.name.zh)||skin.id)+' 皮肤预览';image.loading='lazy';image.referrerPolicy='no-referrer';image.addEventListener('load',()=>fallback.remove());image.addEventListener('error',()=>image.remove());previewTargets.set(image,{skin,index:0});preview.append(image);if(previewObserver)previewObserver.observe(image);else void loadPreview(image)}const body=document.createElement('div');body.className='dss-card-body';const h=document.createElement('h3');h.textContent=(skin.name&&skin.name.zh)||skin.id;const desc=document.createElement('p');desc.className='dss-description';desc.textContent=skin.description||'';desc.title=skin.description||'';const meta=document.createElement('p');meta.className='dss-meta';meta.textContent=(skin.author||'')+' · '+((skin.license&&skin.license.code)||'未知许可证');body.append(h,desc,meta);const active=snapshot.activeSkinId===skin.id;const runtime=active?window.__dshDesktopSkinRuntime:null;const choices=runtime&&runtime.id===skin.id&&Array.isArray(runtime.availableThemes)?runtime.availableThemes:[];if(active&&choices.length>1&&typeof runtime.selectTheme==='function'){const pickerLabel=document.createElement('label');pickerLabel.className='dss-variant-label';pickerLabel.textContent='选择主题风格';const picker=document.createElement('select');picker.className='dss-variant';picker.setAttribute('aria-label','选择主题风格');for(const choice of choices){const option=document.createElement('option');option.value=choice.id;option.textContent=choice.name||choice.id;option.selected=choice.id===runtime.selectedTheme;picker.append(option)}picker.disabled=busy;picker.addEventListener('change',()=>{try{runtime.selectTheme(picker.value);setStatus('已切换到 '+picker.options[picker.selectedIndex].text)}catch(error){setStatus(error&&error.message?error.message:String(error))}});pickerLabel.append(picker);body.append(pickerLabel)}const actions=document.createElement('div');actions.className='dss-actions';const installed=Boolean(skin.runtime);const compatible=!installed||skin.runtime.compatible!==false;const action=document.createElement('button');action.type='button';action.className='primary';action.disabled=busy||(installed&&!compatible);action.textContent=active?'停用':installed?(compatible?'使用':'暂不兼容'):'安装';if(installed&&!compatible){const reason=document.createElement('p');reason.className='dss-compat-error';reason.textContent='当前壳无法启用：'+(skin.runtime.error||'需要额外 DSH Client 服务');reason.title=reason.textContent;body.append(reason);action.title=skin.runtime.error||'需要额外 DSH Client 服务'}action.addEventListener('click',()=>void operation(action.textContent,()=>active?api.deactivate():installed?api.activate(skin.id):api.install(skin.id)));actions.append(action);if(installed){const remove=document.createElement('button');remove.type='button';remove.className='danger';remove.disabled=busy;remove.textContent='卸载';remove.addEventListener('click',()=>void operation('卸载',()=>api.uninstall(skin.id)));actions.append(remove)}body.append(actions);card.append(preview,body);grid.append(card)}}
  const load=async()=>{setStatus('正在读取市场目录…');try{snapshot=await api.list();setStatus('皮肤包安装在桌面壳目录，不会修改 DSH profile');render()}catch(error){setStatus(error&&error.message?error.message:String(error))}};
  const readThemeToken=(names,fallback)=>{const sources=[getComputedStyle(document.documentElement),document.body?getComputedStyle(document.body):null];for(const name of names)for(const source of sources){const value=source&&source.getPropertyValue(name).trim();if(value)return value}return fallback};
  const refreshTheme=()=>{const computedCandidates=[document.querySelector('#root'),document.body,document.documentElement].filter(Boolean).map(node=>getComputedStyle(node));const pageBackground=computedCandidates.map(source=>source.backgroundColor).find(value=>value&&value!=='transparent'&&value!=='rgba(0, 0, 0, 0)')||'#ffffff';const surface=readThemeToken(['--dsw-alias-bg-layer-1','--dsw-alias-bg-base','--dsw-specific-sidebar-fill'],pageBackground);const elevated=readThemeToken(['--dsw-alias-bg-layer-2','--dsw-alias-bg-layer-1'],surface);const foreground=readThemeToken(['--dsw-alias-fg-default','--dsw-alias-label-primary'],getComputedStyle(document.body||document.documentElement).color||'#111111');const border=readThemeToken(['--dsw-alias-border-default','--dsw-alias-border-subtle'],'color-mix(in srgb,'+foreground+' 22%,transparent)');const probe=document.createElement('span');probe.style.cssText='position:fixed;visibility:hidden;background-color:'+surface;(document.body||document.documentElement).appendChild(probe);const resolved=getComputedStyle(probe).backgroundColor;probe.remove();const channels=(resolved.match(/[\d.]+/g)||[]).slice(0,3).map(Number);const dark=channels.length===3&&(channels[0]*.2126+channels[1]*.7152+channels[2]*.0722)<128;root.style.colorScheme=dark?'dark':'light';root.style.setProperty('--dss-surface',surface);root.style.setProperty('--dss-elevated',elevated);root.style.setProperty('--dss-card',elevated);root.style.setProperty('--dss-fg',foreground);root.style.setProperty('--dss-border',border)};
  const openMarket=()=>{refreshTheme();panel.classList.add('open');void load();return true};Object.defineProperty(window,'__dshDesktopOpenSkinMarket',{configurable:true,value:openMarket});close.addEventListener('click',()=>panel.classList.remove('open'));document.addEventListener('keydown',event=>{if(event.key==='Escape')panel.classList.remove('open')});
})();`;
}
//#endregion
//#region src/shell-skin-store.ts
function exportTarget(value) {
	if (typeof value === "string") return value;
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const record = value;
	for (const key of [
		"browser",
		"import",
		"default",
		"require"
	]) {
		const target = exportTarget(record[key]);
		if (target !== void 0) return target;
	}
}
async function resolveClientEntry(manifest, source) {
	const candidates = [
		exportTarget(manifest.exports?.["./client"]),
		"./lib/client.js",
		"./plugin/client.js",
		"./dist/client.js",
		"./client.js"
	].filter((value) => typeof value === "string");
	for (const candidate of candidates) {
		if (candidate.startsWith("/") || candidate.includes("..")) continue;
		const target = resolve(source, candidate);
		if (!target.startsWith(resolve(source) + sep)) continue;
		try {
			await access(target);
			return candidate;
		} catch {}
	}
	throw new Error("未找到可注入的客户端入口（支持 exports[\"./client\"] 条件导出及 lib/plugin/dist/client.js）");
}
function isInjectableClientBundle(bundle) {
	const normalized = bundle.replace(/^\uFEFF/, "");
	return /window\s*\.\s*__ModuleLoader__\s*\.\s*load\s*\(\s*\{/.test(normalized);
}
function clientCompatibilityError(_bundle) {}
const CATALOG_URL = "https://raw.githubusercontent.com/kingOfSoySauce/dsh-skin-market/main/data/catalog.json";
const PREVIEW_HOSTS = new Set(["raw.githubusercontent.com", "kingofsoysauce.github.io"]);
const PREVIEW_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/gif",
	"image/avif"
]);
const MAX_PREVIEW_BYTES = 12 * 1024 * 1024;
const MAX_PREVIEW_CACHE_BYTES = 48 * 1024 * 1024;
const ASSET_TYPES = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".webp": "image/webp",
	".gif": "image/gif",
	".svg": "image/svg+xml",
	".avif": "image/avif",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf"
};
const NATIVE_TYPES = {
	...ASSET_TYPES,
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8"
};
/** Resolve only reviewed, package-local shell assets. */
async function resolveShellSkinAsset(directory, requestPath) {
	const raw = requestPath.replace(/^\/+/, "");
	const segments = raw.split(/[\\/]+/);
	if (!raw || segments.some((segment) => !segment || segment === ".." || segment === "." || segment.startsWith("."))) throw new Error("皮肤资源路径越界");
	const relative = segments.join("/");
	const routeRelative = segments.length > 1 ? segments.slice(1).join("/") : void 0;
	const packageRoot = resolve(directory);
	const candidates = [
		[
			resolve(packageRoot, "native-dist"),
			relative,
			NATIVE_TYPES
		],
		[
			packageRoot,
			relative,
			ASSET_TYPES
		],
		[
			resolve(packageRoot, "assets"),
			relative,
			ASSET_TYPES
		]
	];
	if (routeRelative !== void 0) {
		candidates.push([
			resolve(packageRoot, "assets"),
			routeRelative,
			ASSET_TYPES
		]);
		candidates.push([
			resolve(packageRoot, "native-dist"),
			routeRelative,
			NATIVE_TYPES
		]);
	}
	for (const [root, rel, types] of candidates) {
		const extension = extname(rel).toLowerCase();
		if (!(extension in types)) continue;
		const rootReal = await realpathIfExists(root);
		if (rootReal === void 0) continue;
		const target = resolve(root, rel);
		if (target !== root && !target.startsWith(root + sep)) continue;
		const targetReal = await realpathIfExists(target);
		if (targetReal === void 0 || targetReal !== rootReal && !targetReal.startsWith(rootReal + sep)) continue;
		try {
			if (!(await stat(targetReal)).isFile()) continue;
		} catch {
			continue;
		}
		return {
			body: await readFile(targetReal),
			contentType: types[extension]
		};
	}
	throw new Error("未找到皮肤资源");
}
async function realpathIfExists(path) {
	try {
		return await realpath(path);
	} catch {
		return;
	}
}
function safeId(id) {
	if (!/^[a-z0-9][a-z0-9._-]{1,180}$/i.test(id)) throw new Error("皮肤 ID 非法");
	return id;
}
async function run(command, args, cwd, onOutput, timeoutMs = 18e4) {
	await new Promise((ok, fail) => {
		const child = spawn(command, args, {
			cwd,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			shell: false
		});
		let tail = "";
		const accept = (chunk) => {
			const text = String(chunk);
			tail = (tail + text).slice(-8e3);
			for (const line of text.split(/\r?\n/)) if (line.trim()) onOutput(line.trim());
		};
		child.stdout.on("data", accept);
		child.stderr.on("data", accept);
		const timer = setTimeout(() => {
			child.kill();
			fail(/* @__PURE__ */ new Error(command + " 超时，最后输出：" + tail.slice(-1200)));
		}, timeoutMs);
		child.once("error", (error) => {
			clearTimeout(timer);
			fail(error);
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			code === 0 ? ok() : fail(/* @__PURE__ */ new Error(command + " 失败 (exit " + String(code) + ")：" + tail.slice(-1200)));
		});
	});
}
async function downloadPinnedArchive(repo, commit, staging, onOutput) {
	const parsed = new URL(repo);
	if (parsed.hostname !== "github.com") throw new Error("Git 拉取失败且该仓库不支持 GitHub 固定归档回退");
	const parts = parsed.pathname.replace(/\.git$/, "").split("/").filter(Boolean);
	const owner = parts[0], repoName = parts[1];
	if (owner === void 0 || repoName === void 0 || parts.length !== 2) throw new Error("GitHub 仓库地址无效");
	const archiveUrl = "https://codeload.github.com/" + encodeURIComponent(owner) + "/" + encodeURIComponent(repoName) + "/zip/" + encodeURIComponent(commit);
	onOutput("Git 不可用，切换到固定 commit 归档");
	const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(18e4) });
	if (!response.ok) throw new Error("固定版本归档下载失败: HTTP " + response.status);
	const total = Number(response.headers.get("content-length") || 0);
	const reader = response.body?.getReader();
	if (reader === void 0) throw new Error("固定版本归档响应没有数据");
	const chunks = [];
	let received = 0;
	while (true) {
		const result = await reader.read();
		if (result.done) break;
		chunks.push(result.value);
		received += result.value.byteLength;
		onOutput(total > 0 ? "归档下载 " + Math.floor(received * 100 / total) + "% (" + received + "/" + total + " bytes)" : "归档下载 " + received + " bytes");
	}
	const archive = join(staging, "..archive.zip");
	const expanded = join(staging, "..archive");
	await rm(archive, { force: true });
	await rm(expanded, {
		recursive: true,
		force: true
	});
	await writeFile(archive, Buffer.concat(chunks));
	await mkdir(expanded, { recursive: true });
	await extract(archive, { dir: expanded });
	const roots = (await readdir(expanded, { withFileTypes: true })).filter((entry) => entry.isDirectory());
	const archiveRoot = roots[0];
	if (archiveRoot === void 0 || roots.length !== 1) throw new Error("固定版本归档结构无效");
	await rm(staging, {
		recursive: true,
		force: true
	});
	await cp(join(expanded, archiveRoot.name), staging, { recursive: true });
	await rm(archive, { force: true });
	await rm(expanded, {
		recursive: true,
		force: true
	});
}
var ShellSkinStore = class {
	stateValue = {
		activeSkinId: null,
		installed: {}
	};
	catalogValue = [];
	previewCache = /* @__PURE__ */ new Map();
	previewCacheBytes = 0;
	constructor(root, catalogUrl = CATALOG_URL, onProgress = () => {}) {
		this.root = root;
		this.catalogUrl = catalogUrl;
		this.onProgress = onProgress;
	}
	async initialize() {
		await mkdir(join(this.root, "packages"), { recursive: true });
		try {
			this.stateValue = JSON.parse(await readFile(join(this.root, "state.json"), "utf8"));
		} catch {}
		for (const item of Object.values(this.stateValue.installed)) try {
			const bundle = await readFile(resolve(item.directory, item.clientPath), "utf8");
			const error = isInjectableClientBundle(bundle) ? /* @__PURE__ */ clientCompatibilityError(bundle) : "缺少标准 ModuleLoader/apply 导出";
			item.compatible = error === void 0;
			if (error === void 0) delete item.error;
			else item.error = error;
		} catch (error) {
			item.compatible = false;
			item.error = error instanceof Error ? error.message : String(error);
		}
		if (this.stateValue.activeSkinId !== null && !this.stateValue.installed[this.stateValue.activeSkinId]?.compatible) this.stateValue.activeSkinId = null;
		await this.save();
		await this.refreshCatalog();
	}
	async refreshCatalog() {
		const response = await fetch(this.catalogUrl, { signal: AbortSignal.timeout(15e3) });
		if (!response.ok) throw new Error("皮肤目录请求失败: " + response.status);
		const value = await response.json();
		if (!Array.isArray(value.skins)) throw new Error("皮肤目录格式无效");
		this.catalogValue = value.skins.filter((v) => typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.repo === "string" && typeof v.install?.commit === "string");
		return this.catalogValue;
	}
	list() {
		return {
			skins: this.catalogValue.map((s) => ({
				...s,
				screenshots: s.screenshots?.map((_, index) => String(index)),
				runtime: this.runtime(s.id)
			})),
			activeSkinId: this.stateValue.activeSkinId
		};
	}
	async preview(id, index) {
		const skin = this.entry(id);
		if (!Number.isSafeInteger(index) || index < 0) throw new Error("预览图序号无效");
		const source = skin.screenshots?.[index];
		if (typeof source !== "string") throw new Error("预览图不存在");
		const parsed = new URL(source);
		if (parsed.protocol !== "https:" || !PREVIEW_HOSTS.has(parsed.hostname)) throw new Error("预览图来源不受信任");
		const cached = this.previewCache.get(source);
		if (cached !== void 0) {
			this.previewCache.delete(source);
			this.previewCache.set(source, cached);
			return cached.dataUrl;
		}
		const response = await fetch(source, { signal: AbortSignal.timeout(2e4) });
		if (!response.ok) throw new Error("预览图请求失败: " + response.status);
		const finalUrl = response.url ? new URL(response.url) : parsed;
		if (finalUrl.protocol !== "https:" || !PREVIEW_HOSTS.has(finalUrl.hostname)) throw new Error("预览图重定向来源不受信任");
		const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
		if (!PREVIEW_TYPES.has(contentType)) throw new Error("预览图响应类型无效");
		const declared = Number(response.headers.get("content-length") ?? 0);
		if (Number.isFinite(declared) && declared > MAX_PREVIEW_BYTES) throw new Error("预览图超过 12 MB 限制");
		const body = Buffer.from(await response.arrayBuffer());
		if (body.length === 0) throw new Error("预览图响应为空");
		if (body.length > MAX_PREVIEW_BYTES) throw new Error("预览图超过 12 MB 限制");
		const dataUrl = "data:" + contentType + ";base64," + body.toString("base64");
		while (this.previewCacheBytes + body.length > MAX_PREVIEW_CACHE_BYTES && this.previewCache.size > 0) {
			const oldest = this.previewCache.entries().next().value;
			if (oldest === void 0) break;
			this.previewCache.delete(oldest[0]);
			this.previewCacheBytes -= oldest[1].bytes;
		}
		this.previewCache.set(source, {
			dataUrl,
			bytes: body.length
		});
		this.previewCacheBytes += body.length;
		return dataUrl;
	}
	entry(id) {
		const found = this.catalogValue.find((s) => s.id === safeId(id));
		if (!found) throw new Error("皮肤不在市场目录中");
		return found;
	}
	runtime(id) {
		const item = this.stateValue.installed[id];
		if (item?.error?.startsWith("需要 DSH 客户端模块：") || item?.error?.startsWith("需要完整 DSH Client 上下文：")) {
			item.compatible = true;
			delete item.error;
		}
		return item ?? null;
	}
	async save() {
		const temp = join(this.root, "state.json.tmp");
		await writeFile(temp, JSON.stringify(this.stateValue, null, 2));
		await rename(temp, join(this.root, "state.json"));
	}
	async install(id) {
		const skin = this.entry(id);
		const started = Date.now();
		const emit = (phase, message, detail) => this.onProgress({
			skinId: id,
			phase,
			message,
			...detail ? { detail } : {},
			elapsedMs: Date.now() - started
		});
		const target = join(this.root, "packages", safeId(id));
		const staging = target + ".staging";
		try {
			emit("prepare", "正在清理临时目录");
			await rm(staging, {
				recursive: true,
				force: true
			});
			await mkdir(staging, { recursive: true });
			const output = (detail) => emit("download", "正在下载固定版本", detail);
			try {
				await run("git", ["init"], staging, output);
				await run("git", [
					"remote",
					"add",
					"origin",
					skin.repo
				], staging, output);
				await run("git", [
					"fetch",
					"--depth",
					"1",
					"--progress",
					"origin",
					skin.install.commit
				], staging, output);
				await run("git", [
					"checkout",
					"--detach",
					"FETCH_HEAD"
				], staging, output);
			} catch (gitError) {
				output(gitError instanceof Error ? gitError.message : String(gitError));
				await downloadPinnedArchive(skin.repo, skin.install.commit, staging, output);
			}
			emit("validate", "正在校验客户端 bundle");
			const source = skin.subpath ? resolve(staging, skin.subpath) : resolve(staging);
			if (skin.subpath && !source.startsWith(resolve(staging) + sep)) throw new Error("皮肤子路径非法");
			const manifest = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
			if (manifest.name !== skin.package || manifest.dsh?.client === void 0) throw new Error("皮肤客户端清单不兼容");
			const clientPath = await resolveClientEntry(manifest, source);
			const bundle = await readFile(resolve(source, clientPath), "utf8");
			if (!isInjectableClientBundle(bundle)) throw new Error("皮肤客户端 bundle 不支持壳注入：缺少标准 ModuleLoader/apply 导出");
			const compatibilityError = /* @__PURE__ */ clientCompatibilityError(bundle);
			emit("copy", "正在写入壳皮肤目录");
			await rm(target, {
				recursive: true,
				force: true
			});
			if (skin.subpath) {
				await mkdir(target, { recursive: true });
				await cp(source, target, { recursive: true });
			} else await rename(staging, target);
			await rm(staging, {
				recursive: true,
				force: true
			});
			this.stateValue.installed[id] = {
				version: skin.install.version,
				directory: target,
				clientPath,
				compatible: compatibilityError === void 0,
				...compatibilityError ? { error: compatibilityError } : {}
			};
			await this.save();
			emit("complete", "安装完成");
			return this.list();
		} catch (error) {
			await rm(staging, {
				recursive: true,
				force: true
			});
			emit("failed", "安装失败", error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
	async activate(id) {
		if (!this.runtime(id)?.compatible) throw new Error("请先安装兼容皮肤");
		this.stateValue.activeSkinId = id;
		await this.save();
		return this.activeClientBundle();
	}
	async deactivate() {
		this.stateValue.activeSkinId = null;
		await this.save();
		return this.list();
	}
	async uninstall(id) {
		safeId(id);
		if (this.stateValue.activeSkinId === id) this.stateValue.activeSkinId = null;
		const item = this.stateValue.installed[id];
		if (item) await rm(item.directory, {
			recursive: true,
			force: true
		});
		delete this.stateValue.installed[id];
		await this.save();
		return this.list();
	}
	async activeClientBundle() {
		const id = this.stateValue.activeSkinId;
		if (!id) return null;
		const item = this.stateValue.installed[id];
		if (!item?.compatible) return null;
		return {
			id,
			bundle: await readFile(resolve(item.directory, item.clientPath), "utf8")
		};
	}
	async readAsset(id, path) {
		safeId(id);
		const item = this.stateValue.installed[id];
		if (!item?.compatible) throw new Error("皮肤未安装");
		return resolveShellSkinAsset(item.directory, path);
	}
};
//#endregion
//#region src/window-security.ts
function shouldOpenInSystemBrowser(candidate, trustedOrigin) {
	try {
		const url = new URL(candidate);
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (url.hostname === "localhost" || url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/u.test(url.hostname)) return false;
		return trustedOrigin === void 0 || url.origin !== trustedOrigin;
	} catch {
		return false;
	}
}
function allowDshWebPermission(request) {
	if (!request.mainWindow || request.permission !== "clipboard-sanitized-write" || request.trustedOrigin === void 0) return false;
	try {
		return new URL(request.requestingUrl).origin === request.trustedOrigin && new URL(request.currentUrl).origin === request.trustedOrigin;
	} catch {
		return false;
	}
}
//#endregion
//#region src/main.ts
protocol.registerSchemesAsPrivileged([{
	scheme: "dsh-skin",
	privileges: {
		standard: true,
		secure: true,
		supportFetchAPI: true,
		corsEnabled: true
	}
}]);
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const setupPage = join(app.getAppPath(), "assets", "runtime.html");
const repairPage = join(app.getAppPath(), "assets", "session-repair.html");
const pluginManagerPage = join(app.getAppPath(), "assets", "plugin-manager.html");
const mcpManagerPage = join(app.getAppPath(), "assets", "mcp-manager.html");
const personalizationPage = join(app.getAppPath(), "assets", "personalization.html");
const shellUpdatePage = join(app.getAppPath(), "assets", "shell-update.html");
const petPage = join(app.getAppPath(), "assets", "pet.html");
const allowedLocalPages = new Set([
	setupPage,
	repairPage,
	pluginManagerPage,
	mcpManagerPage,
	personalizationPage,
	shellUpdatePage,
	petPage
]);
const preload = join(moduleDirectory, "preload.cjs");
const petPreload = join(moduleDirectory, "pet-preload.cjs");
const shutdownHook = app.isPackaged ? join(process.resourcesPath, "app.asar.unpacked", "lib", "shutdown-hook.js") : join(moduleDirectory, "shutdown-hook.js");
let mainWindow;
let tray;
let managerWindow;
let repairWindow;
let pluginWindow;
let mcpWindow;
let personalizationWindow;
let updateWindow;
let latestUpdateProgress;
let controller;
let pluginManager;
let mcpManager;
let personalizationManager;
let personalizationDirty = false;
let personalizationClosePrompt = false;
let personalizationQuitPrompt = false;
let mcpMutationActive = false;
const pluginRestartCoordinator = new PluginRestartCoordinator();
let updater;
let petWindow;
let petEvents;
let disposePetEvents;
let activePetSession;
let latestView;
let cliDirectory;
let trustedOrigin;
let mainUiLoaded = false;
let shellSkinStore;
let quitting = false;
function runtimeRoot() {
	if (process.env.DSH_DESKTOP_RUNTIME_ROOT !== void 0) return process.env.DSH_DESKTOP_RUNTIME_ROOT;
	const local = process.env.LOCALAPPDATA;
	if (local === void 0 || local.length === 0) throw new Error("LOCALAPPDATA is unavailable");
	return join(local, "DeepSeek Harness", "runtime-manager");
}
let skinReactRuntimeSource;
function getSkinReactRuntimeSource() {
	skinReactRuntimeSource ??= readFileSync(join(dirname(fileURLToPath(import.meta.url)), "skin-react-runtime.global.iife.js"), "utf8");
	return skinReactRuntimeSource;
}
async function executeClientBundleAdapter(contents, bundle, skinId, variantId) {
	await contents.executeJavaScript(`if (!window.__dshDesktopReactRuntime) { ${getSkinReactRuntimeSource()} }`);
	const result = await contents.executeJavaScript(createClientBundleAdapterScript(bundle, skinId, variantId));
	if (result === null || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") throw new Error("皮肤适配器执行失败：皮肤 " + skinId + " 返回了无效结果");
	const adapterResult = result;
	if (adapterResult.ok) return;
	const detail = adapterResult.error ?? {};
	const parts = ["皮肤适配器执行失败：皮肤 " + skinId];
	if (detail.stage !== void 0) parts.push("阶段 " + detail.stage);
	if (detail.name !== void 0) parts.push("名称 " + detail.name);
	if (detail.message !== void 0) parts.push("消息 " + detail.message);
	const error = new Error(parts.join("，"));
	if (detail.stack !== void 0) error.stack = error.message + "\n" + detail.stack;
	throw error;
}
function injectSkinMarket(window) {
	if (window !== mainWindow || trustedOrigin === void 0 || window.isDestroyed()) return;
	try {
		if (new URL(window.webContents.getURL()).origin !== trustedOrigin) return;
	} catch {
		return;
	}
	(async () => {
		await window.webContents.executeJavaScript(createFileContextInjectorScript());
		await window.webContents.executeJavaScript(createSkinMarketInjectorScript());
		const active = await shellSkinStore?.activeClientBundle();
		if (active !== void 0 && active !== null) await executeClientBundleAdapter(window.webContents, active.bundle, active.id);
	})().catch(logFatalError);
}
function petStatus(message) {
	if (message === void 0) return void 0;
	if (message === "Approval response failed") return "审批响应发送失败";
	if (message === "Invalid approval response") return "审批响应格式无效";
	if (message === "Approval expired") return "审批已失效";
	if (message === "DSH event stream unavailable") return "DSH 事件流暂不可用";
	if (message === "DSH connection lost; retrying") return "正在重新连接 DSH";
	return "宠物状态暂不可用";
}
function toPetWindowState(state) {
	const status = petStatus(state.message);
	const approval = state.approval;
	if (approval !== void 0) return {
		mode: "approval",
		...status === void 0 ? {} : { status },
		approval: {
			id: approval.approvalId,
			toolName: approval.toolName,
			sessionLabel: approval.sessionLabel,
			...approval.reason === void 0 ? {} : { reason: approval.reason },
			pendingCount: state.queuedApprovals + 1,
			responding: approval.status === "responding"
		}
	};
	if (state.reply !== void 0) return {
		mode: state.reply.streaming ? "speaking" : "success",
		reply: state.reply.text + (state.reply.truncated ? "…" : ""),
		sessionLabel: "当前会话",
		...status === void 0 ? {} : { status }
	};
	if (state.thinking === true) return {
		mode: "thinking",
		status: "正在思考",
		sessionLabel: "当前会话"
	};
	if (state.connection !== "connected") return {
		mode: "unavailable",
		status: status ?? (state.connection === "reconnecting" ? "正在重新连接 DSH" : "DSH 暂不可用")
	};
	if (status !== void 0) return {
		mode: "error",
		status
	};
	return { mode: "idle" };
}
async function setPetEnabled(enabled) {
	await petWindow?.setEnabled(enabled);
	installMenu();
	installTrayMenu();
}
async function setPetSize(size) {
	const pet = petWindow;
	if (pet === void 0) return;
	try {
		await pet.setSize(size);
	} catch (error) {
		dialog.showErrorBox("无法调整桌宠大小", error instanceof Error ? error.message : String(error));
	} finally {
		installMenu();
	}
}
function showPetContextMenu(event) {
	const pet = petSender(event);
	const owner = BrowserWindow.fromWebContents(event.sender);
	if (pet === void 0 || owner === null || owner.isDestroyed()) return;
	Menu.buildFromTemplate([
		{
			label: "打开 DeepSeek Harness",
			click: showMainWindow
		},
		{ type: "separator" },
		{
			label: "桌宠大小",
			submenu: [
				{
					label: "小",
					type: "radio",
					checked: pet.size === "small",
					click: () => {
						setPetSize("small");
					}
				},
				{
					label: "标准",
					type: "radio",
					checked: pet.size === "standard",
					click: () => {
						setPetSize("standard");
					}
				},
				{
					label: "大",
					type: "radio",
					checked: pet.size === "large",
					click: () => {
						setPetSize("large");
					}
				}
			]
		},
		{ type: "separator" },
		{
			label: "隐藏桌宠",
			click: () => {
				setPetEnabled(false);
			}
		}
	]).popup({ window: owner });
}
async function stopPet() {
	activePetSession = void 0;
	petEvents?.stop();
	disposePetEvents?.();
	disposePetEvents = void 0;
	petEvents = void 0;
	await petWindow?.dispose();
	petWindow = void 0;
}
function installTrayMenu() {
	if (tray === void 0 || tray.isDestroyed()) return;
	tray.setContextMenu(Menu.buildFromTemplate([
		{
			label: "显示 DeepSeek Harness",
			click: showMainWindow
		},
		{
			label: "启用桌面宠物",
			type: "checkbox",
			checked: petWindow?.enabled ?? true,
			click: (item) => {
				setPetEnabled(item.checked);
			}
		},
		{ type: "separator" },
		{
			label: "退出",
			click: () => {
				app.quit();
			}
		}
	]));
}
function clearMainMenu() {
	Menu.setApplicationMenu(null);
	mainWindow?.setMenuBarVisibility(false);
}
function syncMainMenuVisibility() {
	const window = mainWindow;
	if (window === void 0 || window.isDestroyed()) return;
	let trustedPageLoaded = false;
	if (mainUiLoaded && latestView?.phase === "ready" && trustedOrigin !== void 0) try {
		trustedPageLoaded = new URL(window.webContents.getURL()).origin === trustedOrigin;
	} catch {
		trustedPageLoaded = false;
	}
	window.setMenuBarVisibility(trustedPageLoaded);
}
function createWindow(options = {}) {
	const utility = options.utility;
	const manager = utility === "manager";
	const repair = utility === "repair";
	const plugin = utility === "plugin";
	const mcp = utility === "mcp";
	const personalization = utility === "personalization";
	const update = utility === "update";
	const window = new BrowserWindow({
		...update && mainWindow !== void 0 ? {
			parent: mainWindow,
			modal: true
		} : {},
		width: manager ? 700 : repair ? 760 : plugin ? 740 : mcp ? 860 : personalization ? 800 : update ? 480 : 1240,
		height: manager ? 720 : repair ? 780 : plugin ? 700 : mcp ? 760 : personalization ? 720 : update ? 250 : 820,
		minWidth: manager || repair ? 480 : plugin ? 420 : mcp ? 600 : personalization ? 520 : update ? 420 : 820,
		minHeight: manager ? 560 : plugin ? 520 : mcp || personalization ? 560 : update ? 220 : 600,
		...update ? {
			closable: false,
			minimizable: false,
			maximizable: false,
			resizable: false
		} : {},
		show: false,
		autoHideMenuBar: utility !== void 0,
		backgroundColor: "#f5f6f8",
		icon: nativeImage.createFromPath(join(app.getAppPath(), "assets", "icon.png")),
		webPreferences: {
			preload,
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true
		}
	});
	window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
		callback(allowDshWebPermission({
			permission,
			requestingUrl: details.requestingUrl,
			currentUrl: contents.getURL(),
			trustedOrigin,
			mainWindow: contents === mainWindow?.webContents
		}));
	});
	window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin) => {
		return allowDshWebPermission({
			permission,
			requestingUrl: requestingOrigin,
			currentUrl: contents?.getURL() ?? "",
			trustedOrigin,
			mainWindow: contents === mainWindow?.webContents
		});
	});
	window.webContents.setWindowOpenHandler(({ url }) => {
		if (shouldOpenInSystemBrowser(url, trustedOrigin)) shell.openExternal(url);
		return { action: "deny" };
	});
	window.webContents.on("will-navigate", (event, url) => {
		const parsed = new URL(url);
		const origin = parsed.origin;
		if (!(parsed.protocol === "file:" && allowedLocalPages.has(fileURLToPath(parsed)) || trustedOrigin !== void 0 && origin === trustedOrigin)) {
			event.preventDefault();
			if (shouldOpenInSystemBrowser(url, trustedOrigin)) shell.openExternal(url);
		}
	});
	if (utility === void 0) window.setMenuBarVisibility(false);
	window.once("ready-to-show", () => {
		window.show();
	});
	window.webContents.on("did-finish-load", () => {
		sendView(window);
		if (window === mainWindow) {
			syncMainMenuVisibility();
			injectSkinMarket(window);
		}
	});
	return window;
}
function showMainWindow() {
	if (mainWindow === void 0 || mainWindow.isDestroyed()) return;
	if (mainWindow.isMinimized()) mainWindow.restore();
	mainWindow.show();
	mainWindow.focus();
}
function createTray() {
	tray = new Tray(nativeImage.createFromPath(join(app.getAppPath(), "assets", "icon.png")));
	tray.setToolTip("DeepSeek Harness");
	installTrayMenu();
	tray.on("click", showMainWindow);
}
async function showSetup(window) {
	if (window === mainWindow) {
		mainUiLoaded = false;
		clearMainMenu();
	}
	if (!window.webContents.getURL().startsWith("file:")) await window.loadFile(setupPage);
	sendView(window);
}
function sendView(window) {
	if (latestView !== void 0 && !window.isDestroyed()) window.webContents.send("runtime:view", latestView);
}
async function retryRuntimeFromMenu() {
	const runtimeController = controller;
	if (runtimeController === void 0) return;
	if (mainWindow !== void 0) await showSetup(mainWindow);
	await runtimeController.retry();
}
function showUpdateProgress(progress) {
	latestUpdateProgress = progress;
	if (progress.state === "checking" || progress.state === "idle" || progress.state === "error") {
		mainWindow?.setProgressBar(-1);
		if (updateWindow !== void 0 && !updateWindow.isDestroyed()) updateWindow.destroy();
		updateWindow = void 0;
		return;
	}
	if (progress.state === "downloading") mainWindow?.setProgressBar(Math.max(0, Math.min(1, progress.percent / 100)), { mode: "normal" });
	else mainWindow?.setProgressBar(2, { mode: "indeterminate" });
	if (updateWindow === void 0 || updateWindow.isDestroyed()) {
		updateWindow = createWindow({ utility: "update" });
		updateWindow.on("closed", () => {
			updateWindow = void 0;
		});
		updateWindow.loadFile(shellUpdatePage).then(() => {
			if (latestUpdateProgress !== void 0 && updateWindow !== void 0 && !updateWindow.isDestroyed()) updateWindow.webContents.send("shell-update:progress", latestUpdateProgress);
		});
		return;
	}
	updateWindow.webContents.send("shell-update:progress", progress);
}
async function openTextDocument(path) {
	const failure = await shell.openPath(path);
	if (failure.length === 0) return;
	await new Promise((resolve, reject) => {
		const child = spawn("notepad.exe", [path], {
			detached: true,
			stdio: "ignore",
			windowsHide: false
		});
		child.once("error", reject);
		child.once("spawn", () => {
			child.unref();
			resolve();
		});
	}).catch((error) => {
		throw new Error(failure + "\n" + (error instanceof Error ? error.message : String(error)));
	});
}
async function openSettings() {
	if (trustedOrigin === void 0 || latestView?.phase !== "ready") {
		await dialog.showMessageBox({
			type: "warning",
			title: "设置",
			message: "DSH Runtime 尚未就绪。"
		});
		return;
	}
	try {
		await new SettingsDocumentClient(new URL(trustedOrigin)).open();
	} catch (error) {
		await dialog.showMessageBox({
			type: "error",
			title: "无法打开设置",
			message: "无法打开 DSH 配置文件。",
			detail: error instanceof Error ? error.message : String(error)
		});
	}
}
function broadcast(view) {
	latestView = view;
	if (view.phase !== "ready") {
		mainUiLoaded = false;
		mainWindow?.setMenuBarVisibility(false);
		activePetSession = void 0;
		petEvents?.setActiveSession(void 0);
		petEvents?.stop();
	}
	installMenu();
	if (mainWindow !== void 0 && view.phase === "error") showSetup(mainWindow);
	if (mainWindow !== void 0) sendView(mainWindow);
	if (managerWindow !== void 0) sendView(managerWindow);
}
function parsePreference(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("runtime preference must be an object");
	const input = value;
	if (input.mode === "latest-compatible") return { mode: "latest-compatible" };
	if (input.mode === "pinned" && typeof input.version === "string" && input.version.length > 0) return {
		mode: "pinned",
		version: input.version
	};
	throw new Error("runtime preference is invalid");
}
async function openVersionManager() {
	if (managerWindow !== void 0 && !managerWindow.isDestroyed()) {
		managerWindow.focus();
		return;
	}
	managerWindow = createWindow({ utility: "manager" });
	managerWindow.on("closed", () => {
		managerWindow = void 0;
	});
	await managerWindow.loadFile(setupPage, { query: { view: "manager" } });
}
async function openSessionRepair() {
	if (repairWindow !== void 0 && !repairWindow.isDestroyed()) {
		repairWindow.focus();
		return;
	}
	repairWindow = createWindow({ utility: "repair" });
	repairWindow.on("closed", () => {
		repairWindow = void 0;
	});
	await repairWindow.loadFile(repairPage);
}
async function openPluginManager() {
	if (controller?.installedRuntime() === void 0) {
		await dialog.showMessageBox({
			type: "warning",
			title: "插件管理",
			message: "DSH Runtime 尚未安装。"
		});
		return;
	}
	if (pluginWindow !== void 0 && !pluginWindow.isDestroyed()) {
		pluginWindow.focus();
		return;
	}
	pluginWindow = createWindow({ utility: "plugin" });
	pluginWindow.on("closed", () => {
		pluginWindow = void 0;
	});
	await pluginWindow.loadFile(pluginManagerPage);
}
async function openMcpManager() {
	if (controller?.installedRuntime() === void 0) {
		await dialog.showMessageBox({
			type: "warning",
			title: "MCP 管理",
			message: "DSH Runtime 尚未安装。"
		});
		return;
	}
	if (mcpWindow !== void 0 && !mcpWindow.isDestroyed()) {
		mcpWindow.focus();
		return;
	}
	mcpWindow = createWindow({ utility: "mcp" });
	mcpWindow.on("closed", () => {
		mcpWindow = void 0;
	});
	await mcpWindow.loadFile(mcpManagerPage);
}
async function openPersonalization() {
	if (personalizationWindow !== void 0 && !personalizationWindow.isDestroyed()) {
		personalizationWindow.focus();
		return;
	}
	personalizationDirty = false;
	personalizationClosePrompt = false;
	personalizationQuitPrompt = false;
	const window = createWindow({ utility: "personalization" });
	personalizationWindow = window;
	window.on("close", (event) => {
		if (quitting || !personalizationDirty) return;
		event.preventDefault();
		if (personalizationClosePrompt) return;
		personalizationClosePrompt = true;
		dialog.showMessageBox(window, {
			type: "warning",
			title: "个性化设置",
			message: "个性化设置有尚未保存的更改。",
			detail: "关闭窗口将放弃这些更改。",
			buttons: ["继续编辑", "放弃更改"],
			defaultId: 0,
			cancelId: 0
		}).then((result) => {
			personalizationClosePrompt = false;
			if (result.response !== 1 || window.isDestroyed()) return;
			personalizationDirty = false;
			window.close();
		});
	});
	window.on("closed", () => {
		personalizationWindow = void 0;
		personalizationDirty = false;
		personalizationClosePrompt = false;
		personalizationQuitPrompt = false;
	});
	await window.loadFile(personalizationPage);
}
async function showAbout() {
	const runtimeVersion = latestView?.currentVersion === void 0 ? "尚未启动" : latestView.currentVersion;
	await dialog.showMessageBox({
		type: "info",
		title: "关于 DeepSeek Harness",
		message: "DeepSeek Harness",
		detail: "Windows 桌面壳与 DSH Runtime 管理器\n\nShell " + app.getVersion() + "\nDSH " + runtimeVersion + "\n\nCopyright © 2026 ToxicantX\nMIT License",
		icon: nativeImage.createFromPath(join(app.getAppPath(), "assets", "icon.png")),
		buttons: ["确定"],
		defaultId: 0
	});
}
function repairClient(event) {
	if (repairWindow === void 0 || repairWindow.isDestroyed() || event.sender !== repairWindow.webContents) throw new Error("会话修复请求来源无效");
	if (trustedOrigin === void 0 || latestView?.phase !== "ready") throw new Error("DSH Runtime 尚未就绪，请等待启动完成后再试");
	return new SessionRepairClient(new URL(trustedOrigin));
}
function runtimeClient(event) {
	const fromMainWindow = mainWindow !== void 0 && !mainWindow.isDestroyed() && event.sender === mainWindow.webContents;
	const fromManagerWindow = managerWindow !== void 0 && !managerWindow.isDestroyed() && event.sender === managerWindow.webContents;
	if (!fromMainWindow && !fromManagerWindow) throw new Error("Runtime 请求来源无效");
	const url = new URL(event.sender.getURL());
	if (url.protocol !== "file:" || resolve(fileURLToPath(url)) !== resolve(setupPage)) throw new Error("Runtime 请求页面无效");
	if (controller === void 0) throw new Error("DSH Runtime 控制器尚未初始化");
	return controller;
}
function fromTrustedDshWindow(event) {
	if (mainWindow === void 0 || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || trustedOrigin === void 0 || latestView?.phase !== "ready") return false;
	try {
		return new URL(event.sender.getURL()).origin === trustedOrigin;
	} catch {
		return false;
	}
}
function skinService(event) {
	if (!fromTrustedDshWindow(event)) throw new Error("皮肤市场请求来源无效");
	if (shellSkinStore === void 0) throw new Error("皮肤市场尚未初始化");
	return shellSkinStore;
}
function openSkinMarket() {
	if (mainWindow === void 0 || mainWindow.isDestroyed() || trustedOrigin === void 0) return;
	try {
		if (new URL(mainWindow.webContents.getURL()).origin !== trustedOrigin) return;
	} catch {
		return;
	}
	mainWindow.webContents.executeJavaScript("typeof window.__dshDesktopOpenSkinMarket === 'function' ? window.__dshDesktopOpenSkinMarket() : false").catch(logFatalError);
}
function petSender(event) {
	const window = petWindow;
	return window?.matchesSender(event.sender, petPage) === true ? window : void 0;
}
function fromPetWindow(event) {
	const window = petSender(event);
	if (window === void 0) throw new Error("桌面宠物请求来源无效");
	return window;
}
function parseActivePetSession(value) {
	if (value === null) return void 0;
	if (typeof value !== "string" || value.length === 0 || value.length > 128 || !/^[0-9A-Za-z._~-]+$/u.test(value)) throw new Error("桌面宠物前台会话无效");
	return value;
}
function pluginService(event) {
	if (pluginWindow === void 0 || pluginWindow.isDestroyed() || event.sender !== pluginWindow.webContents) throw new Error("插件管理请求来源无效");
	if (pluginManager === void 0) throw new Error("插件管理器尚未初始化");
	return pluginManager;
}
function mcpService(event) {
	if (mcpWindow === void 0 || mcpWindow.isDestroyed() || event.sender !== mcpWindow.webContents) throw new Error("MCP 管理请求来源无效");
	if (mcpManager === void 0) throw new Error("MCP 管理器尚未初始化");
	return mcpManager;
}
function personalizationService(event) {
	if (personalizationWindow === void 0 || personalizationWindow.isDestroyed() || event.sender !== personalizationWindow.webContents) throw new Error("个性化设置请求来源无效");
	if (personalizationManager === void 0) throw new Error("个性化设置管理器尚未初始化");
	return personalizationManager;
}
function isPersonalizationSender(event) {
	return personalizationWindow !== void 0 && !personalizationWindow.isDestroyed() && event.sender === personalizationWindow.webContents;
}
async function setMcpEnabled(event, value) {
	const service = mcpService(event);
	const runtimeController = controller;
	if (runtimeController === void 0) throw new Error("DSH Runtime 控制器尚未初始化");
	if (mcpMutationActive) throw new Error("另一个 MCP 操作正在进行");
	if (pluginManager?.current() !== void 0) throw new Error("插件操作正在进行，请完成后再切换 MCP");
	mcpMutationActive = true;
	try {
		return await mutateMcpWithRuntime({
			async pause() {
				if (quitting) throw new Error("应用正在退出，无法切换 MCP");
				if (mainWindow !== void 0) await showSetup(mainWindow);
				await runtimeController.pauseForPluginMutation();
			},
			async mutate() {
				if (quitting) throw new Error("应用正在退出，无法切换 MCP");
				return service.setEnabled(value);
			},
			async retry() {
				if (!quitting) await runtimeController.retry();
			}
		});
	} finally {
		mcpMutationActive = false;
	}
}
function installMenu() {
	if (!mainUiLoaded) {
		clearMainMenu();
		return;
	}
	const template = [
		{
			label: "文件",
			submenu: [
				{
					label: "个性化设置...",
					click: () => {
						openPersonalization();
					}
				},
				{
					label: "桌宠设置",
					submenu: [
						{
							label: "小",
							type: "radio",
							checked: petWindow?.size === "small",
							enabled: petWindow !== void 0,
							click: () => {
								setPetSize("small");
							}
						},
						{
							label: "标准",
							type: "radio",
							checked: petWindow?.size === "standard",
							enabled: petWindow !== void 0,
							click: () => {
								setPetSize("standard");
							}
						},
						{
							label: "大",
							type: "radio",
							checked: petWindow?.size === "large",
							enabled: petWindow !== void 0,
							click: () => {
								setPetSize("large");
							}
						}
					]
				},
				{
					label: "设置",
					enabled: latestView?.phase === "ready",
					click: () => {
						openSettings();
					}
				},
				{
					label: "检查更新",
					click: () => {
						updater?.check(true);
					}
				},
				{ type: "separator" },
				{
					label: "打开 DSH 数据目录",
					click: () => {
						const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
						mkdir(home, { recursive: true }).then(() => shell.openPath(home));
					}
				}
			]
		},
		{
			label: "Runtime",
			submenu: [
				{
					label: "管理 DSH 版本",
					click: () => {
						openVersionManager();
					}
				},
				{
					label: "刷新并应用版本策略",
					click: () => {
						retryRuntimeFromMenu().catch(logFatalError);
					}
				},
				{ type: "separator" },
				{
					label: "管理插件",
					enabled: controller?.installedRuntime() !== void 0,
					click: () => {
						openPluginManager();
					}
				},
				{
					label: "管理 MCP",
					enabled: controller?.installedRuntime() !== void 0,
					click: () => {
						openMcpManager();
					}
				},
				{
					label: "打开插件管理终端",
					enabled: cliDirectory !== void 0,
					click: () => {
						if (cliDirectory === void 0) return;
						const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
						openPluginTerminal(cliDirectory, home).catch((error) => {
							dialog.showErrorBox("无法打开插件管理终端", String(error));
						});
					}
				}
			]
		},
		{
			label: "编辑",
			submenu: [
				{
					role: "copy",
					label: "复制"
				},
				{
					role: "paste",
					label: "粘贴"
				},
				{
					role: "selectAll",
					label: "全选"
				}
			]
		},
		{
			label: "视图",
			submenu: [
				{
					label: "主题",
					enabled: latestView?.phase === "ready",
					click: openSkinMarket
				},
				{
					label: "桌面宠物",
					type: "checkbox",
					checked: petWindow?.enabled ?? true,
					click: (item) => {
						setPetEnabled(item.checked);
					}
				},
				{ type: "separator" },
				{
					role: "reload",
					label: "重新加载"
				},
				{
					role: "toggleDevTools",
					label: "开发者工具"
				},
				{ type: "separator" },
				{
					role: "resetZoom",
					label: "实际大小"
				},
				{
					role: "zoomIn",
					label: "放大"
				},
				{
					role: "zoomOut",
					label: "缩小"
				},
				{
					role: "togglefullscreen",
					label: "全屏"
				}
			]
		},
		{
			label: "帮助",
			submenu: [
				{
					label: "修复历史会话",
					click: () => {
						openSessionRepair();
					}
				},
				{ type: "separator" },
				{
					label: "关于 DeepSeek Harness",
					click: () => {
						showAbout();
					}
				}
			]
		}
	];
	Menu.setApplicationMenu(Menu.buildFromTemplate(template));
	syncMainMenuVisibility();
}
async function startApplication() {
	mainUiLoaded = false;
	clearMainMenu();
	latestView = {
		phase: "checking",
		message: "正在检查可用的 DSH 版本",
		shellVersion: app.getVersion(),
		minimumDshVersion: MINIMUM_DSH_VERSION,
		preference: { mode: "latest-compatible" },
		versions: [],
		cachedCatalog: false
	};
	mainWindow = createWindow();
	petWindow = new PetWindowController({
		page: petPage,
		preload: petPreload,
		icon: join(app.getAppPath(), "assets", "icon.png"),
		userData: app.getPath("userData"),
		onFatal: logFatalError
	});
	await petWindow.start();
	petEvents = new DesktopPetController({ webSocketFactory: (url) => new WebSocket(url) });
	disposePetEvents = petEvents.subscribe((state) => {
		petWindow?.setState(toPetWindowState(state));
	});
	petWindow.setState(toPetWindowState(petEvents.snapshot()));
	mainWindow.on("show", () => {
		petWindow?.setMainVisible(true);
	});
	mainWindow.on("hide", () => {
		petWindow?.setMainVisible(false);
	});
	mainWindow.on("close", (event) => {
		if (quitting) return;
		event.preventDefault();
		mainWindow?.hide();
	});
	mainWindow.on("closed", () => {
		mainWindow = void 0;
		if (!quitting) petWindow?.setMainVisible(false);
	});
	petWindow.setMainVisible(mainWindow.isVisible());
	createTray();
	await mainWindow.loadFile(setupPage);
	const store = new RuntimeStore(runtimeRoot());
	shellSkinStore = new ShellSkinStore(join(app.getPath("userData"), "skins"), void 0, (progress) => {
		if (mainWindow !== void 0 && !mainWindow.isDestroyed()) mainWindow.webContents.send("shell-skins:progress", progress);
	});
	await shellSkinStore.initialize().catch(logFatalError);
	protocol.handle("dsh-skin", async (request) => {
		try {
			const url = new URL(request.url);
			const asset = await shellSkinStore?.readAsset(decodeURIComponent(url.hostname), decodeURIComponent(url.pathname === "/" ? "/skin.html" : url.pathname));
			if (asset === void 0) return new Response("skin store unavailable", { status: 503 });
			return new Response(new Uint8Array(asset.body), {
				status: 200,
				headers: {
					"content-type": asset.contentType,
					"cache-control": "no-cache",
					"access-control-allow-origin": "*"
				}
			});
		} catch (error) {
			return new Response(error instanceof Error ? error.message : String(error), { status: 404 });
		}
	});
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	await mkdir(home, { recursive: true });
	controller = new RuntimeController({
		shellVersion: app.getVersion(),
		store,
		shutdownHook,
		userData: app.getPath("userData"),
		...process.env.DSH_DESKTOP_CATALOG_URL === void 0 ? {} : { catalogUrl: process.env.DSH_DESKTOP_CATALOG_URL },
		onView: broadcast,
		async onReady(url, _runtime, preparedCliDirectory) {
			mainUiLoaded = false;
			clearMainMenu();
			cliDirectory = preparedCliDirectory;
			trustedOrigin = url.origin;
			activePetSession = void 0;
			petEvents?.setActiveSession(void 0);
			petEvents?.start(url.origin);
			installMenu();
			installTrayMenu();
			const window = mainWindow;
			if (window === void 0) return;
			await window.loadURL(url.href);
			if (mainWindow !== window || window.isDestroyed()) return;
			mainUiLoaded = true;
			installMenu();
		},
		onOpenSettingsDocument: openTextDocument
	});
	pluginManager = new PluginManager({
		runtime: () => controller?.installedRuntime(),
		home,
		onOperationFinished(operation) {
			if (operation.state !== "failed" || controller === void 0) return;
			controller.retry().catch(logFatalError);
		}
	});
	personalizationManager = new PersonalizationManager({ home });
	mcpManager = new McpManager({
		home,
		codexConfigPath: join(homedir(), ".codex", "config.toml"),
		overlayPaths() {
			const runtime = controller?.installedRuntime();
			return runtime === void 0 ? [] : [join(runtime.directory, "app", "desktop.patch.yml")];
		}
	});
	updater = new ShellUpdater(mainWindow, async () => {
		pluginManager?.dispose();
		await stopPet();
		await controller?.stop();
		quitting = true;
	}, showUpdateProgress);
	installMenu();
	await controller.start();
	setTimeout(() => {
		updater?.check(false);
	}, 5e3).unref();
}
function logFatalError(error) {
	const directory = app.getPath("userData");
	mkdirSync(directory, { recursive: true });
	const detail = error instanceof Error ? error.stack ?? error.message : String(error);
	appendFileSync(join(directory, "desktop.log"), `[${(/* @__PURE__ */ new Date()).toISOString()}] ${detail}\n`, "utf8");
}
ipcMain.on("pet:set-active-session", (event, value) => {
	if (!fromTrustedDshWindow(event)) return;
	try {
		const sessionId = parseActivePetSession(value);
		if (sessionId === activePetSession) return;
		activePetSession = sessionId;
		petEvents?.setActiveSession(sessionId);
	} catch {}
});
function parsePetDragPoint(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const input = value;
	if (typeof input.x !== "number" || !Number.isFinite(input.x) || Math.abs(input.x) > 1e6 || typeof input.y !== "number" || !Number.isFinite(input.y) || Math.abs(input.y) > 1e6) return void 0;
	return {
		x: input.x,
		y: input.y
	};
}
ipcMain.on("pet:ready", (event) => {
	petSender(event)?.rendererDidLoad();
});
ipcMain.on("pet:interaction", (event, value) => {
	petSender(event)?.setInteraction(value === true);
});
ipcMain.on("pet:set-shape", (event, value) => {
	const pet = petSender(event);
	if (pet === void 0) return;
	try {
		pet.setBubbleShape(parsePetWindowShape(value, pet.size));
	} catch {}
});
ipcMain.on("pet:drag-start", (event, value) => {
	const point = parsePetDragPoint(value);
	if (point !== void 0) petSender(event)?.startDrag(point);
});
ipcMain.on("pet:drag-move", (event, value) => {
	const point = parsePetDragPoint(value);
	if (point !== void 0) petSender(event)?.dragTo(point);
});
ipcMain.on("pet:drag-end", (event) => {
	petSender(event)?.endDrag();
});
ipcMain.on("pet:focus-main", (event) => {
	if (petSender(event) !== void 0) showMainWindow();
});
ipcMain.on("pet:context-menu", showPetContextMenu);
ipcMain.on("pet:hide", (event) => {
	if (petSender(event) !== void 0) setPetEnabled(false);
});
ipcMain.handle("shell-skins:list", (event) => skinService(event).list());
ipcMain.handle("shell-skins:preview", async (event, skinId, index) => skinService(event).preview(String(skinId), Number(index)));
ipcMain.handle("shell-skins:install", async (event, skinId) => skinService(event).install(String(skinId)));
ipcMain.handle("shell-skins:activate", async (event, skinId) => {
	const service = skinService(event);
	const active = await service.activate(String(skinId));
	if (active !== null) await executeClientBundleAdapter(event.sender, active.bundle, active.id);
	return service.list();
});
ipcMain.handle("shell-skins:select-variant", async (event, skinId, variantId) => {
	const service = skinService(event);
	const requestedSkinId = String(skinId);
	if (service.list().activeSkinId !== requestedSkinId) throw new Error("只能为当前激活皮肤选择变体");
	const active = await service.activeClientBundle();
	if (active === null || active.id !== requestedSkinId) throw new Error("当前激活皮肤不可用");
	await executeClientBundleAdapter(event.sender, active.bundle, active.id, String(variantId));
	return service.list();
});
ipcMain.handle("shell-skins:deactivate", async (event) => {
	const result = await skinService(event).deactivate();
	await event.sender.executeJavaScript(createSkinDisposerScript());
	return result;
});
ipcMain.handle("shell-skins:uninstall", async (event, skinId) => {
	const service = skinService(event);
	const active = service.list().activeSkinId === String(skinId);
	const result = await service.uninstall(String(skinId));
	if (active) await event.sender.executeJavaScript(createSkinDisposerScript());
	return result;
});
ipcMain.handle("pet:respond", async (event, approvalId, outcome) => {
	fromPetWindow(event);
	if (typeof approvalId !== "string" || approvalId.length === 0 || approvalId.length > 256 || outcome !== "allowed-once" && outcome !== "rejected") throw new Error("桌面宠物审批参数无效");
	const events = petEvents;
	if (events === void 0) throw new Error("DSH 审批连接不可用");
	return events.decide({
		approvalId,
		outcome
	});
});
ipcMain.handle("runtime:get-view", (event) => {
	runtimeClient(event);
	return latestView;
});
ipcMain.handle("runtime:retry", async (event) => {
	const runtimeController = runtimeClient(event);
	if (mainWindow !== void 0) await showSetup(mainWindow);
	await runtimeController.retry();
});
ipcMain.handle("runtime:set-preference", async (event, value) => {
	const runtimeController = runtimeClient(event);
	if (mainWindow !== void 0) await showSetup(mainWindow);
	await runtimeController.setPreference(parsePreference(value));
});
ipcMain.handle("runtime:recover-stale-local-plugins", async (event) => {
	const runtimeController = runtimeClient(event);
	if (mainWindow !== void 0) await showSetup(mainWindow);
	await runtimeController.recoverStaleLocalPlugins();
});
ipcMain.handle("runtime:recover-plugin-preset", async (event) => {
	const runtimeController = runtimeClient(event);
	if (mainWindow !== void 0) await showSetup(mainWindow);
	await runtimeController.recoverPluginPreset();
});
ipcMain.handle("personalization:read", async (event) => {
	return personalizationService(event).read();
});
ipcMain.handle("personalization:save", async (event, value) => {
	return personalizationService(event).save(value);
});
ipcMain.on("personalization:dirty", (event, value) => {
	if (isPersonalizationSender(event) && typeof value === "boolean") personalizationDirty = value;
});
ipcMain.handle("mcp-manager:list", async (event) => {
	return mcpService(event).list();
});
ipcMain.handle("mcp-manager:set-enabled", async (event, value) => {
	return setMcpEnabled(event, value);
});
ipcMain.handle("plugin-manager:list", async (event) => {
	return pluginService(event).list();
});
ipcMain.handle("plugin-manager:updates", async (event) => {
	return pluginService(event).updates();
});
ipcMain.handle("plugin-manager:start", async (event, value) => {
	const service = pluginService(event);
	if (mcpMutationActive) throw new Error("MCP 操作正在进行，请完成后再管理插件");
	const runtimeController = controller;
	if (runtimeController === void 0) throw new Error("DSH Runtime 控制器尚未初始化");
	return service.start(value, async () => {
		if (mainWindow !== void 0) await showSetup(mainWindow);
		await runtimeController.pauseForPluginMutation();
	});
});
ipcMain.handle("plugin-manager:status", (event, operationId) => {
	return pluginService(event).status(operationId);
});
ipcMain.handle("plugin-manager:current", (event) => {
	return pluginService(event).current();
});
ipcMain.handle("plugin-manager:restart", async (event, operationId) => {
	const service = pluginService(event);
	const runtimeController = controller;
	if (runtimeController === void 0) throw new Error("DSH Runtime 控制器尚未初始化");
	return pluginRestartCoordinator.restart(operationId, {
		status: (id) => service.status(id),
		async showSetup() {
			if (mainWindow !== void 0) await showSetup(mainWindow);
		},
		async retry() {
			await runtimeController.retry();
		},
		currentView: () => latestView
	}, (id) => {
		service.markRestarted(id);
	});
});
ipcMain.handle("session-repair:inspect", async (event, sessionId) => {
	return repairClient(event).inspect(sessionId);
});
ipcMain.handle("session-repair:apply", async (event, sessionId, expectedRevision) => {
	const result = await repairClient(event).apply(sessionId, expectedRevision);
	mainWindow?.webContents.reload();
	return result;
});
ipcMain.handle("session-repair:rollback", async (event, sessionId, expectedRevision) => {
	const result = await repairClient(event).rollback(sessionId, expectedRevision);
	mainWindow?.webContents.reload();
	return result;
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
	app.on("second-instance", () => {
		showMainWindow();
	});
	app.on("before-quit", (event) => {
		if (quitting) {
			tray?.destroy();
			tray = void 0;
			return;
		}
		if (personalizationDirty && personalizationWindow !== void 0 && !personalizationWindow.isDestroyed()) {
			event.preventDefault();
			if (personalizationQuitPrompt || personalizationClosePrompt) return;
			const window = personalizationWindow;
			personalizationQuitPrompt = true;
			dialog.showMessageBox(window, {
				type: "warning",
				title: "退出 DeepSeek Harness",
				message: "个性化设置有尚未保存的更改。",
				detail: "退出应用将放弃这些更改。",
				buttons: ["继续编辑", "放弃更改并退出"],
				defaultId: 0,
				cancelId: 0
			}).then((result) => {
				personalizationQuitPrompt = false;
				if (result.response !== 1 || window.isDestroyed()) return;
				personalizationDirty = false;
				app.quit();
			});
			return;
		}
		if (controller === void 0 && petWindow === void 0) {
			tray?.destroy();
			tray = void 0;
			return;
		}
		event.preventDefault();
		quitting = true;
		pluginManager?.dispose();
		tray?.destroy();
		tray = void 0;
		Promise.all([stopPet(), controller?.stop()]).finally(() => {
			app.quit();
		});
	});
	app.whenReady().then(startApplication).catch((error) => {
		logFatalError(error);
		dialog.showErrorBox("DeepSeek Harness 启动失败", error instanceof Error ? error.message : String(error));
		app.quit();
	});
}
//#endregion
export {};

//# sourceMappingURL=main.js.map