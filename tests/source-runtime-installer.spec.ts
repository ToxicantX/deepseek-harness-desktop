import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeManifest } from '../src/catalog.ts'
import { installRuntimeFromSource, type RunCommand, type SourceInstallStage } from '../src/source-runtime-installer.ts'
import { RuntimeStore } from '../src/runtime-store.ts'

const roots: string[] = []

function manifest(): RuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    dshVersion: '0.1.1-rc.2',
    runtimeRevision: 1,
    requiredShellRange: '>=0.1.0 <1.0.0',
    platform: 'win32',
    arch: 'x64',
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      tag: 'dsh-v0.1.1-rc.2',
      commit: 'a'.repeat(40),
    },
    archive: {
      url: 'https://example.test/missing-runtime.zip',
      sha256: 'b'.repeat(64),
      size: 100,
    },
    paths: {
      node: 'node/node.exe',
      pnpm: 'tools/node_modules/@pnpm/exe/pnpm.exe',
      dsh: 'app/node_modules/@deepseek-ai/dsh/lib/bin.js',
    },
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-source-installer-'))
  roots.push(root)
  return root
}

async function createResources(root: string): Promise<string> {
  const resources = join(root, 'resources')
  await Promise.all([
    mkdir(join(resources, 'session-repair-plugin'), { recursive: true }),
    mkdir(join(resources, 'pet-bridge-plugin'), { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(resources, 'session-repair-plugin', 'index.js'), 'export default {}\n'),
    writeFile(join(resources, 'pet-bridge-plugin', 'client.js'), 'export default {}\n'),
    writeFile(join(resources, 'desktop.patch.yml'), '[]\n'),
  ])
  return resources
}

afterEach(async () => {
  vi.unstubAllGlobals()
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('source runtime installer', () => {
  it('clones the selected tag, builds it, and assembles the runtime manifest paths', async () => {
    const root = await temporaryRoot()
    const destination = join(root, 'runtime')
    const workDirectory = join(root, 'work')
    const resourcesDirectory = await createResources(root)
    const tools = join(root, 'tools')
    await mkdir(tools)
    const executables = {
      git: join(tools, 'git.exe'),
      node: join(tools, 'node.exe'),
      pnpm: join(tools, 'pnpm.exe'),
    }
    await Promise.all(Object.values(executables).map(file => writeFile(file, file)))
    const commands: Array<{ command: string; args: readonly string[]; cwd?: string }> = []
    const run: RunCommand = async (command, args, cwd) => {
      commands.push({ command, args, ...(cwd === undefined ? {} : { cwd }) })
      if (args[0] === 'clone') {
        const source = String(args.at(-1))
        await mkdir(join(source, 'apps', 'cli'), { recursive: true })
        await writeFile(join(source, 'apps', 'cli', 'package.json'), JSON.stringify({ version: manifest().dshVersion }))
      }
      if (args[0] === 'rev-parse') return { stdout: manifest().source.commit }
      if (args.includes('deploy')) {
        const deployed = String(args.at(-1))
        await mkdir(join(deployed, 'lib'), { recursive: true })
        await writeFile(join(deployed, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', dependencies: {} }))
        await writeFile(join(deployed, 'lib', 'bin.js'), 'export {}\n')
      }
      return { stdout: '' }
    }
    const stages: SourceInstallStage[] = []

    await installRuntimeFromSource({
      manifest: manifest(),
      destination,
      workDirectory,
      resourcesDirectory,
      runCommand: run,
      resolveExecutable: async name => executables[name],
      onProgress: progress => { stages.push(progress.stage) },
    })

    expect(commands[0]).toMatchObject({
      command: executables.git,
      args: ['clone', '--depth', '1', '--branch', manifest().source.tag, '--single-branch', manifest().source.repository, join(workDirectory, 'source')],
    })
    expect(commands.map(command => command.args)).toContainEqual(['install', '--frozen-lockfile'])
    expect(commands.map(command => command.args)).toContainEqual(['run', 'build'])
    expect(commands.map(command => command.args)).toContainEqual([
      '--filter', '@deepseek-ai/dsh', 'deploy', '--legacy', '--prod',
      join(destination, 'app', 'node_modules', '@deepseek-ai', 'dsh'),
    ])
    expect(stages).toEqual(['cloning', 'installing', 'building', 'assembling'])
    await Promise.all([
      access(join(destination, manifest().paths.node)),
      access(join(destination, manifest().paths.pnpm)),
      access(join(destination, manifest().paths.dsh)),
      access(join(destination, 'app', 'desktop.patch.yml')),
    ])
    expect(JSON.parse(await readFile(join(destination, 'runtime-manifest.json'), 'utf8'))).toEqual(manifest())
    const deployedManifest = JSON.parse(await readFile(join(dirname(dirname(join(destination, manifest().paths.dsh))), 'package.json'), 'utf8'))
    expect(deployedManifest.dependencies).toMatchObject({
      '@deepseek-ai/dsh-desktop-session-repair': '0.1.0',
      '@deepseek-ai/dsh-desktop-pet-bridge': '0.1.0',
    })
    await expect(access(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes source work and partial runtime output when a build command fails', async () => {
    const root = await temporaryRoot()
    const destination = join(root, 'runtime')
    const workDirectory = join(root, 'work')
    const resourcesDirectory = await createResources(root)
    const run: RunCommand = async (_command, args) => {
      if (args[0] === 'clone') {
        const source = String(args.at(-1))
        await mkdir(join(source, 'apps', 'cli'), { recursive: true })
        await writeFile(join(source, 'apps', 'cli', 'package.json'), JSON.stringify({ version: manifest().dshVersion }))
      }
      if (args[0] === 'rev-parse') return { stdout: manifest().source.commit }
      if (args[0] === 'run') throw new Error('build failed')
      return { stdout: '' }
    }

    await expect(installRuntimeFromSource({
      manifest: manifest(),
      destination,
      workDirectory,
      resourcesDirectory,
      runCommand: run,
      resolveExecutable: async name => name + '.exe',
    })).rejects.toThrow('build failed')
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(workDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('RuntimeStore source fallback', () => {
  it('uses the source installer only when the prebuilt archive returns 404', async () => {
    const root = await temporaryRoot()
    const selected = manifest()
    const sourceInstaller = vi.fn(async (options: Parameters<typeof installRuntimeFromSource>[0]) => {
      for (const path of Object.values(selected.paths)) {
        const file = join(options.destination, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, path)
      }
      await writeFile(join(options.destination, 'runtime-manifest.json'), JSON.stringify(selected))
      options.onProgress?.({ stage: 'cloning', received: 0, total: 0 })
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 404 })))
    const progress: string[] = []
    const store = new RuntimeStore(root, { sourceResourcesDirectory: join(root, 'resources'), sourceInstaller })

    const installed = await store.install(selected, value => { progress.push(value.stage) })

    expect(sourceInstaller).toHaveBeenCalledOnce()
    expect(progress).toEqual(['cloning'])
    expect(installed.manifest).toEqual(selected)
    await access(installed.dshBin)
    expect((await readdir(store.downloadsDirectory)).filter(name => name.includes('.source-') || name.endsWith('.part'))).toEqual([])
  })

  it('does not build from source for a non-404 download failure', async () => {
    const root = await temporaryRoot()
    const sourceInstaller = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 503 })))
    const store = new RuntimeStore(root, { sourceResourcesDirectory: join(root, 'resources'), sourceInstaller })

    await expect(store.install(manifest())).rejects.toThrow('runtime download failed with HTTP 503')
    expect(sourceInstaller).not.toHaveBeenCalled()
    expect((await readdir(store.runtimesDirectory)).filter(name => name.includes('.staging-'))).toEqual([])
  })
})
