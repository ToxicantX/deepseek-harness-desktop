import { fork, type ChildProcess, type ForkOptions } from 'node:child_process'
import { dirname, delimiter } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InstalledRuntime } from './runtime-store.ts'

const READY_PREFIX = 'dsh web: '
const SHUTDOWN_MESSAGE = 'dsh/shutdown'
const DEFAULT_START_TIMEOUT_MS = 120_000
const DEFAULT_STOP_TIMEOUT_MS = 7_000
const DIAGNOSTIC_LIMIT = 24 * 1024

export interface BackendExit {
  exitCode: number | null
  signal: NodeJS.Signals | null
  diagnostics: string
  error?: Error
}

export interface RunningBackend {
  url: URL
  done: Promise<BackendExit>
  stop(): Promise<BackendExit>
}

export interface StartBackendOptions {
  runtime: InstalledRuntime
  shutdownHook: string
  cwd: string
  env: NodeJS.ProcessEnv
  startTimeoutMs?: number
  stopTimeoutMs?: number
  forkProcess?: typeof fork
}

class DiagnosticTail {
  private value = Buffer.alloc(0)

  append(chunk: Buffer | string): void {
    this.value = Buffer.concat([this.value, Buffer.from(chunk)])
    if (this.value.length > DIAGNOSTIC_LIMIT) this.value = this.value.subarray(this.value.length - DIAGNOSTIC_LIMIT)
  }

  toString(): string {
    return this.value.toString('utf8').trim()
  }
}

function describe(exit: BackendExit): string {
  const reason = exit.error?.message
    ?? (exit.signal === null ? `exit code ${exit.exitCode ?? 'unknown'}` : `signal ${exit.signal}`)
  return exit.diagnostics.length === 0 ? reason : `${reason}\n\n${exit.diagnostics}`
}

function timeout<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { resolve(undefined) }, milliseconds)
    timer.unref()
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error: unknown) => { clearTimeout(timer); reject(error) },
    )
  })
}

export function parseBackendUrl(line: string): string | undefined {
  if (!line.startsWith(READY_PREFIX)) return undefined
  const candidate = line.slice(READY_PREFIX.length).trim()
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
      return undefined
    }
    return url.href
  } catch {
    return undefined
  }
}

export function desktopEnvironment(runtime: InstalledRuntime, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = { ...inherited }
  const path = [dirname(runtime.pnpmExecutable), dirname(runtime.nodeExecutable), inherited.Path ?? inherited.PATH]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join(delimiter)
  environment.Path = path
  environment.PATH = path
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

export async function startBackend(options: StartBackendOptions): Promise<RunningBackend> {
  const diagnostics = new DiagnosticTail()
  const child = (options.forkProcess ?? fork)(
    options.runtime.dshBin,
    ['web', '--port', '0'],
    {
      cwd: options.cwd,
      env: options.env,
      execPath: options.runtime.nodeExecutable,
      execArgv: ['--import', pathToFileURL(options.shutdownHook).href],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    } satisfies ForkOptions,
  )
  let spawnError: Error | undefined
  const done = new Promise<BackendExit>((resolve) => {
    child.once('error', (error) => { spawnError = error })
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        diagnostics: diagnostics.toString(),
        ...(spawnError === undefined ? {} : { error: spawnError }),
      })
    })
  })
  child.stderr?.on('data', (chunk: Buffer | string) => { diagnostics.append(chunk) })

  let lineBuffer = ''
  let ready = false
  const readiness = new Promise<URL>((resolve) => {
    child.stdout?.on('data', (chunk: Buffer | string) => {
      diagnostics.append(chunk)
      lineBuffer += chunk.toString()
      for (;;) {
        const newline = lineBuffer.indexOf('\n')
        if (newline === -1) break
        const line = lineBuffer.slice(0, newline).replace(/\r$/u, '')
        lineBuffer = lineBuffer.slice(newline + 1)
        const parsed = parseBackendUrl(line)
        if (!ready && parsed !== undefined) {
          ready = true
          resolve(new URL(parsed))
        }
      }
    })
  })

  const startTimeoutMs = options.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS
  let timer: NodeJS.Timeout | undefined
  try {
    const url = await Promise.race([
      readiness,
      done.then((exit) => { throw new Error(`DSH runtime exited before readiness:\n${describe(exit)}`) }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(`DSH runtime did not become ready within ${startTimeoutMs} ms`)) }, startTimeoutMs)
      }),
    ])
    if (timer !== undefined) clearTimeout(timer)
    return runningBackend(url, child, done, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)
  } catch (error: unknown) {
    if (timer !== undefined) clearTimeout(timer)
    if (child.exitCode === null) child.kill()
    await done
    const message = error instanceof Error ? error.message : String(error)
    const detail = diagnostics.toString()
    throw new Error(detail.length === 0 || message.includes(detail) ? message : `${message}\n\n${detail}`)
  }
}

function runningBackend(
  url: URL,
  child: ChildProcess,
  done: Promise<BackendExit>,
  stopTimeoutMs: number,
): RunningBackend {
  let stopping: Promise<BackendExit> | undefined
  return {
    url,
    done,
    stop() {
      if (stopping !== undefined) return stopping
      stopping = (async () => {
        if (child.exitCode !== null) return done
        if (child.connected) {
          await new Promise<void>((resolve) => {
            child.send(SHUTDOWN_MESSAGE, (error) => {
              if (error !== null && child.exitCode === null) child.kill()
              resolve()
            })
          })
        } else child.kill()
        const graceful = await timeout(done, stopTimeoutMs)
        if (graceful !== undefined) return graceful
        child.kill()
        return done
      })()
      return stopping
    },
  }
}
