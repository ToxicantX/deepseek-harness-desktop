import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import extract from 'extract-zip'
import {
  DEFAULT_CATALOG_URL,
  parseRuntimeCatalog,
  type RuntimeCatalog,
  type RuntimeManifest,
  type RuntimePreference,
} from './catalog.ts'

const STATE_SCHEMA = 1
const MANIFEST_FILE = 'runtime-manifest.json'

export interface RuntimeState {
  schemaVersion: 1
  preference: RuntimePreference
  currentVersion?: string
}

export interface InstalledRuntime {
  directory: string
  manifest: RuntimeManifest
  nodeExecutable: string
  pnpmExecutable: string
  dshBin: string
}

export interface DownloadProgress {
  received: number
  total: number
}

function stateRecord(value: unknown): RuntimeState {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime state must be an object')
  const input = value as Record<string, unknown>
  if (input.schemaVersion !== STATE_SCHEMA) throw new Error('runtime state has an unsupported schemaVersion')
  const rawPreference = input.preference
  if (rawPreference === null || typeof rawPreference !== 'object' || Array.isArray(rawPreference)) {
    throw new Error('runtime state preference must be an object')
  }
  const preference = rawPreference as Record<string, unknown>
  let parsedPreference: RuntimePreference
  if (preference.mode === 'latest-compatible') parsedPreference = { mode: 'latest-compatible' }
  else if (preference.mode === 'pinned' && typeof preference.version === 'string') {
    parsedPreference = { mode: 'pinned', version: preference.version }
  } else throw new Error('runtime state preference is invalid')
  const currentVersion = input.currentVersion
  if (currentVersion !== undefined && typeof currentVersion !== 'string') {
    throw new Error('runtime state currentVersion must be a string')
  }
  return {
    schemaVersion: STATE_SCHEMA,
    preference: parsedPreference,
    ...(currentVersion === undefined ? {} : { currentVersion }),
  }
}

async function recoverableRead(filename: string): Promise<string | undefined> {
  try {
    return await readFile(filename, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const backup = `${filename}.backup`
  try {
    await rename(backup, filename)
    return await readFile(filename, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function atomicWrite(filename: string, contents: string): Promise<void> {
  await mkdir(dirname(filename), { recursive: true })
  const temporary = `${filename}.${randomUUID()}.tmp`
  const backup = `${filename}.backup`
  await writeFile(temporary, contents, 'utf8')
  await rm(backup, { force: true })
  try {
    await rename(filename, backup)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  try {
    await rename(temporary, filename)
  } catch (error: unknown) {
    try { await rename(backup, filename) } catch (restoreError: unknown) {
      if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError
    }
    throw error
  }
  await rm(backup, { force: true })
}

async function fetchJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': 'deepseek-harness-desktop' },
    redirect: 'follow',
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  return response.json()
}

async function pathExists(filename: string): Promise<boolean> {
  try {
    await access(filename)
    return true
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export class RuntimeStore {
  readonly runtimesDirectory: string
  readonly downloadsDirectory: string
  readonly stateFile: string
  readonly catalogFile: string

  constructor(readonly root: string) {
    this.runtimesDirectory = join(root, 'runtimes')
    this.downloadsDirectory = join(root, 'downloads')
    this.stateFile = join(root, 'state.json')
    this.catalogFile = join(root, 'runtime-catalog.json')
  }

  async readState(): Promise<RuntimeState> {
    const contents = await recoverableRead(this.stateFile)
    if (contents === undefined) return { schemaVersion: STATE_SCHEMA, preference: { mode: 'latest-compatible' } }
    return stateRecord(JSON.parse(contents) as unknown)
  }

  async setPreference(preference: RuntimePreference): Promise<RuntimeState> {
    const state = await this.readState()
    const updated: RuntimeState = { ...state, preference }
    await atomicWrite(this.stateFile, `${JSON.stringify(updated, undefined, 2)}\n`)
    return updated
  }

  async promote(version: string): Promise<RuntimeState> {
    const state = await this.readState()
    const updated: RuntimeState = { ...state, currentVersion: version }
    await atomicWrite(this.stateFile, `${JSON.stringify(updated, undefined, 2)}\n`)
    return updated
  }

  async loadCatalog(url = DEFAULT_CATALOG_URL): Promise<{ catalog: RuntimeCatalog; cached: boolean }> {
    try {
      const catalog = parseRuntimeCatalog(await fetchJson(url, AbortSignal.timeout(10_000)))
      await atomicWrite(this.catalogFile, `${JSON.stringify(catalog, undefined, 2)}\n`)
      return { catalog, cached: false }
    } catch (networkError: unknown) {
      const cached = await recoverableRead(this.catalogFile)
      if (cached === undefined) throw networkError
      return { catalog: parseRuntimeCatalog(JSON.parse(cached) as unknown), cached: true }
    }
  }

  async installed(version: string): Promise<InstalledRuntime | undefined> {
    const directory = join(this.runtimesDirectory, version)
    const contents = await recoverableRead(join(directory, MANIFEST_FILE))
    if (contents === undefined) return undefined
    const catalog = parseRuntimeCatalog({
      schemaVersion: 1,
      generatedAt: new Date(0).toISOString(),
      releases: [JSON.parse(contents) as unknown],
    })
    const manifest = catalog.releases[0]
    if (manifest === undefined || manifest.dshVersion !== version) return undefined
    const installed = this.resolveInstalled(directory, manifest)
    if (!(await pathExists(installed.nodeExecutable)) || !(await pathExists(installed.pnpmExecutable)) || !(await pathExists(installed.dshBin))) {
      return undefined
    }
    return installed
  }

  async install(
    manifest: RuntimeManifest,
    onProgress: (progress: DownloadProgress) => void = () => {},
  ): Promise<InstalledRuntime> {
    const existing = await this.installed(manifest.dshVersion)
    if (existing !== undefined) {
      if (existing.manifest.runtimeRevision === manifest.runtimeRevision && existing.manifest.archive.sha256 === manifest.archive.sha256) return existing
      if (existing.manifest.runtimeRevision === manifest.runtimeRevision) throw new Error(`installed DSH ${manifest.dshVersion} differs from the immutable catalog release`)
      if (existing.manifest.runtimeRevision > manifest.runtimeRevision) throw new Error(`runtime revision downgrade is not allowed for DSH ${manifest.dshVersion}`)
    }
    const finalDirectory = join(this.runtimesDirectory, manifest.dshVersion)
    const backupDirectory = `${finalDirectory}.backup-${randomUUID()}`
    await mkdir(this.downloadsDirectory, { recursive: true })
    await mkdir(this.runtimesDirectory, { recursive: true })
    const archiveFile = join(this.downloadsDirectory, `${manifest.dshVersion}.${randomUUID()}.zip.part`)
    const staging = join(this.runtimesDirectory, `${manifest.dshVersion}.staging-${randomUUID()}`)
    let backupPresent = false
    try {
      await this.download(manifest, archiveFile, onProgress)
      await mkdir(staging, { recursive: true })
      await extract(archiveFile, { dir: staging })
      await writeFile(join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, undefined, 2)}\n`, 'utf8')
      const hadExisting = await pathExists(finalDirectory)
      if (hadExisting) {
        await rename(finalDirectory, backupDirectory)
        backupPresent = true
      }
      try {
        await rename(staging, finalDirectory)
        await this.materializeLinks(finalDirectory)
        const installed = this.resolveInstalled(finalDirectory, manifest)
        await Promise.all([
          access(installed.nodeExecutable),
          access(installed.pnpmExecutable),
          access(installed.dshBin),
        ])
        await rm(backupDirectory, { recursive: true, force: true })
        backupPresent = false
        return installed
      } catch (error: unknown) {
        await rm(finalDirectory, { recursive: true, force: true })
        if (backupPresent) {
          await rename(backupDirectory, finalDirectory)
          backupPresent = false
        }
        throw error
      }
    } finally {
      await rm(archiveFile, { force: true })
      await rm(staging, { recursive: true, force: true })
      // A remaining backup means restoration failed; retain it for manual recovery.
      if (!backupPresent) await rm(backupDirectory, { recursive: true, force: true })
    }
  }

  private async materializeLinks(directory: string): Promise<void> {
    const filename = join(directory, 'runtime-links.json')
    const value: unknown = JSON.parse(await readFile(filename, 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('runtime-links.json must be an object')
    const input = value as Record<string, unknown>
    if (input.schemaVersion !== 1 || !Array.isArray(input.links) || input.links.length > 100_000) {
      throw new Error('runtime-links.json has an unsupported schema or link count')
    }
    const root = resolve(directory)
    const inside = (path: unknown, name: string): string => {
      if (typeof path !== 'string' || path.length === 0 || isAbsolute(path)) throw new Error(`${name} must be a relative path`)
      const filename = resolve(root, path)
      const prefix = `${root}${process.platform === 'win32' ? '\\' : '/'}`
      if (!filename.startsWith(prefix)) throw new Error(`${name} escapes the runtime directory`)
      return filename
    }
    const seen = new Set<string>()
    const links = input.links.map((value, index) => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`runtime link ${index} must be an object`)
      const link = value as Record<string, unknown>
      if (link.kind !== 'junction') throw new Error(`runtime link ${index} has an unsupported kind`)
      const path = inside(link.path, `runtime link ${index} path`)
      const target = inside(link.target, `runtime link ${index} target`)
      if (path === target || seen.has(path)) throw new Error(`runtime link ${index} is duplicate or self-referential`)
      seen.add(path)
      return { path, target }
    })
    for (const link of links) {
      const target = await lstat(link.target)
      if (!target.isDirectory() || target.isSymbolicLink()) throw new Error('runtime junction target is not a physical directory')
    }
    for (let index = 0; index < links.length; index += 64) {
      await Promise.all(links.slice(index, index + 64).map(async (link) => {
        await mkdir(dirname(link.path), { recursive: true })
        await symlink(link.target, link.path, 'junction')
      }))
    }
  }

  private resolveInstalled(directory: string, manifest: RuntimeManifest): InstalledRuntime {
    const inside = (path: string): string => {
      const filename = resolve(directory, path)
      const prefix = `${resolve(directory)}${process.platform === 'win32' ? '\\' : '/'}`
      if (!filename.startsWith(prefix)) throw new Error(`runtime path escapes installation: ${path}`)
      return filename
    }
    return {
      directory,
      manifest,
      nodeExecutable: inside(manifest.paths.node),
      pnpmExecutable: inside(manifest.paths.pnpm),
      dshBin: inside(manifest.paths.dsh),
    }
  }

  private async download(
    manifest: RuntimeManifest,
    destination: string,
    onProgress: (progress: DownloadProgress) => void,
  ): Promise<void> {
    const response = await fetch(manifest.archive.url, {
      headers: { accept: 'application/octet-stream', 'user-agent': 'deepseek-harness-desktop' },
      redirect: 'follow',
      signal: AbortSignal.timeout(30 * 60_000),
    })
    if (!response.ok || response.body === null) {
      throw new Error(`runtime download failed with HTTP ${response.status}`)
    }
    const file = await open(destination, 'wx')
    const hash = createHash('sha256')
    let received = 0
    try {
      const reader = response.body.getReader()
      for (;;) {
        const result = await reader.read()
        if (result.done) break
        received += result.value.byteLength
        if (received > manifest.archive.size) throw new Error('runtime download exceeded its declared size')
        hash.update(result.value)
        await file.write(result.value)
        onProgress({ received, total: manifest.archive.size })
      }
    } finally {
      await file.close()
    }
    if (received !== manifest.archive.size) {
      throw new Error(`runtime download size mismatch: expected ${manifest.archive.size}, received ${received}`)
    }
    const actual = hash.digest('hex')
    if (actual !== manifest.archive.sha256) throw new Error('runtime download SHA-256 mismatch')
    const actualSize = (await stat(destination)).size
    if (actualSize !== manifest.archive.size) throw new Error('runtime file size changed after download')
  }
}
