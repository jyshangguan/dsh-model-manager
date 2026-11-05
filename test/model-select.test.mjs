/**
 * Model-selection suite for @darkbear9494/dsh-model-manager (0.6.1).
 *
 * DSH 0.2.x moved model switching out of the request waterfall:
 *
 *   - the loop reads `agent.model.current()` at the very start of
 *     `preStep()`, fixes provider/model/reasoningEffort for that step, and
 *     ABORTS the turn when `agent/request` proposes another route
 *     ("... after step preparation fixed ...; use agent.model.select() before
 *     step preparation");
 *   - `agent.model.select()` is the only legal way to change a model, and it
 *     applies to the next step whose preparation has not begun.
 *
 * The plugin therefore has two paths. On a harness without a selection surface
 * it keeps rewriting `agent/request` (0.1.x). With one, it selects before the
 * step: at `turn/start` — where `agent.inbox` still holds the turn's prompt and
 * the first `preStep()` has not run — and at `agent/pre-step` for the step after
 * the one in flight. `agent/request` becomes observe-only, which is exactly
 * what the harness requires.
 *
 * Run: node test/model-select.test.mjs   (or: npm test)
 */
import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);
const { apply, sameSelection, planningSkillInMessages, selectionModelOf } = plugin;

// ---------------------------------------------------------------------------
// assertion machinery
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
  ok ? passed++ : failed++;
};
const eq = (label, got, want) =>
  check(label, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const routeEq = (label, got, want) =>
  check(label, got?.provider === want.provider && got?.model === want.model,
    `${got?.provider}/${got?.model}`, `${want.provider}/${want.model}`);

// ---------------------------------------------------------------------------
// mock world
// ---------------------------------------------------------------------------
const PK = 'pkucorpus';
const DEPLOY = { provider: PK, model: 'deployment-default' };
const COMPOSER = { provider: 'user-picked', model: 'composer-choice' };
const MAIN = { provider: PK, model: 'main-tier' };
const MAIN2 = { provider: PK, model: 'main-tier-2' };
const PLAN = { provider: PK, model: 'planning-tier' };
const PLAN2 = { provider: PK, model: 'planning-tier-2' };
const EXEC = { provider: PK, model: 'execution-tier' };
const CHILD_LABEL = 'plan: design the change';

const config = (strategy = {}, roles = {}) => ({
  roles: {
    main: { models: [MAIN, MAIN2] },
    planning: { models: [PLAN, PLAN2] },
    execution: { models: [EXEC] },
    vision: { models: [] },
    ...roles,
  },
  strategy: { mode: 'hybrid', ...strategy },
  update: { enabled: false },
});

const userText = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });

/**
 * A DSH 0.2.x agent: `model.current()` answers the recorded selection or the
 * creation route; `model.select()` records one. `options` is the creation
 * route, which is how the manager tells a hand-picked model from the default.
 */
const modelAgent = (id, opts = {}) => {
  const agent = {
    id,
    options: { ...DEPLOY },
    session: {
      header: {},
      events: [],
      requestHeader: () => ({ config: agent.requestRoute ?? DEPLOY }),
    },
    inbox: { nextStep: [], nextTurn: [] },
    selections: [],
    current: undefined,
    requestRoute: undefined,
  };
  agent.model = {
    current: () => agent.current ?? { ...agent.options },
    select: (selection) => {
      agent.selections.push({ ...selection });
      agent.current = { ...selection };
    },
  };
  Object.assign(agent, opts);
  return agent;
};

/** A 0.1.x agent: no selection surface, so routing stays in the request. */
const requestAgent = (id, opts = {}) => ({
  id,
  options: { ...DEPLOY },
  session: { header: {}, events: [] },
  ...opts,
});

function harness(raw, { agent, childFacts } = {}) {
  const handlers = new Map();
  const logs = [];
  const services = {
    agents: {
      list: () => (agent === undefined ? [] : [agent]),
      get: (id) => (agent !== undefined && agent.id === id ? agent : undefined),
    },
    subagents: { listChildren: async () => childFacts ?? [] },
    subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
    planMode: { get: (subject) => ({ active: subject?.__plan === true }) },
    tools: { register: () => {} },
  };
  const ctx = {
    logger: () => ({
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    }),
    get: (name) => services[name],
    on: (event, handler) => { handlers.set(event, handler); },
    inject: () => {},
    effect: (fn) => { fn(); },
  };
  apply(ctx, raw);
  return {
    handlers,
    logs,
    // The loop claims a step's input first, then reads the model; the claim
    // notifications are emitted outside the append that published the splice.
    claim: (subject, message) => handlers.get('agent/inbox/claimed')?.({ agent: subject, message, turn: 1 }),
    request: (subject, resolved) => handlers.get('agent/request')?.({ agent: subject, turn: 1, step: 1 }, async () => resolved),
    preStep: (subject, messages = [], decision) => handlers.get('agent/pre-step')?.(
      { agent: subject, messages, turn: 1, step: 1 },
      async () => decision ?? { kind: 'enter', messages },
    ),
    requestError: (subject, failure) => handlers.get('agent/request-error')?.(
      { agent: subject, turn: 1, step: 1, failure, signal: undefined },
      async () => undefined,
    ),
  };
}

// ===========================================================================
console.log('--- A. the pure helpers ---');
// ===========================================================================
{
  eq('A1  sameSelection compares provider, model and effort',
    [
      sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }),
      sameSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'n' }),
      sameSelection({ provider: 'p', model: 'm', reasoningEffort: 'high' }, { provider: 'p', model: 'm' }),
      sameSelection(undefined, { provider: 'p', model: 'm' }),
    ], [true, false, false, false]);

  eq('A2  planningSkillInMessages finds the gesture in pending user text',
    planningSkillInMessages([userText('please /grilling sharpen this')], ['grill-me', 'grilling']),
    'grilling');
  eq('A3  an unlisted skill does not match',
    planningSkillInMessages([userText('/autoplan build it')], ['grill-me', 'grilling']),
    undefined);
  eq('A4  runtime-context and model messages are not scanned',
    planningSkillInMessages([
      { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: '/grilling' }] },
      { source: { kind: 'model' }, content: [{ type: 'text', text: '/grilling' }] },
    ], ['grilling']), undefined);
  eq('A5  an empty wanted list matches nothing',
    planningSkillInMessages([userText('/grilling')], []), undefined);

  eq('A6  selectionModelOf detects the surface and rejects an absent one',
    [selectionModelOf({ model: { select() {}, current() {} } }) !== undefined,
      selectionModelOf({ model: {} }) === undefined,
      selectionModelOf(undefined) === undefined],
    [true, true, true]);
}

// ===========================================================================
console.log('--- B. turn/start selects before the first step (DSH 0.2.x) ---');
// ===========================================================================
{
  const agent = modelAgent('b1');
  const h = harness(config(), { agent });
  h.claim(agent, userText('do the thing'));
  eq('B1  a plain prompt selects the main role', agent.selections.at(-1), MAIN);
}

{
  const agent = modelAgent('b2');
  const h = harness(config(), { agent });
  h.claim(agent, userText('/grilling sharpen this'));
  eq('B2  a /grilling prompt selects the planning role', agent.selections.at(-1), PLAN);
}

{
  const agent = modelAgent('b3');
  const h = harness(config(), { agent });
  h.claim(agent, userText('/autoplan build the thing'));
  eq('B3  a /autoplan prompt stays on the main role (autoplan is not a planning skill)',
    agent.selections.at(-1), MAIN);
}

{
  // A hand-picked composer model: the recorded selection differs from the
  // creation route and was not written by the manager.
  const agent = modelAgent('b4', { current: { ...COMPOSER } });
  const h = harness(config(), { agent });
  h.claim(agent, userText('do the thing'));
  eq('B4  hybrid respects a hand-picked session model', agent.selections, []);
  eq('B5  the manager owns the planning override under managed mode',
    (() => {
      const owned = modelAgent('b5', { current: { ...COMPOSER } });
      harness(config({ mode: 'managed' }), { agent: owned }).claim(owned, userText('do the thing'));
      return owned.selections.at(-1);
    })(), MAIN);
}

{
  // Step 1 selects MAIN; a later turn opening with /grilling must still move to
  // the planning tier — the manager's own selection is not a hand-picked model.
  const agent = modelAgent('b6');
  const h = harness(config(), { agent });
  h.claim(agent, userText('first turn'));
  eq('B6  first turn applies main', agent.current, MAIN);
  h.claim(agent, userText('/grilling now'));
  eq('B7  a later reading turn still escalates (manager-owned route is not explicit)',
    agent.current, PLAN);
}

{
  // Plan mode is read at the turn boundary too.
  const agent = modelAgent('b8', { __plan: true });
  harness(config(), { agent }).claim(agent, userText('design this'));
  eq('B8  plan mode selects the planning role', agent.current, PLAN);
}

{
  // Shared round-robin advance: a selection consumes one rotation turn only
  // when it is actually applied.
  const agent = modelAgent('b9');
  const h = harness({ ...config(), pick: 'round-robin' }, { agent });
  h.claim(agent, userText('one'));
  eq('B9  round-robin starts at the first model', agent.selections.at(-1), MAIN);
  h.claim(agent, userText('two'));
  eq('B10 round-robin advances on the second applied selection', agent.selections.at(-1), MAIN2);
}

// ===========================================================================
console.log('--- C. agent/request never proposes another route ---');
// ===========================================================================
{
  const agent = modelAgent('c1');
  const h = harness(config(), { agent });
  h.claim(agent, userText('do it'));
  // The harness fixed the step at a different route (a composer pick the
  // manager respected, say). Returning anything else would abort the turn.
  const resolved = { provider: PK, model: 'qwen3.8-max-0902' };
  const out = await h.request(agent, resolved);
  eq('C1  a route the step fixed is returned untouched', out, resolved);
}

{
  // A matching step is returned untouched too — the plugin never edits the
  // config object the harness passed in.
  const agent = modelAgent('c2');
  const h = harness(config(), { agent });
  h.claim(agent, userText('do it'));
  const resolved = { ...MAIN };
  const out = await h.request(agent, resolved);
  check('C2  the returned object IS the resolved config', out === resolved);
}

// ===========================================================================
console.log('--- D. pre-step corrects the next step ---');
// ===========================================================================
{
  // A session the manager already routed (so the route is manager-owned), then
  // plan mode opens: the step boundary moves it to the planning tier.
  const agent = modelAgent('d1');
  const h = harness(config(), { agent });
  h.claim(agent, userText('start'));
  eq('D1a the first turn is on main', agent.current, MAIN);
  agent.__plan = true;
  await h.preStep(agent, []);
  eq('D1b an active planning role is selected at the step boundary', agent.current, PLAN);
}
{
  const agent = modelAgent('d2', { current: { ...MAIN } });
  agent.session.header = {};
  const h = harness(config(), { agent });
  await h.preStep(agent, []);
  eq('D2  an unchanged role is not reselected', agent.selections, []);
}

// ===========================================================================
console.log('--- E. failover selects the next route instead of retrying ---');
// ===========================================================================
{
  const agent = modelAgent('e1');
  const h = harness(config(), { agent });
  // Record the role the failed request was routed as (the request observer
  // does this; a planning session is the clearest two-model chain).
  agent.__plan = true;
  h.claim(agent, userText('design this'));
  agent.requestRoute = { ...PLAN };
  await h.request(agent, { ...PLAN });
  const action = await h.requestError(agent, { code: 'RATE_LIMIT', message: 'down' });
  eq('E1  the next planning model is selected', agent.selections.at(-1), PLAN2);
  eq('E2  no retry is requested (the step route is fixed)', action, undefined);
  check('E3  the downgrade is logged',
    h.logs.some(([level, message]) => level === 'warn' && message.includes('fixed at preparation')),
    h.logs.map(([, m]) => m).join(' | '));
}

// ===========================================================================
console.log('--- F. 0.1.x harnesses keep request-time routing ---');
// ===========================================================================
{
  const agent = requestAgent('f1');
  const h = harness(config(), { agent });
  const out = await h.request(agent, { ...DEPLOY });
  routeEq('F1  a request-only harness still gets the role route applied', out, MAIN);
  await h.preStep(agent, []);
  check('F2  pre-step does not select on a harness without a selection surface',
    agent.selections === undefined);
}

console.log(`\nTALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;