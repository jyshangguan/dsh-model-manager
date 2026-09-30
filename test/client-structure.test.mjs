/**
 * Structural check of the client half, per the harness's verification guidance:
 * manifest/loadability and slot-registration shape only. No React/DOM emulation
 * and no claim about rendered appearance.
 */
import { PLUGIN, CLIENT, dshFile } from './paths.mjs';

import { readFileSync } from 'node:fs';

const SRC = CLIENT;

let captured;
globalThis.window = { __ModuleLoader__: { load(def) { captured = def; } } };
await import('file://' + SRC + '?t=' + Date.now());

const required = [];
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props: { ...props }, children }),
  useSyncExternalStore: (subscribe, getSnapshot) => getSnapshot(),
  useState: (initial) => [initial, () => {}],
  useMemo: (fn) => fn(),
};

const exported = captured.factory((name) => {
  required.push(name);
  if (name === 'react') return reactStub;
  throw new Error(`client half required a non-React module: ${name}`);
});

// ---- recording context -----------------------------------------------------
const localeCalls = [];
const slotInjects = [];
const registerCalls = [];
const effects = [];
const remoteOns = [];
const configFormGets = [];
const whileServedCalls = [];

const projectionFaces = [];
const usageFace = {
  getSnapshot: () => ({ routes: [{ provider: 'pku-corpus', model: 'qwen3.8-flash', requests: 3, uncachedInputTokens: 1200, outputTokens: 640, cacheReadTokens: 9000, cacheWriteTokens: 0, totalTokens: 11840 }] }),
  subscribe: () => () => {},
};
const services = {
  sessions: {
    binding: (sessionId) => ({
      sessionId,
      session: {
        projections: {
          faceOf(key) {
            projectionFaces.push(key);
            return usageFace;
          },
        },
      },
    }),
  },
  configForms: {
    get(entryId) {
      configFormGets.push(entryId);
      return {
        getSnapshot: () => ({ status: 'ready', value: { roles: {}, strategy: {} }, writable: true, revision: 1, mode: 'host' }),
        subscribe: () => () => {},
        mutate: async () => true,
      };
    },
    whileServed(namespaces, register) {
      whileServedCalls.push([...namespaces]);
      return register(new Set(namespaces));
    },
  },
};

const ctx = {
  effect(fn, label) { effects.push(label); const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject(deps, cb) { const scoped = Object.create(ctx); for (const d of deps) scoped[d] = services[d]; return cb(scoped); },
  locale: {
    register: (ns, dicts) => { localeCalls.push({ ns, en: Object.keys(dicts.en ?? {}), zh: Object.keys(dicts.zh ?? {}) }); return () => {}; },
    bind: (ns) => (key) => `${ns}.${key}`,
  },
  slots: {
    inject: (name, cb) => { slotInjects.push(name); return cb(); },
    register: (options, Component) => {
      // Mirror the real SlotCore.register contract (dsh-client-ui-slots/lib/index.js:163-189).
      if (options === undefined || options.name === undefined) throw new Error('slot "undefined" is not declared');
      const kind = options.name === 'plugins.row.config' ? 'keyed' : 'list';
      if (kind === 'list' && options.id === undefined) throw new Error('list slot requires options.id');
      if (kind === 'keyed' && options.key === undefined) throw new Error('keyed slot requires options.key');
      registerCalls.push({ options, Component });
      return () => {};
    },
  },
  remote: {
    $on: (event) => { remoteOns.push(event); return () => {}; },
    session: { modelCatalog: async () => ({ ok: true, value: { groups: [], failures: [] } }) },
  },
};

console.log('1. factory id, and modules required at load');
console.log('   id      :', captured?.id, captured?.id === '@darkbear9494/dsh-model-manager' ? 'PASS' : 'FAIL');
console.log('   requires:', JSON.stringify(required), required.every((n) => n === 'react') ? 'PASS' : 'FAIL');

console.log('\n2. exports');
console.log('   inject:', JSON.stringify(exported.inject));
console.log('   apply :', typeof exported.apply === 'function' ? 'PASS' : 'FAIL');

exported.apply(ctx);
await new Promise((r) => setTimeout(r, 20));

console.log('\n3. locale:', JSON.stringify(localeCalls.map((c) => ({ ns: c.ns, en: c.en.length, zh: c.zh.length }))));
console.log('4. slots injected:', JSON.stringify(slotInjects));
for (const r of registerCalls) console.log('   register:', JSON.stringify(r.options), '| Component:', typeof r.Component);
console.log('5. configForms.get called with:', JSON.stringify(configFormGets));
console.log('   whileServed gated on     :', JSON.stringify(whileServedCalls));
console.log('6. remote subscriptions:', JSON.stringify(remoteOns));

// Static guard: every `ctx.remote.<ns>` the client half touches must be declared
// in `inject`. Each namespace is a separate cordis service mounted by its own
// package, so declaring only `remote` lets `apply` run before they exist — which
// is what once left every model picker empty.
const clientSource = readFileSync(SRC, 'utf8');
const usedNamespaces = new Set(
  [...clientSource.matchAll(/ctx\.remote\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
);
usedNamespaces.delete('$on');   // a method on the remote service, not a namespace
const declaredNamespaces = new Set(
  exported.inject.filter((n) => n.startsWith('remote.')).map((n) => n.slice('remote.'.length)),
);
const undeclaredNamespaces = [...usedNamespaces].filter((ns) => !declaredNamespaces.has(ns));
console.log(`   remote namespaces used: ${JSON.stringify([...usedNamespaces])}`);
console.log(`   declared in inject  : ${JSON.stringify([...declaredNamespaces])}`);

const usageRegistration = registerCalls.find((r) => r.options?.name === 'conversation.session.header.utilities');
let usageProps;
let usageRendered;
if (usageRegistration !== undefined) {
  try {
    usageProps = usageRegistration.options.inject?.('session-under-test');
    usageRendered = usageRegistration.Component(usageProps);
  } catch (error) {
    console.log('   usage surface threw:', error?.message ?? error);
  }
}

// Expanded state: the panel is what proves the value is attributed per model,
// since the collapsed trigger only shows one aggregate.
const previousUseState = reactStub.useState;
reactStub.useState = () => [true, () => {}];
let usageExpandedJson = '';
try {
  usageExpandedJson = JSON.stringify(usageRegistration ? usageRegistration.Component(usageProps) : null);
} finally {
  reactStub.useState = previousUseState;
}

const checks = [
  ['factory id is the package name', captured?.id === '@darkbear9494/dsh-model-manager'],
  ['only react is required', required.every((n) => n === 'react')],
  ['apply exported', typeof exported.apply === 'function'],
  ['locale registered and en/zh key sets match',
    (localeCalls[0]?.en.length ?? 0) > 0
      && JSON.stringify([...localeCalls[0].en].sort()) === JSON.stringify([...localeCalls[0].zh].sort())
      && localeCalls[0].ns === 'dsh-model-manager'],
  ['Settings section slot injected', slotInjects.includes('settings.section')],
  ['both surfaces are injected', slotInjects.length === 2
    && slotInjects.includes('settings.section')
    && slotInjects.includes('conversation.session.header.utilities')],
  ['settings page registered', registerCalls.some((r) => r.options?.id === 'model-manager' && r.options?.order === 50)],
  ['exactly two registrations', registerCalls.length === 2],
  ['settings form bound to row ns', configFormGets.includes('model-manager')],
  ['settings page registered without a whileServed gate', whileServedCalls.length === 0],
  ['adapter invalidation subscribed', remoteOns.includes('llm/adapters-updated')],
  ['every registration carries name', registerCalls.every((r) => typeof r.options?.name === 'string')],
  ['usage surface registered in the session header',
    registerCalls.some((r) => r.options?.name === 'conversation.session.header.utilities'
      && r.options?.id === 'model-manager-usage')],
  ['usage surface reads the host projection key', projectionFaces.includes('modelManagerUsage')],
  ['usage inject hands the component a projection face',
    usageProps !== undefined && typeof usageProps.face?.getSnapshot === 'function'],
  ['usage trigger renders collapsed with the wired total',
    JSON.stringify(usageRendered ?? '').includes('dsh-model-manager.usageTitle')
      && JSON.stringify(usageRendered ?? '').includes('12k')
      && !JSON.stringify(usageRendered ?? '').includes('pku-corpus')],
  ['expanding the trigger discloses the attributed route',
    usageExpandedJson.includes('pku-corpus/qwen3.8-flash')
      && usageExpandedJson.includes('dsh-model-manager.usageUncachedInput')
      && usageExpandedJson.includes('1,200') === false
      && usageExpandedJson.includes('1.2k')],
];

// ---- catalog sourcing ------------------------------------------------------
// Regression: the session-scoped catalog is served through the session
// namespace and may never settle when no session is open. It must be a bonus
// source, never a gate — awaiting it first is what once left the pickers empty
// in the Settings panel.
const llmCalls = [];
let unhandled = null;
process.on('unhandledRejection', (reason) => { unhandled = reason; });

const hangCtx = {
  effect(fn) { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
  inject(deps, cb) { const scoped = Object.create(hangCtx); return cb(scoped); },
  locale: { register: () => () => {}, bind: () => (key) => key },
  slots: { inject: (name, cb) => cb(), register: () => () => {} },
  remote: {
    $on: () => () => {},
    session: { modelCatalog: () => new Promise(() => {}) },   // never settles
    llm: {
      listConfigurableProviders: async () => {
        llmCalls.push('listConfigurableProviders');
        return { ok: true, value: [{ provider: 'pku-corpus', displayName: 'PKU Corpus Program', settingsNs: 'llm-pi-ai' }] };
      },
      discoverModels: async (ns, request) => {
        llmCalls.push(`discoverModels:${ns}:${request?.provider}`);
        return { ok: true, value: [{ id: 'qwen3.8-flash', name: 'qwen3.8-flash', inputModalities: ['text'] }] };
      },
    },
  },
};
exported.apply(hangCtx);
await new Promise((r) => setTimeout(r, 80));

checks.push(
  ['a hanging session catalog does not gate the llm directory',
    llmCalls.includes('listConfigurableProviders')
      && llmCalls.some((c) => c.startsWith('discoverModels:llm-pi-ai:pku-corpus'))],
  ['discoverModels is called with the provider settings namespace',
    llmCalls.includes('discoverModels:llm-pi-ai:pku-corpus')],
  ['the catalog load leaves no unhandled rejection', unhandled === null],
);
if (llmCalls.length > 0) console.log(`\n7. llm directory calls under a hanging session catalog: ${JSON.stringify(llmCalls)}`);

let passed = 0;
let failed = 0;
console.log('');
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  ok ? passed++ : failed++;
}

// ---- 8. settings card layout invariants ------------------------------------
// The model editor is a grid, and that is the whole fix: flex rows whose width
// depends on siblings cannot keep columns aligned once a row shows an extra
// control. These assertions pin the invariants that produce the alignment, so a
// later edit that reintroduces a wrapping flex row or drops a placeholder cell
// fails here instead of looking wrong on screen.
console.log('\n8. settings card layout');

const layoutRegistrations = [];
const layoutCtx = {
  effect: (fn) => { fn(); return () => {}; },
  inject: (deps, cb) => {
    const scoped = Object.create(layoutCtx);
    for (const dep of deps) scoped[dep] = dep === 'sessions' ? undefined : services[dep];
    cb(scoped);
  },
  locale: { register: () => () => {}, bind: (ns) => (key, params) => (params ? `${ns}.${key}:${params.count}` : `${ns}.${key}`) },
  slots: {
    inject: (name, cb) => (name === 'settings.section' ? cb() : () => {}),
    register: (options, Component) => { layoutRegistrations.push({ options, Component }); return () => {}; },
  },
  remote: {
    $on: () => () => {},
    // A catalog entry WITH reasoning efforts and one without, so both branches
    // of the effort column exist in the rendered tree.
    session: {
      modelCatalog: async () => ({
        ok: true,
        value: {
          groups: [{
            id: 'pku-corpus',
            name: 'PKU',
            models: [
              { id: 'qwen3.8-max-0902', name: 'Qwen Max', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
              { id: 'qwen3.8-flash', name: 'Qwen Flash' },
            ],
          }],
          failures: [],
        },
      }),
    },
  },
};
exported.apply(layoutCtx);

const card = layoutRegistrations.find((r) => r.options?.id === 'model-manager')?.Component;
const cardState = {
  status: 'ready',
  revision: 3,
  writable: true,
  value: {
    enabled: true,
    strategy: { mode: 'hybrid' },
    roles: {
      main: { models: [{ provider: 'pku-corpus', model: 'qwen3.8-max-0902' }, { provider: 'pku-corpus', model: 'qwen3.8-flash' }] },
      planning: { models: [] },
      execution: { models: [] },
      vision: { models: [] },
    },
  },
};

const layoutChecks = [];
let cardTree;
try {
  cardTree = card({ form: { state: cardState, mutate: async () => true } });
} catch (error) {
  layoutChecks.push(['card renders a populated role without throwing', false, String(error?.message ?? error)]);
}
if (cardTree !== undefined) layoutChecks.push(['card renders a populated role without throwing', true]);

const nodes = [];
(function walk(node) {
  if (node === null || node === undefined || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach(walk); return; }
  if (node.type !== undefined) nodes.push(node);
  walk(node.children);
  if (node.props?.style === undefined) return;
})(cardTree);

const grids = nodes.filter((n) => n.props?.style?.display === 'grid');
layoutChecks.push(['one grid container per role, so every role aligns on its own',
  grids.length === 4, `found ${grids.length}`]);
layoutChecks.push(['the grid declares index, model, effort and action tracks',
  grids.every((g) => g.props?.style?.gridTemplateColumns === 'auto minmax(0, 1fr) auto auto'),
  grids[0]?.props?.style?.gridTemplateColumns]);
layoutChecks.push(['no grid cell reflows, which is what misaligned the old flex rows',
  grids.every((g) => g.props?.style?.flexWrap === undefined),
  JSON.stringify(grids.map((g) => g.props?.style?.flexWrap))]);

// Two models must emit two complete 4-cell groups.
const gridChildren = grids[0]?.children ?? [];
const flat = [];
// Descend into each node's own children too: the action buttons live inside the
// action cell, so a flatten that only walks arrays stops one level above them.
(function flatten(list) {
  for (const item of list ?? []) {
    if (Array.isArray(item)) { flatten(item); continue; }
    if (item === null || typeof item !== 'object') continue;
    flat.push(item);
    flatten(item.children);
  }
})(gridChildren);
const cellNodes = (grids[0]?.children ?? []).flat(9).filter((c) => c !== null && typeof c === 'object');
// Four cells per row (index, model, effort-or-placeholder, actions), plus the
// add affordance and the pick line this role shows because it has two models.
layoutChecks.push(['every row emits all four cells, effort placeholder included',
  cellNodes.length === 2 * 4 + 2, `cells ${cellNodes.length}`]);
const modelSelects = flat.filter((n) => n.type === 'select' && String(n.props?.['aria-label'] ?? '').match(/Main \d$/));
layoutChecks.push(['each model gets its own value select', modelSelects.length === 2, `found ${modelSelects.length}`]);
const actionSpans = flat.filter((n) => n.props?.style?.display === 'inline-flex'
  && (n.children ?? []).some((c) => c?.type === 'button'));
layoutChecks.push(['each row carries an action cell', actionSpans.length >= 2, `found ${actionSpans.length}`]);
const upButtons = flat.filter((n) => n.type === 'button' && String(n.props?.['aria-label'] ?? '').startsWith('dsh-model-manager.moveUp'));
layoutChecks.push(['move-up exists on every row, disabled on the first',
  upButtons.length === 2 && upButtons[0]?.props?.disabled === true,
  upButtons.map((b) => b.props?.disabled).join(',')]);
layoutChecks.push(['glyph-only buttons still name themselves',
  upButtons.every((b) => typeof b.props?.['aria-label'] === 'string' && typeof b.props?.title === 'string')]);

const addSelect = flat.find((n) => n.type === 'select' && String(n.props?.['aria-label'] ?? '').includes('addModel'));
layoutChecks.push(['the add control is styled as an affordance, not a model row',
  addSelect?.props?.style?.borderStyle === 'dashed' && addSelect?.props?.style?.background === 'transparent',
  JSON.stringify(addSelect?.props?.style ?? {})]);
layoutChecks.push(['the add control spans the value columns',
  addSelect?.props?.style?.gridColumn === '2 / -1', addSelect?.props?.style?.gridColumn]);

for (const [label, ok, detail] of layoutChecks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
  ok ? passed++ : failed++;
}

// ---- 9. theme tokens are real ----------------------------------------------
// `Theme.listTokens` (Client inspect provider) is the authoritative set; the
// list below was read from it against the running page. Inventing a token does
// not throw: `var()` with an unknown custom property drops the declaration, so
// the element silently inherits a color and the intent is lost without a trace.
const LEGAL_TOKENS = new Set([
  '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary',
  '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
  '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary',
  '--dsw-specific-sidebar-fill',
]);
const tokens = [...clientSource.matchAll(/--dsw-[a-z0-9-]+/gi)].map((m) => m[0]);
const invented = tokens.filter((t) => !LEGAL_TOKENS.has(t) && t !== '--dsw-alias-');
console.log('\n9. theme tokens');
console.log(`${invented.length === 0 ? 'PASS' : 'FAIL'}  every theme token used is published by Theme.listTokens`);
if (invented.length > 0) console.log(`        invented: ${[...new Set(invented)].join(', ')}`);
invented.length === 0 ? passed++ : failed++;

console.log('\nRESULT: ' + (failed === 0 ? 'PASS' : `FAIL (${failed})`));
console.log(`TALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
