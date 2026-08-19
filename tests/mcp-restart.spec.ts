import { describe, expect, it, vi } from 'vitest'
import { mutateMcpWithRuntime } from '../src/mcp-restart.ts'

describe('mutateMcpWithRuntime', () => {
  it('pauses, mutates, and restarts in order', async () => {
    const calls: string[] = []
    await expect(mutateMcpWithRuntime({
      async pause() { calls.push('pause') },
      async mutate() { calls.push('mutate'); return 'updated' },
      async retry() { calls.push('retry') },
    })).resolves.toBe('updated')
    expect(calls).toEqual(['pause', 'mutate', 'retry'])
  })

  it('restarts after mutation or pause failures', async () => {
    const retryAfterMutation = vi.fn(async () => {})
    await expect(mutateMcpWithRuntime({
      async pause() {},
      async mutate() { throw new Error('write failed') },
      retry: retryAfterMutation,
    })).rejects.toThrow('write failed')
    expect(retryAfterMutation).toHaveBeenCalledOnce()

    const mutate = vi.fn(async () => 'unreachable')
    const retryAfterPause = vi.fn(async () => {})
    await expect(mutateMcpWithRuntime({
      async pause() { throw new Error('pause failed') },
      mutate,
      retry: retryAfterPause,
    })).rejects.toThrow('pause failed')
    expect(mutate).not.toHaveBeenCalled()
    expect(retryAfterPause).toHaveBeenCalledOnce()
  })

  it('preserves both the mutation and restart failures', async () => {
    const promise = mutateMcpWithRuntime({
      async pause() {},
      async mutate() { throw new Error('write failed') },
      async retry() { throw new Error('restart failed') },
    })
    await expect(promise).rejects.toBeInstanceOf(AggregateError)
    await expect(promise).rejects.toThrow('MCP 配置写入和 Runtime 恢复均失败')
  })
})
