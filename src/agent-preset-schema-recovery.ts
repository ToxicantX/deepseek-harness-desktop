import { constants } from 'node:fs'
import { copyFile, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path'
import { isMap, isSeq, parseDocument } from 'yaml'
import type { InstalledRuntime } from './runtime-store.ts'

const PRESET_ID = 'multi-model-orchestrator'
const PRESENTATION_PLUGIN = '@deepseek-ai/dsh-agent-tool-presentation'
const LEGACY_MODE = 'code'
const NEW_MODE = 'ptc'
const DIAGNOSTIC_PATTERN = /failed to apply loader entry tool-presentation \(@deepseek-ai\/dsh-agent-tool-presentation\): invalid config: \$\.mode expected "native" \| "ptc" \| "both", but got "code" at ([^\r\n]+agent\.cordis\.yml)\b/iu

export interface AgentPresetSchemaRecoveryInput {
  home: string
  runtime: InstalledRuntime
  diagnostics: string
}

export interface AgentPresetSchemaRecoveryResult {
  presetId: string
  mode: typeof NEW_MODE
}

export interface AgentPresetSchemaRecoveryPlan extends AgentPresetSchemaRecoveryResult {
  apply(): Promise<AgentPresetSchemaRecoveryResult>
}

function canonicalPath(value: string): string {
  const normalized = win32.isAbsolute(value) ? win32.resolve(value) : resolve(value)
  return process.platform === 'win32' || win32.isAbsolute(value) ? normalized.toLowerCase() : normalized
}

function mapValue(node: any, key: string): any {
  if (!isMap(node)) return undefined
  return node.items.find((item: any) => item.key?.value === key)?.value
}

function legacyModeRange(content: string): [number, number] | undefined {
  const document = parseDocument(content, { strict: true })
  if (document.errors.length > 0 || !isSeq(document.contents)) return undefined
  for (const item of document.contents.items as any[]) {
    if (!isMap(item) || mapValue(item, 'id')?.value !== 'tool-presentation'
      || mapValue(item, 'name')?.value !== PRESENTATION_PLUGIN) continue
    const mode = mapValue(mapValue(item, 'config'), 'mode')
    if (mode?.value !== LEGACY_MODE || !Array.isArray(mode.range) || mode.range.length < 2) return undefined
    return [mode.range[0], mode.range[1]]
  }
  return undefined
}

function diagnosticTarget(diagnostics: string): string | undefined {
  return diagnostics.match(DIAGNOSTIC_PATTERN)?.[1]
}

export async function inspectAgentPresetSchemaRecovery(
  input: AgentPresetSchemaRecoveryInput,
): Promise<AgentPresetSchemaRecoveryPlan | undefined> {
  if (!isAbsoluteHome(input.home)) return undefined
  const target = join(input.home, '.agent-presets', PRESET_ID, 'agent.cordis.yml')
  const reported = diagnosticTarget(input.diagnostics)
  if (reported === undefined || canonicalPath(reported) !== canonicalPath(target)) return undefined
  const original = await readFile(target, 'utf8').catch(() => undefined)
  if (original === undefined) return undefined
  const range = legacyModeRange(original)
  if (range === undefined) return undefined
  let applied = false
  return {
    presetId: PRESET_ID,
    mode: NEW_MODE,
    async apply() {
      if (applied) throw new Error('Agent preset schema 恢复计划已执行')
      if (await readFile(target, 'utf8').catch(() => undefined) !== original) throw new Error('Agent preset 文件已更改，请重新诊断')
      const replacement = original.slice(0, range[0]) + NEW_MODE + original.slice(range[1])
      const directory = dirname(target)
      const backup = join(directory, 'agent.cordis.yml.desktop-backup-' + Date.now().toString(36) + '-' + randomUUID())
      const temporary = join(directory, '.' + randomUUID() + '.desktop-schema.tmp')
      try {
        await copyFile(target, backup, constants.COPYFILE_EXCL)
        await writeFile(temporary, replacement, { encoding: 'utf8', flag: 'wx' })
        if (await readFile(target, 'utf8') !== original) throw new Error('Agent preset 文件已更改，请重新诊断')
        await rename(temporary, target)
        applied = true
        return { presetId: PRESET_ID, mode: NEW_MODE }
      } finally {
        await rm(temporary, { force: true }).catch(() => {})
      }
    },
  }
}

function isAbsoluteHome(value: string): boolean {
  return isAbsolute(value) || win32.isAbsolute(value)
}
