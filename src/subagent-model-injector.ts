/** Desktop-shell model badge for a subagent conversation header (ModuleLoader transform). */
export interface SubagentModelTransform {
  source: string
  changed: boolean
}

/**
 * Slot this badge seats into. Only the template literal below may read it: every function that
 * reaches the main world is serialized by `Function.prototype.toString`, so each of those writes
 * its own literals out in full instead of reading this or any other module binding.
 */
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/**
 * Injected verbatim into the Runtime's ui-subagent factory body. Every name it declares lives
 * inside one IIFE, so a future upstream factory can never collide with it, and the only outer
 * bindings it touches are the factory's own `require` and `apply`.
 *
 * The badge reads the addressed Session's own durable `modelSelection` projection; it never
 * falls back to a parent Session or to the catalog default, and it renders nothing when the
 * child has no model of its own.
 */
export const SUBAGENT_MODEL_BADGE_SOURCE = `(function () {
const React = (function () { try { return require("react"); } catch (error) { return void 0; } })();
const badgeStyle = ".dsh-desktop-subagent-model{display:inline-flex;align-items:center;gap:6px;max-width:min(220px,28vw);min-width:0;height:22px;padding:0 8px;border:1px solid var(--dsw-alias-stroke-primary);border-radius:11px;background:color-mix(in srgb,currentColor 6%,transparent);color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:20px}.dsh-desktop-subagent-model-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}";
const noSessions = selector => selector(void 0);
const noProjection = () => void 0;
const emptyDirectory = () => void 0;
const noSubscribe = () => () => {};
/** Sessions whose badge seat is already claimed in this factory execution. */
const installedContexts = new WeakSet();
/** Resolve the child Session's own selection; undefined while absent, never a fabricated value. */
function resolveModelView(projection, directoryState) {
  if (projection === null || projection === void 0 || typeof projection !== "object") return void 0;
  const selection = projection.next === null || projection.next === void 0 ? projection.lastUsed : projection.next;
  if (selection === null || selection === void 0 || typeof selection !== "object") return void 0;
  if (typeof selection.provider !== "string" || selection.provider.length === 0) return void 0;
  if (typeof selection.model !== "string" || selection.model.length === 0) return void 0;
  const groups = directoryState === null || directoryState === void 0 || !Array.isArray(directoryState.groups) ? [] : directoryState.groups;
  let displayName;
  for (const group of groups) {
    if (group === null || group === void 0 || group.id !== selection.provider || !Array.isArray(group.models)) continue;
    const match = group.models.find(model => model !== null && model !== void 0 && model.id === selection.model);
    if (match !== void 0 && typeof match.name === "string" && match.name.length > 0) { displayName = match.name; break; }
  }
  const effort = typeof selection.reasoningEffort === "string" && selection.reasoningEffort.length > 0 ? " · " + selection.reasoningEffort : "";
  return { label: typeof displayName === "string" ? displayName : selection.model, title: selection.provider + " / " + selection.model + effort };
}
/** Header badge: rendered only on a child Session, and only while one model is actually known. */
function DshDesktopSubagentModelBadge(props) {
  if (React === void 0 || React === null || typeof React.createElement !== "function") return null;
  const useSessions = typeof props.useSessions === "function" ? props.useSessions : noSessions;
  const useProjection = typeof props.useProjection === "function" ? props.useProjection : noProjection;
  const isSubagent = useSessions(state => state !== null && state !== void 0 && typeof state === "object" && state.byId !== null && typeof state.byId === "object" && state.byId[props.sessionId] !== void 0 && state.byId[props.sessionId].origin === "subagent") === true;
  const projection = useProjection("modelSelection");
  const store = props.dshDesktopModelDirectory;
  const subscribe = React.useMemo(() => store === null || store === void 0 || typeof store.subscribe !== "function" ? noSubscribe : listener => store.subscribe(listener), [store]);
  const read = React.useMemo(() => store === null || store === void 0 || typeof store.getSnapshot !== "function" ? emptyDirectory : () => store.getSnapshot(), [store]);
  const directoryState = React.useSyncExternalStore(subscribe, read, read);
  if (!isSubagent) return null;
  const view = resolveModelView(projection, directoryState);
  if (view === void 0) return null;
  return React.createElement("span", { className: "dsh-desktop-subagent-model", title: view.title, "aria-label": "当前执行模型：" + view.title, "data-dsh-subagent-model": "" }, React.createElement("span", { className: "dsh-desktop-subagent-model-label" }, view.label));
}
/** Install the badge stylesheet once per document. */
function applyModelStyle() {
  if (typeof document === "undefined" || document === null || document.head === null || document.head === void 0) return;
  if (document.querySelector("style[data-dsh-subagent-model-style]") !== null) return;
  const tag = document.createElement("style");
  tag.setAttribute("data-dsh-subagent-model-style", "");
  tag.textContent = badgeStyle;
  document.head.appendChild(tag);
}
/** Seat the badge beside the header's existing actions; the slot's Session scope supplies useProjection. */
function registerBadge(ctx) {
  if (ctx === null || ctx === void 0 || typeof ctx !== "object" || ctx.slots === null || ctx.slots === void 0 || typeof ctx.slots.inject !== "function" || typeof ctx.slots.register !== "function") return;
  if (installedContexts.has(ctx)) return;
  installedContexts.add(ctx);
  ctx.slots.inject("${HEADER_ACTIONS_SLOT}", function () {
    ctx.slots.register({ name: "${HEADER_ACTIONS_SLOT}", id: "subagent-model", order: -20, inject: function (sessionId) { try { const resolver = ctx.modelDirectories; const directory = resolver === null || resolver === void 0 || typeof resolver.directoryFor !== "function" ? void 0 : resolver.directoryFor(sessionId); return directory === null || directory === void 0 || directory.store === void 0 ? {} : { dshDesktopModelDirectory: directory.store }; } catch (error) { return {}; } } }, DshDesktopSubagentModelBadge);
  });
}
if (typeof apply === "function") {
  const originalApply = apply;
  apply = function (ctx) {
    const result = originalApply.apply(this, arguments);
    try { applyModelStyle(); registerBadge(ctx); } catch (error) { console.error("桌面壳子智能体模型徽标注册失败", error); }
    return result;
  };
}
})();`;

/**
 * Insert the badge IIFE at the top of a ui-subagent factory body. Pure and serialized into the
 * main world, so the sentinel literal is inlined rather than read from a module binding.
 */
export function injectSubagentModelBadgeFactorySource(factorySource: string, badgeSource: string): SubagentModelTransform {
  if (typeof factorySource !== 'string' || typeof badgeSource !== 'string') return { source: factorySource, changed: false }
  if (factorySource.length === 0 || badgeSource.length === 0) return { source: factorySource, changed: false }
  // Inlined literal: this function is serialized, so it cannot read a module binding.
  if (factorySource.includes('.dsh-desktop-subagent-model{')) return { source: factorySource, changed: false }
  const bodyStart = factorySource.indexOf('{')
  if (bodyStart < 0) return { source: factorySource, changed: false }
  if (!/=>\s*\{$/u.test(factorySource.slice(0, bodyStart + 1))) return { source: factorySource, changed: false }
  return { source: factorySource.slice(0, bodyStart + 1) + '\n' + badgeSource + '\n' + factorySource.slice(bodyStart + 1), changed: true }
}

/**
 * Register the badge transform on the shared ModuleLoader hook. Serialized into the main world,
 * so both inputs arrive as arguments and no module binding is referenced.
 */
export function installSubagentModelBadgeHook(transformSource: string, badgeSource: string): string {
  const globalObject = globalThis as any
  const hookKey = '__dshDesktopSubagentModelHook'
  if (globalObject[hookKey]?.version === 1) return 'already-installed'
  const loaderHook = globalObject.__dshDesktopConversationReplayHook
  if (typeof loaderHook?.registerModuleFactoryTransform !== 'function') return 'loader-hook-unavailable'
  try {
    const transform = Function(`return (${transformSource})`)()
    // Inlined literal: this function is serialized, so it cannot read a module binding.
    const registered = loaderHook.registerModuleFactoryTransform('@deepseek-ai/dsh-client-ui-subagent', (factory: Function) => {
      const result = transform(Function.prototype.toString.call(factory), badgeSource)
      if (result?.changed !== true || typeof result.source !== 'string') return factory
      try {
        const rebuilt = Function(`return (${result.source})`)()
        return typeof rebuilt === 'function' ? rebuilt : factory
      } catch (error) {
        console.error('桌面壳子智能体模型徽标注入失败', error)
        return factory
      }
    })
    if (registered !== true) return 'registration-failed'
    Object.defineProperty(globalObject, hookKey, {
      configurable: true,
      enumerable: false,
      writable: false,
      value: Object.freeze({ version: 1 }),
    })
    return 'installed'
  } catch (error) {
    console.error('桌面壳子智能体模型徽标注入失败', error)
    return 'registration-failed'
  }
}
