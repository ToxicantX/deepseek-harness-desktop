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

function controller(onReady = vi.fn(async () => {})) {
  return new RuntimeController({
    shellVersion: '0.1.16',
    store: { promote: vi.fn(async () => ({ schemaVersion: 1, preference: { mode: 'latest-compatible' } })) } as any,
    shutdownHook: 'C:/shutdown-hook.js',
    userData: 'C:/user-data',
    goalGuardPlugin: 'C:/resources/goal-no-progress-guard/index.js',
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
