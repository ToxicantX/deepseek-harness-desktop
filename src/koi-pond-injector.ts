/** Serialized into the main world: no imports or closure dependencies. */
export function injectKoiPondDialogue(source: string): { source: string; changed: boolean } {
  if (source.includes('__dshPondOriginalPrompt')) return { source, changed: false }
  const anchor = ['async prompt(content, mode, signal, requestId) {', 'async prompt(content, mode) {']
    .find(text => source.split(text).length === 2)
  if (!anchor) return { source, changed: false }
  return {
    changed: true,
    source: source.replace(anchor, `
      async prompt(...args) {
        const sessionId = this.sessionId;
        const requestId = typeof args[3] === "string" ? args[3] : crypto.randomUUID();
        let releaseRunning;
        let running = false;
        const notifyRunning = value => {
          if (running === value) return;
          running = value;
          try { window.postMessage({ type: "dsh/session-running", sessionId, requestId, running: value }, window.location.origin); } catch {}
        };
        const stopRunning = () => {
          const release = releaseRunning;
          releaseRunning = undefined;
          if (typeof release === "function") release();
        };
        notifyRunning(true);
        if (typeof this.subscribe === "function" && typeof this.getSnapshot === "function") {
          let observedRunning = false;
          const syncRunning = () => {
            let active = false;
            try { active = this.getSnapshot().running === true; } catch {}
            if (active) {
              observedRunning = true;
              notifyRunning(true);
            } else if (observedRunning) {
              notifyRunning(false);
              stopRunning();
            }
          };
          try {
            releaseRunning = this.subscribe(syncRunning);
            syncRunning();
          } catch {}
        }
        let result;
        try {
          result = await this.__dshPondOriginalPrompt(...args);
        } catch (error) {
          notifyRunning(false);
          stopRunning();
          throw error;
        }
        if (result?.ok !== true) {
          notifyRunning(false);
          stopRunning();
        } else if (releaseRunning === undefined) {
          notifyRunning(false);
        }
        try {
          if (result?.ok === true && this.address === void 0) {
            window.postMessage({
              type: "dsh/pond-dialogue", sessionId: this.sessionId, requestId
            }, window.location.origin);
          }
        } catch (error) { console.warn("鱼塘成长通知未送达，聊天发送结果保持不变", error); }
        return result;
      }
      ${anchor.replace('async prompt(', 'async __dshPondOriginalPrompt(')}
    `),
  }
}

export function installKoiPondDialogueHook(transformSource: string): string {
  const root = globalThis as any
  const hook = root.__dshDesktopConversationReplayHook
  if (typeof hook?.registerModuleFactoryTransform !== 'function') return 'loader-hook-unavailable'
  if (root.__dshPondDialogueInstalled) return 'already-installed'
  const transform = Function(`return (${transformSource})`)()
  for (const id of ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-api-session-controller']) {
    hook.registerModuleFactoryTransform(id, (factory: Function) => {
      try {
        const result = transform(Function.prototype.toString.call(factory))
        if (!result.changed) {
          console.warn('鱼塘成长观察未匹配此 Runtime，保留原始聊天模块')
          return factory
        }
        return Function(`return (${result.source})`)()
      } catch (error) {
        console.warn('鱼塘成长观察启动失败，保留原始聊天模块', error)
        return factory
      }
    })
  }
  root.__dshPondDialogueInstalled = true
  return 'installed'
}
