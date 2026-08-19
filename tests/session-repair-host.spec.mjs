import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { constants, zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Session } from '@deepseek-ai/dsh-session'
import { apply as applyPlugin, openSettingsDocument, requestDesktopOpen } from '../runtime/session-repair-plugin/index.js'

const temporaryDirectories = []
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function serializedSession(id, sequences, paddingBytes = 0) {
  const session = Session.create(id)
  for (let index = 0; index < sequences.length; index += 1) session.append('todo/write', { todos: [] })
  const events = session.events.map((event, index) => ({
    ...structuredClone(event),
    seq: sequences[index],
    data: { ...event.data, ...(paddingBytes === 0 ? {} : { padding: 'x'.repeat(paddingBytes) }) },
  }))
  return JSON.stringify(session.header) + '\n' + events.map(event => JSON.stringify(event)).join('\n') + '\n'
}

function zstdFrameRanges(buffer) {
  const ranges = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    expect(buffer.readUInt32LE(offset)).toBe(0xfd2fb528)
    offset += 4
    const descriptor = buffer.readUInt8(offset++)
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const dictionaryFlag = descriptor & 3
    offset += (singleSegment ? 0 : 1) + (dictionaryFlag === 3 ? 4 : dictionaryFlag) + (contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag)
    for (;;) {
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const blockType = (blockHeader >>> 1) & 3
      offset += blockType === 1 ? 1 : blockHeader >>> 3
      if ((blockHeader & 1) !== 0) break
    }
    if ((descriptor & 4) !== 0) offset += 4
    ranges.push({ start, end: offset, checksum: (descriptor & 4) !== 0 })
  }
  return ranges
}

function encodeZstdFrames(content) {
  const split = content.indexOf('\n') + 1
  const options = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }
  return Buffer.concat([zstdCompressSync(Buffer.from(content.slice(0, split)), options), zstdCompressSync(Buffer.from(content.slice(split)), options)])
}

function decodeZstdFrames(buffer) {
  return Buffer.concat(zstdFrameRanges(buffer).map(frame => zstdDecompressSync(buffer.subarray(frame.start, frame.end)))).toString('utf8')
}

async function fileRevision(path) {
  const value = await stat(path, { bigint: true })
  return [value.size, value.mtimeNs, value.ctimeNs].join(':')
}

async function createHarness(sequences = [0, 0, 1], options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-repair-test-'))
  temporaryDirectories.push(directory)
  const sessionId = 'repair-host-' + directory.slice(-8)
  const path = join(directory, options.zstd ? 'session.jsonl.zstd' : 'session.jsonl')
  const original = serializedSession(sessionId, sequences, options.paddingBytes ?? 0)
  await writeFile(path, options.zstd ? encodeZstdFrames(original) : original)
  let revisionReads = 0
  const deleted = vi.fn(async () => {})
  const history = vi.fn(async request => ({ rpcId: request.rpcId, result: { ok: true, value: { events: [], hasMore: false } } }))
  const routes = new Map()
  const persistence = {
    supportsRawArtifacts: true,
    async readStoredRevision() {
      revisionReads += 1
      const revision = await fileRevision(path)
      return options.raceAtRevisionRead === revisionReads ? revision + ':changed' : revision
    },
    async readRaw() {
      const physical = await readFile(path)
      const content = options.zstd ? decodeZstdFrames(physical) : physical.toString('utf8')
      return { meta: JSON.parse(content.slice(0, content.indexOf('\n'))), content }
    },
    locate() { return { kind: 'jsonl', path } },
  }
  const context = {
    apiProxy: { sessions: { history } },
    sessions: { get: () => options.active ? {} : undefined },
    sessionPersistence: persistence,
    settings: { prepareDocument: vi.fn(async () => join(directory, 'settings.yaml')) },
    storageDomain: { get: name => name === 'session_projcache' ? { table: table => {
      expect(table).toBe('sessions')
      return { delete: deleted }
    } } : undefined },
    webServer: {
      port: 54545,
      register(route) { routes.set(route.path, route); return () => routes.delete(route.path) },
    },
    effect(start) { return start() },
  }
  applyPlugin(context)

  async function rpc(method, payload, requestOptions = {}) {
    const rpcId = 'rpc-' + Math.random()
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
    const request = Readable.from([body])
    request.method = 'POST'
    request.headers = { 'content-type': 'application/json', host: requestOptions.host ?? '127.0.0.1:54545', ...(requestOptions.origin === undefined ? {} : { origin: requestOptions.origin }) }
    request.socket = { remoteAddress: requestOptions.remoteAddress ?? '127.0.0.1' }
    const response = {
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers = {}) { this.status = status; this.headers = headers },
      end(chunk = '') { this.body += chunk.toString() },
    }
    await routes.get('/api/' + method).handler(request, response)
    const isJson = typeof response.headers['content-type'] === 'string' && response.headers['content-type'].startsWith('application/json')
    return { ...response, json: response.body === '' || !isJson ? undefined : JSON.parse(response.body) }
  }
  return { context, deleted, directory, history, original, path, persistence, rpc, sessionId }
}

describe('Runtime session repair Host API', () => {
  it('repairs, verifies history, preserves the original backup, and rolls back', async () => {
    const harness = await createHarness()
    const inspection = await harness.rpc('session.repair.inspect', { sessionId: harness.sessionId })
    expect(inspection.status).toBe(200)
    expect(inspection.json.result).toMatchObject({ ok: true, value: { repairable: true, preservesAllEvents: true, strategy: 'renumber-preserve-physical-order' } })
    const expectedRevision = inspection.json.result.value.revision

    const applied = await harness.rpc('session.repair.apply', { sessionId: harness.sessionId, expectedRevision })
    expect(applied.json.result.ok).toBe(true)
    expect(applied.json.result.value).toMatchObject({ eventCount: 3, lastSeq: 2, previousRevision: expectedRevision })
    expect(harness.history).toHaveBeenCalledOnce()
    expect(harness.deleted).toHaveBeenCalledWith(harness.sessionId)
    expect(await readFile(harness.path + '.bak', 'utf8')).toBe(harness.original)
    const repaired = (await readFile(harness.path, 'utf8')).trim().split('\n').slice(1).map(JSON.parse)
    expect(repaired.map(event => event.seq)).toEqual([0, 1, 2])

    const duplicateApply = await harness.rpc('session.repair.apply', { sessionId: harness.sessionId, expectedRevision: applied.json.result.value.newRevision })
    expect(duplicateApply.json.result).toMatchObject({ ok: false, error: { message: expect.stringContaining('备份文件') } })

    const rolledBack = await harness.rpc('session.repair.rollback', { sessionId: harness.sessionId, expectedRevision: applied.json.result.value.newRevision })
    expect(rolledBack.json.result.ok).toBe(true)
    expect(await readFile(harness.path, 'utf8')).toBe(harness.original)
    expect(await readFile(harness.path + '.repaired.bak', 'utf8')).toContain('"seq":2')
  })

  it('round-trips concatenated checksummed Zstandard frames', async () => {
    const harness = await createHarness([0, 0, 1], { zstd: true, paddingBytes: 600_000 })
    const inspection = await harness.rpc('session.repair.inspect', { sessionId: harness.sessionId })
    expect(inspection.json.result.value.repairable).toBe(true)
    const applied = await harness.rpc('session.repair.apply', { sessionId: harness.sessionId, expectedRevision: inspection.json.result.value.revision })
    expect(applied.json.result.ok).toBe(true)
    const physical = await readFile(harness.path)
    const frames = zstdFrameRanges(physical)
    expect(frames.length).toBeGreaterThan(1)
    expect(frames.every(frame => frame.checksum)).toBe(true)
    const repaired = decodeZstdFrames(physical).trim().split('\n').slice(1).map(JSON.parse)
    expect(repaired.map(event => event.seq)).toEqual([0, 1, 2])
    expect(decodeZstdFrames(await readFile(harness.path + '.bak'))).toBe(harness.original)
  })

  it('reports ambiguous logs without offering automatic repair', async () => {
    const harness = await createHarness([0, 4])
    const response = await harness.rpc('session.repair.inspect', { sessionId: harness.sessionId })
    expect(response.json.result).toMatchObject({ ok: true, value: { repairable: false, anomalies: [{ kind: 'ambiguous' }] } })
  })

  it('rejects active sessions before reading or changing their artifact', async () => {
    const harness = await createHarness([0, 0], { active: true })
    const response = await harness.rpc('session.repair.inspect', { sessionId: harness.sessionId })
    expect(response.json.result).toMatchObject({ ok: false, error: { message: expect.stringContaining('活动状态') } })
    expect(await readFile(harness.path, 'utf8')).toBe(harness.original)
  })

  it('aborts a revision race before backup publication', async () => {
    const harness = await createHarness([0, 0, 1], { raceAtRevisionRead: 3 })
    const expectedRevision = await fileRevision(harness.path)
    const response = await harness.rpc('session.repair.apply', { sessionId: harness.sessionId, expectedRevision })
    expect(response.json.result).toMatchObject({ ok: false, error: { message: expect.stringContaining('发布前') } })
    expect(await readFile(harness.path, 'utf8')).toBe(harness.original)
    await expect(stat(harness.path + '.bak')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('enforces loopback Host and Origin checks on exact routes', async () => {
    const harness = await createHarness()
    const payload = { sessionId: harness.sessionId }
    expect((await harness.rpc('session.repair.inspect', payload, { host: 'attacker.test' })).status).toBe(403)
    expect((await harness.rpc('session.repair.inspect', payload, { origin: 'https://attacker.test' })).status).toBe(403)
    expect((await harness.rpc('session.repair.inspect', payload, { remoteAddress: '192.168.1.2' })).status).toBe(403)
  })

  it('prepares the provider-owned settings document without accepting a browser path', async () => {
    const prepareDocument = vi.fn(async () => 'C:\\dsh\\settings.yaml')
    const opener = vi.fn(async () => {})
    await expect(openSettingsDocument({ settings: { prepareDocument } }, {}, new AbortController().signal, opener)).resolves.toEqual({ opened: true })
    expect(prepareDocument).toHaveBeenCalledWith()
    expect(opener).toHaveBeenCalledWith('C:\\dsh\\settings.yaml', expect.any(AbortSignal))
    await expect(openSettingsDocument({ settings: { prepareDocument } }, { path: 'C:\\other.yaml' }, new AbortController().signal, opener)).rejects.toThrow('does not accept a path')

    const harness = await createHarness()
    const response = await harness.rpc('settings.openDocument', { path: 'C:\\other.yaml' })
    expect(response.json.result).toMatchObject({ ok: false, error: { message: expect.stringContaining('does not accept a path') } })
  })

  it('correlates and cleans up a desktop settings IPC request', async () => {
    const ipc = new EventEmitter()
    ipc.connected = true
    let sent
    ipc.send = (message, callback) => {
      sent = message
      callback?.(null)
      queueMicrotask(() => { ipc.emit('message', { type: 'dsh/desktop-open-settings-result', requestId: message.requestId, ok: true }) })
    }
    await expect(requestDesktopOpen('C:\\dsh\\settings.yaml', new AbortController().signal, ipc)).resolves.toBeUndefined()
    expect(sent).toMatchObject({ type: 'dsh/desktop-open-settings', path: 'C:\\dsh\\settings.yaml', requestId: expect.any(String) })
    expect(ipc.listenerCount('message')).toBe(0)
  })
})
