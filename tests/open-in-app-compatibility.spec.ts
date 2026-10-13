import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installConversationReplayModuleHook } from '../src/conversation-replay-injector.ts'
import {
  injectOpenInAppFactorySource,
  installOpenInAppCompatibilityHook,
  openExplorerDirectory,
} from '../src/open-in-app-compatibility.ts'

const originalLoaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__ModuleLoader__')
const originalConversationHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopConversationReplayHook')
const originalOpenHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopOpenInAppCompatibilityHook')
const originalDesktopApiDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'dshDesktopOpenInApp')

const fixtureFactory = `(require) => {
  class OpenInAppController {
    constructor(fetcher) {
      this.fetcher = fetcher;
      this.operation = {
        phase: 'idle',
        path: null,
        set(next) { this.phase = next.phase; this.path = next.path; },
        getSnapshot() { return { phase: this.phase, path: this.path }; }
      };
    }
    async launch(appId, path) {
      if (this.operation.getSnapshot().phase === 'busy') return;
      this.operation.set({ phase: 'busy', path });
      const body = { app: appId, path };
      const response = await this.fetcher('/open-in-app/open', {
        method: 'POST', body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error('open failed');
      this.operation.set({ phase: 'idle', path });
    }
    async run() {}
  }
  return { OpenInAppController };
}`

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as Record<string, unknown>)[name]
  if (descriptor !== undefined) Object.defineProperty(globalThis, name, descriptor)
}

afterEach(() => {
  restoreGlobal('__ModuleLoader__', originalLoaderDescriptor)
  restoreGlobal('__dshDesktopConversationReplayHook', originalConversationHookDescriptor)
  restoreGlobal('__dshDesktopOpenInAppCompatibilityHook', originalOpenHookDescriptor)
  restoreGlobal('dshDesktopOpenInApp', originalDesktopApiDescriptor)
  vi.restoreAllMocks()
})

function createExplorerController(fetcher: (url: string, init: unknown) => Promise<{ ok: boolean }>) {
  expect(installConversationReplayModuleHook()).toBe('installed')
  const serializedInstaller = Function(`return (${installOpenInAppCompatibilityHook.toString()})`)() as typeof installOpenInAppCompatibilityHook
  expect(serializedInstaller(injectOpenInAppFactorySource.toString())).toBe('installed')
  const rawLoad = vi.fn()
  ;(globalThis as any).__ModuleLoader__ = { load: rawLoad }
  const targetFactory = Function(`return (${fixtureFactory})`)()
  ;(globalThis as any).__ModuleLoader__.load({ id: '@deepseek-ai/dsh-client-ui-open-in-app', factory: targetFactory })
  const module = rawLoad.mock.calls[0]?.[0].factory(vi.fn())
  return new module.OpenInAppController(fetcher)
}

describe('open-in-app compatibility', () => {
  it('routes Explorer through the desktop bridge and leaves other apps on DSH HTTP', async () => {
    expect(installConversationReplayModuleHook()).toBe('installed')
    const serializedInstaller = Function(`return (${installOpenInAppCompatibilityHook.toString()})`)() as typeof installOpenInAppCompatibilityHook
    expect(serializedInstaller(injectOpenInAppFactorySource.toString())).toBe('installed')
    const rawLoad = vi.fn()
    ;(globalThis as any).__ModuleLoader__ = { load: rawLoad }
    ;(globalThis as any).dshDesktopOpenInApp = { openExplorer: vi.fn().mockResolvedValue(undefined) }
    const targetFactory = Function(`return (${fixtureFactory})`)()
    ;(globalThis as any).__ModuleLoader__.load({ id: '@deepseek-ai/dsh-client-ui-open-in-app', factory: targetFactory })
    const module = rawLoad.mock.calls[0]?.[0].factory(vi.fn())
    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    const controller = new module.OpenInAppController(fetcher)

    await controller.launch('explorer', 'C:\\workspace')
    expect((globalThis as any).dshDesktopOpenInApp.openExplorer).toHaveBeenCalledWith('C:\\workspace')
    expect(fetcher).not.toHaveBeenCalled()
    expect(controller.operation.getSnapshot().phase).toBe('idle')

    await controller.launch('cursor', 'C:\\workspace')
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('releases Explorer launches back to idle and allows a repeat launch', async () => {
    ;(globalThis as any).dshDesktopOpenInApp = { openExplorer: vi.fn().mockResolvedValue(undefined) }
    const openExplorer = (globalThis as any).dshDesktopOpenInApp.openExplorer
    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    const controller = createExplorerController(fetcher)

    await controller.launch('explorer', 'C:\\workspace')
    expect(openExplorer).toHaveBeenCalledTimes(1)
    expect(controller.operation.getSnapshot()).toEqual({ phase: 'idle', path: 'C:\\workspace' })

    await controller.launch('explorer', 'C:\\workspace')
    expect(openExplorer).toHaveBeenCalledTimes(2)
    expect(controller.operation.getSnapshot().phase).toBe('idle')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('records an error phase and rethrows when the Explorer bridge rejects', async () => {
    ;(globalThis as any).dshDesktopOpenInApp = { openExplorer: vi.fn().mockRejectedValue(new Error('bridge failure')) }
    const fetcher = vi.fn().mockResolvedValue({ ok: true })
    const controller = createExplorerController(fetcher)

    await expect(controller.launch('explorer', 'C:\\workspace')).rejects.toThrow('bridge failure')
    expect(controller.operation.getSnapshot()).toEqual({ phase: 'error', path: 'C:\\workspace' })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('records an error phase and rethrows when the Explorer bridge throws synchronously', async () => {
    ;(globalThis as any).dshDesktopOpenInApp = {
      openExplorer: vi.fn(() => {
        throw new Error('sync bridge failure')
      }),
    }
    const controller = createExplorerController(vi.fn().mockResolvedValue({ ok: true }))

    await expect(controller.launch('explorer', 'C:\\workspace')).rejects.toThrow('sync bridge failure')
    expect(controller.operation.getSnapshot().phase).toBe('error')
  })

  it('keeps an incompatible upstream factory unchanged', () => {
    expect(injectOpenInAppFactorySource('(require) => ({ apply() {} })')).toEqual({
      source: '(require) => ({ apply() {} })',
      changed: false,
    })
  })

  it('opens only an existing absolute directory and surfaces native failures', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-open-in-app-'))
    const file = join(directory, 'file.txt')
    await writeFile(file, 'fixture', 'utf8')
    try {
      const openPath = vi.fn().mockResolvedValue('')
      await openExplorerDirectory(directory, openPath)
      expect(openPath).toHaveBeenCalledWith(directory)
      await expect(openExplorerDirectory(file, openPath)).rejects.toThrow('目录不存在')
      await expect(openExplorerDirectory('relative', openPath)).rejects.toThrow('目录参数无效')
      await expect(openExplorerDirectory(directory, vi.fn().mockResolvedValue('native failure'))).rejects.toThrow('native failure')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
