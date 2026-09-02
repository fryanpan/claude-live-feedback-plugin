#!/usr/bin/env bun
/**
 * The over-500-line gate.
 *
 * Bryan's bar is that every file over 500 lines has either been broken up or
 * been made an explicit exception. `docs/architecture/exceptions.md` is where
 * the exceptions are written down, one row per file with a verdict and a
 * reason. This script is the half that makes the doc true: it walks the source
 * tree, finds every file over the limit, and fails if one of them is not in the
 * doc.
 *
 * It deliberately does NOT judge the verdict. A row saying `Split` is still a
 * listed row — the split is queued, not done, and failing on it would take a
 * dozen unrelated PRs red. What the gate stops is a NEW god file appearing
 * with nobody having written down why.
 *
 * Rows naming a file that is gone or has since dropped under the limit are
 * printed as stale and do not fail: a PR that splits a file should tidy its
 * row, but a stale row is a doc chore, not a broken build.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LINE_LIMIT = 500;

// `import.meta.url`, not Bun's `import.meta.dir`: the colocated test runs under
// vitest, where `import.meta.dir` is undefined and module load throws.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = 'packages';
const EXCEPTIONS_DOC = join('docs', 'architecture', 'exceptions.md');

/** Extensions the bar applies to. Markdown and JSON are data, not code. */
const EXTENSIONS = ['.ts', '.css'];

/**
 * Directories never worth counting, and the one generated artifact that lives
 * under a source path: `packages/plugin/mcp/index.js` is a committed bundle
 * (CI rebuilds it and fails on drift), so its length is an output, not a
 * decision anybody makes. It is a `.js` file so the extension filter already
 * excludes it; naming it here keeps that from being an accident.
 */
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);
const SKIP_FILES = new Set([join('packages', 'plugin', 'mcp', 'index.js')]);

/** `wc -l` semantics: count newlines, so the numbers agree with the doc. */
export function countLines(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

export function isScannable(repoRelPath: string): boolean {
  if (SKIP_FILES.has(repoRelPath)) return false;
  const parts = repoRelPath.split(sep);
  if (parts.some((p) => SKIP_DIRS.has(p))) return false;
  return EXTENSIONS.some((ext) => repoRelPath.endsWith(ext));
}

/**
 * Every `packages/...` path the doc mentions, in a table cell or in prose.
 * Reasons name proposed NEW filenames too (`task-goals.ts`), but those are bare
 * names without the `packages/` prefix, so they cannot accidentally satisfy the
 * gate for a file that exists.
 */
export function listedPaths(markdown: string): Set<string> {
  const found = new Set<string>();
  const re = /packages\/[A-Za-z0-9._/-]+\.(?:ts|css)/g;
  for (const m of markdown.matchAll(re)) found.add(m[0]);
  return found;
}

export function walk(dir: string, root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, root, out);
    } else if (entry.isFile() && isScannable(rel)) {
      out.push(rel);
    }
  }
  return out;
}

export type Offender = { path: string; lines: number };

export function oversizedFiles(root: string): Offender[] {
  const scanDir = join(root, SCAN_ROOT);
  if (!existsSync(scanDir)) return [];
  const found: Offender[] = [];
  for (const rel of walk(scanDir, root)) {
    const abs = join(root, rel);
    if (!statSync(abs).isFile()) continue;
    const lines = countLines(readFileSync(abs, 'utf8'));
    if (lines > LINE_LIMIT) found.push({ path: rel, lines });
  }
  return found.sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));
}

export type AuditResult = { unlisted: Offender[]; stale: string[]; total: number };

export function audit(root: string): AuditResult {
  const docPath = join(root, EXCEPTIONS_DOC);
  if (!existsSync(docPath)) {
    throw new Error(
      `${EXCEPTIONS_DOC} is missing. It is the record of which over-${LINE_LIMIT}-line files are deliberate; without it this gate cannot pass.`,
    );
  }
  const listed = listedPaths(readFileSync(docPath, 'utf8'));
  const over = oversizedFiles(root);
  const overPaths = new Set(over.map((f) => f.path));
  return {
    unlisted: over.filter((f) => !listed.has(f.path)),
    stale: [...listed].filter((p) => !overPaths.has(p)).sort(),
    total: over.length,
  };
}

function main(): number {
  const result = audit(REPO_ROOT);

  console.log(
    `${result.total} file(s) over ${LINE_LIMIT} lines under ${SCAN_ROOT}/; ${EXCEPTIONS_DOC} lists ${result.total - result.unlisted.length} of them.`,
  );

  if (result.stale.length > 0) {
    console.log(
      `\nnote: ${result.stale.length} row(s) in ${EXCEPTIONS_DOC} name a file that is gone or now under the limit — tidy them when you next touch the doc:`,
    );
    for (const p of result.stale) console.log(`  ${p}`);
  }

  if (result.unlisted.length === 0) {
    console.log('\n✅ every file over the limit has a written verdict.');
    return 0;
  }

  console.error(
    `\n❌ ${result.unlisted.length} file(s) over ${LINE_LIMIT} lines with no row in ${EXCEPTIONS_DOC}:`,
  );
  for (const f of result.unlisted) console.error(`  ${String(f.lines).padStart(6)}  ${f.path}`);
  console.error(
    `\nEither split the file, or add a row to ${EXCEPTIONS_DOC} saying why it stays whole.`,
  );
  return 1;
}

if (import.meta.main) process.exit(main());
