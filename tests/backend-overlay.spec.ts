import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { backendArguments, startBackend } from '../src/backend.ts'

function runtime(version = '0.1.0-rc.8') {
  return {
    directory: 'C:/runtime',
    manifest: { dshVersion: version },
    nodeExecutable: 'C:/runtime/node.exe',
    pnpmExecutable: 'C:/runtime/pnpm.cmd',
    dshBin: 'C:/runtime/dsh.cjs',
  } as any
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  connected = true
  kill = vi.fn(() => {
    if (this.exitCode !== null) return
    this.exitCode = 130
    queueMicrotask(() => this.emit('close', 130, 'SIGTERM'))
  })
  send = vi.fn((_message: unknown, callback?: (error: Error | null) => void) => {
    this.exitCode = 0
    callback?.(null)
    queueMicrotask(() => this.emit('close', 0, null))
  })
}

function forkWith(child: FakeChild, args: string[][]) {
  return ((_file: string, argv: string[]) => {
    args.push(argv)
    queueMicrotask(() => child.stdout.write('dsh web: http://127.0.0.1:43123/\n'))
    return child
  }) as any
}

describe('backend overlay integration', () => {
  it('places Runtime and overlay patches before port and no-open', () => {
    const args = backendArguments(runtime(), ['C:/overlay/a.yml', 'C:/overlay/b.yml'], () => true)
    expect(args).toEqual([
      'web',
      '--patch', join('C:/runtime', 'app', 'desktop.patch.yml'),
      '--patch', 'C:/overlay/a.yml',
      '--patch', 'C:/overlay/b.yml',
      '--port', '0',
      '--no-open',
    ])
  })

  it('runs cleanup exactly once on normal stop and preserves cleanup diagnostics', async () => {
    const child = new FakeChild()
    const cleanup = vi.fn(async () => { throw new Error('overlay busy') })
    const backend = await startBackend({
      runtime: runtime(),
      shutdownHook: 'C:/shutdown-hook.js',
      cwd: 'C:/home',
      env: {},
      additionalPatches: ['C:/overlay.yml'],
      cleanup,
      forkProcess: forkWith(child, []),
    })
    const first = await backend.stop()
    const second = await backend.stop()
    expect(first.exitCode).toBe(0)
    expect(second).toBe(first)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(first.diagnostics).toContain('Runtime overlay cleanup failed: overlay busy')
  })

  it('runs cleanup exactly once after unexpected exit', async () => {
    const child = new FakeChild()
    const cleanup = vi.fn(async () => {})
    const backend = await startBackend({
      runtime: runtime(),
      shutdownHook: 'C:/shutdown-hook.js',
      cwd: 'C:/home',
      env: {},
      cleanup,
      forkProcess: ((_file: string, _args: string[]) => {
        queueMicrotask(() => child.stdout.write('dsh web: http://127.0.0.1:43123/\n'))
        return child
      }) as any,
    })
    child.exitCode = 2
    child.emit('close', 2, null)
    const exit = await backend.done
    expect(exit.exitCode).toBe(2)
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('runs cleanup when process creation throws synchronously', async () => {
    const cleanup = vi.fn(async () => {})
    await expect(startBackend({
      runtime: runtime(),
      shutdownHook: 'C:/shutdown-hook.js',
      cwd: 'C:/home',
      env: {},
      cleanup,
      forkProcess: (() => { throw new Error('spawn denied') }) as any,
    })).rejects.toThrow('spawn denied')
    expect(cleanup).toHaveBeenCalledOnce()
  })

  it('runs cleanup when startup readiness fails', async () => {
    const child = new FakeChild()
    const cleanup = vi.fn(async () => {})
    await expect(startBackend({
      runtime: runtime(),
      shutdownHook: 'C:/shutdown-hook.js',
      cwd: 'C:/home',
      env: {},
      startTimeoutMs: 1,
      cleanup,
      forkProcess: ((_file: string, _args: string[]) => child) as any,
    })).rejects.toThrow('did not become ready')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})
