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

  it('limits long-text clipping to the active chat composer', () => {
    const script = createFileContextInjectorScript()
    expect(script).toContain("const CHAT_EDITOR_SELECTOR = '[data-composer-card=\"true\"] [data-input-scroll=\"true\"] textarea")
    expect(script).toContain('const editor = editorFromTarget(event.target)')
    expect(script).toContain('if (!isChatEditor(editor)) return')
    expect(script).toContain('appendText(editor, text)')
    expect(script).toContain('handleFile(editor, file)')
    expect(script).not.toContain("document.querySelectorAll('textarea,[contenteditable=\"true\"]')")
  })

  it('keeps the browser paste path for non-chat textareas', () => {
    const listeners = new Map<string, (event: { target: object, preventDefault: () => void, stopImmediatePropagation: () => void }) => void>()
    class FakeElement {
      constructor(private readonly chatEditor: boolean) {}
      matches(): boolean { return true }
      closest(selector: string): FakeElement | null {
        if (selector === 'textarea,[contenteditable="true"]') return this
        return this.chatEditor ? this : null
      }
    }
    class FakeHTMLElement extends FakeElement {}
    class FakeTextAreaElement extends FakeHTMLElement {}
    class FakeInputElement extends FakeHTMLElement {}
    const windowFixture = {
      addEventListener: (type: string, listener: (event: { target: object, preventDefault: () => void, stopImmediatePropagation: () => void }) => void) => listeners.set(type, listener),
      removeEventListener: () => undefined,
    }
    const documentFixture = {
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      querySelectorAll: () => [],
    }
    const execute = new Function('window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement', 'InputEvent', 'Node', 'HTMLFormElement', 'HTMLButtonElement', 'KeyboardEvent', 'return ' + createFileContextInjectorScript())
    execute(windowFixture, documentFixture, FakeElement, FakeHTMLElement, FakeTextAreaElement, FakeInputElement, class {}, class {}, class {}, class {}, class {})
    let intercepted = false
    listeners.get('paste')?.({
      target: new FakeTextAreaElement(false),
      preventDefault: () => { intercepted = true },
      stopImmediatePropagation: () => { intercepted = true },
    })
    expect(intercepted).toBe(false)
  })

  it('is reinjection-safe and expands pending clips before keyboard, form, or send-button submit', () => {
    const script = createFileContextInjectorScript()
    expect(script).toContain("if (previous && typeof previous.dispose === 'function') previous.dispose()")
    expect(script).toContain("document.addEventListener('keydown', onSubmit, true)")
    expect(script).toContain("document.addEventListener('click', onSubmit, true)")
    expect(script).toContain("document.addEventListener('submit', onSubmit, true)")
    expect(script).toContain("const SEND_BUTTON_LABELS = new Set(['发送消息', 'send message'])")
    expect(script).toContain("button.closest('[data-composer-card=\"true\"]')")
    expect(script).toContain("else if (button) replayButtonClick(button)")
    expect(script).toContain('try { button.click(); }')
    expect(script).toContain('for (const entry of clips.values()) value = appendEntry(value, entry)')
  })

  it('expands a pending clip before replaying the DSH send-button click', async () => {
    const listeners = new Map<string, (event: any) => void>()
    let editor: FakeTextAreaElement
    let sent: string | undefined
    class FakeElement {
      closest(_selector: string): FakeElement | null { return null }
    }
    class FakeHTMLElement extends FakeElement {
      matches(_selector: string): boolean { return false }
    }
    const composer = new class extends FakeHTMLElement {
      querySelector(selector: string): FakeTextAreaElement | null {
        return selector.includes('textarea') ? editor : null
      }
    }()
    class FakeTextAreaElement extends FakeHTMLElement {
      private current = ''
      get value(): string { return this.current }
      set value(value: string) { this.current = value }
      override matches(selector: string): boolean { return selector.includes('textarea') }
      override closest(selector: string): FakeElement | null {
        if (selector === 'textarea,[contenteditable="true"]') return this
        if (selector === '[data-composer-card="true"]') return composer
        if (selector === '[data-input-scroll="true"]') return this
        return null
      }
      dispatchEvent(): boolean { return true }
      focus(): void {}
    }
    class FakeInputElement extends FakeHTMLElement {}
    class FakeFormElement extends FakeHTMLElement {}
    class FakeButtonElement extends FakeHTMLElement {
      disabled = false
      getAttribute(name: string): string | null { return name === 'aria-label' ? '发送消息' : null }
      override closest(selector: string): FakeElement | null {
        if (selector === 'button[aria-label]') return this
        if (selector === '[data-composer-card="true"]') return composer
        return null
      }
      click(): void {
        const event = {
          type: 'click',
          target: this,
          stopped: false,
          preventDefault() {},
          stopImmediatePropagation() { this.stopped = true },
        }
        listeners.get('click')?.(event)
        if (!event.stopped) sent = editor.value
      }
    }
    const button = new FakeButtonElement()
    class FakeIconElement extends FakeElement {
      override closest(selector: string): FakeElement | null { return selector === 'button[aria-label]' ? button : null }
    }
    class PendingClipMap extends Map<string, any> {
      constructor() {
        super()
        this.set('clip-1', { name: 'long.textclip', text: '长文本'.repeat(200), isFile: false, element: null })
      }
    }
    const windowFixture = { addEventListener() {}, removeEventListener() {} } as any
    const documentFixture = {
      addEventListener: (type: string, listener: (event: any) => void) => listeners.set(type, listener),
      removeEventListener() {},
      querySelectorAll: () => [],
    }
    const execute = new Function(
      'window', 'document', 'Element', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLInputElement',
      'InputEvent', 'Node', 'HTMLFormElement', 'HTMLButtonElement', 'KeyboardEvent', 'Map',
      'return ' + createFileContextInjectorScript(),
    )
    execute(
      windowFixture, documentFixture, FakeElement, FakeHTMLElement, FakeTextAreaElement, FakeInputElement,
      class {}, FakeElement, FakeFormElement, FakeButtonElement, class {}, PendingClipMap,
    )
    editor = new FakeTextAreaElement()
    editor.value = '修复这个问题'
    const event = {
      type: 'click',
      target: new FakeIconElement(),
      prevented: false,
      stopped: false,
      preventDefault() { this.prevented = true },
      stopImmediatePropagation() { this.stopped = true },
    }

    listeners.get('click')?.(event)
    await new Promise(resolve => setTimeout(resolve, 5))

    expect(event).toMatchObject({ prevented: true, stopped: true })
    expect(sent).toBe('修复这个问题\n\n' + '长文本'.repeat(200))
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
