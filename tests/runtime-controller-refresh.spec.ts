import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import {
  RuntimeController,
  type RuntimeControllerOptions,
  type RuntimeView,
} from '../src/runtime-controller.ts'
import {
  beginRuntimeConfigProtection,
  RuntimeConfigurationLossError,
} from '../src/runtime-config-protection.ts'

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

function createController(
  store: Record<string, unknown>,
  onView: (view: RuntimeView) => void = vi.fn(),
  home = 'C:/dsh-home',
  options: Partial<RuntimeControllerOptions> = {},
) {
  return new RuntimeController({
    shellVersion: '0.1.20',
    store: store as any,
    shutdownHook: 'C:/shutdown-hook.js',
    userData: 'C:/user-data',
    goalGuardPlugin: 'C:/goal-guard.js',
    environment: { DSH_HOME: home },
    onView,
    onReady: vi.fn(async () => {}),
    onOpenSettingsDocument: vi.fn(async () => {}),
    beginRuntimeConfigProtection: vi.fn(async () => undefined),
    recoverPendingRuntimeConfigProtection: vi.fn(async () => undefined),
    loadLatestUpstreamVersion: vi.fn(async () => '0.1.7-alpha.2'),
    ...options,
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
    expect(refreshed.upstream).toEqual({ version: '0.1.7-alpha.2', status: 'pending' })
    expect(mocks.startBackend).not.toHaveBeenCalled()
  })

  it.each(['available', 'shell-required', 'error'] as const)('reports upstream %s without admitting unvalidated versions', async status => {
    const release = manifest('0.1.7-alpha.2')
    if (status === 'shell-required') release.requiredShellRange = '>=0.1.51'
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(release), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference: { mode: 'latest-compatible' as const } })),
      installed: vi.fn(async () => undefined),
    }
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      loadLatestUpstreamVersion: vi.fn(async () => {
        if (status === 'error') throw new Error('HTTP 403')
        return release.dshVersion
      }),
    })
    const view = await controller.refreshCatalog()
    expect(view.upstream).toEqual(status === 'error' ? { status } : { status, version: release.dshVersion })
    expect(view.versions).toHaveLength(status === 'shell-required' ? 0 : 1)
    expect(mocks.startBackend).not.toHaveBeenCalled()
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

  it('rejects a pinned switch when startup falls back to the previous runtime', async () => {
    const oldRelease = manifest('0.1.0-rc.7')
    const newRelease = manifest('0.1.1-rc.2')
    let preference: RuntimePreference = { mode: 'pinned', version: oldRelease.dshVersion }
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(newRelease, oldRelease), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
      setPreference: vi.fn(async (next: RuntimePreference) => {
        preference = next
        return { schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion }
      }),
      installed: vi.fn(async (version: string) => version === oldRelease.dshVersion ? installed(oldRelease) : undefined),
      install: vi.fn(async () => { throw new Error('source build failed') }),
      promote: vi.fn(async (version: string) => ({ schemaVersion: 1, preference, currentVersion: version })),
    }
    mocks.startBackend.mockResolvedValue({
      url: new URL('http://127.0.0.1:43123/'),
      done: new Promise(() => {}),
      stop: vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' })),
    })
    const controller = createController(store)

    await controller.refreshCatalog()

    await expect(controller.setPreference({ mode: 'pinned', version: newRelease.dshVersion }))
      .rejects.toThrow(`DSH ${newRelease.dshVersion} 启动失败，已继续使用 DSH ${oldRelease.dshVersion}\n\n启动诊断：source build failed`)

    expect(controller.snapshot()).toMatchObject({
      phase: 'error',
      currentVersion: oldRelease.dshVersion,
      error: `DSH ${newRelease.dshVersion} 启动失败，已继续使用 DSH ${oldRelease.dshVersion}\n\n启动诊断：source build failed`,
    })
  })

  it('restores legacy model configuration before starting the fallback Runtime', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-controller-config-'))
    try {
      const profile = join(home, 'profiles', 'web')
      const settings = join(home, 'settings.yaml')
      const imported = settings + '.imported'
      const patch = join(profile, 'cordis.patch.yml')
      const legacy = 'agent-default-model:\n  provider: openai\n  model: gpt-test\n'
      const previousImported = 'ui-onboarding:\n  welcomeNoticeVersion: previous\n'
      const previousPatch = '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: previous\n'
      await mkdir(profile, { recursive: true })
      await writeFile(settings, legacy)
      await writeFile(imported, previousImported)
      await writeFile(patch, previousPatch)

      const oldRelease = manifest('0.1.6-alpha.2')
      const newRelease = manifest('0.1.7-alpha.1')
      const preference: RuntimePreference = { mode: 'latest-compatible' }
      const store = {
        loadCatalog: vi.fn(async () => ({ catalog: catalog(newRelease, oldRelease), cached: false })),
        readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
        installed: vi.fn(async (version: string) => version === newRelease.dshVersion ? installed(newRelease) : installed(oldRelease)),
        promote: vi.fn(async (version: string) => ({ schemaVersion: 1, preference, currentVersion: version })),
      }
      mocks.startBackend.mockImplementation(async ({ runtime }: { runtime: ReturnType<typeof installed> }) => {
        if (runtime.manifest.dshVersion === newRelease.dshVersion) {
          await rm(settings)
          await writeFile(imported, legacy)
          await writeFile(patch, '[]\n')
          throw new Error('startup failed after settings migration')
        }
        expect(await readFile(settings, 'utf8')).toBe(legacy)
        expect(await readFile(imported, 'utf8')).toBe(previousImported)
        expect(await readFile(patch, 'utf8')).toBe(previousPatch)
        return {
          url: new URL('http://127.0.0.1:43123/'),
          done: new Promise(() => {}),
          stop: vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' })),
        }
      })
      const controller = createController(store, vi.fn(), home, { beginRuntimeConfigProtection })

      await controller.start()

      expect(mocks.startBackend).toHaveBeenCalledTimes(2)
      expect(controller.snapshot()).toMatchObject({
        phase: 'ready',
        currentVersion: oldRelease.dshVersion,
      })
      expect(await readFile(settings, 'utf8')).toBe(legacy)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })

  it('rolls back configuration before fallback when a ready Runtime lost model settings', async () => {
    const oldRelease = manifest('0.1.6-alpha.2')
    const newRelease = manifest('0.1.7-alpha.1')
    const preference: RuntimePreference = { mode: 'latest-compatible' }
    const events: string[] = []
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(newRelease, oldRelease), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
      installed: vi.fn(async (version: string) => version === newRelease.dshVersion ? installed(newRelease) : installed(oldRelease)),
      promote: vi.fn(async (version: string) => {
        events.push('promote-' + version)
        return { schemaVersion: 1, preference, currentVersion: version }
      }),
    }
    const protection = {
      backupDirectory: 'C:/dsh-home/.desktop-runtime-config/backups/test',
      verify: vi.fn(async () => {
        events.push('verify')
        throw new RuntimeConfigurationLossError(['llm-pi-ai'])
      }),
      commit: vi.fn(async () => { events.push('commit') }),
      rollback: vi.fn(async () => { events.push('rollback') }),
    }
    mocks.startBackend.mockImplementation(async ({ runtime }: { runtime: ReturnType<typeof installed> }) => {
      const version = runtime.manifest.dshVersion
      events.push('start-' + version)
      return {
        url: new URL('http://127.0.0.1:43123/'),
        done: new Promise(() => {}),
        stop: vi.fn(async () => {
          events.push('stop-' + version)
          return { exitCode: 0, signal: null, diagnostics: '' }
        }),
      }
    })
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      beginRuntimeConfigProtection: vi.fn(async () => protection),
      recoverPendingRuntimeConfigProtection: vi.fn(async () => undefined),
    })

    await controller.start()

    expect(events).toEqual([
      'start-' + newRelease.dshVersion,
      'verify',
      'stop-' + newRelease.dshVersion,
      'rollback',
      'start-' + oldRelease.dshVersion,
      'promote-' + oldRelease.dshVersion,
    ])
    expect(protection.commit).not.toHaveBeenCalled()
    expect(store.promote).not.toHaveBeenCalledWith(newRelease.dshVersion)
  })

  it('stops the new Runtime and rolls back before fallback when the config transaction cannot commit', async () => {
    const oldRelease = manifest('0.1.6-alpha.2')
    const newRelease = manifest('0.1.7-alpha.1')
    const preference: RuntimePreference = { mode: 'latest-compatible' }
    const events: string[] = []
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(newRelease, oldRelease), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
      installed: vi.fn(async (version: string) => version === newRelease.dshVersion ? installed(newRelease) : installed(oldRelease)),
      promote: vi.fn(async (version: string) => {
        events.push('promote-' + version)
        return { schemaVersion: 1, preference, currentVersion: version }
      }),
    }
    const protection = {
      backupDirectory: 'C:/dsh-home/.desktop-runtime-config/backups/test',
      verify: vi.fn(async () => { events.push('verify') }),
      commit: vi.fn(async () => {
        events.push('commit')
        throw new Error('pending journal is locked')
      }),
      rollback: vi.fn(async () => { events.push('rollback') }),
    }
    mocks.startBackend.mockImplementation(async ({ runtime }: { runtime: ReturnType<typeof installed> }) => {
      const version = runtime.manifest.dshVersion
      events.push('start-' + version)
      return {
        url: new URL('http://127.0.0.1:43123/'),
        done: new Promise(() => {}),
        stop: vi.fn(async () => {
          events.push('stop-' + version)
          return { exitCode: 0, signal: null, diagnostics: '' }
        }),
      }
    })
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      beginRuntimeConfigProtection: vi.fn(async () => protection),
      recoverPendingRuntimeConfigProtection: vi.fn(async () => undefined),
    })

    await controller.start()

    expect(events).toEqual([
      'start-' + newRelease.dshVersion,
      'verify',
      'commit',
      'stop-' + newRelease.dshVersion,
      'rollback',
      'start-' + oldRelease.dshVersion,
      'promote-' + oldRelease.dshVersion,
    ])
    expect(controller.snapshot()).toMatchObject({
      phase: 'ready',
      currentVersion: oldRelease.dshVersion,
    })
  })

  it('rolls back committed config when persisting the selected Runtime fails', async () => {
    const oldRelease = manifest('0.1.6-alpha.2')
    const newRelease = manifest('0.1.7-alpha.1')
    const preference: RuntimePreference = { mode: 'latest-compatible' }
    const events: string[] = []
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(newRelease, oldRelease), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: oldRelease.dshVersion })),
      installed: vi.fn(async (version: string) => version === newRelease.dshVersion ? installed(newRelease) : installed(oldRelease)),
      promote: vi.fn(async (version: string) => {
        events.push('promote-' + version)
        if (version === newRelease.dshVersion) throw new Error('state file is locked')
        return { schemaVersion: 1, preference, currentVersion: version }
      }),
    }
    const protection = {
      backupDirectory: 'C:/dsh-home/.desktop-runtime-config/backups/test',
      verify: vi.fn(async () => { events.push('verify') }),
      commit: vi.fn(async () => { events.push('commit') }),
      rollback: vi.fn(async () => { events.push('rollback') }),
    }
    mocks.startBackend.mockImplementation(async ({ runtime }: { runtime: ReturnType<typeof installed> }) => {
      const version = runtime.manifest.dshVersion
      events.push('start-' + version)
      return {
        url: new URL('http://127.0.0.1:43123/'),
        done: new Promise(() => {}),
        stop: vi.fn(async () => {
          events.push('stop-' + version)
          return { exitCode: 0, signal: null, diagnostics: '' }
        }),
      }
    })
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      beginRuntimeConfigProtection: vi.fn(async () => protection),
      recoverPendingRuntimeConfigProtection: vi.fn(async () => undefined),
    })

    await controller.start()

    expect(events).toEqual([
      'start-' + newRelease.dshVersion,
      'verify',
      'commit',
      'promote-' + newRelease.dshVersion,
      'stop-' + newRelease.dshVersion,
      'rollback',
      'start-' + oldRelease.dshVersion,
      'promote-' + oldRelease.dshVersion,
    ])
    expect(controller.snapshot()).toMatchObject({
      phase: 'ready',
      currentVersion: oldRelease.dshVersion,
    })
  })

  it('blocks startup and reports an error when pending model configuration cannot be restored', async () => {
    const release = manifest('0.1.7-alpha.1')
    const preference: RuntimePreference = { mode: 'latest-compatible' }
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(release), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: release.dshVersion })),
      installed: vi.fn(async () => installed(release)),
    }
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      recoverPendingRuntimeConfigProtection: vi.fn(async () => {
        throw new Error('snapshot checksum mismatch')
      }),
    })

    await controller.start()

    expect(controller.snapshot()).toMatchObject({
      phase: 'error',
      error: '模型配置自动恢复失败：snapshot checksum mismatch',
    })
    expect(store.loadCatalog).not.toHaveBeenCalled()
    expect(mocks.startBackend).not.toHaveBeenCalled()
  })

  it('protects configuration when installing a new revision of the current Runtime version', async () => {
    const previous = manifest('0.1.7-alpha.1')
    const update = manifest('0.1.7-alpha.1')
    previous.runtimeRevision = 1
    update.runtimeRevision = 2
    update.archive.sha256 = 'e'.repeat(64)
    const preference: RuntimePreference = { mode: 'latest-compatible' }
    const beginProtection = vi.fn(async () => undefined)
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(update), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: previous.dshVersion })),
      installed: vi.fn(async () => installed(previous)),
      install: vi.fn(async () => installed(update)),
      promote: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: update.dshVersion })),
    }
    mocks.startBackend.mockResolvedValue({
      url: new URL('http://127.0.0.1:43123/'),
      done: new Promise(() => {}),
      stop: vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' })),
    })
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      beginRuntimeConfigProtection: beginProtection,
      recoverPendingRuntimeConfigProtection: vi.fn(async () => undefined),
    })

    await controller.start()

    expect(store.install).toHaveBeenCalledWith(update, expect.any(Function))
    expect(beginProtection).toHaveBeenCalledWith({
      home: 'C:/dsh-home',
      fromVersion: previous.dshVersion,
      toVersion: update.dshVersion,
    })
  })

  it('protects the current Runtime when persisted state predates revision tracking', async () => {
    const release = manifest('0.1.7-alpha.1')
    release.runtimeRevision = 2
    const preference: RuntimePreference = { mode: 'latest-compatible' }
    const beginProtection = vi.fn(async () => undefined)
    const promote = vi.fn(async (version: string, runtimeRevision: number) => ({
      schemaVersion: 1 as const,
      preference,
      currentVersion: version,
      currentRuntimeRevision: runtimeRevision,
    }))
    const store = {
      loadCatalog: vi.fn(async () => ({ catalog: catalog(release), cached: false })),
      readState: vi.fn(async () => ({ schemaVersion: 1, preference, currentVersion: release.dshVersion })),
      installed: vi.fn(async () => installed(release)),
      promote,
    }
    mocks.startBackend.mockResolvedValue({
      url: new URL('http://127.0.0.1:43123/'),
      done: new Promise(() => {}),
      stop: vi.fn(async () => ({ exitCode: 0, signal: null, diagnostics: '' })),
    })
    const controller = createController(store, vi.fn(), 'C:/dsh-home', {
      beginRuntimeConfigProtection: beginProtection,
    })

    await controller.start()

    expect(beginProtection).toHaveBeenCalledWith({
      home: 'C:/dsh-home',
      fromVersion: release.dshVersion,
      toVersion: release.dshVersion,
    })
    expect(promote).toHaveBeenCalledWith(release.dshVersion, release.runtimeRevision)
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
    await expect(controller.setPreference({ mode: 'pinned', version: release.dshVersion }))
      .rejects.toThrow('source build failed')

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
    await expect(controller.setPreference({ mode: 'pinned', version: '9.9.9' }))
      .rejects.toThrow('unavailable or incompatible')

    expect(install).not.toHaveBeenCalled()
    expect(controller.snapshot().phase).toBe('error')
    expect(controller.snapshot().error).toContain('unavailable or incompatible')
  })
})
