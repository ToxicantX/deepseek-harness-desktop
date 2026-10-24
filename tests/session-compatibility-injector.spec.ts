import { describe, expect, it } from 'vitest'
import {
  adaptSessionPersistenceCompat,
  adaptSessionTypesCompat,
  adaptSessionControllerPruning,
  adaptSessionControllerWindow,
} from '../src/session-compatibility-injector.ts'

import { createSessionHistoryVirtualizerScript } from '../src/session-history-virtualizer-injector.ts'

describe('session compatibility & long history stability', () => {
  it('adapts KNOWN_SESSION_EVENT_TYPES to include newer harness event types', () => {
    const raw = `const KNOWN_SESSION_EVENT_TYPES = new Set([\n\t"agent-preset/selected",\n\t"turn/start"\n]);`
    const { source, changed } = adaptSessionTypesCompat(raw)
    expect(changed).toBe(true)
    expect(source).toContain('"job/registered"')
    expect(source).toContain('"job/settled"')
    expect(source).toContain('"tool/ptc-dispatch"')
  })

  it('adapts SURFACE_EVENT_TYPES to include newer surface message event types', () => {
    const raw = `const SURFACE_EVENT_TYPES = new Set([\n\t"user/message",\n\t"assistant/message"\n]);`
    const { source, changed } = adaptSessionTypesCompat(raw)
    expect(changed).toBe(true)
    expect(source).toContain('"system/message"')
    expect(source).toContain('"developer/message"')
  })

  it('adapts assertVersion to allow newer session format versions in both method and func styles', () => {
    const methodRaw = `\tassertVersion(meta) {\n\t\tif (meta.version === SESSION_FORMAT_VERSION) return;\n\t\tthrow this.unsupported(meta, sessionFormatVersionRefusal(meta.id, meta.version));\n\t}`
    const methodAdapted = adaptSessionPersistenceCompat(methodRaw)
    expect(methodAdapted.changed).toBe(true)
    expect(methodAdapted.source).toContain('meta.version >= 0')

    const funcRaw = `function assertVersion(meta, location) {\n\tif (meta.version !== SESSION_FORMAT_VERSION) throw unsupported(sessionFormatVersionRefusal(meta.id, meta.version), location);\n}`
    const funcAdapted = adaptSessionPersistenceCompat(funcRaw)
    expect(funcAdapted.changed).toBe(true)
    expect(funcAdapted.source).toContain('meta.version >= 0')
  })

  it('adapts assertEventsSupported and validateStoredEvents to tolerate newer unknown event types with ignorable flag', () => {
    const rawMethod = `\tassertEventsSupported(meta, events) {\n\t\tfor (const event of events) {\n\t\t\tif (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue;\n\t\t\tthrow this.unsupported(meta, \`session "\${meta.id}" contains event type "\${event.type}" (seq \${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness\`);\n\t\t}\n\t}`
    const methodAdapted = adaptSessionPersistenceCompat(rawMethod)
    expect(methodAdapted.changed).toBe(true)
    expect(methodAdapted.source).toContain('event.ignorable = true')

    const rawFunc = `function validateStoredEvents(meta, events, location) {\n\tfor (const event of events) {\n\t\tif (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(\`session "\${meta.id}" contains event type "\${event.type}" (seq \${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness\`, location);`
    const funcAdapted = adaptSessionPersistenceCompat(rawFunc)
    expect(funcAdapted.changed).toBe(true)
    expect(funcAdapted.source).toContain('event.ignorable = true;')
  })

  it('adapts session controller to prune oversized intermediate ptc dispatch payloads on wire', () => {
    const raw = `function entryFor(event) {\n\treturn {\n\t\ttype: "event",\n\t\tevent\n\t};\n}`
    const adapted = adaptSessionControllerPruning(raw)
    expect(adapted.changed).toBe(true)
    expect(adapted.source).toContain('dshSanitizeEventPayload')
    expect(adapted.source).toContain('大文件参数已折叠')
  })

  it('tightens the real pagination driver: turnWindow, not maxMessages', () => {
    // paginate 里 turnWindow 分支先命中就 break，maxMessages 走不到，
    // 所以必须覆盖 turnWindow 才能真的缩小首屏。
    const raw = [
      'const page = paginate(events, void 0, request.maxMessages ?? DEFAULT_MAX_MESSAGES, cursor, request.turnWindow);',
      'const page = paginate(sourceLog, beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES, throughSeq, request.turnWindow);',
    ].join('\n')
    const adapted = adaptSessionControllerWindow(raw)
    expect(adapted.changed).toBe(true)
    expect(adapted.source).toContain('minMessages: 6, minTurns: 1')
    expect(adapted.source).not.toMatch(/paginate\([^)]*request\.turnWindow\)/)
  })

  it('keeps the renderer injector passive by default (no injected layout mutations)', () => {
    const script = createSessionHistoryVirtualizerScript()
    expect(script).toContain('__dshDesktopSessionVirtualizer')
    // 默认必须关闭布局改写：历史上它被怀疑与 DSH 的 ResizeObserver 互相激发。
    expect(script).toContain('const ENABLE_LAYOUT_TWEAKS = false;')
    // 只读观测能力保留。
    expect(script).toContain('longtask')
    expect(script).toContain('heartbeat gap')
  })
})
