/**
 * Update-check suite for @darkbear9494/dsh-model-manager (0.3.0).
 *
 * Covers the version comparator, `update` config normalization, the scheduled
 * check (boot delay + interval, cordis timer vs unref'd fallback), the
 * `model_manager` action "update" report, the `routes`/`report` status lines,
 * and the boot log — with `fetch` mocked at the global so no test touches the
 * network.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);
const { parseVersion, compareVersions, installedVersion, profileHint, readConfig } = plugin;

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));

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

console.log('--- parseVersion ---');
check('U1 a plain release parses', JSON.stringify(parseVersion('0.3.0')), '{"major":0,"minor":3,"patch":0,"prerelease":[]}');
check('U2 a v-prefix and prerelease parse', parseVersion('v1.2.3-rc.1')?.prerelease.join('.'), 'rc.1');
check('U3 build metadata is accepted', parseVersion('1.0.0+build.7')?.patch, 0);
check('U4 garbage is rejected', parseVersion('hello'), undefined);
check('U5 a partial version is rejected', parseVersion('1.2'), undefined);
check('U6 a non-string is rejected', parseVersion(3), undefined);

console.log('\n--- compareVersions ---');
check('U7 equal versions compare 0', compareVersions('0.3.0', '0.3.0'), 0);
check('U8 build metadata does not break equality', compareVersions('1.0.0+a', '1.0.0+b'), 0);
check('U9 major decides first', compareVersions('0.3.0', '0.2.9'), 1);
check('U10 minor decides next', compareVersions('0.3.0', '0.3.1'), -1);
check('U11 a release sorts above its own prerelease', compareVersions('0.3.0', '0.3.0-rc.2'), 1);
check('U12 numeric prerelease identifiers compare numerically', compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
check('U13 numeric identifiers sort below alphanumeric ones', compareVersions('1.0.0-1', '1.0.0-alpha'), -1);
check('U14 a shorter prerelease is smaller', compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
check('U15 an unparseable side yields undefined', compareVersions('nope', '1.0.0'), undefined);

console.log('\n--- installed version ---');
check('U16 installedVersion matches package.json', installedVersion(), manifest.version);

console.log('\n--- profileHint ---');
{
  const originalCwd = process.cwd();
  const fake = join(here, 'fixture', 'profiles', 'desktop');
  const { mkdirSync, rmSync } = await import('node:fs');
  try {
    mkdirSync(fake, { recursive: true });
    process.chdir(fake);
    check('U17 a cwd under profiles/<name> yields the profile', profileHint(), 'desktop');
  } finally {
    process.chdir(originalCwd);
    rmSync(join(here, 'fixture'), { recursive: true, force: true });
  }
}
checkTrue('U18 a cwd outside profiles yields undefined', profileHint() === undefined, String(profileHint()));

console.log('\n--- update config normalization ---');
{
  const defaults = readConfig({});
  check('U19 update defaults: enabled/registry/interval', JSON.stringify(defaults.update),
    JSON.stringify({ enabled: true, registry: 'https://registry.npmjs.org', intervalHours: 24 }));
  check('U20 only an explicit false disables', readConfig({ update: { enabled: false } }).update.enabled, false);
  check('U21 a non-boolean keeps checks on', readConfig({ update: { enabled: 'no' } }).update.enabled, true);
  check('U22 a trailing slash is trimmed from the registry',
    readConfig({ update: { registry: 'https://registry.npmmirror.com/' } }).update.registry, 'https://registry.npmmirror.com');
  check('U23 a non-http registry falls back to npm',
    readConfig({ update: { registry: 'ftp://example.com' } }).update.registry, 'https://registry.npmjs.org');
  check('U24 a non-string registry falls back to npm', readConfig({ update: { registry: 5 } }).update.registry, 'https://registry.npmjs.org');
  check('U25 interval 0 means boot-only', readConfig({ update: { intervalHours: 0 } }).update.intervalHours, 0);
  check('U26 a negative interval means the default', readConfig({ update: { intervalHours: -3 } }).update.intervalHours, 24);
  check('U27 a malformed interval means the default', readConfig({ update: { intervalHours: 'daily' } }).update.intervalHours, 24);
  check('U28 a fractional interval is preserved', readConfig({ update: { intervalHours: 0.5 } }).update.intervalHours, 0.5);
  const warned = readConfig({ update: { frecuency: 1 } });
  checkTrue('U29 an unknown update key warns', warned.warnings.some((w) => w.includes('update.frecuencia')) === false
    && warned.warnings.some((w) => w.includes('update.frecuency')) === true, JSON.stringify(warned.warnings));
  const validated = readConfig(new plugin.Config({ update: { registry: 'https://r.example' } }));
  check('U30 the schema-validated update block round-trips', validated.update.registry, 'https://r.example');
}

// ---------------------------------------------------------------------------
// Harness with a mockable fetch, driving the real engine end to end.
// ---------------------------------------------------------------------------
const registeredTools = [];
const sections = [];
const logs = [];
const handlers = new Map();

const makeCtx = (options = {}) => {
  const tools = {
    register: (tool) => registeredTools.push(tool),
    get: () => undefined,
  };
  const systemPrompt = { section: (s) => { sections.push(s); return () => {}; } };
  // Only services the mock can serve resolve their injection; a missing one
  // parks the fiber, exactly like real cordis — which is what keeps the
  // sessionProjections warn out of suites that do not exercise it.
  const services = { tools, systemPrompt };
  return {
    logger: () => ({
      info: (...args) => logs.push(['info', ...args]),
      warn: (...args) => logs.push(['warn', ...args]),
      error: (...args) => logs.push(['error', ...args]),
    }),
    get: (name) => services[name],
    on: (event, handler) => {
      if (options.ignoreVolatile !== true || event !== 'loader/volatile-update') {
        const list = handlers.get(event) ?? [];
        list.push(handler);
        handlers.set(event, list);
      }
    },
    inject: (deps, cb) => {
      if (deps.some((dep) => services[dep] === undefined)) return;
      const scoped = Object.create(ctxBase);
      for (const dep of deps) scoped[dep] = services[dep];
      cb(scoped);
    },
    effect: (fn) => fn(),
    ...(options.timerApi
      ? {
        timeout: (fn, ms) => { logs.push(['timeout-armed', ms]); return () => {}; },
        interval: (fn, ms) => { logs.push(['interval-armed', ms]); return () => {}; },
      }
      : {}),
  };
};
const ctxBase = {};

const ORIGINAL_FETCH = globalThis.fetch;
const fetchCalls = [];
const mockFetch = (packument, ok = true) => {
  fetchCalls.length = 0;
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), accept: init?.headers?.accept });
    if (!ok) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => packument };
  };
};
const restoreFetch = () => { globalThis.fetch = ORIGINAL_FETCH; };

const ROLES = { execution: { models: [{ provider: 'pku-corpus', model: 'qwen3.8-flash' }] } };
const applyWith = (update, ctxOptions) => plugin.apply(
  makeCtx(ctxOptions),
  { roles: ROLES, strategy: { mode: 'managed' }, update },
);
const tool = () => registeredTools.filter((candidate) => candidate.name === 'model_manager').at(-1);

console.log('\n--- the check itself ---');
try {
  {
    registeredTools.length = 0;
    applyWith(undefined);
    mockFetch({ 'dist-tags': { latest: '99.0.0' } });
    const out = await tool().execute({ action: 'update' });
    checkTrue('U31 a newer release is reported as available',
      out.includes('UPDATE AVAILABLE') && out.includes(`installed : ${manifest.version}`) && out.includes('99.0.0'),
      out);
    checkTrue('U32 the report carries the paste-ready upgrade command',
      out.includes(`dsh plugin --profile ${profileHint() ?? '<profile>'} add @darkbear9494/dsh-model-manager@latest`),
      out);
    checkTrue('U33 the registry was fetched with the abbreviated packument accept header',
      fetchCalls[0]?.url === 'https://registry.npmjs.org/@darkbear9494%2fdsh-model-manager'
        && fetchCalls[0]?.accept === 'application/vnd.npm.install-v1+json',
      JSON.stringify(fetchCalls));
    checkTrue('U34 a newer release warns in the log',
      logs.some(([level, message]) => level === 'warn' && String(message).includes('update available')), 'no warn line');
    const routesOut = await tool().execute({ action: 'routes' });
    checkTrue('U35 routes carries the update status line',
      routesOut.includes('Update check: 99.0.0 AVAILABLE'), routesOut.split('\n').find((line) => line.startsWith('Update check')));
    const reportOut = await tool().execute({ action: 'report' });
    checkTrue('U36 report mentions an available update exactly when one exists',
      reportOut.includes('99.0.0 AVAILABLE'), 'report lacks the update line');
  }

  {
    registeredTools.length = 0;
    logs.length = 0;
    applyWith(undefined);
    mockFetch({ 'dist-tags': { latest: manifest.version } });
    const out = await tool().execute({ action: 'update' });
    checkTrue('U37 the same version reads up to date', out.includes('up to date'), out);
    checkTrue('U38 an up-to-date check logs no warning',
      logs.every(([level]) => level !== 'warn'), JSON.stringify(logs.filter(([l]) => l === 'warn')));
    const routesOut = await tool().execute({ action: 'routes' });
    checkTrue('U39 routes says up to date', routesOut.includes('Update check: up to date'), 'no up-to-date line');
  }

  {
    registeredTools.length = 0;
    applyWith(undefined);
    mockFetch({ 'dist-tags': { latest: '0.0.1' } });
    const out = await tool().execute({ action: 'update' });
    checkTrue('U40 an OLDER latest still reads up to date (no downgrades suggested)', out.includes('up to date'), out);
  }

  {
    registeredTools.length = 0;
    applyWith(undefined);
    mockFetch(null, false);
    const out = await tool().execute({ action: 'update' });
    checkTrue('U41 an HTTP failure reads CHECK FAILED with the status', out.includes('CHECK FAILED') && out.includes('HTTP 404'), out);
  }

  {
    registeredTools.length = 0;
    applyWith(undefined);
    mockFetch({ versions: {} });
    const out = await tool().execute({ action: 'update' });
    checkTrue('U42 a packument without dist-tags fails loudly', out.includes('no dist-tags.latest'), out);
  }

  {
    registeredTools.length = 0;
    applyWith(undefined);
    fetchCalls.length = 0;
    globalThis.fetch = async () => { throw new Error('network down'); };
    const out = await tool().execute({ action: 'update' });
    checkTrue('U43 a rejected fetch degrades to CHECK FAILED', out.includes('CHECK FAILED') && out.includes('network down'), out);
    checkTrue('U44 a failed check logs at info, not warn',
      logs.some(([level, message]) => level === 'info' && String(message).includes('update check failed')), 'no info line');
  }

  {
    registeredTools.length = 0;
    fetchCalls.length = 0;
    applyWith({ enabled: false });
    globalThis.fetch = async () => { fetchCalls.push({ url: 'called-anyway' }); return { ok: true, json: async () => ({}) }; };
    const out = await tool().execute({ action: 'update' });
    checkTrue('U45 a disabled check never fetches', fetchCalls.length === 0, JSON.stringify(fetchCalls));
    checkTrue('U46 a disabled check explains how to re-enable', out.includes('DISABLED') && out.includes('update.enabled: true'), out);
  }

  {
    registeredTools.length = 0;
    applyWith({ registry: 'https://registry.npmmirror.com' });
    mockFetch({ 'dist-tags': { latest: '99.0.0' } });
    await tool().execute({ action: 'update' });
    checkTrue('U47 the configured registry is the one fetched',
      fetchCalls[0]?.url === 'https://registry.npmmirror.com/@darkbear9494%2fdsh-model-manager',
      JSON.stringify(fetchCalls));
  }

  console.log('\n--- scheduling ---');
  {
    logs.length = 0;
    applyWith(undefined, { timerApi: true });
    const armed = logs.filter(([kind]) => kind === 'timeout-armed' || kind === 'interval-armed');
    checkTrue('U48 the boot check is armed through the cordis timer API',
      armed.some(([kind, ms]) => kind === 'timeout-armed' && ms === 10_000), JSON.stringify(armed));
    checkTrue('U49 the 24h default interval is armed',
      armed.some(([kind, ms]) => kind === 'interval-armed' && ms === 24 * 3_600_000), JSON.stringify(armed));
  }
  {
    logs.length = 0;
    applyWith({ intervalHours: 0 }, { timerApi: true });
    const armed = logs.filter(([kind]) => kind === 'timeout-armed' || kind === 'interval-armed');
    checkTrue('U50 interval 0 arms the boot check only',
      armed.some(([kind]) => kind === 'timeout-armed') && !armed.some(([kind]) => kind === 'interval-armed'),
      JSON.stringify(armed));
  }
  {
    logs.length = 0;
    applyWith({ intervalHours: 0.01 }, { timerApi: true });
    const armed = logs.filter(([kind, ms]) => kind === 'interval-armed');
    checkTrue('U51 the interval is floored at one minute',
      armed.length === 1 && armed[0][1] === 60_000, JSON.stringify(armed));
  }
  {
    logs.length = 0;
    applyWith({ enabled: false }, { timerApi: true });
    const armed = logs.filter(([kind]) => kind === 'timeout-armed' || kind === 'interval-armed');
    checkTrue('U52 a disabled config arms no timers at all', armed.length === 0, JSON.stringify(armed));
  }

  console.log('\n--- live reload re-arms ---');
  {
    registeredTools.length = 0;
    handlers.clear();
    logs.length = 0;
    const raw = { roles: ROLES, strategy: { mode: 'managed' }, update: { enabled: true, intervalHours: 24 } };
    const volatileHandlers = [];
    const ctxVolatile = makeCtx({ timerApi: true });
    ctxVolatile.on = (event, handler) => { if (event === 'loader/volatile-update') volatileHandlers.push(handler); };
    plugin.apply(ctxVolatile, raw);
    const timeoutsBefore = logs.filter(([kind]) => kind === 'timeout-armed').length;
    // Disabling the checks DISARMS the schedule: no new timers may be armed.
    raw.update.enabled = false;
    for (const handler of volatileHandlers) handler();
    const routesOut = await tool().execute({ action: 'routes' });
    checkTrue('U53 after a volatile disable the status reads disabled',
      routesOut.includes('Update check: disabled'), routesOut.split('\n').find((line) => line.startsWith('Update check')));
    checkTrue('U54 a volatile disable disarms the schedule (no new timer armed)',
      logs.filter(([kind]) => kind === 'timeout-armed').length === timeoutsBefore,
      JSON.stringify(logs.filter(([kind]) => kind === 'timeout-armed').length));
    const reloadLog = logs.find(([level, message]) => level === 'info' && String(message).includes('settings reloaded'));
    checkTrue('U55 the reload log line names autoDelegate',
      reloadLog !== undefined && String(reloadLog[1]).includes('autoDelegate'), 'no autoDelegate in the reload log');
  }
  {
    registeredTools.length = 0;
    logs.length = 0;
    const raw = { roles: ROLES, strategy: { mode: 'managed' }, update: { enabled: true, intervalHours: 24 } };
    const volatileHandlers = [];
    const ctxVolatile = makeCtx({ timerApi: true });
    ctxVolatile.on = (event, handler) => { if (event === 'loader/volatile-update') volatileHandlers.push(handler); };
    plugin.apply(ctxVolatile, raw);
    mockFetch({ 'dist-tags': { latest: manifest.version } });
    fetchCalls.length = 0;
    const timeoutsBefore = logs.filter(([kind]) => kind === 'timeout-armed').length;
    // Changing the registry re-arms AND runs one immediate check against it.
    raw.update.registry = 'https://registry.npmmirror.com';
    for (const handler of volatileHandlers) handler();
    await new Promise((resolve) => setTimeout(resolve, 5));
    checkTrue('U54b a changed registry re-arms the schedule',
      logs.filter(([kind]) => kind === 'timeout-armed').length === timeoutsBefore + 1,
      JSON.stringify(logs.filter(([kind]) => kind === 'timeout-armed').length));
    checkTrue('U54c the immediate re-check hits the NEW registry',
      fetchCalls.some((call) => call.url.startsWith('https://registry.npmmirror.com/')), JSON.stringify(fetchCalls));
  }

  console.log('\n--- boot log ---');
  {
    logs.length = 0;
    applyWith(undefined, { timerApi: true, ignoreVolatile: true });
    const boot = logs.find(([level, message]) => level === 'info' && String(message).includes('active —'));
    checkTrue('U56 the boot line reports autoDelegate and the update schedule',
      boot !== undefined && String(boot[1]).includes('autoDelegate balanced')
        && String(boot[1]).includes('update check every 24h'),
      String(boot?.[1]));
  }
} finally {
  restoreFetch();
}

console.log(`\nTALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed === 0 ? 0 : 1;
