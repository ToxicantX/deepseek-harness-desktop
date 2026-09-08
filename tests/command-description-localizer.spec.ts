import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  COMMAND_DESCRIPTION_TRANSLATIONS,
  createCommandDescriptionLocalizerScript,
  localizeCommandDescription,
} from '../src/command-description-localizer.ts'

const root = join(import.meta.dirname, '..')
const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8')
const preload = readFileSync(join(root, 'src', 'preload.ts'), 'utf8')

describe('command description localization injection', () => {
  it('localizes only the six known English slash-command descriptions', () => {
    expect(Object.keys(COMMAND_DESCRIPTION_TRANSLATIONS)).toHaveLength(6)
    expect(localizeCommandDescription('Compact older conversation history')).toBe('压缩较早的对话历史')
    expect(localizeCommandDescription('Download this Session log as a ZIP archive')).toBe('将本会话日志下载为 ZIP 压缩包')
    expect(localizeCommandDescription('record feedback about this session')).toBe('记录对此会话的反馈')
    expect(localizeCommandDescription('set or view the goal for a long-running task')).toBe('设置或查看长时间运行任务的目标')
    expect(localizeCommandDescription('Switch the permission preset (sandbox mode + approval policy)')).toBe('切换权限预设（沙盒模式 + 审批策略）')
    expect(localizeCommandDescription('Enter or leave plan mode')).toBe('进入或退出计划模式')
    expect(localizeCommandDescription('选择本会话使用的模型')).toBe('选择本会话使用的模型')
    expect(localizeCommandDescription('Keep upstream copy')).toBe('Keep upstream copy')
  })

  it('localizes existing and dynamically added rendered command options', () => {
    const script = createCommandDescriptionLocalizerScript()
    let observeCalls = 0
    let disconnected = false
    let notify: ((records: Array<{ type: string, target: object, addedNodes: object[] }>) => void) | undefined
    class FakeElement {
      constructor(
        readonly commandOption: boolean,
        readonly spans: Array<{ textContent: string }>,
        readonly options: FakeElement[] = [],
      ) {}
      matches(): boolean { return this.commandOption }
      querySelectorAll(selector: string): Array<FakeElement | { textContent: string }> {
        return selector === 'span' ? this.spans : this.options
      }
      closest(): FakeElement | null { return this.commandOption ? this : null }
    }
    class FakeDocument {
      readonly documentElement = new FakeElement(false, [])
      constructor(readonly options: FakeElement[]) {}
      querySelectorAll(): FakeElement[] { return this.options }
    }
    class FakeMutationObserver {
      constructor(callback: typeof notify) { notify = callback }
      observe(): void { observeCalls += 1 }
      disconnect(): void { disconnected = true }
    }
    const existingDescription = { textContent: 'Compact older conversation history' }
    const existing = new FakeElement(true, [{ textContent: 'compact' }, existingDescription])
    const documentFixture = new FakeDocument([existing])
    const windowFixture: Record<string, unknown> = {}
    const execute = new Function('window', 'document', 'Element', 'Document', 'MutationObserver', 'return ' + script)

    expect(execute(windowFixture, documentFixture, FakeElement, FakeDocument, FakeMutationObserver)).toEqual({ ok: true })
    expect(existingDescription.textContent).toBe('压缩较早的对话历史')
    expect(observeCalls).toBe(1)

    const dynamicDescription = { textContent: 'Enter or leave plan mode' }
    const dynamic = new FakeElement(true, [{ textContent: 'plan' }, dynamicDescription])
    notify?.([{ type: 'childList', target: dynamic, addedNodes: [dynamic] }])
    expect(dynamicDescription.textContent).toBe('进入或退出计划模式')

    const hook = windowFixture.__dshDesktopCommandDescriptionLocalizer as { dispose(): void }
    hook.dispose()
    expect(disconnected).toBe(true)
    expect(script).not.toMatch(/prototype\.candidates|registerModuleFactoryTransform|CommandUiRuntime/u)
  })

  it('injects after trusted-page validation without changing the preload module factories', () => {
    const validationIndex = main.indexOf('new URL(window.webContents.getURL()).origin !== trustedOrigin')
    const injectionIndex = main.indexOf('executeJavaScript(createCommandDescriptionLocalizerScript())')
    expect(validationIndex).toBeGreaterThanOrEqual(0)
    expect(injectionIndex).toBeGreaterThan(validationIndex)
    expect(preload).not.toContain('installCommandDescriptionLocalizationHook')
    expect(preload).not.toContain('injectCommandDescriptionLocalizationFactory')
  })
})
