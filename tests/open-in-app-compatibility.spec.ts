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
    constructor(fetcher) { this.fetcher = fetcher; }
    async launch(appId, path) {
      const body = { app: appId, path };
      const response = await this.fetcher('/open-in-app/open', {
        method: 'POST', body: JSON.stringify(body)
      });
      if (!response.ok) throw new Error('open failed');
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

    await controller.launch('cursor', 'C:\\workspace')
    expect(fetcher).toHaveBeenCalledOnce()
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
