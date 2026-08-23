import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileContextInjectorScript } from '../src/file-context-injector.ts'

const root = join(import.meta.dirname, '..')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')

describe('desktop text and file context contract', () => {
  it('bounds inline file reads and leaves binary files to the Web app', () => {
    const script = createFileContextInjectorScript()
    expect(script).toContain('const MAX_BYTES = 8 * 1024 * 1024')
    expect(script).toContain('const LARGE_FILE_BYTES = 2 * 1024 * 1024')
    expect(script).toContain('const MAX_FILES = 32')
    expect(script.match(/new TextEncoder\(\)\.encode\(text\)\.byteLength > MAX_BYTES/gu)).toHaveLength(2)
    expect(script).toContain('files.filter(file => !isBinaryFile(file)).slice(0, MAX_FILES)')
    expect(script).toContain(String.raw`text.slice(0, 8192).includes('\0')`)
    expect(script).toContain("if (isBinaryFile(file)) return")
    expect(script).toContain("typeof api.getAbsolutePath === 'function'")
    expect(script).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u)
  })

  it('is reinjection-safe and expands pending clips before submit', () => {
    const script = createFileContextInjectorScript()
    expect(script).toContain("if (previous && typeof previous.dispose === 'function') previous.dispose()")
    expect(script).toContain("document.addEventListener('keydown', onSubmit, true)")
    expect(script).toContain("document.addEventListener('submit', onSubmit, true)")
    expect(script).toContain('for (const entry of clips.values()) value = appendEntry(value, entry)')
  })

  it('exposes only Electron file-path resolution and injects on the trusted main page', () => {
    expect(preload).toContain("contextBridge.exposeInMainWorld('dshDesktopFiles'")
    expect(preload).toContain('webUtils.getPathForFile(file)')
    expect(main).toContain('new URL(window.webContents.getURL()).origin !== trustedOrigin')
    expect(main).toContain('executeJavaScript(createFileContextInjectorScript())')
    expect(main).toContain("window.webContents.on('context-menu'")
    expect(main).toContain('createWebContextMenuTemplate(params)')
  })
})
