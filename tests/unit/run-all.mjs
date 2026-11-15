// Runs every unit suite and judges it by the summary line it prints ("N passed, M failed"), not by the process exit code.
//
// Why: on this Windows / Node 24 setup tests/unit/matching.test.mjs intermittently dies AFTER printing "79 passed, 0 failed"
// with a libuv teardown assertion ("!(handle->flags & UV_HANDLE_CLOSING), src\win\async.c") and exit code 127. It also happens on the
// profile workstream's own commit (2eaf716), so it is not caused by the code under test; but in a `a && b && c` chain it silently
// skips every later suite. A suite counts as PASSED only if it printed a summary with 0 failures; a missing summary, a non-zero
// failure count, or any other crash is a failure.
//   node tests/unit/run-all.mjs      (npm run test:unit)
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const suites = ['matching.test.mjs', 'ai-engine.test.mjs', 'ai-assess.test.mjs'];
let bad = false;
let total = 0;
for (const s of suites) {
  const r = spawnSync(process.execPath, [join(here, s)], { encoding: 'utf8', cwd: join(here, '..', '..') });
  process.stdout.write(r.stdout ?? '');
  const m = /(\d+) passed, (\d+) failed/.exec(r.stdout ?? '');
  const teardown = /UV_HANDLE_CLOSING/.test(r.stderr ?? '');
  if (!m) { console.log(`\nSUITE ${s}: NO SUMMARY LINE (crashed)\n${r.stderr ?? ''}`); bad = true; continue; }
  total += Number(m[1]);
  if (Number(m[2]) > 0 || (r.status !== 0 && !teardown)) { console.log(`\nSUITE ${s}: FAILED (exit ${r.status})`); bad = true; }
  else if (r.status !== 0) console.log(`\n(note: ${s} passed; Node reported the known libuv teardown assertion after the summary, exit ${r.status})`);
}
console.log(`\nUNIT SUITES: ${bad ? 'FAILED' : 'PASSED'} (${total} assertions)`);
process.exit(bad ? 1 : 0);
