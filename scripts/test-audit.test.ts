/**
 * The audit has to see a file that is not committed yet.
 *
 * `scripts/test-audit.ts` enumerates with `git ls-files`, which lists TRACKED
 * files only. A brand-new test file is untracked until somebody stages it — so
 * the gate whose entire subject is new tests was blind to exactly the files
 * being added. A builder ran it locally, read a clean table, pushed, and CI
 * went red on a sleep in the file they had just written: CI checks out the
 * commit, where the file is tracked.
 *
 * This runs the real script as a subprocess against the real repo, because the
 * enumeration IS the thing under test and a unit test of a helper would not
 * have caught it. The script does its work at module load and can call
 * `process.exit`, so it cannot be imported.
 *
 * The probe file is planted, asserted on, and removed both inline and in an
 * `afterEach`, so an assertion that throws still cleans up. It is named `.ts`
 * rather than `.test.ts` on purpose: the sleep check globs
 * `packages/server/test/*.ts`, so a plain `.ts` file qualifies without any
 * runner trying to collect it as a suite.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_REL = join('packages', 'server', 'test', 'zz-audit-untracked-probe.ts');
const PROBE_ABS = join(REPO, PROBE_REL);

/**
 * The ignored twin of the probe. `.gitignore` carries a bare `dist/`, so this
 * path is ignored while still matching the sleep check's
 * `packages/server/test/*.ts` pathspec — a git glob crosses slashes. It is the
 * one place where "the audit stopped listing it" can only mean the ignore
 * rules were honoured, rather than that the pathspec never matched.
 */
const IGNORED_REL = join('packages', 'server', 'test', 'dist', 'zz-audit-ignored-probe.ts');
const IGNORED_ABS = join(REPO, IGNORED_REL);

/** A site the audit already counts, committed and tracked. */
const TRACKED_SITE = join('packages', 'markdown-app', 'test', 'back-link-tap-target-css.test.ts');

/** A file the sleep check must object to: one fixed wait, well over the bar. */
const PROBE_SOURCE = `import { sleep } from 'bun';\n\nexport async function wait(): Promise<void> {\n  await sleep(2500);\n}\n`;

type Run = { code: number | null; stdout: string; stderr: string };

/** `node:child_process`, not `Bun.spawnSync`: this suite runs under vitest,
 *  where there is no `Bun` global. */
function runAudit(...args: string[]): Run {
  const out = spawnSync('bun', ['run', 'scripts/test-audit.ts', ...args], {
    cwd: REPO,
    encoding: 'utf8',
  });
  return { code: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '' };
}

afterEach(() => {
  rmSync(PROBE_ABS, { force: true });
  rmSync(dirname(IGNORED_ABS), { force: true, recursive: true });
});

describe('the audit enumerates untracked files', () => {
  it('names an untracked test file, and fails on the sleep inside it', () => {
    // CONTROL, in the same run: with no probe planted the audit is clean and
    // does not name the path. Without this, "the audit named it" could be a
    // leftover file from an interrupted run rather than this test's doing.
    expect(existsSync(PROBE_ABS)).toBe(false);
    const before = runAudit('--list');
    expect(before.stdout).not.toContain(PROBE_REL);
    expect(before.code, `audit already failing before the probe:\n${before.stderr}`).toBe(0);

    writeFileSync(PROBE_ABS, PROBE_SOURCE);
    const after = runAudit('--list');

    // The site is named, with the file and the line the wait is on.
    expect(after.stdout).toContain(`${PROBE_REL}:4`);
    // And it is not merely listed: the count moved past the ratchet, which is
    // what turns a local run red before CI has to.
    expect(after.code).toBe(1);
    expect(after.stderr).toContain('fixedSleeps');

    rmSync(PROBE_ABS);
    // Back to clean once the file is gone, so the failure above was the probe.
    expect(runAudit().code).toBe(0);
  });

  it('still names tracked files', () => {
    // The positive control for the negative control below. Adding `--others`
    // could in principle have replaced the tracked list rather than extended
    // it, and every "the audit did not name it" assertion would still pass.
    expect(runAudit('--list').stdout).toContain(TRACKED_SITE);
  });

  it('does not name a file .gitignore ignores', () => {
    // `--others` without `--exclude-standard` drags in node_modules and build
    // output. The audit reads every file it lists, so that is a hang and a pile
    // of false sites, not just noise.
    //
    // The probe is the same offending source as above at an ignored path, so
    // the only difference between "named and red" and "unnamed and green" is
    // the ignore rules.
    mkdirSync(dirname(IGNORED_ABS), { recursive: true });
    writeFileSync(IGNORED_ABS, PROBE_SOURCE);

    const run = runAudit('--list');
    expect(run.stdout).not.toContain(IGNORED_REL);
    expect(run.code, `audit went red on an ignored file:\n${run.stderr}`).toBe(0);
  });
});
