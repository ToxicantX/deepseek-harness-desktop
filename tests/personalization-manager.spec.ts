import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PERSONALIZATION_MAX_BYTES, PersonalizationManager } from '../src/personalization-manager.ts'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ home: string; manager: PersonalizationManager }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-desktop-personalization-'))
  temporaryDirectories.push(home)
  return { home, manager: new PersonalizationManager({ home }) }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('PersonalizationManager', () => {
  it('reads a deterministic missing document and atomically creates UTF-8 Markdown', async () => {
    const { home, manager } = await fixture()
    const missing = await manager.read()
    expect(missing).toEqual({
      path: join(home, 'AGENTS.md'),
      content: '',
      exists: false,
      revision: missing.revision,
      maxBytes: PERSONALIZATION_MAX_BYTES,
    })
    expect(missing.revision).toMatch(/^[a-f0-9]{64}$/u)
    expect((await manager.read()).revision).toBe(missing.revision)

    const content = '# 全局偏好\n\n- 默认使用中文。\n'
    const saved = await manager.save({ content, expectedRevision: missing.revision })
    expect(saved).toMatchObject({ content, exists: true, path: join(home, 'AGENTS.md') })
    expect(saved.revision).not.toBe(missing.revision)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe(content)

    const updated = await manager.save({ content: '# 已更新\n', expectedRevision: saved.revision })
    expect(updated).toMatchObject({ content: '# 已更新\n', exists: true })
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('# 已更新\n')
    expect((await readdir(home)).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('rejects stale writes and serializes concurrent saves from the same revision', async () => {
    const { home, manager } = await fixture()
    const initial = await manager.read()
    await writeFile(join(home, 'AGENTS.md'), '# external\n')
    await expect(manager.save({ content: '# stale\n', expectedRevision: initial.revision })).rejects.toThrow('其他程序修改')
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('# external\n')

    const current = await manager.read()
    const results = await Promise.allSettled([
      manager.save({ content: '# first\n', expectedRevision: current.revision }),
      manager.save({ content: '# second\n', expectedRevision: current.revision }),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(await readFile(join(home, 'AGENTS.md'), 'utf8')).toBe('# first\n')
  })

  it('removes the document for whitespace-only content without touching siblings', async () => {
    const { home, manager } = await fixture()
    await writeFile(join(home, 'AGENTS.md'), '# preferences\n')
    await writeFile(join(home, 'settings.yaml'), 'language: zh-CN\n')
    const current = await manager.read()
    const removed = await manager.save({ content: '  \n\t', expectedRevision: current.revision })
    expect(removed).toMatchObject({ content: '', exists: false })
    expect(await readFile(join(home, 'settings.yaml'), 'utf8')).toBe('language: zh-CN\n')
    const idempotent = await manager.save({ content: '', expectedRevision: removed.revision })
    expect(idempotent).toMatchObject({ content: '', exists: false, revision: removed.revision })
  })

  it('validates the exact IPC shape, revision, NULs, and UTF-8 byte limit', async () => {
    const { manager } = await fixture()
    const revision = (await manager.read()).revision
    for (const input of [
      null,
      [],
      {},
      { content: 'ok', expectedRevision: revision, extra: true },
      { content: 1, expectedRevision: revision },
      { content: 'ok', expectedRevision: 1 },
    ]) await expect(manager.save(input)).rejects.toThrow('参数无效')
    await expect(manager.save({ content: 'ok', expectedRevision: 'bad' })).rejects.toThrow('revision 无效')
    await expect(manager.save({ content: 'before\0after', expectedRevision: revision })).rejects.toThrow('NUL')
    await expect(manager.save({
      content: 'a'.repeat(PERSONALIZATION_MAX_BYTES + 1),
      expectedRevision: revision,
    })).rejects.toThrow('不能超过')
    await expect(manager.save({
      content: '中'.repeat(Math.floor(PERSONALIZATION_MAX_BYTES / 3) + 1),
      expectedRevision: revision,
    })).rejects.toThrow('不能超过')
  })

  it('refuses to expose a non-UTF-8 personalization document', async () => {
    const { home, manager } = await fixture()
    await writeFile(join(home, 'AGENTS.md'), Buffer.from([0xff, 0xfe, 0xfd]))
    await expect(manager.read()).rejects.toThrow('不是有效的 UTF-8')
  })
})
