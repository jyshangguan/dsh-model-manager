/**
 * The `modelManagerUsage` session projection: the fold that turns durable
 * `assistant/message` events into per-provider/model token totals.
 *
 * This is the only part of the plugin that must agree, to the token, with the
 * harness's own per-Turn usage dialog — so it is tested against the semantics
 * read out of `dsh-client-ui-chat`'s `deriveTurnTokenUsage` / `normalizeUsage`,
 * not against assumptions.
 */

import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);

let captured;
const services = {
  sessionProjections: {
    register: (definition) => { captured = definition; return () => {}; },
  },
};
const ctx = {
  logger: () => ({ info: () => {}, warn: () => {}, error: () => {} }),
  get: (name) => services[name],
  on: () => {},
  effect: (fn) => { fn(); },
  inject: (deps, cb) => {
    const scoped = Object.create(ctx);
    for (const dep of deps) scoped[dep] = services[dep];
    cb(scoped);
  },
};

plugin.apply(ctx, {
  roles: { main: { models: [] }, planning: { models: [] }, execution: { models: [] }, vision: { models: [] } },
  strategy: { mode: 'hybrid' },
});

let passed = 0;
let failed = 0;
const check = (label, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok && detail !== undefined) console.log(`        ${detail}`);
  ok ? passed++ : failed++;
};

check('the projection was registered', captured !== undefined);
if (captured === undefined) {
  console.log(`TALLY: ${passed} passed, ${failed} failed`);
  process.exitCode = 1;
} else {
  run(captured);
}

function run(def) {
  check('key is modelManagerUsage', def.key === 'modelManagerUsage', `got ${def.key}`);
  check('stateVersion is a non-negative integer',
    Number.isSafeInteger(def.stateVersion) && def.stateVersion >= 0, `got ${def.stateVersion}`);
  check('init starts with no routes', JSON.stringify(def.init({}, 0)) === '{"routes":[]}');

  const message = (provider, model, usage) => ({
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { source: { provider, model } }, usage },
  });
  const FLASH = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

  // A fold must return the SAME reference for events it does not own, or the
  // projection layer republishes a value on every unrelated append.
  const s0 = def.init({}, 0);
  check('unrelated event returns the same state reference',
    def.apply(s0, { type: 'tool/call', data: {} }) === s0);
  check('message without a usage sample returns the same reference',
    def.apply(s0, { type: 'assistant/message', data: { turn: 1, step: 1, message: { source: { provider: 'p', model: 'm' } } } }) === s0);
  check('a failed attempt is never counted (no route to attribute it to)',
    def.apply(s0, { type: 'assistant/attempt', data: { turn: 1, step: 1, stream: [{ type: 'usage', usage: FLASH }] } }) === s0);
  check('message without provider/model attribution is skipped',
    def.apply(s0, message('', '', FLASH)) === s0
      && def.apply(s0, { type: 'assistant/message', data: { turn: 1, step: 1, message: {} } }) === s0);

  // Bucket sums, using the harness's own field names.
  let s = def.apply(s0, message('pku-corpus', 'qwen3.8-flash', {
    inputTokens: 1200, outputTokens: 640, cacheReadTokens: 9000, totalTokens: 11840,
  }));
  const r1 = s.routes[0];
  check('first message creates one attributed route', s.routes.length === 1, JSON.stringify(s.routes));
  check('route carries provider and model', r1.provider === 'pku-corpus' && r1.model === 'qwen3.8-flash');
  check('uncached input maps from usage.inputTokens', r1.uncachedInputTokens === 1200, `got ${r1.uncachedInputTokens}`);
  check('output tokens accumulated', r1.outputTokens === 640, `got ${r1.outputTokens}`);
  check('cache read accumulated', r1.cacheReadTokens === 9000, `got ${r1.cacheReadTokens}`);
  check('absent cache write is a proven zero, not undefined', r1.cacheWriteTokens === 0, `got ${r1.cacheWriteTokens}`);
  check('total accumulated', r1.totalTokens === 11840, `got ${r1.totalTokens}`);
  check('requests counted', r1.requests === 1, `got ${r1.requests}`);

  // Same route accumulates; a different route stays separate.
  s = def.apply(s, message('pku-corpus', 'qwen3.8-flash', FLASH));
  check('same route accumulates rather than duplicating', s.routes.length === 1 && s.routes[0].requests === 2,
    JSON.stringify(s.routes));
  check('accumulated sums are exact', s.routes[0].uncachedInputTokens === 1300 && s.routes[0].totalTokens === 11990,
    JSON.stringify(s.routes[0]));
  s = def.apply(s, message('pku-corpus', 'kimi-k3', { inputTokens: 10, outputTokens: 5, totalTokens: 15 }));
  check('a second model is attributed separately', s.routes.length === 2, JSON.stringify(s.routes));

  // The state must never be mutated in place: the projection layer compares
  // references to decide whether to publish.
  check('apply produced a new state object, not a mutation', s !== s0 && s0.routes.length === 0,
    `s0=${JSON.stringify(s0)}`);

  // An unusable sample must be refused without aborting the fold.
  const before = s;
  s = def.apply(s, message('pku-corpus', 'qwen3.8-flash', { inputTokens: 1.5, outputTokens: 5, totalTokens: 6 }));
  check('a fractional token count is refused and the fold survives', s === before, 'state changed');
  s = def.apply(s, message('pku-corpus', 'qwen3.8-flash', { inputTokens: -1, outputTokens: 5, totalTokens: 4 }));
  check('a negative token count is refused', s === before);
  s = def.apply(s, message('pku-corpus', 'qwen3.8-flash', { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 1, totalTokens: 1 }));
  check('an unsafe count is refused', s === before);

  // Stream-carried usage, the same fallback `usageOf` performs.
  s = def.apply(s, {
    type: 'assistant/message',
    data: {
      turn: 2, step: 1,
      message: { source: { provider: 'pku-corpus', model: 'glm' } },
      stream: [{ type: 'text' }, { type: 'usage', usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 } }],
    },
  });
  check('usage recovered from the embedded stream',
    s.routes.some((route) => route.model === 'glm' && route.totalTokens === 10), JSON.stringify(s.routes));

  // Schemas are the wire gate: `.parse` is the only method cordis calls.
  const okState = { routes: [{ provider: 'p', model: 'm', requests: 1, uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 2 }] };
  check('stateSchema.parse accepts a valid state', JSON.stringify(def.stateSchema.parse(okState)) === JSON.stringify(okState));
  check('stateSchema.parse rejects a non-object', throws(() => def.stateSchema.parse(null)));
  check('stateSchema.parse rejects a missing routes array', throws(() => def.stateSchema.parse({})));
  check('stateSchema.parse rejects a negative count', throws(() => def.stateSchema.parse({ routes: [{ ...okState.routes[0], totalTokens: -1 }] })));
  check('stateSchema.parse rejects a non-string model', throws(() => def.stateSchema.parse({ routes: [{ ...okState.routes[0], model: 7 }] })));
  check('viewSchema.parse rejects junk too', throws(() => def.wire.viewSchema.parse({ routes: [{ provider: 'p' }] })));

  // Reference-stable view: an unchanged state must not republish.
  check('view returns the state itself, so identity is stable', def.wire.view(s) === s);

  console.log(`\nroutes after the fold: ${s.routes.length}`);
  console.log(`TALLY: ${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

function throws(fn) {
  try { fn(); return false; } catch { return true; }
}
