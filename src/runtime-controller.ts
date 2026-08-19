import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  compatibleReleases,
  DEFAULT_CATALOG_URL,
  isReleaseCompatible,
  MINIMUM_DSH_VERSION,
  selectRuntime,
  type RuntimeCatalog,
  type RuntimePreference,
} from './catalog.ts'
import { desktopEnvironment, startBackend, type RunningBackend } from './backend.ts'
import { prepareCliShim } from './cli-shell.ts'
import { inspectPluginPresetRecovery, type PluginPresetRecoveryPlan } from './plugin-preset-recovery.ts'
import { RuntimeStore, type InstalledRuntime, type RuntimeState } from './runtime-store.ts'
import {
  inspectStaleLocalPluginRecovery,
  type StaleLocalPluginRecoveryPlan,
} from './stale-local-plugin-recovery.ts'

export type RuntimePhase = 'checking' | 'downloading' | 'starting' | 'ready' | 'error'

export interface RuntimeVersionView {
  version: string
  runtimeRevision: number
  requiredShellRange: string
  sourceTag: string
  installed: boolean
  current: boolean
}

export type RuntimeRecoveryView =
  | { kind: 'stale-local-plugins'; entryIds: string[]; count: number }
  | { kind: 'plugin-preset-conflict'; pluginName: string; presetId: string }

export interface RuntimeView {
  phase: RuntimePhase
  message: string
  shellVersion: string
  minimumDshVersion: string
  currentVersion?: string
  currentRuntimeRevision?: number
  preference: RuntimePreference
  versions: RuntimeVersionView[]
  cachedCatalog: boolean
  progress?: { received: number; total: number }
  recovery?: RuntimeRecoveryView
  error?: string
}

type StaleLocalPluginRecoveryInspector = typeof inspectStaleLocalPluginRecovery
type PluginPresetRecoveryInspector = typeof inspectPluginPresetRecovery
type RuntimeRecoveryPlan =
  | { kind: 'stale-local-plugins'; plan: StaleLocalPluginRecoveryPlan }
  | { kind: 'plugin-preset-conflict'; plan: PluginPresetRecoveryPlan }

export interface RuntimeControllerOptions {
  shellVersion: string
  store: RuntimeStore
  shutdownHook: string
  userData: string
  catalogUrl?: string
  environment?: NodeJS.ProcessEnv
  inspectStaleLocalPlugins?: StaleLocalPluginRecoveryInspector
  inspectPluginPreset?: PluginPresetRecoveryInspector
  onView(view: RuntimeView): void
  onReady(url: URL, runtime: InstalledRuntime, cliDirectory: string): Promise<void>
  onOpenSettingsDocument(path: string): Promise<void>
}

export class RuntimeController {
  private readonly shellVersion: string
  private readonly store: RuntimeStore
  private readonly shutdownHook: string
  private readonly userData: string
  private readonly catalogUrl: string
  private readonly environment: NodeJS.ProcessEnv
  private readonly inspectStaleLocalPlugins: StaleLocalPluginRecoveryInspector
  private readonly inspectPluginPreset: PluginPresetRecoveryInspector
  private readonly onView: (view: RuntimeView) => void
  private readonly onReady: (url: URL, runtime: InstalledRuntime, cliDirectory: string) => Promise<void>
  private readonly onOpenSettingsDocument: (path: string) => Promise<void>
  private catalog: RuntimeCatalog | undefined
  private state: RuntimeState = { schemaVersion: 1, preference: { mode: 'latest-compatible' } }
  private backend: RunningBackend | undefined
  private selectedRuntime: InstalledRuntime | undefined
  private recoveryPlan: RuntimeRecoveryPlan | undefined
  private expectedStop = false
  private currentRuntimeRevision: number | undefined
  private installedVersions = new Set<string>()
  private phase: RuntimePhase = 'checking'
  private message = '正在检查可用的 DSH 版本'
  private error: string | undefined
  private progress: { received: number; total: number } | undefined
  private cachedCatalog = false
  private pending: Promise<void> = Promise.resolve()

  constructor(options: RuntimeControllerOptions) {
    this.shellVersion = options.shellVersion
    this.store = options.store
    this.shutdownHook = options.shutdownHook
    this.userData = options.userData
    this.catalogUrl = options.catalogUrl ?? DEFAULT_CATALOG_URL
    this.environment = options.environment ?? process.env
    this.inspectStaleLocalPlugins = options.inspectStaleLocalPlugins ?? inspectStaleLocalPluginRecovery
    this.inspectPluginPreset = options.inspectPluginPreset ?? inspectPluginPresetRecovery
    this.onView = options.onView
    this.onReady = options.onReady
    this.onOpenSettingsDocument = options.onOpenSettingsDocument
  }

  start(): Promise<void> {
    return this.enqueue(async () => { await this.boot() })
  }

  retry(): Promise<void> {
    return this.enqueue(async () => { await this.boot() })
  }

  recoverStaleLocalPlugins(): Promise<void> {
    return this.enqueue(async () => {
      const recovery = this.recoveryPlan
      if (recovery?.kind !== 'stale-local-plugins') throw new Error('没有可恢复的失效本地插件')
      await recovery.plan.apply()
      this.recoveryPlan = undefined
      await this.boot()
    })
  }

  recoverPluginPreset(): Promise<void> {
    return this.enqueue(async () => {
      const recovery = this.recoveryPlan
      if (recovery?.kind !== 'plugin-preset-conflict') throw new Error('没有可恢复的冲突插件预设')
      await recovery.plan.apply()
      this.recoveryPlan = undefined
      await this.boot()
    })
  }

  pauseForPluginMutation(): Promise<void> {
    return this.enqueue(async () => {
      await this.stopBackend()
      this.update('starting', '正在应用插件变更')
    })
  }

  setPreference(preference: RuntimePreference): Promise<void> {
    return this.enqueue(async () => {
      this.state = await this.store.setPreference(preference)
      await this.stopBackend()
      await this.boot()
    })
  }

  stop(): Promise<void> {
    return this.enqueue(async () => { await this.stopBackend() })
  }

  installedRuntime(): InstalledRuntime | undefined {
    return this.selectedRuntime
  }

  snapshot(): RuntimeView {
    const versions = this.catalog === undefined
      ? []
      : compatibleReleases(this.catalog, this.shellVersion).map(release => ({
          version: release.dshVersion,
          runtimeRevision: release.runtimeRevision,
          requiredShellRange: release.requiredShellRange,
          sourceTag: release.source.tag,
          installed: this.installedVersions.has(release.dshVersion),
          current: this.state.currentVersion === release.dshVersion,
        }))
    return {
      phase: this.phase,
      message: this.message,
      shellVersion: this.shellVersion,
      minimumDshVersion: MINIMUM_DSH_VERSION,
      ...(this.state.currentVersion === undefined ? {} : { currentVersion: this.state.currentVersion }),
      ...(this.currentRuntimeRevision === undefined ? {} : { currentRuntimeRevision: this.currentRuntimeRevision }),
      preference: this.state.preference,
      versions,
      cachedCatalog: this.cachedCatalog,
      ...(this.progress === undefined ? {} : { progress: this.progress }),
      ...(this.phase !== 'error' || this.recoveryPlan === undefined ? {} : {
        recovery: this.recoveryPlan.kind === 'stale-local-plugins'
          ? {
              kind: 'stale-local-plugins' as const,
              entryIds: [...this.recoveryPlan.plan.entryIds],
              count: this.recoveryPlan.plan.count,
            }
          : {
              kind: 'plugin-preset-conflict' as const,
              pluginName: this.recoveryPlan.plan.pluginName,
              presetId: this.recoveryPlan.plan.presetId,
            },
      }),
      ...(this.error === undefined ? {} : { error: this.error }),
    }
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const next = this.pending.catch(() => {}).then(operation)
    this.pending = next
    return next
  }

  private async boot(): Promise<void> {
    this.recoveryPlan = undefined
    this.update('checking', '正在检查可用的 DSH 版本')
    this.state = await this.store.readState()
    let target: InstalledRuntime | undefined
    let selectedVersion: string | undefined
    try {
      const loaded = await this.store.loadCatalog(this.catalogUrl)
      this.catalog = loaded.catalog
      this.cachedCatalog = loaded.cached
      await this.refreshInstalledVersions()
      const selected = selectRuntime(loaded.catalog, this.shellVersion, this.state.preference)
      selectedVersion = selected.dshVersion
      target = await this.store.installed(selected.dshVersion)
      if (target === undefined
        || target.manifest.runtimeRevision !== selected.runtimeRevision
        || target.manifest.archive.sha256 !== selected.archive.sha256) {
        const previous = target
        await this.stopBackend()
        this.update('downloading', `正在下载 DSH ${selected.dshVersion}`)
        try {
          target = await this.store.install(selected, progress => {
            this.progress = progress
            this.emit()
          })
          this.installedVersions.add(selected.dshVersion)
        } catch (error: unknown) {
          if (previous !== undefined && isReleaseCompatible(previous.manifest, this.shellVersion)) {
            const message = `DSH ${selected.dshVersion} 更新未完成，继续使用 DSH ${previous.manifest.dshVersion}`
            await this.launch(previous, message)
            return
          }
          throw error
        }
      }
      await this.launch(target)
      return
    } catch (error: unknown) {
      const primaryError = error instanceof Error ? error.message : String(error)
      const fallback = await this.fallbackRuntime(selectedVersion)
      if (fallback !== undefined) {
        try {
          await this.launch(fallback, `DSH 更新未完成，继续使用 ${fallback.manifest.dshVersion}`)
          return
        } catch (fallbackError: unknown) {
          const detail = fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
          this.fail(`${primaryError}\n\n回退版本启动失败：${detail}`)
          return
        }
      }
      this.fail(primaryError)
    }
  }

  private async fallbackRuntime(excludedVersion: string | undefined): Promise<InstalledRuntime | undefined> {
    const current = this.state.currentVersion
    if (current === undefined || current === excludedVersion) return undefined
    const installed = await this.store.installed(current)
    if (installed === undefined || !isReleaseCompatible(installed.manifest, this.shellVersion)) return undefined
    return installed
  }

  private async launch(runtime: InstalledRuntime, message = `正在启动 DSH ${runtime.manifest.dshVersion}`): Promise<void> {
    await this.stopBackend()
    this.selectedRuntime = runtime
    this.update('starting', message)
    const home = this.environment.DSH_HOME ?? join(homedir(), '.dsh')
    await mkdir(home, { recursive: true })
    let backend: RunningBackend
    try {
      backend = await startBackend({
        runtime,
        shutdownHook: this.shutdownHook,
        cwd: home,
        env: desktopEnvironment(runtime, this.environment),
        onOpenSettingsDocument: this.onOpenSettingsDocument,
      })
    } catch (error: unknown) {
      const diagnostics = error instanceof Error ? error.message : String(error)
      await this.detectRecovery(home, runtime, diagnostics)
      throw error
    }
    this.recoveryPlan = undefined
    this.backend = backend
    this.expectedStop = false
    this.state = await this.store.promote(runtime.manifest.dshVersion)
    this.currentRuntimeRevision = runtime.manifest.runtimeRevision
    const cliDirectory = await prepareCliShim(runtime, this.userData)
    this.update('ready', `DSH ${runtime.manifest.dshVersion} 已启动`)
    await this.onReady(backend.url, runtime, cliDirectory)
    void backend.done.then((exit) => {
      if (this.backend !== backend || this.expectedStop) return
      this.backend = undefined
      const reason = exit.error?.message ?? `退出码 ${exit.exitCode ?? 'unknown'}`
      this.fail(exit.diagnostics.length === 0 ? `DSH runtime 意外退出：${reason}` : `DSH runtime 意外退出：${reason}\n\n${exit.diagnostics}`)
    })
  }

  private async detectRecovery(home: string, runtime: InstalledRuntime, diagnostics: string): Promise<void> {
    try {
      const plan = await this.inspectStaleLocalPlugins({ home, diagnostics })
      if (plan !== undefined) {
        this.recoveryPlan = { kind: 'stale-local-plugins', plan }
        return
      }
    } catch {
      // One recovery inspector must not hide the startup failure or other exact recovery options.
    }
    try {
      const plan = await this.inspectPluginPreset({ home, runtime, diagnostics, environment: this.environment })
      if (plan !== undefined) this.recoveryPlan = { kind: 'plugin-preset-conflict', plan }
    } catch {
      // Recovery inspection must not replace the Runtime startup failure.
    }
  }

  private async stopBackend(): Promise<void> {
    const backend = this.backend
    if (backend === undefined) return
    this.expectedStop = true
    this.backend = undefined
    await backend.stop()
  }

  private async refreshInstalledVersions(): Promise<void> {
    this.installedVersions = new Set<string>()
    if (this.catalog === undefined) return
    await Promise.all(this.catalog.releases.map(async (release) => {
      if (await this.store.installed(release.dshVersion) !== undefined) this.installedVersions.add(release.dshVersion)
    }))
  }

  private update(phase: RuntimePhase, message: string): void {
    this.phase = phase
    this.message = message
    this.error = undefined
    this.progress = undefined
    this.emit()
  }

  private fail(message: string): void {
    this.phase = 'error'
    this.message = '无法启动 DSH'
    this.error = message
    this.progress = undefined
    this.emit()
  }

  private emit(): void {
    this.onView(this.snapshot())
  }
}
