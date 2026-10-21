import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import { expect, it, vi } from 'vitest'

it('accepts search settings IPC only from its local owner window main frame', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const source = main.slice(main.indexOf('function searchSettingsService('), main.indexOf('async function showAbout('))
  const page = fileURLToPath(new URL('../assets/search-settings.html', import.meta.url))
  const frame = {}, service = {}, sender = { mainFrame: frame, getURL: () => pathToFileURL(page).href }
  const owner = { isDestroyed: () => false, webContents: sender }
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText
  const validate = runInNewContext(compiled + '; searchSettingsService', {
    searchSettingsWindow: owner, searchSettingsPage: page, searchSettings: service, URL, resolve, fileURLToPath,
  })
  expect(validate({ sender, senderFrame: frame })).toBe(service)
  expect(() => validate({ sender, senderFrame: {} })).toThrow('来源无效')
  expect(() => validate({ sender: { ...sender }, senderFrame: frame })).toThrow('来源无效')
  for (const url of ['https://example.com', pathToFileURL(page).href + '?fake=1', pathToFileURL(page).href + '#fake']) {
    sender.getURL = () => url
    expect(() => validate({ sender, senderFrame: frame })).toThrow('页面无效')
  }
})

function saveHandler() {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8')
  const source = main.slice(main.indexOf("ipcMain.handle('search-settings:save'"), main.indexOf("ipcMain.handle('personalization:read'"))
  const view = { provider: 'exa', exa: { hasKey: true } }
  const service = { read: vi.fn(async () => view), save: vi.fn(async () => view) }
  const controller = { retry: vi.fn(async () => {}) }
  let handler: (event: unknown, value: unknown) => Promise<any>
  const context = { searchSettingsService: () => service, controller, quitting: false,
    mcpMutationActive: false, pluginIsolationActive: false, pluginManager: undefined,
    dialog: { showMessageBox: vi.fn(async () => ({ response: 1 })) }, searchSettingsWindow: {},
    mainWindow: {}, showSetup: vi.fn(async () => {}), latestView: { phase: 'ready' },
    ipcMain: { handle: (_name: string, value: typeof handler) => { handler = value } } }
  runInNewContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2024 } }).outputText, context)
  return { context, service, controller, call: (value: unknown) => handler({}, value) }
}

it('saves settings and restarts only after confirmation, without returning keys or changing the global environment', async () => {
  const f = saveHandler(), value = { apiKey: 'fixture-secret' }
  f.context.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
  expect((await f.call(value)).saved).toBe(false)
  expect(f.service.save).not.toHaveBeenCalled(); expect(f.controller.retry).not.toHaveBeenCalled()
  const result = await f.call(value)
  expect(result.saved).toBe(true)
  expect(f.service.save).toHaveBeenCalledWith(value)
  expect(f.controller.retry).toHaveBeenCalledOnce()
  expect(f.context.showSetup).toHaveBeenCalledOnce()
  expect(JSON.stringify(result)).not.toContain('fixture-secret')
  expect(f.context.mcpMutationActive).toBe(false)
})

it('rejects conflicting mutations and reports failed Runtime startup without claiming successful application', async () => {
  const f = saveHandler()
  f.context.mcpMutationActive = true
  await expect(f.call({})).rejects.toThrow('请等待')
  expect(f.service.save).not.toHaveBeenCalled()
  f.context.mcpMutationActive = false; f.context.latestView.phase = 'error'
  await expect(f.call({})).rejects.toThrow('搜索设置已保存，但 Runtime 未成功启动')
  expect(f.context.mcpMutationActive).toBe(false)
})

it('does not restart Runtime if the user quits while the confirmation is pending', async () => {
  const f = saveHandler()
  f.context.dialog.showMessageBox.mockImplementationOnce(async () => { f.context.quitting = true; return { response: 1 } })
  await expect(f.call({})).rejects.toThrow('应用正在退出')
  expect(f.service.save).not.toHaveBeenCalled(); expect(f.controller.retry).not.toHaveBeenCalled()
  expect(f.context.mcpMutationActive).toBe(false)
})
