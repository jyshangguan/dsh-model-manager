/**
 * Planning-skill escalation suite for @darkbear9494/dsh-model-manager (0.5.0).
 *
 * The feature under test: a top-level session that invokes the `grilling` or
 * `grill-me` skill runs on the `planning` tier for the rest of the session,
 * exactly like plan mode. Three halves must agree:
 *
 *   - a pure fold (`skillNamesOfEvent`) reading skill names off durable events —
 *     the shared vocabulary of the projection and the pre-step scan;
 *   - the LIVE signal: `agent/pre-step`, registered PREPENDED so its `next()`
 *     returns the decision with the harness's own skill injections, records the
 *     names of the batch before `agent/request` runs — which is what routes the
 *     FIRST request of a `/grilling` turn (dsh-agent-loop commits the user
 *     batch, injection included, only after `agent/request` returns);
 *   - the DURABLE signal: the `modelManagerPlanningSkill` projection folded from
 *     the session log, which carries the trigger across restart, resume and
 *     fork, and catches a model-invoked `skill` tool call on a later request.
 *
 * The mock context mirrors the real seams read out of the install:
 * dsh-agent-loop's `preStep()` dispatches `agent/pre-step` with
 * `{ agent, messages, turn, step, signal }` and a
 * `{ kind: 'enter' | 'reject', messages }` decision, and the scoped dispatcher
 * fuses `agent` into the payload (dsh-agent/dispatch: "the scope key and the
 * payload's `agent` cannot diverge"). The `sessionProjections` mock folds
 * `session.events` through the definitions the plugin itself registers — the
 * same contract the real projection layer honours — so a durable signal is
 * observable without a second process.
 *
 * Run: node test/planning-skills.test.mjs   (or: npm test)
 */
import { readFileSync } from 'node:fs';

import { PLUGIN, dshFile } from './paths.mjs';

const plugin = await import(PLUGIN);
const { readConfig, skillNamesOfEvent, DEFAULT_PLANNING_SKILLS } = plugin;

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
  check(label, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got), JSON.stringify(want));
const routeEq = (label, got, want) =>
  check(label, got?.provider === want.provider && got?.model === want.model,
    `${got?.provider}/${got?.model}`, `${want.provider}/${want.model}`);
const throws = (fn) => {
  try { fn(); return false; } catch { return true; }
};

// ---------------------------------------------------------------------------
// mock world
// ---------------------------------------------------------------------------
const PK = 'pku-corpus';
// One unmistakable model per tier, so an applied route identifies its role.
const MAIN = { provider: PK, model: 'main-tier' };
const PLAN = { provider: PK, model: 'planning-tier' };
const EXEC = { provider: PK, model: 'execution-tier' };
const VISION = { provider: PK, model: 'vision-tier' };
// The deployment default a top-level session rides before `main` rewrites it.
const DEFAULT_ROUTE = { provider: PK, model: 'session-default' };
// A route a person picked in the composer; `main` must never overwrite it.
const COMPOSER = { provider: 'user-picked', model: 'composer-choice' };

/** Plugin config with every tier configured; strategy overrides come in. */
const config = (strategy = {}, roles = {}) => ({
  roles: {
    main: { models: [MAIN] },
    planning: { models: [PLAN] },
    execution: { models: [EXEC] },
    vision: { models: [VISION] },
    ...roles,
  },
  strategy: { mode: 'hybrid', ...strategy },
  // No update checks: a test process must never reach the network.
  update: { enabled: false },
});

/** A direct user message whose only text block says `text`. */
const userText = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
/** DSH's own validated skill injection (tool-skill's pre-step decision message). */
const skillInjection = (name) => ({ source: { kind: 'skill-invocation', name, form: 'instructions' } });
const ev = (type, data) => ({ type, data });
/** A top-level agent: no subagent origin, optional durable log to resume from. */
const topAgent = (id, events) => ({
  id,
  options: { ...DEFAULT_ROUTE },
  status: 'running',
  __plan: false,
  session: { header: {}, events: events ?? [] },
});

/**
 * One engine with its own handler map, projection registry and agent roster.
 *
 * @param raw - plugin config handed to `apply` (kept mutable: the volatile
 *              reload test edits it in place, the way a Settings save does).
 * @param options.projections - `false` removes the sessionProjections service.
 * @param options.stateOf - per-key answers that override the folded state.
 */
function harness(raw, options = {}) {
  const handlers = new Map();
  const registrations = [];
  const registered = new Map();
  const tools = [];
  const roster = [];
  const childRows = [];
  const logs = [];
  const services = {
    agents: {
      list: () => roster.slice(),
      get: (id) => roster.find((agent) => agent.id === id),
      isOwnedBy: (childId, owner) => childRows.some((row) => row.id === childId && row.parentId === owner.id),
    },
    subagents: { listChildren: async (parentId) => childRows.filter((row) => row.parentId === parentId) },
    subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
    planMode: { get: (agent) => ({ active: agent.__plan === true }) },
    tools: { register: (tool) => tools.push(tool) },
    systemPrompt: { section: () => () => {} },
  };
  if (options.projections !== false) {
    services.sessionProjections = {
      register: (definition) => { registered.set(definition.key, definition); return () => {}; },
      stateOf: (session, key) => {
        const definition = registered.get(key);
        // A key the registry never received answers undefined, per its contract.
        if (definition === undefined) return undefined;
        if (options.stateOf !== undefined && Object.hasOwn(options.stateOf, key)) return options.stateOf[key];
        let state = definition.init(session, 0);
        for (const event of Array.isArray(session?.events) ? session.events : []) {
          state = definition.apply(state, event);
        }
        return state;
      },
    };
  }
  const ctx = {
    logger: () => ({
      info: (message) => logs.push(['info', message]),
      warn: (message) => logs.push(['warn', message]),
      error: (message) => logs.push(['error', message]),
    }),
    get: (name) => services[name],
    // Capture the registration options: the pre-step listener's `prepend` is
    // the difference between seeing the harness's skill injections and not.
    on: (event, handler, opts) => { handlers.set(event, handler); registrations.push({ event, opts }); },
    inject: (deps, cb) => {
      const scoped = Object.create(ctx);
      let ready = true;
      for (const dep of deps) {
        if (services[dep] === undefined) ready = false;
        scoped[dep] = services[dep];
      }
      if (ready) cb(scoped);
    },
    effect: (fn) => { fn(); },
  };
  plugin.apply(ctx, raw);

  /** The agent/pre-step seam, exactly as dsh-agent-loop drives it. */
  const preStep = (agent, messages, decision) => handlers.get('agent/pre-step')(
    { agent, messages, turn: 1, step: 1, signal: undefined },
    async () => decision ?? { kind: 'enter', messages: [] },
  );
  /** The same seam with a fully caller-shaped payload (hostile inputs). */
  const preStepRaw = (payload, decision) => handlers.get('agent/pre-step')(payload, async () => decision);
  const request = (agent, resolved = DEFAULT_ROUTE, turn = 1) =>
    handlers.get('agent/request')({ agent, turn, step: 1, signal: undefined }, async () => resolved);
  const emit = (event, ...args) => handlers.get(event)?.(...args);

  return {
    handlers, registrations, registered, tools, logs, roster, childRows,
    preStep, preStepRaw, request, emit,
    add: (agent) => { roster.push(agent); return agent; },
    tool: () => tools.find((candidate) => candidate.name === 'model_manager'),
  };
}

// ===========================================================================
console.log('--- A. the pure event fold (skillNamesOfEvent) ---');
// ===========================================================================
{
  // The canonical record: DSH's own validated injection.
  eq('A1  a skill-invocation message records its name',
    skillNamesOfEvent(ev('user/message', skillInjection('grilling'))), ['grilling']);
  // The raw gesture, before any injection exists.
  eq('A2  a /grilling gesture in direct user text records the name',
    skillNamesOfEvent(ev('user/message', userText('stress-test this plan /grilling now'))), ['grilling']);
  eq('A3  several gestures in one text block are recorded in order',
    skillNamesOfEvent(ev('user/message', userText('/grilling and /office please'))), ['grilling', 'office']);
  eq('A4  /grill-me is recorded with surrounding whitespace',
    skillNamesOfEvent(ev('user/message', userText('  /grill-me  '))), ['grill-me']);
  // A message may carry several blocks; only text blocks are scanned.
  eq('A5  a gesture in a later text block of the same message is still found',
    skillNamesOfEvent(ev('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'image', url: 'x' }, { type: 'text', text: 'nothing here' }, { type: 'text', text: 'yes /office' }],
    })), ['office']);

  // Gesture boundary rules — the harness's own grammar, not a looser one.
  eq('A6  /usr/bin is not a gesture (a slash cannot follow the name)',
    skillNamesOfEvent(ev('user/message', userText('run /usr/bin/env now'))), []);
  eq('A7  a/grilling is not a gesture (the slash needs a word boundary before it)',
    skillNamesOfEvent(ev('user/message', userText('see a/grilling here'))), []);
  eq('A8  leading and trailing whitespace are word boundaries',
    skillNamesOfEvent(ev('user/message', userText('\t/grilling\n'))), ['grilling']);
  eq('A9  punctuation glued to the name is not a boundary',
    skillNamesOfEvent(ev('user/message', userText('see /grilling, then stop'))), []);

  // Non-user sources never record: only the user's own invocations escalate.
  eq('A10 skill-catalog, model and tool sources are ignored',
    [
      skillNamesOfEvent(ev('user/message', { source: { kind: 'skill-catalog', name: 'grilling' } })),
      skillNamesOfEvent(ev('user/message', { source: { kind: 'model' }, content: [{ type: 'text', text: '/grilling' }] })),
      skillNamesOfEvent(ev('user/message', { source: { kind: 'tool' }, content: [{ type: 'text', text: '/grilling' }] })),
    ], [[], [], []]);

  // The model-invoked skill tool call.
  eq('A11 a tool/call of the skill tool with JSON arguments records the name',
    skillNamesOfEvent(ev('tool/call', { name: 'skill', arguments: '{"name":"grilling"}' })), ['grilling']);
  eq('A12 malformed JSON arguments record nothing',
    skillNamesOfEvent(ev('tool/call', { name: 'skill', arguments: '{"name": "grilling' })), []);
  eq('A13 a tool/call of another tool is ignored',
    skillNamesOfEvent(ev('tool/call', { name: 'bash', arguments: '{"name":"grilling"}' })), []);
  eq('A14 a tool/call with non-string arguments is ignored',
    skillNamesOfEvent(ev('tool/call', { name: 'skill', arguments: { name: 'grilling' } })), []);
  eq('A15 a tool/call with no name in its arguments records nothing',
    skillNamesOfEvent(ev('tool/call', { name: 'skill', arguments: '{"verbose":true}' })), []);

  // Hostile shapes: never throw, never record.
  eq('A16 null, {} and missing data never throw and record nothing',
    [skillNamesOfEvent(null), skillNamesOfEvent({}), skillNamesOfEvent(ev('user/message')),
      skillNamesOfEvent(ev('tool/call')), skillNamesOfEvent(ev('user/message', null)),
      skillNamesOfEvent(ev('tool/call', null))], [[], [], [], [], [], []]);
  eq('A17 a non-text block carrying gesture-looking text is ignored',
    skillNamesOfEvent(ev('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'image', text: '/grilling' }, { type: 'text', text: 42 }],
    })), []);
  eq('A18 a skill-invocation source with a non-string name records nothing',
    skillNamesOfEvent(ev('user/message', { source: { kind: 'skill-invocation', name: 42 } })), []);
  eq('A19 an unknown event type records nothing',
    skillNamesOfEvent(ev('assistant/message', { source: { kind: 'skill-invocation', name: 'grilling' } })), []);
}

// The manager must recognise exactly the gestures the harness itself turns
// into a skill invocation, so pin the grammar against dsh-tool-skill's own
// literal (byte-identical, per the plugin's own design note).
{
  const DSH_TOOL_SKILL = dshFile('dsh-tool-skill', 'lib/index.js');
  if (DSH_TOOL_SKILL === undefined) {
    console.log('WARN  no DSH installation found (set DSH_INSTALL_DIR); the gesture-grammar pin is skipped');
  } else {
    const literal = (source) => (source.match(/const SKILL_GESTURE = (.+);/) ?? [])[1];
    const mine = literal(readFileSync(PLUGIN, 'utf8'));
    const harnessLiteral = literal(readFileSync(DSH_TOOL_SKILL, 'utf8'));
    check('A20 the gesture grammar is byte-identical to dsh-tool-skill\'s',
      mine !== undefined && mine === harnessLiteral, `${mine ?? '(not found)'} vs ${harnessLiteral ?? '(not found)'}`);
  }
}

// ===========================================================================
console.log('\n--- B. strategy.planningSkills configuration ---');
// ===========================================================================
{
  eq('B1  an absent planningSkills takes the built-in default',
    readConfig({}).strategy.planningSkills, ['grill-me', 'grilling']);
  eq('B2  DEFAULT_PLANNING_SKILLS is exported with exactly that default',
    DEFAULT_PLANNING_SKILLS, ['grill-me', 'grilling']);
  eq('B3  an explicit [] is honoured and disables the escalation',
    readConfig({ strategy: { planningSkills: [] } }).strategy.planningSkills, []);
  eq('B4  a custom list is lowercased, trimmed, deduped and invalid names dropped',
    readConfig({ strategy: { planningSkills: ['Grilling', 'GRILLING', 'office-docx', 'Bad_Name', 7, '', '  grill-me  ', 'a/b'] } })
      .strategy.planningSkills, ['grilling', 'office-docx', 'grill-me']);
  eq('B5  a non-array value falls back to the default',
    readConfig({ strategy: { planningSkills: 'grilling' } }).strategy.planningSkills, ['grill-me', 'grilling']);
  eq('B6  a volatile ref wrapping the list is unwrapped',
    readConfig({ strategy: { get: () => ({ planningSkills: ['office'] }) } }).strategy.planningSkills, ['office']);
  // The key is a known strategy key: a valid value must not produce a warning.
  eq('B7  a configured list produces no unknown-key warning',
    readConfig({ strategy: { planningSkills: ['office'] } }).warnings, []);
  eq('B8  the disabling [] produces no unknown-key warning',
    readConfig({ strategy: { planningSkills: [] } }).warnings, []);

  if (plugin.Config === undefined) {
    console.log('WARN  the Config schema is unavailable (schemastery did not resolve); schema checks are skipped');
  } else {
    eq('B9  the schema-validated config carries the list through',
      readConfig(new plugin.Config({ strategy: { planningSkills: ['office'] } })).strategy.planningSkills, ['office']);
    eq('B10 a schema-validated empty config defaults to the built-in list',
      readConfig(new plugin.Config({})).strategy.planningSkills, ['grill-me', 'grilling']);
    check('B11 the schema rejects a non-array planningSkills',
      throws(() => new plugin.Config({ strategy: { planningSkills: 'grilling' } })), 'the schema accepted a string');
  }
}

// ===========================================================================
console.log('\n--- C. the modelManagerPlanningSkill projection ---');
// ===========================================================================
{
  const h = harness(config());
  const def = h.registered.get('modelManagerPlanningSkill');
  check('C1  the projection is registered under its key', def !== undefined, [...h.registered.keys()].join(','));
  if (def === undefined) {
    check('C2  key and stateVersion', false, 'no definition to inspect');
  } else {
    check('C2  key and stateVersion', def.key === 'modelManagerPlanningSkill' && def.stateVersion === 1,
      `${def.key} v${def.stateVersion}`);
    eq('C3  init starts with no skills', def.init({}, 0), { skills: [] });

    // A fold that adds nothing must return the SAME reference, or the
    // projection layer republishes on every unrelated append.
    const s0 = def.init({}, 0);
    check('C4  an unrelated event returns the same state reference',
      def.apply(s0, { type: 'request/header', data: { config: { provider: 'p', model: 'm' } } }) === s0);
    eq('C5  folds a user/message skill invocation',
      def.apply(s0, ev('user/message', skillInjection('grilling'))), { skills: ['grilling'] });
    eq('C6  folds a /grill-me gesture in direct user text',
      def.apply(s0, ev('user/message', userText('  /grill-me  '))), { skills: ['grill-me'] });
    eq('C7  folds a model-invoked skill tool call',
      def.apply(s0, ev('tool/call', { name: 'skill', arguments: '{"name":"office"}' })), { skills: ['office'] });
    eq('C8  mixed-case names are canonicalized by the fold',
      def.apply(s0, ev('user/message', skillInjection('GRILL-ME'))), { skills: ['grill-me'] });
    const once = def.apply(s0, ev('user/message', skillInjection('grilling')));
    check('C9  an already-known name returns the same state reference',
      def.apply(once, ev('user/message', skillInjection('Grilling'))) === once);
    check('C10 a later unrelated event still returns the same reference',
      def.apply(once, { type: 'assistant/message', data: {} }) === once);

    // The wire gate: only canonical, lowercase, kebab-shaped names survive.
    check('C11 stateSchema rejects null', throws(() => def.stateSchema.parse(null)));
    check('C12 stateSchema rejects a missing skills array', throws(() => def.stateSchema.parse({})));
    check('C13 stateSchema rejects a non-string entry', throws(() => def.stateSchema.parse({ skills: [7] })));
    check('C14 stateSchema rejects an invalid kebab name',
      throws(() => def.stateSchema.parse({ skills: ['not valid!'] }))
        && throws(() => def.stateSchema.parse({ skills: ['a/b'] })));
    eq('C15 stateSchema canonicalizes a mixed-case list',
      def.stateSchema.parse({ skills: ['Grilling', 'GRILL-ME', 'grilling'] }), { skills: ['grilling', 'grill-me'] });
  }
}

// ===========================================================================
console.log('\n--- D. the live pre-step signal routes the FIRST request ---');
// ===========================================================================
{
  // The ordering contract itself: prepended registration is what makes next()
  // return the decision WITH the harness's own skill injections.
  const h0 = harness(config());
  const preReg = h0.registrations.find((r) => r.event === 'agent/pre-step');
  check('D1  the pre-step listener is registered prepended',
    preReg !== undefined && preReg.opts?.prepend === true, JSON.stringify(preReg?.opts));
  check('D2  the pre-step listener is registered beside agent/request',
    h0.registrations.some((r) => r.event === 'agent/request'), 'no agent/request listener');
}

{
  // Raw gesture only in payload.messages: no injection anywhere — the state of
  // the very first request of a /grilling turn, before the batch is committed.
  const h = harness(config());
  const a = h.add(topAgent('d3'));
  routeEq('D3  before any gesture the session rides main', await h.request(a), MAIN);
  await h.preStep(a, [userText('stress-test my plan /grilling')]);
  routeEq('D4  a raw /grilling gesture routes the FIRST request planning', await h.request(a), PLAN);
}

{
  // The injection only in the decision the inner hooks (tool-skill) produced.
  const h = harness(config());
  const a = h.add(topAgent('d5'));
  await h.preStep(a, [userText('think hard about this')], {
    kind: 'enter',
    messages: [userText('think hard about this'), skillInjection('grilling')],
  });
  routeEq('D5  a skill-invocation injection in decision.messages routes planning', await h.request(a), PLAN);
}

{
  const h = harness(config());
  const a = h.add(topAgent('d6'));
  await h.preStep(a, [userText('  /grill-me  ')]);
  routeEq('D6  a /grill-me gesture routes planning', await h.request(a), PLAN);
  // Sticky: the skill's instructions stay in context for the whole session.
  await h.preStep(a, [userText('next question please')]);
  routeEq('D7  a later plain turn is still planning (sticky)', await h.request(a, undefined, 2), PLAN);
  routeEq('D8  a later request with no pre-step at all is still planning', await h.request(a, undefined, 3), PLAN);
}

{
  const h = harness(config());
  const a = h.add(topAgent('d9'));
  await h.preStep(a, [userText('/office the spreadsheet')]);
  routeEq('D9  a non-listed skill (/office) leaves the session on main', await h.request(a), MAIN);
}

{
  const h = harness(config({ planningSkills: [] }));
  const a = h.add(topAgent('d10'));
  await h.preStep(a, [userText('/grilling everything')]);
  routeEq('D10 planningSkills: [] disables the escalation even after a gesture', await h.request(a), MAIN);
}

{
  // A custom list swaps which skills escalate; nothing is hardcoded.
  const h = harness(config({ planningSkills: ['office'] }));
  const office = h.add(topAgent('d11a'));
  const grill = h.add(topAgent('d11b'));
  await h.preStep(office, [userText('/office the spreadsheet')]);
  await h.preStep(grill, [userText('/grilling everything')]);
  routeEq('D11 a custom list routes the listed skill planning', await h.request(office), PLAN);
  routeEq('D12 a custom list leaves grilling on main', await h.request(grill), MAIN);
}

{
  // The observer must return the decision untouched, by identity. The enter
  // fixture carries no gesture on purpose, so the reject check below starts
  // from a clean live map.
  const h = harness(config());
  const a = h.add(topAgent('d13'));
  const enter = { kind: 'enter', messages: [] };
  const reject = { kind: 'reject', reason: 'blocked' };
  check('D13 the enter decision is returned by identity', (await h.preStep(a, [], enter)) === enter);
  check('D14 the reject decision is returned by identity', (await h.preStep(a, [], reject)) === reject);
  // A rejected step never runs, so its messages must not be scanned either.
  await h.preStep(a, [userText('hello there')], { kind: 'reject', messages: [skillInjection('grilling')] });
  routeEq('D15 a reject decision\'s messages are not scanned', await h.request(a), MAIN);
}

{
  // Hostile pre-step payloads: observe-only means never failing the step.
  const h = harness(config());
  const a = h.add(topAgent('d16'));
  const decision = { kind: 'enter', messages: [] };
  const survives = async (label, payload, out = decision) => {
    let thrown;
    let returned;
    try { returned = await h.preStepRaw(payload, out); } catch (error) { thrown = error; }
    check(label, thrown === undefined && returned === out, thrown?.message ?? 'decision not returned by identity');
  };
  await survives('D16 no payload at all never throws and returns the decision', undefined);
  await survives('D17 no agent in the payload never throws', {});
  await survives('D18 a non-string agent never throws', { agent: 'agent-id', messages: [userText('/grilling')] });
  await survives('D19 messages that is not an array never throws', { agent: a, messages: 'not-an-array' });
  await survives('D20 garbage entries in the batch never throw',
    { agent: a, messages: [null, 7, 'x', { source: null }, { source: 42 }] });
  await survives('D21 garbage content blocks never throw',
    {
      agent: a,
      messages: [{
        source: { kind: 'user' },
        content: [null, 'x', 42, { type: 'text' }, { type: 'text', text: 42 }, { type: 'text', text: null }, { type: 'image', text: '/grilling' }],
      }],
    });
  await survives('D22 a garbage decision.messages never throws', { agent: a, messages: [] },
    { kind: 'enter', messages: [null, 'x', { source: undefined }, { content: 'x' }] });
  routeEq('D23 nothing was recorded from the hostile batches', await h.request(a), MAIN);
  // And one real gesture inside a hostile batch still records: garbage around
  // the content must not blind the scan.
  await survives('D24 a valid gesture inside a hostile batch never throws',
    { agent: a, messages: [null, 'x', { source: { kind: 'user' }, content: [42, { type: 'text', text: ' /grilling ' }] }] });
  routeEq('D25 the valid gesture inside the hostile batch still escalates', await h.request(a, undefined, 2), PLAN);
}

{
  // A subagent is not a planning-skill candidate: only the top-level session
  // escalates, and a delegated child keeps going by its label.
  const h = harness(config());
  const parent = h.add(topAgent('d26-parent'));
  const child = {
    id: 'd26-child',
    options: { ...DEFAULT_ROUTE },
    status: 'running',
    session: { header: { origin: 'subagent' }, events: [] },
  };
  h.add(child);
  h.childRows.push({ id: child.id, parentId: parent.id, label: '', mode: 'one-shot', createdAt: 1 });
  await h.preStep(child, [userText('/grilling this plan hard')]);
  routeEq('D26 a subagent is NOT escalated by a gesture (empty label -> execution)', await h.request(child), EXEC);
  await h.preStep(parent, [userText('/grilling this plan hard')]);
  routeEq('D27 the same gesture on the top-level parent does escalate', await h.request(parent), PLAN);
}

{
  // agent/disposed drops the live signal; the durable fold is what survives.
  const h = harness(config());
  const a = h.add(topAgent('d28'));
  await h.preStep(a, [userText('/grilling')]);
  routeEq('D28 the gesture routes planning before disposal', await h.request(a), PLAN);
  h.emit('agent/disposed', { agent: a });
  routeEq('D29 agent/disposed drops the live signal (no durable event -> main)', await h.request(a, undefined, 2), MAIN);
}

{
  // A Settings save re-reads the live config: [] must apply to the very next
  // request, with no restart and no re-apply.
  const raw = config();
  const h = harness(raw);
  const a = h.add(topAgent('d30'));
  await h.preStep(a, [userText('/grilling')]);
  routeEq('D30 the gesture routes planning before the settings edit', await h.request(a), PLAN);
  raw.strategy.planningSkills = [];
  h.emit('loader/volatile-update');
  routeEq('D31 a volatile reload of planningSkills: [] applies to the next request', await h.request(a, undefined, 2), MAIN);
}

{
  // The info line is a switch notice, not a per-request drumbeat.
  const h = harness(config());
  const a = h.add(topAgent('d32'));
  await h.preStep(a, [userText('/grilling')]);
  await h.request(a);
  await h.request(a, undefined, 2);
  await h.request(a, undefined, 3);
  const notices = h.logs.filter(([level, message]) => level === 'info' && String(message).includes('planning skill "grilling"'));
  check('D32 the info notice fires once per switch, not per request', notices.length === 1,
    `${notices.length} notices`);
}

// ===========================================================================
console.log('\n--- E. the durable projection signal (resume, restart, fork) ---');
// ===========================================================================
{
  // No pre-step runs in these harnesses: the only signal is session.events,
  // exactly what a resumed session brings into a fresh process.
  const h = harness(config());
  const resumed = h.add(topAgent('e1', [ev('user/message', skillInjection('grilling'))]));
  routeEq('E1  a resumed session with a logged skill invocation routes planning', await h.request(resumed), PLAN);
  const gestured = h.add(topAgent('e2', [ev('user/message', userText('  /grill-me  '))]));
  routeEq('E2  a resumed session with a logged gesture routes planning', await h.request(gestured), PLAN);
  const toolCalled = h.add(topAgent('e3', [ev('tool/call', { name: 'skill', arguments: '{"name":"grilling"}' })]));
  routeEq('E3  a logged model-invoked skill tool call escalates the next request', await h.request(toolCalled), PLAN);
}

{
  // The durable signal is bounded by the live config, exactly like the live one.
  const h = harness(config({ planningSkills: [] }));
  const resumed = h.add(topAgent('e4', [ev('user/message', skillInjection('grilling'))]));
  routeEq('E4  a durable skill is inert once planningSkills is []', await h.request(resumed), MAIN);
}

{
  // Live and durable signals merge: either source can put the session planning.
  const h = harness(config());
  const a = h.add(topAgent('e5', [ev('user/message', skillInjection('grilling'))]));
  await h.preStep(a, [userText('/office the spreadsheet')]);
  routeEq('E5  the durable listed name escalates even when the live gesture is unlisted', await h.request(a), PLAN);
}

{
  // No sessionProjections service in the composition: no throw, and the live
  // signal alone (here: none) leaves main in charge.
  const handlers = new Map();
  const services = {
    agents: { list: () => [], get: () => undefined, isOwnedBy: () => false },
    subagents: { listChildren: async () => [] },
    subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
    planMode: { get: () => ({ active: false }) },
    tools: { register: () => {} },
    systemPrompt: { section: () => () => {} },
  };
  const ctx = {
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
    get: (name) => services[name],
    on: (event, handler) => handlers.set(event, handler),
    inject: (deps, cb) => {
      const scoped = Object.create(ctx);
      let ready = true;
      for (const dep of deps) {
        if (services[dep] === undefined) ready = false;
        scoped[dep] = services[dep];
      }
      if (ready) cb(scoped);
    },
    effect: (fn) => { fn(); },
  };
  plugin.apply(ctx, config());
  const a = topAgent('e6', [ev('user/message', skillInjection('grilling'))]);
  let out;
  let thrown;
  try {
    out = await handlers.get('agent/request')({ agent: a, turn: 1, step: 1, signal: undefined }, async () => DEFAULT_ROUTE);
  } catch (error) { thrown = error; }
  check('E6  with no projection service there is no throw', thrown === undefined, thrown?.message);
  routeEq('E7  without the projection service main applies', out, MAIN);
}

// ===========================================================================
console.log('\n--- F. plan mode keeps its own behaviour ---');
// ===========================================================================
{
  const h = harness(config());
  const a = h.add(topAgent('f1'));
  a.__plan = true;
  routeEq('F1  plan mode with planning models routes planning', await h.request(a), PLAN);
}

{
  // Plan mode outranks the skill in the recorded trigger: the session is
  // planning either way, but the report must not call it a skill trigger.
  const h = harness(config());
  const a = h.add(topAgent('f2'));
  a.__plan = true;
  await h.preStep(a, [userText('/grilling')]);
  routeEq('F2  plan mode routes planning even with a gesture in the same step', await h.request(a), PLAN);
  const out = await h.tool().execute({ action: 'report' });
  check('F3  plan mode owns the trigger (no skill-trigger line in the report)',
    !out.includes('Planning skill trigger:'), out.split('\n').find((l) => l.includes('trigger')) ?? '(none)');
}

{
  const h = harness(config());
  const a = h.add(topAgent('f4'));
  routeEq('F4  a plain session routes main when main is configured', await h.request(a), MAIN);
}

{
  const h = harness(config({}, { main: { models: [] } }));
  const a = h.add(topAgent('f5'));
  routeEq('F5  a plain session passes through when main is unconfigured', await h.request(a), DEFAULT_ROUTE);
  const out = await h.tool().execute({ action: 'report' });
  check('F6  the passthrough is recorded as the unconfigured-role reason',
    out.includes('passthrough (role unconfigured)'), out.split('\n').find((l) => l.includes('main-tier')) ?? '(none)');
}

// ===========================================================================
console.log('\n--- G. an explicit composer pick still wins the route ---');
// ===========================================================================
{
  // A human choice beats the manager's route exactly as it does in plan mode;
  // the planning *tier* decision stands, only the route is respected.
  const h = harness(config(), { stateOf: { modelManagerSelection: { explicit: true } } });
  const a = h.add(topAgent('g1'));
  await h.preStep(a, [userText('/grilling')]);
  routeEq('G1  a skill-triggered request keeps the composer-picked route', await h.request(a, COMPOSER), COMPOSER);
  const out = await h.tool().execute({ action: 'report' });
  const row = out.split('\n').find((l) => l.includes('explicit session selection (respected)'));
  check('G2  the remembered reason is the explicit-selection verdict', row !== undefined, out.slice(0, 200));
  check('G3  the row still records the planning role', row !== undefined && row.includes('planning'),
    row ?? '(no row)');
}

// ===========================================================================
console.log('\n--- H. the model_manager surfaces ---');
// ===========================================================================
{
  const h = harness(config());
  const routes = await h.tool().execute({ action: 'routes' });
  const line = routes.split('\n').find((l) => l.startsWith('Planning skills:'));
  check('H1  routes prints a Planning skills line', line !== undefined, routes.slice(0, 120));
  check('H2  routes names the configured skills', line !== undefined && line.includes('grill-me, grilling'),
    line ?? '(none)');
}

{
  const h = harness(config({ planningSkills: [] }));
  const routes = await h.tool().execute({ action: 'routes' });
  const line = routes.split('\n').find((l) => l.startsWith('Planning skills:'));
  check('H3  routes reports the disabled state for []',
    line !== undefined && line.includes('(disabled)'), line ?? '(none)');
}

{
  const h = harness(config());
  const a = h.add(topAgent('h4'));
  await h.preStep(a, [userText('/grilling')]);
  await h.request(a);
  const out = await h.tool().execute({ action: 'report' });
  const line = out.split('\n').find((l) => l.startsWith('Planning skill trigger:'));
  check('H4  report prints the Planning skill trigger line after a skill-triggered request',
    line !== undefined, out.slice(0, 200));
  check('H5  the trigger line names the session and the skill',
    line !== undefined && line.includes('h4') && line.includes('→ grilling'), line ?? '(none)');
  console.log(`      ${line}`);
}

{
  const h = harness(config());
  const a = h.add(topAgent('h6'));
  await h.preStep(a, [userText('just a plain question')]);
  await h.request(a);
  const out = await h.tool().execute({ action: 'report' });
  check('H6  report has no trigger line without a skill-triggered request',
    !out.includes('Planning skill trigger:'), out.split('\n').find((l) => l.includes('trigger')) ?? '(none)');
}

console.log(`\nTALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
