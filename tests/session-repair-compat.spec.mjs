import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, openSettingsDocument } from '../runtime/session-repair-plugin/index.js'

const directories = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-repair-compat-'))
  directories.push(directory)
  return directory
}

function host(ctx) {
  const routes = new Map()
  apply({ ...ctx, effect: operation => operation(), webServer: { port: 12345, register: route => { routes.set(route.path, route.handler); return () => {} } } })
  return async (method, payload) => {
    const req = Readable.from([JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload })])
    Object.assign(req, { socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: { host: '127.0.0.1:12345', 'content-type': 'application/json' } })
    let response
    await routes.get('/api/' + method)(req, { writeHead() {}, end(body) { response = JSON.parse(body).result } })
    return response
  }
}

async function legacyFixture() {
  const directory = await temporaryDirectory()
  const path = join(directory, 'session.jsonl')
  const meta = { id: 'test', version: 0, createdAt: 1 }
  const events = [0, 1, 0, 1].map((seq, index) => ({ seq, type: 'session/title', time: index + 1, data: { title: 'title-' + index } }))
  const original = [meta, ...events].map(value => JSON.stringify(value)).join('\n') + '\n'
  await writeFile(path, original)
  const revision = async () => createHash('sha256').update(await readFile(path)).digest('hex')
  const history = vi.fn(async () => ({ result: { ok: true } }))
  const sessions = new Map()
  const request = host({
    sessions,
    sessionPersistence: {
      supportsRawArtifacts: true,
      locate: () => ({ kind: 'jsonl', path }),
      readStoredRevision: revision,
      readRaw: async () => ({ meta, content: await readFile(path, 'utf8') }),
    },
    apiProxy: { sessions: { history } },
    storageDomain: { get: () => ({ table: () => ({ delete: async () => {} }) }) },
  })
  return { path, original, revision, history, sessions, request }
}

describe('session repair runtime compatibility', () => {
  it('loads natively without retired exports or the apiproxy package and refuses all repair writes', async () => {
    const directory = await temporaryDirectory()
    await cp(resolve('runtime/session-repair-plugin'), join(directory, 'plugin'), { recursive: true })
    const dependency = join(directory, 'node_modules/@deepseek-ai/dsh-session')
    await mkdir(dependency, { recursive: true })
    await writeFile(join(dependency, 'package.json'), JSON.stringify({ type: 'module', exports: './index.js' }))
    await writeFile(join(dependency, 'index.js'), 'export class Session {}\n')
    const script = `
      import assert from 'node:assert/strict'
      import { Readable } from 'node:stream'
      import { apply, inject, openSettingsDocument } from ${JSON.stringify(pathToFileURL(join(directory, 'plugin/index.js')).href)}
      assert.deepEqual(inject, ['settings', 'webServer'])
      const routes = new Map()
      const ctx = {
        effect: fn => fn(),
        webServer: { port: 12345, register: route => { routes.set(route.path, route.handler); return () => {} } },
        get sessionPersistence() { throw new Error('must not access new storage') },
        get sessions() { throw new Error('must not access retired services') },
      }
      apply(ctx)
      for (const operation of ['inspect', 'apply', 'rollback']) {
        const method = 'session.repair.' + operation
        const payload = { sessionId: 'test', ...(operation === 'inspect' ? {} : { expectedRevision: 'test' }) }
        const req = Readable.from([JSON.stringify({ type: 'client-request', rpcId: 'test', method, payload })])
        Object.assign(req, { socket: { remoteAddress: '127.0.0.1' }, method: 'POST', headers: { host: '127.0.0.1:12345', 'content-type': 'application/json' } })
        let result
        await routes.get('/api/' + method)(req, { writeHead() {}, end(body) { result = JSON.parse(body).result } })
        assert.equal(result.ok, false)
        assert.equal(result.error.details.repairCode, 'UNSUPPORTED_BACKEND')
      }
      let opened
      const result = await openSettingsDocument({ settings: { prepareDocument: async () => 'settings.yaml' } }, {}, undefined, async path => { opened = path })
      assert.equal(opened, 'settings.yaml')
      assert.equal(result.opened, true)
    `
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script])
  })

  it('preserves legacy repair, backup and manual rollback', async () => {
    expect(inject).toContain('apiProxy')
    const fixture = await legacyFixture()
    const inspected = await fixture.request('session.repair.inspect', { sessionId: 'test' })
    expect(inspected).toMatchObject({ ok: true, value: { repairable: true, eventCount: 4 } })
    const repaired = await fixture.request('session.repair.apply', { sessionId: 'test', expectedRevision: inspected.value.revision })
    expect(repaired).toMatchObject({ ok: true, value: { eventCount: 4, lastSeq: 3 } })
    expect(await readFile(fixture.path + '.bak', 'utf8')).toBe(fixture.original)
    expect(fixture.history).toHaveBeenCalledOnce()
    expect(fixture.history.mock.calls[0][0].rpcId).toMatch(/^[0-9a-f-]{36}$/)
    const rolledBack = await fixture.request('session.repair.rollback', { sessionId: 'test', expectedRevision: repaired.value.newRevision })
    expect(rolledBack.ok).toBe(true)
    expect(await readFile(fixture.path, 'utf8')).toBe(fixture.original)
    expect(await readFile(fixture.path + '.repaired.bak', 'utf8')).not.toBe(fixture.original)
  })

  it('automatically restores the original bytes when history verification fails', async () => {
    const fixture = await legacyFixture()
    fixture.history.mockResolvedValue({ result: { ok: false, error: { message: 'test failure' } } })
    const result = await fixture.request('session.repair.apply', { sessionId: 'test', expectedRevision: await fixture.revision() })
    expect(result.error.details.repairCode).toBe('HISTORY_VERIFICATION_FAILED')
    expect(await readFile(fixture.path, 'utf8')).toBe(fixture.original)
    await expect(readFile(fixture.path + '.bak')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['revision', 'active', 'backup', 'invalid'])('refuses unsafe legacy repair: %s', async reason => {
    const fixture = await legacyFixture()
    let expectedRevision = await fixture.revision()
    let code
    if (reason === 'revision') { expectedRevision = 'stale'; code = 'REVISION_CHANGED' }
    if (reason === 'active') { fixture.sessions.set('test', {}); code = 'ACTIVE_SESSION' }
    if (reason === 'backup') { await writeFile(fixture.path + '.bak', 'existing backup'); code = 'BACKUP_EXISTS' }
    if (reason === 'invalid') { await writeFile(fixture.path, 'invalid\n'); expectedRevision = await fixture.revision() }
    const before = await readFile(fixture.path)
    const result = await fixture.request('session.repair.apply', { sessionId: 'test', expectedRevision })
    expect(result.ok).toBe(false)
    if (code) expect(result.error.details.repairCode).toBe(code)
    expect(await readFile(fixture.path)).toEqual(before)
    if (reason === 'backup') expect(await readFile(fixture.path + '.bak', 'utf8')).toBe('existing backup')
    expect(fixture.history).not.toHaveBeenCalled()
  })

  it('does not accept a caller-supplied settings path', async () => {
    const prepareDocument = vi.fn()
    await expect(openSettingsDocument({ settings: { prepareDocument } }, { path: 'untrusted' })).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(prepareDocument).not.toHaveBeenCalled()
  })
})
