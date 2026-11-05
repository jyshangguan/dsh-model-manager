/**
 * `/autoplan` skill suite for @darkbear9494/dsh-model-manager (0.6.0).
 *
 * The feature under test: the plugin ships a `/autoplan` skill — registered as
 * a DSH runtime skill through `ctx.skills.register` — that tells the top-level
 * agent to delegate plan design to a `plan:`-labelled fork (which the manager
 * routes to the planning tier) and then implement on the main tier without an
 * approval gate.
 *
 * Four contracts must hold:
 *
 *   - the pure frontmatter parser (`parseSkillMarkdown`) accepts exactly a
 *     well-formed SKILL.md and returns `undefined` for anything else;
 *   - the definition the plugin registers (`autoplanSkillDefinition`) satisfies
 *     the shape `@deepseek-ai/dsh-skill` validates on `get()`, and its body
 *     carries the load-bearing instructions (a `plan:` fork, the no-approval
 *     rule, the plan-mode boundary, the `subagent` fallback);
 *   - registration is optional and never load-bearing: no skills service, a
 *     throwing `register()`, or a broken body all degrade to a logged warning;
 *   - the skill does NOT move the top-level session off `main` — it is a
 *     workflow trigger, not a planning-skill escalation.
 *
 * Run: node test/autoplan-skill.test.mjs   (or: npm test)
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { PLUGIN, repoRoot } from './paths.mjs';

const plugin = await import(PLUGIN);
const {
  apply,
  readConfig,
  parseSkillMarkdown,
  autoplanSkillDefinition,
  DEFAULT_PLANNING_SKILLS,
} = plugin;

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
const throws = (fn) => {
  try { fn(); return false; } catch { return true; }
};

// ---------------------------------------------------------------------------
// mock world
// ---------------------------------------------------------------------------
const PK = 'pku-corpus';
const MAIN = { provider: PK, model: 'main-tier' };
const PLAN = { provider: PK, model: 'planning-tier' };
const EXEC = { provider: PK, model: 'execution-tier' };
// The deployment default a top-level session rides before `main` rewrites it.
const DEFAULT_ROUTE = { provider: PK, model: 'session-default' };

const config = (strategy = {}, roles = {}) => ({
  roles: {
    main: { models: [MAIN] },
    planning: { models: [PLAN] },
    execution: { models: [EXEC] },
    vision: { models: [] },
    ...roles,
  },
  strategy: { mode: 'hybrid', ...strategy },
  // No update checks: a test process must never reach the network.
  update: { enabled: false },
});

const userText = (text) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
const topAgent = (id) => ({
  id,
  options: { ...DEFAULT_ROUTE },
  status: 'running',
  __plan: false,
  session: { header: {}, events: [] },
});

/**
 * One engine with its own handler map and service table.
 *
 * @param raw - plugin config handed to `apply`.
 * @param options.skills - `false` removes the skills service; an object is used
 *                         as the service; omitted installs a capturing mock.
 * @param options.registerThrows - make the mock `register` throw.
 */
function harness(raw, options = {}) {
  const handlers = new Map();
  const logs = [];
  const roster = [];
  const tools = [];
  const registrations = [];
  const effects = [];
  const services = {
    agents: { list: () => roster.slice() },
    subagents: { listChildren: async () => [] },
    subagentModelSelection: { current: () => ({ enabled: false, allowedModels: [] }) },
    planMode: { get: (agent) => ({ active: agent.__plan === true }) },
    tools: { register: (tool) => tools.push(tool) },
    systemPrompt: { section: () => () => {} },
  };
  if (options.skills === false) {
    // no skills service at all: the injection callback never runs
  } else {
    services.skills = options.skills ?? {
      register: (definition) => {
        registrations.push(definition);
        if (options.registerThrows === true) throw new Error('boom');
        return () => {};
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
    on: (event, handler) => { handlers.set(event, handler); },
    inject: (deps, cb) => {
      const scoped = Object.create(ctx);
      let ready = true;
      for (const dep of deps) {
        if (services[dep] === undefined) ready = false;
        scoped[dep] = services[dep];
      }
      if (ready) cb(scoped);
    },
    effect: (fn) => { effects.push(fn()); },
  };
  apply(ctx, raw);

  const preStep = (agent, messages, decision) => handlers.get('agent/pre-step')(
    { agent, messages, turn: 1, step: 1, signal: undefined },
    async () => decision ?? { kind: 'enter', messages: [] },
  );
  const request = (agent, resolved = DEFAULT_ROUTE, turn = 1) =>
    handlers.get('agent/request')({ agent, turn, step: 1, signal: undefined }, async () => resolved);
  const tool = () => tools.find((candidate) => candidate.name === 'model_manager');
  return {
    handlers, logs, roster, tools, registrations, effects, preStep, request, tool,
    add: (agent) => { roster.push(agent); return agent; },
  };
}

/** The shipped skill file, as text. */
const SKILL_FILE = join(repoRoot, 'skills', 'autoplan', 'SKILL.md');
const SKILL_TEXT = readFileSync(SKILL_FILE, 'utf8');

// ===========================================================================
console.log('--- A. parseSkillMarkdown (pure frontmatter parser) ---');
// ===========================================================================
{
  const valid = '---\nname: autoplan\ndescription: plan then do.\n---\n\nDo the thing.\n';
  eq('A1  a well-formed document yields name, description and body',
    parseSkillMarkdown(valid),
    { name: 'autoplan', description: 'plan then do.', content: 'Do the thing.' });

  eq('A2  CRLF line endings parse identically',
    parseSkillMarkdown(valid.replace(/\n/g, '\r\n')),
    { name: 'autoplan', description: 'plan then do.', content: 'Do the thing.' });

  eq('A3  the body is trimmed at both edges',
    parseSkillMarkdown('---\nname: x\ndescription: d\n---\n\n\n  body  \n\n'),
    { name: 'x', description: 'd', content: 'body' });

  eq('A4  a document with no frontmatter is rejected',
    parseSkillMarkdown('# just markdown\n'), undefined);

  eq('A5  an unclosed frontmatter fence is rejected',
    parseSkillMarkdown('---\nname: x\ndescription: d\nbody'), undefined);

  eq('A6  a frontmatter-only document (empty body) is rejected',
    parseSkillMarkdown('---\nname: x\ndescription: d\n---\n\n'), undefined);

  eq('A7  an empty description is rejected',
    parseSkillMarkdown('---\nname: x\ndescription:\n---\nbody'), undefined);

  eq('A8  an invalid name (uppercase) is rejected',
    parseSkillMarkdown('---\nname: AutoPlan\ndescription: d\n---\nbody'), undefined);

  eq('A9  an invalid name (underscore) is rejected',
    parseSkillMarkdown('---\nname: auto_plan\ndescription: d\n---\nbody'), undefined);

  eq('A10 a `name:` line in the body is not mistaken for frontmatter',
    parseSkillMarkdown('---\nname: x\ndescription: d\n---\nname: junk\nbody'),
    { name: 'x', description: 'd', content: 'name: junk\nbody' });

  eq('A11 a `---` line inside the body is preserved',
    parseSkillMarkdown('---\nname: x\ndescription: d\n---\nintro\n\n---\n\nrest'),
    { name: 'x', description: 'd', content: 'intro\n\n---\n\nrest' });

  eq('A12 hostile inputs never throw and yield undefined',
    [null, undefined, 42, {}, [], '<html>'].map((value) => parseSkillMarkdown(value)),
    [undefined, undefined, undefined, undefined, undefined, undefined]);
  check('A13 parseSkillMarkdown never throws on hostile input',
    !throws(() => parseSkillMarkdown({ toString: () => { throw new Error('nope'); } })));
}

// ===========================================================================
console.log('--- B. the shipped definition ---');
// ===========================================================================
const definition = autoplanSkillDefinition();
{
  check('B1  the shipped SKILL.md yields a definition', definition !== undefined);
  check('B2  the skill is named autoplan', definition?.name === 'autoplan', definition?.name);
  check('B3  description and content are non-empty strings',
    typeof definition?.description === 'string' && definition.description.length > 0
      && typeof definition?.content === 'string' && definition.content.length > 0);
  check('B4  source is the display string "bundled"',
    definition?.source === 'bundled', JSON.stringify(definition?.source));
  check('B5  both invocation flags are on',
    definition?.invocation?.modelInvocable === true && definition?.invocation?.userInvocable === true,
    JSON.stringify(definition?.invocation));

  // Re-implement the checks dsh-skill's validateDefinition applies on get():
  // the manager must register something the harness will not reject later.
  const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  check('B6  the definition satisfies the dsh-skill runtime contract',
    typeof definition?.name === 'string' && SKILL_NAME.test(definition.name)
      && typeof definition.description === 'string' && definition.description.length > 0
      && typeof definition.content === 'string'
      && typeof definition.source === 'string'
      && typeof definition.invocation?.modelInvocable === 'boolean'
      && typeof definition.invocation?.userInvocable === 'boolean',
    JSON.stringify({ name: definition?.name, source: definition?.source }));

  const body = definition?.content ?? '';
  check('B7  the body opens with the two phases',
    /##\s*Phase 1/.test(body) && /##\s*Phase 2/.test(body));
  check('B8  the body dispatches a `plan:`-labelled fork',
    /subagent_fork/.test(body) && /`?plan:/.test(body));
  check('B9  the body carries the no-approval rule',
    /do not ask the user to approve/i.test(body) && /do not ask for confirmation/i.test(body));
  check('B10 the body carries the plan-mode boundary',
    /plan mode/i.test(body) && /exit_plan_mode/.test(body));
  check('B11 the body offers the plain `subagent` fallback',
    /`subagent`/.test(body));
  check('B12 the body names the main tier as the implementation tier',
    /main tier/i.test(body));
  check('B13 the body does not leak the frontmatter',
    !body.trimStart().startsWith('---'), body.slice(0, 20));

  // The file is the single source of truth for the registered name.
  const dir = join(repoRoot, 'skills', 'autoplan');
  check('B14 the skill name matches its directory',
    definition?.name === 'autoplan' && existsSync(join(dir, 'SKILL.md')));
}

// ===========================================================================
console.log('--- C. registration is optional and never load-bearing ---');
// ===========================================================================
{
  const h = harness(config());
  check('C1  the definition is registered exactly once', h.registrations.length === 1,
    `${h.registrations.length} registration(s)`);
  eq('C2  the registered definition is the shipped one', h.registrations[0], definition);
  check('C3  the info log names the skill',
    h.logs.some(([level, message]) => level === 'info' && message.includes('/autoplan')));
}

{
  const h = harness(config(), { registerThrows: true });
  check('C4  a throwing register() does not fail apply()',
    h.logs.some(([level, message]) => level === 'warn' && message.includes('/autoplan skill not registered')));
  const out = await h.tool().execute({ action: 'routes' });
  check('C5  routes() reports the skill as not registered', out.includes('Autoplan skill: not registered'),
    out.split('\n').find((line) => line.startsWith('Autoplan skill:')) ?? '(none)');
}

{
  const h = harness(config(), { skills: false });
  const out = await h.tool().execute({ action: 'routes' });
  check('C6  without a skills service, apply() still works and routes() says not registered',
    out.includes('Autoplan skill: not registered'),
    out.split('\n').find((line) => line.startsWith('Autoplan skill:')) ?? '(none)');
}

{
  const h = harness(config(), {});
  const out = await h.tool().execute({ action: 'routes' });
  check('C7  routes() reports the skill as registered when it is',
    out.includes('Autoplan skill: registered'),
    out.split('\n').find((line) => line.startsWith('Autoplan skill:')) ?? '(none)');
}

{
  // A workflow skill is not routing: it stays available with the master switch off.
  const h = harness({ ...config(), enabled: false }, {});
  check('C8  registration is independent of config.enabled', h.registrations.length === 1);
}

// ===========================================================================
console.log('--- D. /autoplan does not move the top-level session off main ---');
// ===========================================================================
{
  check('D1  autoplan is not a default planning skill',
    !DEFAULT_PLANNING_SKILLS.includes('autoplan'), DEFAULT_PLANNING_SKILLS.join(', '));

  const h = harness(config());
  const agent = h.add(topAgent('d2'));
  await h.preStep(agent, [userText('/autoplan build the thing')]);
  const applied = await h.request(agent, DEFAULT_ROUTE);
  routeEq('D2  the top-level session stays on the main tier', applied, MAIN);

  const planning = await (async () => {
    const h2 = harness(config());
    const a2 = h2.add(topAgent('d3'));
    await h2.preStep(a2, [userText('/grilling sharpen this')]);
    return h2.request(a2, DEFAULT_ROUTE);
  })();
  routeEq('D3  control: /grilling still escalates to the planning tier', planning, PLAN);
}

// ===========================================================================
console.log('--- E. packaging ---');
// ===========================================================================
{
  check('E1  skills/autoplan/SKILL.md exists', existsSync(SKILL_FILE));
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  check('E2  package.json files includes "skills"', (manifest.files ?? []).includes('skills'),
    (manifest.files ?? []).join(', '));
  check('E3  the shipped SKILL.md parses to the registered name',
    parseSkillMarkdown(SKILL_TEXT)?.name === 'autoplan');
  check('E4  the manifest version matches this suite',
    manifest.version === '0.6.0', manifest.version);
}

console.log(`\nTALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;