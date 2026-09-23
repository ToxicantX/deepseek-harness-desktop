import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginRuntimeConfigProtection,
  recoverPendingRuntimeConfigProtection,
} from '../src/runtime-config-protection.ts'

const temporaryDirectories: string[] = []

async function fixture(): Promise<{
  home: string
  settings: string
  imported: string
  patch: string
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-runtime-config-'))
  temporaryDirectories.push(home)
  const settings = join(home, 'settings.yaml')
  const imported = settings + '.imported'
  const patch = join(home, 'profiles', 'web', 'cordis.patch.yml')
  await mkdir(join(home, 'profiles', 'web'), { recursive: true })
  return { home, settings, imported, patch }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Runtime model configuration protection', () => {
  it('keeps unique durable copies when a repeated migration overwrites settings.yaml.imported', async () => {
    const value = await fixture()
    const legacy = [
      'llm-pi-ai:',
      '  providers:',
      '    openai:',
      '      apiKeyEnv: OPENAI_API_KEY',
      '      models:',
      '        - id: gpt-test',
      'agent-default-model:',
      '  provider: openai',
      '  model: gpt-test',
      '',
    ].join('\n')
    const previousImported = 'llm-pi-ai:\n  providers:\n    preserved:\n      apiKeyEnv: PRESERVED_KEY\n'
    await writeFile(value.settings, legacy)
    await writeFile(value.imported, previousImported)
    await writeFile(value.patch, '[]\n')

    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.6-alpha.2',
      toVersion: '0.1.7-alpha.1',
    })
    expect(transaction).toBeDefined()
    expect(await readFile(join(transaction!.backupDirectory, 'settings.yaml'), 'utf8')).toBe(legacy)
    expect(await readFile(join(transaction!.backupDirectory, 'settings.yaml.imported'), 'utf8')).toBe(previousImported)

    await rm(value.settings)
    await writeFile(value.imported, legacy)
    await writeFile(value.patch, [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      openai:',
      '        apiKeyEnv: OPENAI_API_KEY',
      '        models:',
      '          - id: gpt-test',
      '- id: agent-default-model',
      '  config:',
      '    provider: openai',
      '    model: gpt-test',
      '',
    ].join('\n'))

    await expect(transaction!.verify({ timeoutMs: 0 })).resolves.toBeUndefined()
    await transaction!.commit()
    expect(await readFile(join(transaction!.backupDirectory, 'settings.yaml.imported'), 'utf8')).toBe(previousImported)
  })

  it('rejects a ready Runtime with an incomplete model migration and restores every original file', async () => {
    const value = await fixture()
    const legacy = [
      'llm-pi-ai:',
      '  providers:',
      '    openai:',
      '      apiKeyEnv: OPENAI_API_KEY',
      'llm-deepseek:',
      '  baseURL: https://api.deepseek.example',
      'agent-default-model:',
      '  provider: openai',
      '  model: gpt-test',
      '',
    ].join('\n')
    const imported = 'ui-onboarding:\n  welcomeNoticeVersion: old\n'
    const patch = '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: old\n'
    await writeFile(value.settings, legacy)
    await writeFile(value.imported, imported)
    await writeFile(value.patch, patch)

    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.6-alpha.2',
      toVersion: '0.1.7-alpha.1',
    })
    await rm(value.settings)
    await writeFile(value.imported, legacy)
    await writeFile(value.patch, '- id: agent-default-model\n  config:\n    provider: openai\n    model: gpt-test\n')

    await expect(transaction!.verify({ timeoutMs: 0 })).rejects.toThrow('llm-deepseek, llm-pi-ai')
    await transaction!.rollback()
    expect(await readFile(value.settings, 'utf8')).toBe(legacy)
    expect(await readFile(value.imported, 'utf8')).toBe(imported)
    expect(await readFile(value.patch, 'utf8')).toBe(patch)
  })

  it('detects loss from an existing Profile even when no legacy settings document remains', async () => {
    const value = await fixture()
    const patch = [
      '- id: llm-pi-ai',
      '  config:',
      '    providers:',
      '      custom:',
      '        apiKeyEnv: CUSTOM_API_KEY',
      '        models:',
      '          - id: custom-model',
      '',
    ].join('\n')
    await writeFile(value.patch, patch)
    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.7-alpha.1',
      toVersion: '0.1.8-alpha.1',
    })
    await writeFile(value.patch, '[]\n')

    await expect(transaction!.verify({ timeoutMs: 0 })).rejects.toThrow('llm-pi-ai')
    await transaction!.rollback()
    expect(await readFile(value.patch, 'utf8')).toBe(patch)
  })

  it('retries an intact imported legacy document after an earlier migration failure', async () => {
    const value = await fixture()
    const legacy = [
      'llm-pi-ai:',
      '  providers:',
      '    openai:',
      '      apiKeyEnv: OPENAI_API_KEY',
      'agent-default-model:',
      '  provider: openai',
      '  model: gpt-test',
      '',
    ].join('\n')
    await writeFile(value.imported, legacy)
    await writeFile(value.patch, '[]\n')

    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.6-alpha.2',
      toVersion: '0.1.7-alpha.1',
    })

    expect(await readFile(value.settings, 'utf8')).toBe(legacy)
    await transaction!.rollback()
    await expect(readFile(value.settings, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(value.imported, 'utf8')).toBe(legacy)
    expect(await readFile(value.patch, 'utf8')).toBe('[]\n')
  })

  it('maps the renamed Agent preset registry before legacy settings are imported', async () => {
    const value = await fixture()
    const legacy = [
      'agent-presets:',
      '  default: multi-model-orchestrator',
      'agent-default-model:',
      '  provider: openai',
      '  model: gpt-test',
      '',
    ].join('\n')
    await writeFile(value.settings, legacy)
    await writeFile(value.patch, '[]\n')

    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.6-alpha.2',
      toVersion: '0.1.7-alpha.1',
    })
    const prepared = await readFile(value.settings, 'utf8')
    expect(prepared).toContain('agent-preset-registry:')
    expect(prepared).not.toContain('agent-presets:')

    await rm(value.settings)
    await writeFile(value.imported, prepared)
    await writeFile(value.patch, [
      '- id: agent-preset-registry',
      '  config:',
      '    default: multi-model-orchestrator',
      '- id: agent-default-model',
      '  config:',
      '    provider: openai',
      '    model: gpt-test',
      '',
    ].join('\n'))

    await expect(transaction!.verify({ timeoutMs: 0 })).resolves.toBeUndefined()
    await transaction!.commit()
    expect(await readFile(join(transaction!.backupDirectory, 'settings.yaml'), 'utf8')).toBe(legacy)
  })

  it('recovers a pending transaction after a Shell interruption before making another snapshot', async () => {
    const value = await fixture()
    const legacy = 'agent-default-model:\n  provider: openai\n  model: stable\n'
    const patch = '- id: agent-default-model\n  config:\n    provider: openai\n    model: previous\n'
    await writeFile(value.settings, legacy)
    await writeFile(value.patch, patch)
    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.6-alpha.2',
      toVersion: '0.1.7-alpha.1',
    })
    await rm(value.settings)
    await writeFile(value.imported, 'overwritten\n')
    await writeFile(value.patch, '[]\n')

    await expect(recoverPendingRuntimeConfigProtection(value.home)).resolves.toBe(transaction!.backupDirectory)
    expect(await readFile(value.settings, 'utf8')).toBe(legacy)
    await expect(readFile(value.imported, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(value.patch, 'utf8')).toBe(patch)
    await expect(recoverPendingRuntimeConfigProtection(value.home)).resolves.toBeUndefined()
  })

  it('can restore its snapshot after commit when Shell state finalization fails', async () => {
    const value = await fixture()
    const patch = '- id: agent-default-model\n  config:\n    provider: openai\n    model: stable\n'
    await writeFile(value.patch, patch)
    const transaction = await beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.7-alpha.1',
      toVersion: '0.1.8-alpha.1',
    })
    await transaction!.verify({ timeoutMs: 0 })
    await transaction!.commit()
    await writeFile(value.patch, '[]\n')

    await transaction!.rollback()

    expect(await readFile(value.patch, 'utf8')).toBe(patch)
    await expect(recoverPendingRuntimeConfigProtection(value.home)).resolves.toBeUndefined()
  })

  it('refuses an invalid legacy document before the Runtime can rename it', async () => {
    const value = await fixture()
    const invalid = 'llm-pi-ai: [\n'
    await writeFile(value.settings, invalid)

    await expect(beginRuntimeConfigProtection({
      home: value.home,
      fromVersion: '0.1.6-alpha.2',
      toVersion: '0.1.7-alpha.1',
    })).rejects.toThrow('settings.yaml')
    expect(await readFile(value.settings, 'utf8')).toBe(invalid)
  })
})
