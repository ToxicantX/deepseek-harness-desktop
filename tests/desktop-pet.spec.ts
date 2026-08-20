import { describe, expect, it, vi } from 'vitest'
import {
  DesktopPetController,
  MAX_PET_FRAME_BYTES,
  MAX_PET_TEXT_BYTES,
  clampPetBounds,
  defaultPetBounds,
  parsePetDecision,
  parsePetWebSocketMessage,
  type PetSocketEvent,
  type PetSocketEventType,
  type PetSocketListener,
  type PetWebSocket,
} from '../src/desktop-pet.ts'

class FakeSocket implements PetWebSocket {
  readonly listeners = new Map<PetSocketEventType, Set<PetSocketListener>>()
  readyState = 0
  closeCalls = 0

  constructor(readonly url: string) {}

  addEventListener(type: PetSocketEventType, listener: PetSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<PetSocketListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: PetSocketEventType, listener: PetSocketListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  close(): void {
    this.closeCalls += 1
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.emit('open', {})
  }

  closeRemote(): void {
    this.readyState = 3
    this.emit('close', {})
  }

  message(value: unknown): void {
    this.emit('message', { data: typeof value === 'string' ? value : JSON.stringify(value) })
  }

  error(): void {
    this.emit('error', {})
  }

  private emit(type: PetSocketEventType, event: PetSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
}

function serverRequest(payload: Record<string, unknown>, rpcId = 'rpc-1'): Record<string, unknown> {
  return { type: 'server-request', rpcId, method: payload.type, payload }
}

let nextSessionEventSeq = 0

function sessionEvent(sessionId: string, event: Record<string, unknown>, seq = ++nextSessionEventSeq): Record<string, unknown> {
  return serverRequest({ type: 'session/event', sessionId, event: { ...event, seq } })
}

function turnEvent(sessionId: string, type: 'turn/start' | 'turn/end', turn = 1): Record<string, unknown> {
  return sessionEvent(sessionId, { type, data: { turn } })
}

function assistantChunk(sessionId: string, text: string, turn = 1, step = 1, seq?: number): Record<string, unknown> {
  return sessionEvent(sessionId, {
    type: 'assistant/chunk',
    data: { turn, step, chunk: { type: 'text-delta', text } },
  }, seq)
}

function assistantMessage(sessionId: string, blocks: unknown[], turn = 1, step = 1): Record<string, unknown> {
  return sessionEvent(sessionId, {
    type: 'assistant/message',
    data: { turn, step, message: { role: 'assistant', content: blocks } },
  })
}

function approvalRequested(sessionId: string, approvalId: string, rpcId = 'rpc-approval'): Record<string, unknown> {
  return serverRequest({
    type: 'approval/requested',
    sessionId,
    approvalId,
    toolName: 'shell',
    reason: '需要执行命令',
  }, rpcId)
}

function approvalResolved(sessionId: string, approvalId: string, outcome = 'allowed-once'): Record<string, unknown> {
  return serverRequest({ type: 'approval/resolved', sessionId, approvalId, outcome })
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function createController(fetcher?: (input: string | URL, init?: RequestInit) => Promise<Response>): { controller: DesktopPetController; sockets: FakeSocket[]; fetcher: ReturnType<typeof vi.fn> } {
  const sockets: FakeSocket[] = []
  const request = fetcher === undefined
    ? vi.fn(async () => jsonResponse({ accepted: true }))
    : vi.fn(fetcher)
  const controller = new DesktopPetController({
    webSocketFactory: url => {
      const socket = new FakeSocket(url)
      sockets.push(socket)
      return socket
    },
    fetcher: request,
    reconnectBaseMs: 10,
    reconnectMaxMs: 20,
  })
  return { controller, sockets, fetcher: request }
}

describe('desktop pet protocol validation', () => {
  it('accepts only the current WebSocket server-request envelope', () => {
    const frame = parsePetWebSocketMessage(JSON.stringify(approvalRequested('session-1', 'approval-1')))
    expect(frame).toMatchObject({ type: 'approval/requested', sessionId: 'session-1', approvalId: 'approval-1', rpcId: 'rpc-approval' })
    expect(parsePetWebSocketMessage('{not-json')).toBeUndefined()
    expect(parsePetWebSocketMessage(JSON.stringify({ ...approvalRequested('session-1', 'approval-1'), method: 'wrong' }))).toBeUndefined()
    expect(parsePetWebSocketMessage(JSON.stringify({ type: 'server-response', rpcId: 'rpc-1', result: {} }))).toBeUndefined()
    expect(parsePetWebSocketMessage('x'.repeat(MAX_PET_FRAME_BYTES + 1))).toBeUndefined()
  })

  it('projects only text blocks and bounds multibyte final replies', () => {
    const frame = parsePetWebSocketMessage(JSON.stringify(assistantMessage('session-1', [
      { type: 'reasoning', text: 'private reasoning' },
      { type: 'text', text: '第一段' },
      { type: 'tool-call', name: 'shell', arguments: '{"secret":true}' },
      { type: 'text', text: '第二段' },
    ])))
    expect(frame).toMatchObject({ type: 'session/event', event: { kind: 'final', text: '第一段\n第二段', truncated: false } })
    if (frame?.type !== 'session/event' || frame.event.kind !== 'final') throw new Error('expected final projection')
    expect(Buffer.byteLength(frame.event.text, 'utf8')).toBeLessThanOrEqual(MAX_PET_TEXT_BYTES)

    const huge = parsePetWebSocketMessage(JSON.stringify(assistantChunk('session-1', '界'.repeat(MAX_PET_TEXT_BYTES))))
    expect(huge).toMatchObject({ type: 'session/event', event: { kind: 'text-delta', truncated: true } })
    expect(JSON.stringify(huge)).not.toContain('secret')
  })

  it('rejects malformed identifiers, unsupported event data, and forged renderer decisions', () => {
    expect(parsePetWebSocketMessage(JSON.stringify(approvalRequested(' session-1', 'approval-1')))).toBeUndefined()
    expect(parsePetWebSocketMessage(JSON.stringify(assistantChunk('session-1', 'ok').payload))).toBeUndefined()
    expect(parsePetDecision({ approvalId: 'approval-1', outcome: 'allowed-once', rpcId: 'forged' })).toBeUndefined()
    expect(parsePetDecision({ approvalId: 'approval-1', outcome: 'always-allow' })).toBeUndefined()
    expect(parsePetDecision({ approvalId: 'approval-1', outcome: 'rejected' })).toEqual({ approvalId: 'approval-1', outcome: 'rejected' })
  })
})

describe('DesktopPetController', () => {
  it('filters replies to the active foreground session while accepting approvals from all sessions', () => {
    const { controller, sockets } = createController()
    controller.setActiveSession('foreground')
    controller.start('http://127.0.0.1:43120')
    const socket = sockets[0]
    if (socket === undefined) throw new Error('socket was not created')
    socket.open()

    socket.message(assistantChunk('background', 'hidden'))
    expect(controller.snapshot().reply).toBeUndefined()
    socket.message(assistantChunk('foreground', 'visible'))
    expect(controller.snapshot().reply).toMatchObject({ text: 'visible', streaming: true })
    socket.message(approvalRequested('background', 'approval-background', 'rpc-background'))
    socket.message(approvalRequested('foreground', 'approval-foreground', 'rpc-foreground'))

    const state = controller.snapshot()
    expect(state.approval).toMatchObject({ approvalId: 'approval-background', toolName: 'shell', sessionLabel: '后台会话', status: 'pending' })
    expect(state.queuedApprovals).toBe(1)

    socket.message(approvalResolved('background', 'approval-background'))
    expect(controller.snapshot().approval).toMatchObject({ approvalId: 'approval-foreground', sessionLabel: '当前会话' })
    expect(JSON.stringify(state)).not.toContain('sessionId')
    expect(JSON.stringify(state)).not.toContain('rpcId')
    expect(JSON.stringify(state)).not.toContain('arguments')
  })

  it('shows thinking only for the active session turn lifecycle', () => {
    const { controller, sockets } = createController()
    controller.setActiveSession('foreground')
    controller.start('http://127.0.0.1:43120')
    sockets[0]?.open()

    sockets[0]?.message(turnEvent('background', 'turn/start'))
    expect(controller.snapshot().thinking).toBeUndefined()
    sockets[0]?.message(turnEvent('foreground', 'turn/start'))
    expect(controller.snapshot().thinking).toBe(true)
    expect(controller.snapshot().reply).toBeUndefined()
    sockets[0]?.message(assistantChunk('foreground', 'answer'))
    expect(controller.snapshot().thinking).toBeUndefined()
    sockets[0]?.message(turnEvent('foreground', 'turn/start', 2))
    sockets[0]?.message(turnEvent('foreground', 'turn/end', 2))
    expect(controller.snapshot().thinking).toBeUndefined()
  })

  it('drops duplicate and out-of-order foreground reply events by sequence', () => {
    const { controller, sockets } = createController()
    controller.setActiveSession('foreground')
    controller.start('http://127.0.0.1:43120')
    sockets[0]?.open()

    sockets[0]?.message(assistantChunk('foreground', 'first', 1, 1, 100))
    sockets[0]?.message(assistantChunk('foreground', '-duplicate', 1, 1, 100))
    sockets[0]?.message(assistantChunk('foreground', '-old', 1, 1, 99))
    expect(controller.snapshot().reply?.text).toBe('first')
    sockets[0]?.message(assistantChunk('foreground', '-next', 1, 1, 101))
    expect(controller.snapshot().reply?.text).toBe('first-next')
  })

  it('clears the reply when the Web selection changes', () => {
    const { controller, sockets } = createController()
    controller.setActiveSession('foreground')
    controller.start('http://127.0.0.1:43120')
    sockets[0]?.open()
    sockets[0]?.message(assistantMessage('foreground', [{ type: 'text', text: 'reply' }]))
    expect(controller.snapshot().reply?.text).toBe('reply')

    controller.setActiveSession('other')
    expect(controller.snapshot().reply).toBeUndefined()
    sockets[0]?.message(assistantMessage('foreground', [{ type: 'text', text: 'old session' }]))
    expect(controller.snapshot().reply).toBeUndefined()
    sockets[0]?.message(assistantMessage('other', [{ type: 'text', text: 'new session' }]))
    expect(controller.snapshot().reply?.text).toBe('new session')
  })

  it('correlates one approval response internally without redacting renderer state', async () => {
    const requests: Record<string, unknown>[] = []
    const { controller, sockets, fetcher } = createController(async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>)
      return jsonResponse({ accepted: true })
    })
    controller.start('http://127.0.0.1:43120')
    sockets[0]?.open()
    sockets[0]?.message(approvalRequested('background', 'approval-1', 'rpc-1'))

    await expect(controller.decide({ approvalId: 'approval-1', outcome: 'allowed-once' })).resolves.toEqual({ accepted: true })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(requests[0]).toEqual({
      type: 'client-response',
      rpcId: 'rpc-1',
      result: { ok: true, value: { sessionId: 'background', approvalId: 'approval-1', outcome: 'allowed-once' } },
    })
    expect(controller.snapshot().approval).toMatchObject({ approvalId: 'approval-1', status: 'responding' })
    expect(JSON.stringify(controller.snapshot())).not.toContain('background')

    sockets[0]?.message(approvalResolved('background', 'approval-1'))
    expect(controller.snapshot().approval).toBeUndefined()
  })

  it('prevents duplicate decisions while the first response is in flight', async () => {
    let resolveFetch: ((response: Response) => void) | undefined
    const { controller, sockets } = createController(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    controller.start('http://127.0.0.1:43120')
    sockets[0]?.open()
    sockets[0]?.message(approvalRequested('background', 'approval-1'))

    const first = controller.decide({ approvalId: 'approval-1', outcome: 'rejected' })
    await Promise.resolve()
    await expect(controller.decide({ approvalId: 'approval-1', outcome: 'allowed-once' })).resolves.toEqual({ accepted: false, reason: 'in-flight' })
    resolveFetch?.(jsonResponse({ accepted: true }))
    await expect(first).resolves.toEqual({ accepted: true })
  })

  it('reopens a failed decision for an explicit retry and handles stale approvals', async () => {
    const { controller, sockets } = createController(async () => jsonResponse({ accepted: false, reason: 'not-pending' }))
    controller.start('http://127.0.0.1:43120')
    sockets[0]?.open()
    sockets[0]?.message(approvalRequested('background', 'approval-1'))
    await expect(controller.decide({ approvalId: 'approval-1', outcome: 'rejected' })).resolves.toEqual({ accepted: false, reason: 'not-pending' })
    expect(controller.snapshot().approval).toBeUndefined()
    await expect(controller.decide({ approvalId: 'approval-1', outcome: 'rejected' })).resolves.toEqual({ accepted: false, reason: 'not-pending' })

    sockets[0]?.message(approvalRequested('background', 'approval-2'))
    const failed = createController(async () => jsonResponse({}, 503))
    failed.controller.start('http://127.0.0.1:43120')
    failed.sockets[0]?.open()
    failed.sockets[0]?.message(approvalRequested('background', 'approval-2'))
    await expect(failed.controller.decide({ approvalId: 'approval-2', outcome: 'rejected' })).resolves.toEqual({ accepted: false, reason: 'transport' })
    expect(failed.controller.snapshot().approval).toMatchObject({ approvalId: 'approval-2', status: 'pending' })
  })

  it('reconnects with backoff and stops without reopening sockets', async () => {
    vi.useFakeTimers()
    try {
      const { controller, sockets } = createController()
      controller.start('http://127.0.0.1:43120')
      sockets[0]?.open()
      sockets[0]?.message(approvalRequested('background', 'approval-replayed'))
      sockets[0]?.closeRemote()
      expect(controller.snapshot().connection).toBe('reconnecting')
      expect(controller.snapshot().approval?.approvalId).toBe('approval-replayed')
      await vi.advanceTimersByTimeAsync(10)
      expect(sockets).toHaveLength(2)
      sockets[1]?.open()
      expect(controller.snapshot().connection).toBe('connected')
      expect(controller.snapshot().approval).toBeUndefined()
      sockets[1]?.message(approvalRequested('background', 'approval-replayed'))
      expect(controller.snapshot().approval?.approvalId).toBe('approval-replayed')
      controller.stop()
      sockets[1]?.closeRemote()
      await vi.advanceTimersByTimeAsync(100)
      expect(sockets).toHaveLength(2)
      expect(controller.snapshot()).toEqual({ connection: 'stopped', queuedApprovals: 0 })
    } finally {
      vi.useRealTimers()
    }
  })

  it('reconnects after a stream error and rejects non-loopback origins', async () => {
    vi.useFakeTimers()
    try {
      const { controller, sockets } = createController()
      expect(() => controller.start('https://127.0.0.1:43120')).toThrow('loopback')
      expect(() => controller.start('http://localhost:43120')).toThrow('loopback')
      controller.start('http://127.0.0.1:43120')
      sockets[0]?.open()
      sockets[0]?.message(serverRequest({ type: 'stream/error', error: { code: 'internal', message: 'do not expose' } }))
      expect(controller.snapshot().connection).toBe('reconnecting')
      expect(controller.snapshot().message).toBe('DSH event stream unavailable')
      await vi.advanceTimersByTimeAsync(10)
      expect(sockets).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('desktop pet screen helpers', () => {
  it('clamps restored bounds to negative-coordinate work areas', () => {
    expect(clampPetBounds({ x: -2_000, y: 900, width: 300, height: 200 }, { x: -1_920, y: 0, width: 1_920, height: 1_080 })).toEqual({ x: -1_920, y: 880, width: 300, height: 200 })
    expect(defaultPetBounds({ x: -1_920, y: 0, width: 1_920, height: 1_080 }, { width: 300, height: 200 }, 24)).toEqual({ x: -324, y: 856, width: 300, height: 200 })
  })

  it('rejects invalid dimensions instead of persisting NaN positions', () => {
    expect(() => clampPetBounds({ x: Number.NaN, y: 0, width: 300, height: 200 }, { x: 0, y: 0, width: 1_920, height: 1_080 })).toThrow('finite')
    expect(() => defaultPetBounds({ x: 0, y: 0, width: 1_920, height: 1_080 }, { width: 0, height: 200 })).toThrow('positive')
  })
})
