#!/usr/bin/env node
/**
 * Adversarial edge-case suite for @darkbear9494/dsh-model-manager.
 *
 * Goal: find defects, not confirm the plugin works. Every assertion prints
 * PASS/FAIL with observed vs expected; a single FAIL sets exit code 1.
 *
 * Mock fidelity notes (the mock is derived from the live DSH sources, not invented):
 *   - `agent/request` payload is `{turn, step, signal, agent}` and `agent` is
 *     fused in by the agent dispatcher (`dsh-agent/lib/index.js` → agentEvents.fused).
 *   - `ctx.get('agents').isOwnedBy(childId, ownerAgent)` compares runtime
 *     ownership (`dsh-agent/lib/index.js` AgentsService.isOwnedBy).
 *   - `ctx.get('subagents').listChildren(parentSessionId)` returns
 *     `{id, createdAt, mode, label?}` rows (dsh-subagent subagentCatalog view);
 *     `agent.id` is the shared agent/session id.
 *   - The agent loop persists the *resolved* waterfall output as the request
 *     header (`dsh-agent-loop/lib/index.js` buildRequest → session.requestHeader().config),
 *     and `dsh-subagent resolveChildAgentOptions` inherits a child's route from
 *     that header first, falling back to `parent.options`
 *     (dsh-subagent/lib/index.js:414-452). The mock mirrors exactly that.
 *   - `subagent/start` is emitted after the catalog fact is appended
 *     (dsh-subagent/lib/index.js:3132 establishCatalogChild → observeRun).
 *   - `llm.resolveModelInfo(provider, model)` returns model info whose
 *     `inputModalities` key is ABSENT unless the adapter declared it
 *     (dsh-llm/lib/index.js:2111-2123) and which THROWS for an unknown route;
 *     `dsh-acp/lib/index.js:84` uses the same `includes('image')` capability test.
 *   - The allow-list fixture is checked against the REAL gate: this file imports
 *     `SubagentModelSelectionConfig.prototype.current` and drives it, so the
 *     emitted snippet is validated by harness code, not by a transcription. The
 *     fixture always holds a non-empty list because `enabled: true` with
 *     `allowedModels: []` throws in the real harness (:59) and is therefore not
 *     a reachable state.
 *   - `loader/volatile-update` is emitted after mutating the raw config object in
 *     place, which is what a volatile-only Settings save does (the harness keeps
 *     the same object and does not re-run `apply`).
 *   - Reason strings asserted against the report column: `applied`,
 *     `applied (manager-owned)`, `explicit child route (respected)`,
 *     `lineage unresolved (child route respected)`, `advisory (not applied)`,
 *     `passthrough (role unconfigured)`.
 *
 * Sections: A waterfall contract - B hostile config/keywords - C reasoning effort
 * - D classification precedence - E keyword anchoring - F report/usage/routes
 * surfaces + allow-list round-trip - G missing services - H concurrency
 * - I catalog staleness - J hybrid lineage + manager-owned rule - M round-robin
 * commit semantics - K exports/effectiveRouteOf - L schema-validated config
 * - N vision image capability - O volatile live reload - Z process invariants.
 *
 * Coverage map (each numbered defect has a passing assertion):
 *   D1 hybrid lineage/`effectiveRouteOf` -> J1-J5c, K6-K10   D5 usage counting -> F13-F13d
 *   D2 historyLimit floor              -> B, F18b            D6 allow-list dedupe -> F23-F27j
 *   D3 keyword trimming                -> B, E16             vision capability -> N1-N12
 *   D4 empty vs absent keywords        -> B, E17             volatile reload -> O0-O8, V1-V9
 *
 * Run: npm test   (or: node test/edge.test.mjs from the package root)
 */
import { inspect } from 'node:util';

const plugin = await import(PLUGIN);
const { apply, readConfig, applyRoute, DEFAULT_PLANNING_KEYWORDS, DEFAULT_VISION_KEYWORDS } = plugin;

// The real DSH child-option resolver, so "what a child inherits" is not a mock guess.
const DSH_SUBAGENT = dshFile('dsh-subagent', 'lib/index.js');
let realResolveChildAgentOptions = null;
if (DSH_SUBAGENT === undefined) {
  console.log('WARN  no DSH installation found on PATH (set DSH_INSTALL_DIR to pin one); '
    + 'using a local re-implementation of resolveChildAgentOptions');
} else {
  try {
    realResolveChildAgentOptions = (await import(DSH_SUBAGENT)).resolveChildAgentOptions;
  } catch (error) {
    console.log(`WARN  could not import the real dsh-subagent resolver (${error.message}); falling back to a local re-implementation`);
  }
}

// The REAL harness allow-list gate. `SubagentModelSelectionConfig.current()` calls
// `assertAllowedModelRoutes(allowedModels)` — see
// dsh-tool-subagent/lib/model-selection-settings.js:23-38 (key `${provider}\0${model}`,
// throws on a repeated route) and :55-64 (also throws on enabled + empty list).
// Driving the real method through the prototype (so no Service construction is needed)
// pins the round-trip test to harness behaviour instead of my transcription of it.
const DSH_MODEL_SELECTION = dshFile('dsh-tool-subagent', 'lib/model-selection-settings.js');
let realSelectionCurrent = null;
if (DSH_MODEL_SELECTION === undefined) {
  console.log('WARN  no DSH installation found on PATH (set DSH_INSTALL_DIR to pin one); '
    + 'using a local transcription of the subagent allow-list gate');
} else {
  try {
    realSelectionCurrent = (await import(DSH_MODEL_SELECTION)).SubagentModelSelectionConfig?.prototype?.current ?? null;
  } catch (error) {
    console.log(`WARN  could not import the real subagent allow-list gate (${error.message}); using a local transcription`);
  }
}

/** Run the harness's own `allowedModels` validation over a candidate list. */
function gateAllowedModels(allowedModels, enabled = true) {
  if (realSelectionCurrent === null) {
    const seen = new Set();
    for (const route of allowedModels) {
      const key = `${route.provider}\0${route.model}`;
      if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`);
      seen.add(key);
    }
    if (enabled && allowedModels.length === 0) throw new Error('enabled subagent model selection requires at least one allowed model');
    return { enabled, allowedModels };
  }
  return realSelectionCurrent.call({
    config: {
      enabled: { get: () => enabled },
      allowedModels: { get: () => allowedModels },
    },
  });
}

// ---------------------------------------------------------------------------
// assertion machinery
// ---------------------------------------------------------------------------
let PASS = 0;
let FAIL = 0;
const failures = [];
const infos = [];

/** The plugin must never leave a rejection unobserved, including its fire-and-forget
 *  boot checks. Collected globally and asserted once at the very end. */
const unhandled = [];
process.on('unhandledRejection', (reason) => {
  unhandled.push(String(reason?.message ?? reason));
});

const short = (value) => {
  try {
    const text = typeof value === 'string' ? value : inspect(value, { depth: 2, breakLength: 220 });
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
  } catch {
    return String(value);
  }
};

function check(label, ok, observed, expected) {
  if (ok) {
    PASS += 1;
    console.log(`PASS  ${label}`);
    return true;
  }
  FAIL += 1;
  failures.push({ label, observed: short(observed), expected: short(expected) });
  console.log(`FAIL  ${label}`);
  console.log(`        observed: ${short(observed)}`);
  console.log(`        expected: ${short(expected)}`);
  return false;
}

const eq = (label, got, want) => check(label, JSON.stringify(got) === JSON.stringify(want), got, want);
const routeEq = (label, got, provider, model) =>
  check(label, got?.provider === provider && got?.model === model, `${got?.provider}/${got?.model}`, `${provider}/${model}`);
const section = (title) => console.log(`\n=== ${title} ===`);
const info = (message) => {
  infos.push(message);
  console.log(`INFO  ${message}`);
};

// ---------------------------------------------------------------------------
// mock world
// ---------------------------------------------------------------------------
const PK = 'pku-corpus';
const M = (model, extra) => ({ provider: PK, model, ...(extra ?? {}) });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeWorld(options = {}) {
  return {
    agents: [],
    owners: new Map(),
    catalog: new Map(),
    calls: { listChildren: 0, isOwnedBy: 0 },
    onListChildren: null,
    onPlanMode: null,
    breakOwnership: false,
    // NOTE: `enabled: true` with an empty list is rejected by the real harness
    // (`model-selection-settings.js:59`), so the default fixture always has a route.
    allowList: options.allowList ?? { enabled: true, allowedModels: [{ provider: 'pku-corpus', model: 'UNRELATED' }] },
  };
}

function addParent(world, id, opts) {
  const agent = {
    id,
    options: { ...opts },
    status: 'running',
    /** what the loop would persist after a waterfall run */
    __headerConfig: undefined,
  };
  agent.session = {
    header: {},
    // mirrors dsh-agent-loop buildRequest -> session.requestHeader()
    requestHeader: () => (agent.__headerConfig === undefined ? undefined : { config: { ...agent.__headerConfig } }),
  };
  world.agents.push(agent);
  return agent;
}

function addChild(world, parent, id, label, opts) {
  const agent = {
    id,
    options: { ...(opts ?? {}) },
    status: 'running',
    __headerConfig: undefined,
  };
  agent.session = {
    header: { origin: 'subagent' },
    requestHeader: () => (agent.__headerConfig === undefined ? undefined : { config: { ...agent.__headerConfig } }),
  };
  world.agents.push(agent);
  world.owners.set(id, parent);
  const rows = world.catalog.get(parent.id) ?? [];
  rows.push({
    id,
    createdAt: rows.length + 1,
    mode: 'one-shot',
    ...(label === undefined ? {} : { label }),
  });
  world.catalog.set(parent.id, rows);
  return agent;
}

/** What a delegation with no per-child model override actually inherits.
 *  Uses the REAL dsh-subagent resolver when it is importable. */
function childInheritedOpts(parent) {
  if (realResolveChildAgentOptions !== null) {
    const resolved = realResolveChildAgentOptions(parent, undefined, 1);
    const { subagentDepth: _depth, ...options } = resolved;
    return options;
  }
  if (parent.__headerConfig !== undefined) return { ...parent.__headerConfig };
  const { provider, model, reasoningEffort, maxTokens } = parent.options ?? {};
  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function makeCtx(options = {}) {
  const world = options.world ?? makeWorld();
  const handlers = new Map();
  const tools = [];
  const state = { section: undefined, logs: [] };
  const allowList = options.allowList ?? world.allowList;

  const services = {
    agents: {
      list: () => world.agents.slice(),
      get: (id) => world.agents.find((agent) => agent.id === id),
      isOwnedBy: (id, owner) => {
        world.calls.isOwnedBy += 1;
        if (world.breakOwnership) return false;
        return world.owners.get(id) === owner;
      },
    },
    subagents: {
      listChildren: async (parentId) => {
        world.calls.listChildren += 1;
        if (world.onListChildren) return world.onListChildren(parentId);
        return (world.catalog.get(parentId) ?? []).slice();
      },
    },
    subagentModelSelection: { current: () => allowList },
    planMode: {
      get: (agent) => world.onPlanMode ? world.onPlanMode(agent) : { active: agent.__plan === true },
    },
    tools: { register: (tool) => tools.push(tool) },
    systemPrompt: {
      section: (s) => {
        if (options.sectionThrows) throw new Error('section boom');
        state.section = s;
        return () => {};
      },
    },
  };
  if (options.toolsMissing) delete services.tools;
  if (options.systemPromptMissing) delete services.systemPrompt;
  if (options.subagentsMissing) delete services.subagents;
  if (options.agentsMissing) delete services.agents;
  if (options.planModeMissing) delete services.planMode;
  if (options.selectionMissing) delete services.subagentModelSelection;
  // `llm.resolveModelInfo(provider, model)` — the image-capability probe used by the
  // vision report (dsh-llm `resolveModelInfo`; dsh-acp:84 does the same
  // `inputModalities?.includes('image')` check).
  if (options.llm !== undefined) services.llm = options.llm;
  if (options.selectionThrows) {
    services.subagentModelSelection = {
      current: () => { throw new Error('subagent model selection repeats route "pku-corpus/DUP"'); },
    };
  }

  const ctx = {
    logger: options.loggerThrows
      ? () => ({
          info: () => { throw new Error('logger.info boom'); },
          warn: () => { throw new Error('logger.warn boom'); },
          error: () => { throw new Error('logger.error boom'); },
        })
      : (name) => ({
          info: (...args) => state.logs.push(['info', name, ...args]),
          warn: (...args) => state.logs.push(['warn', name, ...args]),
          error: (...args) => state.logs.push(['error', name, ...args]),
        }),
    get: options.getThrows
      ? () => { throw new Error('service accessor boom'); }
      : (name) => services[name],
    on: options.onThrows
      ? () => { throw new Error('on boom'); }
      : (event, handler) => {
          const list = handlers.get(event) ?? [];
          list.push(handler);
          handlers.set(event, list);
        },
    inject: options.injectMissing
      ? undefined
      : (deps, callback) => {
          const scoped = Object.create(ctx);
          let ready = true;
          for (const dep of deps) {
            if (services[dep] === undefined) ready = false;
            scoped[dep] = services[dep];
          }
          if (ready) callback(scoped);
        },
    effect: options.effectMissing ? undefined : (fn) => fn(),
  };
  if (options.loggerMissing) delete ctx.logger;
  if (options.onMissing) delete ctx.on;

  async function request(agent, resolved) {
    const list = handlers.get('agent/request') ?? [];
    const payload = { turn: 1, step: 1, signal: undefined, agent };
    const run = (index) =>
      index >= list.length ? Promise.resolve(resolved) : list[index](payload, () => run(index + 1));
    const out = list.length === 0 ? resolved : await run(0);
    // The loop persists whatever the waterfall resolved as the request header.
    if (agent && out && typeof out === 'object' && out.provider !== undefined) {
      agent.__headerConfig = {
        provider: out.provider,
        model: out.model,
        ...(out.reasoningEffort === undefined ? {} : { reasoningEffort: out.reasoningEffort }),
      };
    }
    return out;
  }

  function emit(event, ...args) {
    for (const handler of handlers.get(event) ?? []) handler(...args);
  }

  return {
    world,
    ctx,
    services,
    handlers,
    tools,
    state,
    request,
    emit,
    tool: () => tools.find((tool) => tool.name === 'model_manager'),
  };
}

/** config helper: unconfigured roles are explicit empty, so tests never rely on defaults */
function cfg({ mode = 'hybrid', roles = {}, strategy = {} } = {}) {
  const base = {
    main: { models: [] },
    planning: { models: [] },
    execution: { models: [] },
    vision: { models: [] },
  };
  for (const key of Object.keys(roles)) base[key] = roles[key];
  return { roles: base, strategy: { mode, ...strategy } };
}

/** silence the console for hostile-context tests that fall back to console logging */

import { PLUGIN, CLIENT, dshFile } from './paths.mjs';

function quiet(fn) {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

// ===========================================================================
section('A. applyRoute unit behaviour (reasoningEffort on/inherited across a switch)');
// ===========================================================================
{
  const frozen = Object.freeze({ provider: 'pk', model: 'm1', reasoningEffort: 'high', maxTokens: 100 });
  const switched = applyRoute(frozen, { provider: 'pk', model: 'm2' });
  check('A1 route switch drops inherited effort', switched.reasoningEffort === undefined, switched.reasoningEffort, undefined);
  eq('A2 route switch keeps unrelated keys', switched.maxTokens, 100);
  routeEq('A3 route switch sets provider/model', switched, 'pk', 'm2');

  const matching = Object.freeze({ provider: 'pk', model: 'm1', reasoningEffort: 'high' });
  const kept = applyRoute(matching, { provider: 'pk', model: 'm1' });
  check('A4 matching route preserves inherited effort', kept.reasoningEffort === 'high', kept.reasoningEffort, 'high');
  check('A5 matching route + no role effort returns the same object (identity)', kept === matching, kept === matching, true);

  const applied = applyRoute({ provider: 'pk', model: 'm1', reasoningEffort: 'high', maxTokens: 7 }, { provider: 'pk', model: 'm2', reasoningEffort: 'low' });
  check('A6 role effort replaces inherited effort', applied.reasoningEffort === 'low', applied.reasoningEffort, 'low');
  eq('A7 same-route role effort keeps unrelated keys', applied.maxTokens, 7);

  const noInherited = applyRoute({ provider: 'pk', model: 'm1' }, { provider: 'pk', model: 'm2', reasoningEffort: 'low' });
  check('A8 role effort applied when nothing inherited', noInherited.reasoningEffort === 'low', noInherited.reasoningEffort, 'low');
  check('A9 applyRoute does not mutate its input', frozen.reasoningEffort === 'high', frozen.reasoningEffort, 'high');
}

// ===========================================================================
section('B. readConfig normalization and hostile configs');
// ===========================================================================
{
  const hostile = [
    ['undefined', undefined],
    ['null', null],
    ['number', 42],
    ['string', 'nope'],
    ['array', []],
    ['roles:string', { roles: 'not-an-object' }],
    ['roles:array', { roles: ['x'] }],
    ['roles:empty', { roles: {} }],
    ['role:null', { roles: { main: null } }],
    ['models:string', { roles: { vision: { models: 'x' } } }],
    ['models with junk', { roles: { vision: { models: [null, {}, 'x', 7, { provider: ' a ', model: ' b ' }] } } }],
    ['blank routes', { roles: { vision: { models: [{ provider: '', model: '' }, { provider: '   ', model: '  ' }] } } }],
    ['pick invalid', { roles: { execution: { pick: 'nonsense', models: [M('e')] } } }],
    ['strategy:null', { strategy: null }],
    ['strategy:string', { strategy: 'x' }],
    ['mode invalid', { strategy: { mode: 'nonsense' } }],
    ['historyLimit:-5', { strategy: { historyLimit: -5 } }],
    ['historyLimit:NaN', { strategy: { historyLimit: Number.NaN } }],
    ['historyLimit:0', { strategy: { historyLimit: 0 } }],
    ['historyLimit:0.5', { strategy: { historyLimit: 0.5 } }],
    ['historyLimit:string', { strategy: { historyLimit: '5' } }],
    ['keywords:string', { strategy: { visionKeywords: 'x' } }],
    ['keywords:[]', { strategy: { visionKeywords: [] } }],
    ['keywords padded', { strategy: { visionKeywords: ['  screenshot  '] } }],
    ['volatile get() throws', { roles: { main: { get() { throw new Error('volatile boom'); } } } }],
    ['volatile get() bad', { roles: { main: { get: () => 'garbage' } } }],
  ];

  for (const [name, raw] of hostile) {
    let read;
    let threw;
    try {
      read = readConfig(raw);
    } catch (error) {
      threw = error;
    }
    check(`B  readConfig never throws [${name}]`, threw === undefined, threw?.message, 'no throw');
    if (read === undefined) continue;
    check(`B  role keys total [${name}]`, JSON.stringify(Object.keys(read.roles).sort()) === JSON.stringify(['execution', 'main', 'planning', 'vision']), Object.keys(read.roles), ['execution', 'main', 'planning', 'vision']);
    const rolesOk = ['main', 'planning', 'execution', 'vision'].every((key) => {
      const role = read.roles[key];
      const pickOk = role.pick === 'first' || role.pick === 'round-robin';
      const modelsOk = Array.isArray(role.models) && role.models.every((route) => typeof route.provider === 'string' && route.provider.trim() !== '' && typeof route.model === 'string' && route.model.trim() !== '');
      return pickOk && modelsOk;
    });
    check(`B  role shape total [${name}]`, rolesOk, read.roles, 'valid picks + trimmed non-empty routes');
    check(`B  mode total [${name}]`, ['hybrid', 'managed', 'advisory'].includes(read.strategy.mode), read.strategy.mode, 'one of hybrid|managed|advisory');
    check(`B  keyword lists are arrays [${name}]`, Array.isArray(read.strategy.visionKeywords) && Array.isArray(read.strategy.planningKeywords), { v: read.strategy.visionKeywords, p: read.strategy.planningKeywords }, 'both arrays');
    check(`B  historyLimit is a usable positive integer [${name}]`, Number.isInteger(read.strategy.historyLimit) && read.strategy.historyLimit >= 1, read.strategy.historyLimit, 'integer >= 1');
  }

  const snapshot = { roles: { vision: { models: [M('v')] } }, strategy: { mode: 'managed' } };
  const before = JSON.stringify(snapshot);
  readConfig(snapshot);
  check('B  readConfig does not mutate its input', JSON.stringify(snapshot) === before, JSON.stringify(snapshot), before);

  // volatile refs: whole-roles and per-role refs must be unwrapped
  const wholeRef = readConfig({ roles: { get: () => ({ vision: { models: [M('v')] } }) } });
  eq('B  a volatile ref wrapping `roles` is unwrapped', wholeRef.roles.vision.models, [{ provider: PK, model: 'v' }]);
  const roleRef = readConfig({ roles: { vision: { get: () => ({ models: [M('v2')] }) } } });
  eq('B  a volatile ref wrapping one role is unwrapped', roleRef.roles.vision.models, [{ provider: PK, model: 'v2' }]);
  const badRef = readConfig({ strategy: { get: () => { throw new Error('boom'); } } });
  eq('B  a throwing volatile ref falls back to defaults', badRef.strategy.mode, 'hybrid');

  const trimmed = readConfig({ roles: { vision: { models: [{ provider: ' p ', model: ' m ', reasoningEffort: ' ' }] } } });
  eq('B  routes are trimmed and blank effort dropped', trimmed.roles.vision.models, [{ provider: 'p', model: 'm' }]);

  eq('B  unknown strategy mode normalizes to hybrid', readConfig({ strategy: { mode: 'wat' } }).strategy.mode, 'hybrid');
  eq('B  historyLimit 0 normalizes to 300', readConfig({ strategy: { historyLimit: 0 } }).strategy.historyLimit, 300);
  eq('B  historyLimit 0.5 floors to the usable limit 1, not 0', readConfig({ strategy: { historyLimit: 0.5 } }).strategy.historyLimit, 1);
  eq('B  historyLimit 1 stays 1', readConfig({ strategy: { historyLimit: 1 } }).strategy.historyLimit, 1);
  eq('B  historyLimit 7.9 floors to 7', readConfig({ strategy: { historyLimit: 7.9 } }).strategy.historyLimit, 7);

  // -- empty vs absent keyword lists (D4 regression: these must not be conflated)
  eq('B  absent visionKeywords takes the built-in defaults', readConfig({ strategy: {} }).strategy.visionKeywords.length, DEFAULT_VISION_KEYWORDS.length);
  eq('B  absent planningKeywords takes the built-in defaults', readConfig({ strategy: {} }).strategy.planningKeywords.length, DEFAULT_PLANNING_KEYWORDS.length);
  eq('B  an explicit empty visionKeywords list is honoured', readConfig({ strategy: { visionKeywords: [] } }).strategy.visionKeywords, []);
  eq('B  an explicit empty planningKeywords list is honoured', readConfig({ strategy: { planningKeywords: [] } }).strategy.planningKeywords, []);
  eq('B  a non-array visionKeywords still falls back to defaults', readConfig({ strategy: { visionKeywords: 'x' } }).strategy.visionKeywords.length, DEFAULT_VISION_KEYWORDS.length);
  eq('B  a non-array planningKeywords still falls back to defaults', readConfig({ strategy: { planningKeywords: 5 } }).strategy.planningKeywords.length, DEFAULT_PLANNING_KEYWORDS.length);
  eq('B  keywords are trimmed (D3)', readConfig({ strategy: { visionKeywords: ['  screenshot  ', '   ', 7] } }).strategy.visionKeywords, ['screenshot']);
  eq('B  only an empty array disables a classifier', readConfig({ strategy: { visionKeywords: ['  '] } }).strategy.visionKeywords, []);

  // -- unknown-key warnings
  const warnings = readConfig({
    bogus: 1,
    roles: { main: { models: [], typo: 2 }, nope: {} },
    strategy: { mode: 'hybrid', bogus2: 3 },
  }).warnings;
  check('B  unknown top-level config key warns', warnings.some((line) => line.includes('unknown config key "bogus"')), warnings, 'warning naming "bogus"');
  check('B  unknown role-level key warns', warnings.some((line) => line.includes('unknown key "roles.main.typo"')), warnings, 'warning naming roles.main.typo');
  check('B  unknown strategy-level key warns', warnings.some((line) => line.includes('unknown key "strategy.bogus2"')), warnings, 'warning naming strategy.bogus2');
  check('B  unknown role name warns', warnings.some((line) => line.includes('unknown role "nope"')), warnings, 'warning naming the unknown role');
  eq('B  a valid config produces no warnings', readConfig({ roles: { main: { models: [M('m')], pick: 'first', note: 'n' } }, strategy: { mode: 'managed', historyLimit: 5, visionKeywords: ['a'], planningKeywords: ['b'] } }).warnings, []);
  eq('B  a schema-validated config produces no warnings', readConfig(new plugin.Config({ roles: { vision: { models: [M('v')] } }, strategy: { mode: 'managed' } })).warnings, []);
  const hWarn = makeCtx();
  apply(hWarn.ctx, { bogus: 1, roles: {}, strategy: {} });
  check('B  apply surfaces config warnings through the logger', hWarn.state.logs.some((entry) => entry[0] === 'warn' && String(entry[2]).includes('unknown config key "bogus"')), hWarn.state.logs, 'warn log naming "bogus"');
  // -- unknown keys INSIDE a route object (D-follow-up: previously silent)
  const routeTypo = readConfig({ roles: { main: { models: [{ provider: 'a', model: 'b', reasoning_effort: 'high' }] } } });
  eq('B  a route-level `reasoning_effort` typo produces exactly one warning', routeTypo.warnings.length, 1);
  check('B  the route-typo warning names both spellings', routeTypo.warnings[0].includes('reasoning_effort') && routeTypo.warnings[0].includes('reasoningEffort'), routeTypo.warnings[0], 'warning mentioning reasoning_effort -> reasoningEffort');
  check('B  the route-typo warning is scoped to the role and index', routeTypo.warnings[0].includes('roles.main.models[]'), routeTypo.warnings[0], 'warning naming roles.main.models[]');
  eq('B  a correctly spelled route produces no warning', readConfig({ roles: { main: { models: [{ provider: 'a', model: 'b', reasoningEffort: 'high' }] } } }).warnings, []);
  eq('B  the same effort spelling fix holds on a schema-validated config', readConfig(new plugin.Config({ roles: { main: { models: [{ provider: 'a', model: 'b', reasoning_effort: 'high' }] } } })).warnings.length, 1);
  check('B  other unknown route keys warn without the effort hint', readConfig({ roles: { planning: { models: [{ provider: 'a', model: 'b', effort: 'high' }] } } }).warnings[0] === 'unknown key "roles.planning.models[].effort" ignored', readConfig({ roles: { planning: { models: [{ provider: 'a', model: 'b', effort: 'high' }] } } }).warnings, 'generic unknown-key warning');
  eq('B  two bad routes produce two warnings', readConfig({ roles: { main: { models: [{ provider: 'a', model: 'b', reasoning_effort: 'x' }, { provider: 'c', model: 'd', foo: 1 }] } } }).warnings.length, 2);
  check('B  a dropped route still reports its typo', readConfig({ roles: { main: { models: [{ provider: '', model: '', reasoning_effort: 'x' }] } } }).warnings.some((line) => line.includes('reasoning_effort')), readConfig({ roles: { main: { models: [{ provider: '', model: '', reasoning_effort: 'x' }] } } }).warnings, 'warning despite the route being dropped');
  const hRouteWarn = makeCtx();
  apply(hRouteWarn.ctx, { roles: { main: { models: [{ provider: 'a', model: 'b', reasoning_effort: 'high' }] } }, strategy: {} });
  check('B  apply logs the route-level typo warning', hRouteWarn.state.logs.some((entry) => entry[0] === 'warn' && String(entry[2]).includes('reasoning_effort')), hRouteWarn.state.logs.map((entry) => entry[2]), 'warn log naming reasoning_effort');

  // hostile configs must not break apply()
  for (const [name, raw] of hostile) {
    const h = makeCtx();
    let threw;
    quiet(() => {
      try {
        apply(h.ctx, raw);
      } catch (error) {
        threw = error;
      }
    });
    check(`B  apply never throws [${name}]`, threw === undefined, threw?.message, 'no throw');
  }

  // and routing still works after a hostile config was applied to the same ctx
  const h = makeCtx();
  apply(h.ctx, { roles: 'garbage', strategy: { mode: 'nonsense', historyLimit: -1 } });
  const parent = addParent(h.world, 'hostile-parent', M('default'));
  const out = await h.request(parent, M('default'));
  routeEq('B  hostile config still yields a working pass-through pipeline', out, PK, 'default');
}

// ===========================================================================
section('C. routing: round-robin, first, effort, main, plan mode, vision fallback');
// ===========================================================================
{
  // -- round-robin -----------------------------------------------------------
  const h = makeCtx();
  apply(h.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('E1'), M('E2'), M('E3')], pick: 'round-robin' } } }));
  const parent = addParent(h.world, 'p-rr', M('default'));
  const child = addChild(h.world, parent, 'c-rr', 'fix the typo', M('default'));
  const cycle = [];
  for (let i = 0; i < 7; i += 1) cycle.push((await h.request(child, M('default'))).model);
  eq('C1 round-robin cycles 1,2,3,1,2,3,1', cycle, ['E1', 'E2', 'E3', 'E1', 'E2', 'E3', 'E1']);

  const hf = makeCtx();
  apply(hf.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('F1'), M('F2'), M('F3')], pick: 'first' } } }));
  const p2 = addParent(hf.world, 'p-first', M('default'));
  const c2 = addChild(hf.world, p2, 'c-first', 'fix the typo', M('default'));
  const firsts = [];
  for (let i = 0; i < 4; i += 1) firsts.push((await hf.request(c2, M('default'))).model);
  eq('C2 first does not advance', firsts, ['F1', 'F1', 'F1', 'F1']);

  // -- independent counters per role ----------------------------------------
  const hi = makeCtx();
  apply(hi.ctx, cfg({ mode: 'managed', roles: { main: { models: [M('M1'), M('M2')], pick: 'round-robin' }, execution: { models: [M('X1'), M('X2')], pick: 'round-robin' } } }));
  const p3 = addParent(hi.world, 'p-ind', M('default'));
  const c3 = addChild(hi.world, p3, 'c-ind', 'fix the typo', M('default'));
  const seq = [];
  for (let i = 0; i < 3; i += 1) {
    seq.push((await hi.request(p3, M('default'))).model);
    seq.push((await hi.request(c3, M('default'))).model);
  }
  eq('C3 main and execution round-robin counters are independent', seq, ['M1', 'X1', 'M2', 'X2', 'M1', 'X1']);

  // -- reasoningEffort through the waterfall --------------------------------
  const he = makeCtx();
  apply(he.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('E')] } } }));
  const pe = addParent(he.world, 'p-eff', M('default'));
  const ce = addChild(he.world, pe, 'c-eff', 'fix the typo', M('default'));
  const kept = await he.request(ce, { ...M('E', { reasoningEffort: 'high', maxTokens: 99 }) });
  check('C4 matching route preserves inherited effort', kept.reasoningEffort === 'high', kept.reasoningEffort, 'high');
  const dropped = await he.request(ce, { ...M('other', { reasoningEffort: 'high', maxTokens: 99 }) });
  check('C5 route switch drops inherited effort', dropped.reasoningEffort === undefined, dropped.reasoningEffort, undefined);
  eq('C6 route switch keeps maxTokens', dropped.maxTokens, 99);

  const he2 = makeCtx();
  apply(he2.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('E', { reasoningEffort: 'low' })] } } }));
  const pe2 = addParent(he2.world, 'p-eff2', M('default'));
  const ce2 = addChild(he2.world, pe2, 'c-eff2', 'fix the typo', M('default'));
  const applied = await he2.request(ce2, M('other'));
  check('C7 role effort is applied on a route switch', applied.reasoningEffort === 'low', applied.reasoningEffort, 'low');
  const appliedSame = await he2.request(ce2, { ...M('E', { reasoningEffort: 'high', maxTokens: 5 }) });
  check('C8 role effort overrides an inherited effort on a matching route', appliedSame.reasoningEffort === 'low', appliedSame.reasoningEffort, 'low');
  eq('C9 matching-route rewrite keeps unrelated keys', appliedSame.maxTokens, 5);

  // -- main role / plan mode ------------------------------------------------
  const hm = makeCtx();
  apply(hm.ctx, cfg({ mode: 'hybrid', roles: { main: { models: [M('MAIN')] }, planning: { models: [M('PLAN')] } } }));
  const pm = addParent(hm.world, 'p-main', M('default'));
  const top = await hm.request(pm, M('default'));
  routeEq('C10 configured main rewrites a top-level request', top, PK, 'MAIN');

  const hu = makeCtx();
  apply(hu.ctx, cfg({ mode: 'hybrid', roles: { planning: { models: [M('PLAN')] } } }));
  const pu = addParent(hu.world, 'p-unconf', M('default'));
  const passthrough = { ...M('default') };
  const outU = await hu.request(pu, passthrough);
  routeEq('C11 unconfigured role passes the resolved route through', outU, PK, 'default');
  check('C12 unconfigured role returns the identical object', outU === passthrough, outU === passthrough, true);

  pu.__plan = true;
  routeEq('C13 plan mode active routes to planning', await hu.request(pu, M('default')), PK, 'PLAN');

  const hp = makeCtx();
  apply(hp.ctx, cfg({ mode: 'hybrid', roles: { main: { models: [M('MAIN')] }, planning: { models: [M('PLAN')] } } }));
  const pp = addParent(hp.world, 'p-pending', M('default'));
  pp.__plan = true;
  hp.world.onPlanMode = (agent) => (agent.__plan ? { active: false, pending: true } : { active: false });
  routeEq('C14 pending plan selection routes to planning', await hp.request(pp, M('default')), PK, 'PLAN');

  // Faithful DSH shapes from PlanModeController.get(): {active} or {active, pending}
  // where `pending` is the queued selection (dsh-plan-mode/lib/index.js:339-345).
  hp.world.onPlanMode = () => ({ active: false, pending: true });
  routeEq('C14b queued "enter plan mode" selection routes to planning', await hp.request(pp, M('default')), PK, 'PLAN');
  hp.world.onPlanMode = () => ({ active: true, pending: false });
  const leaveWindow = await hp.request(pp, M('default'));
  routeEq('C14c queued "leave plan mode" selection routes to main (pending wins)', leaveWindow, PK, 'MAIN');

  // planMode.get() throws -> projection fallback
  const hpp = makeCtx({ world: makeWorld() });
  apply(hpp.ctx, cfg({ mode: 'hybrid', roles: { planning: { models: [M('PLAN')] }, main: { models: [M('MAIN')] } } }));
  const ppp = addParent(hpp.world, 'p-proj', M('default'));
  const projections = { stateOf: () => ({ active: true }) };
  hpp.world.onPlanMode = () => { throw new Error('planMode boom'); };
  hpp.ctx.get = (name) => (name === 'sessionProjections' ? projections : hpp.services[name]);
  routeEq('C15 planMode throwing falls back to the session projection', await hpp.request(ppp, M('default')), PK, 'PLAN');

  // -- vision fallback ------------------------------------------------------
  const hv = makeCtx();
  apply(hv.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const pv = addParent(hv.world, 'p-vis', M('default'));
  const cv = addChild(hv.world, pv, 'c-vis', 'look at this screenshot', M('default'));
  routeEq('C16 empty vision falls back to the execution route', await hv.request(cv, M('default')), PK, 'EXEC');

  const hvv = makeCtx();
  apply(hvv.ctx, cfg({ mode: 'managed', roles: {} }));
  const pvv = addParent(hvv.world, 'p-vis2', M('default'));
  const cvv = addChild(hvv.world, pvv, 'c-vis2', 'look at this screenshot', M('default'));
  const both = { ...M('default') };
  const outVV = await hvv.request(cvv, both);
  check('C17 vision AND execution empty -> no rewrite (identity)', outVV === both, outVV === both, true);

  const hvr = makeCtx();
  apply(hvr.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('X1'), M('X2')], pick: 'round-robin' } } }));
  const pvr = addParent(hvr.world, 'p-vis3', M('default'));
  const cvr = addChild(hvr.world, pvr, 'c-vis3', 'screenshot', M('default'));
  const visionCycle = [];
  for (let i = 0; i < 3; i += 1) visionCycle.push((await hvr.request(cvr, M('default'))).model);
  eq('C18 vision fallback honours execution pick=round-robin', visionCycle, ['X1', 'X2', 'X1']);
}

// ===========================================================================
section('D. strategy mode semantics (managed / hybrid / advisory)');
// ===========================================================================
{
  const PARENT_ROUTE = M('parent-route');
  const EXPLICIT = M('explicit-child');

  for (const mode of ['managed', 'hybrid', 'advisory']) {
    const h = makeCtx();
    apply(h.ctx, cfg({ mode, roles: { execution: { models: [M('EXEC-ROLE')] } } }));
    const parent = addParent(h.world, `p-${mode}`, PARENT_ROUTE);
    // a) child whose resolved route still equals the parent's creation route -> inherited
    const inheritedChild = addChild(h.world, parent, `c-${mode}-inh`, 'fix the typo', { ...PARENT_ROUTE });
    const inheritedResolved = { ...PARENT_ROUTE };
    const inheritedOut = await h.request(inheritedChild, inheritedResolved);
    // b) child that explicitly named its own route
    const explicitChild = addChild(h.world, parent, `c-${mode}-exp`, 'fix the typo', { ...EXPLICIT });
    const explicitResolved = { ...EXPLICIT };
    const explicitOut = await h.request(explicitChild, explicitResolved);

    if (mode === 'managed') {
      routeEq('D1 managed always rewrites the inherited child', inheritedOut, PK, 'EXEC-ROLE');
      routeEq('D2 managed always rewrites the explicit child', explicitOut, PK, 'EXEC-ROLE');
    } else if (mode === 'hybrid') {
      routeEq('D3 hybrid rewrites an inherited child', inheritedOut, PK, 'EXEC-ROLE');
      routeEq('D4 hybrid respects an explicit child route', explicitOut, PK, 'explicit-child');
      check('D5 hybrid explicit respect returns the identical object', explicitOut === explicitResolved, explicitOut === explicitResolved, true);
    } else {
      routeEq('D6 advisory never rewrites the inherited child', inheritedOut, PK, 'parent-route');
      routeEq('D7 advisory never rewrites the explicit child', explicitOut, PK, 'explicit-child');
      check('D8 advisory returns the identical object', inheritedOut === inheritedResolved, inheritedOut === inheritedResolved, true);
    }

    // recorded either way
    const report = await h.tool().execute({ action: 'report' });
    check(`D9 ${mode} report lists the routed child`, report.includes(`c-${mode}-inh`.slice(0, 8)), report.split('\n')[0], 'row for the child');
    const expectedReason = mode === 'managed' ? 'applied' : mode === 'advisory' ? 'advisory (not applied)' : 'applied';
    check(`D10 ${mode} report reason for the inherited child`, report.includes(expectedReason), report.split('\n').find((line) => line.includes(`c-${mode}-inh`.slice(0, 8))) ?? '(no row)', expectedReason);
  }

  // advisory must still record even when nothing is applied, and usage must count it
  const hAdv = makeCtx();
  apply(hAdv.ctx, cfg({ mode: 'advisory', roles: { execution: { models: [M('EXEC-ROLE')] } } }));
  const pAdv = addParent(hAdv.world, 'p-adv', PARENT_ROUTE);
  const cAdv = addChild(hAdv.world, pAdv, 'c-adv', 'fix the typo', { ...PARENT_ROUTE });
  await hAdv.request(cAdv, { ...PARENT_ROUTE });
  const usage = await hAdv.tool().execute({ action: 'usage' });
  check('D11 advisory records usage', /execution/.test(usage) && /parent-route/.test(usage), usage, 'execution ... parent-route');
}

// ===========================================================================
section('E. label classification precedence and hostile labels');
// ===========================================================================
{
  const h = makeCtx();
  apply(h.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, planning: { models: [M('PLAN')] }, execution: { models: [M('EXEC')] } } }));
  const parent = addParent(h.world, 'p-cls', M('default'));

  const cases = [
    ['E1 both vision+planning keywords -> vision', 'analyze this screenshot of the design', 'VIS'],
    ['E2 case-insensitive vision', 'SCREENSHOT OF THE UI', 'VIS'],
    ['E3 case-insensitive planning', 'PlAn ThE dEsIgN', 'PLAN'],
    ['E4 punctuation + vision keyword', 'vision: read ./a.png!', 'VIS'],
    ['E5 very long vision label', `${'x'.repeat(4000)} screenshot ${'y'.repeat(4000)}`, 'VIS'],
    ['E6 very long neutral label', 'z'.repeat(8000), 'EXEC'],
    ['E7 empty label', '', 'EXEC'],
    ['E8 whitespace-only label', '   ', 'EXEC'],
    ['E9 punctuation-only label', '!!--..;;', 'EXEC'],
    ['E10 undefined label (absent from catalog)', undefined, 'EXEC'],
    ['E11 non-string label', 12345, 'EXEC'],
    ['E12 planning keyword wins over nothing', 'root cause analysis of the crash', 'PLAN'],
    ['E13 plain work -> execution', 'fix the typo in README', 'EXEC'],
  ];
  let index = 0;
  for (const [label, text, want] of cases) {
    index += 1;
    const child = addChild(h.world, parent, `e${String(index).padStart(2, '0')}child`, text, M('default'));
    const out = await h.request(child, M('default'));
    routeEq(`E  ${label}`, out, PK, want);
  }

  // unknown child (no catalog row anywhere)
  const orphan = { id: 'orphan-unknown', options: M('default'), session: { header: { origin: 'subagent' } }, status: 'running' };
  routeEq('E14 subagent with no catalog row falls back to execution', await h.request(orphan, M('default')), PK, 'EXEC');

  // leading word-boundary anchoring: `spec` must not match `inspect`
  const hSpec = makeCtx();
  apply(hSpec.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, planning: { models: [M('PLAN')] }, execution: { models: [M('EXEC')] } } }));
  const pSpec = addParent(hSpec.world, 'p-spec', M('default'));
  const anchored = [
    ['E15 "spec" must not match inside "inspect"', 'inspect the failing test', 'EXEC'],
    ['E15b "spec" still matches at a word start', 'specification of the api', 'PLAN'],
    ['E15c vision keyword matches a plural ("screenshots")', 'compare these screenshots', 'VIS'],
    ['E15d multi-word keyword matches ("ui mock")', 'draw a ui mock for the page', 'VIS'],
    ['E15e "render" matches inside a hyphenated word', 're-render the chart', 'VIS'],
    ['E15f leading anchor still allows suffixes ("planning")', 'planning the migration', 'PLAN'],
  ];
  let anchoredIndex = 0;
  for (const [label, text, want] of anchored) {
    anchoredIndex += 1;
    const child = addChild(hSpec.world, pSpec, `anch${String(anchoredIndex).padStart(4, '0')}`, text, M('default'));
    routeEq(`E  ${label}`, await hSpec.request(child, M('default')), PK, want);
  }

  // -- custom keyword lists -------------------------------------------------
  const hkw = makeCtx();
  apply(hkw.ctx, cfg({ mode: 'managed', strategy: { visionKeywords: [' screenshot '] }, roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const pkw = addParent(hkw.world, 'p-kw', M('default'));
  const ckw = addChild(hkw.world, pkw, 'kw000001-child', 'take a screenshot', M('default'));
  routeEq('E16 whitespace-padded custom keyword still matches', await hkw.request(ckw, M('default')), PK, 'VIS');

  const hkw2 = makeCtx();
  apply(hkw2.ctx, cfg({ mode: 'managed', strategy: { visionKeywords: [] }, roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const pkw2 = addParent(hkw2.world, 'p-kw2', M('default'));
  const ckw2 = addChild(hkw2.world, pkw2, 'kw000002-child', 'screenshot of the UI', M('default'));
  routeEq('E17 explicit empty visionKeywords disables vision classification', await hkw2.request(ckw2, M('default')), PK, 'EXEC');
}

// ===========================================================================
section('F. tools: report / routes / usage / allow-list');
// ===========================================================================
{
  // -- zero subagents --------------------------------------------------------
  const h0 = makeCtx();
  apply(h0.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('EXEC')] } } }));
  const tool0 = h0.tool();
  check('F1 model_manager tool is registered', tool0 !== undefined, h0.tools.map((t) => t.name), ['model_manager']);
  check('F2 systemPrompt section is registered', h0.state.section !== undefined && h0.state.section.name === 'model-manager', h0.state.section?.name, 'model-manager');
  const emptyReport = await tool0.execute({ action: 'report' });
  check('F3 report with zero subagents is the empty-state message', emptyReport.startsWith('No subagents observed yet'), emptyReport.slice(0, 60), 'No subagents observed yet…');
  const emptyUsage = await tool0.execute({ action: 'usage' });
  check('F4 usage before anything is routed', emptyUsage.startsWith('No model usage recorded yet'), emptyUsage.slice(0, 60), 'No model usage recorded yet…');
  const routesOut = await tool0.execute({ action: 'routes' });
  check('F5 routes lists all four roles', ['main', 'planning', 'execution', 'vision'].every((key) => routesOut.includes(key)), routesOut.split('\n').slice(0, 6), 'all four role names');
  check('F6 routes names the active mode', routesOut.includes('hybrid'), routesOut.split('\n').find((line) => line.startsWith('Strategy mode')), 'Strategy mode: hybrid…');
  check('F7 unknown action falls back to report', (await tool0.execute({ action: 'bogus' })).startsWith('No subagents observed yet'), 'unknown action output', 'report output');
  check('F8 missing args default to report', (await tool0.execute()).startsWith('No subagents observed yet'), 'no-arg output', 'report output');

  // -- routed child ----------------------------------------------------------
  const h1 = makeCtx();
  apply(h1.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] } } }));
  const p1 = addParent(h1.world, 'p-f1', M('default'));
  const c1 = addChild(h1.world, p1, 'f1000001-aaaa', 'read the screenshot', M('default'));
  await h1.request(c1, M('default'));
  const report1 = await h1.tool().execute({ action: 'report' });
  check('F9 report row shows the child, role, model, reason and label', report1.includes('f1000001') && report1.includes('vision') && report1.includes('VIS') && report1.includes('applied') && report1.includes('read the screenshot'), report1, 'row with child/role/model/reason/label');
  check('F10 report totals use the request/subagent format', /Subagent requests by role\/model:/.test(report1) && /\d+ req \/ +\d+ subagent\(s\) +vision +pku-corpus\/VIS/.test(report1), report1.split('\n').slice(-4), '"1 req /  1 subagent(s)  vision  pku-corpus/VIS"');

  // -- routed but absent from the catalog ------------------------------------
  const h2 = makeCtx();
  apply(h2.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const orphan = { id: 'f2000002-orphan', options: M('default'), session: { header: { origin: 'subagent' } }, status: 'running' };
  h2.world.agents.push(orphan); // live agent, but no catalog row and no owner
  await h2.request(orphan, M('default'));
  const report2 = await h2.tool().execute({ action: 'report' });
  check('F11 report includes a routed subagent absent from the catalog', report2.includes('f2000002'), report2, 'row for f2000002');
  check('F12 report labels the absent child "(unlabelled)"', report2.includes('(unlabelled)'), report2.split('\n').find((line) => line.includes('f2000002')), '(unlabelled)');

  // -- usage counts requests AND subagents (D5) ------------------------------
  const h3 = makeCtx();
  apply(h3.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const p3 = addParent(h3.world, 'p-f3', M('default'));
  const c3 = addChild(h3.world, p3, 'f3000003-child', 'fix the typo', M('default'));
  for (let i = 0; i < 3; i += 1) await h3.request(c3, M('default'));
  const usage3 = await h3.tool().execute({ action: 'usage' });
  const countLine3 = usage3.split('\n').find((line) => line.includes('execution'));
  check('F13 usage counts each request of one child (3 req)', /^\s*3 req\b/.test(countLine3 ?? ''), countLine3 ?? usage3, 'row starting "3 req"');
  check('F13b usage also counts the subagent exactly once (1 subagent)', /3 req\s+1 subagent\(s\)/.test(countLine3 ?? ''), countLine3 ?? usage3, '3 req  1 subagent(s)  execution …');
  check('F13c usage header mentions the whole process', usage3.startsWith('Requests by role/model (whole process, including top-level turns)'), usage3.split('\n')[0], 'the documented header');

  // top-level turns are counted with 0 subagents
  const hTop = makeCtx();
  apply(hTop.ctx, cfg({ mode: 'managed', roles: { main: { models: [M('MAIN')] }, execution: { models: [M('EXEC')] } } }));
  const pTop = addParent(hTop.world, 'p-top', M('default'));
  await hTop.request(pTop, M('default'));
  await hTop.request(pTop, M('default'));
  const cTop = addChild(hTop.world, pTop, 'top00001-child', 'fix the typo', M('default'));
  await hTop.request(cTop, M('default'));
  const usageTop = await hTop.tool().execute({ action: 'usage' });
  const mainRow = usageTop.split('\n').find((line) => line.includes('main  '));
  check('F13d top-level turns appear with 0 subagents', /2 req\s+0 subagent\(s\)/.test(mainRow ?? ''), mainRow ?? usageTop, '2 req  0 subagent(s)  main …');

  // -- allow-list reporting --------------------------------------------------
  const allowedWorld = makeWorld({ allowList: { enabled: true, allowedModels: [{ provider: PK, model: 'EXEC' }] } });
  const ha = makeCtx({ world: allowedWorld });
  apply(ha.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] }, vision: { models: [M('VIS-BLOCKED')] } } }));
  const routesA = await ha.tool().execute({ action: 'routes' });
  check('F14 routes flags a role route missing from the allow-list', routesA.includes('BLOCKED') && routesA.includes('VIS-BLOCKED'), routesA.split('\n').filter((line) => line.includes('BLOCKED')), 'BLOCKED row for vision');
  check('F15 routes prints the exact yaml snippet for the missing route', routesA.includes(`provider: ${PK}`) && routesA.includes('model: VIS-BLOCKED'), routesA.split('\n').slice(-8), 'yaml snippet');

  const disabledWorld = makeWorld({ allowList: { enabled: false, allowedModels: [] } });
  const hd = makeCtx({ world: disabledWorld });
  apply(hd.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  check('F16 routes reports a disabled allow-list', (await hd.tool().execute({ action: 'routes' })).includes('DISABLED'), 'allow-list block', 'DISABLED message');

  const hm = makeCtx({ selectionMissing: true });
  apply(hm.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  check('F17 routes reports an unavailable allow-list service', (await hm.tool().execute({ action: 'routes' })).includes('unavailable'), 'allow-list block', 'unavailable message');

  // -- historyLimit eviction -------------------------------------------------
  const h4 = makeCtx();
  apply(h4.ctx, cfg({ mode: 'managed', strategy: { historyLimit: 2 }, roles: { execution: { models: [M('EXEC')] } } }));
  const p4 = addParent(h4.world, 'p-f4', M('default'));
  for (let i = 0; i < 4; i += 1) {
    const child = addChild(h4.world, p4, `f4child${i}00`, 'fix the typo', M('default'));
    await h4.request(child, M('default'));
  }
  const usage4 = await h4.tool().execute({ action: 'usage' });
  const rows4 = usage4.split('\n').filter((line) => line.includes('subagent(s)')).length;
  check('F18 historyLimit bounds the usage map', rows4 <= 2, `${rows4} role/model row(s)`, 'at most 2');

  // historyLimit 0.5 -> limit 1: usage must still be retained (D2)
  const hHalf = makeCtx();
  apply(hHalf.ctx, cfg({ mode: 'managed', strategy: { historyLimit: 0.5 }, roles: { execution: { models: [M('EXEC')] } } }));
  const pHalf = addParent(hHalf.world, 'p-half', M('default'));
  for (let i = 0; i < 3; i += 1) {
    const child = addChild(hHalf.world, pHalf, `halfchild${i}`, 'fix the typo', M('default'));
    await hHalf.request(child, M('default'));
  }
  const usageHalf = await hHalf.tool().execute({ action: 'usage' });
  check('F18b historyLimit 0.5 still retains usage (limit floors to 1, not 0)', /1 req\s+1 subagent\(s\)/.test(usageHalf), usageHalf, '1 req  1 subagent(s) row');

  // LRU eviction: touching a session re-inserts it, so a recently used child survives
  const hLru = makeCtx();
  apply(hLru.ctx, cfg({ mode: 'managed', strategy: { historyLimit: 2 }, roles: { execution: { models: [M('EXEC')] } } }));
  const pLru = addParent(hLru.world, 'p-lru', M('default'));
  const aLru = addChild(hLru.world, pLru, 'lru00000a-child', 'fix the typo', M('default'));
  const bLru = addChild(hLru.world, pLru, 'lru00000b-child', 'fix the typo', M('default'));
  const cLru = addChild(hLru.world, pLru, 'lru00000c-child', 'fix the typo', M('default'));
  await hLru.request(aLru, M('default'));
  await hLru.request(bLru, M('default'));
  await hLru.request(aLru, M('default')); // touch a: LRU order becomes b, a
  await hLru.request(cLru, M('default')); // evicts b
  const reportLru = await hLru.tool().execute({ action: 'report' });
  const rowA = reportLru.split('\n').find((line) => line.includes('lru00000a')) ?? '';
  const rowB = reportLru.split('\n').find((line) => line.includes('lru00000b')) ?? '';
  const rowC = reportLru.split('\n').find((line) => line.includes('lru00000c')) ?? '';
  check('F20 LRU keeps the touched child', rowA.includes('pku-corpus/EXEC'), rowA, 'routed model for the touched child');
  check('F20b LRU evicts the least-recently-used child', rowB.includes('(not yet routed)'), rowB, '(not yet routed) for the evicted child');
  check('F20c LRU keeps the newest child', rowC.includes('pku-corpus/EXEC'), rowC, 'routed model for the newest child');

  // -- report status column --------------------------------------------------
  const hStat = makeCtx();
  apply(hStat.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const pStat = addParent(hStat.world, 'p-stat', M('default'));
  const cStat = addChild(hStat.world, pStat, 'stat0001-child', 'fix the typo', M('default'));
  await hStat.request(cStat, M('default'));
  const reportLive = await hStat.tool().execute({ action: 'report' });
  check('F21 report has a status column header', /status\s+label/.test(reportLive.split('\n')[2] ?? ''), reportLive.split('\n')[2], 'header with status before label');
  check('F21b a live child shows status "running"', /stat0001-c\s+execution\s+\S+\s+applied\s+running/.test(reportLive.split('\n').find((line) => line.includes('stat0001')) ?? ''), reportLive.split('\n').find((line) => line.includes('stat0001')), 'row with status running');
  hStat.world.agents = hStat.world.agents.filter((agent) => agent.id !== 'stat0001-child');
  const reportGone = await hStat.tool().execute({ action: 'report' });
  check('F21c a child whose agent is gone shows status "inactive"', /inactive/.test(reportGone.split('\n').find((line) => line.includes('stat0001')) ?? ''), reportGone.split('\n').find((line) => line.includes('stat0001')), 'row with status inactive');

  // -- routes note + vision fallback marker ---------------------------------
  const hNote = makeCtx();
  apply(hNote.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')], note: 'the workhorse' }, vision: { models: [] } } }));
  const routesNote = await hNote.tool().execute({ action: 'routes' });
  check('F22 routes prints a note for a role', routesNote.includes('note: the workhorse'), routesNote.split('\n').filter((line) => line.includes('note:')), 'note line');
  check('F22b routes marks the vision->execution fallback', routesNote.includes('(via execution)'), routesNote.split('\n').find((line) => line.startsWith('vision')), 'vision row with (via execution)');
  check('F22c routes shows the vision row using the execution model', /vision\s+first\s+pku-corpus\/EXEC\s+\(via execution\)/.test(routesNote), routesNote.split('\n').find((line) => line.startsWith('vision')), 'vision  first  pku-corpus/EXEC  (via execution)');

  // -- D6 regression: the shared vision->execution fallback must be counted once,
  //    because the harness REJECTS a repeated `allowedModels` entry.
  const dupWorld = makeWorld({ allowList: { enabled: true, allowedModels: [M('UNRELATED')] } });
  const hDup = makeCtx({ world: dupWorld });
  apply(hDup.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const routesDup = await hDup.tool().execute({ action: 'routes' });
  // Parse the paste-ready snippet the plugin tells the user to apply.
  const pairRe = /^\s*-\s+provider:\s*(\S+)\s*\n\s+model:\s*(\S+)\s*$/gm;
  const parseSnippet = (text) => {
    const parsed = [];
    for (const match of text.matchAll(pairRe)) parsed.push({ provider: match[1], model: match[2] });
    return parsed;
  };
  const dupSnippet = parseSnippet(routesDup);
  eq('F23 the snippet lists the shared fallback route exactly once', dupSnippet.length, 1);
  eq('F23d the single snippet entry is the execution route', dupSnippet[0], { provider: PK, model: 'EXEC' });
  eq('F23e the provider line appears once (counted, not substring)', (routesDup.match(/^\s+- provider: pku-corpus$/gm) ?? []).length, 1);
  eq('F23f the model line appears once (counted, not substring)', (routesDup.match(/^\s+model: EXEC$/gm) ?? []).length, 1);
  check('F23b the missing-route count counts distinct routes', /^1 role route\(s\) are not in the subagent allow-list\.$/m.test(routesDup), routesDup.split('\n').find((line) => line.includes('role route(s)')) ?? '(no count line)', '1 role route(s) are not in the subagent allow-list.');
  eq('F23g the per-role BLOCKED rows are kept (one per role)', (routesDup.match(/^\s+BLOCKED\s+/gm) ?? []).length, 2);
  check('F23h the snippet passes the harness gate as-is', (() => { try { gateAllowedModels(dupSnippet); return true; } catch (error) { return `threw: ${error.message}`; } })(), true);
  check('F23i the harness gate really does reject a repeat (control)', (() => { try { gateAllowedModels([...dupSnippet, ...dupSnippet]); return 'no throw'; } catch (error) { return error.message; } })(), /repeats route/);
  info('F23i control message: ' + (() => { try { gateAllowedModels([{ provider: PK, model: 'EXEC' }, { provider: PK, model: 'EXEC' }]); return 'no throw'; } catch (error) { return error.message; } })());
  check('F23j the corrected wording says role routing is not blocked', routesDup.includes('This does NOT block role routing'), routesDup.split('\n').find((line) => line.includes('does NOT block')) ?? '(missing)', 'explanatory line');
  check('F23k the corrected wording names both real consequences', routesDup.includes('will be refused') && routesDup.includes('list_subagent_models'), routesDup.split('\n').filter((line) => /refused|list_subagent_models/.test(line)).join(' / '), 'explicit-choice refusal + catalog note');
  check('F23l the old over-strong claim is gone', !/are NOT in the subagent allow-list, so the delegation tool/.test(routesDup) && !/will be refused by the delegation tool/.test(routesDup), 'wording', 'no "routing refused" claim');

  // the same dedup applies to the boot diagnostic
  const bootWorld = makeWorld({ allowList: { enabled: true, allowedModels: [M('UNRELATED')] } });
  const hBoot = makeCtx({ world: bootWorld });
  apply(hBoot.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const bootWarns = hBoot.state.logs.filter((entry) => entry[0] === 'warn' && String(entry[2]).includes('allow-list'));
  eq('F24 the boot diagnostic warns once for the shared route', bootWarns.length, 1);
  const bootLine = String(bootWarns[0]?.[2] ?? '');
  eq('F24b the boot diagnostic names the route once', (bootLine.match(/pku-corpus\/EXEC/g) ?? []).length, 1);
  check('F24c the boot diagnostic counts distinct routes', bootLine.includes('1 role route(s) are not in the subagent allow-list'), bootLine, '1 role route(s)');
  check('F24d the boot diagnostic names the owning role', bootLine.includes('(needed by execution)'), bootLine, '(needed by execution)');
  check('F24e the boot diagnostic no longer claims routing is refused', !bootLine.includes('will be refused by the delegation tool'), bootLine, 'no refusal claim');

  // -- the corrected allow-list semantics: the manager never consults it --------
  const hGate = makeCtx({ world: makeWorld({ allowList: { enabled: true, allowedModels: [M('UNRELATED')] } }) });
  apply(hGate.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const pGate = addParent(hGate.world, 'p-gate', M('default'));
  const cGate = addChild(hGate.world, pGate, 'gate0001-child', 'fix the typo', M('default'));
  routeEq('F25 a pure-inheritance child is routed even though the route is not allow-listed', await hGate.request(cGate, M('default')), PK, 'EXEC');
  const cGateExplicit = addChild(hGate.world, pGate, 'gate0002-child', 'fix the typo', M('EXPLICIT'));
  routeEq('F25b managed overrides an explicit child route with a non-allow-listed role route', await hGate.request(cGateExplicit, M('EXPLICIT')), PK, 'EXEC');
  const routesGate = await hGate.tool().execute({ action: 'routes' });
  check('F25c ... and `routes` still reports that route as not allow-listed', routesGate.includes('BLOCKED') && routesGate.includes(`${PK}/EXEC`), routesGate.split('\n').filter((line) => /BLOCKED|allow-list/.test(line))[0], 'BLOCKED row present');

  // a `current()` that throws is a REAL reachable state: the harness itself throws
  // when model selection is enabled with an empty allow-list
  // (dsh-tool-subagent/lib/model-selection-settings.js:59). It must be reported as
  // a configuration fault, not as a missing service.
  const hThrow = makeCtx({ selectionThrows: true });
  let throwErr;
  try {
    apply(hThrow.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  } catch (error) {
    throwErr = error;
  }
  check('F26 apply survives a throwing allow-list service', throwErr === undefined, throwErr?.message, 'no throw');
  const routesThrow = await hThrow.tool().execute({ action: 'routes' });
  const thrownLine = routesThrow.split('\n').find((line) => line.startsWith('Allow-list:')) ?? '(no allow-list line)';
  check('F26b routes reports the settings REFUSING, not a missing service', routesThrow.includes('the subagent model-selection settings refused to report its routes'), thrownLine, 'refused-to-report note');
  check('F26c and it quotes the underlying cause', routesThrow.includes('repeats route'), routesThrow.split('\n').find((line) => line.trim().startsWith('subagent model selection')), 'the error message');
  check('F26d and says how to fix it', routesThrow.includes('non-empty `allowedModels`'), routesThrow.split('\n').filter((line) => /allowedModels|profile patch/.test(line)).join(' / '), 'remediation line');
  check('F26e the boot diagnostic logs the same refusal', hThrow.state.logs.some((entry) => entry[0] === 'warn' && String(entry[2]).includes('refused to report its routes')), hThrow.state.logs.map((entry) => entry[2]).filter(Boolean).join(' | '), 'warn log naming the refusal');
  const hAbsent = makeCtx({ selectionMissing: true });
  apply(hAbsent.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const routesAbsent = await hAbsent.tool().execute({ action: 'routes' });
  check('F26f a genuinely absent service is still "unavailable"', routesAbsent.includes('Allow-list: unavailable (no subagent model-selection settings service in this composition).'), routesAbsent.split('\n').find((line) => line.startsWith('Allow-list:')), 'unavailable note');
  check('F26g and the two paths stay distinguishable', !routesAbsent.includes('refused to report') && !routesThrow.includes('unavailable'), [thrownLine, routesAbsent.split('\n').find((line) => line.startsWith('Allow-list:'))], 'refused != unavailable');

  // -- end-to-end contract: the emitted snippet IS the working allow-list -------
  const rtWorld = makeWorld({ allowList: { enabled: true, allowedModels: [M('UNRELATED')] } });
  const hRt = makeCtx({ world: rtWorld });
  apply(hRt.ctx, cfg({
    mode: 'managed',
    roles: { main: { models: [M('M1')] }, planning: { models: [M('P1')] }, execution: { models: [M('E1'), M('E2')], pick: 'round-robin' }, vision: { models: [] } },
  }));
  const routesRt = await hRt.tool().execute({ action: 'routes' });
  const rtSnippet = parseSnippet(routesRt);
  eq('F27 the snippet lists every distinct missing route once', rtSnippet.length, 4);
  eq('F27b the per-role audit still shows all six role/route pairs', (routesRt.match(/^\s+BLOCKED\s+/gm) ?? []).length, 6);
  // every route a role will actually use must be covered by the snippet
  const usedRoutes = [...new Set([...routesRt.matchAll(/^\s+(?:allowed|BLOCKED)\s+\w+\s+(\S+)\/(\S+)$/gm)].map((match) => `${match[1]}\0${match[2]}`))];
  const snippetKeys = new Set(rtSnippet.map((route) => `${route.provider}\0${route.model}`));
  eq('F27c the audit rows name 4 distinct routes', usedRoutes.length, 4);
  eq('F27d the snippet covers every route the roles will use', usedRoutes.filter((key) => !snippetKeys.has(key)), []);
  check('F27e the parsed snippet passes the real harness gate', (() => { try { gateAllowedModels(rtSnippet); return true; } catch (error) { return `threw: ${error.message}`; } })(), true);
  // apply it, and the same config must now report everything dispatchable
  rtWorld.allowList.allowedModels = rtSnippet;
  const routesAfter = await hRt.tool().execute({ action: 'routes' });
  check('F27f following the instruction clears the audit', routesAfter.includes('All role routes are allow-listed.'), routesAfter.split('\n').filter((line) => /BLOCKED|allow-list/i.test(line)).join(' | '), 'all allow-listed');
  eq('F27g no BLOCKED rows remain', (routesAfter.match(/^\s+BLOCKED\s+/gm) ?? []).length, 0);
  check('F27h the old over-strong happy-path wording is gone', !routesAfter.includes('All role routes are dispatchable'), routesAfter.split('\n').find((line) => /dispatchable|allow-listed/), 'new wording only');
  const pRt = addParent(hRt.world, 'p-rt', M('default'));
  const cRt = addChild(hRt.world, pRt, 'rt000001-child', 'fix the typo', M('default'));
  routeEq('F27i routing still works after the round-trip', await hRt.request(cRt, M('default')), PK, 'E1');
  check('F27j no missing-route warning remains after the round-trip', !routesAfter.includes('are not in the subagent allow-list'), routesAfter.split('\n').filter((line) => /allow-list/.test(line)).join(' | '), 'no missing-route paragraph');

  // -- label sanitization ----------------------------------------------------
  const h5 = makeCtx();
  apply(h5.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const p5 = addParent(h5.world, 'p-f5', M('default'));
  const c5 = addChild(h5.world, p5, 'f5000005-child', 'say "hi"\nnow', M('default'));
  await h5.request(c5, M('default'));
  const report5 = await h5.tool().execute({ action: 'report' });
  const row5 = report5.split('\n').find((line) => line.includes('f5000005'));
  check('F19 embedded double quotes are escaped to single quotes', row5 !== undefined && row5.includes(`"say 'hi' now"`), row5, `row containing "say 'hi' now"`);
  info(`F19 row rendered as: ${row5}`);
}

// ===========================================================================
section('G. missing / hostile context surfaces');
// ===========================================================================
{
  // G1: every service undefined
  const h1 = makeCtx({ getThrows: false });
  h1.ctx.get = () => undefined;
  let threw;
  let threwMessage;
  quiet(() => {
    try {
      apply(h1.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
      threwMessage = error.message;
    }
  });
  check('G1 apply survives ctx.get() -> undefined for every service', threw === undefined, threwMessage, 'no throw');
  const orphan1 = { id: 'g1-child', options: M('default'), session: { header: { origin: 'subagent' } }, status: 'running' };
  let out1;
  try {
    out1 = await h1.request(orphan1, M('default'));
  } catch (error) {
    threw = error;
    threwMessage = error.message;
  }
  check('G2 managed routing still applies with no services', out1?.model === 'EXEC', threwMessage ?? `${out1?.provider}/${out1?.model}`, 'EXEC');

  // G3: no logger / inject / effect at all
  const h3 = makeCtx({ loggerMissing: true, injectMissing: true, effectMissing: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h3.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G3 apply survives missing logger/inject/effect', threw === undefined, threw?.message, 'no throw');
  check('G3b no tool registered without inject', h3.tools.length === 0, h3.tools.length, 0);

  // G4: no ctx.on at all
  const h4 = makeCtx({ onMissing: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h4.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G4 apply survives a missing ctx.on', threw === undefined, threw?.message, 'no throw');

  // G5: ctx.on throws
  const h5 = makeCtx({ onThrows: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h5.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G5 apply survives ctx.on throwing', threw === undefined, threw?.message, 'no throw');

  // G6: service accessor throws for every service
  const h6 = makeCtx({ getThrows: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h6.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G6 apply survives a throwing service accessor', threw === undefined, threw?.message, 'no throw');
  let threw6b;
  try {
    await h6.request({ id: 'g6-child', options: M('default'), session: { header: { origin: 'subagent' } }, status: 'running' }, M('default'));
  } catch (error) {
    threw6b = error;
  }
  check('G6b routing survives a throwing service accessor', threw6b === undefined, threw6b?.message, 'no throw');

  // G7: logger methods throw
  const h7 = makeCtx({ loggerThrows: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h7.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G7 apply survives a logger that throws', threw === undefined, threw?.message, 'no throw');

  // G8: systemPrompt.section throws
  const h8 = makeCtx({ sectionThrows: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h8.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G8 apply survives a throwing systemPrompt.section', threw === undefined, threw?.message, 'no throw');

  // G9: subagents service missing entirely
  const h9 = makeCtx({ subagentsMissing: true });
  apply(h9.ctx, cfg({ mode: 'managed', roles: { planning: { models: [M('PLAN')] }, execution: { models: [M('EXEC')] } } }));
  const p9 = addParent(h9.world, 'p-g9', M('default'));
  const c9 = addChild(h9.world, p9, 'g9-child', 'analyze the parser design', M('default'));
  routeEq('G9 route falls back to execution when subagents service is missing', await h9.request(c9, M('default')), PK, 'EXEC');

  // G10: agents service missing but subagents present (findParent impossible, full sweep? no agents.list)
  const h10 = makeCtx({ agentsMissing: true });
  apply(h10.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const c10 = { id: 'g10-child', options: M('default'), session: { header: { origin: 'subagent' } }, status: 'running' };
  let threw10;
  try {
    await h10.request(c10, M('default'));
  } catch (error) {
    threw10 = error;
  }
  check('G10 routing survives a missing agents service', threw10 === undefined, threw10?.message, 'no throw');

  // G11: subagents.listChildren rejects
  const h11 = makeCtx();
  h11.world.onListChildren = async () => { throw new Error('listChildren boom'); };
  apply(h11.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  const p11 = addParent(h11.world, 'p-g11', M('default'));
  const c11 = addChild(h11.world, p11, 'g11-child', 'fix the typo', M('default'));
  let threw11;
  try {
    await h11.request(c11, M('default'));
  } catch (error) {
    threw11 = error;
  }
  check('G11 routing survives a rejecting listChildren', threw11 === undefined, threw11?.message, 'no throw');

  // G12: isOwnedBy always false (lineage unavailable) -> full sweep must still classify
  const h12 = makeCtx();
  apply(h12.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const p12 = addParent(h12.world, 'p-g12', M('default'));
  const c12 = addChild(h12.world, p12, 'g12-child', 'read the screenshot', M('default'));
  h12.world.breakOwnership = true;
  routeEq('G12 full sweep classifies when isOwnedBy cannot resolve lineage', await h12.request(c12, M('default')), PK, 'VIS');

  // G13: effect missing but inject present -> the section is registered directly
  const h13 = makeCtx({ effectMissing: true });
  apply(h13.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
  check('G13 section still registers when ctx.effect is absent', h13.state.section?.name === 'model-manager', h13.state.section?.name, 'model-manager');
  check('G13b tool still registers when ctx.effect is absent', h13.tool() !== undefined, h13.tools.map((t) => t.name), ['model_manager']);

  // G14: inject present, tools missing -> the callback must never fire
  const h14 = makeCtx({ toolsMissing: true });
  quiet(() => {
    threw = undefined;
    try {
      apply(h14.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] } } }));
    } catch (error) {
      threw = error;
    }
  });
  check('G14 apply survives a missing tools service', threw === undefined, threw?.message, 'no throw');
  check('G14b no tool registered without the tools service', h14.tool() === undefined, h14.tools.length, 0);
}

// ===========================================================================
section('H. concurrency: distinct children, one shared lookup cache');
// ===========================================================================
{
  const h = makeCtx();
  h.world.onListChildren = async (parentId) => {
    await sleep(Math.floor(Math.random() * 4)); // interleave concurrent lookups
    return (h.world.catalog.get(parentId) ?? []).slice();
  };
  apply(h.ctx, cfg({
    mode: 'managed',
    roles: { vision: { models: [M('VIS')] }, planning: { models: [M('PLAN')] }, execution: { models: [M('EXEC')] } },
  }));
  const parent = addParent(h.world, 'p-conc', M('default'));

  // wave 1: one child populates the catalog
  const warm = addChild(h.world, parent, 'conc0000-warm', 'fix the typo', M('default'));
  await h.request(warm, M('default'));

  // wave 2: 30 children created after the first lookup, then requested concurrently
  const plan = [];
  for (let i = 0; i < 30; i += 1) {
    const kind = i % 3;
    const id = `conc${String(i + 1).padStart(4, '0')}-x`;
    const label = kind === 0 ? `screenshot ${i}` : kind === 1 ? `analyze design ${i}` : `fix typo ${i}`;
    const want = kind === 0 ? 'VIS' : kind === 1 ? 'PLAN' : 'EXEC';
    plan.push({ id, label, want, child: addChild(h.world, parent, id, label, M('default')) });
  }
  const results = await Promise.all(plan.map(async (entry) => ({ ...entry, out: await h.request(entry.child, M('default')) })));
  const wrong = results.filter((entry) => `${entry.out.provider}/${entry.out.model}` !== `${PK}/${entry.want}`);
  check('H1 every concurrent child resolves its own label and role', wrong.length === 0, wrong.map((entry) => `${entry.id} label=${entry.label} -> ${entry.out.model} (want ${entry.want})`), 'no misrouted children');

  const report = await h.tool().execute({ action: 'report' });
  const missingRows = results.filter((entry) => !report.includes(entry.id.slice(0, 8)));
  check('H2 every concurrent child appears in the report', missingRows.length === 0, missingRows.map((entry) => entry.id), 'all children present');

  // H3: the same child requested twice while its first lookup is in flight
  const h3 = makeCtx();
  let inFlight = 0;
  h3.world.onListChildren = async (parentId) => {
    inFlight += 1;
    await sleep(10);
    inFlight -= 1;
    return (h3.world.catalog.get(parentId) ?? []).slice();
  };
  apply(h3.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] } } }));
  const p3 = addParent(h3.world, 'p-conc3', M('default'));
  const c3 = addChild(h3.world, p3, 'conc3-child', 'read the screenshot', M('default'));
  const [r3a, r3b] = await Promise.all([h3.request(c3, M('default')), h3.request(c3, M('default'))]);
  routeEq('H3 concurrent duplicate requests for one child both route correctly', r3a, PK, 'VIS');
  routeEq('H4 second concurrent request also routes correctly', r3b, PK, 'VIS');

  // H5: two parents, children interleaved, no cross-parent contamination
  const h5 = makeCtx();
  h5.world.onListChildren = async (parentId) => {
    await sleep(Math.floor(Math.random() * 4));
    return (h5.world.catalog.get(parentId) ?? []).slice();
  };
  apply(h5.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const pa = addParent(h5.world, 'p-a', M('default'));
  const pb = addParent(h5.world, 'p-b', M('default'));
  const kids = [];
  for (let i = 0; i < 10; i += 1) {
    kids.push({ want: 'VIS', child: addChild(h5.world, pa, `ka${String(i).padStart(4, '0')}`, `screenshot a${i}`, M('default')) });
    kids.push({ want: 'EXEC', child: addChild(h5.world, pb, `kb${String(i).padStart(4, '0')}`, `plain work b${i}`, M('default')) });
  }
  const kidResults = await Promise.all(kids.map(async (entry) => ({ ...entry, out: await h5.request(entry.child, M('default')) })));
  const crossWrong = kidResults.filter((entry) => entry.out.model !== entry.want);
  check('H5 no cross-parent contamination across interleaved lookups', crossWrong.length === 0, crossWrong.map((entry) => `${entry.child.id} -> ${entry.out.model} want ${entry.want}`), 'no contamination');
}

// ===========================================================================
section('I. catalog staleness / first-request classification');
// ===========================================================================
{
  // I1: child added AFTER an earlier request already populated the catalog
  const h = makeCtx();
  apply(h.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const parent = addParent(h.world, 'p-stale', M('default'));
  const early = addChild(h.world, parent, 'stale001-early', 'fix the typo', M('default'));
  await h.request(early, M('default'));
  const late = addChild(h.world, parent, 'stale002-late', 'read the screenshot', M('default'));
  routeEq('I1 child created after the catalog was populated routes on its FIRST request', await h.request(late, M('default')), PK, 'VIS');

  // I2: no latched "catalog loaded" flag - a child that was unresolvable recovers later
  const h2 = makeCtx();
  let snapshot = [];
  h2.world.onListChildren = async () => snapshot;
  apply(h2.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const p2 = addParent(h2.world, 'p-recover', M('default'));
  const c2 = addChild(h2.world, p2, 'recover01-child', 'read the screenshot', M('default'));
  routeEq('I2 first request with a stale catalog falls back to execution', await h2.request(c2, M('default')), PK, 'EXEC');
  snapshot = (h2.world.catalog.get('p-recover') ?? []).slice();
  routeEq('I3 once the catalog is readable the SAME request path recovers (no latching)', await h2.request(c2, M('default')), PK, 'VIS');

  // I4: subagent/start warm-up resolves the label even when lineage is unavailable
  const h4 = makeCtx();
  apply(h4.ctx, cfg({ mode: 'managed', roles: { planning: { models: [M('PLAN')] }, execution: { models: [M('EXEC')] } } }));
  const p4 = addParent(h4.world, 'p-warm', M('default'));
  const c4 = addChild(h4.world, p4, 'warm0001-child', 'analyze the parser design', M('default'));
  h4.world.breakOwnership = true; // findParent cannot resolve lineage
  h4.emit('subagent/start', { id: 'warm0001-child', provider: 'p', local: true }, p4);
  await sleep(5); // let the warm-up lookup settle
  routeEq('I4 subagent/start warm-up classifies without lineage', await h4.request(c4, M('default')), PK, 'PLAN');

  // I5: catalog row with no label -> execution (faithful to one-shot catalog rows)
  const h5 = makeCtx();
  apply(h5.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const p5 = addParent(h5.world, 'p-nolabel', M('default'));
  const c5 = addChild(h5.world, p5, 'nolabel01-child', undefined, M('default'));
  routeEq('I5 catalog row without a label routes to execution', await h5.request(c5, M('default')), PK, 'EXEC');
  const rep5 = await h5.tool().execute({ action: 'report' });
  check('I6 unlabelled catalog row still appears in the report', rep5.includes('nolabel0'), rep5.split('\n').find((line) => line.includes('nolabel0')) ?? '(absent)', 'row present');

  // I7: 100 sequential distinct children, all labels correct (cache growth sanity)
  const h7 = makeCtx();
  apply(h7.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } } }));
  const p7 = addParent(h7.world, 'p-many', M('default'));
  let bad7 = 0;
  for (let i = 0; i < 100; i += 1) {
    const vision = i % 2 === 0;
    const child = addChild(h7.world, p7, `many${String(i).padStart(5, '0')}`, vision ? `screenshot ${i}` : `plain ${i}`, M('default'));
    const out = await h7.request(child, M('default'));
    if (out.model !== (vision ? 'VIS' : 'EXEC')) bad7 += 1;
  }
  check('I7 100 sequential first-requests all classify correctly', bad7 === 0, `${bad7} wrong`, '0 wrong');
}

// ===========================================================================
section('J. hybrid inheritance vs the route DSH actually persists (likely defect)');
// ===========================================================================
{
  // Real DSH: the parent's request header holds the RESOLVED (possibly rewritten)
  // route; children inherit from that header (dsh-subagent resolveChildAgentOptions),
  // and effectiveRouteOf() now mirrors that. `parent.options` is only the
  // pre-first-request fallback.
  info(`J section child inheritance computed by ${realResolveChildAgentOptions ? 'the REAL dsh-subagent resolveChildAgentOptions' : 'the local re-implementation'}`);
  const h = makeCtx();
  apply(h.ctx, cfg({
    mode: 'hybrid',
    roles: { main: { models: [M('MAIN-ROLE')] }, execution: { models: [M('EXEC-ROLE')] } },
  }));
  const parent = addParent(h.world, 'p-hyb', M('CREATED-DEFAULT'));
  const parentOut = await h.request(parent, M('CREATED-DEFAULT'));
  routeEq('J1 parent top-level request is rewritten to the main role', parentOut, PK, 'MAIN-ROLE');

  // child delegates with no explicit model: inherits the parent's LAST REQUEST route
  const child = addChild(h.world, parent, 'hyb00001-child', 'fix the typo', childInheritedOpts(parent));
  const childResolved = { ...child.options };
  const childOut = await h.request(child, childResolved);
  check('J2 hybrid rewrites a child that inherited the parent\'s effective route', childOut.model === 'EXEC-ROLE', `${childOut.provider}/${childOut.model}`, `${PK}/EXEC-ROLE`);

  const rep = await h.tool().execute({ action: 'report' });
  const row = rep.split('\n').find((line) => line.includes('hyb00001')) ?? '(no row)';
  info(`J2 report row: ${row.trim()}`);

  // control: a parent whose creation route already equals its applied route
  const parent2 = addParent(h.world, 'p-ctrl', M('MAIN-ROLE'));
  await h.request(parent2, M('MAIN-ROLE'));
  const child2 = addChild(h.world, parent2, 'hyb00002-child', 'fix the typo', childInheritedOpts(parent2));
  const child2Resolved = { ...child2.options };
  const child2Out = await h.request(child2, child2Resolved);
  routeEq('J3 control: hybrid rewrites when the parent was never rewritten', child2Out, PK, 'EXEC-ROLE');

  // same scenario under `managed`: the defect is hybrid-only
  const hm = makeCtx();
  apply(hm.ctx, cfg({ mode: 'managed', roles: { main: { models: [M('MAIN-ROLE')] }, execution: { models: [M('EXEC-ROLE')] } } }));
  const pm = addParent(hm.world, 'p-hyb-managed', M('CREATED-DEFAULT'));
  await hm.request(pm, M('CREATED-DEFAULT'));
  const cm = addChild(hm.world, pm, 'hyb00003-child', 'fix the typo', childInheritedOpts(pm));
  routeEq('J4 managed rewrites the same child that hybrid refused to rewrite', await hm.request(cm, { ...cm.options }), PK, 'EXEC-ROLE');

  // J5 (D1 fix, pre-first-request half): the parent has NO request header yet,
  // so effectiveRouteOf() must fall back to parent.options.
  const h5 = makeCtx();
  apply(h5.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('EXEC-ROLE')] } } }));
  const p5 = addParent(h5.world, 'p-noheader', M('PARENT-OPTIONS'));
  const c5 = addChild(h5.world, p5, 'hyb00004-child', 'fix the typo', { ...M('PARENT-OPTIONS') });
  check('J5 parent with no request header yet (pre-first-request)', p5.session.requestHeader() === undefined, p5.session.requestHeader(), undefined);
  routeEq('J5b hybrid falls back to parent.options and routes the child', await h5.request(c5, { ...M('PARENT-OPTIONS') }), PK, 'EXEC-ROLE');

  // J5c: once that parent has a header, the header wins for the next child
  await h5.request(p5, M('PARENT-OPTIONS'));
  const c5b = addChild(h5.world, p5, 'hyb00005-child', 'fix the typo', childInheritedOpts(p5));
  routeEq('J5c the header (not options) is used once it exists', await h5.request(c5b, { ...c5b.options }), PK, 'EXEC-ROLE');

  // J6: hybrid + unresolvable lineage FAILS CLOSED — the child route is kept.
  // (Policy reversal: `hybrid` means "only take over when inheritance is
  // provable"; `managed` is the always-apply escape hatch, tested in J6c.)
  const h6 = makeCtx();
  apply(h6.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('EXEC-ROLE')] } } }));
  const p6 = addParent(h6.world, 'p-nolineage', M('PARENT-OPTIONS'));
  const c6 = addChild(h6.world, p6, 'hyb00006-child', 'fix the typo', M('PARENT-OPTIONS'));
  h6.world.breakOwnership = true; // findParent() cannot resolve the parent
  const out6 = await h6.request(c6, M('PARENT-OPTIONS'));
  routeEq('J6 hybrid respects the child route when lineage is unresolved', out6, PK, 'PARENT-OPTIONS');
  const rep6 = await h6.tool().execute({ action: 'report' });
  const row6 = rep6.split('\n').find((line) => line.includes('hyb00006')) ?? '(no row)';
  check('J6b the report names the fail-closed reason', row6.includes('lineage unresolved (child route respected)'), row6, 'reason "lineage unresolved (child route respected)"');
  check('J6d the old fail-open reason string is gone from the plugin', !rep6.includes('applied (lineage unresolved)'), row6, 'no "applied (lineage unresolved)"');

  // J6c: `managed` still applies with the very same unresolvable lineage
  const h6c = makeCtx();
  apply(h6c.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC-ROLE')] } } }));
  const p6c = addParent(h6c.world, 'p-nolineage-m', M('PARENT-OPTIONS'));
  const c6c = addChild(h6c.world, p6c, 'hyb00008-child', 'fix the typo', M('PARENT-OPTIONS'));
  h6c.world.breakOwnership = true;
  routeEq('J6c managed applies the role route even with unresolvable lineage', await h6c.request(c6c, M('PARENT-OPTIONS')), PK, 'EXEC-ROLE');

  // J6e: failing closed must not advance the rotation (didApply === false)
  const h6e = makeCtx();
  apply(h6e.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('R1'), M('R2')], pick: 'round-robin' } } }));
  const p6e = addParent(h6e.world, 'p-nolineage-rr', M('PARENT-OPTIONS'));
  h6e.world.breakOwnership = true;
  const ghost = addChild(h6e.world, p6e, 'hyb00009-child', 'fix the typo', M('PARENT-OPTIONS'));
  await h6e.request(ghost, M('PARENT-OPTIONS')); // respected, no commit
  h6e.world.breakOwnership = false;
  const live = addChild(h6e.world, p6e, 'hyb00010-child', 'fix the typo', M('PARENT-OPTIONS'));
  routeEq('J6e an unresolved-lineage request consumed no rotation slot', await h6e.request(live, M('PARENT-OPTIONS')), PK, 'R1');

  // J11: manager-ownership is remembered ONLY in the LRU-capped `usage` map, so
  // eviction can mislabel a manager-applied route as a caller's explicit choice.
  // historyLimit 1 stands in for "enough other agents were routed in between".
  const hOw = makeCtx();
  apply(hOw.ctx, cfg({
    mode: 'hybrid',
    roles: { execution: { models: [M('E1'), M('E2')], pick: 'round-robin' } },
    strategy: { historyLimit: 1 },
  }));
  const pOw = addParent(hOw.world, 'p-lru-own', M('PARENT'));
  await hOw.request(pOw, M('PARENT'));
  const ownedKid = addChild(hOw.world, pOw, 'own00009-child', 'fix the typo', M('PARENT'));
  const otherKid = addChild(hOw.world, pOw, 'own00010-child', 'fix the typo', M('PARENT'));
  routeEq('J11a the first child is routed', await hOw.request(ownedKid, M('PARENT')), PK, 'E1');
  routeEq('J11b a second child is routed (evicting the first record)', await hOw.request(otherKid, M('PARENT')), PK, 'E2');
  const afterEvict = await hOw.request(ownedKid, M('E1'));
  const rowOw = (await hOw.tool().execute({ action: 'report' })).split('\n').find((line) => line.includes('own00009')) ?? '(no row)';
  check('J11 an evicted record must not relabel a manager-applied route as an explicit choice', !/explicit child route \(respected\)/.test(rowOw), rowOw, 'a reason that does not blame the caller (manager-owned / applied)');
  void afterEvict;
  // the mislabel is durable: `previous` is never restored, so the child can never
  // be re-adopted and its rotation stops for the rest of its life.
  const sticky = [];
  for (let i = 0; i < 3; i += 1) {
    await hOw.request(ownedKid, M('E1'));
    sticky.push(((await hOw.tool().execute({ action: 'report' })).split('\n').find((line) => line.includes('own00009')) ?? '').replace(/\s+/g, ' ').trim());
  }
  info(`J11 after eviction the row reads: ${rowOw.trim()}`);
  info(`J11c it stays that way for every later turn (3 turns observed): ${sticky[2] ?? '(none)'}`);

  // J7: an explicit child route is still respected when lineage IS resolvable
  const h7 = makeCtx();
  apply(h7.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('EXEC-ROLE')] } } }));
  const p7 = addParent(h7.world, 'p-lineage', M('PARENT-OPTIONS'));
  const c7 = addChild(h7.world, p7, 'hyb00007-child', 'fix the typo', M('EXPLICIT-CHOICE'));
  const out7 = await h7.request(c7, { ...M('EXPLICIT-CHOICE') });
  routeEq('J7 an explicit child route is respected when lineage resolves', out7, PK, 'EXPLICIT-CHOICE');

  // -- the manager-owned rule: a routed child keeps being managed --------------
  const h9 = makeCtx();
  apply(h9.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('E1'), M('E2')], pick: 'round-robin' } } }));
  const p9 = addParent(h9.world, 'p-owned', M('PARENT'));
  const rowOf = async (h, id) => (await h.tool().execute({ action: 'report' })).split('\n').find((line) => line.includes(id)) ?? '(no row)';

  const owned = addChild(h9.world, p9, 'own00001-child', 'fix the typo', M('PARENT'));
  routeEq('J8 first turn of an inherited child is routed', await h9.request(owned, M('PARENT')), PK, 'E1');
  check('J8a and the reason is a plain apply', (await rowOf(h9, 'own00001')).includes('applied'), await rowOf(h9, 'own00001'), 'reason "applied"');
  routeEq('J8b its SECOND turn is still managed (header now equals E1)', await h9.request(owned, M('E1')), PK, 'E2');
  check('J8c the reason records manager ownership, not an explicit choice', (await rowOf(h9, 'own00001')).includes('applied (manager-owned)'), await rowOf(h9, 'own00001'), 'reason "applied (manager-owned)"');
  routeEq('J8d and the child keeps cycling the rotation', await h9.request(owned, M('E2')), PK, 'E1');
  check('J8e manager-owned turns DO advance rotation', (await rowOf(h9, 'own00001')).includes('applied (manager-owned)'), await rowOf(h9, 'own00001'), 'reason stays manager-owned');
  check('J8f the old behaviour (reclassified as explicit) is gone', !/explicit child route \(respected\)/.test(await rowOf(h9, 'own00001')), await rowOf(h9, 'own00001'), 'no explicit-respected row');

  // a respected explicit choice must never be re-adopted as manager-owned
  const h10 = makeCtx();
  apply(h10.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('E1'), M('E2')], pick: 'round-robin' } } }));
  const p10 = addParent(h10.world, 'p-explicit', M('PARENT'));
  const expl = addChild(h10.world, p10, 'exp00001-child', 'fix the typo', M('CHOSEN'));
  routeEq('J9 the explicit route is respected on turn 1', await h10.request(expl, M('CHOSEN')), PK, 'CHOSEN');
  check('J9a with the explicit-respected reason', (await rowOf(h10, 'exp00001')).includes('explicit child route (respected)'), await rowOf(h10, 'exp00001'), 'reason "explicit child route (respected)"');
  routeEq('J9b and is NOT adopted as manager-owned on turn 2', await h10.request(expl, M('CHOSEN')), PK, 'CHOSEN');
  check('J9c it is still reported as respected, not applied', (await rowOf(h10, 'exp00001')).includes('explicit child route (respected)'), await rowOf(h10, 'exp00001'), 'reason unchanged');
  const freshAfterExplicit = addChild(h10.world, p10, 'exp00002-child', 'fix the typo', M('PARENT'));
  routeEq('J9d the respected turns advanced no rotation (a new inherited child gets E1)', await h10.request(freshAfterExplicit, M('PARENT')), PK, 'E1');

  // top-level agents are not subject to the inheritance rule
  const h11 = makeCtx();
  apply(h11.ctx, cfg({ mode: 'hybrid', roles: { main: { models: [M('MAIN')] } } }));
  const top = addParent(h11.world, 'p-top-level', M('SELF-CHOSEN'));
  routeEq('J10 hybrid still routes a top-level agent with a route of its own', await h11.request(top, M('SELF-CHOSEN')), PK, 'MAIN');
}

// ===========================================================================
section('M. round-robin commits only when a route is actually applied');
// ===========================================================================
{
  // advisory: the rotation must not be consumed (and no route may be rewritten)
  const hAdv = makeCtx();
  apply(hAdv.ctx, cfg({ mode: 'advisory', roles: { execution: { models: [M('R1'), M('R2')], pick: 'round-robin' } } }));
  const pAdv = addParent(hAdv.world, 'p-rr-adv', M('default'));
  const cAdv = addChild(hAdv.world, pAdv, 'rradv001-child', 'fix the typo', M('default'));
  const advOut = [];
  for (let i = 0; i < 4; i += 1) advOut.push((await hAdv.request(cAdv, M('default'))).model);
  eq('M1 advisory never rewrites the route', advOut, ['default', 'default', 'default', 'default']);
  const advReport = await hAdv.tool().execute({ action: 'report' });
  check('M1b advisory records the reason', advReport.includes('advisory (not applied)'), advReport.split('\n').find((line) => line.includes('rradv001')), 'advisory (not applied)');
  info('M1c the advisory round-robin counter is not externally observable: nothing is ever rewritten and no public action exposes the index. The sibling branch of the same non-commit gate (explicit respected, M2) is asserted directly.');

  // hybrid: two respected explicit choices must not consume rotation slots
  const hExp = makeCtx();
  apply(hExp.ctx, cfg({ mode: 'hybrid', roles: { execution: { models: [M('R1'), M('R2')], pick: 'round-robin' } } }));
  const pExp = addParent(hExp.world, 'p-rr-exp', M('PARENT'));
  const e1 = addChild(hExp.world, pExp, 'rrexp001-child', 'fix the typo', M('EXPLICIT-1'));
  const e2 = addChild(hExp.world, pExp, 'rrexp002-child', 'fix the typo', M('EXPLICIT-2'));
  const inh = addChild(hExp.world, pExp, 'rrexp003-child', 'fix the typo', M('PARENT'));
  routeEq('M2 first explicit choice is respected', await hExp.request(e1, M('EXPLICIT-1')), PK, 'EXPLICIT-1');
  routeEq('M2b second explicit choice is respected', await hExp.request(e2, M('EXPLICIT-2')), PK, 'EXPLICIT-2');
  routeEq('M2c the inherited child still gets rotation slot 0 (no advance)', await hExp.request(inh, M('PARENT')), PK, 'R1');
  routeEq('M2d the next inherited child gets slot 1', await hExp.request(inh, M('PARENT')), PK, 'R2');

  // managed: a route that is already correct still consumes a rotation slot,
  // otherwise the rotation would stall whenever the resolved route coincides
  const hSame = makeCtx();
  apply(hSame.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('R1'), M('R2')], pick: 'round-robin' } } }));
  const pSame = addParent(hSame.world, 'p-rr-same', M('default'));
  const cSame = addChild(hSame.world, pSame, 'rrsame01-child', 'fix the typo', M('default'));
  const sameOut = [];
  for (let i = 0; i < 4; i += 1) sameOut.push((await hSame.request(cSame, M('R1'))).model);
  eq('M3 an applied-but-identical route still rotates', sameOut, ['R1', 'R2', 'R1', 'R2']);

  // concurrent applied requests still rotate (selection+commit is synchronous)
  const hConc = makeCtx();
  apply(hConc.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('A'), M('B'), M('C')], pick: 'round-robin' } } }));
  const pConc = addParent(hConc.world, 'p-rr-conc', M('default'));
  const concKids = [];
  for (let i = 0; i < 6; i += 1) concKids.push(addChild(hConc.world, pConc, `rrconc0${i}-child`, 'fix the typo', M('default')));
  const concOut = await Promise.all(concKids.map((kid) => hConc.request(kid, M('default'))));
  const concModels = concOut.map((out) => out.model).sort();
  eq('M4 six concurrent applied requests still rotate through all models', concModels, ['A', 'A', 'B', 'B', 'C', 'C']);
}

// ===========================================================================
section('K. exports');
// ===========================================================================
{
  check('K1 name export', plugin.name === 'model-manager', plugin.name, 'model-manager');
  check('K2 Config export is a schema', plugin.Config !== undefined, typeof plugin.Config, 'object');
  check('K3 readConfig/applyRoute/effectiveRouteOf exported', typeof readConfig === 'function' && typeof applyRoute === 'function' && typeof plugin.effectiveRouteOf === 'function', [typeof readConfig, typeof applyRoute, typeof plugin.effectiveRouteOf], ['function', 'function', 'function']);
  check('K4 default keyword lists exported and non-empty', DEFAULT_VISION_KEYWORDS.length > 0 && DEFAULT_PLANNING_KEYWORDS.length > 0, [DEFAULT_VISION_KEYWORDS.length, DEFAULT_PLANNING_KEYWORDS.length], 'both > 0');
  check('K5 readConfig result carries a warnings array', Array.isArray(readConfig({}).warnings), readConfig({}).warnings, 'array');

  // effectiveRouteOf unit behaviour (the D1 fix, in isolation)
  const headerAgent = {
    options: { provider: PK, model: 'OPTIONS' },
    session: { requestHeader: () => ({ config: { provider: PK, model: 'HEADER' } }) },
  };
  eq('K6 effectiveRouteOf prefers the request header', plugin.effectiveRouteOf(headerAgent), { provider: PK, model: 'HEADER' });
  const optionsAgent = { options: { provider: PK, model: 'OPTIONS' }, session: { requestHeader: () => undefined } };
  eq('K7 effectiveRouteOf falls back to options', plugin.effectiveRouteOf(optionsAgent), { provider: PK, model: 'OPTIONS' });
  const brokenAgent = { options: { provider: PK, model: 'OPTIONS' }, session: { requestHeader: () => { throw new Error('boom'); } } };
  eq('K8 effectiveRouteOf survives a throwing requestHeader', plugin.effectiveRouteOf(brokenAgent), { provider: PK, model: 'OPTIONS' });
  eq('K9 effectiveRouteOf returns undefined when nothing is resolvable', plugin.effectiveRouteOf({}), undefined);
  const partialHeader = { options: { provider: PK, model: 'OPTIONS' }, session: { requestHeader: () => ({ config: { model: 'HEADER' } }) } };
  eq('K10 effectiveRouteOf ignores a partial header config', plugin.effectiveRouteOf(partialHeader), { provider: PK, model: 'OPTIONS' });
}

// ===========================================================================
section('L. harness data path: schema-validated config with volatile refs');
// ===========================================================================
{
  const validated = new plugin.Config({
    roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } },
    strategy: { mode: 'managed' },
  });
  const read = readConfig(validated);
  eq('L1 readConfig unwraps the schema-produced volatile roles ref', read.roles.vision.models, [{ provider: PK, model: 'VIS' }]);
  eq('L2 readConfig unwraps the schema-produced volatile strategy ref', read.strategy.mode, 'managed');

  const empty = readConfig(new plugin.Config({}));
  eq('L3 an empty validated config yields four unconfigured roles', Object.values(empty.roles).map((role) => role.models.length), [0, 0, 0, 0]);
  eq('L4 an empty validated config defaults to hybrid', empty.strategy.mode, 'hybrid');
  eq('L5 an empty validated config defaults historyLimit to 300', empty.strategy.historyLimit, 300);

  // full routing through the exact object shape the harness hands to apply()
  const h = makeCtx();
  apply(h.ctx, validated);
  const parent = addParent(h.world, 'p-l', M('default'));
  const child = addChild(h.world, parent, 'l0000001-child', 'read the screenshot', M('default'));
  routeEq('L6 routing works on a schema-validated volatile config', await h.request(child, M('default')), PK, 'VIS');
  const child2 = addChild(h.world, parent, 'l0000002-child', 'fix the typo', M('default'));
  routeEq('L7 second role from the same validated config routes too', await h.request(child2, M('default')), PK, 'EXEC');

  let threw;
  try {
    new plugin.Config({ roles: 'garbage' });
  } catch (error) {
    threw = error;
  }
  check('L8 the exported Config schema rejects hostile input (harness-side guard)', threw !== undefined, threw?.message, 'throws');
}

// ===========================================================================
section('N. vision image-capability check (`routes` block + boot warning)');
// ===========================================================================
{
  // Faithful to `dsh-llm` `resolveModelInfo(provider, model)`: it returns an
  // `LlmResolvedModelInfo` whose `inputModalities` key is ABSENT unless the
  // adapter declared it (dsh-llm/lib/index.js:2111-2123, `detachedModalities`),
  // and it THROWS (LlmError) for an unknown provider/model. `dsh-acp` uses the
  // same `inputModalities?.includes("image")` test for image capability (:84).
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const IMAGE_OK = { inputModalities: ['text', 'image'] };
  const TEXT_ONLY = { inputModalities: ['text'] };
  const NOTHING = { inputModalities: [] };
  const NO_FIELD = { name: 'Mystery' };

  const tableLlm = (table, calls) => ({
    async resolveModelInfo(provider, model) {
      calls.push(`${provider}/${model}`);
      const entry = table[`${provider}/${model}`];
      if (entry === 'THROW') throw new Error('boom');
      if (entry === undefined) throw new Error(`no such model ${provider}/${model}`);
      return entry;
    },
  });

  const visionHarness = (roles, llm) => {
    const calls = [];
    const h = makeCtx({ llm: llm === undefined ? undefined : (llm === 'BROKEN_OBJECT' ? { notResolveModelInfo: () => {} } : tableLlm(llm, calls)) });
    apply(h.ctx, cfg({ mode: 'managed', roles }));
    return { h, calls };
  };

  const visionLines = (text) => text.split('\n').filter((line) => /Vision role|^\s{2}(ok|NO IMAGES|unknown|unresolved)/.test(line));

  // -- the four verdicts ------------------------------------------------------
  {
    const { h } = visionHarness({ vision: { models: [M('OK'), M('TEXT'), M('NOTHING'), M('NOFIELD'), M('BOOM')] } }, {
      [`${PK}/OK`]: IMAGE_OK, [`${PK}/TEXT`]: TEXT_ONLY, [`${PK}/NOTHING`]: NOTHING, [`${PK}/NOFIELD`]: NO_FIELD, [`${PK}/BOOM`]: 'THROW',
    });
    const out = await h.tool().execute({ action: 'routes' });
    check('N1 `image` in the modality list is ok', /^\s{2}ok\s+pku-corpus\/OK — accepts images$/m.test(out), visionLines(out).find((line) => line.includes('/OK')), 'ok row for the image-capable model');
    check('N2 a list without `image` is a negative capability', /^\s{2}NO IMAGES\s+pku-corpus\/TEXT — declares text — image work routed here will fail$/m.test(out), visionLines(out).find((line) => line.includes('/TEXT')), 'NO IMAGES row naming the declared modalities');
    check('N2b an EMPTY modality list is NO IMAGES, not unknown', /^\s{2}NO IMAGES\s+pku-corpus\/NOTHING — declares nothing/m.test(out), visionLines(out).find((line) => line.includes('/NOTHING')), 'NO IMAGES row saying "declares nothing"');
    check('N3 a missing inputModalities key is unknown, not a failure', /^\s{2}unknown\s+pku-corpus\/NOFIELD — image support not declared$/m.test(out), visionLines(out).find((line) => line.includes('/NOFIELD')), 'unknown row for an undeclared model');
    check('N3b the unknown row does not claim the route will fail', !/NOFIELD[^\n]*will fail/.test(out), visionLines(out).find((line) => line.includes('/NOFIELD')), 'no failure wording for unknown');
    check('N4 a throwing resolveModelInfo is unresolved', /^\s{2}unresolved\s+pku-corpus\/BOOM — could not resolve \(boom\)$/m.test(out), visionLines(out).find((line) => line.includes('/BOOM')), 'unresolved row carrying the cause');
    eq('N5 the block is headed once', (out.match(/^\s*Vision role \(image capability\):$/gm) ?? []).length, 1);
    eq('N5b one row per configured model', visionLines(out).filter((line) => /^ {2}\S/.test(line)).length, 5);
    // placed between the allow-list block and the delegation-label text
    check('N5c the block sits between the allow-list and the label text', out.indexOf('Allow-list:') < out.indexOf('Vision role (image capability)') && out.indexOf('Vision role (image capability)') < out.indexOf('Delegation labels'), [out.indexOf('Allow-list:'), out.indexOf('Vision role'), out.indexOf('Delegation labels')], 'allow-list < vision < labels');
  }

  // -- the probe is targeted, and runs at boot as well as in `routes` ---------
  // NOTE: `resolveModelInfo` is deliberately invoked twice for the same route —
  // once by the fire-and-forget boot diagnostic in attach(), once by the
  // `routes` action — so each call set is measured separately below.
  {
    const { h, calls } = visionHarness({ vision: { models: [M('OK')] }, execution: { models: [M('EXEC')] } }, { [`${PK}/OK`]: IMAGE_OK, [`${PK}/EXEC`]: IMAGE_OK });
    await sleep(15);
    eq('N6a the boot diagnostic probes the vision role too', calls.slice(), [`${PK}/OK`]);
    calls.length = 0;
    await h.tool().execute({ action: 'routes' });
    eq('N6 `routes` probes only the vision role, once per model', calls, [`${PK}/OK`]);
  }
  {
    const { h, calls } = visionHarness({ vision: { models: [] }, execution: { models: [M('EXEC')] } }, { [`${PK}/EXEC`]: TEXT_ONLY });
    await sleep(15);
    eq('N6b the vision fallback onto execution is probed at boot', calls.slice(), [`${PK}/EXEC`]);
    calls.length = 0;
    const out = await h.tool().execute({ action: 'routes' });
    eq('N6d ... and by `routes`', calls, [`${PK}/EXEC`]);
    check('N6c the fallback route is reported under the vision heading', /NO IMAGES\s+pku-corpus\/EXEC/.test(out), visionLines(out)[1], 'NO IMAGES row for the execution route');
    info('N6c  with `roles.vision` empty the capability block audits the execution route it falls back onto, without the `(via execution)` marker the role table uses. Correct conclusion (image work would fail), slightly ambiguous label.');
    info('N6e  the same route is resolved twice per session start (boot diagnostic) and again per `routes` call: no memoisation of resolveModelInfo. Fine for a diagnostic action, worth knowing it is an adapter round-trip each time.');
  }

  // -- no llm service at all --------------------------------------------------
  {
    const { h } = visionHarness({ vision: { models: [M('OK')] } }, undefined);
    const out = await h.tool().execute({ action: 'routes' });
    check('N7 no llm service → the single "not checked" line', out.includes('Vision role: not checked (no llm service in this composition).') && !out.includes('Vision role (image capability)'), visionLines(out), 'not-checked line');
  }
  {
    const { h } = visionHarness({ vision: { models: [M('OK')] } }, 'BROKEN_OBJECT');
    const out = await h.tool().execute({ action: 'routes' });
    check('N7b an llm service without resolveModelInfo → "not checked"', out.includes('Vision role: not checked'), visionLines(out), 'not-checked line');
  }

  // -- D7 (fixed): the three causes of "no vision check" are distinguishable ---
  {
    const { h } = visionHarness({}, { [`${PK}/ANY`]: IMAGE_OK });
    const out = await h.tool().execute({ action: 'routes' });
    check('N8 an llm service present must not be reported as absent', !out.includes('no llm service in this composition'), visionLines(out)[0], 'a cause-accurate note');
    check('N8b no routes configured is reported as such', out.includes('Vision role: no route configured, so image-labelled delegations have no dedicated model'), visionLines(out).join('\n'), 'no-routes note');
    check('N8c and it names the actual consequence', out.includes("inherit the delegating parent's route"), out.split('\n').find((line) => line.includes('inherit the delegating')), 'consequence line');
    check('N8d no capability rows are printed for an unconfigured role', !out.includes('Vision role (image capability)'), visionLines(out), 'no checked-block');

    const noService = await visionHarness({ vision: { models: [M('OK')] } }, undefined).h.tool().execute({ action: 'routes' });
    const noRoutes = out;
    check('N8e "no-service" and "no-routes" never produce the same string', !noService.includes('no route configured') && !noRoutes.includes('no llm service'), [noService.split('\n').find((line) => line.startsWith('Vision role')), noRoutes.split('\n').find((line) => line.startsWith('Vision role'))], 'two distinct notes');
    check('N8f "no-service" still claims the service is missing', noService.includes('Vision role: not checked (no llm service in this composition).'), noService.split('\n').find((line) => line.startsWith('Vision role')), 'not-checked line');
    info('N8 observed with an llm service present and no role routes: "' + (visionLines(out)[0] ?? '').trim() + '"');
  }

  // -- boot-time warning: only for a real negative capability ------------------
  {
    const { h } = visionHarness({ vision: { models: [M('TEXT'), M('BOOM'), M('NOFIELD'), M('OK')] } }, { [`${PK}/TEXT`]: TEXT_ONLY, [`${PK}/BOOM`]: 'THROW', [`${PK}/NOFIELD`]: NO_FIELD, [`${PK}/OK`]: IMAGE_OK });
    await sleep(15);
    const warns = h.state.logs.filter((entry) => entry[0] === 'warn' && String(entry[2]).includes('image'));
    eq('N9 the boot diagnostic warns once, for no-images routes only', warns.length, 1);
    const bootImage = String(warns[0]?.[2] ?? '');
    check('N9b it names the failing route', bootImage.includes(`${PK}/TEXT`), bootImage, 'names pku-corpus/TEXT');
    check('N9c it does not name ok/unknown/unresolved routes', !bootImage.includes(`${PK}/OK`) && !bootImage.includes(`${PK}/BOOM`) && !bootImage.includes(`${PK}/NOFIELD`), bootImage, 'only the negative-capability route');
    check('N9d it tells the user what to change', bootImage.includes('roles.vision.models'), bootImage, 'points at roles.vision.models');
  }
  {
    const { h } = visionHarness({ vision: { models: [M('OK')] } }, { [`${PK}/OK`]: IMAGE_OK });
    await sleep(15);
    eq('N9e an image-capable vision role logs no capability warning', h.state.logs.filter((entry) => String(entry[2]).includes('image')).length, 0);
  }

  // -- the fire-and-forget boot path must never reject unobserved --------------
  {
    let threw;
    try {
      visionHarness({ vision: { models: [M('BOOM')] } }, { [`${PK}/BOOM`]: 'THROW' });
    } catch (error) {
      threw = error;
    }
    check('N10 apply does not throw when resolveModelInfo rejects', threw === undefined, threw?.message, 'no throw');
    const before = unhandled.length;
    await sleep(20);
    eq('N10b a rejecting resolveModelInfo produces no unhandled rejection', unhandled.length, before);

    // and a synchronous throw from the getter, plus a service that returns junk
    let threw2;
    try {
      const h2 = makeCtx({ llm: { resolveModelInfo: () => { throw new Error('sync boom'); } } });
      apply(h2.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('X')] } } }));
    } catch (error) {
      threw2 = error;
    }
    check('N10c a synchronously throwing resolveModelInfo does not break apply', threw2 === undefined, threw2?.message, 'no throw');
    await sleep(20);
    eq('N10d ... and still no unhandled rejection', unhandled.length, before);

    // resolveModelInfo resolving to undefined / a non-object must be `unknown`
    const h3 = makeCtx({ llm: { resolveModelInfo: async () => undefined } });
    apply(h3.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('U')] } } }));
    const outU = await h3.tool().execute({ action: 'routes' });
    check('N11 resolving to undefined is unknown, not a crash', /unknown\s+pku-corpus\/U — image support not declared/.test(outU), visionLines(outU)[1], 'unknown row');
    const h4 = makeCtx({ llm: { resolveModelInfo: async () => ({ inputModalities: 'image' }) } });
    apply(h4.ctx, cfg({ mode: 'managed', roles: { vision: { models: [M('S')] } } }));
    const outS = await h4.tool().execute({ action: 'routes' });
    check('N11b a non-array inputModalities is unknown (string is not a list)', /unknown\s+pku-corpus\/S/.test(outS), visionLines(outS)[1], 'unknown row, not ok');
  }

  // -- the request waterfall must not wait on the capability probe -------------
  {
    // A never-settling probe (no timer, so the process can still exit): if the
    // waterfall awaited `visionReport()`, routing would hang forever.
    const h = makeCtx({ llm: { resolveModelInfo: () => new Promise(() => {}) } });
    apply(h.ctx, cfg({ mode: 'managed', roles: { execution: { models: [M('EXEC')] }, vision: { models: [M('SLOW')] } } }));
    const p = addParent(h.world, 'p-vision', M('default'));
    const c = addChild(h.world, p, 'vis00001-child', 'read the screenshot', M('default'));
    const raced = await Promise.race([
      h.request(c, M('default')).then((out) => ({ out })),
      sleep(60).then(() => ({ timedOut: true })),
    ]);
    check('N12 routing does not await the capability probe', raced.timedOut === undefined, raced.timedOut === undefined ? 'routed' : 'hung on the pending probe', 'routes immediately');
    if (raced.out !== undefined) routeEq('N12b the vision route is still applied', raced.out, PK, 'SLOW');
  }
}

// ===========================================================================
section('O. live reload of a volatile-only Settings save (loader/volatile-update)');
// ===========================================================================
{
  // A volatile-only save is committed in place and the loader returns WITHOUT
  // re-running `apply`, so the config must be re-read from the same raw object
  // the harness still owns. The mock mutates that object in place, which is
  // exactly what a Settings-page save does.
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // -- (a) the config itself --------------------------------------------------
  const raw = { roles: { execution: { models: [M('OLD')] } }, strategy: { mode: 'managed' } };
  const h = makeCtx();
  apply(h.ctx, raw);
  const pA = addParent(h.world, 'p-volatile', M('SELF'));
  const cA = addChild(h.world, pA, 'vol00001-child', 'fix the typo', M('SELF'));
  routeEq('O0 before the reload the old model is used', await h.request(cA, M('SELF')), PK, 'OLD');
  raw.roles.execution.models = [M('NEW')];
  let reloadThrew;
  try {
    h.emit('loader/volatile-update');
  } catch (error) {
    reloadThrew = error;
  }
  check('O1 the reload handler does not throw', reloadThrew === undefined, reloadThrew?.message, 'no throw');
  check('O1b it logs the reload', h.state.logs.some((entry) => entry[0] === 'info' && String(entry[2]).includes('settings reloaded')), h.state.logs.map((entry) => entry[2]).filter((line) => String(line).includes('settings reloaded')).join(' | '), 'settings reloaded note');
  const routesReloaded = await h.tool().execute({ action: 'routes' });
  check('O1c the role table shows the new model', routesReloaded.includes(`${PK}/NEW`) && !routesReloaded.includes(`${PK}/OLD`), routesReloaded.split('\n').find((line) => line.startsWith('execution')), 'execution row naming pku-corpus/NEW');
  const cB = addChild(h.world, pA, 'vol00002-child', 'fix the typo', M('SELF'));
  routeEq('O1d and routing uses the new model', await h.request(cB, M('SELF')), PK, 'NEW');

  // -- (b) the keyword matchers are rebuilt -----------------------------------
  const rawK = { roles: { vision: { models: [M('VIS')] }, execution: { models: [M('EXEC')] } }, strategy: { mode: 'managed', visionKeywords: ['screenshot'] } };
  const hK = makeCtx();
  apply(hK.ctx, rawK);
  const pK = addParent(hK.world, 'p-keywords', M('SELF'));
  const shotBefore = addChild(hK.world, pK, 'vol00003-child', 'read the screenshot', M('SELF'));
  routeEq('O2 the original keyword routes the image task', await hK.request(shotBefore, M('SELF')), PK, 'VIS');
  rawK.strategy.visionKeywords = ['banana'];
  hK.emit('loader/volatile-update');
  const shotAfter = addChild(hK.world, pK, 'vol00004-child', 'read the screenshot', M('SELF'));
  routeEq('O2b the removed keyword no longer routes it', await hK.request(shotAfter, M('SELF')), PK, 'EXEC');
  const banana = addChild(hK.world, pK, 'vol00005-child', 'peel a BANANA', M('SELF'));
  routeEq('O2c the new keyword does', await hK.request(banana, M('SELF')), PK, 'VIS');
  const bananaReport = await hK.tool().execute({ action: 'report' });
  check('O2d the reloaded keywords are echoed in `routes`', (await hK.tool().execute({ action: 'routes' })).includes('banana'), (await hK.tool().execute({ action: 'routes' })).split('\n').find((line) => line.includes('vision   :')), 'keyword list');
  void bananaReport;

  // -- (c) mode + strategy changes take effect --------------------------------
  const rawM = { roles: { execution: { models: [M('ROLE')] } }, strategy: { mode: 'hybrid' } };
  const hM = makeCtx();
  apply(hM.ctx, rawM);
  const pM = addParent(hM.world, 'p-mode', M('PARENT'));
  const explicitBefore = addChild(hM.world, pM, 'vol00006-child', 'fix the typo', M('CHOSEN'));
  routeEq('O3 hybrid respects an explicit choice', await hM.request(explicitBefore, M('CHOSEN')), PK, 'CHOSEN');
  rawM.strategy.mode = 'managed';
  hM.emit('loader/volatile-update');
  routeEq('O3b managed (after reload) overrides the same explicit choice', await hM.request(explicitBefore, M('CHOSEN')), PK, 'ROLE');

  // rotation state is engine-level and must survive a reload
  const rawR = { roles: { execution: { models: [M('R1'), M('R2'), M('R3')], pick: 'round-robin' } }, strategy: { mode: 'managed' } };
  const hR = makeCtx();
  apply(hR.ctx, rawR);
  const pR = addParent(hR.world, 'p-rr-reload', M('PARENT'));
  const kidR = addChild(hR.world, pR, 'vol00007-child', 'fix the typo', M('PARENT'));
  routeEq('O4 rotation starts at R1', await hR.request(kidR, M('PARENT')), PK, 'R1');
  routeEq('O4b then R2', await hR.request(kidR, M('PARENT')), PK, 'R2');
  hR.emit('loader/volatile-update');
  routeEq('O4c a reload does not rewind the rotation', await hR.request(kidR, M('PARENT')), PK, 'R3');

  // unknown-key warnings are re-reported on reload (they are otherwise invisible)
  const rawW = { roles: { execution: { models: [M('EXEC')] }, typo: {} }, strategy: { mode: 'managed' } };
  const hW = makeCtx();
  apply(hW.ctx, rawW);
  const warnsBefore = hW.state.logs.filter((entry) => entry[0] === 'warn').length;
  hW.emit('loader/volatile-update');
  const warnsAfter = hW.state.logs.filter((entry) => entry[0] === 'warn').length;
  check('O5 config warnings are re-logged after a reload', warnsAfter > warnsBefore, [warnsBefore, warnsAfter], 'more warn logs after the event');
  check('O5b the reloaded log names the offending key', hW.state.logs.some((entry) => entry[0] === 'warn' && String(entry[2]).includes('unknown role "typo"')), hW.state.logs.map((entry) => entry[2]).filter((line) => String(line).includes('unknown')).join(' | '), 'warning naming roles typo');

  // -- (d) a config that cannot be re-read must not break routing -------------
  const rawBad = { roles: { execution: { models: [M('GOOD')] } }, strategy: { mode: 'managed' } };
  const hBad = makeCtx();
  apply(hBad.ctx, rawBad);
  // stand in for a volatile ref whose `get()` fails after the settings row moved
  Object.defineProperty(rawBad.roles, 'main', {
    enumerable: true,
    configurable: true,
    get() { throw new Error('volatile ref is gone'); },
  });
  let badThrew;
  try {
    hBad.emit('loader/volatile-update');
  } catch (error) {
    badThrew = error;
  }
  check('O6 a broken config on the reload event does not throw', badThrew === undefined, badThrew?.message, 'no throw');
  check('O6b it logs a warning naming the cause', hBad.state.logs.some((entry) => entry[0] === 'warn' && String(entry[2]).includes('could not reload settings') && String(entry[2]).includes('volatile ref is gone')), hBad.state.logs.map((entry) => entry[2]).filter((line) => String(line).includes('reload')).join(' | '), 'warn log with the cause');
  const pBad = addParent(hBad.world, 'p-broken', M('PARENT'));
  const cBad = addChild(hBad.world, pBad, 'vol00008-child', 'fix the typo', M('PARENT'));
  routeEq('O6c routing keeps the PREVIOUS config', await hBad.request(cBad, M('PARENT')), PK, 'GOOD');
  check('O6d `routes` still renders', (await hBad.tool().execute({ action: 'routes' })).includes(`${PK}/GOOD`), '(routes)', 'shows the previous model');
  await sleep(20);

  // -- (f) `applied: false` is what keeps advisory/passthrough turns from being
  //        re-adopted as manager-owned later. Observable only through a reload.
  {
    const rowOf2 = async (hh, id) => (await hh.tool().execute({ action: 'report' })).split('\n').find((line) => line.includes(id)) ?? '(no row)';

    // advisory records the route it *would* have used but must not own the child
    const rawAdv = { roles: { execution: { models: [M('E1')] } }, strategy: { mode: 'advisory' } };
    const hAdv = makeCtx();
    apply(hAdv.ctx, rawAdv);
    const pAdv = addParent(hAdv.world, 'p-advice', M('PARENT'));
    await hAdv.request(pAdv, M('PARENT'));
    const cAdv = addChild(hAdv.world, pAdv, 'vol00010-child', 'fix the typo', M('PARENT'));
    routeEq('V1 an advisory turn leaves the child route alone', await hAdv.request(cAdv, M('PARENT')), PK, 'PARENT');
    check('V2 and says so', (await rowOf2(hAdv, 'vol00010')).includes('advisory (not applied)'), await rowOf2(hAdv, 'vol00010'), 'reason "advisory (not applied)"');
    rawAdv.strategy.mode = 'hybrid';
    hAdv.emit('loader/volatile-update');
    routeEq('V3 once hybrid, the same child IS routed', await hAdv.request(cAdv, M('PARENT')), PK, 'E1');
    check('V4 as a fresh apply, not as a manager-owned adoption', /\s+applied\s+running/.test(await rowOf2(hAdv, 'vol00010')), await rowOf2(hAdv, 'vol00010'), 'reason column exactly "applied"');
    check('V5 the advisory turn never made the manager own the route', !/applied \(manager-owned\)/.test(await rowOf2(hAdv, 'vol00010')), await rowOf2(hAdv, 'vol00010'), 'no manager-owned reason');

    // passthrough (role unconfigured) must not own the child either
    const rawPass = { roles: { execution: { models: [] } }, strategy: { mode: 'hybrid' } };
    const hPass = makeCtx();
    apply(hPass.ctx, rawPass);
    const pPass = addParent(hPass.world, 'p-passthru', M('PARENT'));
    await hPass.request(pPass, M('PARENT'));
    const cPass = addChild(hPass.world, pPass, 'vol00011-child', 'fix the typo', M('PARENT'));
    routeEq('V6 an unconfigured role passes the child route through', await hPass.request(cPass, M('PARENT')), PK, 'PARENT');
    check('V7 with the passthrough reason', (await rowOf2(hPass, 'vol00011')).includes('passthrough (role unconfigured)'), await rowOf2(hPass, 'vol00011'), 'reason "passthrough (role unconfigured)"');
    rawPass.roles.execution.models = [M('E1')];
    hPass.emit('loader/volatile-update');
    routeEq('V8 configuring the role afterwards routes the same child', await hPass.request(cPass, M('PARENT')), PK, 'E1');
    check('V9 and the passthrough turn did not make it manager-owned', !/applied \(manager-owned\)/.test(await rowOf2(hPass, 'vol00011')) && /\s+applied\s+running/.test(await rowOf2(hPass, 'vol00011')), await rowOf2(hPass, 'vol00011'), 'reason column exactly "applied"');
  }

  // -- (e) the reload path is synchronous, but guard the rejection hazard -----
  eq('O7 the reload produced no unhandled rejection', unhandled.length, 0);

  // a second, unrelated listener set must not double-apply
  const hDupEmit = makeCtx();
  const rawDup = { roles: { execution: { models: [M('X1')] } }, strategy: { mode: 'managed' } };
  apply(hDupEmit.ctx, rawDup);
  rawDup.roles.execution.models = [M('X2')];
  hDupEmit.emit('loader/volatile-update');
  hDupEmit.emit('loader/volatile-update');
  hDupEmit.emit('loader/volatile-update');
  const pDup = addParent(hDupEmit.world, 'p-dup', M('PARENT'));
  const cDup = addChild(hDupEmit.world, pDup, 'vol00009-child', 'fix the typo', M('PARENT'));
  routeEq('O8 repeated volatile updates are idempotent', await hDupEmit.request(cDup, M('PARENT')), PK, 'X2');
}

// ===========================================================================
// summary
// ===========================================================================
await new Promise((resolve) => setTimeout(resolve, 30));
check('Z1 the plugin never produced an unhandled rejection', unhandled.length === 0, unhandled.join(' | '), 'no unhandled rejections');
console.log('\n===================================================================');
console.log(`TALLY: ${PASS} passed, ${FAIL} failed, ${PASS + FAIL} total`);
if (infos.length > 0) {
  console.log(`\nINFO (${infos.length} behavioural observations, not counted as failures):`);
  for (const line of infos) console.log(`  - ${line}`);
}
if (FAIL > 0) {
  console.log(`\nFAILURES (${FAIL}):`);
  for (const failure of failures) {
    console.log(`  * ${failure.label}`);
    console.log(`      observed: ${failure.observed}`);
    console.log(`      expected: ${failure.expected}`);
  }
  process.exitCode = 1;
}
