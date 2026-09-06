/**
 * Every supervisor diagnostic carries a clock.
 *
 * The prod err log holds lines like "server alive-but-unbound — restarting
 * via launchd", and until now not one of them was dated. launchd does not
 * stamp the file either, so 22 occurrences of that line could not be placed
 * on either side of a reboot — against a deploy criterion that asks for zero
 * of them in a 24 hour window. An undated log cannot answer a question with
 * "24h" in it, so the criterion was unanswerable rather than failing.
 *
 * `scripts/serve.ts` routes its diagnostics through a `note` helper that
 * stamps them. This asserts the routing rather than the helper — `stamped`
 * itself is covered in `log-stamp.test.ts`. A bare `console.error` added to
 * the supervisor later is exactly the regression that would quietly make the
 * log undatable again, and it is invisible to every other test in this repo,
 * because nothing else reads that file.
 *
 * This is a source-shape assertion, which is the only kind available: the
 * supervisor is a long-lived process that spawns children and talks to
 * launchd, so booting one inside the suite to read its stderr would cost far
 * more than the thing being checked is worth.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAMP_PATTERN, stamped } from '../src/log-stamp.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SERVE = join(repoRoot, 'scripts', 'serve.ts');

describe('the supervisor log', () => {
  const source = readFileSync(SERVE, 'utf8');

  it('routes every diagnostic through the stamping helper', () => {
    // The helper's own body is the one legitimate `console.error`. Everything
    // else must be a `note(...)` call.
    const bare = source
      .split('\n')
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => /(?<![\w.])console\.error\(/.test(line))
      // Inside `function note(...)`, and the doc comment above it that names
      // the verb it is replacing.
      .filter(({ line }) => !line.includes('console.error(stamped(line))'))
      .filter(({ line }) => !line.trimStart().startsWith('*'));

    expect(bare.map(({ n, line }) => `${n}: ${line.trim()}`)).toEqual([]);
  });

  it('stamps the line the restart criterion is counted from', () => {
    // Named explicitly because this is the line the 24h measurement reads,
    // and a refactor that stamped everything EXCEPT this one would still
    // leave the criterion unanswerable.
    const alive = source
      .split('\n')
      .find((line) => line.includes('alive-but-unbound') && !line.trimStart().startsWith('*'));
    expect(alive).toBeDefined();
    expect(alive).toContain('note(');
  });

  it('produces a line an ISO-8601 reader can date and order', () => {
    // The shape the log reader matches against, proved on the real helper
    // rather than restated as a regex here.
    const line = stamped('[supervisor] server alive-but-unbound — restarting via launchd', 0);
    expect(line).toMatch(STAMP_PATTERN);
    expect(line.startsWith('1970-01-01T00:00:00.000Z ')).toBe(true);
    // Lexical order is chronological, which is what makes `sort` and a
    // "since this reboot" cut work on the raw file.
    expect(stamped('x', 1) < stamped('x', 2)).toBe(true);
  });
});
