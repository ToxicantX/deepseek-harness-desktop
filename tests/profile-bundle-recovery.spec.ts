import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectProfileBundleRecovery } from '../src/profile-bundle-recovery.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => rm(home, { recursive: true, force: true })))
})

async function fixture(options: { bundle?: boolean; dependency?: boolean } = {}): Promise<{
  home: string
  profileManifest: string
  pluginManifest: string
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-profile-bundle-'))
  homes.push(home)
  const profile = join(home, 'profiles', 'web')
  const plugin = join(profile, 'node_modules', 'dsh-channel-telegram')
  await mkdir(plugin, { recursive: true })
  const profileManifest = join(profile, 'package.json')
  const pluginManifest = join(plugin, 'package.json')
  await writeFile(profileManifest, JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-channel-telegram'] } },
    dependencies: options.dependency === false ? {} : { 'dsh-channel-telegram': 'link:../../../plugin' },
  }, null, 2) + '\n', 'utf8')
  await writeFile(pluginManifest, JSON.stringify({
    name: 'dsh-channel-telegram',
    ...(options.bundle === true ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
  }, null, 2) + '\n', 'utf8')
  return { home, profileManifest, pluginManifest }
}

function diagnostic(packageName = 'dsh-channel-telegram'): string {
  return `Error: dsh: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`
}

describe('profile bundle recovery', () => {
  it('removes only the exact incompatible dependency bundle and creates a backup', async () => {
    const { home, profileManifest } = await fixture()
    const plan = await inspectProfileBundleRecovery({ home, diagnostics: diagnostic() })

    expect(plan).toMatchObject({ packageNames: ['dsh-channel-telegram'], count: 1 })
    expect(JSON.stringify(plan)).not.toContain(home)
    await expect(plan?.apply()).resolves.toEqual({ removedPackageNames: ['dsh-channel-telegram'], count: 1 })

    const updated = JSON.parse(await readFile(profileManifest, 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
      dependencies: Record<string, string>
    }
    expect(updated.dsh.profile.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(updated.dependencies).toHaveProperty('dsh-channel-telegram')
    expect((await readdir(join(home, 'profiles', 'web'))).filter(name => name.includes('.desktop-backup-'))).toHaveLength(1)
    await expect(plan?.apply()).rejects.toThrow('已执行')
  })

  it('does not remove built-in bundles or packages that now declare dsh.bundle', async () => {
    const builtIn = await fixture({ dependency: false })
    await expect(inspectProfileBundleRecovery({ home: builtIn.home, diagnostics: diagnostic() })).resolves.toBeUndefined()

    const repaired = await fixture({ bundle: true })
    await expect(inspectProfileBundleRecovery({ home: repaired.home, diagnostics: diagnostic() })).resolves.toBeUndefined()
  })

  it.each([
    'foreign startup error',
    'dsh: profile bundle "../outside" declares no dsh.bundle in its package.json',
    'dsh: profile bundle "different-package" declares no dsh.bundle in its package.json',
  ])('ignores unrelated or unsafe diagnostics: %s', async diagnostics => {
    const { home } = await fixture()
    await expect(inspectProfileBundleRecovery({ home, diagnostics })).resolves.toBeUndefined()
  })

  it('rejects apply when the profile or plugin manifest changes after inspection', async () => {
    const profileChanged = await fixture()
    const profilePlan = await inspectProfileBundleRecovery({ home: profileChanged.home, diagnostics: diagnostic() })
    await writeFile(profileChanged.profileManifest, '{}\n', 'utf8')
    await expect(profilePlan?.apply()).rejects.toThrow('配置已更改')

    const pluginChanged = await fixture()
    const pluginPlan = await inspectProfileBundleRecovery({ home: pluginChanged.home, diagnostics: diagnostic() })
    await writeFile(pluginChanged.pluginManifest, JSON.stringify({
      name: 'dsh-channel-telegram',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }), 'utf8')
    await expect(pluginPlan?.apply()).rejects.toThrow('插件已更新')
  })
})
