import { randomUUID } from 'node:crypto'

export type SessionRepairAnomalyKind = 'branch-reset' | 'stale-single-event' | 'ambiguous'

export interface SessionRepairAnomaly {
  eventIndex: number
  expectedSeq: number
  actualSeq: number
  runLength: number
  kind: SessionRepairAnomalyKind
}

export interface SessionRepairInspection {
  sessionId: string
  revision: string
  repairable: boolean
  eventCount?: number
  fileSize?: number
  backupPath?: string
  preservesAllEvents?: boolean
  anomalies: SessionRepairAnomaly[]
  strategy?: 'renumber-preserve-physical-order'
  reason?: string
}

export interface SessionRepairResult {
  sessionId: string
  previousRevision: string
  newRevision: string
  backupPath: string
  eventCount: number
  lastSeq: number
  derivedMessageCount: number
}

export interface SessionRepairRollbackResult {
  sessionId: string
  previousRevision: string
  newRevision: string
  backupPath: string
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>
type Parser<T> = (value: unknown) => T
const MAX_SESSION_ID_LENGTH = 256
const MAX_REVISION_LENGTH = 512

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) {
    throw new Error('Malformed session repair response: ' + name + ' must be a nonempty bounded string')
  }
  return value
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error('Malformed session repair response: ' + name + ' must be a nonnegative integer')
  }
  return value
}

function validateSessionId(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_SESSION_ID_LENGTH
    || value.trim() !== value
    || /[\\/\u0000-\u001f]/u.test(value)) {
    throw new TypeError('sessionId must be a nonempty bounded identifier, not a file path')
  }
  return value
}

function validateRevision(value: unknown): string {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_REVISION_LENGTH
    || value.trim() !== value
    || /[\u0000-\u001f]/u.test(value)) {
    throw new TypeError('expectedRevision must be a nonempty bounded string')
  }
  return value
}

function parseAnomaly(value: unknown): SessionRepairAnomaly {
  if (!isRecord(value)
    || (value.kind !== 'branch-reset' && value.kind !== 'stale-single-event' && value.kind !== 'ambiguous')) {
    throw new Error('Malformed session repair response: invalid anomaly')
  }
  return {
    eventIndex: nonnegativeInteger(value.eventIndex, 'anomaly.eventIndex'),
    expectedSeq: nonnegativeInteger(value.expectedSeq, 'anomaly.expectedSeq'),
    actualSeq: nonnegativeInteger(value.actualSeq, 'anomaly.actualSeq'),
    runLength: nonnegativeInteger(value.runLength, 'anomaly.runLength'),
    kind: value.kind,
  }
}

function parseInspection(value: unknown): SessionRepairInspection {
  if (!isRecord(value) || typeof value.repairable !== 'boolean' || !Array.isArray(value.anomalies)) {
    throw new Error('Malformed session repair response: invalid inspection')
  }
  const anomalies = value.anomalies.map(parseAnomaly)
  let strategy: SessionRepairInspection['strategy']
  if (value.strategy !== undefined) {
    if (value.strategy !== 'renumber-preserve-physical-order') {
      throw new Error('Malformed session repair response: invalid repair strategy')
    }
    strategy = value.strategy
  }
  let preservesAllEvents: boolean | undefined
  if (value.preservesAllEvents !== undefined) {
    if (typeof value.preservesAllEvents !== 'boolean') {
      throw new Error('Malformed session repair response: preservesAllEvents must be a boolean')
    }
    preservesAllEvents = value.preservesAllEvents
  }
  if (value.repairable && (anomalies.length === 0
    || anomalies.some(anomaly => anomaly.kind === 'ambiguous')
    || value.eventCount === undefined
    || value.fileSize === undefined
    || typeof value.backupPath !== 'string'
    || preservesAllEvents !== true
    || strategy !== 'renumber-preserve-physical-order')) {
    throw new Error('Malformed session repair response: unsafe repairability claim')
  }
  return {
    sessionId: requiredString(value.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
    revision: requiredString(value.revision, 'revision', MAX_REVISION_LENGTH),
    repairable: value.repairable,
    anomalies,
    ...(value.eventCount === undefined ? {} : { eventCount: nonnegativeInteger(value.eventCount, 'eventCount') }),
    ...(value.fileSize === undefined ? {} : { fileSize: nonnegativeInteger(value.fileSize, 'fileSize') }),
    ...(value.backupPath === undefined ? {} : { backupPath: requiredString(value.backupPath, 'backupPath') }),
    ...(preservesAllEvents === undefined ? {} : { preservesAllEvents }),
    ...(strategy === undefined ? {} : { strategy }),
    ...(value.reason === undefined ? {} : { reason: requiredString(value.reason, 'reason') }),
  }
}

function parseResult(value: unknown): SessionRepairResult {
  if (!isRecord(value)) throw new Error('Malformed session repair response: invalid repair result')
  return {
    sessionId: requiredString(value.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
    previousRevision: requiredString(value.previousRevision, 'previousRevision', MAX_REVISION_LENGTH),
    newRevision: requiredString(value.newRevision, 'newRevision', MAX_REVISION_LENGTH),
    backupPath: requiredString(value.backupPath, 'backupPath'),
    eventCount: nonnegativeInteger(value.eventCount, 'eventCount'),
    lastSeq: nonnegativeInteger(value.lastSeq, 'lastSeq'),
    derivedMessageCount: nonnegativeInteger(value.derivedMessageCount, 'derivedMessageCount'),
  }
}

function parseRollbackResult(value: unknown): SessionRepairRollbackResult {
  if (!isRecord(value)) throw new Error('Malformed session repair response: invalid rollback result')
  return {
    sessionId: requiredString(value.sessionId, 'sessionId', MAX_SESSION_ID_LENGTH),
    previousRevision: requiredString(value.previousRevision, 'previousRevision', MAX_REVISION_LENGTH),
    newRevision: requiredString(value.newRevision, 'newRevision', MAX_REVISION_LENGTH),
    backupPath: requiredString(value.backupPath, 'backupPath'),
  }
}

export class SessionRepairClient {
  private readonly baseUrl: URL
  private readonly fetcher: Fetch

  constructor(baseUrl: URL, fetcher: Fetch = globalThis.fetch) {
    if (baseUrl.protocol !== 'http:' || baseUrl.hostname !== '127.0.0.1' || baseUrl.username !== '' || baseUrl.password !== '') {
      throw new TypeError('session repair API must use the trusted loopback runtime origin')
    }
    this.baseUrl = new URL(baseUrl.origin)
    this.fetcher = fetcher
  }

  async inspect(sessionIdValue: unknown): Promise<SessionRepairInspection> {
    const sessionId = validateSessionId(sessionIdValue)
    const result = await this.call('session.repair.inspect', { sessionId }, parseInspection)
    this.assertSession(result.sessionId, sessionId)
    return result
  }

  async apply(sessionIdValue: unknown, revisionValue: unknown): Promise<SessionRepairResult> {
    const sessionId = validateSessionId(sessionIdValue)
    const expectedRevision = validateRevision(revisionValue)
    const result = await this.call('session.repair.apply', { sessionId, expectedRevision }, parseResult)
    this.assertSession(result.sessionId, sessionId)
    return result
  }

  async rollback(sessionIdValue: unknown, revisionValue: unknown): Promise<SessionRepairRollbackResult> {
    const sessionId = validateSessionId(sessionIdValue)
    const expectedRevision = validateRevision(revisionValue)
    const result = await this.call('session.repair.rollback', { sessionId, expectedRevision }, parseRollbackResult)
    this.assertSession(result.sessionId, sessionId)
    return result
  }

  private assertSession(actual: string, expected: string): void {
    if (actual !== expected) throw new Error('Malformed session repair response: sessionId mismatch')
  }

  private async call<T>(method: string, payload: Record<string, string>, parse: Parser<T>): Promise<T> {
    const rpcId = randomUUID()
    let response: Response
    try {
      response = await this.fetcher(new URL('/api/' + method, this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
      })
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error('Session repair runtime request failed: ' + detail, { cause: error })
    }
    if (response.status === 404) throw new Error('当前 DSH Runtime 不支持历史会话修复，请升级 Runtime 后重试')
    if (!response.ok) throw new Error('Session repair runtime request failed with HTTP ' + response.status)
    let body: unknown
    try {
      body = await response.json()
    } catch (error: unknown) {
      throw new Error('Malformed session repair response: invalid JSON', { cause: error })
    }
    if (!isRecord(body) || body.type !== 'server-response' || body.rpcId !== rpcId || !isRecord(body.result)) {
      throw new Error('Malformed session repair response: invalid RPC envelope')
    }
    if (body.result.ok === false) {
      const error = isRecord(body.result.error) ? body.result.error : {}
      const message = typeof error.message === 'string'
        ? error.message
        : typeof error.code === 'string' ? error.code : 'unknown RPC error'
      throw new Error('Session repair failed: ' + message)
    }
    if (body.result.ok !== true || !Object.hasOwn(body.result, 'value')) {
      throw new Error('Malformed session repair response: invalid RPC result')
    }
    return parse(body.result.value)
  }
}
