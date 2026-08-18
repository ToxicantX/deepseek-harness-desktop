import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { installShutdownHook, type ShutdownProcess } from '../src/shutdown-hook.ts'

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('installShutdownHook', () => {
  it('waits for the upstream CLI SIGINT handler before dispatching once', async () => {
    const target = new EventEmitter() as ShutdownProcess & EventEmitter
    installShutdownHook(target)
    target.emit('message', 'dsh/shutdown')
    await flushMicrotasks()
    const interrupt = vi.fn()
    target.on('SIGINT', interrupt)
    await flushMicrotasks()
    expect(interrupt).toHaveBeenCalledTimes(1)
    target.emit('message', 'dsh/shutdown')
    target.emit('disconnect')
    await flushMicrotasks()
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('uses IPC disconnect as the same graceful shutdown request', async () => {
    const target = new EventEmitter() as ShutdownProcess & EventEmitter
    const interrupt = vi.fn()
    target.on('SIGINT', interrupt)
    installShutdownHook(target)
    target.emit('disconnect')
    await flushMicrotasks()
    expect(interrupt).toHaveBeenCalledTimes(1)
  })
})
