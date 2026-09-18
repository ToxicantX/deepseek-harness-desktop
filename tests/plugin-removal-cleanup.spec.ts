import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupRemovedPluginPresets } from '../src/plugin-removal-cleanup.ts'

const roots: string[] = []

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function fixture(): Promise<{ home: string; target: string; agent: string; preset: string }> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-plugin-cleanup-'))
  roots.push(home)
  const profile = join(home, 'profiles', 'web')
  const target = join(home, '.agent-presets', 'multi-model-orchestrator')
  await mkdir(target, { recursive: true })
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-web', private: true }))
  const agent = '- id: tool-presentation\n'
  const preset = 'name: multi-model\n'
  await writeFile(join(target, 'agent.cordis.yml'), agent)
  await writeFile(join(target, 'preset.yml'), preset)
  await writeFile(join(target, '.dsh-multi-model-orchestrator.json'), JSON.stringify({
    schema: 1,
    managedBy: 'dsh-multi-model-orchestrator',
    files: { 'agent.cordis.yml': sha256(agent), 'preset.yml': sha256(preset) },
  }))
  return { home, target, agent, preset }
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('removed plugin preset cleanup', () => {
  it('moves unchanged managed presets out of the active preset directory', async () => {
    const value = await fixture()
    await expect(cleanupRemovedPluginPresets(value.home)).resolves.toEqual(['multi-model-orchestrator'])
    await expect(access(value.target)).rejects.toMatchObject({ code: 'ENOENT' })
    const backups = (await import('node:fs/promises')).readdir(join(value.home, '.agent-presets'))
    await expect(backups).resolves.toEqual([expect.stringContaining('multi-model-orchestrator.desktop-uninstalled-')])
  })

  it('backs up customized managed presets and leaves installed plugin profiles untouched', async () => {
    const value = await fixture()
    await writeFile(join(value.target, 'agent.cordis.yml'), value.agent + '# customized\n')
    await writeFile(join(value.home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'dsh-multi-model-orchestrator': 'github:ToxicantX/dsh-multi-model-orchestrator' } }))
    await expect(cleanupRemovedPluginPresets(value.home)).resolves.toEqual([])
    await expect(readFile(value.target + '/agent.cordis.yml', 'utf8')).resolves.toContain('customized')
    await writeFile(join(value.home, 'profiles', 'web', 'package.json'), JSON.stringify({ private: true }))
    await expect(cleanupRemovedPluginPresets(value.home)).resolves.toEqual(['multi-model-orchestrator'])
    await expect(access(value.target)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
