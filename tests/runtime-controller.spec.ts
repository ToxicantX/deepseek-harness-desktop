import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/backend.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/backend.ts')>()
  return { ...original, startBackend: vi.fn() }
})
vi.mock('../src/cli-shell.ts', () => ({ prepareCliShim: vi.fn(async () => 'C:\\cli') }))

import { startBackend, type RunningBackend } from '../src/backend.ts'
import type { RuntimeCatalog, RuntimeManifest } from '../src/catalog.ts'
import { RuntimeController, type RuntimeControllerOptions, type RuntimeView } from '../src/runtime-controller.ts'
import { RuntimeStore, type InstalledRuntime, type RuntimeState } from '../src/runtime-store.ts'

function manifest(version: string): RuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    runtimeRevision: 0,
    dshVersion: version,
    requiredShellRange: '>=0.1.0 <1.0.0',
    platform: 'win32',
    arch: 'x64',
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      tag: `dsh-v${version}`,
      commit: 'a'.repeat(40),
    },
    archive: {
      url: `https://example.test/${version}.zip`,
      size: 1,
      sha256: 'b'.repeat(64),
    },
    paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/bin.js' },
  }
}

function installed(value: RuntimeManifest): InstalledRuntime {
  const directory = join('C:\\runtime', value.dshVersion)
  return {
    manifest: value,
    directory,
    nodeExecutable: join(directory, value.paths.node),
    pnpmExecutable: join(directory, value.paths.pnpm),
    dshBin: join(directory, value.paths.dsh),
  }
}

function started(): RunningBackend {
  return {
    url: new URL('http://127.0.0.1:45678'),
    done: new Promise(() => {}),
    stop: vi.fn(async () => ({ exitCode: 130, signal: null, diagnostics: '' })),
  }
}

function harness(
  state: RuntimeState,
  catalog: RuntimeCatalog,
  inspectStaleLocalPlugins: NonNullable<RuntimeControllerOptions['inspectStaleLocalPlugins']> = vi.fn(async () => undefined),
  inspectPluginPreset: NonNullable<RuntimeControllerOptions['inspectPluginPreset']> = vi.fn(async () => undefined),
) {
  const store = new RuntimeStore('C:\\store')
  const views: RuntimeView[] = []
  vi.spyOn(store, 'readState').mockResolvedValue(state)
  vi.spyOn(store, 'loadCatalog').mockResolvedValue({ catalog, cached: false })
  vi.spyOn(store, 'install').mockImplementation(async value => installed(value))
  vi.spyOn(store, 'promote').mockImplementation(async version => ({ ...state, currentVersion: version }))
  const controller = new RuntimeController({
    shellVersion: '0.1.0',
    store,
    shutdownHook: 'C:\\shutdown-hook.js',
    userData: 'C:\\user-data',
    environment: { DSH_HOME: process.cwd() },
    inspectStaleLocalPlugins,
    inspectPluginPreset,
    onView: view => { views.push(view) },
    onReady: vi.fn(async () => {}),
    onOpenSettingsDocument: vi.fn(async () => {}),
  })
  return { controller, store, views, inspectStaleLocalPlugins, inspectPluginPreset }
}

beforeEach(() => { vi.mocked(startBackend).mockReset() })

describe('RuntimeController', () => {
  it('promotes a selected version only after backend readiness', async () => {
    const target = manifest('0.1.0-rc.8')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target] }
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' } },
      catalog,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(undefined)
    vi.mocked(startBackend).mockResolvedValue(started())
    const promote = vi.mocked(store.promote)

    await controller.start()

    expect(startBackend).toHaveBeenCalledOnce()
    expect(promote).toHaveBeenCalledWith(target.dshVersion)
    expect(vi.mocked(startBackend).mock.invocationCallOrder[0]).toBeLessThan(promote.mock.invocationCallOrder[0] ?? 0)
    expect(views.at(-1)).toMatchObject({ phase: 'ready', currentVersion: target.dshVersion })
  })

  it('retains the selected Runtime when Web readiness fails', async () => {
    const target = manifest('0.1.0-rc.7')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target] }
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' } },
      catalog,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(installed(target))
    vi.mocked(startBackend).mockRejectedValue(new Error('plugin readiness failed'))

    await controller.start()

    expect(controller.installedRuntime()).toEqual(installed(target))
    expect(views.at(-1)).toMatchObject({ phase: 'error' })
  })

  it('offers exact stale local plugin recovery and retries only after apply', async () => {
    const target = manifest('0.1.0-rc.7')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target] }
    const apply = vi.fn(async () => ({ removedEntryIds: ['web-search-exa-local'], count: 1 }))
    const inspect = vi.fn(async () => ({ entryIds: ['web-search-exa-local'], count: 1, apply }))
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' } },
      catalog,
      inspect,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(installed(target))
    vi.mocked(startBackend)
      .mockRejectedValueOnce(new Error('failed to import loader entry web-search-exa-local'))
      .mockResolvedValueOnce(started())

    await controller.start()

    expect(inspect).toHaveBeenCalledWith({
      home: process.cwd(),
      diagnostics: 'failed to import loader entry web-search-exa-local',
    })
    expect(apply).not.toHaveBeenCalled()
    expect(views.at(-1)).toMatchObject({
      phase: 'error',
      recovery: { kind: 'stale-local-plugins', entryIds: ['web-search-exa-local'], count: 1 },
    })

    await controller.recoverStaleLocalPlugins()

    expect(apply).toHaveBeenCalledOnce()
    expect(startBackend).toHaveBeenCalledTimes(2)
    expect(views.at(-1)).toMatchObject({ phase: 'ready' })
    expect(views.at(-1)?.recovery).toBeUndefined()
  })

  it('offers exact plugin preset recovery, applies it only after confirmation, and retries', async () => {
    const target = manifest('0.1.0-rc.7')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target] }
    const apply = vi.fn(async () => ({ pluginName: 'dsh-multi-model-orchestrator', presetId: 'multi-model-orchestrator' }))
    const inspectPreset = vi.fn(async () => ({
      pluginName: 'dsh-multi-model-orchestrator',
      presetId: 'multi-model-orchestrator',
      apply,
    }))
    const inspectStale = vi.fn(async () => undefined)
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' } },
      catalog,
      inspectStale,
      inspectPreset,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(installed(target))
    vi.mocked(startBackend)
      .mockRejectedValueOnce(new Error('agent.cordis.yml does not match the packaged preset'))
      .mockResolvedValueOnce(started())

    await controller.start()

    expect(inspectPreset).toHaveBeenCalledWith({
      home: process.cwd(),
      runtime: installed(target),
      diagnostics: 'agent.cordis.yml does not match the packaged preset',
      environment: { DSH_HOME: process.cwd() },
    })
    expect(apply).not.toHaveBeenCalled()
    expect(views.at(-1)).toMatchObject({
      phase: 'error',
      recovery: {
        kind: 'plugin-preset-conflict',
        pluginName: 'dsh-multi-model-orchestrator',
        presetId: 'multi-model-orchestrator',
      },
    })
    await expect(controller.recoverStaleLocalPlugins()).rejects.toThrow('失效本地插件')

    await controller.recoverPluginPreset()

    expect(apply).toHaveBeenCalledOnce()
    expect(startBackend).toHaveBeenCalledTimes(2)
    expect(views.at(-1)).toMatchObject({ phase: 'ready' })
    expect(views.at(-1)?.recovery).toBeUndefined()
  })

  it('stops a ready backend before plugin files are mutated', async () => {
    const target = manifest('0.1.0-rc.7')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target] }
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' } },
      catalog,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(installed(target))
    const backend = started()
    vi.mocked(startBackend).mockResolvedValue(backend)
    await controller.start()

    await controller.pauseForPluginMutation()

    expect(backend.stop).toHaveBeenCalledOnce()
    expect(controller.installedRuntime()).toEqual(installed(target))
    expect(views.at(-1)).toMatchObject({ phase: 'starting', message: '正在应用插件变更' })
  })

  it('does not replace the Runtime error when recovery inspection fails', async () => {
    const target = manifest('0.1.0-rc.7')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target] }
    const inspect = vi.fn(async () => { throw new Error('recovery inspection failed') })
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' } },
      catalog,
      inspect,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(installed(target))
    vi.mocked(startBackend).mockRejectedValue(new Error('original readiness failure'))

    await controller.start()

    expect(views.at(-1)).toMatchObject({ phase: 'error', error: 'original readiness failure' })
    expect(views.at(-1)?.recovery).toBeUndefined()
  })

  it('restarts the previous revision when a same-version revision update fails', async () => {
    const previous = manifest('0.1.0-rc.7')
    const selected = {
      ...previous,
      runtimeRevision: 1,
      archive: { ...previous.archive, sha256: 'c'.repeat(64) },
    }
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [selected] }
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' }, currentVersion: previous.dshVersion },
      catalog,
    )
    vi.spyOn(store, 'installed').mockResolvedValue(installed(previous))
    vi.mocked(store.install).mockRejectedValue(new Error('revision publication failed'))
    vi.mocked(startBackend).mockResolvedValue(started())

    await controller.start()

    expect(store.install).toHaveBeenCalledWith(selected, expect.any(Function))
    expect(startBackend).toHaveBeenCalledWith(expect.objectContaining({ runtime: expect.objectContaining({ manifest: previous }) }))
    expect(views.some(view => view.phase === 'starting' && view.message.includes('继续使用 DSH 0.1.0-rc.7'))).toBe(true)
    expect(views.at(-1)).toMatchObject({ phase: 'ready', currentVersion: previous.dshVersion })
  })

  it('falls back to the current compatible runtime when the target fails readiness', async () => {
    const current = manifest('0.1.0-rc.7')
    const target = manifest('0.1.0-rc.8')
    const catalog = { schemaVersion: 1 as const, generatedAt: new Date().toISOString(), releases: [target, current] }
    const { controller, store, views } = harness(
      { schemaVersion: 1, preference: { mode: 'latest-compatible' }, currentVersion: current.dshVersion },
      catalog,
    )
    vi.spyOn(store, 'installed').mockImplementation(async version => {
      if (version === target.dshVersion) return installed(target)
      if (version === current.dshVersion) return installed(current)
      return undefined
    })
    vi.mocked(startBackend)
      .mockRejectedValueOnce(new Error('target readiness failed'))
      .mockResolvedValueOnce(started())

    await controller.start()

    expect(startBackend).toHaveBeenCalledTimes(2)
    expect(store.promote).toHaveBeenCalledOnce()
    expect(store.promote).toHaveBeenCalledWith(current.dshVersion)
    expect(views.at(-1)).toMatchObject({ phase: 'ready', currentVersion: current.dshVersion })
    expect(views.some(view => view.phase === 'starting' && view.message.includes('继续使用'))).toBe(true)
  })
})
