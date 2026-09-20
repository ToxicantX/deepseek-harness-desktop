import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SkillManager } from '../src/skill-manager.ts'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{ dshHome: string; agentsHome: string; codexHome: string; claudeHome: string; geminiHome: string; antigravityHome: string; legacyAntigravityHome: string; external: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-skill-'))
  temporaryDirectories.push(directory)
  return {
    dshHome: join(directory, 'dsh'),
    agentsHome: join(directory, 'agents'),
    codexHome: join(directory, 'codex'),
    claudeHome: join(directory, 'claude'),
    geminiHome: join(directory, 'gemini'),
    antigravityHome: join(directory, 'antigravity'),
    legacyAntigravityHome: join(directory, 'legacy-antigravity'),
    external: join(directory, 'external'),
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('SkillManager', () => {
  it('discovers valid bundles and flat markdown skills with invocation policy', async () => {
    const paths = await fixture()
    await mkdir(join(paths.dshHome, 'skills', 'bundle-skill'), { recursive: true })
    await writeFile(join(paths.dshHome, 'skills', 'bundle-skill', 'SKILL.md'), '---\nname: bundle-skill\ndescription: Bundle\ndisable-model-invocation: true\n---\nbody\n')
    await mkdir(join(paths.agentsHome, 'skills'), { recursive: true })
    await writeFile(join(paths.agentsHome, 'skills', 'flat-skill.md'), '---\nname: flat-skill\ndescription: Flat\nuser-invocable: false\n---\nbody\n')
    await writeFile(join(paths.agentsHome, 'skills', 'invalid.md'), 'not a skill')
    await mkdir(join(paths.geminiHome, 'skills', 'gemini-skill'), { recursive: true })
    await writeFile(join(paths.geminiHome, 'skills', 'gemini-skill', 'SKILL.md'), '---\nname: gemini-skill\ndescription: Gemini\n---\nbody\n')
    await mkdir(join(paths.antigravityHome, 'skills'), { recursive: true })
    await writeFile(join(paths.antigravityHome, 'skills', 'antigravity-skill.md'), '---\nname: antigravity-skill\ndescription: Antigravity\n---\nbody\n')

    const list = await new SkillManager(paths).list()
    expect(list.entries).toMatchObject([
      { name: 'antigravity-skill', source: 'user-antigravity', kind: 'file', managed: false },
      { name: 'bundle-skill', source: 'user-dsh', kind: 'bundle', modelInvocable: false, userInvocable: true },
      { name: 'flat-skill', source: 'user-agents', kind: 'file', modelInvocable: true, userInvocable: false },
      { name: 'gemini-skill', source: 'user-gemini', kind: 'bundle', managed: false },
    ])
    expect(list.entries).toHaveLength(4)
    const gemini = list.entries.find(entry => entry.name === 'gemini-skill')
    if (gemini === undefined) throw new Error('Gemini fixture missing')
    await expect(new SkillManager(paths).remove(gemini.id, list.revision)).rejects.toThrow('外部 Skill')
    const antigravity = list.entries.find(entry => entry.name === 'antigravity-skill')
    if (antigravity === undefined) throw new Error('Antigravity fixture missing')
    await expect(new SkillManager(paths).remove(antigravity.id, list.revision)).rejects.toThrow('外部 Skill')
  })

  it('imports a validated bundle and flat skill into the DSH user root', async () => {
    const paths = await fixture()
    await mkdir(join(paths.external, 'imported'), { recursive: true })
    await writeFile(join(paths.external, 'imported', 'SKILL.md'), '---\nname: imported-skill\ndescription: Imported\n---\nbody\n')
    const manager = new SkillManager(paths)
    const imported = await manager.import(join(paths.external, 'imported'))
    expect(imported.entries[0]).toMatchObject({ name: 'imported-skill', source: 'user-dsh', kind: 'bundle' })
    await expect(manager.import(join(paths.external, 'imported'))).rejects.toThrow('Skill 已存在')
  })

  it('rejects stale and unsafe removals', async () => {
    const paths = await fixture()
    await mkdir(join(paths.dshHome, 'skills'), { recursive: true })
    await writeFile(join(paths.dshHome, 'skills', 'remove-me.md'), '---\nname: remove-me\ndescription: Remove\n---\nbody\n')
    const manager = new SkillManager(paths)
    const list = await manager.list()
    const entry = list.entries[0]
    if (entry === undefined) throw new Error('fixture missing')
    await writeFile(entry.path, '---\nname: remove-me\ndescription: Remove\n---\nchanged body\n')
    await expect(manager.remove(entry.id, list.revision)).rejects.toThrow('列表已变化')
    const fresh = await manager.list()
    await expect(manager.remove(entry.id, fresh.revision)).resolves.toMatchObject({ entries: [] })
  })
})
