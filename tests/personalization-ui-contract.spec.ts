import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const html = readFileSync(join(root, 'assets', 'personalization.html'), 'utf8')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')

describe('global personalization UI contract', () => {
  it('ships a script-free local Markdown editor with stable controls', () => {
    for (const id of [
      'personalization-page',
      'personalization-state',
      'personalization-template',
      'personalization-reload',
      'personalization-save',
      'personalization-path',
      'personalization-count',
      'personalization-content',
      'personalization-warning',
      'personalization-progress',
      'personalization-status',
    ]) expect(html).toContain('id="' + id + '"')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('textarea')
    expect(html).toContain('不要填写 API Key、Token、密码或其他凭据')
    expect(html).not.toMatch(/<script|\son[a-z]+=/iu)
  })

  it('edits only through preload DOM APIs with byte limits and dirty tracking', () => {
    expect(preload).toContain("document.querySelector('#personalization-page')")
    expect(preload).toContain("ipcRenderer.invoke('personalization:read')")
    expect(preload).toContain("ipcRenderer.invoke('personalization:save'")
    expect(preload).toContain("ipcRenderer.send('personalization:dirty', value)")
    expect(preload).toContain('new TextEncoder()')
    expect(preload).toContain('snapshot === undefined || !dirty || over')
    expect(preload).toContain('baseline = editor.value')
    expect(preload).toContain('遵从当前 Agent 预设提供的角色、工具、能力与工作流程')
    expect(preload).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u)
  })

  it('opens from File menu and scopes IPC to its exact utility window', () => {
    expect(main).toContain("const personalizationPage = join(app.getAppPath(), 'assets', 'personalization.html')")
    expect(main).toContain("utility?: 'manager' | 'repair' | 'plugin' | 'mcp' | 'personalization' | 'update'")
    expect(main).toContain("createWindow({ utility: 'personalization' })")
    expect(main).toContain("label: '个人化设置...'")
    expect(main).toContain("ipcMain.handle('personalization:read'")
    expect(main).toContain("ipcMain.handle('personalization:save'")
    expect(main).toContain("ipcMain.on('personalization:dirty'")
    expect(main).toContain('event.sender !== personalizationWindow.webContents')
    expect(main).toContain("message: '个人化设置有尚未保存的更改。'")
    expect(main).toContain("title: '退出 DeepSeek Harness'")
    expect(main).toContain("buttons: ['继续编辑', '放弃更改并退出']")
    const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"))
    expect(beforeQuit.indexOf('if (personalizationDirty && personalizationWindow')).toBeLessThan(beforeQuit.indexOf('if (controller === undefined)'))
  })
})
