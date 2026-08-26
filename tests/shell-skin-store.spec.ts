import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveClientEntry } from '../src/shell-skin-store.ts'

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
})
