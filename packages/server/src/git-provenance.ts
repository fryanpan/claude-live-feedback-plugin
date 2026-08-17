import { spawnSync } from 'node:child_process';
import { basename, dirname } from 'node:path';

/**
 * Was a file's content written by git rather than typed by a person?
 *
 * The disk→doc poll (`armFileWatcher`) detects changes by mtime and cannot
 * tell `git checkout` / `git stash` / `git pull` apart from an editor save —
 * both rewrite the bytes and bump the mtime. That is by design and is not
 * fixable at the poll: git leaves no marker on the file.
 *
 * What IS knowable, after the fact, is whether the content git left behind is
 * a blob the repository already contains. An editor save produces content the
 * object database has never seen; a checkout, a stash, a branch switch and a
 * pull all write a blob that is by construction already in it. So on the
 * conflict path — where the live doc's edits are about to be reasserted OVER
 * the bytes on disk — we can tell the operator that what we overwrote came
 * from git, which turns "my checkout silently came undone" into a message
 * naming the cause.
 *
 * Deliberately advisory: this NEVER changes which side wins. The editor stays
 * the runtime source of truth (a git-sourced write must not be allowed to
 * clobber a human's un-flushed edits either). A false positive here can only
 * make the message name git when it shouldn't; it cannot lose anyone's work.
 *
 * Cost is paid only on the conflict path, which is rare and already writing a
 * backup file and logging.
 */

const GIT_TIMEOUT_MS = 5_000;

function git(cwd: string, args: string[], input?: string): { ok: boolean; stdout: string } {
  try {
    const res = spawnSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return {
      ok: res.status === 0,
      stdout: typeof res.stdout === 'string' ? res.stdout : '',
    };
  } catch {
    // git absent, cwd gone, spawn refused — never let provenance sniffing
    // break a reconcile.
    return { ok: false, stdout: '' };
  }
}

/** A hash in either object format git may be using. */
function isObjectId(s: string): boolean {
  return /^[0-9a-f]{40}$/.test(s) || /^[0-9a-f]{64}$/.test(s);
}

export type ExternalContentSource =
  | { source: 'git'; detail: string }
  | { source: 'unknown'; detail?: undefined };

/**
 * Classify content that was found on disk at `filePath`.
 *
 * Returns `git` when the repository containing the file already holds this
 * exact content as a blob — i.e. it was almost certainly placed there by a git
 * command rather than saved by an editor. `detail` is a short human phrase
 * naming what matched, for use in a `syncError` message.
 *
 * Returns `unknown` for anything else, including "not a git repo at all".
 */
export function classifyExternalContent(filePath: string, content: string): ExternalContentSource {
  const cwd = dirname(filePath);
  const name = basename(filePath);

  // Hash through git rather than reimplementing it, so sha1 and sha256
  // repositories are both handled without asking which one this is.
  const hashed = git(cwd, ['hash-object', '-t', 'blob', '--stdin'], content);
  const hash = hashed.stdout.trim();
  if (!hashed.ok || !isObjectId(hash)) return { source: 'unknown' };

  // Repo-relative path, so the message names the file the way git does.
  const listed = git(cwd, ['ls-files', '--full-name', '--', name]);
  const rel = listed.ok ? listed.stdout.split('\n')[0].trim() : '';

  if (rel) {
    const head = git(cwd, ['rev-parse', '--verify', '--quiet', `HEAD:${rel}`]);
    if (head.ok && head.stdout.trim() === hash) {
      return { source: 'git', detail: `identical to HEAD:${rel}` };
    }
  }

  // Not HEAD's version, but git still knows this content — a pull, a rebase
  // step, or a checkout of some other ref.
  const known = git(cwd, ['cat-file', '-e', `${hash}^{blob}`]);
  if (known.ok) {
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
 * (prose and flat write-back bindings) cannot drift apart.
 */
export function gitConflictHint(filePath: string, overwritten: string): string {
  const verdict = classifyExternalContent(filePath, overwritten);
  if (verdict.source !== 'git') return '';
  return (
    ` The overwritten content was ${verdict.detail}, so a git command (checkout, stash, pull or rebase)` +
    ' — not an editor save — is what changed this file. The reassert has put the live doc back over it,' +
    ' so the working tree no longer matches what git wrote and `git status` will show the file modified.' +
    ' Re-run the git command once the doc is idle, or reparse_from_disk to let the git version win.'
  );
}
