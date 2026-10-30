import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { expect, it } from 'vitest'
import { prepareCompactionOverlay } from '../src/compaction-overlay.ts'
import type { InstalledRuntime } from '../src/runtime-store.ts'

it('loads the Shell plugin from an external overlay and removes only its own temporary directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-compaction-overlay-test-'))
  const pluginFile = resolve('resources/compaction-reasoning/index.mjs')
  const runtime = (dshVersion: string) => ({ manifest: { dshVersion } }) as InstalledRuntime
  try {
    expect(await prepareCompactionOverlay({ directory, pluginFile, runtime: runtime('0.2.1-rc.3') })).toBeUndefined()
    expect(await readdir(directory)).toEqual([])
    const options = { directory, pluginFile, runtime: runtime('0.2.2-alpha.2') }
    const first = await prepareCompactionOverlay(options)
    const second = await prepareCompactionOverlay(options)
    expect(first!.path).not.toBe(second!.path)
    expect(parse(await readFile(first!.path, 'utf8'))).toEqual([{ insert: [{
      id: 'desktop-compaction-reasoning', name: pathToFileURL(pluginFile).href,
    }] }])
    await first!.dispose()
    await first!.dispose()
    expect(await readFile(second!.path, 'utf8')).toContain('desktop-compaction-reasoning')
    await second!.dispose()
    expect(await readdir(directory)).toEqual([])
  } finally { await rm(directory, { recursive: true, force: true }) }
})
