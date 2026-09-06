#!/usr/bin/env bun
/**
 * Mechanical audit of the testing standards in .claude/rules/testing-standards.md.
 *
 * Three counts, each a proxy for one standard. A proxy is not the standard:
 * the script cannot tell a test that asserts behaviour from one that asserts
 * source text, so every check below states the pattern it actually matches and
 * the rule file states the standard the pattern stands in for.
 *
 * The counts ratchet. scripts/test-audit.baseline.json holds the highest count
 * each check is allowed to reach; exceeding it fails. Lower a baseline in the
 * same commit that lowers the count, never on its own.
 *
 * Files are enumerated tracked AND untracked-but-not-ignored, so a test file
 * you have written but not staged is judged here exactly as CI will judge it
 * once it is committed. See `gitFiles` for what went wrong when it was not.
 *
 *   bun run test:audit            print the table, exit non-zero over baseline
 *   bun run test:audit --list     also print every matching site
 *   bun run test:audit --write    rewrite the baseline to today's counts
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const baselinePath = join(repoRoot, 'scripts', 'test-audit.baseline.json');

type Site = { file: string; line: number; text: string };
type Check = { id: string; title: string; pattern: string; sites: Site[] };

function lsFiles(args: string[], globs: string[]): string[] {
  const out = Bun.spawnSync(['git', 'ls-files', ...args, ...globs], { cwd: repoRoot });
  if (out.exitCode !== 0) throw new Error(`git ls-files failed: ${out.stderr.toString()}`);
  return out.stdout.toString().split('\n').filter(Boolean);
}

/**
 * Every file matching the globs that this audit should judge: tracked, plus
 * untracked-and-not-ignored.
 *
 * The second half is the whole point. A brand-new test file is untracked until
 * somebody stages it, and `git ls-files` alone cannot see it — so the audit
 * whose entire subject is NEW tests was blind to exactly the files being added.
 * A builder ran it locally, got a clean table, pushed, and CI failed on the
 * sleep in the file they had just written: CI checks out the commit, where the
 * file IS tracked. The gate was reporting on a different set of files than the
 * one it was defending.
 *
 * `--exclude-standard` keeps .gitignore honoured, so build output and local
 * scratch files stay out.
 *
 * Linked worktrees are dropped by name rather than left to the ignore rules.
 * This repo's worktrees live at `.claude/worktrees/<branch>`, INSIDE the
 * primary checkout, so `--others` would otherwise walk into every branch in
 * progress and count its test files as this one's. They are excluded today
 * only by a line in `.git/info/exclude`, which is local and uncommitted — a
 * clone without it would fail the ratchet on somebody else's work in progress.
 *
 * Files are then filtered to those that exist on disk: `git ls-files` still
 * lists a tracked file that has been deleted in the working tree, and reading
 * one throws ENOENT and takes down the whole audit.
 */
const WORKTREES = `.claude${sep}worktrees${sep}`;

function gitFiles(...globs: string[]): string[] {
  const tracked = lsFiles([], globs);
  const untracked = lsFiles(['--others', '--exclude-standard'], globs);
  return [...new Set([...tracked, ...untracked])]
    .filter((rel) => !rel.includes(WORKTREES))
    .filter((rel) => existsSync(join(repoRoot, rel)))
    .sort();
}

const read = (rel: string): string[] => readFileSync(join(repoRoot, rel), 'utf8').split('\n');

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * A `// timed:` marker exempts a wait. It may sit on the line itself or
 * anywhere in the contiguous comment block directly above it, so the marker
 * can be written next to the sentence that explains the window.
 */
function isTimed(lines: string[], i: number): boolean {
  if (/\/\/\s*timed:/.test(lines[i] ?? '')) return true;
  for (let j = i - 1; j >= 0 && COMMENT_LINE.test(lines[j] ?? ''); j--) {
    if (/timed:/.test(lines[j] ?? '')) return true;
  }
  return false;
}

// 1. Fixed sleeps of 500ms or more in the server suite.
//    Matches `sleep(N)` and `setTimeout(fn, N)`, where N is a literal OR the
//    name of a millisecond constant declared in the same file. Resolving names
//    matters: 16 waits of 2400ms hid behind one `SETTLE_MS` and this check
//    reported zero while they ran.
const SLEEP =
  /(?:\bsleep\(\s*([\w$]+)\s*\)|\bsetTimeout\(\s*[A-Za-z_$][\w$]*\s*,\s*([\w$]+)\s*\))/g;
const MS_CONST = /^\s*(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*number\s*)?=\s*(\d[\d_]*)\s*;/;

/** Millisecond constants declared in a file, so `sleep(SETTLE_MS)` resolves. */
function msConstants(lines: string[]): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of lines) {
    const m = line.match(MS_CONST);
    if (m?.[1] && m[2]) found.set(m[1], Number(m[2].replace(/_/g, '')));
  }
  return found;
}

function fixedSleeps(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('packages/server/test/*.ts')) {
    const lines = read(file);
    const consts = msConstants(lines);
    lines.forEach((text, i) => {
      // A sleep NAMED in a comment is prose, not a wait.
      if (COMMENT_LINE.test(text)) return;
      for (const m of text.matchAll(SLEEP)) {
        const raw = m[1] ?? m[2] ?? '';
        // `.replace` matters: `setTimeout(r, 15_000)` is a legal literal, and
        // `Number('15_000')` is NaN — which read as "below the threshold" and
        // hid the single slowest wait in the suite for a whole conversion pass.
        const ms = /^\d/.test(raw)
          ? Number(raw.replace(/_/g, ''))
          : (consts.get(raw) ?? Number.NaN);
        if (ms >= 500 && !isTimed(lines, i)) sites.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return {
    id: 'fixedSleeps',
    title: 'fixed sleeps >= 500ms (server suite)',
    pattern:
      'sleep(N) or setTimeout(fn, N) with N >= 500 — N literal or a ms constant declared in the same file — without a `// timed:` marker',
    sites,
  };
}

// 2. Source-shape tests: a test that reads a source, bundle or stylesheet file
//    from the repo and asserts on its text.
//
//    Two blind spots closed. The check used to look only INSIDE `*.test.ts`
//    for the read, so nine MCP tests that read `packages/mcp/src` through
//    `test/harness/mcp-source.ts` were invisible — and two of them had
//    silently widened their slice to the whole file tail while the table
//    stayed green. And it used to require `toContain`/`toMatch`, so
//    `shell-grid-placement.test.ts` and `list-indent-css.test.ts`, which
//    parse a stylesheet and assert the parsed value with `toBe` and
//    `toBeGreaterThanOrEqual`, had never been counted at all.
//
//    So a test now counts when it reads source directly OR imports a module
//    that does. Moving the read one file away is not an escape.
//
//    What it still cannot see, so that nobody reads a clean table as proof:
//
//    - A read whose path is in a constant declared elsewhere.
//      `review-item-tools.test.ts` reads a `BUNDLE` const built twenty lines
//      up, and no window over the call site can see it. A WRAPPED call is no
//      longer in this list: `readCallArgs` follows the call across the lines
//      the formatter put it on, so the literal only has to be inside the
//      call's own parentheses, not on the same line as its name.
//    - A support module outside a `test/` directory. The walk stops at the
//      edge of the test tree on purpose, and a reader parked in `src/` or in
//      a sibling `helpers/` is therefore invisible.
//    - `require()`. Only `import` specifiers are followed.

/** A read call. The path may be computed, so the literal is matched separately. */
const READ_CALL = /(?:readFileSync|readFile|Bun\.file)\(/;

/**
 * A quoted literal naming a source, bundle or stylesheet path.
 *
 * `fixtures/` is excluded on purpose: a test that reads its own fixture and
 * asserts on it is testing a parser against sample input, which is behaviour.
 * Without the exclusion a fixture named `.css` or `.js` would count, and the
 * standard this check stands in for has nothing to say about it.
 */
const FIXTURE_PATH = /(?:^|\/)fixtures?(?:\/|$)/;
const SOURCE_PATH = /(?:^|\/|\.\.)(?:src|dist)(?:\/|$)|\.css$|\.js$|packages\/plugin/;

/** Does this quoted string name a source path the audit cares about? */
function isSourcePath(literal: string): boolean {
  return !FIXTURE_PATH.test(literal) && SOURCE_PATH.test(literal);
}

/** Source-path literals anywhere on a line. */
function sourceLiterals(text: string): string[] {
  return [...text.matchAll(/['"`]([^'"`\n]*)['"`]/g)]
    .map((m) => m[1] ?? '')
    .filter((l) => isSourcePath(l));
}

/** A read whose own call carries a source path — the precise, per-line form. */
function readsSourceOnLine(text: string): boolean {
  if (!READ_CALL.test(text)) return false;
  return sourceLiterals(text).length > 0;
}

/**
 * Every read call STARTING on a line, as an offset just past its `(`.
 *
 * A separate global regex because `READ_CALL` above is used with `.test()`,
 * and a `g` flag makes `.test()` stateful across calls.
 */
const READ_CALL_G = /(?:readFileSync|readFile|Bun\.file)\(/g;

/**
 * How far a wrapped call may run. Twelve lines is far past anything biome
 * produces and still a bound: the walk gives up rather than reading on.
 */
const MAX_CALL_LINES = 12;

/**
 * The text between a read call's parentheses, followed across the lines the
 * formatter wrapped it onto.
 *
 * WHY THIS EXISTS. The per-line form above needs the call and its path
 * literal on one line, and a formatter decides that. `bun run test:audit`
 * counted 52 sites, then 51, and the site that vanished had not been
 * converted: PR 718 renamed `src/hub/` to `src/board/`, the longer name
 * pushed a `readFileSync(join(__dirname, '..', 'src', 'hub', …))` in
 * `walk-handoff.test.ts` past biome's width, biome wrapped it, and the call
 * and its literal landed on different lines. The site was still there and
 * still grepping source. Two builders on unrelated PRs read the drop as
 * harmless. A ratchet you can lower by renaming a directory is not a ratchet.
 *
 * WHY THE WINDOW IS THE PARENTHESES AND NOT N LINES. A fixed multi-line
 * window finds "sites" that are not reads: a `readFileSync(tmp, 'utf8')`
 * followed by an unrelated `resolve(dir, '../src/x.ts')` on the next line
 * would count, and a detector that over-counts is as useless as one that
 * under-counts. Balancing the parentheses means the text examined is exactly
 * the call's own arguments — the next statement can never be inside it.
 *
 * Quoted strings do not move the depth (a path may legally contain a
 * parenthesis) and `//` comments are dropped rather than walked: the marker
 * comments inside `launcher.test.ts`'s `JSON.parse(` argument carry
 * backticks, and treating those as string delimiters would swallow the rest
 * of the call.
 *
 * Returns undefined when the parens do not balance inside the cap. The
 * caller then falls back to the start line alone, so a pathological call
 * never widens the window instead of narrowing it.
 */
function readCallArgs(lines: string[], start: number, from: number): string | undefined {
  let depth = 1;
  let out = '';
  const last = Math.min(lines.length, start + MAX_CALL_LINES);
  for (let i = start; i < last; i++) {
    const line = lines[i] ?? '';
    let quote = '';
    for (let j = i === start ? from : 0; j < line.length; j++) {
      const ch = line[j] ?? '';
      if (quote) {
        out += ch;
        if (ch === '\\') {
          out += line[j + 1] ?? '';
          j++;
        } else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch;
        out += ch;
        continue;
      }
      if (ch === '/' && line[j + 1] === '/') break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return out;
      }
      out += ch;
    }
    out += ' ';
  }
  return undefined;
}

/**
 * Does a read call starting on this line name a source path in its arguments?
 *
 * The per-line form is kept as the first half of a union rather than replaced.
 * It matches the whole line, so a read whose literal sits outside its own
 * parentheses but on the same line — `const p = join(d, '../src/a.ts'); const
 * t = readFileSync(p, 'utf8');` — stays counted. Narrowing to the arguments
 * alone would have quietly dropped sites while claiming to add them.
 */
function readsSource(lines: string[], i: number): boolean {
  const text = lines[i] ?? '';
  if (readsSourceOnLine(text)) return true;
  READ_CALL_G.lastIndex = 0;
  for (const m of text.matchAll(READ_CALL_G)) {
    const args = readCallArgs(lines, i, (m.index ?? 0) + m[0].length);
    if (args !== undefined && sourceLiterals(args).length > 0) return true;
  }
  return false;
}

/**
 * Does this MODULE read repo source at all?
 *
 * Deliberately looser than the per-line form: `mcp-source.ts` reads
 * `readFileSync(join(SRC_DIR, f), 'utf8')`, where the only source-shaped
 * literal in the file is the `'../../src'` that built `SRC_DIR` twenty lines
 * up. A per-line rule sees nothing there, which is how nine tests hid.
 */
function moduleReadsSource(lines: string[]): boolean {
  if (!lines.some((l) => READ_CALL.test(l) && !COMMENT_LINE.test(l))) return false;
  return lines.some((l) => !COMMENT_LINE.test(l) && sourceLiterals(stripImports(l)).length > 0);
}

/**
 * An import specifier is not a read.
 *
 * `packages/server/test/wait-for.ts` polls files at runtime paths and imports
 * `../src/doc-store-timings.ts` for the cadence constants. Counting that specifier
 * as a source path made every one of its thirty-two importers a source-shape
 * test — a bigger false positive than the blind spot this check was fixing.
 */
const IMPORT_CLAUSE = /(?:from\s*|\bimport\s*\(?\s*)['"][^'"]*['"]/g;

function stripImports(text: string): string {
  return text.replace(IMPORT_CLAUSE, '');
}

/**
 * Every exported VALUE, and whether its type is written down.
 *
 * `annotated` is the load-bearing half. An export with no annotation is not
 * evidence that the module returns no text — it is the absence of evidence,
 * and `export const BOARD_TEXT = TEXT['board.css'];` appended to a harness is a
 * one-line hole that inference would happily fill with `string` while a
 * regex sees nothing. So an unannotated export lapses the exemption on its
 * own, and `export {`, `export *`, `export default` and `export class` all
 * count as unannotated for the same reason: nothing on the line says what
 * comes out.
 *
 * Exported types and interfaces are skipped. `export type SheetName =
 * 'board.css' | …` is a string union that hands no test any stylesheet text.
 */
type ExportedValue = { annotated: boolean; type: string };

function exportedValues(lines: string[]): ExportedValue[] {
  const out: ExportedValue[] = [];
  const opaque: ExportedValue = { annotated: false, type: '' };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^export\s+(?:type|interface)\b/.test(line)) continue;
    if (/^export\s+(?:\*|\{|default\b|(?:abstract\s+)?class\b)/.test(line)) {
      out.push(opaque);
      continue;
    }
    if (/^export\s+(?:async\s+)?function\b/.test(line)) {
      // Walk to the line that closes the signature: a multi-line signature
      // puts the return type on the `): T {` line, not the `export` line.
      for (let j = i; j < lines.length && j < i + 40; j++) {
        const end = (lines[j] ?? '').match(/\)\s*(?::\s*([^{]*?))?\s*\{\s*$/);
        if (end) {
          out.push({ annotated: end[1] !== undefined, type: end[1] ?? '' });
          i = j;
          break;
        }
      }
      continue;
    }
    const value = line.match(/^export\s+(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*(?::\s*([^=]+))?=/);
    if (value) out.push({ annotated: value[1] !== undefined, type: value[1] ?? '' });
  }
  return out;
}

/**
 * The exemption, and why it is shaped this way.
 *
 * A module that reads source is assumed to hand that text to its importers.
 * `packages/workspaces-app/test/css-harness.ts` is the honest exception: it
 * reads four stylesheets only to INSTALL them in the test document, keeps the
 * text in a module-private map, and returns computed styles and elements. Its
 * forty-six importers assert behaviour and must not count.
 *
 * Claiming the exemption takes three things, each of which a reader can check
 * on its own:
 *
 *  - a marker comment on a line of its own, holding nothing but the marker.
 *    Prose that merely quotes the phrase does not exempt anything — the first
 *    cut matched the phrase anywhere, so deleting the real marker from
 *    `css-harness.ts` changed no count at all, because the module's header
 *    paragraph said the words.
 *  - every exported value annotated. No annotation is no evidence.
 *  - no annotation naming `string`.
 *
 * So the marker cannot buy silence on its own: write it over a
 * `function readSource(): string`, or over an export with no type at all, and
 * the check counts you anyway. That is what stops the exemption from becoming
 * the new hiding place, the way "put the read in a helper" was the old one.
 */
const NO_TEXT_MARKER = /^\s*\/\/\s*audit:\s*no-text\s*$/;

function providesSourceText(rel: string): boolean {
  const lines = read(rel);
  if (!moduleReadsSource(lines)) return false;
  if (!lines.some((l) => NO_TEXT_MARKER.test(l))) return true;
  return exportedValues(lines).some((v) => !v.annotated || /\bstring\b/.test(v.type));
}

/** Relative import specifiers: static, side-effect and dynamic. */
const IMPORT_SPECIFIER = /(?:from\s*|\bimport\s*\(?\s*)['"](\.[^'"]+)['"]/g;

/**
 * The walk stops at the edge of the test tree.
 *
 * A test that imports `../src/server.ts` is importing the SUBJECT, and the
 * subject reads stylesheets and bundles as its day job — following the import
 * in there counts every server test as a source-shape test and the number
 * stops meaning anything (314 sites, against 18 real ones, when this filter
 * was missing). What the check is looking for is a test-support module that
 * reads source ON A TEST'S BEHALF, and those live beside the tests.
 */
const TEST_DIR = /(?:^|\/)tests?\//;

function inTestTree(rel: string): boolean {
  return TEST_DIR.test(rel);
}

function resolveImport(fromRel: string, spec: string): string | undefined {
  const base = join(repoRoot, dirname(fromRel), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    base.replace(/\.js$/, '.ts'),
    join(base, 'index.ts'),
  ];
  for (const abs of candidates) {
    if (/\.tsx?$/.test(abs) && existsSync(abs)) return relative(repoRoot, abs);
  }
  return undefined;
}

/**
 * Does this module, or anything it imports, provide source text? Transitive,
 * so a harness that wraps another harness is still counted, and memoised
 * because forty-six test files ask about the same two modules.
 */
const textProviderCache = new Map<string, boolean>();

function providesTransitively(rel: string, seen = new Set<string>()): boolean {
  const cached = textProviderCache.get(rel);
  if (cached !== undefined) return cached;
  if (seen.has(rel)) return false;
  seen.add(rel);
  let answer = false;
  if (inTestTree(rel) && existsSync(join(repoRoot, rel))) {
    answer = providesSourceText(rel);
    if (!answer) {
      const body = readFileSync(join(repoRoot, rel), 'utf8');
      for (const m of body.matchAll(IMPORT_SPECIFIER)) {
        const next = resolveImport(rel, m[1] ?? '');
        if (next && providesTransitively(next, seen)) {
          answer = true;
          break;
        }
      }
    }
  }
  if (seen.size === 1) textProviderCache.set(rel, answer);
  return answer;
}

/**
 * A `// audit: not-source — <reason>` marker exempts ONE read site.
 *
 * WHY A SECOND EXEMPTION EXISTS. The module-level `audit: no-text` marker
 * answers "this harness does not hand source text to its importers". It has
 * nothing to say about the other way this check reports a site it should not:
 * a read whose PATH is not repo source at all. Two shapes of that are already
 * in the tree and neither is a source grep —
 *
 *  - `readFileSync(join(rel.markdownAppDir, 'app.js'))` in
 *    `client-release.test.ts`, where the directory is a tmpdir the test
 *    published into a moment earlier. The bare filename `'app.js'` is what
 *    matches, and restricting `.js` to literals containing a slash would hide
 *    the real stylesheet sites, which are bare filenames too (`'board.css'`).
 *  - `JSON.parse(readFileSync('packages/plugin/.claude-plugin/plugin.json'))`
 *    in `launcher.test.ts`, which compares two artifacts' PARSED fields and
 *    asserts on no text at all.
 *
 * A third shape, added when the MCP sweep reached it: a read whose path IS
 * repo source, but whose text is the INPUT to the transform under test rather
 * than its subject. `css-minify.test.ts` feeds the widget stylesheet's raw
 * literal to `minifyCss` and asserts only RELATIONS between the input and the
 * output — every interpolation preserved, every rule block still there, the
 * result smaller. A renamed selector changes both sides and can neither pass
 * nor fail a case. It is the `fixtures/` carve-out ("a parser driven over
 * sample input is behaviour") applied where the sample has to be the real
 * file, because a copy would drift away from what the build actually feeds.
 * The discriminator a reviewer can check: is there any assertion whose
 * expected value is a literal from the file? If yes, it is a source grep and
 * this marker does not apply.
 *
 * WHAT KEEPS IT FROM BECOMING A HIDING PLACE. Three things, and the first two
 * are the same discipline `// timed:` runs on:
 *
 *  - The marker is a claim a reviewer reads, sitting on the line or in the
 *    comment block directly above it, so a diff that adds one is a diff that
 *    argues for it.
 *  - A REASON is required. `// audit: not-source` alone exempts nothing —
 *    the regex needs a dash and a non-empty word after it, so the marker
 *    cannot be pasted in as a bare silencer.
 *  - It reaches the DIRECT read form only, never the harness-import form.
 *    A test that reaches source through a reading module still counts, and
 *    still has to make its case at the module, where the exemption can be
 *    checked against what the module exports rather than believed.
 */
const NOT_SOURCE_MARKER = /\/\/\s*audit:\s*not-source\s*[—-]\s*\S/;

function isNotSource(lines: string[], i: number): boolean {
  if (NOT_SOURCE_MARKER.test(lines[i] ?? '')) return true;
  for (let j = i - 1; j >= 0 && COMMENT_LINE.test(lines[j] ?? ''); j--) {
    if (NOT_SOURCE_MARKER.test(lines[j] ?? '')) return true;
  }
  return false;
}

/**
 * An assertion on a value the test read out of a file.
 *
 * `toBe`/`toEqual`/`toStrictEqual` and the ordered comparisons join
 * `toContain`/`toMatch` because a test that PARSES a stylesheet asserts the
 * parsed value, not a substring — which is how the two stylesheet tests named
 * at the top of this section stayed uncounted while grepping `styles.css`.
 */
const TEXT_ASSERT =
  /expect\([^\n]*\)\s*(?:\.not)?\.(?:toContain|toMatch|toBe|toEqual|toStrictEqual|toBeGreaterThan|toBeGreaterThanOrEqual|toBeLessThan|toBeLessThanOrEqual)\(/;

function sourceShape(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('*.test.ts', '*.test.tsx')) {
    const lines = read(file);
    if (!lines.some((l) => TEXT_ASSERT.test(l))) continue;
    lines.forEach((text, i) => {
      if (COMMENT_LINE.test(text)) return;
      if (readsSource(lines, i)) {
        if (!isNotSource(lines, i)) sites.push({ file, line: i + 1, text: text.trim() });
        return;
      }
      for (const m of text.matchAll(IMPORT_SPECIFIER)) {
        const target = resolveImport(file, m[1] ?? '');
        if (target && providesTransitively(target)) {
          sites.push({ file, line: i + 1, text: text.trim() });
          return;
        }
      }
    });
  }
  return {
    id: 'sourceShape',
    title: 'source-shape reads (all suites)',
    pattern:
      'in a test that asserts with toContain/toMatch/toBe/toEqual/toStrictEqual or an ordered comparison: ' +
      'a readFileSync/readFile/Bun.file whose call names a path under src/ or dist/, a .css/.js file or ' +
      "packages/plugin (fixtures/ excluded) — on the call line or anywhere inside the call's own " +
      'parentheses, so wrapping it across lines hides nothing — OR an import of a test module that ' +
      'reads one. ' +
      'A reading module is assumed to hand the text on. It is exempt only when all three hold: a comment ' +
      'line holding nothing but the marker `audit: no-text`, every exported value carrying an explicit ' +
      'type or return annotation, and no annotation naming string. An unannotated export is not evidence, ' +
      'so it counts (packages/workspaces-app/test/css-harness.ts returns computed styles and is the ' +
      'module the exemption exists for). A DIRECT read is exempt when it carries ' +
      '`// audit: not-source — <reason>` on its own line or in the comment block above it — the reason ' +
      'is required, and the marker never reaches the harness-import form',
    sites,
  };
}

// 3. Wall-clock assertions: an elapsed-time delta asserted against a number.
const CLOCK_DELTA =
  /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=[^\n]*(?:Date|performance)\.now\(\)\s*[-+]/;
const CLOCK_IN_EXPECT = /expect\([^\n]*(?:Date|performance)\.now\(\)/;
function wallClock(): Check {
  const sites: Site[] = [];
  for (const file of gitFiles('*.test.ts', '*.test.tsx')) {
    const lines = read(file);
    const deltas = new Set<string>();
    for (const l of lines) {
      const m = l.match(CLOCK_DELTA);
      if (m?.[1]) deltas.add(m[1]);
    }
    lines.forEach((text, i) => {
      const named = [...deltas].some((d) =>
        new RegExp(`expect\\(\\s*${d}\\s*\\)\\s*\\.(?:not\\.)?to`).test(text),
      );
      if (named || CLOCK_IN_EXPECT.test(text)) sites.push({ file, line: i + 1, text: text.trim() });
    });
  }
  return {
    id: 'wallClock',
    title: 'wall-clock assertions (all suites)',
    pattern:
      'expect() on a Date.now()/performance.now() value or on a variable assigned from a now() delta',
    sites,
  };
}

const checks = [fixedSleeps(), sourceShape(), wallClock()];
const counts = Object.fromEntries(checks.map((c) => [c.id, c.sites.length]));

if (process.argv.includes('--write')) {
  const body = {
    _comment:
      'Ratchet for bun run test:audit. Counts may only go down. Lower a number in the same commit that lowers the count.',
    ...counts,
  };
  writeFileSync(baselinePath, `${JSON.stringify(body, null, 2)}\n`);
  console.log(`wrote ${baselinePath}`);
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Record<string, number>;

if (process.argv.includes('--list')) {
  for (const c of checks) {
    console.log(`\n# ${c.title}`);
    for (const s of c.sites) console.log(`  ${s.file}:${s.line}  ${s.text.slice(0, 110)}`);
  }
  console.log('');
}

const rows = checks.map((c) => {
  const max = baseline[c.id];
  const over = typeof max !== 'number' || c.sites.length > max;
  return { c, max, over };
});

const w = Math.max(...checks.map((c) => c.title.length));
console.log(`${'check'.padEnd(w)}  count  baseline  status`);
console.log('-'.repeat(w + 26));
for (const { c, max, over } of rows) {
  const status = over ? 'OVER' : c.sites.length < (max ?? 0) ? 'under (lower it)' : 'ok';
  console.log(
    `${c.title.padEnd(w)}  ${String(c.sites.length).padStart(5)}  ${String(max ?? '-').padStart(8)}  ${status}`,
  );
}

const failed = rows.filter((r) => r.over);
if (failed.length > 0) {
  console.error('\nOver the ratchet:');
  for (const { c, max } of failed) {
    console.error(`  ${c.id}: ${c.sites.length} > ${max ?? 'no baseline'} — matches ${c.pattern}`);
    for (const s of c.sites.slice(0, 20))
      console.error(`    ${s.file}:${s.line}  ${s.text.slice(0, 100)}`);
  }
  console.error('\nFix the new sites, or run with --list to see all of them.');
  console.error('See .claude/rules/testing-standards.md for what each check stands in for.');
  process.exit(1);
}
console.log('\nAll checks at or under the ratchet.');
