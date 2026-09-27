/**
 * Run every suite in this directory and aggregate the result.
 *
 * Each suite is a standalone script that prints `PASS`/`FAIL` lines and a
 * `TALLY: <p> passed, <f> failed` summary, and sets a non-zero exit code on
 * failure. They are run in child processes so one suite crashing cannot hide
 * the others.
 *
 * Run: npm test
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const SUITES = [
  ['routing', 'routing.test.mjs', 'role routing, classification, and the model_manager tool'],
  ['edge', 'edge.test.mjs', 'adversarial config, keyword matching, reporting, settings reload'],
  ['failover', 'failover.test.mjs', 'agent/request-error model failover and its guards'],
  ['client-structure', 'client-structure.test.mjs', 'client half load, exports, and slot registration'],
  ['client-diagnostic', 'client-diagnostic.test.mjs', 'host-side client self-diagnosis branches'],
];

const run = (file) => new Promise((resolve) => {
  const child = spawn(process.execPath, [join(here, file)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: dirname(here),
  });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  child.stderr.on('data', (chunk) => { out += chunk; });
  child.on('error', (error) => resolve({ code: 1, out: String(error) }));
  child.on('close', (code) => resolve({ code, out }));
});

/** Read a suite's own tally, falling back to counting its PASS/FAIL lines. */
const tallyOf = (out) => {
  const match = out.match(/TALLY:\s*(\d+)\s*passed,\s*(\d+)\s*failed/);
  if (match !== null) return { passed: Number(match[1]), failed: Number(match[2]) };
  return {
    passed: (out.match(/^PASS\b/gm) ?? []).length,
    failed: (out.match(/^FAIL\b/gm) ?? []).length,
  };
};

let totalPassed = 0;
let totalFailed = 0;
let broken = 0;

console.log('dsh-model-manager — test suite\n');
for (const [name, file, what] of SUITES) {
  const { code, out } = await run(file);
  const { passed, failed: suiteFailed } = tallyOf(out);
  totalPassed += passed;
  totalFailed += suiteFailed;
  const ok = code === 0 && suiteFailed === 0;
  if (!ok) broken += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(18)} ${String(passed).padStart(4)} passed,`
    + ` ${String(suiteFailed).padStart(3)} failed   ${what}`);
  if (!ok) {
    const detail = out.split('\n')
      .filter((line) => /^(FAIL|  \* |WARN|Error|TypeError)/.test(line))
      .slice(0, 30);
    for (const line of detail) console.log(`        ${line}`);
    // Surface a crash that produced no FAIL lines at all.
    if (detail.length === 0) {
      for (const line of out.split('\n').slice(-15)) console.log(`        ${line}`);
    }
  }
}

console.log(`\n${broken === 0 ? 'ALL SUITES PASS' : `${broken} SUITE(S) FAILED`}`
  + ` — ${totalPassed} assertions passed, ${totalFailed} failed`);
process.exitCode = broken === 0 ? 0 : 1;
