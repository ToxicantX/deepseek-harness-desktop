import { setTimeout as delay } from 'node:timers/promises'
import type { WebContents } from 'electron'
import { classifyPluginFailure, PluginImportFailure } from './plugin-isolation.ts'

// The alpha boot kernel keeps this marker until the UI renderer mounts.
export function clientBootState(): 'loading' | 'failed' | 'mounted' {
  const boot = document.querySelector('[data-dsh-boot]')
  if (boot !== null) return boot.textContent?.includes('Failed to load plugins') ? 'failed' : 'loading'
  return document.querySelector('#root')?.childElementCount ? 'mounted' : 'loading'
}

export async function loadAndValidatePlugins(contents: WebContents, url: URL, load: () => Promise<void>, timeoutMs = 30_000): Promise<void> {
  const failures = new Set<string>()
  const listener = (event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>): void => {
    if (event.frame !== contents.mainFrame || !event.frame.url.startsWith(url.origin + '/')) return
    // Store only classified package names, never arbitrary console contents or tokens.
    for (const name of classifyPluginFailure(event.message.slice(0, 24 * 1024))) failures.add(name)
  }
  contents.on('console-message', listener)
  const deadline = Date.now() + timeoutMs
  let cancelled = false
  const inspect = async (): Promise<void> => {
    await load()
    while (!cancelled && Date.now() < deadline) {
      if (contents.isDestroyed() || new URL(contents.getURL()).origin !== url.origin) throw new Error('插件验证页面已关闭或发生跳转')
      if (failures.size) {
        throw new PluginImportFailure([...failures])
      }
      const state: unknown = await contents.executeJavaScript(`(${clientBootState.toString()})()`)
      if (state === 'mounted') return
      // Wait for the kernel's final console report instead of attributing a pending service to a plugin.
      await delay(200)
    }
    throw new Error('插件界面未通过启动验证；未将网络、认证或未知错误自动归为不兼容')
  }
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([inspect(), new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('插件界面未通过启动验证：等待超时')) }, timeoutMs)
    })])
  } finally {
    cancelled = true
    clearTimeout(timer)
    contents.removeListener('console-message', listener)
  }
}
