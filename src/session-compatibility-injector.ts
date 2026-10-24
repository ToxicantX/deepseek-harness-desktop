import { registerHooks, type ModuleHooks } from 'node:module'

/**
 * 针对 DSH 各版本 Session 历史事件及版本向前/向后兼容的拦截适配器：
 * 
 * 1. 扩充与容错 KNOWN_SESSION_EVENT_TYPES 与 SURFACE_EVENT_TYPES：
 *    在高版本写入但在当前运行时的 dsh-session 中未声明的事件（如 job/registered、job/settled、tool/ptc-dispatch、system/message 等），
 *    自动追加到白名单并在 assertEventsSupported / validateStoredEvents 中宽容放行，防止抛出：
 *    "contains event type "job/registered" (seq 20) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness"
 * 
 * 2. 放宽 assertVersion：
 *    支持高版本 session.v4.jsonl.zstd (meta.version >= 0) 在较早版本 Runtime 打开时不会因 meta.version > SESSION_FORMAT_VERSION
 *    而抛出 SessionFormatUnsupportedError，从而导致前端一直停在“载入历史…”。
 * 
 * 3. 历史会话巨量工具结果（ptc-dispatch / tool/call / tool/result）轻量化瘦身：
 *    在向浏览器下发历史切片时，对长达数十 KB 乃至上百 KB 的超大非表面中间调用参数（如 ptc 读取的大文本文件内容）
 *    做轻量化安全截断与保护，避免单次 follow 往前端塞进数十兆不可变数据导致 Chromium 主线程卡死。
 */
export function adaptSessionPersistenceCompat(source: string): { source: string; changed: boolean } {
  let changed = false
  let result = source

  // 1. 拦截 assertVersion (旧版面向对象风格: assertVersion(meta) { ... })
  const assertVersionMethodAnchor = `\tassertVersion(meta) {
\t\tif (meta.version === SESSION_FORMAT_VERSION) return;
\t\tthrow this.unsupported(meta, sessionFormatVersionRefusal(meta.id, meta.version));
\t}`
  if (result.includes(assertVersionMethodAnchor)) {
    result = result.replace(
      assertVersionMethodAnchor,
      `\tassertVersion(meta) {
\t\tif (typeof meta?.version === "number" && meta.version >= 0) return;
\t\tif (meta?.version === SESSION_FORMAT_VERSION) return;
\t\tthrow this.unsupported(meta, sessionFormatVersionRefusal(meta.id, meta.version));
\t}`
    )
    changed = true
  }

  // 1.1 拦截 assertVersion (0.2.0 函数风格: function assertVersion(meta, location) { ... })
  const assertVersionFuncAnchor = `function assertVersion(meta, location) {
\tif (meta.version !== SESSION_FORMAT_VERSION) throw unsupported(sessionFormatVersionRefusal(meta.id, meta.version), location);
}`
  if (result.includes(assertVersionFuncAnchor)) {
    result = result.replace(
      assertVersionFuncAnchor,
      `function assertVersion(meta, location) {
\tif (typeof meta?.version === "number" && meta.version >= 0) return;
\tif (meta.version !== SESSION_FORMAT_VERSION) throw unsupported(sessionFormatVersionRefusal(meta.id, meta.version), location);
}`
    )
    changed = true
  }

  // 2. 拦截 assertEventsSupported (旧版风格: assertEventsSupported(meta, events) { ... })
  const assertEventsAnchor = `\tassertEventsSupported(meta, events) {
\t\tfor (const event of events) {
\t\t\tif (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue;
\t\t\tthrow this.unsupported(meta, \`session "\${meta.id}" contains event type "\${event.type}" (seq \${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness\`);
\t\t}
\t}`
  if (result.includes(assertEventsAnchor)) {
    result = result.replace(
      assertEventsAnchor,
      `\tassertEventsSupported(meta, events) {
\t\tfor (const event of events) {
\t\t\tif (KNOWN_SESSION_EVENT_TYPES.has(event.type) || event.ignorable === true) continue;
\t\t\tevent.ignorable = true;
\t\t}
\t}`
    )
    changed = true
  }

  // 2.1 拦截 validateStoredEvents (0.2.0 函数风格: function validateStoredEvents(meta, events, location) { ... })
  const validateStoredEventsAnchor = `function validateStoredEvents(meta, events, location) {
\tfor (const event of events) {
\t\tif (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) throw unsupported(\`session "\${meta.id}" contains event type "\${event.type}" (seq \${event.seq}) unknown to this harness and not marked ignorable; refusing to interpret the log — it was likely written by a newer harness\`, location);`
  if (result.includes(validateStoredEventsAnchor)) {
    result = result.replace(
      validateStoredEventsAnchor,
      `function validateStoredEvents(meta, events, location) {
\tfor (const event of events) {
\t\tif (!KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true) {
\t\t\tevent.ignorable = true;
\t\t}`
    )
    changed = true
  }

  return { source: result, changed }
}

export function adaptSessionTypesCompat(source: string): { source: string; changed: boolean } {
  let changed = false
  let result = source

  // 扩充 KNOWN_SESSION_EVENT_TYPES 白名单
  const knownAnchor = `const KNOWN_SESSION_EVENT_TYPES = new Set([`
  if (result.includes(knownAnchor) && !result.includes('"job/registered"')) {
    result = result.replace(
      knownAnchor,
      `const KNOWN_SESSION_EVENT_TYPES = new Set([
\t"job/registered",
\t"job/settled",
\t"tool/ptc-dispatch",
\t"tool/ptc-dispatch-start",
\t"system/message",
\t"developer/message",
\t"assistant/attempt",
\t"workspace/changes",`
    )
    changed = true
  }

  // 扩充 SURFACE_EVENT_TYPES (若缺少 system/message / developer/message 则补充，防止表面折叠失败)
  const surfaceAnchor = `const SURFACE_EVENT_TYPES = new Set([
\t"user/message",`
  if (result.includes(surfaceAnchor)) {
    result = result.replace(
      surfaceAnchor,
      `const SURFACE_EVENT_TYPES = new Set([
\t"system/message",
\t"developer/message",
\t"user/message",`
    )
    changed = true
  }

  return { source: result, changed }
}

export function adaptSessionControllerWindow(source: string): { source: string; changed: boolean } {
  let changed = false
  let result = source

  // 关键结论（实测得出）：paginate 里 turnWindow 分支先命中就 break，
  // maxMessages 根本走不到，所以只改 maxMessages 对首屏体积毫无影响。
  // 实测本机会话：
  //   {minMessages:50,minTurns:2} => 597 条 / 633KB
  //   {minMessages:10,minTurns:1} => 597 条 / 633KB
  //   {minMessages:6, minTurns:1} =>  58 条 /  43KB
  // 因此这里必须收紧 turnWindow，并把客户端传入的 turnWindow 一并覆盖。
  const PAGINATE_LIMIT = 80
  const TURN_WINDOW_LITERAL = '{ minMessages: 6, minTurns: 1 }'

  const serverFollow = `const page = paginate(events, void 0, request.maxMessages ?? DEFAULT_MAX_MESSAGES, cursor, request.turnWindow);`
  if (result.includes(serverFollow)) {
    result = result.replace(
      serverFollow,
      `const page = paginate(events, void 0, Math.min(request.maxMessages ?? DEFAULT_MAX_MESSAGES, ${PAGINATE_LIMIT}), cursor, ${TURN_WINDOW_LITERAL});`
    )
    changed = true
  }

  const serverPage = `const page = paginate(sourceLog, beforeSeq, request.maxMessages ?? DEFAULT_MAX_MESSAGES, throughSeq, request.turnWindow);`
  if (result.includes(serverPage)) {
    result = result.replace(
      serverPage,
      `const page = paginate(sourceLog, beforeSeq, Math.min(request.maxMessages ?? DEFAULT_MAX_MESSAGES, ${PAGINATE_LIMIT}), throughSeq, ${TURN_WINDOW_LITERAL});`
    )
    changed = true
  }

  // 浏览器侧那一份仍然顺手改掉（若被打包进 Node 侧时同样生效）。
  const clientOptions = `const HISTORY_PAGE_OPTIONS = { maxMessages: 500, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } };`
  if (result.includes(clientOptions)) {
    result = result.replace(
      clientOptions,
      `const HISTORY_PAGE_OPTIONS = { maxMessages: ${PAGINATE_LIMIT}, turnWindow: { minMessages: PAGE_MESSAGES, minTurns: 2 } };`
    )
    changed = true
  }

  return { source: result, changed }
}

export function adaptSessionControllerPruning(source: string): { source: string; changed: boolean } {
  let changed = false
  let result = source

  // 服务端负责裁剪下发给浏览器的历史切片：ptc 大参数、tool 结果长文本都会被折叠。
  // 每次折叠都会打印实际体积，便于确认瘦身是否生效。
  const sanitizerCode = `function dshSanitizeEventPayload(ev) {
\tif (!ev || typeof ev !== "object" || !ev.data || typeof ev.data !== "object") return ev;
\tif (ev.type === "tool/ptc-dispatch" && typeof ev.data.arguments === "object" && ev.data.arguments !== null) {
\t\tconst clone = { ...ev, data: { ...ev.data } };
\t\tconst args = { ...clone.data.arguments };
\t\tlet trimmed = 0;
\t\tfor (const k of Object.keys(args)) {
\t\t\tif (typeof args[k] === "string" && args[k].length > 4096) {
\t\t\t\ttrimmed += args[k].length;
\t\t\t\targs[k] = args[k].slice(0, 1024) + "\\n... [桌面端历史渲染保护：大文件参数已折叠] ...";
\t\t\t}
\t\t}
\t\tclone.data.arguments = args;
\t\tif (trimmed > 0) console.log("[DSH-PRUNE] ptc-dispatch seq=" + ev.seq + " folded " + trimmed + " chars");
\t\treturn clone;
\t}
\tif (ev.type === "tool/result" && ev.data.message && typeof ev.data.message.content === "object" && ev.data.message.content !== null) {
\t\tconst clone = { ...ev, data: { ...ev.data, message: { ...ev.data.message } } };
\t\tconst content = clone.data.message.content;
\t\tif (Array.isArray(content)) {
\t\t\tlet folded = 0;
\t\t\tclone.data.message.content = content.map(part => {
\t\t\t\tif (part && typeof part.text === "string" && part.text.length > 32768) {
\t\t\t\t\tfolded += part.text.length;
\t\t\t\t\treturn { ...part, text: part.text.slice(0, 16384) + "\\n\\n... [桌面端历史渲染保护：巨型工具输出已折叠截断] ..." };
\t\t\t\t}
\t\t\t\treturn part;
\t\t\t});
\t\t\tif (folded > 0) console.log("[DSH-PRUNE] tool/result seq=" + ev.seq + " folded " + folded + " chars");
\t\t}
\t\treturn clone;
\t}
\treturn ev;
}`

  const entryForAnchor = `function entryFor(event) {
\treturn {
\t\ttype: "event",
\t\tevent
\t};
}`
  if (result.includes(entryForAnchor)) {
    result = result.replace(
      entryForAnchor,
      `${sanitizerCode}
function entryFor(event) {
\treturn {
\t\ttype: "event",
\t\tevent: dshSanitizeEventPayload(event)
\t};
}`
    )
    changed = true
  }

  // pageRecords 是服务端组装 snapshot 切片的出口，在这里量一次体积。
  const pageRecordsAnchor = `function pageRecords(events) {
\treturn events.map(entryFor);
}`
  if (result.includes(pageRecordsAnchor)) {
    result = result.replace(
      pageRecordsAnchor,
      `function pageRecords(events) {
\tconst records = events.map(entryFor);
\ttry {
\t\tconst bytes = JSON.stringify(records).length;
\t\tconsole.log("[DSH-PRUNE] outbound snapshot: " + records.length + " records, " + (bytes / 1024 / 1024).toFixed(2) + " MB");
\t} catch (error) {
\t\tconsole.log("[DSH-PRUNE] outbound snapshot size measurement failed", error);
\t}
\treturn records;
}`
    )
    changed = true
  }

  const clientHistoryEntriesAnchor = `function historyEntries(records) {
\t\t\treturn records;
\t\t}`
  if (result.includes(clientHistoryEntriesAnchor)) {
    result = result.replace(
      clientHistoryEntriesAnchor,
      `${sanitizerCode}
\t\tfunction historyEntries(records) {
\t\t\treturn records.map(r => r && r.event ? { ...r, event: dshSanitizeEventPayload(r.event) } : r);
\t\t}`
    )
    changed = true
  }

  const cjsHistoryEntriesAnchor = `function historyEntries(records) {
    return records;
}`
  if (result.includes(cjsHistoryEntriesAnchor)) {
    result = result.replace(
      cjsHistoryEntriesAnchor,
      `${sanitizerCode}
function historyEntries(records) {
    return records.map(r => r && r.event ? { ...r, event: dshSanitizeEventPayload(r.event) } : r);
}`
    )
    changed = true
  }

  return { source: result, changed }
}

export function installSessionCompatibilityHook(register: typeof registerHooks = registerHooks): ModuleHooks {
  console.log('[DSH-HOOK] installSessionCompatibilityHook is registering module loader...')
  return register({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context)
      if (!url.startsWith('file:')) return loaded
      const path = decodeURIComponent(new URL(url).pathname)

      const isPersistence = path.endsWith('/node_modules/@deepseek-ai/dsh-session-persistence/lib/index.js')
      const isSession = path.endsWith('/node_modules/@deepseek-ai/dsh-session/lib/index.js')
        || path.endsWith('/node_modules/@deepseek-ai/dsh-session/lib/types/known-event-types.js')
      const isController = path.endsWith('/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js')
        || path.endsWith('/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js')
        || path.endsWith('/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/session.js')
        || path.endsWith('/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/sessions/history-records.js')
        || path.endsWith('/node_modules/@deepseek-ai/dsh-api-session-controller/lib/types/client/transport.js')

      if (!isPersistence && !isSession && !isController) return loaded
      if (loaded.source === undefined) return loaded

      console.log(`[DSH-HOOK] Intercepting module load: ${path}`)

      const raw = loaded.source
      const text = typeof raw === 'string' ? raw : ArrayBuffer.isView(raw)
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
        : Buffer.from(raw).toString('utf8')

      let res = isPersistence ? adaptSessionPersistenceCompat(text)
        : isSession ? adaptSessionTypesCompat(text)
        : adaptSessionControllerPruning(adaptSessionControllerWindow(text).source)


      if (res.changed) {
        console.log(`[DSH-HOOK] Successfully patched module: ${path}`)
        return { ...loaded, source: res.source }
      } else {
        console.warn(`[DSH-HOOK] Module did not match patch patterns: ${path}`)
      }
      return loaded
    },
  })
}
