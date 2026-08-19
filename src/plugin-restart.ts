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
