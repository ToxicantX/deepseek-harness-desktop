import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { inspectStaleLocalPluginRecovery } from '../src/stale-local-plugin-recovery.ts'

const homes: string[] = []

afterEach(async () => {
  await Promise.all(homes.splice(0).map(async home => rm(home, { recursive: true, force: true })))
})

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-stale-plugin-'))
  homes.push(home)
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  return home
}

function yamlPath(file: string): string {
  return file.replaceAll('\\', '/')
}

function diagnostic(id: string, file: string): string {
  return "Error: failed to import loader entry " + id + " (" + pathToFileURL(file).href + "): Cannot find module '" + file + "' imported from C:/Users/test/.dsh/profiles/web/"
}

function inserted(id: string, file: string): string {
  return "- insert:\n    - id: " + id + "\n      name: '" + pathToFileURL(file).href + "'\n"
}

describe('stale local plugin recovery', () => {
  it('removes exact missing entries from profile and home patches while preserving other YAML', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'deleted-plugin', 'index.js')
    const profile = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const root = join(home, 'cordis.patch.yml')
    await writeFile(profile, '# profile comment\n' + inserted('bad-profile', missing) + "- insert:\n    - id: keep-profile\n      name: '@scope/keep'\n", 'utf8')
    await writeFile(root, '# home comment\n' + inserted('bad-home', missing), 'utf8')

    const repeated = diagnostic('bad-profile', missing) + '\n' + diagnostic('bad-profile', missing)
    const diagnostics = repeated + '\n' + diagnostic('bad-home', missing)
    const plan = await inspectStaleLocalPluginRecovery({ home, diagnostics })

    expect(plan).toMatchObject({ entryIds: ['bad-home', 'bad-profile'], count: 2 })
    expect(JSON.stringify(plan)).not.toContain(home)
    const result = await plan?.apply()
    expect(result).toEqual({ removedEntryIds: ['bad-home', 'bad-profile'], count: 2 })
    expect(await readFile(profile, 'utf8')).toContain('# profile comment')
    expect(await readFile(profile, 'utf8')).toContain('keep-profile')
    expect(await readFile(profile, 'utf8')).not.toContain('bad-profile')
    expect(await readFile(root, 'utf8')).toContain('# home comment')
    expect(await readFile(root, 'utf8')).not.toContain('bad-home')
    expect((await readdir(dirname(profile))).filter(name => name.includes('.desktop-backup-'))).toHaveLength(1)
    expect((await readdir(dirname(root))).filter(name => name.startsWith('cordis.patch.yml.desktop-backup-'))).toHaveLength(1)
    await expect(plan?.apply()).rejects.toThrow('已执行')
  })

  it('supports a missing loader nested inside an inserted group', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'deleted-nested', 'index.js')
    const profile = join(home, 'profiles', 'web', 'cordis.patch.yml')
    await writeFile(profile, [
      '- insert:',
      '    - id: local-group',
      '      name: cordis:group',
      '      config:',
      '        - id: nested-missing',
      "          name: '" + pathToFileURL(missing).href + "'",
      '        - id: nested-keep',
      "          name: '@scope/keep'",
      '',
    ].join('\n'), 'utf8')

    const plan = await inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('nested-missing', missing) })
    expect(plan).toMatchObject({ entryIds: ['nested-missing'], count: 1 })
    await plan?.apply()
    const updated = await readFile(profile, 'utf8')
    expect(updated).not.toContain('nested-missing')
    expect(updated).toContain('nested-keep')
  })

  it('does not offer recovery when the referenced local target still exists', async () => {
    const home = await temporaryHome()
    const present = join(home, 'present-plugin', 'index.js')
    await mkdir(dirname(present), { recursive: true })
    await writeFile(present, 'export default {}\n', 'utf8')
    await writeFile(join(home, 'cordis.patch.yml'), inserted('present', present), 'utf8')

    await expect(inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('present', present) })).resolves.toBeUndefined()
  })

  it.each([
    'foreign startup error',
    "failed to import loader entry missing (https://example.test/plugin.js): Cannot find module 'C:\\missing.js'",
  ])('ignores unrelated diagnostics: %s', async diagnostics => {
    const home = await temporaryHome()
    await writeFile(join(home, 'cordis.patch.yml'), inserted('missing', join(home, 'gone.js')), 'utf8')
    await expect(inspectStaleLocalPluginRecovery({ home, diagnostics })).resolves.toBeUndefined()
  })

  it('requires the diagnostic id and normalized path to match the YAML entry', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'gone.js')
    await writeFile(join(home, 'cordis.patch.yml'), inserted('configured-id', missing), 'utf8')
    await expect(inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('different-id', missing) })).resolves.toBeUndefined()
    const other = join(home, 'other.js')
    await expect(inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('configured-id', other) })).resolves.toBeUndefined()
  })

  it('does not traverse arbitrary config objects that happen to contain id and name', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'gone.js')
    await writeFile(join(home, 'cordis.patch.yml'), [
      '- id: settings-provider',
      '  config:',
      '    providers:',
      '      - id: not-a-loader-entry',
      "        name: '" + yamlPath(missing) + "'",
      '',
    ].join('\n'), 'utf8')
    await expect(inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('not-a-loader-entry', missing) })).resolves.toBeUndefined()
  })

  it('rejects apply when a patch changes after inspection', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'gone.js')
    const file = join(home, 'cordis.patch.yml')
    const original = inserted('missing', missing)
    await writeFile(file, original, 'utf8')
    const plan = await inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('missing', missing) })
    await writeFile(file, original + '# user edit\n', 'utf8')

    await expect(plan?.apply()).rejects.toThrow('配置已更改')
    expect(await readFile(file, 'utf8')).toContain('# user edit')
    expect((await readdir(home)).some(name => name.includes('.desktop-backup-'))).toBe(false)
  })

  it('restores an earlier patch when a later atomic replacement fails', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'gone.js')
    const profile = join(home, 'profiles', 'web', 'cordis.patch.yml')
    const root = join(home, 'cordis.patch.yml')
    const profileOriginal = inserted('profile-missing', missing)
    const rootOriginal = inserted('home-missing', missing)
    await writeFile(profile, profileOriginal, 'utf8')
    await writeFile(root, rootOriginal, 'utf8')
    let replacements = 0
    const plan = await inspectStaleLocalPluginRecovery(
      { home, diagnostics: diagnostic('profile-missing', missing) + '\n' + diagnostic('home-missing', missing) },
      {
        fileSystem: {
          async replace(source, destination) {
            replacements += 1
            if (replacements === 2) throw new Error('simulated replacement failure')
            await rename(source, destination)
          },
          async remove() {
            throw new Error('simulated cleanup failure')
          },
        },
      },
    )

    await expect(plan?.apply()).rejects.toThrow('simulated replacement failure')
    expect(await readFile(profile, 'utf8')).toBe(profileOriginal)
    expect(await readFile(root, 'utf8')).toBe(rootOriginal)
  })

  it('ignores malformed patch YAML without modifying it', async () => {
    const home = await temporaryHome()
    const missing = join(home, 'gone.js')
    const file = join(home, 'cordis.patch.yml')
    const malformed = '- insert: [unterminated\n'
    await writeFile(file, malformed, 'utf8')
    await expect(inspectStaleLocalPluginRecovery({ home, diagnostics: diagnostic('missing', missing) })).resolves.toBeUndefined()
    expect(await readFile(file, 'utf8')).toBe(malformed)
  })
})
