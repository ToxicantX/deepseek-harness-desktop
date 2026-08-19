import { describe, expect, it, vi } from 'vitest'
import type { PluginOperationStatus } from '../src/plugin-manager.ts'
import { restartRuntimeAfterPluginMutation, type PluginRestartOptions } from '../src/plugin-restart.ts'
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
