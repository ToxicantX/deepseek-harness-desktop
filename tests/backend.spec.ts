import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, Serializable } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { parseBackendUrl, startBackend, type StartBackendOptions } from '../src/backend.ts'
import type { InstalledRuntime } from '../src/runtime-store.ts'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  connected = true
  exitCode: number | null = null
  sent: Serializable[] = []
  killCalls = 0

  send(message: Serializable, callback?: (error: Error | null) => void): boolean {
    this.sent.push(message)
    callback?.(null)
    return true
  }

  kill(): boolean {
    this.killCalls += 1
    if (this.killCalls === 1) {
      this.exitCode = 1
      queueMicrotask(() => { this.emit('close', this.exitCode, null) })
    }
    return true
  }

  settle(exitCode: number): void {
    this.exitCode = exitCode
    this.emit('close', exitCode, null)
  }
}

const runtime: InstalledRuntime = {
  directory: 'C:\runtime',
  nodeExecutable: 'C:\runtime\node\node.exe',
  pnpmExecutable: 'C:\runtime\tools\pnpm.exe',
  dshBin: 'C:\runtime\app\lib\bin.js',
  manifest: {
    schemaVersion: 1,
    runtimeProtocolVersion: 1,
    dshVersion: '0.1.0-rc.7',
    requiredShellRange: '>=0.1.0 <1.0.0',
    platform: 'win32',
    arch: 'x64',
    source: { repository: 'https://github.com/deepseek-ai/deepseek-harness.git', tag: 'dsh-v0.1.0-rc.7', commit: 'a'.repeat(40) },
    archive: { url: 'https://example.test/runtime.zip', sha256: 'b'.repeat(64), size: 1 },
    paths: { node: 'node/node.exe', pnpm: 'tools/pnpm.exe', dsh: 'app/lib/bin.js' },
  },
}

function options(child: FakeChild, overrides: Partial<StartBackendOptions> = {}): StartBackendOptions {
  return {
    runtime,
    shutdownHook: 'C:\shell\shutdown-hook.js',
    cwd: 'C:\home',
    env: { Path: 'C:\runtime' },
    forkProcess: vi.fn(() => child as unknown as ChildProcess) as unknown as typeof import('node:child_process').fork,
    ...overrides,
  }
}

describe('parseBackendUrl', () => {
  it('accepts only the exact loopback readiness origin', () => {
    expect(parseBackendUrl('dsh web: http://127.0.0.1:43120')).toBe('http://127.0.0.1:43120/')
    expect(parseBackendUrl('dsh web: http://localhost:43120')).toBeUndefined()
    expect(parseBackendUrl('noise http://127.0.0.1:43120')).toBeUndefined()
  })
})

describe('startBackend', () => {
  it('coalesces graceful shutdown requests onto the IPC hook', async () => {
    const child = new FakeChild()
    const starting = startBackend(options(child))
    child.stdout.write('dsh web: http://127.0.0.1:43120\n')
    const backend = await starting
    const first = backend.stop()
    const second = backend.stop()
    expect(first).toBe(second)
    expect(child.sent).toEqual(['dsh/shutdown'])
    child.settle(0)
    expect(await first).toMatchObject({ exitCode: 0 })
    expect(child.killCalls).toBe(0)
  })

  it('retains bounded diagnostics when startup exits early', async () => {
    const child = new FakeChild()
    const starting = startBackend(options(child))
    child.stderr.write('configuration failed\n')
    child.settle(1)
    await expect(starting).rejects.toThrow('configuration failed')
  })

  it('force-kills after the graceful shutdown bound', async () => {
    const child = new FakeChild()
    const starting = startBackend(options(child, { stopTimeoutMs: 5 }))
    child.stdout.write('dsh web: http://127.0.0.1:43121\n')
    const backend = await starting
    await backend.stop()
    expect(child.killCalls).toBe(1)
  })
})
