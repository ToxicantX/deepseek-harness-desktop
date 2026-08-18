import type { Serializable } from 'node:child_process'

const SHUTDOWN_MESSAGE = 'dsh/shutdown'

export interface ShutdownProcess {
  send?: (message: Serializable) => boolean
  listenerCount(event: string): number
  emit(event: string): boolean
  on(event: 'message', listener: (message: unknown) => void): this
  on(event: 'newListener', listener: (event: string | symbol) => void): this
  once(event: 'disconnect', listener: () => void): this
}

export function installShutdownHook(target: ShutdownProcess): void {
  let requested = false
  let dispatched = false

  const dispatchWhenReady = (): void => {
    if (!requested || dispatched || target.listenerCount('SIGINT') === 0) return
    dispatched = true
    target.emit('SIGINT')
  }
  const requestShutdown = (): void => {
    if (requested) return
    requested = true
    queueMicrotask(dispatchWhenReady)
  }

  target.on('message', (message: unknown) => {
    if (message === SHUTDOWN_MESSAGE) requestShutdown()
  })
  target.once('disconnect', requestShutdown)
  target.on('newListener', (event: string | symbol) => {
    if (event === 'SIGINT' && requested) queueMicrotask(dispatchWhenReady)
  })
}

if (process.send !== undefined) installShutdownHook(process)
