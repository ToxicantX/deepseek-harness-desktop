import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const PERSONALIZATION_MAX_BYTES = 65_536

export interface PersonalizationDocument {
  path: string
  content: string
  exists: boolean
  revision: string
  maxBytes: number
}

export interface PersonalizationManagerOptions {
  home: string
}

interface PersonalizationSaveInput {
  content: string
  expectedRevision: string
}

interface FileState {
  bytes: Buffer
  exists: boolean
}

function revision(state: FileState): string {
  return createHash('sha256')
    .update(state.exists ? 'present\0' : 'missing\0')
    .update(state.bytes)
    .digest('hex')
}

function parseSaveInput(value: unknown): PersonalizationSaveInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('个人化设置保存参数无效')
  }
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort()
  if (keys.length !== 2 || keys[0] !== 'content' || keys[1] !== 'expectedRevision') {
    throw new Error('个人化设置保存参数无效')
  }
  if (typeof input.content !== 'string' || typeof input.expectedRevision !== 'string') {
    throw new Error('个人化设置保存参数无效')
  }
  if (!/^[a-f0-9]{64}$/u.test(input.expectedRevision)) throw new Error('个人化设置 revision 无效')
  if (input.content.includes('\0')) throw new Error('个人化设置不能包含 NUL 字符')
  const bytes = Buffer.byteLength(input.content, 'utf8')
  if (bytes > PERSONALIZATION_MAX_BYTES) {
    throw new Error('个人化设置不能超过 ' + PERSONALIZATION_MAX_BYTES.toLocaleString('zh-CN') + ' B')
  }
  return { content: input.content, expectedRevision: input.expectedRevision }
}

export class PersonalizationManager {
  private readonly path: string
  private mutationQueue: Promise<void> = Promise.resolve()

  constructor(options: PersonalizationManagerOptions) {
    if (options === null || typeof options !== 'object' || typeof options.home !== 'string' || options.home.length === 0) {
      throw new Error('个人化设置目录无效')
    }
    this.path = join(options.home, 'AGENTS.md')
  }

  async read(): Promise<PersonalizationDocument> {
    return this.toDocument(await this.readState())
  }

  save(value: unknown): Promise<PersonalizationDocument> {
    const operation = this.mutationQueue.then(() => this.saveLocked(parseSaveInput(value)))
    this.mutationQueue = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async saveLocked(input: PersonalizationSaveInput): Promise<PersonalizationDocument> {
    const current = await this.readState()
    if (revision(current) !== input.expectedRevision) {
      throw new Error('个人化设置已被其他程序修改，请重新加载后再保存')
    }

    if (input.content.trim().length === 0) {
      const verified = await this.readState()
      if (revision(verified) !== input.expectedRevision) {
        throw new Error('个人化设置已被其他程序修改，请重新加载后再保存')
      }
      await rm(this.path, { force: true })
      return this.read()
    }

    await mkdir(dirname(this.path), { recursive: true })
    const temporary = join(dirname(this.path), '.AGENTS.md.' + randomUUID() + '.tmp')
    try {
      await writeFile(temporary, input.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      const verified = await this.readState()
      if (revision(verified) !== input.expectedRevision) {
        throw new Error('个人化设置已被其他程序修改，请重新加载后再保存')
      }
      await rename(temporary, this.path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return this.read()
  }

  private async readState(): Promise<FileState> {
    try {
      return { bytes: await readFile(this.path), exists: true }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bytes: Buffer.alloc(0), exists: false }
      throw error
    }
  }

  private toDocument(state: FileState): PersonalizationDocument {
    const content = state.bytes.toString('utf8')
    if (!Buffer.from(content, 'utf8').equals(state.bytes)) {
      throw new Error('个人化设置文件不是有效的 UTF-8 文本')
    }
    return {
      path: this.path,
      content,
      exists: state.exists,
      revision: revision(state),
      maxBytes: PERSONALIZATION_MAX_BYTES,
    }
  }
}
