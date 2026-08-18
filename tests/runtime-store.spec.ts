import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, lstat, readFile, readlink, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeManifest } from '../src/catalog.ts'
import { RuntimeStore } from '../src/runtime-store.ts'

const temporaryDirectories: string[] = []
const execFileAsync = promisify(execFile)
const require = createRequire(import.meta.url)
const path7za = (require('7zip-bin') as { path7za: string }).path7za

function manifest(version = '0.1.0-rc.7'): RuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    dshVersion: version,
    requiredShellRange: '>=0.1.0 <1.0.0',
    platform: 'win32',
    arch: 'x64',
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      tag: `dsh-v${version}`,
      commit: 'a'.repeat(40),
    },
    archive: {
      url: 'https://github.com/ToxicantX/deepseek-harness-desktop/releases/download/runtime/test.zip',
      sha256: 'b'.repeat(64),
      size: 4,
    },
    paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/lib/bin.js' },
  }
}

async function temporaryStore(): Promise<RuntimeStore> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-desktop-store-'))
  temporaryDirectories.push(directory)
  return new RuntimeStore(directory)
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('RuntimeStore', () => {
  it('persists independent preference and current-version state', async () => {
    const store = await temporaryStore()
    expect(await store.readState()).toEqual({ schemaVersion: 1, preference: { mode: 'latest-compatible' } })
    await store.setPreference({ mode: 'pinned', version: '0.1.0-rc.7' })
    await store.promote('0.1.0-rc.7')
    expect(await store.readState()).toEqual({
      schemaVersion: 1,
      preference: { mode: 'pinned', version: '0.1.0-rc.7' },
      currentVersion: '0.1.0-rc.7',
    })
  })

  it('uses a validated cached catalog after a network failure', async () => {
    const store = await temporaryStore()
    const value = { schemaVersion: 1, generatedAt: '2026-08-18T00:00:00.000Z', releases: [manifest()] }
    const url = `data:application/json,${encodeURIComponent(JSON.stringify(value))}`
    const first = await store.loadCatalog(url)
    expect(first.cached).toBe(false)
    const fallback = await store.loadCatalog('http://127.0.0.1:1/unavailable')
    expect(fallback.cached).toBe(true)
    expect(fallback.catalog.releases[0]?.dshVersion).toBe('0.1.0-rc.7')
  })

  it('resolves only installations with every declared executable', async () => {
    const store = await temporaryStore()
    const value = manifest()
    const root = join(store.runtimesDirectory, value.dshVersion)
    await mkdir(join(root, 'node'), { recursive: true })
    await mkdir(join(root, 'tools'), { recursive: true })
    await mkdir(join(root, 'app', 'lib'), { recursive: true })
    await Promise.all([
      writeFile(join(root, 'node', 'node.exe'), ''),
      writeFile(join(root, 'tools', 'pnpm.exe'), ''),
      writeFile(join(root, 'app', 'lib', 'bin.js'), ''),
      writeFile(join(root, 'runtime-manifest.json'), JSON.stringify(value)),
    ])
    expect((await store.installed(value.dshVersion))?.dshBin).toBe(join(root, 'app', 'lib', 'bin.js'))
    const changed = { ...value, archive: { ...value.archive, sha256: 'c'.repeat(64) } }
    await expect(store.install(changed)).rejects.toThrow('immutable catalog release')
    await rm(join(root, 'node', 'node.exe'))
    expect(await store.installed(value.dshVersion)).toBeUndefined()
  })

  it('materializes archive junctions only after the version reaches its final path', async () => {
    const store = await temporaryStore()
    const fixture = await mkdtemp(join(tmpdir(), 'dsh-desktop-archive-'))
    temporaryDirectories.push(fixture)
    const source = join(fixture, 'source')
    const archive = join(fixture, 'runtime.zip')
    await mkdir(join(source, 'node'), { recursive: true })
    await mkdir(join(source, 'tools', '.pnpm', 'pnpm-package'), { recursive: true })
    await mkdir(join(source, 'app', '.pnpm', 'dsh-package', 'lib'), { recursive: true })
    await Promise.all([
      writeFile(join(source, 'node', 'node.exe'), ''),
      writeFile(join(source, 'tools', '.pnpm', 'pnpm-package', 'pnpm.exe'), ''),
      writeFile(join(source, 'app', '.pnpm', 'dsh-package', 'lib', 'bin.js'), ''),
      writeFile(join(source, 'runtime-links.json'), JSON.stringify({
        schemaVersion: 1,
        links: [
          { path: 'tools/node_modules/@pnpm/exe', target: 'tools/.pnpm/pnpm-package', kind: 'junction' },
          { path: 'app/node_modules/@deepseek-ai/dsh', target: 'app/.pnpm/dsh-package', kind: 'junction' },
        ],
      })),
    ])
    await execFileAsync(path7za, ['a', '-tzip', archive, '*'], { cwd: source })
    const bytes = await readFile(archive)
    const value: RuntimeManifest = {
      ...manifest(),
      archive: {
        url: 'https://example.test/runtime.zip',
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
      paths: {
        node: 'node/node.exe',
        pnpm: 'tools/node_modules/@pnpm/exe/pnpm.exe',
        dsh: 'app/node_modules/@deepseek-ai/dsh/lib/bin.js',
      },
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(bytes, { status: 200 })))
    const installed = await store.install(value)
    const link = join(installed.directory, 'tools', 'node_modules', '@pnpm', 'exe')
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(resolve(join(link, '..'), await readlink(link))).toBe(join(installed.directory, 'tools', '.pnpm', 'pnpm-package'))
    expect(installed.pnpmExecutable).toBe(join(link, 'pnpm.exe'))
  })

  it('rejects a downloaded archive before extraction when its digest differs', async () => {
    const store = await temporaryStore()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })))
    await expect(store.install(manifest())).rejects.toThrow('SHA-256 mismatch')
    expect(await store.installed('0.1.0-rc.7')).toBeUndefined()
  })
})
