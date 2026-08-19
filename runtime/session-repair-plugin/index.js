import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, toNamespacedPath } from 'node:path'
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'
import { decodeStorageRecord, packChunkRuns, Session } from '@deepseek-ai/dsh-session'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy'
import { createRepairPlan, decodeSessionLog, inspectSequence } from './core.mjs'

export const name = 'desktop-session-repair'
export const inject = ['apiProxy', 'sessions', 'sessionPersistence', 'settings', 'storageDomain', 'webServer']

const ENDPOINTS = new Map([
  ['settings.openDocument', 'settings'],
  ['session.repair.inspect', 'inspect'],
  ['session.repair.apply', 'apply'],
  ['session.repair.rollback', 'rollback'],
])
const MAX_BODY_BYTES = 16 * 1024
const MAX_FRAME_PLAINTEXT_BYTES = 1024 * 1024
const CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
const compressZstd = promisify(zstdCompress)
const decompressZstd = promisify(zstdDecompress)
const locks = new Set()
let win32Bindings

class RepairError extends Error {
  constructor(code, message, options) {
    super(message, options)
    this.name = 'SessionRepairError'
    this.code = code
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertSessionId(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim() !== value || /[\\/\u0000-\u001f]/u.test(value)) {
    throw new RepairError('BAD_REQUEST', 'sessionId must be a bounded identifier, not a file path')
  }
  return value
}

function assertRevision(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value || /[\u0000-\u001f]/u.test(value)) {
    throw new RepairError('BAD_REQUEST', 'expectedRevision must be a nonempty bounded string')
  }
  return value
}

function parsePayload(payload, needsRevision) {
  if (!isRecord(payload)) throw new RepairError('BAD_REQUEST', 'request payload must be an object')
  const allowed = needsRevision ? ['expectedRevision', 'sessionId'] : ['sessionId']
  const keys = Object.keys(payload).sort()
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) {
    throw new RepairError('BAD_REQUEST', 'request payload contains unsupported fields')
  }
  return {
    sessionId: assertSessionId(payload.sessionId),
    ...(needsRevision ? { expectedRevision: assertRevision(payload.expectedRevision) } : {}),
  }
}

function persistenceOf(ctx) {
  const persistence = ctx.sessionPersistence
  for (const method of ['locate', 'readRaw', 'readStoredRevision']) {
    if (typeof persistence?.[method] !== 'function') {
      throw new RepairError('UNSUPPORTED_BACKEND', 'active session persistence backend does not expose safe raw artifact access')
    }
  }
  if (persistence.supportsRawArtifacts !== true) {
    throw new RepairError('UNSUPPORTED_BACKEND', 'active session persistence backend does not support raw artifacts')
  }
  return persistence
}

function assertInactive(ctx, sessionId) {
  if (ctx.sessions.get(sessionId) !== undefined) {
    throw new RepairError('ACTIVE_SESSION', '会话当前处于活动状态；请先关闭会话后再修复')
  }
}

async function pathExists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}

function compressionFor(path) {
  if (path.endsWith('.jsonl.zstd')) return 'zstd'
  if (path.endsWith('.jsonl')) return 'none'
  throw new RepairError('UNSUPPORTED_BACKEND', 'session persistence returned an unsupported artifact format')
}

function scanZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== 0xfd2fb528) throw new RepairError('CORRUPT_FRAME', 'invalid Zstandard frame magic at byte ' + String(offset))
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) throw new RepairError('CORRUPT_FRAME', 'reserved Zstandard frame-header bit at byte ' + String(offset - 1))
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) throw new RepairError('CORRUPT_FRAME', 'reserved Zstandard block type at byte ' + String(offset - 3))
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
  }
  return { frames }
}

async function decodePhysical(buffer, compression) {
  if (compression === 'none') return buffer.toString('utf8')
  const scanned = scanZstdFrames(buffer)
  if (scanned.tornStart !== undefined) {
    throw new RepairError('TORN_FRAME', 'session log has an incomplete final Zstandard frame; automatic sequence repair is refused')
  }
  if (scanned.frames.length === 0) throw new RepairError('CORRUPT_FRAME', 'session log has no complete Zstandard frame')
  const plaintext = []
  for (const frame of scanned.frames) plaintext.push(await decompressZstd(buffer.subarray(frame.start, frame.end)))
  return Buffer.concat(plaintext).toString('utf8')
}

async function readArtifact(ctx, sessionId, expectedRevision, signal) {
  signal?.throwIfAborted()
  const persistence = persistenceOf(ctx)
  const before = await persistence.readStoredRevision(sessionId, signal)
  if (before === undefined) throw new RepairError('SESSION_NOT_FOUND', '找不到会话 ' + sessionId)
  if (expectedRevision !== undefined && before !== expectedRevision) {
    throw new RepairError('REVISION_CHANGED', '会话文件已变化；请重新诊断后再试')
  }
  const raw = await persistence.readRaw(sessionId, signal)
  if (raw === undefined) throw new RepairError('SESSION_NOT_FOUND', '找不到会话 ' + sessionId)
  const location = persistence.locate(raw.meta)
  if (!isRecord(location) || location.kind !== 'jsonl' || typeof location.path !== 'string' || !isAbsolute(location.path)) {
    throw new RepairError('UNSUPPORTED_BACKEND', 'session persistence did not resolve a controlled JSONL path')
  }
  const compression = compressionFor(location.path)
  const physical = await readFile(location.path, { signal })
  const decodedPhysical = await decodePhysical(physical, compression)
  const after = await persistence.readStoredRevision(sessionId, signal)
  if (after !== before) throw new RepairError('REVISION_CHANGED', '会话文件在读取期间发生变化；修复已中止')
  if (decodedPhysical !== raw.content) throw new RepairError('REVISION_CHANGED', 'raw session artifact changed across stable reads')
  return { persistence, raw, path: location.path, compression, revision: before, fileSize: physical.length }
}

function validateReplay(meta, events) {
  const replay = Session.fromRestore(meta.id, structuredClone(events), structuredClone(meta))
  return { derivedMessageCount: replay.deriveMessages().length }
}

function planArtifact(artifact) {
  return createRepairPlan(artifact.raw.content, {
    decodeStorageRecord,
    validateReplay: events => validateReplay(artifact.raw.meta, events),
  })
}

function backupPathFor(path) { return path + '.bak' }
function repairedBackupPathFor(path) { return path + '.repaired.bak' }

async function inspectSession(ctx, payload, signal) {
  const { sessionId } = parsePayload(payload, false)
  return withLock(sessionId, async () => {
    assertInactive(ctx, sessionId)
    const artifact = await readArtifact(ctx, sessionId, undefined, signal)
    const decoded = decodeSessionLog(artifact.raw.content, decodeStorageRecord)
    const anomalies = inspectSequence(decoded.events)
    const backupPath = backupPathFor(artifact.path)
    let repairable = false
    let preservesAllEvents
    let strategy
    let reason
    if (anomalies.length === 0) reason = '日志健康，无需修复'
    else if (anomalies.some(anomaly => anomaly.kind === 'ambiguous')) reason = '序号异常无法明确区分，禁止自动修复'
    else {
      try {
        const plan = planArtifact(artifact)
        preservesAllEvents = plan.repairedEvents.length === decoded.events.length
        strategy = 'renumber-preserve-physical-order'
        if (await pathExists(backupPath)) reason = '不可覆盖的备份文件已存在，请先处理现有备份'
        else if (!preservesAllEvents) reason = '无法确认完整保留全部事件'
        else repairable = true
      } catch (error) {
        reason = '完整语义重放失败：' + (error instanceof Error ? error.message : String(error))
      }
    }
    return {
      sessionId,
      revision: artifact.revision,
      repairable,
      eventCount: decoded.events.length,
      fileSize: artifact.fileSize,
      backupPath,
      ...(preservesAllEvents === undefined ? {} : { preservesAllEvents }),
      anomalies,
      ...(strategy === undefined ? {} : { strategy }),
      ...(reason === undefined ? {} : { reason }),
    }
  })
}

async function encodeArtifact(headerLine, events, compression) {
  const lines = [headerLine + '\n', ...packChunkRuns(events).map(record => {
    const serialized = JSON.stringify(record)
    if (serialized === undefined) throw new RepairError('ENCODE_FAILED', 'a repaired storage record is not JSON serializable')
    return serialized + '\n'
  })]
  if (compression === 'none') return Buffer.from(lines.join(''), 'utf8')
  const frames = []
  let batch = ''
  let bytes = 0
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line)
    if (bytes > 0 && bytes + lineBytes > MAX_FRAME_PLAINTEXT_BYTES) {
      frames.push(await compressZstd(Buffer.from(batch), CHECKSUM_OPTIONS))
      batch = ''
      bytes = 0
    }
    batch += line
    bytes += lineBytes
  }
  if (bytes > 0) frames.push(await compressZstd(Buffer.from(batch), CHECKSUM_OPTIONS))
  return Buffer.concat(frames)
}

async function writeDurable(path, contents) {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(contents)
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function loadWin32Bindings() {
  if (win32Bindings !== undefined) return win32Bindings
  const kernel32 = (await import('koffi')).default.load('kernel32.dll')
  win32Bindings = {
    move: kernel32.func('__stdcall', 'MoveFileExW', 'int', ['str16', 'str16', 'uint']),
    lastError: kernel32.func('__stdcall', 'GetLastError', 'uint', []),
  }
  return win32Bindings
}

async function syncDirectory(path) {
  const handle = await open(path, 'r')
  try { await handle.sync() } finally { await handle.close() }
}

async function durableMove(source, destination) {
  if (process.platform === 'win32') {
    const api = await loadWin32Bindings()
    if (api.move(toNamespacedPath(source), toNamespacedPath(destination), 8) === 0) {
      const code = api.lastError()
      throw new RepairError('ATOMIC_MOVE_FAILED', 'MoveFileExW failed with Win32 error ' + String(code) + ': ' + source + ' -> ' + destination)
    }
    return
  }
  if (await pathExists(destination)) throw new RepairError('BACKUP_EXISTS', 'destination already exists: ' + destination)
  await rename(source, destination)
  await syncDirectory(dirname(destination))
}

async function invalidateProjectionCache(ctx, sessionId) {
  const domain = ctx.storageDomain.get('session_projcache')
  if (domain === undefined) throw new RepairError('CACHE_INVALIDATION_FAILED', 'session projection cache domain is unavailable')
  await domain.table('sessions').delete(sessionId)
}

async function verifyHistory(ctx, sessionId) {
  const response = await ctx.apiProxy.sessions.history({ rpcId: RpcId(randomUUID()), payload: { sessionId, maxMessages: 1 } })
  if (!response.result.ok) throw new RepairError('HISTORY_VERIFICATION_FAILED', 'session.history verification failed: ' + response.result.error.message)
}

async function restoreAfterFailure(ctx, sessionId, target, backup, published) {
  const failed = target + '.failed-' + randomUUID()
  if (published && await pathExists(target)) {
    try { await durableMove(target, failed) } catch { await rm(target, { force: true }) }
  }
  await durableMove(backup, target)
  await rm(failed, { force: true })
  await invalidateProjectionCache(ctx, sessionId)
}

async function applyRepair(ctx, payload, signal) {
  const { sessionId, expectedRevision } = parsePayload(payload, true)
  return withLock(sessionId, async () => {
    assertInactive(ctx, sessionId)
    const artifact = await readArtifact(ctx, sessionId, expectedRevision, signal)
    const backupPath = backupPathFor(artifact.path)
    if (await pathExists(backupPath)) throw new RepairError('BACKUP_EXISTS', '不可覆盖的备份文件已存在')
    const plan = planArtifact(artifact)
    if (plan.repairedEvents.length !== decodeSessionLog(artifact.raw.content, decodeStorageRecord).events.length) {
      throw new RepairError('EVENT_LOSS', 'repair plan did not preserve every physical event')
    }
    const encoded = await encodeArtifact(plan.headerLine, plan.repairedEvents, artifact.compression)
    const temporary = artifact.path + '.repair-' + randomUUID() + '.tmp'
    await writeDurable(temporary, encoded)
    let backupMoved = false
    let published = false
    try {
      signal?.throwIfAborted()
      assertInactive(ctx, sessionId)
      const currentRevision = await artifact.persistence.readStoredRevision(sessionId, signal)
      if (currentRevision !== expectedRevision) throw new RepairError('REVISION_CHANGED', '会话文件在发布前发生变化；修复已中止')
      await durableMove(artifact.path, backupPath)
      backupMoved = true
      await durableMove(temporary, artifact.path)
      published = true
      const verified = await readArtifact(ctx, sessionId, undefined, signal)
      const decoded = decodeSessionLog(verified.raw.content, decodeStorageRecord)
      if (decoded.events.length !== plan.repairedEvents.length || decoded.events.some((event, index) => event.seq !== index)) {
        throw new RepairError('VERIFY_FAILED', 'repaired artifact failed sequence verification')
      }
      const replay = validateReplay(verified.raw.meta, decoded.events)
      await invalidateProjectionCache(ctx, sessionId)
      await verifyHistory(ctx, sessionId)
      return {
        sessionId,
        previousRevision: expectedRevision,
        newRevision: verified.revision,
        backupPath,
        eventCount: decoded.events.length,
        lastSeq: decoded.events.length - 1,
        derivedMessageCount: replay.derivedMessageCount,
      }
    } catch (error) {
      if (backupMoved) {
        try { await restoreAfterFailure(ctx, sessionId, artifact.path, backupPath, published) } catch (rollbackError) {
          throw new RepairError('ROLLBACK_FAILED', 'repair failed and automatic rollback also failed', { cause: new AggregateError([error, rollbackError]) })
        }
      }
      throw error
    } finally {
      await rm(temporary, { force: true })
    }
  })
}

async function readBackup(path, compression, sessionId, signal) {
  const contents = await readFile(path, { signal })
  const plaintext = await decodePhysical(contents, compression)
  const decoded = decodeSessionLog(plaintext, decodeStorageRecord)
  if (decoded.header.id !== sessionId) throw new RepairError('BACKUP_MISMATCH', 'backup belongs to a different session')
  return plaintext
}

async function rollbackRepair(ctx, payload, signal) {
  const { sessionId, expectedRevision } = parsePayload(payload, true)
  return withLock(sessionId, async () => {
    assertInactive(ctx, sessionId)
    const current = await readArtifact(ctx, sessionId, expectedRevision, signal)
    const currentDecoded = decodeSessionLog(current.raw.content, decodeStorageRecord)
    validateReplay(current.raw.meta, currentDecoded.events)
    const backupPath = backupPathFor(current.path)
    const repairedBackupPath = repairedBackupPathFor(current.path)
    if (!await pathExists(backupPath)) throw new RepairError('BACKUP_NOT_FOUND', '找不到原始会话备份')
    if (await pathExists(repairedBackupPath)) throw new RepairError('BACKUP_EXISTS', '回滚目标备份已存在，拒绝覆盖')
    const backupPlaintext = await readBackup(backupPath, current.compression, sessionId, signal)
    assertInactive(ctx, sessionId)
    if (await current.persistence.readStoredRevision(sessionId, signal) !== expectedRevision) {
      throw new RepairError('REVISION_CHANGED', '会话文件在回滚前发生变化；回滚已中止')
    }
    await durableMove(current.path, repairedBackupPath)
    try {
      await durableMove(backupPath, current.path)
    } catch (error) {
      await durableMove(repairedBackupPath, current.path)
      throw error
    }
    const restored = await readArtifact(ctx, sessionId, undefined, signal)
    if (restored.raw.content !== backupPlaintext) throw new RepairError('VERIFY_FAILED', 'restored backup content did not round-trip')
    await invalidateProjectionCache(ctx, sessionId)
    return { sessionId, previousRevision: expectedRevision, newRevision: restored.revision, backupPath: repairedBackupPath }
  })
}

async function withLock(sessionId, operation) {
  if (locks.has(sessionId)) throw new RepairError('REPAIR_BUSY', '该会话已有诊断或修复操作正在进行')
  locks.add(sessionId)
  try { return await operation() } finally { locks.delete(sessionId) }
}

export function requestDesktopOpen(path, signal, ipc = process) {
  if (typeof path !== 'string' || path.length === 0) return Promise.reject(new RepairError('SETTINGS_PATH_UNAVAILABLE', 'settings provider returned no document path'))
  if (ipc.connected !== true || typeof ipc.send !== 'function') return Promise.reject(new RepairError('DESKTOP_IPC_UNAVAILABLE', 'desktop settings opener is unavailable'))
  const requestId = randomUUID()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = operation => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      ipc.removeListener('message', onMessage)
      operation()
    }
    const onAbort = () => { finish(() => { reject(signal.reason ?? new RepairError('CANCELLED', 'settings document open was cancelled')) }) }
    const onMessage = message => {
      if (!isRecord(message) || message.type !== 'dsh/desktop-open-settings-result' || message.requestId !== requestId) return
      if (message.ok === true) finish(resolve)
      else finish(() => { reject(new RepairError('DESKTOP_OPEN_FAILED', typeof message.error === 'string' ? message.error : 'desktop failed to open settings document')) })
    }
    const timeout = setTimeout(() => { finish(() => { reject(new RepairError('DESKTOP_IPC_TIMEOUT', 'desktop settings opener did not respond')) }) }, 30_000)
    timeout.unref?.()
    ipc.on('message', onMessage)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted === true) { onAbort(); return }
    ipc.send({ type: 'dsh/desktop-open-settings', requestId, path }, error => {
      if (error !== null && error !== undefined) finish(() => { reject(error) })
    })
  })
}

export async function openSettingsDocument(ctx, payload, signal, openDocument = requestDesktopOpen) {
  if (!isRecord(payload) || Object.keys(payload).length !== 0) throw new RepairError('BAD_REQUEST', 'settings.openDocument does not accept a path or other fields')
  const path = await ctx.settings.prepareDocument()
  await openDocument(path, signal)
  return { opened: true }
}

function rpcFailure(error) {
  const message = error instanceof Error ? error.message : String(error)
  return { ok: false, error: { code: 'internal', message, details: {} } }
}

function requestTrusted(ctx, req) {
  const remote = req.socket.remoteAddress
  if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') return false
  const authority = '127.0.0.1:' + String(ctx.webServer.port)
  if (req.headers.host !== authority) return false
  const origin = req.headers.origin
  return origin === undefined || origin === 'http://' + authority
}

async function readJsonBody(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new RepairError('BAD_REQUEST', 'request body is too large')
    chunks.push(buffer)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch (error) {
    throw new RepairError('BAD_REQUEST', 'request body is not valid JSON', { cause: error })
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
  res.end(body)
}

function routeHandler(ctx, expectedMethod) {
  return async (req, res) => {
    if (!requestTrusted(ctx, req)) { res.writeHead(403); res.end('forbidden'); return }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
    if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') { res.writeHead(415); res.end(); return }
    let request
    try { request = await readJsonBody(req) } catch (error) { sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) }); return }
    if (!isRecord(request) || request.type !== 'client-request' || typeof request.rpcId !== 'string' || request.method !== expectedMethod) {
      sendJson(res, 400, { error: 'invalid RPC envelope' })
      return
    }
    const operation = ENDPOINTS.get(expectedMethod)
    const abortController = new AbortController()
    const abort = () => { abortController.abort(new RepairError('CANCELLED', 'session repair request was cancelled')) }
    req.once('aborted', abort)
    let result
    try {
      if (operation === 'settings') result = { ok: true, value: await openSettingsDocument(ctx, request.payload, abortController.signal) }
      else if (operation === 'inspect') result = { ok: true, value: await inspectSession(ctx, request.payload, abortController.signal) }
      else if (operation === 'apply') result = { ok: true, value: await applyRepair(ctx, request.payload, abortController.signal) }
      else result = { ok: true, value: await rollbackRepair(ctx, request.payload, abortController.signal) }
    } catch (error) {
      result = rpcFailure(error)
    } finally {
      req.removeListener('aborted', abort)
    }
    sendJson(res, 200, { type: 'server-response', rpcId: request.rpcId, result })
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const disposers = [...ENDPOINTS.keys()].map(method => ctx.webServer.register({
      kind: 'exact',
      path: '/api/' + method,
      handler: routeHandler(ctx, method),
    }))
    return () => { for (const dispose of disposers) dispose() }
  }, 'desktop session repair Host API')
}
