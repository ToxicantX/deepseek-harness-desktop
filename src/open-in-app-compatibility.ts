import { stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

export interface OpenInAppTransform {
  source: string
  changed: boolean
}

export async function openExplorerDirectory(
  value: unknown,
  openPath: (path: string) => Promise<string>,
): Promise<void> {
  if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) {
    throw new Error('文件资源管理器目录参数无效')
  }
  const path = resolve(value)
  const entry = await stat(path).catch(() => undefined)
  if (entry?.isDirectory() !== true) throw new Error('文件资源管理器目录不存在')
  const failure = await openPath(path)
  if (failure.length > 0) throw new Error(failure)
}

/** Serialized into the main world: no imports or closure dependencies. */
export function injectOpenInAppFactorySource(source: string): OpenInAppTransform {
  if (source.includes('__dshDesktopOpenExplorer')) return { source, changed: false }
  const method = 'async launch(appId, path) {'
  const methodStart = source.indexOf(method)
  if (methodStart < 0) return { source, changed: false }
  const methodEnd = source.indexOf('async run()', methodStart + method.length)
  const bodyStart = source.indexOf('const body = {', methodStart + method.length)
  if (bodyStart < 0 || (methodEnd >= 0 && bodyStart >= methodEnd)) return { source, changed: false }
  const lineStart = source.lastIndexOf('\n', bodyStart) + 1
  const indentation = source.slice(lineStart, bodyStart)
  const injected = [
    `${indentation}const __dshDesktopOpenExplorer = globalThis.dshDesktopOpenInApp?.openExplorer;`,
    `${indentation}if (appId === "explorer" && typeof __dshDesktopOpenExplorer === "function") {`,
    `${indentation}\tawait __dshDesktopOpenExplorer(path);`,
    `${indentation}\treturn;`,
    `${indentation}}`,
  ].join('\n') + '\n'
  return { source: source.slice(0, lineStart) + injected + source.slice(lineStart), changed: true }
}

/** Serialized into the main world: no imports or closure dependencies. */
export function installOpenInAppCompatibilityHook(transformSource: string): string {
  const root = globalThis as any
  const hookKey = '__dshDesktopOpenInAppCompatibilityHook'
  if (root[hookKey]?.version === 1) return 'already-installed'
  const loaderHook = root.__dshDesktopConversationReplayHook
  if (typeof loaderHook?.registerModuleFactoryTransform !== 'function') return 'loader-hook-unavailable'
  try {
    const transform = Function(`return (${transformSource})`)()
    const registered = loaderHook.registerModuleFactoryTransform('@deepseek-ai/dsh-client-ui-open-in-app', (factory: Function) => {
      const result = transform(Function.prototype.toString.call(factory))
      if (result?.changed !== true || typeof result.source !== 'string') return factory
      try {
        const rebuilt = Function(`return (${result.source})`)()
        return typeof rebuilt === 'function' ? rebuilt : factory
      } catch (error) {
        console.error('桌面壳文件资源管理器兼容注入失败', error)
        return factory
      }
    })
    if (registered !== true) return 'registration-failed'
    Object.defineProperty(root, hookKey, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: Object.freeze({ version: 1 }),
    })
    return 'installed'
  } catch (error) {
    console.error('桌面壳文件资源管理器兼容注入失败', error)
    return 'registration-failed'
  }
}
