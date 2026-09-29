/**
 * Failover tests for @jyshangguan/dsh-model-manager.
 *
 * Drives the real plugin through a mock Cordis context whose `agent/request` and
 * `agent/request-error` waterfalls mirror the harness contract verified in
 * .research/failover-ref.md (agent/request-error fires once per genuinely failed
 * attempt; returning {kind:'retry'} re-runs the same step through agent/request).
 */
import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);

let passed = 0;
let failed = 0;
const infos = [];
const check = (name, ok, observed, expected) => {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n        observed: ${JSON.stringify(observed)}\n        expected: ${JSON.stringify(expected)}`); }
};
const info = (m) => { infos.push(m); };

const PK = 'pku-corpus';
const M = (model, reasoningEffort) => ({ provider: PK, model, ...(reasoningEffort ? { reasoningEffort } : {}) });
const routeOf = (r) => `${r.provider}/${r.model}`;

function makeWorld() {
  const handlers = new Map();
  const logs = [];
  const roots = [];
  const children = [];

  const ctx = {
    logger: () => ({
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
    }),
    get(name) {
      if (name === 'agents') {
        return {
          list: () => roots,
          get: (id) => roots.find((a) => a.id === id),
          isOwnedBy: (childId, owner) => children.some((c) => c.id === childId && c.parentId === owner.id),
        };
      }
      if (name === 'subagents') return { listChildren: async (pid) => children.filter((c) => c.parentId === pid) };
      if (name === 'planMode') return { get: (agent) => ({ active: agent.__plan === true }) };
      if (name === 'tools') return { register() {} };
      if (name === 'systemPrompt') return { section: () => () => {} };
      return undefined;
    },
    on(event, handler) { handlers.set(event, handler); },
    inject(deps, cb) { const scoped = Object.create(ctx); for (const d of deps) scoped[d] = ctx.get(d); cb(scoped); },
    effect(fn) { fn(); },
  };

  const addAgent = (id, route, { subagent = false, parentId } = {}) => {
    const agent = {
      id,
      options: { provider: route.provider, model: route.model },
      status: 'running',
      session: {
        header: subagent ? { origin: 'subagent' } : {},
        // Mirrors the harness: the header holds the config of the last attempt.
        requestHeader: () => (agent.__header === undefined ? undefined : { config: agent.__header }),
      },
    };
    roots.push(agent);
    if (subagent && parentId) children.push({ id, parentId, label: agent.__label, mode: 'one-shot', createdAt: 1 });
    return agent;
  };

  /** Run the agent/request waterfall; records the result as the logged header. */
  const request = async (agent, seed) => {
    const handler = handlers.get('agent/request');
    const out = await handler({ agent, turn: agent.__turn ?? 1, step: agent.__step ?? 1, signal: new AbortController().signal }, async () => seed);
    agent.__header = { provider: out.provider, model: out.model, ...(out.reasoningEffort ? { reasoningEffort: out.reasoningEffort } : {}) };
    return out;
  };

  /** Run the agent/request-error waterfall. `downstream` is what next() yields. */
  const requestError = async (agent, code, { downstream, aborted = false, turn, step } = {}) => {
    const handler = handlers.get('agent/request-error');
    if (typeof handler !== 'function') throw new Error('agent/request-error not registered');
    return handler(
      {
        agent,
        turn: turn ?? agent.__turn ?? 1,
        step: step ?? agent.__step ?? 1,
        provider: agent.__header?.provider,
        failure: { message: `simulated ${code}`, code },
        retryPolicy: undefined,
        signal: { aborted },
      },
      async () => downstream,
    );
  };

  return { ctx, handlers, logs, roots, children, addAgent, request, requestError };
}

const cfg = (roles, extra = {}) => ({
  roles,
  strategy: { mode: 'managed', ...extra.strategy },
  ...extra,
});

console.log('=== A. basic failover chain (pick: first) ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B'), M('C')] } }));
  const a = w.addAgent('s-a', M('A'));
  check('A1 first request uses model 1', routeOf(await w.request(a, M('A'))) === `${PK}/A`, routeOf(a.__header), `${PK}/A`);

  const d1 = await w.requestError(a, 'SERVER');
  check('A2 a SERVER failure asks for a retry', d1 && d1.kind === 'retry', d1, { kind: 'retry' });

  check('A3 the retried step uses model 2', routeOf(await w.request(a, M('A'))) === `${PK}/B`, routeOf(a.__header), `${PK}/B`);

  await w.requestError(a, 'TIMEOUT');
  check('A4 second failure moves to model 3', routeOf(await w.request(a, M('A'))) === `${PK}/C`, routeOf(a.__header), `${PK}/C`);

  const d3 = await w.requestError(a, 'TRANSPORT');
  check('A5 the end of the chain is terminal (no wrap, no retry)', d3 === undefined, d3, undefined);
  check('A6 the route stays on the last model', routeOf(await w.request(a, M('A'))) === `${PK}/C`, routeOf(a.__header), `${PK}/C`);
  info(`A  failover log lines: ${w.logs.filter((l) => l[0] === 'warn' && String(l[1]).includes('failover')).length}`);
}

console.log('\n=== B. never fail over on a cancellation or a request-content error ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B')] } }));
  const a = w.addAgent('s-b', M('A'));
  await w.request(a, M('A'));

  check('B1 ABORTED code does not fail over', (await w.requestError(a, 'ABORTED')) === undefined, 'retry', undefined);
  check('B2 an aborted signal does not fail over', (await w.requestError(a, 'SERVER', { aborted: true })) === undefined, 'retry', undefined);
  check('B3 INVALID_REQUEST does not fail over', (await w.requestError(a, 'INVALID_REQUEST')) === undefined, 'retry', undefined);
  check('B4 IMAGE_OFFLOAD_REQUIRED is left to its owner', (await w.requestError(a, 'IMAGE_OFFLOAD_REQUIRED')) === undefined, 'retry', undefined);
  check('B5 the pointer did not move', routeOf(await w.request(a, M('A'))) === `${PK}/A`, routeOf(a.__header), `${PK}/A`);
}

console.log('\n=== C. downstream recovery is authoritative ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B')] } }));
  const a = w.addAgent('s-c', M('A'));
  await w.request(a, M('A'));
  const owned = { kind: 'retry' };
  const got = await w.requestError(a, 'CONTEXT_WINDOW_EXCEEDED', { downstream: owned });
  check('C1 a downstream decision is passed through untouched', got === owned, got, 'the same object');
  check('C2 the pointer did not advance behind the owner', routeOf(await w.request(a, M('A'))) === `${PK}/A`, routeOf(a.__header), `${PK}/A`);
}

console.log('\n=== D. per-step switch cap ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B'), M('C'), M('D'), M('E')] } }));
  const a = w.addAgent('s-d', M('A'));
  await w.request(a, M('A'));
  const decisions = [];
  for (let i = 0; i < 5; i++) {
    decisions.push(await w.requestError(a, 'SERVER'));
    await w.request(a, M('A'));
  }
  const retries = decisions.filter((d) => d && d.kind === 'retry').length;
  check('D1 at most MAX_SWITCHES_PER_STEP (3) switches in one step', retries === 3, retries, 3);
  check('D2 later failures in the same step are terminal', decisions[3] === undefined && decisions[4] === undefined, decisions.slice(3), [undefined, undefined]);

  // A new step resets the budget.
  a.__step = 2;
  await w.request(a, M('A'));
  const after = await w.requestError(a, 'SERVER');
  check('D3 a new step gets a fresh budget', after && after.kind === 'retry', after, { kind: 'retry' });
}

console.log('\n=== E. round-robin wraps instead of terminating ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B'), M('C')], pick: 'round-robin' } }));
  const a = w.addAgent('s-e', M('A'));
  await w.request(a, M('A'));
  const seen = [];
  for (let i = 0; i < 2; i++) {
    const before = routeOf(a.__header);
    await w.requestError(a, 'SERVER');
    await w.request(a, M('A'));
    seen.push(`${before} -> ${routeOf(a.__header)}`);
  }
  info(`E  transitions: ${seen.join(', ')}`);
  check('E1 round-robin advances on failure', seen.length === 2 && seen.every((s) => s.split(' -> ')[0] !== s.split(' -> ')[1]), seen, 'two distinct transitions');
}

console.log('\n=== F. roles that cannot fail over ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A')] } }));
  const a = w.addAgent('s-f', M('A'));
  await w.request(a, M('A'));
  check('F1 a single-model role does not retry', (await w.requestError(a, 'SERVER')) === undefined, 'retry', undefined);
}
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B')] }, vision: { models: [M('V1'), M('V2')] } }, { enabled: false }));
  const a = w.addAgent('s-f2', M('A'));
  await w.request(a, M('A'));
  check('F2 enabled:false disables failover too', (await w.requestError(a, 'SERVER')) === undefined, 'retry', undefined);
}

console.log('\n=== G. a failure on a route outside the role list is not ours ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B')] } }));
  const a = w.addAgent('s-g', M('A'));
  await w.request(a, M('A'));
  a.__header = { provider: 'other', model: 'elsewhere' };   // an explicit choice we respected
  check('G1 no failover for a route the role does not own', (await w.requestError(a, 'SERVER')) === undefined, 'retry', undefined);
}

console.log('\n=== H. robustness ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ main: { models: [M('A'), M('B')] } }));
  const a = w.addAgent('s-h', M('A'));
  await w.request(a, M('A'));
  let threw = null;
  try {
    await w.handlers.get('agent/request-error')({ agent: undefined, failure: { code: 'SERVER' }, signal: {} }, async () => undefined);
    await w.handlers.get('agent/request-error')({ agent: a, failure: undefined, signal: {} }, async () => undefined);
    await w.handlers.get('agent/request-error')({ agent: a, failure: { code: 'SERVER' }, signal: undefined }, async () => undefined);
    await w.handlers.get('agent/request-error')(undefined, async () => undefined);
  } catch (e) { threw = e; }
  check('H1 hostile payloads never throw out of the listener', threw === null, threw && threw.message, null);
  a.session.requestHeader = () => { throw new Error('boom'); };
  let threw2 = null;
  try { await w.requestError(a, 'SERVER'); } catch (e) { threw2 = e; }
  check('H2 a throwing requestHeader is survived', threw2 === null, threw2 && threw2.message, null);
}

console.log('\n=== I. subagent chains fail over too ===');
{
  const w = makeWorld();
  plugin.apply(w.ctx, cfg({ execution: { models: [M('A'), M('B')] }, planning: { models: [M('P1'), M('P2')] } }));
  const parent = w.addAgent('s-i-p', M('A'));
  await w.request(parent, M('A'));
  parent.__header = { provider: PK, model: 'A' };
  const child = w.addAgent('s-i-c', M('A'), { subagent: true, parentId: 's-i-p' });
  child.__label = 'fix the typo';
  w.children.push({ id: 's-i-c', parentId: 's-i-p', label: 'fix the typo', mode: 'one-shot', createdAt: 2 });
  await w.request(child, M('A'));
  check('I1 the child was routed to the execution chain', routeOf(child.__header) === `${PK}/A`, routeOf(child.__header), `${PK}/A`);
  await w.requestError(child, 'RATE_LIMIT');
  await w.request(child, M('A'));
  check('I2 the child fails over to model 2', routeOf(child.__header) === `${PK}/B`, routeOf(child.__header), `${PK}/B`);
}

console.log('\n===================================================================');
console.log(`TALLY: ${passed} passed, ${failed} failed, ${passed + failed} total`);
for (const m of infos) console.log(`INFO  ${m}`);
process.exitCode = failed ? 1 : 0;
