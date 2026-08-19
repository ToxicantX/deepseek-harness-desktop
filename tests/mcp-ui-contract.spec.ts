import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = join(import.meta.dirname, '..')
const html = readFileSync(join(root, 'assets', 'mcp-manager.html'), 'utf8')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')
const codexMcp = readFileSync(join(root, 'src', 'codex-mcp.ts'), 'utf8')

describe('MCP manager UI contract', () => {
  it('ships a script-free local management page with search, filters, and status controls', () => {
    for (const id of [
      'mcp-manager-page',
      'mcp-count',
      'mcp-search',
      'mcp-filter-all',
      'mcp-filter-enabled',
      'mcp-filter-disabled',
      'mcp-refresh',
      'mcp-status',
      'mcp-progress',
      'mcp-list',
      'mcp-empty',
    ]) expect(html).toContain('id="' + id + '"')
    expect(html).toContain("default-src 'none'")
    expect(html).toContain('role="group"')
    expect(html).toContain('.switch input:checked + .switch-track')
    expect(html).not.toMatch(/<script|\son[a-z]+=/iu)
  })

  it('renders MCP data with DOM APIs and exposes no HTML injection sink', () => {
    expect(preload).toContain("ipcRenderer.invoke('mcp-manager:list')")
    expect(preload).toContain("ipcRenderer.invoke('mcp-manager:set-enabled'")
    expect(preload).toContain("document.querySelector('#mcp-manager-page')")
    expect(preload).toContain("toggle.type = 'checkbox'")
    expect(preload).toContain('toggle.indeterminate = entry.dynamic === true')
    expect(preload).toContain("toggle.dataset.mutable = String(entry.mutable)")
    expect(preload).toContain("entry.provider === 'MCP Lens'")
    expect(preload).toContain("entry.management === 'codex-import'")
    expect(preload).toContain('接入 DSH')
    expect(preload).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u)
  })

  it('restricts MCP IPC to its utility window and coordinates Runtime restart', () => {
    expect(main).toContain("const mcpManagerPage = join(app.getAppPath(), 'assets', 'mcp-manager.html')")
    expect(main).toContain("mcpWindow = createWindow({ utility: 'mcp' })")
    expect(main).toContain('event.sender !== mcpWindow.webContents')
    expect(main).toContain("ipcMain.handle('mcp-manager:list'")
    expect(main).toContain("ipcMain.handle('mcp-manager:set-enabled'")
    expect(main).toContain('mcpManager = new McpManager({')
    expect(main).toContain("codexConfigPath: join(homedir(), '.codex', 'config.toml')")
    expect(codexMcp).toContain('parseTOML(source')
    expect(codexMcp).not.toMatch(/writeFile|rename|rmSync|unlink/u)
    expect(main).toContain("return runtime === undefined ? [] : [join(runtime.directory, 'app', 'desktop.patch.yml')]")
    expect(main).toContain('mutateMcpWithRuntime({')
    expect(main).toContain('await runtimeController.pauseForPluginMutation()')
    expect(main).toContain('if (!quitting) await runtimeController.retry()')
    expect(main).toContain("if (quitting) throw new Error('应用正在退出，无法切换 MCP')")
    expect(main).toContain("pluginManager?.current() !== undefined")
    expect(main).toContain("if (mcpMutationActive) throw new Error('MCP 操作正在进行，请完成后再管理插件')")
  })
})
