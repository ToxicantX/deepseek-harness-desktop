import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { loadAndValidatePlugins } from '../src/plugin-client-health.ts'

function contents() {
  return Object.assign(new EventEmitter(), {
    mainFrame: { url: 'http://127.0.0.1:41111/' },
    getURL: () => 'http://127.0.0.1:41111/',
    isDestroyed: () => false,
    executeJavaScript: vi.fn(async () => 'mounted'),
  })
}

describe('frontend plugin validation', () => {
  it('captures exact main-frame import failures that happen while loading', async () => {
    const page = contents()
    await expect(loadAndValidatePlugins(page as any, new URL(page.getURL()), async () => {
      page.emit('console-message', {
        frame: page.mainFrame,
        message: 'failed to import loader entry aa (@dshthemes/ui): client-modules: require("old/client") missed the module table token=private',
      })
    })).rejects.toThrow('@dshthemes/ui')
    expect(page.listenerCount('console-message')).toBe(0)
  })

  it('ignores iframe errors and ordinary authentication errors', async () => {
    const page = contents()
    await loadAndValidatePlugins(page as any, new URL(page.getURL()), async () => {
      page.emit('console-message', { frame: { url: page.getURL() }, message: 'failed to import loader entry aa (@dshthemes/ui): Cannot find package "x"' })
      page.emit('console-message', { frame: page.mainFrame, message: '401 Unauthorized' })
    })
    expect(page.executeJavaScript).toHaveBeenCalledOnce()
    expect(page.listenerCount('console-message')).toBe(0)
  })

  it('does not call a backend-ready but unmounted frontend successful', async () => {
    const page = contents()
    page.executeJavaScript.mockResolvedValue('loading')
    await expect(loadAndValidatePlugins(page as any, new URL(page.getURL()), async () => {}, 1)).rejects.toThrow('未通过启动验证')
  })

  it('bounds a hung renderer probe and removes its listener', async () => {
    const page = contents()
    page.executeJavaScript.mockImplementation(() => new Promise(() => {}))
    await expect(loadAndValidatePlugins(page as any, new URL(page.getURL()), async () => {}, 10)).rejects.toThrow('等待超时')
    expect(page.listenerCount('console-message')).toBe(0)
  })
})
