import { describe, expect, it, vi } from 'vitest'
import { SessionRepairClient } from '../src/session-repair.ts'

const anomaly = {
  eventIndex: 10,
  expectedSeq: 12,
  actualSeq: 10,
  runLength: 40,
  kind: 'branch-reset' as const,
}
const inspection = {
  sessionId: 'session-1',
  revision: 'revision-1',
  repairable: true,
  eventCount: 52,
  fileSize: 4096,
  backupPath: 'C:\\data\\session.jsonl.zstd.bak',
  preservesAllEvents: true,
  anomalies: [anomaly],
  strategy: 'renumber-preserve-physical-order' as const,
}
const repairResult = {
  sessionId: 'session-1',
  previousRevision: 'revision-1',
  newRevision: 'revision-2',
  backupPath: 'C:\\data\\session.jsonl.zstd.bak',
  eventCount: 52,
  lastSeq: 51,
  derivedMessageCount: 7,
}
const rollbackResult = {
  sessionId: 'session-1',
  previousRevision: 'revision-2',
  newRevision: 'revision-3',
  backupPath: 'C:\\data\\session.jsonl.zstd.bak',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status })
}

function successfulFetcher(value: unknown) {
  return vi.fn(async (_url: string | URL, init?: RequestInit) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    return jsonResponse({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
  })
}

describe('SessionRepairClient', () => {
  it('uses the exact DSH RPC endpoint and envelope for inspection', async () => {
    const fetcher = successfulFetcher(inspection)
    const client = new SessionRepairClient(new URL('http://127.0.0.1:60316'), fetcher)
    await expect(client.inspect('session-1')).resolves.toEqual(inspection)
    const call = fetcher.mock.calls[0]
    expect(call).toBeDefined()
    const url = call?.[0]
    const init = call?.[1]
    expect(String(url)).toBe('http://127.0.0.1:60316/api/session.repair.inspect')
    expect(init?.headers).toEqual({ 'content-type': 'application/json' })
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    expect(body).toMatchObject({
      type: 'client-request',
      method: 'session.repair.inspect',
      payload: { sessionId: 'session-1' },
    })
    expect(typeof body.rpcId).toBe('string')
  })

  it('sends only sessionId and expectedRevision for apply and rollback', async () => {
    const fetcher = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string; payload: unknown }
      expect(request.payload).toEqual({ sessionId: 'session-1', expectedRevision: 'revision-1' })
      const value = String(url).endsWith('.apply') ? repairResult : rollbackResult
      return jsonResponse({ type: 'server-response', rpcId: request.rpcId, result: { ok: true, value } })
    })
    const client = new SessionRepairClient(new URL('http://127.0.0.1:60316'), fetcher)
    await expect(client.apply('session-1', 'revision-1')).resolves.toEqual(repairResult)
    await expect(client.rollback('session-1', 'revision-1')).resolves.toEqual(rollbackResult)
  })

  it('maps unsupported runtimes, transport failures, and business errors', async () => {
    const unsupported = new SessionRepairClient(new URL('http://127.0.0.1'), vi.fn(async () => jsonResponse({}, 404)))
    await expect(unsupported.inspect('session-1')).rejects.toThrow('不支持历史会话修复')
    const offline = new SessionRepairClient(new URL('http://127.0.0.1'), vi.fn(async () => { throw new Error('offline') }))
    await expect(offline.inspect('session-1')).rejects.toThrow('offline')
    const fetcher = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { rpcId: string }
      return jsonResponse({ type: 'server-response', rpcId: request.rpcId, result: { ok: false, error: { code: 'REVISION_CHANGED', message: 'revision changed' } } })
    })
    const conflict = new SessionRepairClient(new URL('http://127.0.0.1'), fetcher)
    await expect(conflict.apply('session-1', 'revision-1')).rejects.toThrow('revision changed')
  })

  it('fails closed for malformed and unsafe inspection responses', async () => {
    const malformed = new SessionRepairClient(new URL('http://127.0.0.1'), successfulFetcher({}))
    await expect(malformed.inspect('session-1')).rejects.toThrow('Malformed')
    const unsafe = new SessionRepairClient(new URL('http://127.0.0.1'), successfulFetcher({
      ...inspection,
      anomalies: [{ ...anomaly, kind: 'ambiguous' }],
    }))
    await expect(unsafe.inspect('session-1')).rejects.toThrow('unsafe repairability claim')
  })

  it('rejects path-like session IDs, empty revisions, and non-loopback origins', async () => {
    const fetcher = successfulFetcher(inspection)
    const client = new SessionRepairClient(new URL('http://127.0.0.1'), fetcher)
    await expect(client.inspect('../session')).rejects.toThrow('not a file path')
    await expect(client.apply('session-1', '')).rejects.toThrow('expectedRevision')
    expect(() => new SessionRepairClient(new URL('https://127.0.0.1'))).toThrow('loopback')
    expect(() => new SessionRepairClient(new URL('http://localhost'))).toThrow('loopback')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
