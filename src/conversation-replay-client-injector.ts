/** Self-contained because preload serializes this transform into the main world. */
export function injectDesktopReplayClient(source: string): { source: string; changed: boolean } {
  const codecAnchor = 'function parseInput(codec, value, endpoint, field) {'
  if (source.split(codecAnchor).length === 2) {
    return { changed: true, source: source.replace(codecAnchor, codecAnchor + `
      if (codec.mode === "strict" && endpoint === "session/prompt" && value?.mode === "desktop-replay-v1") {
        if (!Number.isSafeInteger(value.desktopReplayFrom) || value.desktopReplayFrom < 0) throw new Error("无效重试目标");
        const parsed = codec.schema.parse({ ...value, mode: "queue" });
        return { ...parsed, mode: "desktop-replay-v1", desktopReplayFrom: value.desktopReplayFrom };
      }
    `) }
  }
  const methods = `
    async desktopReplay(targetSeq, content) {
      if (this.address !== void 0) return { ok: false, error: { message: "暂不支持子智能体会话重试" } };
      try {
        const reply = await this.api.sessions.prompt({
          sessionId: this.sessionId, mode: "desktop-replay-v1", desktopReplayFrom: targetSeq, content
        });
        return reply.result;
      } catch (error) {
        return { ok: false, error: { message: "原会话重试未成功，请检查 Runtime 适配：" + String(error) } };
      }
    }
    desktopReplayEntries() {
      let entries = this.events.map((event, index) => ({ event, view: this.views[index] }));
      for (const event of this.events) {
        const marker = event.type === "user/message" && event.surfaceOp?.op === "replace"
          && event.data?.source?.desktopReplay;
        if (!marker || marker.version !== 1 || !Number.isSafeInteger(marker.fromSeq)
          || !Number.isSafeInteger(marker.throughSeq) || marker.fromSeq < 0
          || marker.throughSeq < marker.fromSeq || marker.throughSeq >= event.seq) continue;
        entries = entries.filter(item => item.event.seq < marker.fromSeq || item.event.seq > marker.throughSeq);
        entries = entries.map(item => item.event.seq === event.seq
          ? { ...item, event: { ...item.event, surfaceOp: "append", sourceEventSeqs: void 0 } } : item);
      }
      return entries;
    }
    desktopReplayRebuild() {
      let entries;
      try { entries = this.desktopReplayEntries(); }
      catch (error) {
        console.error("桌面壳重试历史展示适配失败，保留原始历史", error);
        entries = this.events.map((event, index) => ({ event, view: this.views[index] }));
      }
      return this.conversation.replaceWindow(entries, this.hasMore);
    }
  `
  const modernPrompt = 'async prompt(content, mode, signal, requestId) {'
  const publish = 'this.snapshot = windowSnapshot(this.window, hasMore, this.snapshot.revision + 1, change);'
  const eventSource = 'var MutableSessionEventSource = class {'
  if (source.split(modernPrompt).length === 2 && source.split(publish).length === 2 && source.split(eventSource).length === 2) {
    const project = `
      function desktopReplayProject(entries) {
        let visible = entries;
        for (const { event } of entries) {
          const marker = event.type === "user/message" && event.surfaceOp?.op === "replace" && event.data?.source?.desktopReplay;
          if (!marker || marker.version !== 1 || !Number.isSafeInteger(marker.fromSeq)
            || !Number.isSafeInteger(marker.throughSeq) || marker.fromSeq < 0
            || marker.throughSeq < marker.fromSeq || marker.throughSeq >= event.seq) continue;
          visible = visible.filter(item => item.event.seq < marker.fromSeq || item.event.seq > marker.throughSeq);
          visible = visible.map(item => item.event.seq === event.seq
            ? { ...item, event: { ...item.event, surfaceOp: "append", sourceEventSeqs: void 0 } } : item);
        }
        return visible;
      }
    `
    const replay = `
      async desktopReplay(targetSeq, content) {
        if (this.address !== void 0) return { ok: false, error: { message: "暂不支持子智能体会话重试" } };
        try {
          return await this.remote.session.prompt({
            requestId: randomUUID(), sessionId: this.sessionId,
            mode: "desktop-replay-v1", desktopReplayFrom: targetSeq, content,
            clientTimeZone: resolvedClientTimeZone()
          });
        } catch (error) {
          return { ok: false, error: { message: "原会话重试适配未成功：" + String(error) } };
        }
      }
    `
    return { changed: true, source: source.replace(eventSource, project + eventSource)
      .replace(modernPrompt, replay + modernPrompt)
      .replace(publish, `
        try {
          const marked = change.entries?.some(item => item.event.type === "user/message" && item.event.data?.source?.desktopReplay);
          if (change.kind === "replace") this.desktopReplayActive = marked;
          else if (marked) this.desktopReplayActive = true;
          if (this.desktopReplayActive) {
            if (change.kind === "append" && !marked) {
              this.snapshot = windowSnapshot(concat(leaf(this.snapshot.entries), leaf(change.entries)), hasMore, this.snapshot.revision + 1, change);
            } else {
              const entries = desktopReplayProject(materialize(this.window));
              this.snapshot = windowSnapshot(leaf(entries), hasMore, this.snapshot.revision + 1, { kind: "replace", entries });
            }
          } else { ${publish} }
        } catch (error) {
          console.error("桌面壳重试历史展示适配失败，保留原始历史", error);
          ${publish}
        }
      `) }
  }
  const replacements: Array<[string, string]> = [
    ['async prompt(content, mode) {', methods + '\nasync prompt(content, mode) {'],
    ['this.conversation.prepend(older.map(conversationInput), this.hasMore);',
      'if (this.events.some(event => event.type === "user/message" && event.data?.source?.desktopReplay)) this.desktopReplayRebuild(); else this.conversation.prepend(older.map(conversationInput), this.hasMore);'],
    ['this.conversation.replaceWindow(entries.map(conversationInput), hasMore);',
      'if (this.events.some(event => event.type === "user/message" && event.data?.source?.desktopReplay)) this.desktopReplayRebuild(); else this.conversation.replaceWindow(entries.map(conversationInput), hasMore);'],
  ]
  if (replacements.some(([text]) => source.split(text).length !== 2)) return { source, changed: false }
  const append = /this\.conversation\.append\(\s*\{\s*event,\s*view\s*\}\s*\)/gu
  if ([...source.matchAll(append)].length !== 1) return { source, changed: false }
  let transformed = source.replace(append, '(event.type === "user/message" && event.data?.source?.desktopReplay ? this.desktopReplayRebuild() : this.conversation.append({ event, view }))')
  for (const [text, replacement] of replacements) transformed = transformed.replace(text, replacement)
  return { source: transformed, changed: true }
}

/** Register before the Runtime browser factory is evaluated; failures retain the original factory. */
export function installDesktopReplayClientHook(transformSource: string): string {
  // The shell's main-world hook is an untyped cross-context capability.
  const hook = (globalThis as any).__dshDesktopConversationReplayHook
  if (typeof hook?.registerModuleFactoryTransform !== 'function') return 'loader-hook-unavailable'
  try {
    const transform = Function(`return (${transformSource})`)()
    for (const moduleId of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-api-session-controller', '@deepseek-ai/dsh-api-gateway']) {
      hook.registerModuleFactoryTransform(moduleId, (factory: Function) => {
        try {
          const result = transform(Function.prototype.toString.call(factory))
          if (!result.changed) {
            console.warn('桌面壳原会话重试：客户端未匹配适配，保留原始模块')
            return factory
          }
          return Function(`return (${result.source})`)()
        } catch (error) {
          console.error('桌面壳原会话重试客户端适配失败，保留原始模块', error)
          return factory
        }
      })
    }
    return 'installed'
  } catch (error) {
    console.error('桌面壳原会话重试客户端注册失败', error)
    return 'registration-failed'
  }
}
