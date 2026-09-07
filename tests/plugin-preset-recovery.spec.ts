import { mkdir, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { inspectPluginPresetRecovery } from '../src/plugin-preset-recovery.ts'

describe('plugin preset recovery', () => {
  it('recognizes a stale legacy preset from an early Runtime exit', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-preset-recovery-'))
    const packageRoot = join(home, 'profiles', 'web', 'node_modules', 'dsh-multi-model-orchestrator')
    const source = join(packageRoot, 'preset')
    const target = join(home, '.agent-presets', 'multi-model-orchestrator')
    await mkdir(source, { recursive: true })
    await mkdir(target, { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: 'dsh-multi-model-orchestrator' }))
    await mkdir(join(packageRoot, 'src'), { recursive: true })
    await writeFile(join(packageRoot, 'src', 'install.mjs'), '')
    await writeFile(join(source, 'agent.cordis.yml'), '- id: tool-presentation\n  config:\n    mode: ptc\n')
    await writeFile(join(source, 'preset.yml'), 'name: test\n')
    await writeFile(join(target, 'agent.cordis.yml'), '- id: tool-presentation\n  config:\n    mode: code\n')

    const plan = await inspectPluginPresetRecovery({
      home,
      runtime: { nodeExecutable: 'node' } as any,
      diagnostics: 'DSH runtime exited before readiness: exit code 1',
    })

    expect(plan?.pluginName).toBe('dsh-multi-model-orchestrator')
    expect(plan?.presetId).toBe('multi-model-orchestrator')
  })
})
