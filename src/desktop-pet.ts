type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>

export const MAX_PET_TEXT_BYTES = 4_096
export const MAX_PET_TEXT_CHARACTERS = 2_000
export const MAX_PET_REASON_BYTES = 1_024
export const MAX_PET_TOOL_NAME_BYTES = 256
export const MAX_PET_IDENTIFIER_LENGTH = 256
export const MAX_PET_FRAME_BYTES = 64 * 1024
export const MAX_PENDING_APPROVALS = 64

const PET_EVENTS_PATH = '/api/events.mux'
const PET_RESPOND_PATH = '/api/respond'
const DEFAULT_RECONNECT_BASE_MS = 250
const DEFAULT_RECONNECT_MAX_MS = 5_000
const SOCKET_CONNECTING = 0
const SOCKET_OPEN = 1

export type PetApprovalOutcome = 'allowed-once' | 'rejected'
export type PetResolvedOutcome = PetApprovalOutcome | 'cancelled' | 'unavailable'

export interface PetDecision {
  approvalId: string
  outcome: PetApprovalOutcome
}

export type PetDecisionResult =
  | { accepted: true }
  | { accepted: false; reason: 'invalid-decision' | 'not-pending' | 'in-flight' | 'transport' | 'bad-response' | 'stopped' }

export interface PetReplyView {
  text: string
  streaming: boolean
  truncated: boolean
}

export interface PetApprovalView {
  approvalId: string
  toolName: string
  reason?: string
  sessionLabel: string
  status: 'pending' | 'responding'
}

export type PetConnectionState = 'stopped' | 'connecting' | 'connected' | 'reconnecting'

export interface PetRendererState {
  connection: PetConnectionState
  queuedApprovals: number
  reply?: PetReplyView
  approval?: PetApprovalView
  thinking?: true
  message?: string
}

export interface PetTextProjection {
  text: string
  truncated: boolean
}

export interface PetSocketEvent {
  data?: unknown
}

export type PetSocketEventType = 'open' | 'message' | 'close' | 'error'
export type PetSocketListener = (event: PetSocketEvent) => void

export interface PetWebSocket {
  readonly readyState: number
  addEventListener(type: PetSocketEventType, listener: PetSocketListener): void
  removeEventListener(type: PetSocketEventType, listener: PetSocketListener): void
  close(): void
}

export type PetWebSocketFactory = (url: string) => PetWebSocket

export interface DesktopPetOptions {
  webSocketFactory: PetWebSocketFactory
  fetcher?: Fetch
  reconnectBaseMs?: number
  reconnectMaxMs?: number
}

export interface PetWorkArea {
  x: number
  y: number
  width: number
  height: number
}

export interface PetBounds {
  x: number
  y: number
  width: number
  height: number
}

interface ParsedSessionEventTextDelta {
  kind: 'text-delta'
  turn: number
  step: number
  text: string
  truncated: boolean
}

interface ParsedSessionEventFinal {
  kind: 'final'
  turn: number
  step: number
  text: string
  truncated: boolean
}

interface ParsedSessionEventTurnStart {
  kind: 'turn-start'
  turn: number
}

interface ParsedSessionEventTurnEnd {
  kind: 'turn-end'
  turn: number
}

interface ParsedSessionEventIgnored {
  kind: 'ignored'
}

type ParsedSessionEvent = ParsedSessionEventTextDelta | ParsedSessionEventFinal | ParsedSessionEventTurnStart | ParsedSessionEventTurnEnd | ParsedSessionEventIgnored

export type PetMuxFrame =
  | { type: 'session/event'; sessionId: string; seq: number; event: ParsedSessionEvent }
  | { type: 'session/subscribed'; sessionId: string; lastSeq: number }
  | { type: 'approval/requested'; sessionId: string; approvalId: string; rpcId: string; toolName: string; reason?: string }
  | { type: 'approval/resolved'; sessionId: string; approvalId: string; outcome: PetResolvedOutcome }
  | { type: 'stream/error' }

interface PendingApproval {
  approvalId: string
  rpcId: string
  sessionId: string
  toolName: string
  reason?: string
  status: 'pending' | 'responding'
}

interface SocketHandle {
  socket: PetWebSocket
  onOpen: PetSocketListener
  onMessage: PetSocketListener
  onClose: PetSocketListener
  onError: PetSocketListener
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_PET_IDENTIFIER_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

function isSafeIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function sanitizeText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, ' ')
}

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

export function projectPetText(value: unknown, maximumBytes = MAX_PET_TEXT_BYTES, maximumCharacters = MAX_PET_TEXT_CHARACTERS): PetTextProjection | undefined {
  if (typeof value !== 'string') return undefined
  const sanitized = sanitizeText(value)
  let text = ''
  let bytes = 0
  let characters = 0
  let truncated = false
  for (const character of sanitized) {
    if (characters >= maximumCharacters || bytes + utf8ByteLength(character) > maximumBytes) {
      truncated = true
      break
    }
    text += character
    bytes += utf8ByteLength(character)
    characters += 1
  }
  return { text, truncated }
}

function appendProjectedText(current: PetTextProjection, addition: string, separator = ''): PetTextProjection {
  const next = projectPetText(current.text + (current.text.length === 0 ? '' : separator) + addition)
  if (next === undefined) return current
  return { text: next.text, truncated: current.truncated || next.truncated }
}

function projectReason(value: unknown): string | undefined {
  const projection = projectPetText(value, MAX_PET_REASON_BYTES, MAX_PET_REASON_BYTES)
  if (projection === undefined || projection.text.length === 0) return undefined
  return projection.text
}

function projectToolName(value: unknown): string | undefined {
  const projection = projectPetText(value, MAX_PET_TOOL_NAME_BYTES, MAX_PET_TOOL_NAME_BYTES)
  if (projection === undefined || projection.text.length === 0) return undefined
  return projection.text
}

function parseSessionEvent(value: unknown): ParsedSessionEvent {
  if (!isRecord(value) || typeof value.type !== 'string' || !isRecord(value.data)) return { kind: 'ignored' }
  const data = value.data
  if (!isSafeIndex(data.turn)) return { kind: 'ignored' }
  if (value.type === 'turn/start') return { kind: 'turn-start', turn: data.turn }
  if (value.type === 'turn/end') return { kind: 'turn-end', turn: data.turn }
  if (!isSafeIndex(data.step)) return { kind: 'ignored' }
  if (value.type === 'assistant/chunk') {
    if (!isRecord(data.chunk) || data.chunk.type !== 'text-delta') return { kind: 'ignored' }
    const text = projectPetText(data.chunk.text)
    if (text === undefined || text.text.length === 0) return { kind: 'ignored' }
    return { kind: 'text-delta', turn: data.turn, step: data.step, text: text.text, truncated: text.truncated }
  }
  if (value.type === 'assistant/message') {
    if (!isRecord(data.message) || !Array.isArray(data.message.content)) return { kind: 'ignored' }
    let text: PetTextProjection = { text: '', truncated: false }
    for (const block of data.message.content) {
      if (!isRecord(block) || block.type !== 'text') continue
      const blockText = projectPetText(block.text)
      if (blockText === undefined || blockText.text.length === 0) continue
      const next = appendProjectedText(text, blockText.text, '\n')
      text = { text: next.text, truncated: text.truncated || blockText.truncated || next.truncated }
    }
    if (text.text.length === 0) return { kind: 'ignored' }
    return { kind: 'final', turn: data.turn, step: data.step, text: text.text, truncated: text.truncated }
  }
  return { kind: 'ignored' }
}

function parseMuxPayload(value: unknown, rpcId: string): PetMuxFrame | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined
  if (value.type === 'session/event') {
    if (!isBoundedIdentifier(value.sessionId) || !isRecord(value.event) || !isSafeIndex(value.event.seq)) return undefined
    return { type: 'session/event', sessionId: value.sessionId, seq: value.event.seq, event: parseSessionEvent(value.event) }
  }
  if (value.type === 'session/subscribed') {
    if (!isBoundedIdentifier(value.sessionId) || !isSafeIndex(value.lastSeq)) return undefined
    return { type: 'session/subscribed', sessionId: value.sessionId, lastSeq: value.lastSeq }
  }
  if (value.type === 'approval/requested') {
    const toolName = projectToolName(value.toolName)
    if (!isBoundedIdentifier(value.sessionId) || !isBoundedIdentifier(value.approvalId) || toolName === undefined) return undefined
    const reason = projectReason(value.reason)
    return {
      type: 'approval/requested',
      sessionId: value.sessionId,
      approvalId: value.approvalId,
      rpcId,
      toolName,
      ...(reason === undefined ? {} : { reason }),
    }
  }
  if (value.type === 'approval/resolved') {
    if (!isBoundedIdentifier(value.sessionId) || !isBoundedIdentifier(value.approvalId)) return undefined
    if (value.outcome !== 'allowed-once' && value.outcome !== 'rejected' && value.outcome !== 'cancelled' && value.outcome !== 'unavailable') return undefined
    return { type: 'approval/resolved', sessionId: value.sessionId, approvalId: value.approvalId, outcome: value.outcome }
  }
  if (value.type === 'stream/error') {
    if (!isRecord(value.error) || typeof value.error.code !== 'string' || typeof value.error.message !== 'string') return undefined
    return { type: 'stream/error' }
  }
  return undefined
}

export function parsePetWebSocketFrame(value: unknown): PetMuxFrame | undefined {
  if (!isRecord(value) || value.type !== 'server-request' || !isBoundedIdentifier(value.rpcId) || !isBoundedIdentifier(value.method) || !isRecord(value.payload)) return undefined
  if (value.method !== value.payload.type || typeof value.payload.type !== 'string') return undefined
  return parseMuxPayload(value.payload, value.rpcId)
}

export function parsePetWebSocketMessage(value: unknown): PetMuxFrame | undefined {
  if (typeof value !== 'string' || utf8ByteLength(value) > MAX_PET_FRAME_BYTES) return undefined
  try {
    return parsePetWebSocketFrame(JSON.parse(value) as unknown)
  } catch {
    return undefined
  }
}

export function parsePetDecision(value: unknown): PetDecision | undefined {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'approvalId' && key !== 'outcome')) return undefined
  if (!isBoundedIdentifier(value.approvalId)) return undefined
  if (value.outcome !== 'allowed-once' && value.outcome !== 'rejected') return undefined
  return { approvalId: value.approvalId, outcome: value.outcome }
}

function trustedLoopbackOrigin(value: string | URL): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch (error: unknown) {
    throw new TypeError('desktop pet requires a valid DSH origin', { cause: error })
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new TypeError('desktop pet requires a trusted loopback DSH origin')
  }
  return url
}

function socketUrl(origin: URL): string {
  const url = new URL(PET_EVENTS_PATH, origin)
  url.protocol = 'ws:'
  return url.href
}

function validPositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(name + ' must be a positive finite number')
  return value
}

function validRect(value: PetWorkArea, name: string): PetWorkArea {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new TypeError(name + ' origin must be finite')
  return { x: Math.round(value.x), y: Math.round(value.y), width: Math.max(1, Math.round(validPositiveNumber(value.width, name + '.width'))), height: Math.max(1, Math.round(validPositiveNumber(value.height, name + '.height'))) }
}

export function clampPetBounds(bounds: PetBounds, workArea: PetWorkArea): PetBounds {
  const area = validRect(workArea, 'workArea')
  if (!Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) throw new TypeError('bounds origin must be finite')
  const width = Math.min(Math.max(1, Math.round(validPositiveNumber(bounds.width, 'bounds.width'))), area.width)
  const height = Math.min(Math.max(1, Math.round(validPositiveNumber(bounds.height, 'bounds.height'))), area.height)
  const minX = area.x
  const minY = area.y
  const maxX = area.x + area.width - width
  const maxY = area.y + area.height - height
  return {
    x: Math.min(maxX, Math.max(minX, Math.round(bounds.x))),
    y: Math.min(maxY, Math.max(minY, Math.round(bounds.y))),
    width,
    height,
  }
}

export function defaultPetBounds(workArea: PetWorkArea, size: Pick<PetBounds, 'width' | 'height'>, margin = 24): PetBounds {
  if (!Number.isFinite(margin) || margin < 0) throw new TypeError('margin must be a nonnegative finite number')
  const area = validRect(workArea, 'workArea')
  const width = validPositiveNumber(size.width, 'size.width')
  const height = validPositiveNumber(size.height, 'size.height')
  return clampPetBounds({
    x: area.x + area.width - width - Math.round(margin),
    y: area.y + area.height - height - Math.round(margin),
    width,
    height,
  }, area)
}

export function restorePetBounds(saved: PetBounds | undefined, workArea: PetWorkArea, size: Pick<PetBounds, 'width' | 'height'>, margin = 24): PetBounds {
  return saved === undefined ? defaultPetBounds(workArea, size, margin) : clampPetBounds(saved, workArea)
}

function defaultFetch(input: string | URL, init?: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init)
}

export class DesktopPetController {
  private readonly fetcher: Fetch
  private readonly reconnectBaseMs: number
  private readonly reconnectMaxMs: number
  private readonly listeners = new Set<(state: PetRendererState) => void>()
  private readonly approvals = new Map<string, PendingApproval>()
  private readonly responseControllers = new Map<string, AbortController>()
  private socket: SocketHandle | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private origin: URL | undefined
  private activeSessionId: string | undefined
  private activeDraftKey: string | undefined
  private activeLastSeq: number | undefined
  private activeDraft: PetTextProjection = { text: '', truncated: false }
  private reply: PetReplyView | undefined
  private thinking = false
  private connection: PetConnectionState = 'stopped'
  private message: string | undefined
  private reconnectAttempt = 0
  private generation = 0
  private stopped = true

  constructor(private readonly options: DesktopPetOptions) {
    this.fetcher = options.fetcher ?? defaultFetch
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS
    if (!Number.isFinite(this.reconnectBaseMs) || this.reconnectBaseMs <= 0) throw new TypeError('reconnectBaseMs must be positive')
    if (!Number.isFinite(this.reconnectMaxMs) || this.reconnectMaxMs < this.reconnectBaseMs) throw new TypeError('reconnectMaxMs must be at least reconnectBaseMs')
  }

  subscribe(listener: (state: PetRendererState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  snapshot(): PetRendererState {
    const firstApproval = this.approvals.values().next().value as PendingApproval | undefined
    const state: PetRendererState = {
      connection: this.connection,
      queuedApprovals: Math.max(0, this.approvals.size - (firstApproval === undefined ? 0 : 1)),
    }
    if (this.reply !== undefined) state.reply = { ...this.reply }
    if (this.thinking) state.thinking = true
    if (firstApproval !== undefined) {
      state.approval = {
        approvalId: firstApproval.approvalId,
        toolName: firstApproval.toolName,
        ...(firstApproval.reason === undefined ? {} : { reason: firstApproval.reason }),
        sessionLabel: firstApproval.sessionId === this.activeSessionId ? '当前会话' : '后台会话',
        status: firstApproval.status,
      }
    }
    if (this.message !== undefined) state.message = this.message
    return state
  }

  setActiveSession(sessionId: string | undefined): void {
    if (sessionId !== undefined && !isBoundedIdentifier(sessionId)) throw new TypeError('active session must be a bounded opaque identifier')
    if (sessionId === this.activeSessionId) return
    this.activeSessionId = sessionId
    this.activeLastSeq = undefined
    this.activeDraftKey = undefined
    this.activeDraft = { text: '', truncated: false }
    this.reply = undefined
    this.thinking = false
    this.emit()
  }

  start(origin: string | URL): void {
    const trusted = trustedLoopbackOrigin(origin)
    if (!this.stopped && this.origin?.href === trusted.href) return
    this.stop()
    this.origin = trusted
    this.stopped = false
    this.connection = 'connecting'
    this.message = undefined
    this.reconnectAttempt = 0
    this.emit()
    this.openSocket()
  }

  stop(): void {
    this.stopped = true
    this.generation += 1
    this.clearReconnectTimer()
    this.disposeSocket()
    for (const controller of this.responseControllers.values()) controller.abort()
    this.responseControllers.clear()
    this.origin = undefined
    this.approvals.clear()
    this.activeLastSeq = undefined
    this.activeDraftKey = undefined
    this.activeDraft = { text: '', truncated: false }
    this.reply = undefined
    this.thinking = false
    this.connection = 'stopped'
    this.message = undefined
    this.emit()
  }

  async decide(value: unknown): Promise<PetDecisionResult> {
    const decision = parsePetDecision(value)
    if (decision === undefined) return { accepted: false, reason: 'invalid-decision' }
    const pending = this.approvals.get(decision.approvalId)
    if (pending === undefined) return { accepted: false, reason: 'not-pending' }
    if (pending.status !== 'pending') return { accepted: false, reason: 'in-flight' }
    const origin = this.origin
    if (this.stopped || origin === undefined) return { accepted: false, reason: 'stopped' }
    pending.status = 'responding'
    const responseController = new AbortController()
    this.responseControllers.set(decision.approvalId, responseController)
    this.emit()
    const body = {
      type: 'client-response',
      rpcId: pending.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: pending.sessionId,
          approvalId: pending.approvalId,
          outcome: decision.outcome,
        },
      },
    }
    let response: Response
    try {
      response = await this.fetcher(new URL(PET_RESPOND_PATH, origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: responseController.signal,
      })
    } catch {
      this.responseControllers.delete(decision.approvalId)
      if (this.approvals.get(decision.approvalId) === pending) {
        pending.status = 'pending'
        this.message = 'Approval response failed'
        this.emit()
      }
      return { accepted: false, reason: 'transport' }
    }
    this.responseControllers.delete(decision.approvalId)
    if (this.approvals.get(decision.approvalId) !== pending) return { accepted: false, reason: 'not-pending' }
    if (!response.ok) {
      pending.status = 'pending'
      this.message = 'Approval response failed'
      this.emit()
      return { accepted: false, reason: 'transport' }
    }
    let result: unknown
    try {
      result = await response.json() as unknown
    } catch {
      pending.status = 'pending'
      this.message = 'Invalid approval response'
      this.emit()
      return { accepted: false, reason: 'bad-response' }
    }
    if (isRecord(result) && result.accepted === true) {
      this.message = undefined
      this.emit()
      return { accepted: true }
    }
    if (isRecord(result) && result.accepted === false && result.reason === 'not-pending') {
      this.approvals.delete(decision.approvalId)
      this.message = 'Approval expired'
      this.emit()
      return { accepted: false, reason: 'not-pending' }
    }
    pending.status = 'pending'
    this.message = 'Invalid approval response'
    this.emit()
    return { accepted: false, reason: 'bad-response' }
  }

  private openSocket(): void {
    const origin = this.origin
    if (this.stopped || origin === undefined) return
    const generation = this.generation
    let socket: PetWebSocket
    try {
      socket = this.options.webSocketFactory(socketUrl(origin))
    } catch {
      this.handleConnectionFailure(generation)
      return
    }
    const handle: SocketHandle = {
      socket,
      onOpen: () => {
        if (!this.isCurrentSocket(handle, generation)) return
        this.reconnectAttempt = 0
        for (const controller of this.responseControllers.values()) controller.abort()
        this.responseControllers.clear()
        this.approvals.clear()
        this.connection = 'connected'
        this.message = undefined
        this.emit()
      },
      onMessage: event => {
        if (!this.isCurrentSocket(handle, generation)) return
        const frame = parsePetWebSocketMessage(event.data)
        if (frame !== undefined) this.handleFrame(frame)
      },
      onClose: () => {
        if (!this.isCurrentSocket(handle, generation)) return
        this.finishSocket(handle)
        this.handleConnectionFailure(generation)
      },
      onError: () => {
        if (!this.isCurrentSocket(handle, generation)) return
        this.finishSocket(handle)
        this.handleConnectionFailure(generation)
      },
    }
    this.socket = handle
    socket.addEventListener('open', handle.onOpen)
    socket.addEventListener('message', handle.onMessage)
    socket.addEventListener('close', handle.onClose)
    socket.addEventListener('error', handle.onError)
    if (socket.readyState === SOCKET_OPEN) handle.onOpen({})
    else if (socket.readyState !== SOCKET_CONNECTING) handle.onClose({})
  }

  private isCurrentSocket(handle: SocketHandle, generation: number): boolean {
    return !this.stopped && this.generation === generation && this.socket === handle
  }

  private finishSocket(handle: SocketHandle): void {
    if (this.socket !== handle) return
    this.socket = undefined
    handle.socket.removeEventListener('open', handle.onOpen)
    handle.socket.removeEventListener('message', handle.onMessage)
    handle.socket.removeEventListener('close', handle.onClose)
    handle.socket.removeEventListener('error', handle.onError)
  }

  private disposeSocket(): void {
    const handle = this.socket
    if (handle === undefined) return
    this.finishSocket(handle)
    try {
      handle.socket.close()
    } catch {
      // A socket that already closed needs no further cleanup.
    }
  }

  private handleConnectionFailure(generation: number, failureMessage = 'DSH connection lost; retrying'): void {
    if (this.stopped || this.generation !== generation) return
    this.connection = 'reconnecting'
    this.message = failureMessage
    this.emit()
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== undefined) return
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** this.reconnectAttempt))
    this.reconnectAttempt = Math.min(this.reconnectAttempt + 1, 30)
    const timer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (!this.stopped) this.openSocket()
    }, delay)
    this.reconnectTimer = timer
    if (typeof timer === 'object' && timer !== null && 'unref' in timer && typeof timer.unref === 'function') timer.unref()
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === undefined) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }

  private handleFrame(frame: PetMuxFrame): void {
    if (frame.type === 'session/event') {
      this.handleSessionEvent(frame)
      return
    }
    if (frame.type === 'approval/requested') {
      this.handleApprovalRequested(frame)
      return
    }
    if (frame.type === 'approval/resolved') {
      this.handleApprovalResolved(frame)
      return
    }
    if (frame.type === 'stream/error') {
      this.message = 'DSH event stream unavailable'
      this.emit()
      const handle = this.socket
      if (handle !== undefined) {
        this.finishSocket(handle)
        try {
          handle.socket.close()
        } catch {
          // The failed stream may already be closed.
        }
      }
      this.handleConnectionFailure(this.generation, 'DSH event stream unavailable')
    }
  }

  private handleSessionEvent(frame: Extract<PetMuxFrame, { type: 'session/event' }>): void {
    if (frame.sessionId !== this.activeSessionId) return
    if (this.activeLastSeq !== undefined && frame.seq <= this.activeLastSeq) return
    this.activeLastSeq = frame.seq
    if (frame.event.kind === 'ignored') return
    if (frame.event.kind === 'turn-start') {
      this.activeDraftKey = undefined
      this.activeDraft = { text: '', truncated: false }
      this.reply = undefined
      this.thinking = true
      this.emit()
      return
    }
    if (frame.event.kind === 'turn-end') {
      this.thinking = false
      this.emit()
      return
    }
    const key = String(frame.event.turn) + ':' + String(frame.event.step)
    if (frame.event.kind === 'text-delta') {
      this.thinking = false
      if (this.activeDraftKey !== key) {
        this.activeDraftKey = key
        this.activeDraft = { text: '', truncated: false }
      }
      const next = projectPetText(this.activeDraft.text + frame.event.text)
      if (next !== undefined) this.activeDraft = { text: next.text, truncated: this.activeDraft.truncated || frame.event.truncated || next.truncated }
      if (this.activeDraft.text.length === 0) return
      this.reply = { text: this.activeDraft.text, streaming: true, truncated: this.activeDraft.truncated }
      this.emit()
      return
    }
    this.activeDraftKey = key
    this.activeDraft = { text: frame.event.text, truncated: frame.event.truncated }
    this.reply = { text: frame.event.text, streaming: false, truncated: frame.event.truncated }
    this.thinking = false
    this.message = undefined
    this.emit()
  }

  private handleApprovalRequested(frame: Extract<PetMuxFrame, { type: 'approval/requested' }>): void {
    const existing = this.approvals.get(frame.approvalId)
    if (existing !== undefined) {
      if (existing.sessionId !== frame.sessionId || existing.rpcId !== frame.rpcId) return
      return
    }
    if (this.approvals.size >= MAX_PENDING_APPROVALS) return
    this.approvals.set(frame.approvalId, {
      approvalId: frame.approvalId,
      rpcId: frame.rpcId,
      sessionId: frame.sessionId,
      toolName: frame.toolName,
      ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      status: 'pending',
    })
    this.emit()
  }

  private handleApprovalResolved(frame: Extract<PetMuxFrame, { type: 'approval/resolved' }>): void {
    const existing = this.approvals.get(frame.approvalId)
    if (existing === undefined || existing.sessionId !== frame.sessionId) return
    this.approvals.delete(frame.approvalId)
    this.message = undefined
    this.emit()
  }

  private emit(): void {
    const state = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(state)
      } catch {
        // A renderer observer must not interrupt runtime event processing.
      }
    }
  }
}
