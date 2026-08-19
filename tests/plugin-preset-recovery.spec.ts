import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { inspectPluginPresetRecovery } from '../src/plugin-preset-recovery.ts'
import type { InstalledRuntime } from '../src/runtime-store.ts'

const roots: string[] = []
const pluginName = 'dsh-multi-model-orchestrator'
const presetId = 'multi-model-orchestrator'
const agent = 'new agent preset\n'
const preset = 'name: New preset\n'

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'dsh-preset-recovery-'))
  roots.push(home)
  const packageRoot = join(home, 'profiles', 'web', 'node_modules', pluginName)
  const source = join(packageRoot, 'preset')
  const target = join(home, '.agent-presets', presetId)
  await Promise.all([mkdir(join(packageRoot, 'src'), { recursive: true }), mkdir(source, { recursive: true }), mkdir(target, { recursive: true })])
  await Promise.all([
    writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: pluginName, version: '0.6.0' })),
    writeFile(join(packageRoot, 'src', 'install.mjs'), '// fixture installer\n'),
    writeFile(join(source, 'agent.cordis.yml'), agent),
    writeFile(join(source, 'preset.yml'), preset),
    writeFile(join(target, 'agent.cordis.yml'), 'locally changed agent preset\n'),
    writeFile(join(target, 'preset.yml'), 'name: Old preset\n'),
    writeFile(join(target, 'notes.txt'), 'preserve me\n'),
  ])
  const runtime: InstalledRuntime = {
    directory: join(home, 'runtime'),
    manifest: {
      schemaVersion: 1,
      runtimeProtocolVersion: 1,
      runtimeRevision: 1,
      dshVersion: '0.1.0-rc.7',
      requiredShellRange: '>=0.1.1 <1.0.0',
      platform: 'win32',
      arch: 'x64',
      source: { repository: 'https://github.com/deepseek-ai/deepseek-harness.git', tag: 'dsh-v0.1.0-rc.7', commit: 'a'.repeat(40) },
      archive: { url: 'https://example.test/runtime.zip', sha256: 'b'.repeat(64), size: 1 },
      paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/bin.js' },
    },
    nodeExecutable: join(home, 'runtime', 'node', 'node.exe'),
    pnpmExecutable: join(home, 'runtime', 'tools', 'pnpm.exe'),
    dshBin: join(home, 'runtime', 'app', 'bin.js'),
  }
  const diagnostics = 'failed to apply loader entry multi-model-orchestrator-settings (dsh-multi-model-orchestrator): Refusing to modify preset target '
    + target + ': agent.cordis.yml does not match the packaged preset. Use --force to replace it.'
  return { home, packageRoot, source, target, runtime, diagnostics }
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

async function writeResetTarget(target: string): Promise<void> {
  await mkdir(target, { recursive: true })
  await Promise.all([
    writeFile(join(target, 'agent.cordis.yml'), agent),
    writeFile(join(target, 'preset.yml'), preset),
    writeFile(join(target, '.dsh-multi-model-orchestrator.json'), JSON.stringify({
      schema: 1,
      managedBy: pluginName,
      files: { 'agent.cordis.yml': digest(agent), 'preset.yml': digest(preset) },
    }) + '\n'),
  ])
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => { await rm(root, { recursive: true, force: true }) }))
})

describe('plugin preset recovery', () => {
  it('backs up the complete conflicting target and runs only the fixed installed repair command', async () => {
    const value = await fixture()
    const runInstaller = vi.fn(async () => { await writeResetTarget(value.target) })
    const plan = await inspectPluginPresetRecovery(value, { runInstaller })

    expect(plan).toMatchObject({ pluginName, presetId })
    expect(JSON.stringify(plan)).not.toContain(value.home)
    await expect(plan?.apply()).resolves.toEqual({ pluginName, presetId })
    expect(runInstaller).toHaveBeenCalledWith({
      command: value.runtime.nodeExecutable,
      args: [join(value.packageRoot, 'src', 'install.mjs'), '--force', '--target', value.target],
      cwd: value.packageRoot,
      env: expect.objectContaining({ DSH_HOME: value.home }),
    })
    expect(await readFile(join(value.target, 'agent.cordis.yml'), 'utf8')).toBe(agent)
    const backups = (await readdir(join(value.home, '.agent-presets'))).filter(name => name.startsWith(presetId + '.desktop-backup-'))
    expect(backups).toHaveLength(1)
    expect(await readFile(join(value.home, '.agent-presets', backups[0] as string, 'notes.txt'), 'utf8')).toBe('preserve me\n')
    await expect(plan?.apply()).rejects.toThrow('已执行')
  })

  it('executes the installed reset script with the managed Node process', async () => {
    const value = await fixture()
    value.runtime.nodeExecutable = process.execPath
    const script = [
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "import { join } from 'node:path'",
      "const target = process.argv[process.argv.indexOf('--target') + 1]",
      "if (!process.argv.includes('--force') || target === undefined) process.exit(2)",
      "await mkdir(target, { recursive: true })",
      "await writeFile(join(target, 'agent.cordis.yml'), " + JSON.stringify(agent) + " )",
      "await writeFile(join(target, 'preset.yml'), " + JSON.stringify(preset) + " )",
      "await writeFile(join(target, '.dsh-multi-model-orchestrator.json'), " + JSON.stringify(JSON.stringify({ schema: 1, managedBy: pluginName, files: { 'agent.cordis.yml': digest(agent), 'preset.yml': digest(preset) } }) + '\n') + " )",
    ].join('\n')
    await writeFile(join(value.packageRoot, 'src', 'install.mjs'), script)
    const plan = await inspectPluginPresetRecovery(value)

    await expect(plan?.apply()).resolves.toEqual({ pluginName, presetId })
    expect(await readFile(join(value.target, 'agent.cordis.yml'), 'utf8')).toBe(agent)
    const backups = (await readdir(join(value.home, '.agent-presets'))).filter(name => name.startsWith(presetId + '.desktop-backup-'))
    expect(backups).toHaveLength(1)
  })

  it('rolls the complete target back when the installer or validation fails', async () => {
    const value = await fixture()
    const plan = await inspectPluginPresetRecovery(value, {
      runInstaller: async () => {
        await mkdir(value.target, { recursive: true })
        await writeFile(join(value.target, 'agent.cordis.yml'), 'partial replacement')
        throw new Error('simulated installer failure')
      },
    })

    await expect(plan?.apply()).rejects.toThrow('simulated installer failure')
    expect(await readFile(join(value.target, 'agent.cordis.yml'), 'utf8')).toBe('locally changed agent preset\n')
    expect(await readFile(join(value.target, 'notes.txt'), 'utf8')).toBe('preserve me\n')
    expect((await readdir(join(value.home, '.agent-presets'))).filter(name => name.startsWith(presetId + '.desktop-backup-'))).toHaveLength(0)
  })

  it('rejects lookalike diagnostics, unexpected targets, and foreign packages', async () => {
    const value = await fixture()
    const cases = [
      value.diagnostics.replace('multi-model-orchestrator-settings', 'other-settings'),
      value.diagnostics.replace(value.target, join(value.home, '.agent-presets', 'other')),
      value.diagnostics.replace('does not match the packaged preset', 'has another problem'),
      'agent.cordis.yml does not match the packaged preset',
    ]
    for (const diagnostics of cases) {
      await expect(inspectPluginPresetRecovery({ ...value, diagnostics })).resolves.toBeUndefined()
    }
    await writeFile(join(value.packageRoot, 'package.json'), JSON.stringify({ name: 'foreign-package' }))
    await expect(inspectPluginPresetRecovery(value)).resolves.toBeUndefined()
  })

  it.each([
    'agent.cordis.yml has changed since it was managed.',
    'preset.yml does not match the packaged preset.',
    'the management marker is invalid.',
    'the management marker is foreign or invalid.',
  ])('accepts the exact managed conflict detail %s', async detail => {
    const value = await fixture()
    const diagnostics = value.diagnostics.replace('agent.cordis.yml does not match the packaged preset.', detail)
    await expect(inspectPluginPresetRecovery({ ...value, diagnostics }, { runInstaller: async () => {} })).resolves.toMatchObject({ pluginName, presetId })
  })
})
