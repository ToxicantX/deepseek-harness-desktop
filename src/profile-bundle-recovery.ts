import { constants } from 'node:fs'
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

const MAX_MANIFEST_BYTES = 1024 * 1024
const DIAGNOSTIC_PATTERN = /dsh: profile bundle ("(?:\\.|[^"\\]){1,512}") declares no dsh\.bundle in its package\.json/gu

export interface ProfileBundleRecoveryInput {
  home: string
  diagnostics: string
}

export interface ProfileBundleRecoveryResult {
  removedPackageNames: string[]
  count: number
}

export interface ProfileBundleRecoveryPlan {
  packageNames: string[]
  count: number
  apply(): Promise<ProfileBundleRecoveryResult>
}

function packageName(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > 214) return undefined
  const atom = '[a-z0-9](?:[a-z0-9._~-]*[a-z0-9._~-])?'
  return new RegExp('^(?:' + atom + '|@' + atom + '/' + atom + ')$').test(value) ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function parseManifest(text: string): Record<string, unknown> | undefined {
  if (Buffer.byteLength(text, 'utf8') > MAX_MANIFEST_BYTES) return undefined
  try { return object(JSON.parse(text) as unknown) } catch { return undefined }
}

function declaredBundle(manifest: Record<string, unknown>): boolean {
  const dsh = object(manifest.dsh)
  const bundle = object(dsh?.bundle)
  return typeof bundle?.patch === 'string' && bundle.patch.length > 0
}

function diagnosticPackages(diagnostics: string): string[] {
  const names = new Set<string>()
  for (const match of diagnostics.matchAll(DIAGNOSTIC_PATTERN)) {
    try {
      const name = packageName(JSON.parse(match[1] ?? '') as unknown)
      if (name !== undefined) names.add(name)
    } catch {}
  }
  return [...names]
}

async function readText(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8') } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function inspectProfileBundleRecovery(
  input: ProfileBundleRecoveryInput,
): Promise<ProfileBundleRecoveryPlan | undefined> {
  const reported = diagnosticPackages(input.diagnostics)
  if (reported.length === 0) return undefined

  const profileDirectory = join(input.home, 'profiles', 'web')
  const profileFile = join(profileDirectory, 'package.json')
  const original = await readText(profileFile)
  const manifest = original === undefined ? undefined : parseManifest(original)
  const dsh = object(manifest?.dsh)
  const profile = object(dsh?.profile)
  const bundles = profile?.bundles
  const dependencies = object(manifest?.dependencies)
  if (profile === undefined || !Array.isArray(bundles)
    || !bundles.every(value => typeof value === 'string') || dependencies === undefined) return undefined

  const candidates = reported.filter(name => bundles.includes(name) && Object.hasOwn(dependencies, name))
  if (candidates.length === 0) return undefined
  const pluginFiles = new Map<string, { file: string; original: string }>()
  for (const name of candidates) {
    const file = join(profileDirectory, 'node_modules', ...name.split('/'), 'package.json')
    const pluginOriginal = await readText(file)
    const pluginManifest = pluginOriginal === undefined ? undefined : parseManifest(pluginOriginal)
    if (pluginOriginal === undefined || pluginManifest === undefined || pluginManifest.name !== name || declaredBundle(pluginManifest)) continue
    pluginFiles.set(name, { file, original: pluginOriginal })
  }
  const packageNames = [...pluginFiles.keys()].sort((left, right) => left.localeCompare(right))
  if (packageNames.length === 0) return undefined

  const removed = new Set(packageNames)
  profile.bundles = bundles.filter(value => !removed.has(value))
  const replacement = JSON.stringify(manifest, null, 2) + '\n'
  const count = bundles.length - (profile.bundles as string[]).length
  let applied = false
  return {
    packageNames,
    count,
    async apply() {
      if (applied) throw new Error('Profile bundle 恢复计划已执行')
      if (await readText(profileFile) !== original) throw new Error('插件配置已更改，请重新诊断')
      for (const plugin of pluginFiles.values()) {
        if (await readText(plugin.file) !== plugin.original) throw new Error('插件已更新，请重新诊断')
      }

      const backup = profileFile + '.desktop-backup-' + Date.now().toString(36) + '-' + randomUUID()
      const temp = join(dirname(profileFile), '.' + randomUUID() + '.desktop-recovery.tmp')
      try {
        await writeFile(temp, replacement, { encoding: 'utf8', flag: 'wx' })
        await copyFile(profileFile, backup, constants.COPYFILE_EXCL)
        if (await readText(backup) !== original || await readText(profileFile) !== original) {
          throw new Error('插件配置已更改，请重新诊断')
        }
        await rename(temp, profileFile)
        applied = true
        return { removedPackageNames: packageNames, count }
      } finally {
        await rm(temp, { force: true }).catch(() => {})
      }
    },
  }
}
