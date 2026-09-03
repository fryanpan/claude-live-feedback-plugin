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

/**
 * A site the audit already counts, committed and tracked.
 *
 * It used to name a stylesheet read in `packages/workspaces-app/test`, and
 * that whole class of site is gone — those tests install the sheets and read
 * a computed value now. What is left is the MCP suite's reads of the built
 * plugin bundle, which is a different subject and not on its way out. When
 * this file stops being a site, point this at another one from
 * `bun run test:audit --list` rather than deleting the assertion: it is the
 * positive control for the two negative controls below.
 */
const TRACKED_SITE = join('packages', 'mcp', 'test', 'channel-gate.test.ts');

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

/**
 * The source-shape check's own blind spots, and the two negatives that keep
 * closing them from swallowing the whole suite.
 *
 * Everything below is planted under one throwaway directory inside an existing
 * test tree, run through the real script once, and removed. Seven probes in a
 * SINGLE run on purpose: "the audit did not name the fixture reader" is worth
 * nothing unless the same run named something, and the counted and uncounted
 * probes differ by exactly the property under test.
 *
 * The probes are `.test.ts` because the check only enumerates `*.test.ts` and
 * `*.test.tsx` — unlike the sleep probe above, which is deliberately a plain
 * `.ts`. So each one is a real, passing, self-contained test: if a concurrent
 * `vitest run` collects one before `afterEach` removes it, it goes green
 * rather than breaking somebody else's gate.
 */
const PROBE_DIR_REL = join('packages', 'workspaces-app', 'test', 'zz-audit-source-probe');
const PROBE_DIR_ABS = join(REPO, PROBE_DIR_REL);

/** The stylesheet every probe points at: real, so a collected probe passes. */
const REAL_SOURCE = "'../../src/styles.css'";

/**
 * A harness that reads source and hands the TEXT back. Its importers must
 * count: this is `packages/mcp/test/harness/mcp-source.ts` in miniature, the
 * module through which nine MCP tests read `packages/mcp/src` invisibly.
 */
const HARNESS_TEXT = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  '',
  `const SRC = resolve(import.meta.dirname, ${REAL_SOURCE});`,
  '',
  'export function readSheet(): string {',
  "  return readFileSync(SRC, 'utf8');",
  '}',
  '',
].join('\n');

/**
 * A harness that reads source and hands back only a derived value. Its
 * importers must NOT count: this is `css-harness.ts` in miniature, the module
 * whose forty-five importers assert computed styles.
 *
 * It differs from the one above in exactly the two things the exemption asks
 * for — the marker, and no string-typed export.
 */
const HARNESS_COMPUTED = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  '',
  '// audit: no-text',
  `const TEXT = readFileSync(resolve(import.meta.dirname, ${REAL_SOURCE}), 'utf8');`,
  '',
  'export function sheetLength(): number {',
  '  return TEXT.length;',
  '}',
  '',
].join('\n');

/** Imports the text harness, asserts on what it returns. Must be counted. */
const VIA_HARNESS = [
  "import { describe, expect, it } from 'vitest';",
  "import { readSheet } from './harness-text.ts';",
  '',
  "describe('probe', () => {",
  "  it('reads source through a harness', () => {",
  "    expect(readSheet()).toContain(':root');",
  '  });',
  '});',
  '',
].join('\n');

/** Imports the computed harness. Must NOT be counted. */
const VIA_COMPUTED = [
  "import { describe, expect, it } from 'vitest';",
  "import { sheetLength } from './harness-computed.ts';",
  '',
  "describe('probe', () => {",
  "  it('reads a derived value through a harness', () => {",
  '    expect(sheetLength() > 0).toBe(true);',
  '  });',
  '});',
  '',
].join('\n');

/**
 * Reads source itself and asserts with `toBe`, never `toContain`. Must be
 * counted: this is `shell-grid-placement.test.ts`, which parses `styles.css`
 * and asserts the parsed row index, and went uncounted for the whole life of
 * the check because the matcher list stopped at `toContain`/`toMatch`.
 */
const TO_BE_READER = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  "import { describe, expect, it } from 'vitest';",
  '',
  `const CSS = readFileSync(resolve(import.meta.dirname, ${REAL_SOURCE}), 'utf8');`,
  '',
  "describe('probe', () => {",
  "  it('asserts a parsed value with toBe', () => {",
  "    expect(CSS.includes(':root')).toBe(true);",
  '  });',
  '});',
  '',
].join('\n');

/**
 * Reads its own fixture and asserts on it. Must NOT be counted — a parser
 * driven over sample input is behaviour, and the fixture is named `.css` so
 * that only the `fixtures/` exclusion, not the extension, keeps it out.
 */
const FIXTURE_READER = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  "import { describe, expect, it } from 'vitest';",
  '',
  "const SAMPLE = readFileSync(resolve(import.meta.dirname, 'fixtures/sample.css'), 'utf8');",
  '',
  "describe('probe', () => {",
  "  it('asserts on its own fixture', () => {",
  "    expect(SAMPLE).toContain('.probe');",
  '  });',
  '});',
  '',
].join('\n');

/**
 * A harness carrying the marker over a string-typed export. Its importers must
 * count ANYWAY: the marker is a claim, and the check verifies the claim rather
 * than taking it. Without this the exemption would just be the new hiding
 * place, one line cheaper than the old one.
 */
const HARNESS_MARKED_LIAR = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  '',
  '// audit: no-text',
  `const SRC = resolve(import.meta.dirname, ${REAL_SOURCE});`,
  '',
  'export function sheetText(): string {',
  "  return readFileSync(SRC, 'utf8');",
  '}',
  '',
].join('\n');

/** Imports the lying harness. Must be counted despite the marker. */
const VIA_LIAR = [
  "import { describe, expect, it } from 'vitest';",
  "import { sheetText } from './harness-liar.ts';",
  '',
  "describe('probe', () => {",
  "  it('reads source through a harness that claims otherwise', () => {",
  "    expect(sheetText()).toContain(':root');",
  '  });',
  '});',
  '',
].join('\n');

/**
 * A harness that only TALKS about the marker. Its importers must count: the
 * marker is read on a line holding nothing else, so a paragraph quoting the
 * phrase exempts nothing.
 *
 * This is the mutation that showed the first cut was hollow. The real marker
 * was deleted from `css-harness.ts` and the count did not move, because the
 * module's own header paragraph named the phrase and the regex matched it
 * anywhere on a line.
 */
const HARNESS_PROSE = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  '',
  '/**',
  ' * Nothing here hands back CSS text, which in an older check was written as',
  ' * `// audit: no-text` and believed on sight.',
  ' */',
  '// This module is no-text in spirit: see `audit: no-text` in the audit docs.',
  `const TEXT = readFileSync(resolve(import.meta.dirname, ${REAL_SOURCE}), 'utf8');`,
  '',
  'export function proseSheetLength(): number {',
  '  return TEXT.length;',
  '}',
  '',
].join('\n');

/** Imports the prose-only harness. Must be counted. */
const VIA_PROSE = [
  "import { describe, expect, it } from 'vitest';",
  "import { proseSheetLength } from './harness-prose.ts';",
  '',
  "describe('probe', () => {",
  "  it('reads through a harness that only mentions the marker in prose', () => {",
  '    expect(proseSheetLength() > 0).toBe(true);',
  '  });',
  '});',
  '',
].join('\n');

/**
 * A harness with a real marker line and one export whose type is inferred.
 * Its importers must count: no annotation is not evidence that no text comes
 * out, and `export const HUB_TEXT = TEXT['hub.css'];` appended to the real
 * `css-harness.ts` is exactly this, a one-line hole.
 */
const HARNESS_UNANNOTATED = [
  "import { readFileSync } from 'node:fs';",
  "import { resolve } from 'node:path';",
  '',
  '// audit: no-text',
  `const TEXT = readFileSync(resolve(import.meta.dirname, ${REAL_SOURCE}), 'utf8');`,
  '',
  'export function loneSheetLength(): number {',
  '  return TEXT.length;',
  '}',
  '',
  '// No annotation, so the audit has nothing to check and counts it.',
  'export const SHEET_HEAD = TEXT.slice(0, 8);',
  '',
].join('\n');

/** Imports the unannotated-export harness. Must be counted. */
const VIA_UNANNOTATED = [
  "import { describe, expect, it } from 'vitest';",
  "import { SHEET_HEAD, loneSheetLength } from './harness-unannotated.ts';",
  '',
  "describe('probe', () => {",
  "  it('reads through a harness with an unannotated export', () => {",
  '    expect(loneSheetLength() > 0).toBe(true);',
  '    expect(SHEET_HEAD.length).toBe(8);',
  '  });',
  '});',
  '',
].join('\n');

/** The 1-based line a probe's read or harness import sits on. */
function lineOf(source: string, needle: string): number {
  const i = source.split('\n').findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`probe source has no line containing ${needle}`);
  return i + 1;
}

function plantSourceProbes(): void {
  mkdirSync(join(PROBE_DIR_ABS, 'fixtures'), { recursive: true });
  writeFileSync(join(PROBE_DIR_ABS, 'harness-text.ts'), HARNESS_TEXT);
  writeFileSync(join(PROBE_DIR_ABS, 'harness-computed.ts'), HARNESS_COMPUTED);
  writeFileSync(join(PROBE_DIR_ABS, 'via-harness.test.ts'), VIA_HARNESS);
  writeFileSync(join(PROBE_DIR_ABS, 'via-computed.test.ts'), VIA_COMPUTED);
  writeFileSync(join(PROBE_DIR_ABS, 'harness-liar.ts'), HARNESS_MARKED_LIAR);
  writeFileSync(join(PROBE_DIR_ABS, 'harness-prose.ts'), HARNESS_PROSE);
  writeFileSync(join(PROBE_DIR_ABS, 'via-prose.test.ts'), VIA_PROSE);
  writeFileSync(join(PROBE_DIR_ABS, 'harness-unannotated.ts'), HARNESS_UNANNOTATED);
  writeFileSync(join(PROBE_DIR_ABS, 'via-unannotated.test.ts'), VIA_UNANNOTATED);
  writeFileSync(join(PROBE_DIR_ABS, 'via-liar.test.ts'), VIA_LIAR);
  writeFileSync(join(PROBE_DIR_ABS, 'to-be.test.ts'), TO_BE_READER);
  writeFileSync(join(PROBE_DIR_ABS, 'fixture.test.ts'), FIXTURE_READER);
  writeFileSync(join(PROBE_DIR_ABS, 'fixtures', 'sample.css'), '.probe { color: red; }\n');
}

afterEach(() => {
  rmSync(PROBE_DIR_ABS, { force: true, recursive: true });
});

describe('the audit sees a source read one module away', () => {
  it('counts the five ways a test reaches source text, and neither of the two that do not', () => {
    // CONTROL: nothing from the probe directory is named before it exists, so
    // every "named" assertion below is this test's doing.
    expect(existsSync(PROBE_DIR_ABS)).toBe(false);
    const before = runAudit('--list');
    expect(before.stdout).not.toContain(PROBE_DIR_REL);

    plantSourceProbes();
    const run = runAudit('--list');

    // Counted, with the line the read reaches the test on.
    expect(run.stdout).toContain(
      `${join(PROBE_DIR_REL, 'via-harness.test.ts')}:${lineOf(VIA_HARNESS, 'harness-text.ts')}`,
    );
    expect(run.stdout).toContain(
      `${join(PROBE_DIR_REL, 'to-be.test.ts')}:${lineOf(TO_BE_READER, 'const CSS =')}`,
    );

    // Counted despite a real marker line, because the module it imports
    // exports a string. The marker is checked, not believed.
    expect(run.stdout).toContain(
      `${join(PROBE_DIR_REL, 'via-liar.test.ts')}:${lineOf(VIA_LIAR, 'harness-liar.ts')}`,
    );

    // Counted, because the marker has to be a line of its own. A harness
    // that merely quotes the phrase in a sentence exempts nothing.
    expect(run.stdout).toContain(
      `${join(PROBE_DIR_REL, 'via-prose.test.ts')}:${lineOf(VIA_PROSE, 'harness-prose.ts')}`,
    );

    // Counted, because one export's type is inferred. The exemption asks for
    // evidence that no text comes out, and an unannotated export is none.
    expect(run.stdout).toContain(
      `${join(PROBE_DIR_REL, 'via-unannotated.test.ts')}:${lineOf(VIA_UNANNOTATED, 'harness-unannotated.ts')}`,
    );

    // Not counted. Both read a real stylesheet; what keeps them out is the
    // harness's marker line over fully annotated exports, and the
    // `fixtures/` path.
    expect(run.stdout).not.toContain(join(PROBE_DIR_REL, 'via-computed.test.ts'));
    expect(run.stdout).not.toContain(join(PROBE_DIR_REL, 'fixture.test.ts'));
  });

  it('holds on the real harnesses, not only on planted ones', () => {
    // The two modules the rule was written for. `watch-coverage.test.ts` owns
    // no read of its own — every line of source it asserts on arrives through
    // `harness/mcp-source.ts`. `board-island.test.tsx` imports `css-harness.ts`
    // and asserts computed styles with `toBe`, so it matches every widened
    // criterion except the one that matters.
    const listed = runAudit('--list').stdout;
    expect(listed).toContain(join('packages', 'mcp', 'test', 'watch-coverage.test.ts'));
    expect(listed).not.toContain(join('packages', 'workspaces-app', 'test', 'board-island'));
  });
});
