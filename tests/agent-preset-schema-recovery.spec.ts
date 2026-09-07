import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectAgentPresetSchemaRecovery } from '../src/agent-preset-schema-recovery.ts'

const runtime = { manifest: { dshVersion: '0.1.3' } } as any

function diagnostic(file: string, mode: string): string {
  return `agent-presets: preset "multi-model-orchestrator" failed to mount: failed to apply loader entry tool-presentation (@deepseek-ai/dsh-agent-tool-presentation): invalid config: $.mode expected "native" | "ptc" | "both", but got "${mode}" at ${file}`
}

async function fixture(content: string) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-schema-'))
  const file = join(root, '.agent-presets', 'multi-model-orchestrator', 'agent.cordis.yml')
  await (await import('node:fs/promises')).mkdir(join(root, '.agent-presets', 'multi-model-orchestrator'), { recursive: true })
  await writeFile(file, content)
  return { root, file }
}

describe('agent preset schema recovery', () => {
  it('migrates only the legacy code mode to ptc and keeps the rest byte-for-byte', async () => {
    const original = `- id: tool-presentation\n  name: '@deepseek-ai/dsh-agent-tool-presentation'\n  config:\n    mode: code\n- id: user-config\n  config:\n    provider: openai\n    model: preserved-model\n`
    const { root, file } = await fixture(original)
    const plan = await inspectAgentPresetSchemaRecovery({ home: root, runtime, diagnostics: diagnostic(file, 'code') })
    expect(plan).toBeDefined()
    const result = await plan!.apply()
    expect(result).toMatchObject({ presetId: 'multi-model-orchestrator', mode: 'ptc' })
    expect(await readFile(file, 'utf8')).toBe(original.replace('mode: code', 'mode: ptc'))
    const backups = (await readdir(join(root, '.agent-presets', 'multi-model-orchestrator'))).filter(name => name.includes('.desktop-backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(root, '.agent-presets', 'multi-model-orchestrator', backups[0]!), 'utf8')).toBe(original)
  })

  it.each(['native', 'ptc', 'both', 'custom'])('does not guess or rewrite mode %s', async mode => {
    const { root, file } = await fixture(`- id: tool-presentation\n  name: '@deepseek-ai/dsh-agent-tool-presentation'\n  config:\n    mode: ${mode}\n`)
    await expect(inspectAgentPresetSchemaRecovery({ home: root, runtime, diagnostics: diagnostic(file, mode) })).resolves.toBeUndefined()
    expect(await readFile(file, 'utf8')).toContain(`mode: ${mode}`)
  })

  it('refuses to apply after the file changes', async () => {
    const { root, file } = await fixture(`- id: tool-presentation\n  name: '@deepseek-ai/dsh-agent-tool-presentation'\n  config:\n    mode: code\n`)
    const plan = await inspectAgentPresetSchemaRecovery({ home: root, runtime, diagnostics: diagnostic(file, 'code') })
    await writeFile(file, `${await readFile(file, 'utf8')}# changed\n`)
    await expect(plan!.apply()).rejects.toThrow('已更改')
    expect(await readFile(file, 'utf8')).toContain('mode: code')
  })
})
