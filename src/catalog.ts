import { isAbsolute, normalize, sep } from 'node:path'
import { compare, rcompare, satisfies, valid } from 'semver'

export const RUNTIME_CATALOG_SCHEMA = 1
export const RUNTIME_PROTOCOL_VERSION = 1
export const MINIMUM_DSH_VERSION = '0.1.0-rc.7'
export const UPSTREAM_REPOSITORY = 'https://github.com/deepseek-ai/deepseek-harness.git'
export const DEFAULT_CATALOG_URL = 'https://github.com/ToxicantX/deepseek-harness-desktop/releases/download/runtime-catalog/runtime-catalog.json'

export interface RuntimeManifest {
  schemaVersion: 1
  runtimeProtocolVersion: 1
  dshVersion: string
  runtimeRevision: number
  requiredShellRange: string
  platform: 'win32'
  arch: 'x64'
  source: {
    repository: string
    tag: string
    commit: string
  }
  archive: {
    url: string
    sha256: string
    size: number
  }
  paths: {
    node: string
    pnpm: string
    dsh: string
  }
}

export interface RuntimeCatalog {
  schemaVersion: 1
  generatedAt: string
  releases: RuntimeManifest[]
}

export type RuntimePreference =
  | { mode: 'latest-compatible' }
  | { mode: 'pinned'; version: string }

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`)
  return value
}

function relativePath(value: unknown, name: string): string {
  const path = text(value, name)
  const normalized = normalize(path)
  if (isAbsolute(path) || normalized === '..' || normalized.startsWith(`..${sep}`)) {
    throw new Error(`${name} must stay inside the runtime directory`)
  }
  return path
}

function parseManifest(value: unknown): RuntimeManifest {
  const input = record(value, 'runtime release')
  if (input.schemaVersion !== RUNTIME_CATALOG_SCHEMA) throw new Error('runtime release has an unsupported schemaVersion')
  if (input.runtimeProtocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error('runtime release has an unsupported runtimeProtocolVersion')
  }
  if (input.platform !== 'win32' || input.arch !== 'x64') throw new Error('runtime release is not Windows x64')

  const dshVersion = text(input.dshVersion, 'dshVersion')
  if (valid(dshVersion) === null) throw new Error(`invalid dshVersion: ${dshVersion}`)
  const runtimeRevision = input.runtimeRevision === undefined ? 0 : input.runtimeRevision
  if (typeof runtimeRevision !== 'number' || !Number.isSafeInteger(runtimeRevision) || runtimeRevision < 0) throw new Error('runtimeRevision must be a nonnegative safe integer')
  const requiredShellRange = text(input.requiredShellRange, 'requiredShellRange')
  const source = record(input.source, 'source')
  const repository = text(source.repository, 'source.repository')
  const tag = text(source.tag, 'source.tag')
  const commit = text(source.commit, 'source.commit')
  if (repository !== UPSTREAM_REPOSITORY) throw new Error(`unexpected source repository: ${repository}`)
  if (tag !== `dsh-v${dshVersion}`) throw new Error(`source tag ${tag} does not match dshVersion ${dshVersion}`)
  if (!/^[0-9a-f]{40}$/u.test(commit)) throw new Error('source.commit must be a full Git SHA-1')

  const archive = record(input.archive, 'archive')
  const url = text(archive.url, 'archive.url')
  if (new URL(url).protocol !== 'https:') throw new Error('archive.url must use HTTPS')
  const sha256 = text(archive.sha256, 'archive.sha256').toLowerCase()
  if (!/^[0-9a-f]{64}$/u.test(sha256)) throw new Error('archive.sha256 must be 64 hexadecimal characters')
  const size = archive.size
  if (typeof size !== 'number' || !Number.isSafeInteger(size) || size <= 0) {
    throw new Error('archive.size must be a positive safe integer')
  }

  const paths = record(input.paths, 'paths')
  return {
    schemaVersion: RUNTIME_CATALOG_SCHEMA,
    runtimeProtocolVersion: RUNTIME_PROTOCOL_VERSION,
    dshVersion,
    runtimeRevision,
    requiredShellRange,
    platform: 'win32',
    arch: 'x64',
    source: { repository, tag, commit },
    archive: { url, sha256, size },
    paths: {
      node: relativePath(paths.node, 'paths.node'),
      pnpm: relativePath(paths.pnpm, 'paths.pnpm'),
      dsh: relativePath(paths.dsh, 'paths.dsh'),
    },
  }
}

export function parseRuntimeCatalog(value: unknown): RuntimeCatalog {
  const input = record(value, 'runtime catalog')
  if (input.schemaVersion !== RUNTIME_CATALOG_SCHEMA) throw new Error('runtime catalog has an unsupported schemaVersion')
  const generatedAt = text(input.generatedAt, 'generatedAt')
  if (Number.isNaN(Date.parse(generatedAt))) throw new Error('generatedAt must be an ISO date')
  if (!Array.isArray(input.releases)) throw new Error('releases must be an array')
  const releases = input.releases.map(parseManifest)
  const revisions = new Set<string>()
  for (const release of releases) {
    const key = release.dshVersion + ':' + release.runtimeRevision
    if (revisions.has(key)) throw new Error('duplicate DSH version revision: ' + release.dshVersion + ' ' + release.runtimeRevision)
    revisions.add(key)
  }
  return { schemaVersion: RUNTIME_CATALOG_SCHEMA, generatedAt, releases }
}

export function isReleaseCompatible(release: RuntimeManifest, shellVersion: string): boolean {
  return compare(release.dshVersion, MINIMUM_DSH_VERSION) >= 0
    && satisfies(shellVersion, release.requiredShellRange, { includePrerelease: true })
    && release.runtimeProtocolVersion === RUNTIME_PROTOCOL_VERSION
    && release.platform === 'win32'
    && release.arch === 'x64'
}

export function compatibleReleases(catalog: RuntimeCatalog, shellVersion: string): RuntimeManifest[] {
  return catalog.releases
    .filter(release => isReleaseCompatible(release, shellVersion))
    .sort((left, right) => rcompare(left.dshVersion, right.dshVersion) || right.runtimeRevision - left.runtimeRevision)
}

export function selectRuntime(
  catalog: RuntimeCatalog,
  shellVersion: string,
  preference: RuntimePreference,
): RuntimeManifest {
  const compatible = compatibleReleases(catalog, shellVersion)
  if (preference.mode === 'latest-compatible') {
    const latest = compatible[0]
    if (latest === undefined) throw new Error(`no DSH runtime is compatible with shell ${shellVersion}`)
    return latest
  }
  const selected = compatible.find(release => release.dshVersion === preference.version)
  if (selected === undefined) {
    throw new Error(`DSH ${preference.version} is unavailable or incompatible with shell ${shellVersion}`)
  }
  return selected
}
