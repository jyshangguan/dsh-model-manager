/**
 * Delegation-policy suite for @darkbear9494/dsh-model-manager (0.4.0).
 *
 * Covers `strategy.autoDelegate`: config normalization, the second
 * system-prompt section, and the per-assembly rendering rules — the policy
 * must appear only for the top-level orchestrator, only when it actually has
 * the delegation tools, and never for delegated children.
 *
 * The mock mirrors dsh-agent's `assembleContextFor`: every section text
 * function receives `{ agent, scope }`, and `tools.get(name, scope)` answers
 * visibility the way dsh-tools does.
 */
import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);

const registeredSections = [];
const registeredTools = [];
const handlers = new Map();
const logs = [];

const subagentScope = { id: 'scope-with-subagent', hasSubagent: true };
const forkOnlyScope = { id: 'scope-with-fork-only', hasSubagent: false, hasFork: true };
const bareScope = { id: 'scope-without-tools', hasSubagent: false, hasFork: false };

const services = {
  agents: { list: () => [], get: () => undefined, isOwnedBy: () => false },
  subagents: { listChildren: async () => [] },
  subagentModelSelection: { current: () => ({ enabled: true, allowedModels: [] }) },
  planMode: { get: () => ({ active: false }) },
  tools: {
    register: (tool) => registeredTools.push(tool),
    get: (name, scope) => {
      if (name === 'subagent' && scope?.hasSubagent === true) return { name };
      if (name === 'subagent_fork' && (scope?.hasFork === true || scope?.hasSubagent === true)) return { name };
      return undefined;
    },
  },
  systemPrompt: { section: (section) => { registeredSections.push(section); return () => {}; } },
};

const ctx = {
  logger: () => ({
    info: (...args) => logs.push(['info', ...args]),
    warn: () => {},
    error: () => {},
  }),
  get: (name) => services[name],
  on: (event, handler) => handlers.set(event, handler),
  inject: (deps, cb) => {
    const scoped = Object.create(ctx);
    for (const dep of deps) scoped[dep] = services[dep];
    cb(scoped);
  },
  effect: (fn) => fn(),
};

const ROLES = {
  main: { models: [] },
  planning: { models: [{ provider: 'pku-corpus', model: 'qwen3.8-max-0902' }] },
  execution: { models: [{ provider: 'pku-corpus', model: 'qwen3.8-flash' }] },
  vision: { models: [{ provider: 'pku-corpus', model: 'kimi-k3' }] },
};

const applyWith = (strategy) => plugin.apply(ctx, { roles: ROLES, strategy });

let passed = 0;
let failed = 0;
const check = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        got  ${JSON.stringify(got)}`);
    console.log(`        want ${JSON.stringify(want)}`);
    failed += 1;
  } else passed += 1;
};
const checkTrue = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`        ${detail ?? 'condition false'}`);
    failed += 1;
  } else passed += 1;
};

console.log('--- config normalization ---');
check('D1 absent autoDelegate defaults to balanced', plugin.readConfig({}).strategy.autoDelegate, 'balanced');
check('D2 explicit off is preserved', plugin.readConfig({ strategy: { autoDelegate: 'off' } }).strategy.autoDelegate, 'off');
check('D3 explicit eager is preserved', plugin.readConfig({ strategy: { autoDelegate: 'eager' } }).strategy.autoDelegate, 'eager');
check('D4 an unrecognised level falls back to balanced',
  plugin.readConfig({ strategy: { autoDelegate: 'aggressive' } }).strategy.autoDelegate, 'balanced');
check('D5 a volatile ref wrapping strategy is unwrapped',
  plugin.readConfig({ strategy: { get: () => ({ autoDelegate: 'eager' }) } }).strategy.autoDelegate, 'eager');

console.log('\n--- schema validation ---');
{
  const validated = new plugin.Config({ strategy: { autoDelegate: 'eager' } });
  check('D6 the schema accepts eager', plugin.readConfig(validated).strategy.autoDelegate, 'eager');
  let threw;
  try {
    new plugin.Config({ strategy: { autoDelegate: 'sometimes' } });
  } catch (error) {
    threw = error;
  }
  checkTrue('D7 the schema rejects an unknown level', threw !== undefined, 'Config accepted "sometimes"');
  const defaults = plugin.readConfig(new plugin.Config({}));
  check('D8 a validated empty config defaults to balanced', defaults.strategy.autoDelegate, 'balanced');
}

console.log('\n--- section registration ---');
applyWith({ mode: 'managed' });
const cheat = registeredSections.find((section) => section.name === 'model-manager');
const policy = registeredSections.find((section) => section.name === 'model-manager:delegation');
checkTrue('D9 the routing cheat sheet is still registered', cheat !== undefined, 'no model-manager section');
checkTrue('D10 the delegation section is registered', policy !== undefined, 'no model-manager:delegation section');
check('D11 the delegation section orders itself with the policy rows', policy?.order, 550);
checkTrue('D12 the delegation text is a function', typeof policy?.text === 'function', 'text is not callable');

console.log('\n--- rendering rules ---');
const topLevel = { agent: { id: 'top', session: { header: {} } }, scope: subagentScope };
const child = { agent: { id: 'kid', session: { header: { origin: 'subagent' } } }, scope: subagentScope };
const deepChild = { agent: { id: 'kid2', session: { header: { delegationDepth: 2 } } }, scope: subagentScope };

const balancedText = policy?.text(topLevel);
checkTrue('D13 a top-level agent with the subagent tool gets the policy',
  typeof balancedText === 'string' && balancedText.startsWith('## Delegation policy (model-manager, balanced)'),
  `got: ${String(balancedText).slice(0, 60)}`);
checkTrue('D14 the balanced policy names the tier prefixes',
  balancedText?.includes('`plan:`') === true && balancedText?.includes('`vision:`') === true,
  'plan:/vision: prefixes missing');
check('D15 a delegated child gets no policy', policy?.text(child), '');
check('D16 a child identified only by delegationDepth gets no policy', policy?.text(deepChild), '');
check('D17 an agent without delegation tools gets no policy', policy?.text({ ...topLevel, scope: bareScope }), '');
check('D18 an assembly with no context at all gets no policy', policy?.text(undefined), '');

const forkText = policy?.text({ ...topLevel, scope: forkOnlyScope });
checkTrue('D19 a fork-only scope still gets a policy naming subagent_fork',
  typeof forkText === 'string' && forkText.includes('`subagent_fork`') === true,
  'subagent_fork not named');

console.log('\n--- level switching ---');
{
  registeredSections.length = 0;
  applyWith({ mode: 'managed', autoDelegate: 'eager' });
  const eager = registeredSections.find((section) => section.name === 'model-manager:delegation');
  const text = eager?.text(topLevel);
  checkTrue('D20 eager renders the orchestrator policy',
    text?.startsWith('## Delegation policy (model-manager, eager)') === true,
    `got: ${String(text).slice(0, 60)}`);
  checkTrue('D21 eager is not the balanced text', text !== balancedText, 'eager equals balanced');
}
{
  registeredSections.length = 0;
  applyWith({ mode: 'managed', autoDelegate: 'off' });
  const off = registeredSections.find((section) => section.name === 'model-manager:delegation');
  check('D22 off renders an empty policy for the same context', off?.text(topLevel), '');
}
{
  registeredSections.length = 0;
  plugin.apply(ctx, { enabled: false, roles: ROLES, strategy: { mode: 'managed', autoDelegate: 'eager' } });
  const disabled = registeredSections.find((section) => section.name === 'model-manager:delegation');
  check('D23 the master switch off suppresses the policy too', disabled?.text(topLevel), '');
}

console.log('\n--- tier awareness (engine) ---');
{
  registeredSections.length = 0;
  applyWith({ mode: 'managed' });
  const policy = registeredSections.find((section) => section.name === 'model-manager:delegation');
  const text = policy?.text(topLevel);
  checkTrue('D30 the balanced policy delegates the decomposition itself',
    text?.includes('delegate the decomposition') === true, 'decomposition line missing');
  checkTrue('D31 the policy states the prefix rule',
    text?.includes('A leading prefix decides the tier') === true, 'prefix rule missing');
  checkTrue('D32 the policy teaches the omit-provider rule',
    text?.includes('Omit `provider` and `model`') === true, 'omit rule missing');
}
{
  registeredSections.length = 0;
  applyWith({ mode: 'advisory' });
  const policy = registeredSections.find((section) => section.name === 'model-manager:delegation');
  const text = policy?.text(topLevel);
  checkTrue('D33 advisory keeps the labels but drops the omit-provider rule',
    text?.includes('`plan:`') === true && text?.includes('Omit `provider`') !== true,
    'advisory text kept the routed-only line');
}
{
  registeredSections.length = 0;
  plugin.apply(ctx, { roles: { ...ROLES, planning: { models: [] } }, strategy: { mode: 'managed' } });
  const policy = registeredSections.find((section) => section.name === 'model-manager:delegation');
  const text = policy?.text(topLevel);
  checkTrue('D34 an unconfigured planning tier is never advertised',
    text?.includes('`plan:`') !== true && text?.includes('`vision:`') === true,
    'plan: advertised with no models behind it');
}

console.log('\n--- delegationPolicyText tiers (pure) ---');
{
  const both = plugin.delegationPolicyText('balanced', ['subagent', 'subagent_fork']);
  checkTrue('D35 a bare call keeps both tier labels', both.includes('`plan:`') && both.includes('`vision:`'), 'labels missing');
  const noPlan = plugin.delegationPolicyText('balanced', ['subagent'], { planning: false });
  checkTrue('D36 planning:false drops every plan: mention',
    !noPlan.includes('`plan:`') && noPlan.includes('`vision:`') && noPlan.includes('Omit `provider`'),
    'plan: still advertised');
  const none = plugin.delegationPolicyText('balanced', ['subagent'], { planning: false, vision: false });
  checkTrue('D37 no tiers: no labels, no omit rule, policy still renders',
    !none.includes('`plan:`') && !none.includes('`vision:`') && !none.includes('Omit `provider`') && none.includes('plain —'),
    'tierless text still teaches tiers');
  const unrouted = plugin.delegationPolicyText('balanced', ['subagent'], { routed: false });
  checkTrue('D38 routed:false keeps labels but drops the omit rule',
    unrouted.includes('`plan:`') && !unrouted.includes('Omit `provider`'), 'omit rule kept');
  const eagerOmit = plugin.delegationPolicyText('eager', ['subagent']);
  checkTrue('D39 eager carries the omit rule too', eagerOmit.includes('Omit `provider`'), 'omit rule missing in eager');
}

console.log('\n--- routes surface ---');
{
  registeredSections.length = 0;
  registeredTools.length = 0;
  applyWith({ mode: 'managed', autoDelegate: 'eager' });
  const tool = registeredTools.find((candidate) => candidate.name === 'model_manager');
  const out = await tool.execute({ action: 'routes' });
  checkTrue('D24 routes reports the auto-delegation level',
    out.includes('Auto-delegation: eager'), out.split('\n').find((line) => line.startsWith('Auto-delegation')));
}

console.log('\n--- live reload ---');
{
  registeredSections.length = 0;
  const raw = { roles: ROLES, strategy: { mode: 'managed', autoDelegate: 'balanced' } };
  const fresh = [];
  const ctx2 = {
    ...ctx,
    on: (event, handler) => { if (event === 'loader/volatile-update') fresh.push(handler); },
    inject: ctx.inject,
    effect: (fn) => fn(),
    logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  };
  plugin.apply(ctx2, raw);
  const section = registeredSections.at(-1);
  checkTrue('D25 reload harness registered the policy section', section?.name === 'model-manager:delegation', section?.name);
  raw.strategy.autoDelegate = 'off';
  for (const handler of fresh) handler();
  check('D26 after a volatile save to off the section renders empty', section.text(topLevel), '');
  raw.strategy.autoDelegate = 'eager';
  for (const handler of fresh) handler();
  checkTrue('D27 after a volatile save back to eager the text returns',
    section.text(topLevel)?.startsWith('## Delegation policy (model-manager, eager)') === true,
    'policy did not come back');
}

console.log('\n--- robustness ---');
{
  const hostile = {
    ...ctx,
    inject: (deps, cb) => {
      const scoped = Object.create(hostile);
      for (const dep of deps) {
        scoped[dep] = dep === 'tools'
          ? { register: () => { throw new Error('register boom'); }, get: () => { throw new Error('get boom'); } }
          : services[dep];
      }
      cb(scoped);
    },
  };
  let threw;
  try {
    plugin.apply(hostile, { roles: ROLES, strategy: { autoDelegate: 'balanced' } });
  } catch (error) {
    threw = error;
  }
  checkTrue('D28 a throwing tools service never escapes apply', threw === undefined, threw?.message);
  // The hostile engine registered its own sections after the earlier applies;
  // the LAST one belongs to that engine and its throwing tools service.
  const hostileSection = registeredSections.filter((section) => section.name === 'model-manager:delegation').at(-1);
  check('D29 a throwing tools.get degrades to an empty policy', hostileSection?.text(topLevel), '');
}

console.log(`\nTALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
