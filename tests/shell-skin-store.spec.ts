import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { create as createTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveClientEntry, resolveClientPackage } from '../src/shell-skin-store.ts'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('shell skin client entry resolution', () => {
  it('finds the nested legacy plugin client bundle', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-'))
    temporaryDirectories.push(source)
    const clientPath = join(source, 'lib', 'plugin', 'dist', 'client.js')
    await mkdir(join(source, 'lib', 'plugin', 'dist'), { recursive: true })
    await writeFile(clientPath, 'window.__ModuleLoader__.load({})')

    await expect(resolveClientEntry({ dsh: { client: { platform: 'web' } } }, source))
      .resolves.toBe('./lib/plugin/dist/client.js')
  })

  it('resolves array and node conditions in client exports', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-'))
    temporaryDirectories.push(source)
    await writeFile(join(source, 'client.js'), 'window.__ModuleLoader__.load({})')

    await expect(resolveClientEntry({
      exports: { './client': [null, { node: './client.js' }] },
      dsh: { client: { platform: 'web' } },
    }, source)).resolves.toBe('./client.js')
  })

  it('accepts a UTF-8 BOM in the package manifest', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-'))
    temporaryDirectories.push(source)
    await mkdir(join(source, 'lib'), { recursive: true })
    await writeFile(join(source, 'package.json'), '\uFEFF' + JSON.stringify({
      name: '@example/dsh-beautify',
      version: '0.3.0',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }))
    await writeFile(join(source, 'lib', 'client.js'), 'window.__ModuleLoader__.load({})')
    const fetcher = vi.fn()

    await expect(resolveClientPackage({
      package: '@example/dsh-beautify',
      install: { version: '0.3.0', commit: '0123456789abcdef0123456789abcdef01234567' },
    }, source, undefined, fetcher as typeof fetch)).resolves.toBe('./lib/client.js')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses the exact npm build artifact when the pinned source omits its client bundle', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-source-'))
    const packing = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-pack-'))
    temporaryDirectories.push(source, packing)
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'dsh-theme-test',
      version: '1.2.3',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }))
    const packageRoot = join(packing, 'package')
    await mkdir(join(packageRoot, 'lib'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: 'dsh-theme-test',
      version: '1.2.3',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }))
    await writeFile(join(packageRoot, 'lib', 'client.js'), 'window.__ModuleLoader__.load({})')
    const archive = join(packing, 'package.tgz')
    await createTar({ gzip: true, file: archive, cwd: packing }, ['package'])
    const body = await readFile(archive)
    const tarball = 'https://registry.npmjs.org/dsh-theme-test/-/dsh-theme-test-1.2.3.tgz'
    const commit = '0123456789abcdef0123456789abcdef01234567'
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url === tarball) return new Response(body, { status: 200 })
      return new Response(JSON.stringify({
        name: 'dsh-theme-test',
        version: '1.2.3',
        gitHead: commit,
        dist: { tarball, integrity: 'sha512-' + createHash('sha512').update(body).digest('base64') },
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    }) as typeof fetch

    const output: string[] = []
    await expect(resolveClientPackage({
      package: 'dsh-theme-test',
      install: { version: '1.2.3', commit },
    }, source, message => output.push(message), fetcher)).resolves.toBe('./lib/client.js')
    await expect(readFile(join(source, 'lib', 'client.js'), 'utf8')).resolves.toContain('window.__ModuleLoader__.load')
    expect(output).toContain('固定 commit 源码中没有客户端 bundle，正在读取同 commit 的 npm 构建包')
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('rejects an npm artifact that was not built from the pinned commit', async () => {
    const source = await mkdtemp(join(tmpdir(), 'dsh-shell-skin-source-'))
    temporaryDirectories.push(source)
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'dsh-theme-test',
      version: '1.2.3',
      exports: { './client': './lib/client.js' },
      dsh: { client: { platform: 'web' } },
    }))
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      name: 'dsh-theme-test',
      version: '1.2.3',
      gitHead: 'ffffffffffffffffffffffffffffffffffffffff',
      dist: {
        tarball: 'https://registry.npmjs.org/dsh-theme-test/-/dsh-theme-test-1.2.3.tgz',
        integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch

    await expect(resolveClientPackage({
      package: 'dsh-theme-test',
      install: { version: '1.2.3', commit: '0123456789abcdef0123456789abcdef01234567' },
    }, source, undefined, fetcher)).rejects.toThrow('package/version/commit 不一致')
  })
})
