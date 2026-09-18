import { randomUUID } from 'node:crypto'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const PLUGIN_NAME = 'dsh-multi-model-orchestrator'
const MARKER_NAME = '.dsh-multi-model-orchestrator.json'
const PRESET_IDS = ['multi-model-orchestrator', 'orchestrator'] as const
const MANAGED_FILES = ['agent.cordis.yml', 'preset.yml'] as const

async function pluginIsInstalled(home: string): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(join(home, 'profiles', 'web', 'package.json'), 'utf8'))
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const manifest = value as Record<string, unknown>
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      const dependencies = manifest[field]
      if (dependencies !== null && typeof dependencies === 'object' && !Array.isArray(dependencies)
        && Object.prototype.hasOwnProperty.call(dependencies, PLUGIN_NAME)) return true
    }
  } catch {}
  return false
}

async function isManagedPreset(target: string): Promise<boolean> {
  try {
    const markerValue: unknown = JSON.parse(await readFile(join(target, MARKER_NAME), 'utf8'))
    if (markerValue === null || typeof markerValue !== 'object' || Array.isArray(markerValue)) return false
    const marker = markerValue as Record<string, unknown>
    const files = marker.files
    if (marker.schema !== 1 || marker.managedBy !== PLUGIN_NAME || files === null
      || typeof files !== 'object' || Array.isArray(files)) return false
    const hashes = files as Record<string, unknown>
    for (const name of MANAGED_FILES) {
      const expected = hashes[name]
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/u.test(expected)) return false
      await readFile(join(target, name))
    }
    return true
  } catch {
    return false
  }
}

/** Preserve plugin-owned presets as backups after package removal. */
export async function cleanupRemovedPluginPresets(home: string): Promise<string[]> {
  if (await pluginIsInstalled(home)) return []
  const root = join(home, '.agent-presets')
  const removed: string[] = []
  for (const presetId of PRESET_IDS) {
    const target = join(root, presetId)
    if (!await isManagedPreset(target)) continue
    const backup = target + '.desktop-uninstalled-' + Date.now().toString(36) + '-' + randomUUID()
    try {
      await rename(target, backup)
      removed.push(presetId)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return removed
}
