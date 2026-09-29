/**
 * The rule this plugin now implements: `main` replaces a route the user never
 * chose, and does not overrule one they did.
 *
 * The proof is a durable `model/selection` event folded into the
 * `modelManagerSelection` projection, read back at request time through
 * `sessionProjections.stateOf`. Each scenario builds its own engine so the
 * captured registry cannot leak between cases.
 */

import { readFileSync } from 'node:fs';

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
    agents: { list: () => [...live.values()], get: (id) => live.get(id), isOwnedBy: () => false },
    subagents: { listChildren: async () => [] },
    subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
    planMode: { get: () => ({ active: false }) },
    tools: { register: (tool) => { registeredTool = tool; } },
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
  const live = new Map();
  let registeredTool;
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
  const request = (agent, resolved) => {
    live.set(agent.id, agent);
    return handlers.get('agent/request')({ agent, turn: 1, step: 1 }, async () => resolved);
  };
  return {
    request,
    handlers,
    registered,
    calls,
    tool: () => registeredTool,
    forget: (id) => live.delete(id),
    setExplicit: (value) => { explicit = value; },
  };
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

console.log('\n5. the report shows what served the top-level agent');
{
  const h = harness(CONFIG('hybrid'), { explicit: true });
  await h.request(topLevel(), COMPOSER);
  const out = await h.tool().execute({ action: 'report' });
  check('the report has a top-level section', out.includes('Top-level agents'), out.slice(0, 70));
  check('it records the hand-picked origin', out.includes('picked by hand, so main yields'), out.slice(0, 200));
  check('it records the reason that proved the override',
    out.includes('explicit session selection (respected)'), out.slice(0, 200));
  check('no orphan subagent table when no subagent exists',
    !out.includes('Subagent model report') && !out.includes('child       role'), out.slice(0, 220));
  const headers = out.split('\n').filter((l) => l.includes('status') && (l.includes('reason') || l.includes('label')));
  check('both tables put status at the same column',
    headers.length < 2 || headers[0].indexOf('status') === headers[1].indexOf('status'),
    headers.map((l) => l.indexOf('status')).join(','));
  // The 43-wide column is only trustworthy if no reason string can exceed it.
  // Read the literals out of the host half instead of trusting a hand-kept list,
  // which is exactly the kind of table that goes stale.
  const hostSource = readFileSync(PLUGIN, 'utf8');
  const reasons = [...hostSource.matchAll(/reason:?'?\s*'([^']+)'/g)].map((m) => m[1])
    .concat([...hostSource.matchAll(/reason = '([^']+)'/g)].map((m) => m[1]));
  const tooLong = reasons.filter((r) => r.length > 42);
  check('no reason string can overflow the 43-wide column it is padded into',
    reasons.length > 5 && tooLong.length === 0,
    `${reasons.length} reasons found; overlong: ${tooLong.join(' | ')}`);
  // And the width the code actually uses, read back out of the source, so the
  // check above cannot pass while the renderer quietly narrows the column again.
  const width = Number((hostSource.match(/seen\?\.reason \?\? '-'\)\.padEnd\((\d+)\)/) ?? [])[1] ?? 0);
  const longest = reasons.reduce((n, r) => (r.length > n ? r.length : n), 0);
  check('the renderer pads the reason column past the longest reason it can print',
    width > 0 && longest < width, `padEnd(${width}) but the longest reason is ${longest} chars`);
  const outLines = out.split('\n');
  const separators = outLines.filter((l) => l.startsWith('----------  ---------'));
  check('every table separator is exactly as wide as its header',
    separators.every((sep) => outLines.some((l) => l.includes('role       model') && l.length === sep.length)),
    `separators ${separators.length}, widths ${[...new Set(separators.map((x) => x.length))].join(',')}`);
}
{
  const h = harness(CONFIG('hybrid'), { explicit: false });
  await h.request(topLevel(), COMPOSER);
  const out = await h.tool().execute({ action: 'report' });
  check('an untouched session is reported as default-driven',
    out.includes('the deployment default, so main applies'), out.slice(0, 220));
  check('and its route really was rewritten by main', out.includes('mgr/main-0'), out.slice(0, 220));
}
{
  const h = harness(CONFIG('managed'), { explicit: true });
  await h.request(topLevel(), COMPOSER);
  const out = await h.tool().execute({ action: 'report' });
  check('managed reports the pick but shows the override',
    out.includes('picked by hand, so main yields') && out.includes('mgr/main-0'), out.slice(0, 240));
}

console.log('\n6. a decision outlives its agent');
{
  const h = harness(CONFIG('hybrid'), { explicit: true });
  await h.request(topLevel(), COMPOSER);
  h.forget('top-1'); // the agent is disposed, but the request was still recorded
  const out = await h.tool().execute({ action: 'report' });
  check('a no-longer-live session still reports what served it',
    out.includes('Top-level agents') && out.includes('unknown, agent no longer live'),
    out.slice(0, 240));
  check('and the row is marked inactive rather than dropped',
    out.includes('inactive') && out.includes('picked by hand, so main yields') === false,
    out.slice(0, 240));
}
{
  const h = harness(CONFIG('hybrid'), { explicit: true });
  const out = await h.tool().execute({ action: 'report' });
  check('a report with nothing observed is still the empty state',
    out.startsWith('No subagents observed yet'), out.slice(0, 60));
}

console.log(`\nregistered projection keys: ${JSON.stringify([...new Set(harness(CONFIG('hybrid'), {}).registered)])}`);
console.log(`TALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
