import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepareOverlay: vi.fn(),
  startBackend: vi.fn(),
}))

vi.mock('../src/goal-guard-overlay.ts', () => ({ prepareGoalGuardOverlay: mocks.prepareOverlay }))
vi.mock('../src/backend.ts', () => ({
  desktopEnvironment: (_runtime: unknown, environment: unknown) => environment,
  startBackend: mocks.startBackend,
}))
vi.mock('../src/cli-shell.ts', () => ({ prepareCliShim: vi.fn(async () => 'cli-directory') }))

import { RuntimeController } from '../src/runtime-controller.ts'

function runtime() {
  return {
    directory: 'C:/runtime',
    manifest: { dshVersion: '0.1.0-rc.8', runtimeRevision: 1 },
    nodeExecutable: 'C:/runtime/node.exe',
    pnpmExecutable: 'C:/runtime/pnpm.cmd',
    dshBin: 'C:/runtime/dsh.cjs',
  } as any
}

function controller(
  onReady = vi.fn(async () => {}),
  pluginIsolation?: any,
  preparePluginPresetCompatibility: (input: any) => Promise<string | undefined> = vi.fn(async () => undefined),
  inspectAgentPresetSchema?: any,
  inspectPluginPreset?: any,
) {
  return new RuntimeController({
    shellVersion: '0.1.16',
    store: { promote: vi.fn(async () => ({ schemaVersion: 1, preference: { mode: 'latest-compatible' } })) } as any,
    shutdownHook: 'C:/shutdown-hook.js',
    userData: 'C:/user-data',
    goalGuardPlugin: 'C:/resources/goal-no-progress-guard/index.js',
    ...(pluginIsolation === undefined ? {} : { pluginIsolation }),
    preparePluginPresetCompatibility,
    ...(inspectAgentPresetSchema === undefined ? {} : { inspectAgentPresetSchema }),
    ...(inspectPluginPreset === undefined ? {} : { inspectPluginPreset }),
    environment: { DSH_HOME: 'C:/dsh-home' },
    onView: vi.fn(),
    onReady,
    onOpenSettingsDocument: vi.fn(async () => {}),
  })
}

beforeEach(() => {
  mocks.prepareOverlay.mockReset()
  mocks.startBackend.mockReset()
})

describe('RuntimeController goal guard overlay', () => {
  it('automatically migrates the exact DSH 0.1.3 preset schema error before retrying', async () => {
    const apply = vi.fn(async () => {})
    const inspect = vi.fn(async (input: { diagnostics?: string }) => input.diagnostics === undefined
      ? undefined
      : ({ presetId: 'multi-model-orchestrator', mode: 'ptc', apply }))
    mocks.startBackend
      .mockRejectedValueOnce(new Error('failed to apply loader entry tool-presentation (@deepseek-ai/dsh-agent-tool-presentation): invalid config: $.mode expected "native" | "ptc" | "both", but got "code" at C:/dsh/.agent-presets/multi-model-orchestrator/agent.cordis.yml'))
      .mockResolvedValue({ url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop: vi.fn() })

    await (controller(undefined, undefined, undefined, inspect) as any).launch(runtime())

    expect(inspect).toHaveBeenCalledTimes(3)
    expect(apply).toHaveBeenCalledOnce()
    expect(mocks.startBackend).toHaveBeenCalledTimes(2)
  })

  it('automatically isolates a preset conflict when Runtime only reports an early exit', async () => {
    const disable = vi.fn(async () => {})
    const isolation = { supported: () => true, packages: vi.fn(async () => ['dsh-multi-model-orchestrator']), disable, prepare: vi.fn(async () => undefined), quarantine: vi.fn(async () => false) }
    const inspectPluginPreset = vi.fn(async (input: { diagnostics?: string }) => input.diagnostics === undefined
      ? undefined
      : ({ pluginName: 'dsh-multi-model-orchestrator', presetId: 'multi-model-orchestrator', apply: vi.fn(async () => {}) }))
    mocks.startBackend
      .mockRejectedValueOnce(new Error('DSH runtime exited before readiness: exit code 1'))
      .mockResolvedValue({ url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop: vi.fn() })

    await (controller(undefined, isolation, undefined, undefined, inspectPluginPreset) as any).launch(runtime())

    expect(disable).toHaveBeenCalledWith('dsh-multi-model-orchestrator', 'preset-conflict')
    expect(mocks.startBackend).toHaveBeenCalledTimes(2)
    expect(isolation.quarantine).not.toHaveBeenCalled()
  })

  it('isolates the third-party plugin when its preset reset fails, then restarts DSH', async () => {
    const disable = vi.fn(async () => {})
    const isolation = { supported: () => true, packages: vi.fn(async () => ['dsh-multi-model-orchestrator']), disable }
    const value = controller(undefined, isolation)
    const boot = vi.fn(async () => {})
    ;(value as any).boot = boot
    ;(value as any).selectedRuntime = runtime()
    ;(value as any).recoveryPlan = {
      kind: 'plugin-preset-conflict',
      plan: { pluginName: 'dsh-multi-model-orchestrator', presetId: 'multi-model-orchestrator', apply: vi.fn(async () => { throw new Error('preset reset failed') }) },
    }

    await value.recoverPluginPreset()

    expect(disable).toHaveBeenCalledWith('dsh-multi-model-orchestrator', 'preset-conflict')
    expect(boot).toHaveBeenCalledOnce()
  })

  it('isolates the plugin when reset succeeds but the restarted Runtime rewrites the old schema', async () => {
    const disable = vi.fn(async () => {})
    const isolation = { supported: () => true, packages: vi.fn(async () => ['dsh-multi-model-orchestrator']), disable }
    const value = controller(undefined, isolation)
    ;(value as any).selectedRuntime = runtime()
    const boot = vi.fn()
      .mockRejectedValueOnce(new Error('invalid config: $.mode expected "native" | "ptc" | "both", but got "code"'))
      .mockResolvedValueOnce(undefined)
    ;(value as any).boot = boot
    ;(value as any).recoveryPlan = {
      kind: 'plugin-preset-conflict',
      plan: { pluginName: 'dsh-multi-model-orchestrator', presetId: 'multi-model-orchestrator', apply: vi.fn(async () => {}) },
    }

    await value.recoverPluginPreset()

    expect(disable).toHaveBeenCalledWith('dsh-multi-model-orchestrator', 'preset-conflict')
    expect(boot).toHaveBeenCalledTimes(2)
  })

  it('bounds automatic quarantine retries after both backend and frontend failures', async () => {
    const isolation = { prepare: vi.fn(), quarantine: vi.fn(async () => true) }
    mocks.startBackend.mockRejectedValue(new Error('backend import failure'))
    await expect((controller(undefined, isolation) as any).launch(runtime())).rejects.toThrow('backend import failure')
    expect(mocks.startBackend).toHaveBeenCalledTimes(4)
    expect(isolation.quarantine).toHaveBeenCalledTimes(3)

    mocks.startBackend.mockReset()
    isolation.quarantine.mockClear()
    const stop = vi.fn(async () => {})
    mocks.startBackend.mockResolvedValue({ url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop })
    await expect((controller(vi.fn(async () => { throw new Error('client import failure') }), isolation) as any).launch(runtime())).rejects.toThrow('client import failure')
    expect(stop).toHaveBeenCalledTimes(4)
    expect(isolation.quarantine).toHaveBeenCalledTimes(3)
  })

  it('does not automatically retry a validation trial and restores the disabled launch', async () => {
    const isolation = {
      supported: () => true,
      packages: async () => ['third-party'],
      prepare: vi.fn(async (_runtime, _environment, trial) => {
        if (trial) throw new Error('still incompatible')
      }),
      quarantine: vi.fn(),
      validate: vi.fn(async (_name, attempt) => { await attempt() }),
    }
    const value = controller(undefined, isolation)
    ;(value as any).selectedRuntime = runtime()
    mocks.startBackend.mockResolvedValue({ url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop: vi.fn() })
    await expect(value.setPluginEnabled('third-party', true)).rejects.toThrow('still incompatible')
    expect(isolation.prepare.mock.calls.map(call => call[2])).toEqual(['third-party', undefined])
    expect(isolation.quarantine).not.toHaveBeenCalled()
    expect(value.snapshot().phase).toBe('ready')
  })

  it('prepares the overlay and forwards its patch and cleanup', async () => {
    const dispose = vi.fn(async () => {})
    mocks.prepareOverlay.mockResolvedValue({ path: 'C:/user-data/runtime-overlays/goal.yml', dispose })
    const backend = { url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop: vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' })) }
    mocks.startBackend.mockResolvedValue(backend)

    const value = controller()
    await (value as any).launch(runtime())
    expect(mocks.prepareOverlay).toHaveBeenCalledWith({
      runtime: runtime(),
      pluginFile: 'C:/resources/goal-no-progress-guard/index.js',
      directory: join('C:/user-data', 'runtime-overlays'),
    })
    const options = mocks.startBackend.mock.calls[0]![0]
    expect(options.additionalPatches).toEqual(['C:/user-data/runtime-overlays/goal.yml'])
    await options.cleanup()
    await options.cleanup()
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('keeps starting the Runtime when preset compatibility preparation fails', async () => {
    const preparePreset = vi.fn(async () => { throw new Error('preset migration failed') })
    const backend = { url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop: vi.fn() }
    mocks.startBackend.mockResolvedValue(backend)

    await expect((controller(undefined, undefined, preparePreset) as any).launch(runtime())).resolves.toBeUndefined()
    expect(preparePreset).toHaveBeenCalledWith({ home: 'C:/dsh-home', runtime: runtime() })
    expect(mocks.startBackend).toHaveBeenCalledOnce()
  })

  it('releases only the repaired removed-client-runtime isolation before launch', async () => {
    const release = vi.fn(async () => true)
    const isolation = { prepare: vi.fn(), quarantine: vi.fn(), releaseRemovedClientRuntime: release }
    const preparePreset = vi.fn(async () => 'dsh-multi-model-orchestrator')
    mocks.startBackend.mockResolvedValue({ url: new URL('http://127.0.0.1:43123/'), done: new Promise(() => {}), stop: vi.fn() })

    await (controller(undefined, isolation, preparePreset) as any).launch(runtime())
    expect(release).toHaveBeenCalledWith('dsh-multi-model-orchestrator')
    expect(release.mock.invocationCallOrder[0]).toBeLessThan(isolation.prepare.mock.invocationCallOrder[0]!)
  })

  it('stops the backend and disposes the overlay when post-start setup fails', async () => {
    const dispose = vi.fn(async () => {})
    const stop = vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' }))
    mocks.prepareOverlay.mockResolvedValue({ path: 'C:/overlay.yml', dispose })
    mocks.startBackend.mockImplementation(async (options) => ({
      url: new URL('http://127.0.0.1:43123/'),
      done: new Promise(() => {}),
      stop: vi.fn(async () => {
        await options.cleanup?.()
        return stop()
      }),
    }))
    const value = controller(vi.fn(async () => { throw new Error('window failed') }))

    await expect((value as any).launch(runtime())).rejects.toThrow('window failed')
    expect(stop).toHaveBeenCalledOnce()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('disposes the prepared overlay when backend startup fails', async () => {
    const dispose = vi.fn(async () => {})
    mocks.prepareOverlay.mockResolvedValue({ path: 'C:/overlay.yml', dispose })
    mocks.startBackend.mockRejectedValue(new Error('backend failed'))
    const value = controller()

    await expect((value as any).launch(runtime())).rejects.toThrow('backend failed')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})
