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
        const root = globalThis;
        const pond = root.__dshPondRunning || (root.__dshPondRunning = {
          epoch: String(Date.now()) + "-" + Math.random().toString(36).slice(2),
          seq: 0, local: new Map(), starts: new Map(), list: void 0, installed: false, signature: void 0,
          runs: new Map(), previous: new Set(), children: new Set(),
        });
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
            const snapshot = typeof this.getSnapshot === "function" ? this.getSnapshot() : void 0;
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
        const contexts = () => {
          const found = [];
          for (const context of [this.actx, this.ctx, this.context]) {
            if (context && !found.includes(context)) found.push(context);
          }
          return found;
        };
        const serviceOf = (context, property, name) => {
          try { return context?.[property] || context?.get?.(name); } catch { return void 0; }
        };
        const listStore = () => {
          if (pond.list) return pond.list;
          for (const context of contexts()) {
            const list = serviceOf(context, "sessions", "sessions")?.list;
            if (typeof list?.getSnapshot === "function") { pond.list = list; return list; }
          }
          return void 0;
        };
        const nameParts = (id, row) => {
          const own = id === sessionId;
          let ownContext;
          if (own) for (const context of contexts()) { ownContext = context; break; }
          const cwd = row?.cwd || (own ? this.cwd || this.workdir || this.workspace?.path : void 0);
          let projectFromPath;
          if (typeof cwd === "string") {
            let normalizedCwd = cwd.replaceAll(String.fromCharCode(92), "/");
            while (normalizedCwd.endsWith("/")) normalizedCwd = normalizedCwd.slice(0, -1);
            const slash = normalizedCwd.lastIndexOf("/");
            projectFromPath = slash < 0 ? normalizedCwd : normalizedCwd.slice(slash + 1);
          }
          const workspaces = own ? serviceOf(ownContext, "workspaces", "workspaces") : void 0;
          const items = workspaces?.list?.getSnapshot?.()?.items || workspaces?.list?.getSnapshot?.()?.workspaces || [];
          const workspace = items.find(item => item?.path === cwd || item?.cwd === cwd || item?.workspacePath === cwd);
          const projectName = (own ? this.projectName || this.workspaceName : void 0)
            || row?.workspaceName || row?.workspace?.title || workspace?.title || projectFromPath || "当前项目";
          const candidates = [own ? this.sessionLabel : void 0, own ? this.sessionName : void 0, row?.title, row?.displayTitle];
          const sessionLabel = candidates.find(candidate => typeof candidate === "string"
            && candidate.trim().length > 0 && candidate.trim() !== id)?.trim() || "未命名会话";
          return { projectName, sessionLabel };
        };
        const bindList = () => {
          if (pond.installed) return;
          const list = listStore();
          if (typeof list?.subscribe !== "function") return;
          try { list.subscribe(() => { try { publish(); } catch {} }); pond.installed = true; } catch {}
        };
        const publish = () => {
          // A broken pond observer must never change the chat send result.
          try {
          // Only a usable identity may be published; an unnamed entry cannot be tracked
          // or dismissed and would be rejected by the shell anyway.
          if (typeof sessionId !== "string" || sessionId.length === 0) return;
          bindList();
          const snapshot = listStore()?.getSnapshot?.();
          const byId = snapshot && typeof snapshot === "object" ? snapshot.byId : void 0;
          const authoritative = byId !== void 0 && byId !== null;
          const running = new Set();
          if (authoritative) {
            // The Runtime list projection is the only running authority. A session the host
            // no longer reports as running must leave, however stale this page's own
            // observation of it has become; otherwise a missed stop frame lists it forever.
            for (const id of Object.keys(byId)) {
              const row = byId[id];
              if (row?.running !== true) continue;
              // The pond lists main sessions only: a child agent session is projected with
              // origin "subagent", or was recorded as a child submission of this document, and
              // must never become a row, however long it runs.
              if (row.origin === "subagent" || pond.children.has(id)) continue;
              running.add(id);
            }
          } else {
            // Without a bound list (older Runtime) fall back to this page's own submissions.
            for (const id of pond.local.keys()) {
              // This map is shared by every session on the document, so a child recorded by
              // another scope stays dropped here: testing only this scope's own address would
              // republish a child that prompted elsewhere on the same page.
              if (pond.children.has(id)) continue;
              running.add(id);
            }
          }
          const output = currentOutput();
          // A run counter identifies one execution: it advances only when a session enters
          // the running set from outside it, so a dismissed row stays dismissed until a real restart.
          for (const id of running) {
            if (!pond.previous.has(id)) pond.runs.set(id, (pond.runs.get(id) || 0) + 1);
          }
          pond.previous = running;
          const entries = [];
          for (const id of running) {
            // An entry without a usable identity cannot be tracked or dismissed; drop it
            // here rather than publishing a row the shell has to throw away.
            if (typeof id !== "string" || id.length === 0 || id.length > 128) continue;
            const row = authoritative ? byId[id] : void 0;
            const labels = nameParts(id, row);
            let startedAt = pond.starts.get(id);
            if (startedAt === void 0) { startedAt = Date.now(); pond.starts.set(id, startedAt); }
            // Nothing subagent-shaped reaches this point, so no entry carries a child marker.
            entries.push({
              id, seq: pond.runs.get(id) || 0, startedAt,
              projectName: labels.projectName, sessionLabel: labels.sessionLabel,
              ...(id === sessionId && output ? { output } : {}),
            });
          }
          entries.sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : 1));
          for (const id of [...pond.starts.keys()]) { if (!running.has(id)) pond.starts.delete(id); }
          // The run counter is deliberately not pruned: dropping it would restart at 1 for a
          // session that stops and runs again, and a dismissed row would then stay dismissed.
          const signature = JSON.stringify(entries.map(entry => [entry.id, entry.seq, entry.startedAt, entry.projectName,
            entry.sessionLabel, entry.output || ""]));
          if (signature === pond.signature) return;
          pond.signature = signature;
          pond.seq += 1;
          window.postMessage({ type: "dsh/session-running-set", epoch: pond.epoch, seq: pond.seq, sessions: entries }, window.location.origin);
          } catch {}
        };
        bindList();
        let releaseRunning;
        let observedRunning = false;
        let promptSettled = false;
        const stopRunning = () => {
          const release = releaseRunning;
          releaseRunning = void 0;
          if (typeof release === "function") release();
        };
        const syncRunning = () => {
          let active = false;
          try { active = this.getSnapshot().running === true; } catch {}
          if (active) {
            observedRunning = true;
            // A child submission is recorded as a child for every scope on this document, so no
            // other prompt can later republish this id as a main row.
            if (this.address !== void 0) pond.children.add(sessionId); else pond.children.delete(sessionId);
            pond.local.set(sessionId, "running");
            publish();
          } else if (observedRunning || promptSettled) {
            pond.local.delete(sessionId);
            publish();
          }
        };
        // A child is marked in the shared document state at admission, because its own snapshot may
        // never report running; a main submission clears any earlier child mark for that id.
        if (this.address !== void 0) pond.children.add(sessionId); else pond.children.delete(sessionId);
        pond.local.set(sessionId, "pending");
        publish();
        if (typeof this.subscribe === "function" && typeof this.getSnapshot === "function") {
          try { releaseRunning = this.subscribe(syncRunning); } catch {}
          syncRunning();
        }
        let result;
        try {
          result = await this.__dshPondOriginalPrompt(...args);
        } catch (error) {
          promptSettled = true;
          pond.local.delete(sessionId);
          publish();
          stopRunning();
          throw error;
        }
        promptSettled = true;
        let stillRunning = false;
        try { stillRunning = typeof this.getSnapshot === "function" && this.getSnapshot()?.running === true; } catch {}
        if (!stillRunning) { pond.local.delete(sessionId); stopRunning(); }
        publish();
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
