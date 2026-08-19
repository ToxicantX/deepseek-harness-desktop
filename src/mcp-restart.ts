export interface McpRuntimeMutationOptions<T> {
  pause(): Promise<void>
  mutate(): Promise<T>
  retry(): Promise<void>
}

export async function mutateMcpWithRuntime<T>(options: McpRuntimeMutationOptions<T>): Promise<T> {
  let result: T | undefined
  let failure: unknown
  try {
    await options.pause()
    result = await options.mutate()
  } catch (error: unknown) {
    failure = error
  }
  try {
    await options.retry()
  } catch (error: unknown) {
    failure = failure === undefined ? error : new AggregateError([failure, error], 'MCP 配置写入和 Runtime 恢复均失败')
  }
  if (failure !== undefined) throw failure
  if (result === undefined) throw new Error('MCP 操作未返回结果')
  return result
}
