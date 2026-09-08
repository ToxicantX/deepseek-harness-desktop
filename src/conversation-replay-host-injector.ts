import { registerHooks, type LoadFnOutput } from 'node:module'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

/**
 * Serialized into the host module. The Runtime owns these objects; their layout is
 * checked at admission rather than coupled to the shell's installed SDK types.
 */
export async function admitDesktopReplay(agent: any, message: any, targetSeq: number): Promise<void> {
  if (typeof agent.runMaintenance !== 'function' || typeof agent.whenIdle !== 'function') {
    throw new Error('当前 Runtime 不支持原会话重试维护阶段')
  }
  let cleanup = () => {}
  try {
    await agent.runMaintenance(async (signal: AbortSignal) => {
      signal.throwIfAborted()
      const session = agent.session
      const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : session.events
      const nodes = [...session.surface.nodes]
      const target = events[targetSeq]
      const start = events.slice(0, targetSeq).findLast((event: any) => event.type === 'turn/start')
      if (agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw new Error('请等待排队消息处理完成')
      if (!message.content.some((part: any) => part.type !== 'text' || part.text.trim())) throw new Error('消息内容为空')
      if (!Number.isSafeInteger(targetSeq) || target?.type !== 'user/message'
        || target.data.source.kind !== 'user' || !nodes.includes(targetSeq) || !start) {
        throw new Error('目标消息已失效或已被压缩')
      }
      if (events.slice(start.seq + 1, targetSeq).some((event: any) => event.type === 'user/message' && event.data.source.kind === 'user')) {
        throw new Error('暂不支持同轮追加消息的回退')
      }
      const sourceEventSeqs = nodes.slice(nodes.indexOf(targetSeq))
      const replacement = {
        ...message,
        source: { ...message.source, desktopReplay: { version: 1, targetSeq, fromSeq: start.seq, throughSeq: events.at(-1).seq } },
      }
      const original = session.append
      const ownDescriptor = Object.getOwnPropertyDescriptor(session, 'append')
      const wrapped = function (this: any, type: string, data: any, options: any) {
        if (type !== 'user/message' || data.id !== replacement.id) return original.call(this, type, data, options)
        cleanup()
        // Commit through the original validator. No history changes if pre-step
        // admission drops the message or replacement validation rejects.
        return original.call(this, type, data, {
          ...options,
          surfaceOp: { op: 'replace', start: targetSeq, end: sourceEventSeqs.at(-1) },
          sourceEventSeqs,
        })
      }
      cleanup = () => {
        if (session.append !== wrapped) return
        if (ownDescriptor) Object.defineProperty(session, 'append', ownDescriptor)
        else delete session.append
      }
      Object.defineProperty(session, 'append', { configurable: true, writable: true, value: wrapped })
      agent.followup(replacement)
    })
  } catch (error) {
    cleanup()
    throw error
  }
  // Also restore when a guard rejects or removes the queued message.
  void agent.whenIdle().then(cleanup, cleanup)
}

export function injectDesktopReplayHost(source: string): { source: string; changed: boolean } {
  const schema = /const sessionPromptRequestSchema = ([\w$]+)\.object\(\{([\s\S]*?)\n\}\);/u
  const match = source.match(schema)
  if (!match || !/mode: [\w$]+\.union\(\[\s*[\w$]+\.literal\("queue"\),\s*[\w$]+\.literal\("steer"\)\s*\]\)/u.test(match[2]!)) {
    return { source, changed: false }
  }
  const replacements: Array<[string, string]> = [
    ['const { sessionId, mode, content, clientTimeZone } = request.payload;',
      'const { sessionId, mode, content, clientTimeZone, desktopReplayFrom } = request.payload;'],
    ['if (mode === "steer") agent.steer(message);',
      'if (mode === "desktop-replay-v1") await dshDesktopAdmitReplay(agent, message, desktopReplayFrom);\nelse if (mode === "steer") agent.steer(message);'],
  ]
  if (replacements.some(([text]) => source.split(text).length !== 2)) return { source, changed: false }
  const z = match[1]!
  const extended = match[0].replace(
    /mode: [\w$]+\.union\(\[[\s\S]*?\]\)/u,
    `mode: ${z}.union([${z}.literal("queue"), ${z}.literal("steer"), ${z}.literal("desktop-replay-v1")])`,
  ).replace('sessionId: sessionIdSchema,', `sessionId: sessionIdSchema,\n desktopReplayFrom: ${z}.number().int().nonnegative().optional(),`)
  let transformed = source.replace(match[0], extended)
  for (const [text, replacement] of replacements) transformed = transformed.replace(text, replacement)
  transformed += `\nconst dshDesktopAdmitReplay = (${admitDesktopReplay.toString()});\n`
  return { source: transformed, changed: true }
}

/** Newer Runtime packages split the controller and its generated input codec. */
export function injectDesktopReplayController(source: string): { source: string; changed: boolean } {
  const anchor = 'if (request.mode === "steer") agent.steer(message);'
  if (source.split(anchor).length !== 2) return { source, changed: false }
  return {
    changed: true,
    source: source.replace(anchor, 'if (request.mode === "desktop-replay-v1") await dshDesktopAdmitReplay(agent, message, request.desktopReplayFrom);\nelse ' + anchor)
      + `\nconst dshDesktopAdmitReplay = (${admitDesktopReplay.toString()});\n`,
  }
}

export function injectDesktopReplayCodec(source: string): { source: string; changed: boolean } {
  const anchor = `'mode': z.union([z.literal("queue"), z.literal("steer")]).readonly(),`
  if (source.split(anchor).length !== 2) return { source, changed: false }
  return { changed: true, source: source.replace(anchor,
    `'mode': z.union([z.literal("queue"), z.literal("steer"), z.literal("desktop-replay-v1")]).readonly(),\n'desktopReplayFrom': z.number().int().nonnegative().optional(),`) }
}

export function installDesktopReplayHostHook(register: typeof registerHooks = registerHooks): void {
  try {
    register({
      load(url, context, nextLoad) {
        const loaded = nextLoad(url, context)
        try {
          const path = decodeURIComponent(new URL(url).pathname).replaceAll('\\', '/')
          const legacy = path.endsWith('/@deepseek-ai/dsh-host-apiproxy/lib/index.js')
          const controller = /\/@deepseek-ai\/dsh-api-session-controller\/lib\/(?:index|typert\.host)\.js$/u.test(path)
          if (!legacy && !controller) return loaded
          const raw: LoadFnOutput['source'] = loaded.source
          if (raw === undefined) return loaded
          const text = typeof raw === 'string' ? raw : ArrayBuffer.isView(raw)
            ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
            : Buffer.from(raw).toString('utf8')
          let result
          if (controller) {
            const directory = dirname(fileURLToPath(url))
            // Both halves must match before either is exposed. In particular,
            // never accept a new mode on an unadapted ordinary-send controller.
            const index = readFileSync(join(directory, 'index.js'), 'utf8')
            const codec = readFileSync(join(directory, 'typert.host.js'), 'utf8')
            const adaptedIndex = injectDesktopReplayController(index)
            const adaptedCodec = injectDesktopReplayCodec(codec)
            if (!adaptedIndex.changed || !adaptedCodec.changed) return loaded
            const isIndex = path.endsWith('/index.js')
            if (text !== (isIndex ? index : codec)) return loaded
            result = isIndex ? adaptedIndex : adaptedCodec
          } else result = injectDesktopReplayHost(text)
          if (!result.changed) console.warn('桌面壳原会话重试：当前 Runtime 未匹配适配，保留原始模块')
          return result.changed ? { ...loaded, source: result.source } : loaded
        } catch (error) {
          console.error('桌面壳原会话重试适配失败，保留原始模块', error)
          return loaded
        }
      },
    })
  } catch (error) {
    console.error('桌面壳原会话重试加载钩子安装失败', error)
  }
}
