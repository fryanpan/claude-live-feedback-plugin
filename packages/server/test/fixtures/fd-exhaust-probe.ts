/**
 * Child-process fixture for fd-contention.test.ts: under a lowered
 * `ulimit -n`, exhaust the remaining descriptors on purpose and report what
 * the probe says. Run with `bun run`, never as a test — the exhaustion must
 * live and die in a throwaway process so it cannot destabilize the suite.
 */
import { openSync } from 'node:fs';
import { fdContentionError } from '../fd-contention.ts';

const CAP = 4096;
const held: number[] = [];
try {
  // The cap guards against an environment whose limit was not actually
  // lowered; the caller asserts `exhausted < CAP` to prove real exhaustion
  // rather than a loop that gave up.
  for (let i = 0; i < CAP; i++) held.push(openSync('/dev/null', 'r'));
} catch {}
const err = fdContentionError();
console.log(JSON.stringify({ exhausted: held.length, message: err ? err.message : null }));
