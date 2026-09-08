import { link, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { preparePluginPresetCompatibility } from '../src/plugin-preset-compatibility.ts'

const presentation = (mode: string) => [
  '# keep this comment',
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    text: |- # keep persona comment',
  '      You are the orchestrator.',
  '- id: tool-presentation',
  "  name: '@deepseek-ai/dsh-agent-tool-presentation'",
  '  config:',
  `    mode: ${mode} # keep inline comment`,
  '',
].join('\r\n')

async function fixture(
  runtimeMode: string,
  pluginMode = 'code',
  runtimeLayout: 'current' | 'legacy' = 'current',
  personaVersion = '0.1.3-alpha.1',
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-preset-compat-'))
  const runtimePackage = join(root, 'runtime', 'app', 'node_modules', '@deepseek-ai', 'dsh')
  const dshBin = join(runtimePackage, 'lib', 'bin.js')
  const pluginRoot = join(root, 'home', 'profiles', 'web', 'node_modules', 'dsh-multi-model-orchestrator')
  const runtimePresetId = runtimeMode === 'ptc' ? 'ptc' : 'code'
  const runtimePresetRoot = runtimeLayout === 'current'
    ? join(runtimePackage, 'node_modules', '@deepseek-ai', 'dsh-agent-presets', 'presets')
    : join(runtimePackage, 'config', 'agent-presets')
  await mkdir(join(runtimePresetRoot, runtimePresetId), { recursive: true })
  await mkdir(join(pluginRoot, 'preset'), { recursive: true })
  await mkdir(join(pluginRoot, 'preset-legacy'), { recursive: true })
  const personaRoot = join(root, 'home', 'profiles', 'node_modules', '@deepseek-ai', 'dsh-persona')
  await mkdir(personaRoot, { recursive: true })
  await writeFile(join(personaRoot, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-persona', version: personaVersion }))
  await writeFile(join(runtimePresetRoot, runtimePresetId, 'agent.cordis.yml'), presentation(runtimeMode))
  const packagePath = join(pluginRoot, 'package.json')
  await writeFile(packagePath, JSON.stringify({
    name: 'dsh-multi-model-orchestrator',
    dsh: { client: { inject: ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-settings'] } },
  }, null, 2))
  const sourcePath = join(pluginRoot, 'preset', 'agent.cordis.yml')
  const legacySourcePath = join(pluginRoot, 'preset-legacy', 'agent.cordis.yml')
  await writeFile(sourcePath, presentation(pluginMode))
  await writeFile(legacySourcePath, presentation(pluginMode))
  return {
    home: join(root, 'home'),
    packagePath,
    sourcePath,
    legacySourcePath,
    runtime: { dshBin } as any,
  }
}

describe('plugin preset compatibility', () => {
  it('migrates the managed plugin source from the former Code Mode name to PTC', async () => {
    const value = await fixture('ptc')
    const before = await readFile(value.sourcePath, 'utf8')
    await expect(preparePluginPresetCompatibility(value)).resolves.toBe('dsh-multi-model-orchestrator')
    const after = await readFile(value.sourcePath, 'utf8')
    expect(after).toBe(before.replace('mode: code', 'mode: ptc'))
    expect(await readFile(value.legacySourcePath, 'utf8')).toContain('mode: ptc')
    expect(after).toContain('# keep this comment')
    expect(after).toContain('# keep inline comment')
    expect(JSON.parse(await readFile(value.packagePath, 'utf8')).dsh.client.inject).toEqual(['@deepseek-ai/dsh-client-ui-settings'])
  })

  it('renames the legacy persona text key when the installed persona package requires prefix', async () => {
    const value = await fixture('ptc', 'ptc', 'current', '0.1.3-alpha.2')
    const before = await readFile(value.sourcePath, 'utf8')
    await expect(preparePluginPresetCompatibility(value)).resolves.toBe('dsh-multi-model-orchestrator')
    const after = await readFile(value.sourcePath, 'utf8')
    expect(after).toBe(before.replace('text: |-', 'prefix: |-'))
    expect(await readFile(value.legacySourcePath, 'utf8')).toContain('prefix: |-')
    expect(after).toContain('# keep persona comment')
    await expect(preparePluginPresetCompatibility(value)).resolves.toBe('dsh-multi-model-orchestrator')
    expect(await readFile(value.sourcePath, 'utf8')).toBe(after)
  })

  it('is idempotent and leaves runtimes that still use code unchanged', async () => {
    const current = await fixture('ptc')
    await preparePluginPresetCompatibility(current)
    const migrated = await readFile(current.sourcePath, 'utf8')
    await expect(preparePluginPresetCompatibility(current)).resolves.toBe('dsh-multi-model-orchestrator')
    expect(await readFile(current.sourcePath, 'utf8')).toBe(migrated)

    const former = await fixture('code', 'code', 'legacy')
    const before = await readFile(former.sourcePath, 'utf8')
    await expect(preparePluginPresetCompatibility(former)).resolves.toBeUndefined()
    expect(await readFile(former.sourcePath, 'utf8')).toBe(before)
    expect(before).toContain('text: |-')
  })

  it('breaks pnpm hard links instead of modifying the shared store copy', async () => {
    const value = await fixture('ptc')
    const storeCopy = join(value.home, 'store-agent.cordis.yml')
    const storeManifest = join(value.home, 'store-package.json')
    await writeFile(storeCopy, presentation('code'))
    await writeFile(storeManifest, await readFile(value.packagePath))
    await rm(value.sourcePath)
    await rm(value.legacySourcePath)
    await link(storeCopy, value.sourcePath)
    await link(storeCopy, value.legacySourcePath)
    await rm(value.packagePath)
    await link(storeManifest, value.packagePath)

    await expect(preparePluginPresetCompatibility(value)).resolves.toBe('dsh-multi-model-orchestrator')
    expect(await readFile(storeCopy, 'utf8')).toContain('mode: code')
    expect(await readFile(value.sourcePath, 'utf8')).toContain('mode: ptc')
    expect(await readFile(value.legacySourcePath, 'utf8')).toContain('mode: ptc')
    expect(JSON.parse(await readFile(storeManifest, 'utf8')).dsh.client.inject).toContain('@deepseek-ai/dsh-client-runtime')
    expect(JSON.parse(await readFile(value.packagePath, 'utf8')).dsh.client.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
  })

  it('does not rewrite an unrelated package or an already customized presentation', async () => {
    const unrelated = await fixture('ptc')
    await writeFile(join(unrelated.home, 'profiles', 'web', 'node_modules', 'dsh-multi-model-orchestrator', 'package.json'), JSON.stringify({ name: 'other' }))
    await expect(preparePluginPresetCompatibility(unrelated)).resolves.toBeUndefined()

    const customized = await fixture('ptc', 'native')
    const before = await readFile(customized.sourcePath, 'utf8')
    await expect(preparePluginPresetCompatibility(customized)).resolves.toBe('dsh-multi-model-orchestrator')
    expect(await readFile(customized.sourcePath, 'utf8')).toBe(before)
  })
})
