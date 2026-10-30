import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gte } from 'semver'
import { stringify } from 'yaml'
import type { InstalledRuntime } from './runtime-store.ts'

export async function prepareCompactionOverlay(options: {
  runtime: InstalledRuntime
  pluginFile: string
  directory: string
}): Promise<{ path: string; dispose(): Promise<void> } | undefined> {
  if (!gte(options.runtime.manifest.dshVersion, '0.2.2-alpha.2')) return undefined
  await mkdir(options.directory, { recursive: true })
  const directory = await mkdtemp(join(options.directory, 'compaction-'))
  const path = join(directory, 'patch.yml')
  const dispose = async (): Promise<void> => { await rm(directory, { recursive: true, force: true }) }
  try {
    await writeFile(path, stringify([{ insert: [{
      id: 'desktop-compaction-reasoning',
      name: pathToFileURL(options.pluginFile).href,
    }] }]), { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    await dispose()
    throw error
  }
  return { path, dispose }
}
