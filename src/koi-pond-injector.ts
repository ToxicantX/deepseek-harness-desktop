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
        let lastOutput;
        const textOf = (value) => {
          if (typeof value === "string") return value.trim();
          if (Array.isArray(value)) return value.map(textOf).filter(Boolean).join(" ").trim();
          if (!value || typeof value !== "object") return "";
          for (const key of ["text", "content", "output", "lastAssistantMessage"]) {
            const text = textOf(value[key]);
            if (text) return text;
          }
          return "";
        };
        const currentOutput = () => {
          try {
            const snapshot = typeof this.getSnapshot === "function" ? this.getSnapshot() : undefined;
            for (const value of [snapshot?.lastAssistantMessage, snapshot?.lastOutput, snapshot?.output, this.lastAssistantMessage, this.output]) {
              const text = textOf(value);
              if (text) return text;
            }
            const events = Array.isArray(this.events) ? this.events : [];
            for (let index = events.length - 1; index >= 0; index -= 1) {
              const event = events[index];
              const text = textOf(event?.data?.message?.content || event?.data?.content || event?.data?.stream);
              if (text) return text;
            }
          } catch {}
          return "";
        };
        const notifyRunning = (value, output) => {
          const nextOutput = typeof output === "string" ? output.trim() : "";
          if (running === value && lastOutput === nextOutput) return;
          running = value;
          lastOutput = nextOutput;
          try {
            let summary;
            let workspace;
            const serviceOf = (context, property, name) => {
              try { return context?.[property] || context?.get?.(name); } catch { return undefined; }
            };
            for (const context of [this.actx, this.ctx, this.context]) {
              try {
                const sessions = serviceOf(context, "sessions", "sessions");
                const snapshot = sessions?.list?.getSnapshot?.();
                summary = snapshot?.byId?.[sessionId]
                  || snapshot?.items?.find(item => item?.id === sessionId || item?.sessionId === sessionId);
                const cwd = summary?.cwd || this.cwd || this.workdir || this.workspace?.path;
                const workspaces = serviceOf(context, "workspaces", "workspaces");
                const workspaceItems = workspaces?.list?.getSnapshot?.()?.items || workspaces?.list?.getSnapshot?.()?.workspaces || [];
                workspace = workspaceItems.find(item => item?.path === cwd || item?.cwd === cwd || item?.workspacePath === cwd);
                if (summary) break;
              } catch {}
            }
            const cwd = summary?.cwd || this.cwd || this.workdir || this.workspace?.path;
            let projectFromPath;
            if (typeof cwd === "string") {
              let normalizedCwd = cwd.replaceAll(String.fromCharCode(92), "/");
              while (normalizedCwd.endsWith("/")) normalizedCwd = normalizedCwd.slice(0, -1);
              const slash = normalizedCwd.lastIndexOf("/");
              projectFromPath = slash < 0 ? normalizedCwd : normalizedCwd.slice(slash + 1);
            }
            const projectName = this.projectName || this.workspaceName || workspace?.title
              || summary?.workspaceName || summary?.workspace?.title || projectFromPath || "当前项目";
            const sessionCandidates = [this.sessionLabel, this.sessionName, summary?.title, summary?.displayTitle];
            const sessionLabel = sessionCandidates.find(candidate => typeof candidate === "string"
              && candidate.trim().length > 0 && candidate.trim() !== sessionId)?.trim() || "未命名会话";
            window.postMessage({ type: "dsh/session-running", sessionId, requestId, running: value, projectName, sessionLabel, subAgent: this.address !== void 0, output }, window.location.origin);
          } catch {}
        };
        const stopRunning = () => {
          const release = releaseRunning;
          releaseRunning = undefined;
          if (typeof release === "function") release();
        };
        notifyRunning(true, currentOutput() || "正在生成输出…");
        if (typeof this.subscribe === "function" && typeof this.getSnapshot === "function") {
          let observedRunning = false;
          const syncRunning = () => {
            let active = false;
            try { active = this.getSnapshot().running === true; } catch {}
            if (active) {
              observedRunning = true;
              notifyRunning(true, currentOutput() || "正在生成输出…");
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
          notifyRunning(false, "执行失败");
          stopRunning();
          throw error;
        }
        if (result?.ok !== true) {
          notifyRunning(false, result?.error?.message || "已完成");
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
