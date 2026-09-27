/**
 * Host-side client self-diagnosis tests.
 *
 * `model_manager` with `action: "client"` exists so a missing configuration card
 * can be diagnosed without a browser: it reports whether the Host composed the
 * client half into the boot graph, serves a usable bundle, exported a Config
 * schema, and serves this plugin's settings namespace. These tests pin each
 * branch, including the failure modes that would otherwise be invisible.
 *
 * Run: npm test   (or: node test/client-diagnostic.test.mjs)
 */

import { PLUGIN } from './paths.mjs';

const plugin = await import(PLUGIN);

let passed = 0;
let failed = 0;
const check = (name, ok, observed) => {
  if (ok) { passed++; console.log(`PASS  ${name}`); }
  else { failed++; console.log(`FAIL  ${name}\n        observed: ${JSON.stringify(observed)}`); }
};

const BUNDLE = `window.__ModuleLoader__.load({ id: 'dsh-model-manager', factory(require){ return {apply(){}}; } });`;
let tools = [];

function makeCtx({ withSettings = true, bundleStatus = 200, bundleBody = BUNDLE, withModules = true } = {}) {
  return {
    logger: () => ({ info() {}, warn() {}, error() {} }),
    get(name) {
      if (name === 'clientModules') {
        if (!withModules) return undefined;
        return {
          graph: () => ({
            rev: 'ba2fce3a86ff',
            batches: [],
            entries: [
              { id: 'dsh-model-manager', url: '/plugins/dsh-model-manager/client.js?rev=ba2fce3a86ff' },
              { id: 'dshmarket', url: '/plugins/dshmarket/client.js?rev=x' },
            ],
          }),
          clientPath: (id) => (id === 'dsh-model-manager' ? '/abs/path/client.js' : undefined),
          fetchBundle: async () => ({ status: bundleStatus, text: async () => bundleBody }),
        };
      }
      if (name === 'settings') {
        return withSettings
          ? { describe: () => [{ ns: 'model-manager' }, { ns: 'subagent-model-selection-settings' }] }
          : undefined;
      }
      if (name === 'tools') return { register: (tool) => tools.push(tool) };
      return undefined;
    },
    on() {},
    inject(deps, cb) { const scoped = Object.create(this); for (const d of deps) scoped[d] = this.get(d); cb(scoped); },
    effect(fn) { fn(); },
  };
}

const CFG = { roles: { execution: { models: [{ provider: 'pku-corpus', model: 'qwen3.8-flash' }] } } };

const client = async (options) => {
  tools = [];
  plugin.apply(makeCtx(options), CFG);
  return tools.find((candidate) => candidate.name === 'model_manager').execute({ action: 'client' });
};

console.log('=== A. healthy composition ===');
{
  const out = await client();
  check('A1 the package is reported PRESENT', out.includes('PRESENT (dsh-model-manager)'), out);
  check('A2 the self-fetch reports HTTP 200', /self-fetch\s*:\s*HTTP 200/.test(out), out);
  check('A3 the bundle is recognised as a module-loader bundle', out.includes('module loader  : present'), out);
  check('A4 the bundle registers the right id', out.includes('registers id   : yes'), out);
  check('A5 the Config schema is exported', out.includes('Config schema  : exported'), out);
  check('A6 our settings namespace is served', out.includes('ours (model-manager) served: YES'), out);
  check('A7 it points at the page, not at packaging', out.includes('The Host serves a usable bundle'), out);
}

console.log('\n=== B. bundle not served (a packaging problem) ===');
{
  const out = await client({ bundleStatus: 404, bundleBody: '' });
  check('B1 reports HTTP 404', /self-fetch\s*:\s*HTTP 404/.test(out), out);
  check('B2 says the browser cannot load it', out.includes('The Host did not serve a usable bundle'), out);
  check('B3 does not blame the page cache', !out.includes('The Host serves a usable bundle'), out);
}

console.log('\n=== C. bundle served but registering the wrong id ===');
{
  const out = await client({ bundleBody: 'window.__ModuleLoader__.load({ id: "wrong-name", factory(){} });' });
  check('C1 flags the missing registration', out.includes('registers id   : NO'), out);
  check('C2 treats it as a packaging problem', out.includes('The Host did not serve a usable bundle'), out);
}

console.log('\n=== D. settings namespace not served ===');
{
  const out = await client({ withSettings: false });
  check('D1 reports the settings service as unavailable', out.includes('settings namespaces: unavailable'), out);
  check('D2 does not claim our namespace is served', !out.includes('served: YES'), out);
}

console.log('\n=== E. no clientModules service at all ===');
{
  const out = await client({ withModules: false });
  check('E1 says the composition has no clientModules', out.includes('no clientModules service'), out);
}

console.log('\n=== F. a throwing self-fetch must not break the action ===');
{
  tools = [];
  const ctx = makeCtx();
  ctx.get = (name) => {
    if (name === 'clientModules') {
      return {
        graph: () => ({ rev: 'r', entries: [{ id: 'dsh-model-manager', url: '/p' }] }),
        clientPath: () => '/x',
        fetchBundle: () => { throw new Error('boom'); },
      };
    }
    return name === 'tools' ? { register: (tool) => tools.push(tool) } : undefined;
  };
  plugin.apply(ctx, CFG);
  let threw = null;
  let out = '';
  try {
    out = await tools.find((candidate) => candidate.name === 'model_manager').execute({ action: 'client' });
  } catch (error) { threw = error; }
  check('F1 the action survives a throwing fetchBundle', threw === null, threw && threw.message);
  check('F2 it reports the failure', out.includes('self-fetch     : FAILED'), out);
}

console.log('\n===================================================================');
console.log(`TALLY: ${passed} passed, ${failed} failed, ${passed + failed} total`);
process.exitCode = failed ? 1 : 0;
