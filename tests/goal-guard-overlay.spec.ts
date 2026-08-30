import { access, copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse as parseYaml } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareGoalGuardOverlay } from '../src/goal-guard-overlay.ts'
import type { InstalledRuntime } from '../src/runtime-store.ts'

const pluginFile = resolve('resources/goal-no-progress-guard/index.js')
const temporaryDirectories: string[] = []

function runtime(version = '0.1.1-rc.2'): InstalledRuntime {
  return {
    directory: 'C:/runtime',
    manifest: {
      schemaVersion: 1,
      runtimeProtocolVersion: 1,
      runtimeRevision: 2,
      dshVersion: version,
      requiredShellRange: '>=0.1.0 <1.0.0',
      platform: 'win32',
      arch: 'x64',
      source: { repository: 'https://github.com/deepseek-ai/deepseek-harness.git', tag: 'dsh-v0.1.1-rc.2', commit: 'a'.repeat(40) },
      archive: { url: 'https://example.test/runtime.zip', sha256: 'b'.repeat(64), size: 1 },
      paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/bin.js' },
    },
    nodeExecutable: 'C:/runtime/node/node.exe',
    pnpmExecutable: 'C:/runtime/tools/pnpm.exe',
    dshBin: 'C:/runtime/app/bin.js',
  }
}

async function fixture(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-shell-goal-overlay-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async directory => { await rm(directory, { recursive: true, force: true }) }))
})

describe('prepareGoalGuardOverlay', () => {
  it.each(['0.1.0-rc.8', '0.1.1-rc.1', '0.1.1', '0.1.2-rc.1'])(
    'skips unsupported DSH version %s without reading or creating resources',
    async version => {
      const directory = join(await fixture(), 'overlays')
      await expect(prepareGoalGuardOverlay({
        runtime: runtime(version),
        pluginFile: join(directory, 'missing.js'),
        directory,
      })).resolves.toBeUndefined()
      await expect(access(directory)).rejects.toThrow()
    },
  )

  it('rejects modified and non-file Guard resources', async () => {
    const root = await fixture()
    const modified = join(root, 'modified.js')
    await copyFile(pluginFile, modified)
    await writeFile(modified, '\n// modified\n', { encoding: 'utf8', flag: 'a' })
    await expect(prepareGoalGuardOverlay({ runtime: runtime(), pluginFile: modified, directory: join(root, 'overlay-a') }))
      .rejects.toThrow('integrity')

    const directoryResource = join(root, 'directory-resource')
    await mkdir(directoryResource)
    await expect(prepareGoalGuardOverlay({ runtime: runtime(), pluginFile: directoryResource, directory: join(root, 'overlay-b') }))
      .rejects.toThrow('regular file')
  })

  it('atomically writes an ordered disable-then-insert overlay and cleans stale files', async () => {
    const root = await fixture()
    const directory = join(root, 'overlays')
    await mkdir(directory)
    await writeFile(join(directory, 'goal-guard-overlay-stale.yml'), 'stale')
    await writeFile(join(directory, 'unrelated.yml'), 'keep')

    const overlay = await prepareGoalGuardOverlay({ runtime: runtime(), pluginFile, directory })
    expect(overlay).toBeDefined()
    const document = parseYaml(await readFile(overlay!.path, 'utf8'))
    expect(document).toEqual([
      { id: 'desktop-goal-no-progress-guard', disabled: true },
      { insert: [{ id: 'shell-goal-no-progress-guard', name: pathToFileURL(pluginFile).href }] },
    ])
    const names = await readdir(directory)
    expect(names).toContain('unrelated.yml')
    expect(names).not.toContain('goal-guard-overlay-stale.yml')
    expect(names.filter(name => name.endsWith('.tmp'))).toEqual([])

    await overlay!.dispose()
    await overlay!.dispose()
    await expect(access(overlay!.path)).rejects.toThrow()
    await expect(access(join(directory, 'unrelated.yml'))).resolves.toBeUndefined()
  })

  it('publishes unique overlays for concurrent preparations', async () => {
    const directory = join(await fixture(), 'overlays')
    const [first, second] = await Promise.all([
      prepareGoalGuardOverlay({ runtime: runtime(), pluginFile, directory }),
      prepareGoalGuardOverlay({ runtime: runtime(), pluginFile, directory }),
    ])
    expect(first?.path).toBeDefined()
    expect(second?.path).toBeDefined()
    expect(first?.path).not.toBe(second?.path)
    await expect(access(first!.path)).resolves.toBeUndefined()
    await expect(access(second!.path)).resolves.toBeUndefined()
    await Promise.all([first!.dispose(), second!.dispose()])
  })
})
