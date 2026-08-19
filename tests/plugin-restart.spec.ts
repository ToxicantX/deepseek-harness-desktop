import { describe, expect, it, vi } from 'vitest'
import type { PluginOperationStatus } from '../src/plugin-manager.ts'
import { PluginRestartCoordinator, restartRuntimeAfterPluginMutation, type PluginRestartOptions } from '../src/plugin-restart.ts'
import type { RuntimeView } from '../src/runtime-controller.ts'

const operationId = '00000000-0000-4000-8000-000000000000'
const succeeded: PluginOperationStatus = { operationId, state: 'succeeded', action: 'add', output: '' }

function runtimeView(phase: RuntimeView['phase'], error?: string): RuntimeView {
  return {
    phase,
    message: phase,
    shellVersion: '0.1.2',
    minimumDshVersion: '0.1.0-rc.7',
    preference: { mode: 'latest-compatible' },
    versions: [],
    cachedCatalog: false,
    ...(error === undefined ? {} : { error }),
  }
}

function options(overrides: Partial<PluginRestartOptions> = {}): PluginRestartOptions {
  return {
    status: () => succeeded,
    showSetup: vi.fn(async () => undefined),
    retry: vi.fn(async () => undefined),
    currentView: () => runtimeView('ready'),
    ...overrides,
  }
}

describe('restartRuntimeAfterPluginMutation', () => {
  it.each(['running', 'failed'] as const)('rejects a %s operation without restarting', async state => {
    const value = options({
      status: () => ({ ...succeeded, state }),
    })
    await expect(restartRuntimeAfterPluginMutation(operationId, value)).rejects.toThrow('尚未成功')
    expect(value.showSetup).not.toHaveBeenCalled()
    expect(value.retry).not.toHaveBeenCalled()
  })

  it('shows setup, retries, then reads and returns the ready view', async () => {
    const order: string[] = []
    const ready = runtimeView('ready')
    const value = options({
      status(id) { order.push('status:' + id); return succeeded },
      async showSetup() { order.push('setup') },
      async retry() { order.push('retry') },
      currentView() { order.push('view'); return ready },
    })
    await expect(restartRuntimeAfterPluginMutation(operationId, value)).resolves.toBe(ready)
    expect(order).toEqual(['status:' + operationId, 'setup', 'retry', 'view'])
  })

  it('propagates the Runtime startup error while leaving recovery to the caller', async () => {
    const value = options({ currentView: () => runtimeView('error', 'plugin bundle failed to load') })
    await expect(restartRuntimeAfterPluginMutation(operationId, value)).rejects.toThrow('plugin bundle failed to load')
  })

  it('uses a useful fallback when no Runtime view is available', async () => {
    const value = options({ currentView: () => undefined })
    await expect(restartRuntimeAfterPluginMutation(operationId, value)).rejects.toThrow('DSH Runtime 重启失败')
  })
})

describe('PluginRestartCoordinator', () => {
  it('shares one Runtime restart for the same operation across reopened windows', async () => {
    const coordinator = new PluginRestartCoordinator()
    let releaseRetry: (() => void) | undefined
    const retrying = new Promise<void>(resolve => { releaseRetry = resolve })
    const value = options({ retry: vi.fn(async () => { await retrying }) })
    const completed = vi.fn()

    const first = coordinator.restart(operationId, value, completed)
    const second = coordinator.restart(operationId, value, completed)
    expect(second).toBe(first)
    await vi.waitFor(() => { expect(value.retry).toHaveBeenCalledOnce() })
    releaseRetry?.()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
    expect(completed).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledWith(operationId)
  })

  it('rejects a different operation during restart and allows retry after failure', async () => {
    const coordinator = new PluginRestartCoordinator()
    let releaseRetry: (() => void) | undefined
    const retrying = new Promise<void>(resolve => { releaseRetry = resolve })
    const first = coordinator.restart(operationId, options({ retry: async () => { await retrying } }), vi.fn())
    const otherId = '11111111-1111-4111-8111-111111111111'
    await expect(coordinator.restart(otherId, options(), vi.fn())).rejects.toThrow('另一个插件操作')
    releaseRetry?.()
    await first

    const completed = vi.fn()
    await expect(coordinator.restart(operationId, options({ retry: async () => { throw new Error('restart failed') } }), completed)).rejects.toThrow('restart failed')
    expect(completed).not.toHaveBeenCalled()
    await expect(coordinator.restart(operationId, options(), completed)).resolves.toMatchObject({ phase: 'ready' })
    expect(completed).toHaveBeenCalledOnce()
  })
})
