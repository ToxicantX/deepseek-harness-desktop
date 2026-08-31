import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { stringify } from 'yaml'
import type { InstalledRuntime } from './runtime-store.ts'

const SUPPORTED_DSH_VERSION = '0.1.1-rc.2'
const PLUGIN_SHA256 = '8b5953001725a2828f51299652324b3a6acac0c7e1d78ef88dec8a655e052ef0'
const MAX_PLUGIN_BYTES = 256 * 1024
const OVERLAY_PREFIX = 'goal-guard-overlay-'
const cleanupRuns = new Map<string, Promise<void>>()

export interface GoalGuardOverlay {
  path: string
  dispose(): Promise<void>
}

async function verifyPlugin(file: string): Promise<void> {
  const linkInfo = await lstat(file)
  if (!linkInfo.isFile()) throw new Error('Shell Goal guard resource is not a regular file')
  const handle = await open(file, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Shell Goal guard resource is not a regular file')
    if (info.size <= 0 || info.size > MAX_PLUGIN_BYTES) throw new Error('Shell Goal guard resource size is invalid')
    const content = await handle.readFile()
    const digest = createHash('sha256').update(content).digest('hex')
    if (digest !== PLUGIN_SHA256) throw new Error('Shell Goal guard resource failed integrity verification')
  } finally {
    await handle.close()
  }
}

async function cleanupStale(directory: string): Promise<void> {
  const key = resolve(directory).toLowerCase()
  const existing = cleanupRuns.get(key)
  if (existing !== undefined) return existing
  const run = (async () => {
    const entries = await readdir(directory, { withFileTypes: true })
    await Promise.all(entries
      .filter(entry => entry.isFile() && entry.name.startsWith(OVERLAY_PREFIX))
      .map(async entry => { await rm(join(directory, entry.name), { force: true }) }))
  })()
  cleanupRuns.set(key, run)
  try {
    await run
  } finally {
    if (cleanupRuns.get(key) === run) cleanupRuns.delete(key)
  }
}

export async function prepareGoalGuardOverlay(options: {
  runtime: InstalledRuntime
  pluginFile: string
  directory: string
}): Promise<GoalGuardOverlay | undefined> {
  if (options.runtime.manifest.dshVersion !== SUPPORTED_DSH_VERSION) return undefined

  await verifyPlugin(options.pluginFile)
  await mkdir(options.directory, { recursive: true })
  await cleanupStale(options.directory)

  const id = randomUUID()
  const temporary = join(options.directory, OVERLAY_PREFIX + id + '.tmp')
  const published = join(options.directory, OVERLAY_PREFIX + id + '.yml')
  const overlay = stringify([
    { id: 'desktop-goal-no-progress-guard', disabled: true },
    {
      insert: [{
        id: 'shell-goal-no-progress-guard',
        name: pathToFileURL(options.pluginFile).href,
      }],
    },
  ])

  let handle
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(overlay, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, published)
  } catch (error) {
    await handle?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
    await rm(published, { force: true }).catch(() => {})
    throw error
  }

  let disposal: Promise<void> | undefined
  return {
    path: published,
    dispose() {
      disposal ??= Promise.allSettled([
        rm(temporary, { force: true }),
        rm(published, { force: true }),
      ]).then(results => {
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
        if (failures.length > 0) throw new AggregateError(failures, 'Could not remove the Shell Goal guard overlay')
      })
      return disposal
    },
  }
}
