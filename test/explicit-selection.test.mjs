/**
 * The rule this plugin now implements: `main` replaces a route the user never
 * chose, and does not overrule one they did.
 *
 * The proof is a durable `model/selection` event folded into the
 * `modelManagerSelection` projection, read back at request time through
 * `sessionProjections.stateOf`. Each scenario builds its own engine so the
 * captured registry cannot leak between cases.
 */

import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
  ok ? passed++ : failed++;
};

/**
 * One engine with its own handler map and projection answers.
 *
 * @param config - plugin config to apply.
 * @param options - how the projection layer should answer.
 */
function harness(config, options = {}) {
  const handlers = new Map();
  let explicit = options.explicit ?? false;
  const calls = [];
  const services = {
    agents: { list: () => [options.agent].filter(Boolean), get: () => options.agent, isOwnedBy: () => false },
    subagents: { listChildren: async () => [] },
    subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
    planMode: { get: () => ({ active: false }) },
    tools: { register: () => {} },
    systemPrompt: { section: () => () => {} },
  };
  if (options.projections !== false) {
    services.sessionProjections = {
      register: (definition) => { registered.push(definition.key); return () => {}; },
      stateOf(session, key) {
        calls.push(key);
        if (options.stateOfThrows === true) throw new Error('projection read failed');
        // A key the registry never received answers `undefined`, per the
        // declaration: "current state, or undefined when the key is not registered".
        if (options.noState === true) return undefined;
        return key === 'modelManagerSelection' ? (explicit ? { explicit: true } : { explicit: false }) : undefined;
      },
    };
  }
  const registered = [];
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    get: (name) => services[name],
    on: (event, handler) => handlers.set(event, handler),
    effect: (fn) => { fn(); },
    inject: (deps, cb) => {
      const scoped = Object.create(ctx);
      for (const dep of deps) scoped[dep] = services[dep];
      cb(scoped);
    },
  };
  plugin.apply(ctx, config);
  const request = (agent, resolved) =>
    handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => resolved);
  return { request, handlers, registered, calls, setExplicit: (value) => { explicit = value; } };
}

const COMPOSER = { provider: 'user-picked', model: 'session-choice' };
const MAIN = { provider: 'mgr', model: 'main-0' };
const CONFIG = (mode) => ({
  enabled: true,
  strategy: { mode },
  roles: {
    main: { models: [MAIN, { provider: 'mgr', model: 'main-1' }], pick: 'round-robin' },
    planning: { models: [] }, execution: { models: [] }, vision: { models: [] },
  },
});
const topLevel = () => ({ id: 'top-1', options: { ...COMPOSER }, session: { header: {}, id: 'sess-top' }, status: 'running' });

console.log('1. hybrid');
{
  const h = harness(CONFIG('hybrid'), { explicit: true });
  const out = await h.request(topLevel(), COMPOSER);
  check('an explicit session selection is respected', out.provider === 'user-picked' && out.model === 'session-choice',
    JSON.stringify(out));
  check('the projection was actually consulted', h.calls.includes('modelManagerSelection'), JSON.stringify(h.calls));
}
{
  const h = harness(CONFIG('hybrid'), { explicit: false });
  const out = await h.request(topLevel(), COMPOSER);
  check('with no explicit selection main rewrites the route', out.provider === 'mgr' && out.model === 'main-0',
    JSON.stringify(out));
}
{
  // Non-advancement is only observable across the switch: a respected call must
  // leave the rotation at index 0, so the first call that *is* applied still
  // gets main-0 rather than having silently consumed it.
  const h = harness(CONFIG('hybrid'), { explicit: true });
  await h.request(topLevel(), COMPOSER);
  h.setExplicit(false);
  const after = await h.request(topLevel(), COMPOSER);
  check('a respected selection does not consume the rotation', after.model === 'main-0',
    `first applied call got ${after.model}`);
}
{
  const h = harness(CONFIG('hybrid'), { explicit: false });
  await h.request(topLevel(), COMPOSER);
  const second = await h.request(topLevel(), COMPOSER);
  check('applying a route does advance the rotation', second.model === 'main-1', `second call got ${second.model}`);
}

console.log('\n2. the other modes keep owning every route');
{
  const h = harness(CONFIG('managed'), { explicit: true });
  const out = await h.request(topLevel(), COMPOSER);
  check('managed still applies main over an explicit selection', out.model === 'main-0', JSON.stringify(out));
}
{
  const h = harness(CONFIG('advisory'), { explicit: true });
  const out = await h.request(topLevel(), COMPOSER);
  check('advisory never rewrites, explicit or not', out.model === 'session-choice', JSON.stringify(out));
}

console.log('\n3. degraded projection answers fall back to the old behaviour');
{
  const h = harness(CONFIG('hybrid'), { explicit: true, projections: false });
  const out = await h.request(topLevel(), COMPOSER);
  check('no sessionProjections service: main still applies', out.model === 'main-0', JSON.stringify(out));
}
{
  const h = harness(CONFIG('hybrid'), { explicit: true, stateOfThrows: true });
  const out = await h.request(topLevel(), COMPOSER);
  check('a throwing stateOf is absorbed, not propagated', out.model === 'main-0', JSON.stringify(out));
}
{
  const h = harness(CONFIG('hybrid'), { explicit: true, noState: true });
  const out = await h.request(topLevel(), COMPOSER);
  check('an unregistered projection key reads as "not explicit"', out.model === 'main-0', JSON.stringify(out));
}

console.log('\n4. a disabled manager observes without touching the route');
{
  const h = harness({ ...CONFIG('hybrid'), enabled: false }, { explicit: true });
  const out = await h.request(topLevel(), COMPOSER);
  check('disabled manager leaves the route alone', out.model === 'session-choice', JSON.stringify(out));
}

console.log(`\nregistered projection keys: ${JSON.stringify([...new Set(harness(CONFIG('hybrid'), {}).registered)])}`);
console.log(`TALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
