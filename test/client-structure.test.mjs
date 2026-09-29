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
    register: (ns, dicts) => { localeCalls.push({ ns, en: Object.keys(dicts.en ?? {}).length, zh: Object.keys(dicts.zh ?? {}).length }); return () => {}; },
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
console.log('   id      :', captured?.id, captured?.id === 'dsh-model-manager' ? 'PASS' : 'FAIL');
console.log('   requires:', JSON.stringify(required), required.every((n) => n === 'react') ? 'PASS' : 'FAIL');

console.log('\n2. exports');
console.log('   inject:', JSON.stringify(exported.inject));
console.log('   apply :', typeof exported.apply === 'function' ? 'PASS' : 'FAIL');

exported.apply(ctx);
await new Promise((r) => setTimeout(r, 20));

console.log('\n3. locale:', JSON.stringify(localeCalls));
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
  ['factory id is the package name', captured?.id === 'dsh-model-manager'],
  ['only react is required', required.every((n) => n === 'react')],
  ['apply exported', typeof exported.apply === 'function'],
  ['locale registered and en/zh key sets match', localeCalls[0]?.en > 0 && localeCalls[0]?.en === localeCalls[0]?.zh],
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

console.log('');
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed++;
}
console.log(failed === 0 ? '\nRESULT: PASS' : `\nRESULT: FAIL (${failed})`);
process.exitCode = failed ? 1 : 0;
