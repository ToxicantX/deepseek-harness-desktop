import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installConversationReplayModuleHook } from '../src/conversation-replay-injector.ts'
import {
  SUBAGENT_MODEL_BADGE_SOURCE,
  injectSubagentModelBadgeFactorySource,
  installSubagentModelBadgeHook,
} from '../src/subagent-model-injector.ts'

const SUBAGENT_MODULE_ID = '@deepseek-ai/dsh-client-ui-subagent'
const HEADER_ACTIONS_SLOT = 'conversation.session.header.actions'

/** Representative ui-subagent bundle factory: the shipped module's own shape. */
const FIXTURE_FACTORY = `(require) => {
		var module = { exports: {} };
		var exports = module.exports;
		let react = require("react");
		function SubagentReadOnlyComposer() { return null; }
		function apply(ctx) {
			ctx.slots.inject("conversation.composer", () => ctx.slots.register({ name: "conversation.composer" }, SubagentReadOnlyComposer));
		}
		exports.apply = apply;
		exports.inject = ["sessions", "slots"];
		return module.exports;
	}`

interface BadgeHarness {
  component: React.ComponentType<Record<string, unknown>>;
  inject: (sessionId: string) => Record<string, unknown>;
  directoryFor: ReturnType<typeof vi.fn>;
}

/** Execute the transformed factory through the same apply/register path the Runtime uses. */
function buildBadge(transformedSource: string, directory: unknown): BadgeHarness {
  const factory = Function(`return (${transformedSource})`)() as (require: (id: string) => unknown) => Record<string, unknown>;
  const exported = factory((id: string) => {
    if (id === 'react') return React;
    throw new Error('unexpected dependency ' + id);
  });
  let captured: BadgeHarness | undefined;
  const directoryFor = vi.fn(() => (directory === undefined ? undefined : { store: directory }));
  const ctx = {
    modelDirectories: { directoryFor },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (options: { inject?: (sessionId: string) => Record<string, unknown> }, component: BadgeHarness['component']) => {
        captured = { component, directoryFor, inject: options.inject ?? (() => ({})) };
      },
    },
  };
  const apply = exported.apply as ((context: unknown) => unknown) | undefined;
  expect(typeof apply).toBe('function');
  apply?.(ctx);
  if (captured === undefined) throw new Error('badge component was not registered');
  return captured;
}

/** Minimal uSES-compatible store matching SnapshotStore's subscribe/getSnapshot face. */
function badgeStore(initial: unknown) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => value,
    set: (next: unknown) => { value = next; for (const listener of listeners) listener(); },
  };
}

const SESSIONS = { first: { origin: 'subagent' }, second: { origin: 'subagent' }, parent: { origin: 'user' } };

/** Capture the component one already-executed apply registered. */
function captureBadge(apply: (context: unknown) => unknown): { component: BadgeHarness['component'] } {
  let captured: { component: BadgeHarness['component'] } | undefined;
  apply({
    modelDirectories: { directoryFor: () => undefined },
    slots: {
      inject: (_name: string, callback: () => void) => callback(),
      register: (_options: unknown, component: BadgeHarness['component']) => { captured = { component }; },
    },
  });
  if (captured === undefined) throw new Error('badge component was not registered');
  return captured;
}

/** Real React render via renderToStaticMarkup; the slot's injected face is merged as props. */
function renderBadge(harness: BadgeHarness, projection: unknown, sessionId = 'first', sessions: Record<string, unknown> = SESSIONS): string {
  return renderToStaticMarkup(
    React.createElement(harness.component, {
      ...harness.inject(sessionId),
      sessionId,
      useSessions: (selector: (state: unknown) => unknown) => selector({ byId: sessions }),
      useProjection: (key: string) => (key === 'modelSelection' ? projection : undefined),
    }),
  );
}

const readModel = (markup: string): string | undefined => /data-dsh-subagent-model=""[^>]*>(?:<span[^>]*>)?([^<]*)/u.exec(markup)?.[1];
const modelTitle = (markup: string): string | undefined => /title="([^"]*)"/u.exec(markup)?.[1];

const badgeSource = SUBAGENT_MODEL_BADGE_SOURCE;
const spliced = () => {
  const result = injectSubagentModelBadgeFactorySource(FIXTURE_FACTORY, badgeSource);
  expect(result.changed).toBe(true);
  return result.source;
};

const originalLoaderDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__ModuleLoader__');
const originalConversationHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopConversationReplayHook');
const originalBadgeHookDescriptor = Object.getOwnPropertyDescriptor(globalThis, '__dshDesktopSubagentModelHook');

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  delete (globalThis as Record<string, unknown>)[name];
  if (descriptor !== undefined) Object.defineProperty(globalThis, name, descriptor);
}

afterEach(() => {
  restoreGlobal('__ModuleLoader__', originalLoaderDescriptor);
  restoreGlobal('__dshDesktopConversationReplayHook', originalConversationHookDescriptor);
  restoreGlobal('__dshDesktopSubagentModelHook', originalBadgeHookDescriptor);
  vi.restoreAllMocks();
});

describe('subagent model badge injector', () => {
  it('splices the badge into a representative ui-subagent factory and keeps the original body', () => {
    const source = spliced();

    expect(source).toContain('DshDesktopSubagentModelBadge');
    expect(source).toContain('"' + HEADER_ACTIONS_SLOT + '"');
    expect(source).toContain('if (typeof apply === "function") {');
    expect(source).toContain('ctx.slots.inject("conversation.composer"');
    expect(source).toContain('exports.inject = ["sessions", "slots"];');
    expect(source.startsWith('(require) => {')).toBe(true);
  });

  it('leaves an incompatible factory and an empty badge source unchanged', () => {
    expect(injectSubagentModelBadgeFactorySource('(require) => ({ apply() {} })', '')).toEqual({
      source: '(require) => ({ apply() {} })',
      changed: false,
    });
    expect(injectSubagentModelBadgeFactorySource('exports.apply = apply;', SUBAGENT_MODEL_BADGE_SOURCE)).toEqual({
      source: 'exports.apply = apply;',
      changed: false,
    });
    expect(injectSubagentModelBadgeFactorySource(FIXTURE_FACTORY, '')).toEqual({
      source: FIXTURE_FACTORY,
      changed: false,
    });
  });

  it('does not splice twice when the factory was already transformed', () => {
    const once = injectSubagentModelBadgeFactorySource(FIXTURE_FACTORY, SUBAGENT_MODEL_BADGE_SOURCE);
    const twice = injectSubagentModelBadgeFactorySource(once.source, SUBAGENT_MODEL_BADGE_SOURCE);

    expect(twice.changed).toBe(false);
    expect(twice.source).toBe(once.source);
    expect(once.source.split('function DshDesktopSubagentModelBadge')).toHaveLength(2);
    const harness = buildBadge(once.source, badgeStore({ groups: [] }));
    expect(typeof harness.component).toBe('function');
  });

  it('shows the child Session model name and a provider/model tooltip', () => {
    const harness = buildBadge(spliced(), badgeStore({
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' }] }],
    }));
    const markup = renderBadge(harness, { lastUsed: null, next: { provider: 'deepseek-official', model: 'deepseek-reasoner' } });

    expect(readModel(markup)).toBe('DeepSeek Reasoner');
    expect(modelTitle(markup)).toBe('deepseek-official / deepseek-reasoner');
    expect(markup).toContain('data-dsh-subagent-model=""');
  });

  it('shows the child model that differs from the parent and never the parent model', () => {
    const harness = buildBadge(spliced(), badgeStore({
      groups: [
        { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'parent-model', name: 'Parent Model' }] },
        { id: 'deepseek-account', name: 'Account', models: [{ id: 'child-model', name: 'Child Model' }] },
      ],
    }));
    const childMarkup = renderBadge(harness, { lastUsed: { provider: 'deepseek-account', model: 'child-model' }, next: null });

    expect(readModel(childMarkup)).toBe('Child Model');
    expect(modelTitle(childMarkup)).toBe('deepseek-account / child-model');
    expect(childMarkup).not.toContain('Parent Model');
    expect(childMarkup).not.toContain('parent-model');
    expect(childMarkup).not.toContain('deepseek-official');
  });

  it('renders nothing without a model and never fabricates the catalog default', () => {
    const harness = buildBadge(spliced(), badgeStore({
      groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'default-model', name: 'Default Model' }] }],
    }));

    expect(renderBadge(harness, undefined)).toBe('');
    expect(renderBadge(harness, null)).toBe('');
    expect(renderBadge(harness, { lastUsed: null, next: null })).toBe('');
    expect(renderBadge(harness, { lastUsed: { provider: '', model: 'default-model' }, next: null })).toBe('');
    expect(renderBadge(harness, { lastUsed: { provider: 'deepseek-official', model: '' }, next: null })).toBe('');
    expect(renderBadge(harness, { lastUsed: { provider: 'deepseek-official' }, next: null })).toBe('');
    expect(renderBadge(harness, 'modelSelection')).toBe('');
  });

  it('renders nothing on a root Session or an unknown Session', () => {
    const harness = buildBadge(spliced(), badgeStore({ groups: [] }));
    const projection = { lastUsed: { provider: 'p', model: 'm' }, next: null };

    expect(renderBadge(harness, projection, 'parent')).toBe('');
    expect(renderBadge(harness, projection, 'missing')).toBe('');
    expect(renderBadge(harness, projection, 'first', {})).toBe('');
  });

  it('drops the previous model when the viewed Session switches', () => {
    const harness = buildBadge(spliced(), badgeStore({
      groups: [{ id: 'p', name: 'P', models: [{ id: 'a', name: 'Model A' }, { id: 'b', name: 'Model B' }] }],
    }));

    const first = renderBadge(harness, { lastUsed: null, next: { provider: 'p', model: 'a' } }, 'first');
    const second = renderBadge(harness, { lastUsed: null, next: { provider: 'p', model: 'b' } }, 'second');
    const parent = renderBadge(harness, { lastUsed: null, next: { provider: 'p', model: 'b' } }, 'parent');

    expect(readModel(first)).toBe('Model A');
    expect(readModel(second)).toBe('Model B');
    expect(first).not.toContain('Model B');
    expect(second).not.toContain('Model A');
    expect(parent).toBe('');
  });

  it('re-reads the live name for an unsettled selection and drops a cleared child selection', () => {
    const directory = badgeStore({ groups: [{ id: 'p', name: 'P', models: [] }] });
    const harness = buildBadge(spliced(), directory);
    const selection = { lastUsed: null, next: { provider: 'p', model: 'live-id' } };

    expect(readModel(renderBadge(harness, selection))).toBe('live-id');

    directory.set({ groups: [{ id: 'p', name: 'P', models: [{ id: 'live-id', name: 'Live Display Name' }] }] });
    expect(readModel(renderBadge(harness, selection))).toBe('Live Display Name');

    expect(renderBadge(harness, { lastUsed: null, next: null })).toBe('');
  });

  it('falls back to the raw model id and keeps the layout bounded', () => {
    const harness = buildBadge(spliced(), badgeStore({ groups: [] }));
    const longId = 'vendor-' + 'x'.repeat(180);
    const markup = renderBadge(harness, { lastUsed: { provider: 'vendor', model: longId }, next: null });

    expect(readModel(markup)).toBe(longId);
    expect(markup).toContain('dsh-desktop-subagent-model-label');
    expect(badgeSource).toContain('text-overflow:ellipsis');
    expect(badgeSource).toContain('white-space:nowrap');
    expect(badgeSource).toContain('max-width:min(220px,28vw)');
  });

  it('appends the reasoning effort to the tooltip only', () => {
    const harness = buildBadge(spliced(), badgeStore({
      groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'Reasoning Model' }] }],
    }));
    const markup = renderBadge(harness, { lastUsed: null, next: { provider: 'p', model: 'm', reasoningEffort: 'high' } });

    expect(readModel(markup)).toBe('Reasoning Model');
    expect(modelTitle(markup)).toBe('p / m · high');
  });

  it('still renders the exact id when the model directory is unavailable', () => {
    const harness = buildBadge(spliced(), undefined);
    const markup = renderBadge(harness, { lastUsed: { provider: 'p', model: 'm' }, next: null });

    expect(readModel(markup)).toBe('m');
    expect(modelTitle(markup)).toBe('p / m');
    expect(harness.directoryFor).toHaveBeenCalledWith('first');
  });

  it('swallows a directory lookup failure instead of breaking the header', () => {
    const source = spliced();
    const factory = Function(`return (${source})`)() as (require: (id: string) => unknown) => Record<string, unknown>;
    const exported = factory(() => React);
    let captured: { inject?: (sessionId: string) => Record<string, unknown> } | undefined;
    const ctx = {
      modelDirectories: { directoryFor: () => { throw new Error('unknown session'); } },
      slots: {
        inject: (_name: string, callback: () => void) => callback(),
        register: (options: { inject?: (sessionId: string) => Record<string, unknown> }) => { captured = options; },
      },
    };
    (exported.apply as (context: unknown) => unknown)(ctx);

    expect(captured?.inject?.('first')).toEqual({});
  });

  it('registers one ModuleLoader transform and stays idempotent across repeated injection', () => {
    expect(installConversationReplayModuleHook()).toBe('installed');
    const serializedInstaller = Function(`return (${installSubagentModelBadgeHook.toString()})`)() as typeof installSubagentModelBadgeHook;
    expect(serializedInstaller(injectSubagentModelBadgeFactorySource.toString(), SUBAGENT_MODEL_BADGE_SOURCE)).toBe('installed');
    const rawLoad = vi.fn();
    (globalThis as Record<string, unknown>).__ModuleLoader__ = { load: rawLoad };
    const targetFactory = Function(`return (${FIXTURE_FACTORY})`)() as (require: (id: string) => unknown) => Record<string, unknown>;
    (globalThis as any).__ModuleLoader__.load({ id: SUBAGENT_MODULE_ID, factory: targetFactory });

    const handoff = rawLoad.mock.calls[0]?.[0] as { factory: (require: (id: string) => unknown) => Record<string, unknown> };
    expect(handoff.factory).not.toBe(targetFactory);
    const exported = handoff.factory((id: string) => { if (id === 'react') return React; throw new Error(id); });
    expect(typeof exported.apply).toBe('function');
    const captured = captureBadge(exported.apply as (context: unknown) => unknown);
    expect(captured.component).not.toBeUndefined();

    expect(serializedInstaller(injectSubagentModelBadgeFactorySource.toString(), SUBAGENT_MODEL_BADGE_SOURCE)).toBe('already-installed');
    expect(installSubagentModelBadgeHook(injectSubagentModelBadgeFactorySource.toString(), SUBAGENT_MODEL_BADGE_SOURCE)).toBe('already-installed');
  });

  it('claims each Session context once even when apply runs repeatedly', () => {
    const source = spliced();
    const factory = Function(`return (${source})`)() as (require: (id: string) => unknown) => Record<string, unknown>;
    const exported = factory(() => React);
    const registrations: string[] = [];
    const ctx = {
      modelDirectories: { directoryFor: () => undefined },
      slots: {
        inject: (_n: string, cb: () => void) => cb(),
        register: (options: { id?: string }) => { registrations.push(options.id ?? ''); },
      },
    };
    const apply = exported.apply as (context: unknown) => unknown;
    apply(ctx);
    apply(ctx);
    apply(ctx);

    // The upstream body re-registers its own composer each call (unchanged upstream behavior);
    // the badge seat must still be claimed exactly once for this context.
    expect(registrations.filter((id) => id === 'subagent-model')).toHaveLength(1);
  });
  it('installs the badge stylesheet once, so repeated injection leaves no duplicate style tag', () => {
    const source = spliced();
    const exec = () => {
      const factory = Function(`return (${source})`)() as (require: (id: string) => unknown) => Record<string, unknown>;
      const exported = factory(() => React);
      (exported.apply as (context: unknown) => unknown)({
        modelDirectories: { directoryFor: () => undefined },
        slots: { inject: (_n: string, cb: () => void) => cb(), register: () => undefined },
      });
    };
    const tags: { attrs: Record<string, string>; textContent: string }[] = [];
    const documentStub = {
      head: { appendChild: (tag: { attrs: Record<string, string>; textContent: string }) => { tags.push(tag); } },
      querySelector: (selector: string) => (selector.includes('data-dsh-subagent-model-style') && tags.length > 0 ? tags[0] : null),
      createElement: () => {
        const tag = { attrs: {} as Record<string, string>, textContent: '', setAttribute: (name: string, value: string) => { tag.attrs[name] = value; } };
        return tag;
      },
    };
    vi.stubGlobal('document', documentStub);
    try {
      exec();
      exec();
      expect(tags).toHaveLength(1);
      expect(tags[0]?.attrs['data-dsh-subagent-model-style']).toBe('');
      expect(tags[0]?.textContent).toContain('.dsh-desktop-subagent-model{');
      expect(tags[0]?.textContent).toContain('text-overflow:ellipsis');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('reports loader-hook-unavailable instead of throwing when the shell hook is absent', () => {
    expect(installSubagentModelBadgeHook(injectSubagentModelBadgeFactorySource.toString(), SUBAGENT_MODEL_BADGE_SOURCE)).toBe('loader-hook-unavailable');
  });

  it('isolates its declarations from a factory that reuses every injected identifier', () => {
    // Adversarial fixture: the same names the badge block declares, plus a factory-scope `React`.
    const conflicting = `(require) => {
\t\tvar module = { exports: {} };
\t\tvar exports = module.exports;
\t\tconst React = "not-the-real-react";
\t\tconst badgeStyle = "hijacked";
\t\tconst noSessions = () => "hijacked";
\t\tconst noProjection = () => "hijacked";
\t\tconst emptyDirectory = () => "hijacked";
\t\tconst noSubscribe = () => "hijacked";
\t\tconst originalApply = () => "hijacked";
\t\tfunction resolveModelView() { return "hijacked"; }
\t\tfunction DshDesktopSubagentModelBadge() { return "hijacked"; }
\t\t// Hoisted exactly like the shipped bundle, so the injected block sees it at body start.
\t\tfunction apply(ctx) { ctx.slots.inject("conversation.composer", () => {}); }
\t\texports.apply = apply;
\t\treturn module.exports;
\t}`;
    const result = injectSubagentModelBadgeFactorySource(conflicting, SUBAGENT_MODEL_BADGE_SOURCE);

    expect(result.changed).toBe(true);
    expect(() => Function(`return (${result.source})`)()).not.toThrow();

    // The real badge still wins inside the injected block, and the factory keeps its own apply.
    const harness = buildBadge(result.source, badgeStore({ groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'Real Model' }] }] }));
    const markup = renderBadge(harness, { lastUsed: { provider: 'p', model: 'm' }, next: null });
    expect(readModel(markup)).toBe('Real Model');
  });
});
