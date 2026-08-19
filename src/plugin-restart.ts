import type { PluginOperationStatus } from './plugin-manager.ts'
import type { RuntimeView } from './runtime-controller.ts'

export interface PluginRestartOptions {
  status(operationId: string): PluginOperationStatus
  showSetup(): Promise<void>
  retry(): Promise<void>
  currentView(): RuntimeView | undefined
}

export async function restartRuntimeAfterPluginMutation(
  operationId: string,
  options: PluginRestartOptions,
): Promise<RuntimeView> {
  const operation = options.status(operationId)
  if (operation.state !== 'succeeded') throw new Error('插件操作尚未成功完成')
  await options.showSetup()
  await options.retry()
  const view = options.currentView()
  if (view?.phase !== 'ready') throw new Error(view?.error ?? 'DSH Runtime 重启失败')
  return view
}

export class PluginRestartCoordinator {
  private active: { operationId: string; promise: Promise<RuntimeView> } | undefined

  restart(
    operationId: string,
    options: PluginRestartOptions,
    completed: (operationId: string) => void,
  ): Promise<RuntimeView> {
    if (this.active !== undefined) {
      if (this.active.operationId === operationId) return this.active.promise
      return Promise.reject(new Error('另一个插件操作正在重启 Runtime'))
    }
    const promise = restartRuntimeAfterPluginMutation(operationId, options).then(view => {
      completed(operationId)
      return view
    })
    this.active = { operationId, promise }
    const clear = (): void => {
      if (this.active?.promise === promise) this.active = undefined
    }
    void promise.then(clear, clear)
    return promise
  }
}
