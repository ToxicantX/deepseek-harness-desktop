import { randomUUID } from 'node:crypto'
import { readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { isMap, isScalar, isSeq, parseDocument, type YAMLMap } from 'yaml'
import type { InstalledRuntime } from './runtime-store.ts'

const PLUGIN_NAME = 'dsh-multi-model-orchestrator'
const LEGACY_CLIENT = '@deepseek-ai/dsh-client-runtime'
const PRESENTATION_NAME = '@deepseek-ai/dsh-agent-tool-presentation'
const PRESET_SOURCES = [
  ['preset', 'agent.cordis.yml'],
  ['preset-legacy', 'agent.cordis.yml'],
] as const
const RUNTIME_PRESET_IDS = ['ptc', 'code'] as const

export interface PluginPresetCompatibilityInput {
  home: string
  runtime: InstalledRuntime
}

interface ModeScalar {
  value: string
  start: number
  end: number
}

function scalar(map: YAMLMap, key: string) {
  for (const pair of map.items) {
    if (isScalar(pair.key) && pair.key.value === key && isScalar(pair.value)) return pair.value
  }
}

function presentationMode(source: string): ModeScalar | undefined {
  const document = parseDocument(source, { prettyErrors: false })
  if (document.errors.length > 0) throw document.errors[0]
  if (!isSeq(document.contents)) return undefined
  let result: ModeScalar | undefined
  for (const item of document.contents.items) {
    if (!isMap(item)) continue
    if (scalar(item, 'id')?.value !== 'tool-presentation' || scalar(item, 'name')?.value !== PRESENTATION_NAME) continue
    const config = item.items.find(pair => isScalar(pair.key) && pair.key.value === 'config')?.value
    if (!isMap(config)) return undefined
    const mode = scalar(config, 'mode')
    const range = mode?.range
    if (mode === undefined || typeof mode.value !== 'string' || range === undefined || range === null) return undefined
    if (result !== undefined) throw new Error('agent preset contains duplicate tool-presentation entries')
    result = { value: mode.value, start: range[0], end: range[1] }
  }
  return result
}

function replaceMode(source: string, mode: ModeScalar, replacement: string): string {
  const raw = source.slice(mode.start, mode.end)
  const next = raw.replace(mode.value, replacement)
  if (next === raw) throw new Error('agent preset tool-presentation mode range is invalid')
  return source.slice(0, mode.start) + next + source.slice(mode.end)
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function isExpectedPlugin(packageRoot: string): Promise<boolean> {
  const manifest = await readOptional(join(packageRoot, 'package.json'))
  if (manifest === undefined) return false
  try {
    const value: unknown = JSON.parse(manifest)
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && (value as Record<string, unknown>).name === PLUGIN_NAME
  } catch {
    return false
  }
}

async function replaceFile(path: string, contents: string): Promise<void> {
  const suffix = `.desktop-compat-${randomUUID()}`
  const temporary = path + suffix + '.tmp'
  const backup = path + suffix + '.backup'
  await writeFile(temporary, contents, 'utf8')
  await rename(path, backup)
  try {
    await rename(temporary, path)
  } catch (error: unknown) {
    let rollbackError: unknown
    try {
      await rename(backup, path)
    } catch (value: unknown) {
      rollbackError = value
    }
    await rm(temporary, { force: true }).catch(() => {})
    if (rollbackError !== undefined) throw new AggregateError([error, rollbackError], 'agent preset compatibility write and rollback both failed')
    throw error
  }
  await rm(backup, { force: true })
}

async function removeLegacyClientInjection(packageRoot: string, runtime: InstalledRuntime): Promise<boolean> {
  try {
    createRequire(runtime.dshBin).resolve(LEGACY_CLIENT + '/client')
    return false
  } catch {
    // The compatibility edit is needed only after the Runtime removes this module.
  }
  const manifestPath = join(packageRoot, 'package.json')
  const source = await readOptional(manifestPath)
  if (source === undefined) return false
  const manifest: unknown = JSON.parse(source)
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const dsh = (manifest as Record<string, unknown>).dsh
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh)) return false
  const client = (dsh as Record<string, unknown>).client
  if (client === null || typeof client !== 'object' || Array.isArray(client)) return false
  const inject = (client as Record<string, unknown>).inject
  if (!Array.isArray(inject) || !inject.includes(LEGACY_CLIENT)) return false
  ;(client as Record<string, unknown>).inject = inject.filter(value => value !== LEGACY_CLIENT)
  await replaceFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
  return true
}

export async function preparePluginPresetCompatibility(input: PluginPresetCompatibilityInput): Promise<string | undefined> {
  const runtimePackage = dirname(dirname(input.runtime.dshBin))
  let runtimeUsesPtc = false
  const runtimePresetRoots = [
    join(runtimePackage, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets'),
    join(runtimePackage, 'config', 'agent-presets'),
  ]
  for (const presetRoot of runtimePresetRoots) {
    for (const presetId of RUNTIME_PRESET_IDS) {
      const runtimePreset = await readOptional(join(presetRoot, presetId, 'agent.cordis.yml'))
      if (runtimePreset !== undefined && presentationMode(runtimePreset)?.value === 'ptc') {
        runtimeUsesPtc = true
        break
      }
    }
    if (runtimeUsesPtc) break
  }
  if (!runtimeUsesPtc) return undefined

  const profileModules = join(input.home, 'profiles', 'web', 'node_modules')
  const pluginRoot = join(profileModules, PLUGIN_NAME)
  let resolvedPlugin: string
  try {
    const resolvedModules = await realpath(profileModules)
    resolvedPlugin = await realpath(pluginRoot)
    const location = relative(resolvedModules, resolvedPlugin)
    if (location.startsWith('..') || isAbsolute(location)) return undefined
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (!await isExpectedPlugin(resolvedPlugin)) return undefined
  for (const sourceSegments of PRESET_SOURCES) {
    const sourcePath = join(resolvedPlugin, ...sourceSegments)
    const source = await readOptional(sourcePath)
    if (source === undefined) continue
    const mode = presentationMode(source)
    if (mode?.value !== 'code') continue
    await replaceFile(sourcePath, replaceMode(source, mode, 'ptc'))
  }
  await removeLegacyClientInjection(resolvedPlugin, input.runtime)
  return PLUGIN_NAME
}
