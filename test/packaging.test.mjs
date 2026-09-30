/**
 * Packaging invariants for @jyshangguan/dsh-model-manager.
 *
 * The package name appears in four files that nothing else cross-checks:
 * package.json, the bundle patch's loader row, the client half's module-loader
 * id, and the host half's PACKAGE_NAME. A rename that misses one of them does
 * not fail loudly — the loader resolves a row whose package is absent, or the
 * client diagnostic reports the bundle as ABSENT while everything else looks
 * fine. These assertions make that class of mistake a test failure.
 *
 * They also pin the strings that must NOT follow the package name, because
 * "consistency" is exactly the instinct that would break them.
 */
import { readFileSync, existsSync, globSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0;
let failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`PASS  ${label}`); }
  else { failed++; console.log(`FAIL  ${label}${detail ? `\n        ${detail}` : ''}`); }
};

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const NAME = manifest.name;
const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8');
const client = readFileSync(join(ROOT, 'client.js'), 'utf8');
const host = readFileSync(join(ROOT, 'lib/index.js'), 'utf8');

console.log('\n1. identity');
check('the package name is scoped under the owner',
  NAME === '@jyshangguan/dsh-model-manager', NAME);
check('the unscoped name is not used — it is taken on npm by another plugin',
  !NAME.startsWith('dsh-') || NAME.includes('/'), NAME);
check('the bundle patch mounts that exact package',
  patch.includes(`name: '${NAME}'`),
  patch.split('\n').filter((l) => l.includes('name:')).join(' | ').slice(0, 160));
check('the client half registers under that exact module id',
  client.includes(`id: '${NAME}',`), client.split('\n').find((l) => l.includes('id:')) ?? '');
check('the host half diagnoses that exact package name',
  host.includes(`const PACKAGE_NAME = '${NAME}';`),
  host.split('\n').find((l) => l.includes('PACKAGE_NAME =')) ?? '');

console.log('\n2. the loader row id and locale namespace stay unscoped on purpose');
check('the cordis row id is still model-manager',
  patch.includes('- id: model-manager'), 'a scoped row id would orphan every existing profile override');
check('the host cordis identity is still model-manager',
  host.includes(`export const name = 'model-manager';`));
check('the client row namespace is still model-manager',
  client.includes(`const ROW_NS = 'model-manager';`));
check('the locale namespace did not follow the rename',
  client.includes(`const LOCALE_NS = 'dsh-model-manager';`),
  'changing it would silently retitle every string in the card');

console.log('\n3. publishability');
check('the package is not marked private', manifest.private === undefined,
  `private: ${JSON.stringify(manifest.private)}`);
check('a scoped package publishes publicly by default',
  manifest.publishConfig?.access === 'public', JSON.stringify(manifest.publishConfig));
check('the runtime version gate is declared and is not a wildcard',
  typeof manifest.peerDependencies?.['@deepseek-ai/dsh'] === 'string'
    && manifest.peerDependencies['@deepseek-ai/dsh'].trim() !== '*'
    && manifest.peerDependencies['@deepseek-ai/dsh'].trim() !== '',
  JSON.stringify(manifest.peerDependencies?.['@deepseek-ai/dsh']));

// The gate is not a string to eyeball: the harness evaluates it with
// `includePrerelease: true`, and prerelease ordering is the trap. A prerelease
// sorts BELOW its release, so `0.2.0-rc.2 < 0.2.0` is true and a `<0.2.0` upper
// bound admits every 0.2.0 prerelease while excluding 0.2.0 itself. The
// comparator is deliberately tiny and self-validating: the first assertion
// below fails if its ordering is wrong, so the ones after it mean something.
const parseVersion = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (m === null) throw new Error(`not a version: ${v}`);
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? [] : m[4].split('.') };
};
const compareVersions = (a, b) => {
  const A = parseVersion(a);
  const B = parseVersion(b);
  for (let i = 0; i < 3; i++) if (A.nums[i] !== B.nums[i]) return A.nums[i] < B.nums[i] ? -1 : 1;
  if (A.pre.length === 0 || B.pre.length === 0) {
    if (A.pre.length === B.pre.length) return 0;
    return A.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(A.pre.length, B.pre.length); i++) {
    const x = A.pre[i];
    const y = B.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) { if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1; }
    else if (xn !== yn) return xn ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
};
check('the comparator orders prereleases the way semver does (a release outranks its prereleases)',
  compareVersions('0.2.0-rc.2', '0.2.0') === -1
    && compareVersions('0.2.0', '0.2.0-rc.2') === 1
    && compareVersions('0.1.7-rc.1', '0.1.7-rc.2') === -1
    && compareVersions('0.2.0', '0.2.0') === 0
    && compareVersions('0.1.7', '0.2.0') === -1);

const DSH_PEER = manifest.peerDependencies?.['@deepseek-ai/dsh'] ?? '';
const gate = /^>=(.+?)\s+<(.+)$/.exec(DSH_PEER.trim());
const admits = (v) => gate !== null
  && compareVersions(v, gate[1].trim()) >= 0 && compareVersions(v, gate[2].trim()) < 0;
check('the gate is a lower-and-upper bound the comparator can read',
  gate !== null, DSH_PEER);
check('the gate admits 0.1.7-rc.2, the runtime the plugin was written against',
  admits('0.1.7-rc.2'), DSH_PEER);
check('the gate admits 0.2.0-rc.2, the runtime both halves were verified against',
  admits('0.2.0-rc.2'), DSH_PEER);
check('the gate admits 0.2.0 itself, so shipping rc.2 does not push the plugin out of range',
  admits('0.2.0'), DSH_PEER);
check('the gate refuses 0.3.0, a line nothing here has been tested on',
  !admits('0.3.0'), DSH_PEER);
check('the gate refuses a runtime older than the one it was written against',
  !admits('0.1.6'), DSH_PEER);
check('the upper bound is not <0.2.0, which semver reads as "every 0.2.0 prerelease"',
  !DSH_PEER.includes('<0.2.0'), DSH_PEER);
check('schemastery stays an optional peer so a resolution failure degrades',
  manifest.peerDependenciesMeta?.['@deepseek-ai/schemastery']?.optional === true,
  JSON.stringify(manifest.peerDependenciesMeta));
check('repository metadata is present for the registry listing',
  typeof manifest.repository?.url === 'string' && manifest.repository.url.includes('dsh-model-manager'),
  JSON.stringify(manifest.repository));

console.log('\n4. the published tarball would actually work');
check('the bundle declares a patch the loader can read',
  typeof manifest.dsh?.bundle?.patch === 'string'
    && existsSync(join(ROOT, manifest.dsh.bundle.patch)),
  JSON.stringify(manifest.dsh?.bundle));
check('the client half declares its platform and injections',
  manifest.dsh?.client?.platform === 'web'
    && Array.isArray(manifest.dsh?.client?.inject)
    && manifest.dsh.client.inject.length > 0
    && manifest.dsh.client.inject.every((n) => n.startsWith('@deepseek-ai/')),
  JSON.stringify(manifest.dsh?.client));
check('every exports target exists',
  Object.entries(manifest.exports ?? {}).every(([key, target]) => key === './package.json'
    || existsSync(join(ROOT, String(target).replace(/^\.\/locale\/\*\.json$/, 'locale/en.json')))),
  JSON.stringify(manifest.exports));
// `files` is what npm packs. A missing entry publishes a bundle that installs
// cleanly and then cannot mount, so resolve each pattern against the disk.
const packed = manifest.files ?? [];
const resolves = (pattern) => pattern.includes('*')
  ? globSync(pattern, { cwd: ROOT }).length > 0
  : existsSync(join(ROOT, pattern));
check('every files pattern matches something on disk',
  packed.length >= 5 && packed.every(resolves),
  packed.filter((p) => !resolves(p)).join(', ') || `patterns: ${packed.join(', ')}`);
for (const required of ['lib', 'client.js', 'cordis.patch.yml', 'README.md']) {
  check(`files includes ${required}`, packed.includes(required), packed.join(', '));
}
check('locale dictionaries exist for both languages',
  existsSync(join(ROOT, 'locale/en.json')) && existsSync(join(ROOT, 'locale/zh.json')));

console.log(`\nTALLY: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
