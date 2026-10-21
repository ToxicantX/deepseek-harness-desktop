import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SearchSettings } from '../src/search-settings.ts'

let directory: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'dsh-search-')); vi.stubEnv('EXA_API_KEY', ''); vi.stubEnv('PERPLEXITY_API_KEY', '') })
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }) })
function storage() {
  const key = randomBytes(32)
  return {
    isEncryptionAvailable: () => true,
    encryptString(value: string) {
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
      const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      return Buffer.concat([iv, cipher.getAuthTag(), body])
    },
    decryptString(bytes: Buffer) {
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    },
  }
}
const input = (revision: string) => ({ provider: 'exa', expectedRevision: revision,
  exa: { baseURL: 'https://api.exa.ai', apiKey: 'test-exa-secret', removeKey: false },
  perplexity: { baseURL: 'https://api.perplexity.ai', apiKey: '', removeKey: false } })

describe('encrypted search settings', () => {
  it('encrypts secrets, survives reopening, and never returns saved keys to the renderer', async () => {
    const path = join(directory, 'search.bin'), secrets = storage(), manager = new SearchSettings(path, secrets)
    expect((await manager.read()).provider).toBe('auto')
    const view = await manager.save(input((await manager.read()).revision))
    expect(view.exa.hasKey).toBe(true)
    expect(JSON.stringify(view)).not.toContain('test-exa-secret')
    expect((await readFile(path)).toString('utf8')).not.toContain('test-exa-secret')
    const reopened = new SearchSettings(path, secrets)
    expect(JSON.parse(await reopened.runtimeConfiguration()).exa.apiKey).toBe('test-exa-secret')
    expect(await reopened.read()).toEqual(view)
  })

  it('preserves blank keys, removes only explicitly selected keys, and rejects stale saves', async () => {
    const manager = new SearchSettings(join(directory, 'search.bin'), storage())
    const first = input((await manager.read()).revision)
    const view = await manager.save(first)
    await expect(manager.save(first)).rejects.toThrow('已变化')
    const change = input(view.revision); change.exa.apiKey = ''
    const preserved = await manager.save(change)
    expect(preserved.exa.hasKey).toBe(true)
    change.expectedRevision = preserved.revision; change.provider = 'auto'; change.exa.removeKey = true
    expect((await manager.save(change)).exa.hasKey).toBe(false)
  })

  it('fails closed when system encryption is unavailable or another account cannot decrypt', async () => {
    const path = join(directory, 'search.bin'), secrets = storage(), manager = new SearchSettings(path, secrets)
    const value = input((await manager.read()).revision)
    secrets.isEncryptionAvailable = () => false
    await expect(manager.save(value)).rejects.toThrow('系统密钥加密不可用')
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
    secrets.isEncryptionAvailable = () => true
    await manager.save(value)
    await expect(new SearchSettings(path, storage()).read()).rejects.toThrow('无法解密')
  })

  it.each(['http://api.exa.ai', 'https://user:password@api.exa.ai', 'https://api.exa.ai?key=value', 'https://api.exa.ai/#secret', 'file:///tmp/search'])('rejects unsafe endpoint %s without writing or echoing credentials', async baseURL => {
    const manager = new SearchSettings(join(directory, 'search.bin'), storage())
    const value = input((await manager.read()).revision); value.exa.baseURL = baseURL
    await expect(manager.save(value)).rejects.toThrow('搜索接口必须')
    expect((await manager.read()).exa.hasKey).toBe(false)
  })

  it('validates keys, selected providers, and input shapes', async () => {
    const manager = new SearchSettings(join(directory, 'search.bin'), storage())
    const value = input((await manager.read()).revision)
    for (const invalid of [null, [], { ...value, extra: 1 }, { ...value, provider: 'unknown' }, { ...value, exa: { ...value.exa, apiKey: 'key\r\nheader' } }]) {
      await expect(manager.save(invalid)).rejects.toThrow()
    }
    value.exa.apiKey = ''
    await expect(manager.save(value)).rejects.toThrow('API Key')
  })
})
