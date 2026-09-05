import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  prepareOverlay: vi.fn(),
  prepareCliShim: vi.fn(),
  startBackend: vi.fn(),
}))

vi.mock('../src/goal-guard-overlay.ts', () => ({ prepareGoalGuardOverlay: mocks.prepareOverlay }))
vi.mock('../src/backend.ts', () => ({
  desktopEnvironment: (_runtime: unknown, environment: unknown) => environment,
  startBackend: mocks.startBackend,
}))
vi.mock('../src/cli-shell.ts', () => ({ prepareCliShim: mocks.prepareCliShim }))

import type { RuntimeCatalog, RuntimeManifest, RuntimePreference } from '../src/catalog.ts'
import { RuntimeController, type RuntimeView } from '../src/runtime-controller.ts'

function manifest(version: string): RuntimeManifest {
  return {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    dshVersion: version,
    runtimeRevision: 1,
    requiredShellRange: '>=0.1.0',
    platform: 'win32',
    arch: 'x64',
    source: {
      repository: 'https://github.com/deepseek-ai/deepseek-harness.git',
      tag: 'dsh-v' + version,
      commit: version.startsWith('0.1.1') ? 'b'.repeat(40) : 'a'.repeat(40),
    },
    archive: { url: 'https://example.test/' + version + '.zip', sha256: (version.startsWith('0.1.1') ? 'd' : 'c').repeat(64), size: 1 },
    paths: { node: 'node.exe', pnpm: 'pnpm.cmd', dsh: 'dsh.cjs' },
  }
}

function catalog(...releases: RuntimeManifest[]): RuntimeCatalog {
  return { schemaVersion: 1, generatedAt: new Date().toISOString(), releases }
}

function installed(value: RuntimeManifest) {
  return {
    directory: 'C:/runtime/' + value.dshVersion,
    manifest: value,
    nodeExecutable: 'C:/runtime/' + value.dshVersion + '/node.exe',
    pnpmExecutable: 'C:/runtime/' + value.dshVersion + '/pnpm.cmd',
    dshBin: 'C:/runtime/' + value.dshVersion + '/dsh.cjs',
  }
}

function createController(store: Record<string, unknown>, onView: (view: RuntimeView) => void = vi.fn()) {
  return new RuntimeController({
    shellVersion: '0.1.20',
    store: store as any,
    shutdownHook: 'C:/shutdown-hook.js',
    userData: 'C:/user-data',
    goalGuardPlugin: 'C:/goal-guard.js',
    environment: { DSH_HOME: 'C:/dsh-home' },
    onView,
    onReady: vi.fn(async () => {}),
    onOpenSettingsDocument: vi.fn(async () => {}),
  })
}

beforeEach(() => {
  mocks.prepareOverlay.mockReset().mockResolvedValue(undefined)
  mocks.prepareCliShim.mockReset().mockResolvedValue('C:/cli')
  mocks.startBackend.mockReset()
})

describe('RuntimeController catalog refresh', () => {
  it('refreshes catalog-backed versions without restarting the running backend', async () => {
    const oldRelease = manifest('0.1.0-rc.7')
    const newRelease = manifest('0.1.1-rc.2')
    const stop = vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' }))
    const store = {
      loadCatalog: vi.fn()
        .mockResolvedValueOnce({ catalog: catalog(oldRelease), cached: false })
        .mockResolvedValueOnce({ catalog: catalog(newRelease, oldRelease), cached: false }),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference: { mode: 'latest-compatible' as const }, currentVersion: oldRelease.dshVersion })),
      installed: vi.fn(async (version: string) => version === oldRelease.dshVersion ? installed(oldRelease) : undefined),
    }
    const controller = createController(store)
    ;(controller as any).backend = { stop }

    expect((await controller.refreshCatalog()).versions.map(version => version.version)).toEqual([oldRelease.dshVersion])
    const refreshed = await controller.refreshCatalog()

    expect(refreshed.versions.map(version => version.version)).toEqual([newRelease.dshVersion, oldRelease.dshVersion])
    expect(stop).not.toHaveBeenCalled()
  })

  it('switches an old-version user using only the selected catalog manifest', async () => {
    const oldRelease = manifest('0.1.0-rc.7')
    const newRelease = manifest('0.1.1-rc.2')
    let preference: RuntimePreference = { mode: 'pinned', version: oldRelease.dshVersion }
    const install = vi.fn(async (release: RuntimeManifest) => installed(release))
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(newRelease, oldRelease), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
      setPreference: vi.fn(async (next: RuntimePreference) => {
        preference = next
        return { schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion }
      }),
      installed: vi.fn(async (version: string) => version === oldRelease.dshVersion ? installed(oldRelease) : undefined),
      install,
      promote: vi.fn(async (version: string) => ({ schemaVersion: 1, preference, currentVersion: version })),
    }
    mocks.startBackend.mockResolvedValue({
      url: new URL('http://127.0.0.1:43123/'),
      done: new Promise(() => {}),
      stop: vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' })),
    })
    const controller = createController(store)

    await controller.refreshCatalog()
    await controller.setPreference({ mode: 'pinned', version: newRelease.dshVersion })

    expect(install).toHaveBeenCalledOnce()
    expect(install).toHaveBeenCalledWith(newRelease, expect.any(Function))
    expect(controller.snapshot().currentVersion).toBe(newRelease.dshVersion)
  })

  it('publishes source-build stages and cleans the busy state after failure', async () => {
    const release = manifest('0.1.1-rc.2')
    let preference: RuntimePreference = { mode: 'latest-compatible' }
    const views: RuntimeView[] = []
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(release), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference })),
      setPreference: vi.fn(async (next: RuntimePreference) => { preference = next; return { schemaVersion: 1, preference } }),
      installed: vi.fn(async () => undefined),
      install: vi.fn(async (_release: RuntimeManifest, progress: (value: { stage: string; received: number; total: number }) => void) => {
        for (const stage of ['cloning', 'installing', 'building', 'assembling']) progress({ stage, received: 0, total: 0 })
        throw new Error('source build failed')
      }),
    }
    const controller = createController(store, view => { views.push(view) })

    await controller.refreshCatalog()
    await controller.setPreference({ mode: 'pinned', version: release.dshVersion })

    expect(views.map(view => view.message)).toEqual(expect.arrayContaining([
      '正在克隆 DSH 0.1.1-rc.2 源码',
      '正在安装 DSH 0.1.1-rc.2 构建依赖',
      '正在构建 DSH 0.1.1-rc.2',
      '正在准备 DSH 0.1.1-rc.2 Runtime',
    ]))
    expect(controller.snapshot()).toMatchObject({ phase: 'error', error: 'source build failed' })
    expect(controller.snapshot().progress).toBeUndefined()
  })

  it('rejects a version absent from the validated catalog without installing it', async () => {
    const oldRelease = manifest('0.1.0-rc.7')
    let preference: RuntimePreference = { mode: 'pinned', version: oldRelease.dshVersion }
    const install = vi.fn()
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(oldRelease), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
      setPreference: vi.fn(async (next: RuntimePreference) => { preference = next; return { schemaVersion: 1, preference } }),
      installed: vi.fn(async (version: string) => version === oldRelease.dshVersion ? installed(oldRelease) : undefined),
      install,
    }
    const controller = createController(store)

    await controller.refreshCatalog()
    await controller.setPreference({ mode: 'pinned', version: '9.9.9' })

    expect(install).not.toHaveBeenCalled()
    expect(controller.snapshot().phase).toBe('error')
    expect(controller.snapshot().error).toContain('unavailable or incompatible')
  })
})
