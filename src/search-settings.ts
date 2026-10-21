import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface SearchConfiguration {
  provider: 'auto' | 'runtime' | 'exa' | 'perplexity'
  exa: { baseURL: string; apiKey: string }
  perplexity: { baseURL: string; apiKey: string }
}
export interface SearchSettingsView {
  revision: string
  provider: SearchConfiguration['provider']
  exa: { baseURL: string; hasKey: boolean }
  perplexity: { baseURL: string; hasKey: boolean }
}
interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

function defaults(): SearchConfiguration {
  return { provider: 'auto', exa: { baseURL: 'https://api.exa.ai', apiKey: '' }, perplexity: { baseURL: 'https://api.perplexity.ai', apiKey: '' } }
}
const revision = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

export class SearchSettings {
  private queue: Promise<void> = Promise.resolve()
  constructor(private readonly path: string, private readonly secrets: SecretStorage) {}

  private async readState(): Promise<{ config: SearchConfiguration; revision: string }> {
    let bytes: Buffer
    try { bytes = await readFile(this.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { config: defaults(), revision: revision(Buffer.alloc(0)) }
      throw error
    }
    try {
      if (!this.secrets.isEncryptionAvailable()) throw new Error()
      return { config: JSON.parse(this.secrets.decryptString(bytes)), revision: revision(bytes) }
    } catch { throw new Error('无法解密搜索设置，请使用保存设置的 Windows 账户。') }
  }

  async runtimeConfiguration(): Promise<string> { return JSON.stringify((await this.readState()).config) }

  async read(): Promise<SearchSettingsView> {
    const { config, revision } = await this.readState()
    return { revision, provider: config.provider,
      exa: { baseURL: config.exa.baseURL, hasKey: config.exa.apiKey.length > 0 },
      perplexity: { baseURL: config.perplexity.baseURL, hasKey: config.perplexity.apiKey.length > 0 } }
  }

  save(input: unknown): Promise<SearchSettingsView> {
    const operation = this.queue.then(() => this.saveLocked(input))
    this.queue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async saveLocked(input: unknown): Promise<SearchSettingsView> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('搜索设置参数无效')
    const value = input as Record<string, any>
    if (Object.keys(value).some(key => !['provider', 'exa', 'perplexity', 'expectedRevision'].includes(key))
      || !['auto', 'runtime', 'exa', 'perplexity'].includes(value.provider)) throw new Error('搜索渠道无效')
    const state = await this.readState()
    if (value.expectedRevision !== state.revision) throw new Error('搜索设置已变化，请重新加载后再保存。')
    const config = state.config
    config.provider = value.provider
    for (const id of ['exa', 'perplexity'] as const) {
      const entry = value[id]
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || Object.keys(entry).some(key => !['baseURL', 'apiKey', 'removeKey'].includes(key))
        || typeof entry.baseURL !== 'string' || entry.baseURL.length > 2048
        || typeof entry.apiKey !== 'string' || entry.apiKey.length > 8192 || /[\r\n\0]/u.test(entry.apiKey)
        || typeof entry.removeKey !== 'boolean' || (entry.removeKey && entry.apiKey.trim() !== '')) throw new Error('搜索渠道参数无效')
      let url: URL
      try { url = new URL(entry.baseURL) } catch { throw new Error('搜索接口地址无效') }
      if (url.username || url.password || url.search || url.hash
        || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('搜索接口必须为 HTTPS 地址（本机测试可使用 HTTP），且不能包含凭据或查询参数。')
      config[id] = { baseURL: url.href.replace(/\/+$/, ''), apiKey: entry.removeKey ? '' : entry.apiKey.trim() || config[id].apiKey }
    }
    if (config.provider === 'exa' || config.provider === 'perplexity') {
      if (config[config.provider].apiKey === '' && !process.env[config.provider === 'exa' ? 'EXA_API_KEY' : 'PERPLEXITY_API_KEY']?.trim()) throw new Error('请先填写所选渠道的 API Key。')
    }
    if (!this.secrets.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，搜索设置未保存。')
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = this.path + '.' + randomUUID() + '.tmp'
    try {
      await writeFile(temporary, this.secrets.encryptString(JSON.stringify(config)), { flag: 'wx', mode: 0o600 })
      if ((await this.readState()).revision !== state.revision) throw new Error('搜索设置已变化，请重新加载后再保存。')
      await rename(temporary, this.path)
    } finally { await rm(temporary, { force: true }) }
    return this.read()
  }
}
