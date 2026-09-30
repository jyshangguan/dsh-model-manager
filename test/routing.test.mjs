/**
 * Unit probe for @darkbear9494/dsh-model-manager.
 *
 * Mocks a Cordis context whose service surface mirrors the live DSH 0.1.7-rc.2
 * host, then drives routing and reporting. Injected services are exposed as
 * context properties (`ctx.tools`), the way real cordis scopes do.
 */

import { PLUGIN, CLIENT, dshFile } from './paths.mjs';

const plugin = await import(PLUGIN);

const handlers = new Map();
const registeredTools = [];
let registeredSection;

const services = {
  agents: {
    list: () => roots,
    get: (id) => roots.find((a) => a.id === id),
    isOwnedBy: (childId, owner) => children.some((c) => c.id === childId && c.parentId === owner.id),
  },
  subagents: { listChildren: async (parentId) => children.filter((c) => c.parentId === parentId) },
  subagentModelSelection: {
    current: () => ({
      enabled: true,
      allowedModels: [
        { provider: 'pku-corpus', model: 'qwen3.8-max-0902' },
        { provider: 'pku-corpus', model: 'qwen3.8-flash' },
      ],
    }),
  },
  planMode: { get: (agent) => ({ active: agent.__plan === true }) },
  tools: { register: (tool) => registeredTools.push(tool) },
  systemPrompt: { section: (section) => { registeredSection = section; return () => {}; } },
};

const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  get: (name) => services[name],
  on: (event, handler) => { handlers.set(event, handler); },
  inject: (deps, cb) => {
    const scoped = Object.create(ctx);
    for (const dep of deps) scoped[dep] = services[dep];
    cb(scoped);
  },
  effect: (fn) => { fn(); },
};

/** Run the agent/request waterfall the way the harness would. */
const request = (agent, resolved) =>
  handlers.get('agent/request')({ agent, turn: 1, step: 1, signal: undefined }, async () => resolved);

// Distinct model per role so an applied route is unmistakable.
const CONFIG = {
  roles: {
    main: { models: [] },
    planning: { models: [{ provider: 'pku-corpus', model: 'deepseek-v4-pro-0813' }] },
    execution: { models: [{ provider: 'pku-corpus', model: 'qwen3.8-flash' }] },
    vision: { models: [{ provider: 'pku-corpus', model: 'kimi-k3' }] },
  },
  strategy: { mode: 'hybrid' },
};

const parent = { id: 'parent-0001', options: { provider: 'pku-corpus', model: 'qwen3.8-max-0902' }, session: { header: {} }, status: 'running' };
const roots = [parent];
const children = [];

function addChild(id, label, options) {
  const agent = { id, options, session: { header: { origin: 'subagent' } }, status: 'running' };
  roots.push(agent);
  children.push({ id, parentId: 'parent-0001', label, mode: 'one-shot', createdAt: children.length + 1 });
  return agent;
}

plugin.apply(ctx, CONFIG);

const INHERITED = { provider: 'pku-corpus', model: 'qwen3.8-max-0902' };
const check = (n, label, got, want) => {
  const ok = got.provider === want.provider && got.model === want.model;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}  ${label}`);
  console.log(`        got  ${got.provider}/${got.model}`);
  if (!ok) console.log(`        want ${want.provider}/${want.model}`);
  if (!ok) process.exitCode = 1;
};

console.log('--- routing ---');
check(1, 'top-level, no plan mode, main unconfigured -> passthrough',
  await request(parent, { provider: 'pku-corpus', model: 'qwen3.8-flash' }),
  { provider: 'pku-corpus', model: 'qwen3.8-flash' });

parent.__plan = true;
check(2, 'top-level IN plan mode -> planning route forced',
  await request(parent, { provider: 'pku-corpus', model: 'qwen3.8-flash' }),
  { provider: 'pku-corpus', model: 'deepseek-v4-pro-0813' });
parent.__plan = false;

check(3, 'subagent "analyze the parser design" -> planning',
  await request(addChild('child-0001', 'analyze the parser design', INHERITED), { ...INHERITED }),
  { provider: 'pku-corpus', model: 'deepseek-v4-pro-0813' });

check(4, 'subagent "fix the typo in README" -> execution',
  await request(addChild('child-0002', 'fix the typo in README', INHERITED), { ...INHERITED }),
  { provider: 'pku-corpus', model: 'qwen3.8-flash' });

check(5, 'subagent "read this screenshot of the UI" -> vision',
  await request(addChild('child-0003', 'read this screenshot of the UI', INHERITED), { ...INHERITED }),
  { provider: 'pku-corpus', model: 'kimi-k3' });

check(6, 'subagent with an EXPLICIT route -> respected (hybrid)',
  await request(addChild('child-0004', 'fix the typo', { provider: 'pku-corpus', model: 'deepseek-v4-flash-0731' }),
    { provider: 'pku-corpus', model: 'deepseek-v4-flash-0731' }),
  { provider: 'pku-corpus', model: 'deepseek-v4-flash-0731' });

console.log('\n--- surface ---');
console.log(`${registeredTools.length === 1 ? 'PASS' : 'FAIL'}  tool registered: ${registeredTools.map((t) => t.name).join(', ') || '(none)'}`);
console.log(`${registeredSection !== undefined ? 'PASS' : 'FAIL'}  system prompt section: ${registeredSection?.name ?? '(none)'}`);

const tool = registeredTools.find((t) => t.name === 'model_manager');
console.log('\n--- action: report ---');
console.log(await tool.execute({ action: 'report' }));
console.log('\n--- action: routes ---');
console.log(await tool.execute({ action: 'routes' }));
console.log('\n--- action: usage ---');
console.log(await tool.execute({ action: 'usage' }));

console.log('\n--- robustness: malformed configs must not throw ---');
const before = registeredTools.length;
try {
  plugin.apply(ctx, { roles: 'not-an-object', strategy: null });
  plugin.apply(ctx, undefined);
  plugin.apply(ctx, { strategy: { mode: 'nonsense', historyLimit: -5 }, roles: { vision: { models: [{ provider: '', model: '' }] } } });
  console.log('PASS  apply() survived three malformed configs');
  console.log('      readConfig normalizes bad routes to:', JSON.stringify(plugin.readConfig({ roles: { vision: { models: [{ provider: '', model: '' }, { provider: 'a', model: 'b' }] } } }).roles.vision.models));
  console.log('      strategy defaults:', JSON.stringify(plugin.readConfig({ strategy: { mode: 'nonsense' } }).strategy.mode));
} catch (error) {
  console.log('FAIL  apply() threw:', error.message);
  process.exitCode = 1;
}

console.log('\n--- empty allow-list path ---');
services.subagentModelSelection = undefined;
const ctx3 = Object.create(ctx);
console.log('      routes with no selection service:', (await tool.execute({ action: 'routes' })).split('\n').find((l) => l.startsWith('Allow-list')));
