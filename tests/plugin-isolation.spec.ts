import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { PluginIsolation, classifyPluginFailure, isolationTargets } from '../src/plugin-isolation.ts'
import type { InstalledRuntime } from '../src/runtime-store.ts'

describe('plugin isolation', () => {
  it('attributes only exact import incompatibilities, never ordinary errors or core packages', () => {
    expect(classifyPluginFailure('failed to import loader entry de3f655b (@dshthemes/ui): client-modules: require("@deepseek-ai/dsh-client-runtime/client") missed the module table')).toEqual(['@dshthemes/ui'])
    expect(classifyPluginFailure('failed to import loader entry x (@deepseek-ai/dsh-client-web): client-modules: require("x") missed the module table')).toEqual([])
    expect(classifyPluginFailure('Failed to load plugins\ndsh-channel-telegram\n401 Unauthorized')).toEqual([])
    expect(classifyPluginFailure('failed to import loader entry x (dsh-channel-telegram): fetch failed ECONNRESET')).toEqual([])
    expect(classifyPluginFailure('other-plugin: Cannot find package "x"')).toEqual([])
  })

  it('targets exact declared packages, skips core, ambiguous IDs and unrelated nested entries', () => {
    const rows = [{ id: 'group', group: true, config: [
      { id: 'one', name: 'third-party' }, { id: 'two', name: '@deepseek-ai/core' },
      { id: 'three', name: 'third-party-extra' },
    ] }]
    expect(isolationTargets(rows, ['third-party', '@deepseek-ai/core'])).toEqual([{ id: 'one', name: 'third-party', disabled: true }])
    expect(() => isolationTargets([{ id: 'same', name: 'third-party' }, { id: 'same', name: 'core' }], ['third-party'])).toThrow(/ambiguous/)
    expect(() => isolationTargets([{ id: 'one', name: 'third-party', disabled: true }], ['third-party'], true)).toThrow(/用户配置/)
    expect(() => isolationTargets([{ id: 'outer', group: true, disabled: true, config: rows }], ['third-party'], true)).toThrow(/用户配置/)
  })

  it('attributes exact undeclared service access to the applying third-party plugin', () => {
    const diagnostic = 'failed to apply loader entry telegram-channel (dsh-channel-telegram): cannot get property "webServer" without inject'
    expect(classifyPluginFailure(diagnostic + '\n' + diagnostic)).toEqual(['dsh-channel-telegram'])
    expect(classifyPluginFailure('failed to apply loader entry core (@deepseek-ai/core): cannot get property "webServer" without inject')).toEqual([])
    expect(classifyPluginFailure('failed to apply loader entry channel (dsh-channel-telegram): fetch failed ECONNRESET')).toEqual([])
    expect(classifyPluginFailure('failed to apply loader entry channel (dsh-channel-telegram): 401 Unauthorized')).toEqual([])
    expect(classifyPluginFailure('failed to apply loader entry channel (dsh-channel-telegram): unexpected error')).toEqual([])
    expect(classifyPluginFailure('cannot get property "webServer" without inject')).toEqual([])
  })

  it('isolates only the declared plugin causing undeclared service access', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-service-'))
    const service = new PluginIsolation({ home: root, directory: root })
    vi.spyOn(service, 'packages').mockResolvedValue(['dsh-channel-telegram', 'other-plugin'])
    vi.spyOn(service, 'composition').mockResolvedValue([
      { id: 'telegram-channel', name: 'dsh-channel-telegram' },
      { id: 'other', name: 'other-plugin' },
    ])
    const runtime = { manifest: { dshVersion: '0.1.5-rc.2' } } as InstalledRuntime
    const diagnostic = 'failed to apply loader entry telegram-channel (dsh-channel-telegram): cannot get property "webServer" without inject'

    expect(await service.quarantine(runtime, {}, diagnostic)).toBe(true)
    expect(await service.list()).toEqual([{ name: 'dsh-channel-telegram', reason: 'import-incompatible' }])
    expect(await service.quarantine(runtime, {}, diagnostic)).toBe(false)
    const overlay = await service.prepare(runtime, {})
    expect(parse(await readFile(overlay!.path, 'utf8'))).toEqual([{ id: 'telegram-channel', name: 'dsh-channel-telegram', disabled: true }])
    await overlay!.dispose()
  })

  it('persists isolation separately and keeps it until a successful validation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-'))
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    const profile = join(home, 'profiles', 'web', 'package.json')
    const content = JSON.stringify({ dependencies: { 'third-party': 'link:/local' } })
    await writeFile(profile, content)
    const service = new PluginIsolation({ home, directory: join(root, 'shell') })
    await service.disable('third-party', 'manual')
    expect(await service.list()).toEqual([{ name: 'third-party', reason: 'manual' }])
    const restarted = new PluginIsolation({ home, directory: join(root, 'shell') })
    await expect(restarted.validate('third-party', async () => { throw new Error('still incompatible') })).rejects.toThrow('still incompatible')
    expect(await restarted.list()).toHaveLength(1)
    await restarted.validate('third-party', async () => {})
    expect(await restarted.list()).toEqual([])
    expect(await readFile(profile, 'utf8')).toBe(content)
    await expect(service.disable('@deepseek-ai/core', 'manual')).rejects.toThrow()
    await expect(service.disable('not-installed', 'manual')).rejects.toThrow()
  })

  it('releases only isolation caused by the removed client runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-release-'))
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dependencies: { 'third-party': '1.0.0' } }))
    const service = new PluginIsolation({ home, directory: join(root, 'shell') })

    await service.disable('third-party', 'removed-client-runtime')
    await expect(service.releaseRemovedClientRuntime('third-party')).resolves.toBe(true)
    expect(await service.list()).toEqual([])
    await service.disable('third-party', 'manual')
    await expect(service.releaseRemovedClientRuntime('third-party')).resolves.toBe(false)
    expect(await service.list()).toEqual([{ name: 'third-party', reason: 'manual' }])
  })

  it('generates only exact disabled patches and does not clear isolation when a plugin becomes compatible', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-overlay-'))
    const service = new PluginIsolation({ home: join(root, 'home'), directory: root })
    vi.spyOn(service, 'packages').mockResolvedValue(['third-party'])
    const incompatible = vi.spyOn(service, 'incompatible').mockResolvedValue(['third-party'])
    vi.spyOn(service, 'composition').mockResolvedValue([
      { id: 'core', name: '@deepseek-ai/core', config: { secret: 'not-for-overlay' } },
      { id: 'third', name: 'third-party', config: { credential: 'not-for-overlay' } },
    ])
    const runtime = { manifest: { dshVersion: '0.1.3-alpha.1' } } as InstalledRuntime
    const overlay = await service.prepare(runtime, {})
    expect(overlay).toBeDefined()
    const text = await readFile(overlay!.path, 'utf8')
    expect(text).toContain('id: third')
    expect(text).toContain('disabled: true')
    expect(text).not.toContain('core')
    expect(text).not.toContain('not-for-overlay')
    incompatible.mockResolvedValue([])
    const afterUpgrade = await service.prepare(runtime, {})
    expect(afterUpgrade).toBeDefined()
    expect(await service.list()).toEqual([{ name: 'third-party', reason: 'removed-client-runtime' }])
    await overlay!.dispose()
    await afterUpgrade!.dispose()
    await expect(readFile(overlay!.path)).rejects.toThrow()
  })

  it('does not persist ambiguous or uninstalled failures', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-isolation-ambiguous-'))
    const service = new PluginIsolation({ home: root, directory: root })
    vi.spyOn(service, 'packages').mockResolvedValue(['third-party'])
    vi.spyOn(service, 'composition').mockResolvedValue([{ id: 'a', name: '@deepseek-ai/core' }])
    const runtime = { manifest: { dshVersion: '0.1.3-alpha.1' } } as InstalledRuntime
    const diagnostic = 'failed to import loader entry aa (third-party): Cannot find package "missing"'
    expect(await service.quarantine(runtime, {}, diagnostic)).toBe(false)
    expect(await service.list()).toEqual([])
  })
})
