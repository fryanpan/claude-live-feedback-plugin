import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';

/**
 * Was the content a reconcile is about to overwrite written by GIT rather
 * than typed by a person?
 *
 * The disk→doc poll (`armFileWatcher`) detects change by mtime, and nothing
 * git leaves on a file distinguishes `git checkout` / `git stash` / `git pull`
 * / a rebase from an editor save — both rewrite the bytes and bump the mtime.
 * That is not fixable at the poll. Measured on a running server over synthetic
 * fixtures (2026-08-17): against an idle doc a git operation lands as `apply`,
 * and against un-flushed live edits it lands as `conflict`, where the live doc
 * wins and is reasserted onto the working tree ~800ms after git already exited
 * 0 — so the operator sees a clean checkout and the file changes back
 * underneath them a second later.
 *
 * What IS knowable, after the fact, is whether the content git left behind is
 * a blob this repository already contains. An editor save produces content the
 * object database has never seen; a checkout, a stash, a branch switch and a
 * pull all write a blob that is in it by construction. So on the conflict path
 * — the one where bytes on disk are about to be overwritten — we can name the
 * cause in the `syncError`, which turns "my checkout silently came undone"
 * into a sentence that says what happened.
 *
 * Deliberately ADVISORY: this never changes which side wins. The editor stays
 * the runtime source of truth, because letting a git-sourced write win would
 * clobber a human's un-flushed edits, which is the exact incident class the
 * conflict arm exists to prevent. A false positive can therefore only make a
 * message name git when it shouldn't; it cannot lose anyone's work.
 *
 * Cost is paid only on the conflict path, which is rare and is already writing
 * a backup file and logging.
 */

/**
 * Total wall-clock this check may spend, across ALL of its git calls.
 *
 * These are `spawnSync`, on the event loop: `reconcileFromDisk` is synchronous
 * and runs from a `setTimeout` in the mtime poll, so every millisecond spent
 * here is a millisecond the whole server is not serving anyone. A per-call
 * timeout alone is not a bound — a classification makes up to four calls, so
 * a generous per-call limit multiplies. The budget is what makes the ceiling
 * a number rather than a product.
 *
 * The budget is only enforceable because every call also passes
 * `killSignal: 'SIGKILL'`. `spawnSync`'s `timeout` sends the signal and then
 * keeps waiting, so under the default SIGTERM this ceiling is advisory and a
 * child that ignores the signal blocks for as long as it wants — measured at
 * 30,352ms against this 1,200ms figure before the signal was changed. Read the
 * two together; neither is a bound on its own.
 *
 * Staying synchronous is deliberate. Making it async would mean making
 * `reconcileFromDisk` async — the most incident-prone path in this file — and
 * would publish the `syncError` in two stages, so a reader landing between
 * them sees the un-annotated message. A hint is not worth that. What the hint
 * IS worth is bounded: normal calls are single-digit milliseconds, and an
 * answer that needs longer than this is one we would rather not have.
 * Overrunning simply yields `unknown`, which is the same thing this returns
 * for a file outside a repo — a case every caller already handles.
 */
export const PROVENANCE_BUDGET_MS = 1_200;

/** Ceiling for any single git call; the budget still caps the total. */
const GIT_CALL_TIMEOUT_MS = 400;

/** Remaining-time closure. Returns 0 once the budget is spent. */
function deadlineFrom(budgetMs: number): () => number {
  const endsAt = Date.now() + budgetMs;
  return () => Math.max(0, endsAt - Date.now());
}

/**
 * Run git with every `GIT_*` key stripped from the environment.
 *
 * git exports `GIT_DIR` (and friends) into hooks and subprocesses, and a
 * server that inherited one would be asking the WRONG repository whether it
 * holds this blob — a confidently wrong verdict rather than an absent one.
 * Nothing here writes, so this is not the destructive shape recorded in
 * learnings.md ("git exports GIT_DIR into hooks, and `git init` inherits it"),
 * but it is the same "which repo am I even talking to" hazard.
 */
function git(
  cwd: string,
  args: string[],
  remainingMs: () => number,
  input?: string,
): { ok: boolean; stdout: string } {
  const left = remainingMs();
  // Budget already spent — don't start another subprocess just to abandon it.
  if (left <= 0) return { ok: false, stdout: '' };
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  }
  try {
    const res = spawnSync('git', args, {
      cwd,
      env,
      input,
      encoding: 'utf8',
      timeout: Math.min(GIT_CALL_TIMEOUT_MS, left),
      // SIGKILL, not the default SIGTERM. `timeout` sends `killSignal` and then
      // KEEPS WAITING — it does not guarantee the child dies — so a process
      // that ignores SIGTERM blocks this synchronous call for as long as it
      // likes. Measured: a child running `trap '' TERM; sleep 30` held the
      // event loop for 30,352ms against this 1,200ms budget; the same child
      // under SIGKILL returns on time. This is not a tail risk here, because
      // `--path` below deliberately invokes the repository's configured clean
      // filter, which is arbitrary user-configured code under no obligation to
      // handle SIGTERM. SIGKILL cannot be trapped, so the budget becomes
      // enforceable rather than advisory.
      killSignal: 'SIGKILL',
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: res.status === 0, stdout: typeof res.stdout === 'string' ? res.stdout : '' };
  } catch {
    // git absent, cwd gone, spawn refused — provenance sniffing must never
    // break a reconcile.
    return { ok: false, stdout: '' };
  }
}

/** An object id in either format a repository may be using. */
function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

export type ExternalContentSource =
  | { source: 'git'; detail: string }
  | { source: 'unknown'; detail?: undefined };

/**
 * Classify content found on disk at `filePath`.
 *
 * `git` means this repository already holds that exact content as a blob, so a
 * git command almost certainly put it there. `detail` names what matched, for
 * use in a message. Everything else — including "not in a repo at all" — is
 * `unknown`.
 */
export function classifyExternalContent(
  filePath: string,
  content: string,
  budgetMs: number = PROVENANCE_BUDGET_MS,
): ExternalContentSource {
  // An empty or whitespace-only blob is in nearly every repository's object
  // database by accident, so a match on one says nothing about who wrote it.
  // Erring toward `unknown` keeps the check one-directional.
  if (content.trim() === '') return { source: 'unknown' };

  // Resolve symlinks, because `scheduleFileWrite` writes through
  // `realpathSync` — so a doc bound via a symlink from outside the repo has
  // its bytes overwritten INSIDE the repo while `dirname(filePath)` points
  // somewhere with no git at all, and every such conflict silently classifies
  // `unknown`. Fall back to the literal path if the target is gone; that only
  // costs us the hint, which is what an unresolvable path would have got.
  let resolved = filePath;
  try {
    resolved = realpathSync(filePath);
  } catch {
    // Missing or dangling — leave it; the git calls below will simply fail.
  }
  const cwd = dirname(resolved);
  const name = basename(resolved);
  const remainingMs = deadlineFrom(budgetMs);

  // Repo-relative path, so the message names the file the way git does — and
  // so the hash below can apply this path's clean filter, if it has one.
  // `--literal-pathspecs`: a basename is a FILENAME here, never a pattern.
  // Without it git reads `* ? [` as globs — `-- 'a?.md'` matches both `a1.md`
  // and `ab.md`, and taking `[0]` would name a different file — and a leading
  // `:` as pathspec magic, which returns nothing.
  const listed = git(
    cwd,
    ['--literal-pathspecs', 'ls-files', '--full-name', '--', name],
    remainingMs,
  );
  const rel = listed.ok ? listed.stdout.split('\n')[0].trim() : '';

  // Hash through git rather than reimplementing it, so sha1 and sha256
  // repositories are both handled without asking which one this is. With
  // `--path`, git applies that path's clean filter — which is the same
  // working-tree→blob conversion a checkout inverted on the way in, so a
  // repository using filters still classifies correctly instead of silently
  // reading `unknown` forever.
  const hashArgs = rel
    ? ['hash-object', '-t', 'blob', '--path', rel, '--stdin']
    : ['hash-object', '-t', 'blob', '--stdin'];
  const hashed = git(cwd, hashArgs, remainingMs, content);
  const hash = hashed.stdout.trim();
  if (!hashed.ok || !isObjectId(hash)) return { source: 'unknown' };

  if (rel) {
    const head = git(cwd, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`], remainingMs);
    if (head.ok && head.stdout.trim() === hash) {
      return { source: 'git', detail: `identical to HEAD:${rel}` };
    }
  }

  // Not HEAD's version, but git still knows this content — a pull, a rebase
  // step, a stash restore, or a checkout of some other ref.
  if (git(cwd, ['cat-file', '-e', `${hash}^{blob}`], remainingMs).ok) {
    return {
      source: 'git',
      detail: rel
        ? `a blob this repository already contains, though not HEAD:${rel}`
        : 'a blob this repository already contains',
    };
  }

  return { source: 'unknown' };
}

/**
 * The sentence appended to a conflict `syncError` when the overwritten bytes
 * came from git. Split out so the two conflict arms in `reconcileFromDisk`
 * (prose bindings and flat write-back bindings) cannot drift apart.
 */
export function gitConflictHint(filePath: string, overwritten: string): string {
  const verdict = classifyExternalContent(filePath, overwritten);
  if (verdict.source !== 'git') return '';
  return (
    ` The overwritten content was ${verdict.detail}, so a git command (checkout, stash, pull or` +
    ' rebase) — not an editor save — is what changed this file, and that git operation is now' +
    ' partly undone: this doc has been written back over it, so the working tree no longer' +
    ' matches what git left and `git status` will show the file modified. Let the doc go idle' +
    ' (~1s after its last edit) and then re-run the git command.'
  );
}
