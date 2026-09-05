import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import type { DocOriginRepo } from '@feedback/core';

/**
 * A doc's ORIGIN REPO: the repo+branch+path where its on-disk copy belongs.
 *
 * The model (Bryan, 2026-08-20): the workspace holds the doc's identity and
 * primary copy; the file is an artifact whose location may move. A checkout
 * is not a location — the same path serves every branch that checkout ever
 * switches to, which is how a triage doc once flushed onto another session's
 * feature branch. So an origin repo names the BRANCH, and resolving it means asking
 * "which worktree of this repo has that branch checked out right now?".
 *
 * Everything here is pure filesystem reads of git's own plumbing files
 * (`.git`, `commondir`, `worktrees/<name>/gitdir`, `HEAD`) — no subprocess. That
 * is deliberate: `verifyPathInOriginRepo` runs on the synchronous flush path in
 * doc-store.ts, where a spawn would need the budget-and-SIGKILL machinery
 * git-provenance.ts carries (and it earns it only by running on a rare
 * conflict arm; a per-flush guard cannot). The layout read here is the same
 * one `git worktree list` prints from, stable across git versions.
 *
 * Every reader returns null / a refusal on anything unexpected — an origin repo that
 * cannot be resolved must degrade to "writes parked, doc stays durable in
 * the .ydoc", never to a throw on the flush path.
 */

/** Resolve a worktree root's gitdir: `.git` as a directory (main checkout)
 *  or as a `gitdir: <path>` pointer file (linked worktree). */
function gitDirOf(worktreeRoot: string): string | null {
  const dotGit = join(worktreeRoot, '.git');
  try {
    const st = statSync(dotGit);
    if (st.isDirectory()) return dotGit;
    if (st.isFile()) {
      const m = readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+?)\s*$/m);
      if (!m?.[1]) return null;
      const target = isAbsolute(m[1]) ? m[1] : resolvePath(worktreeRoot, m[1]);
      return existsSync(target) ? target : null;
    }
  } catch {}
  return null;
}

/**
 * The repo's COMMON dir — one value for every worktree of the same repo, so
 * it is the repo's identity. Realpath'd, because worktree registrations and
 * bind paths routinely reach the same place through different links.
 */
export function gitCommonDir(worktreeRoot: string): string | null {
  const gd = gitDirOf(worktreeRoot);
  if (!gd) return null;
  let common = gd;
  const commondirFile = join(gd, 'commondir');
  try {
    if (existsSync(commondirFile)) {
      const raw = readFileSync(commondirFile, 'utf8').trim();
      common = isAbsolute(raw) ? raw : resolvePath(gd, raw);
    }
    return realpathSync(common);
  } catch {
    return null;
  }
}

/**
 * The durable spelling of a repoRoot: the MAIN checkout's root. An origin repo (or
 * notes home) declared from a linked worktree would otherwise die with that
 * worktree — every resolver starts at `gitCommonDir(repoRoot)`, which needs
 * the declared path to still exist — even though the repo and the pinned
 * branch live on in other checkouts. The main checkout is the common dir's
 * parent; a layout where that doesn't hold (bare repo) keeps the caller's
 * path, which is then genuinely the repo's most durable known address.
 */
export function canonicalRepoRoot(worktreeRoot: string): string | null {
  const common = gitCommonDir(worktreeRoot);
  if (!common) return null;
  return basename(common) === '.git' ? dirname(common) : resolvePath(worktreeRoot);
}

/** The branch a gitdir's HEAD is on, or null for detached / unreadable. */
function branchOfGitDir(gd: string): string | null {
  try {
    const head = readFileSync(join(gd, 'HEAD'), 'utf8').trim();
    const m = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The branch checked out at a worktree root, or null (detached, not a
 *  repo). */
export function checkoutBranch(worktreeRoot: string): string | null {
  const gd = gitDirOf(worktreeRoot);
  return gd ? branchOfGitDir(gd) : null;
}

/** Walk up from a path (which need not exist yet) to the enclosing worktree
 *  root — the nearest ancestor with a `.git` entry. */
export function findWorktreeRoot(absPath: string): string | null {
  let dir = resolvePath(absPath);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type OriginRepoPlacement =
  | { placed: true; worktreeRoot: string; absPath: string }
  | { placed: false; reason: 'repo-missing' | 'no-checkout-on-branch' | 'path-escapes-checkout' };

/**
 * Does `root`/`relPath` stay inside `root` once symlinks are resolved? The
 * lexical checks in normalizeDocOriginRepo catch `..` spellings, but a SYMLINKED
 * parent directory inside the checkout can point anywhere — the joined path
 * looks contained while the bytes land outside the repo. Resolve the nearest
 * EXISTING ancestor (the file itself may not exist yet) and compare real
 * prefixes. Unreadable resolves count as escapes: a placement we cannot
 * prove contained is not a placement.
 */
export function placementEscapesRoot(root: string, relPath: string): boolean {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    return true;
  }
  const segments = relPath.split('/');
  for (let keep = segments.length; keep >= 0; keep--) {
    const candidate = join(root, ...segments.slice(0, keep));
    let real: string;
    try {
      real = realpathSync(candidate);
    } catch {
      continue; // not created yet — try the parent
    }
    const full = join(real, ...segments.slice(keep));
    return full !== realRoot && !full.startsWith(realRoot + sep);
  }
  return true;
}

/**
 * Every worktree of the repo whose common dir this is, with the branch each
 * has checked out. Reads `<common>/worktrees/<name>/gitdir` the way
 * `git worktree list` does; a registration whose worktree is gone (or whose
 * path was reused by something that is no longer this repo's worktree) is
 * skipped rather than trusted.
 */
function listWorktrees(common: string): Array<{ root: string; branch: string | null }> {
  const out: Array<{ root: string; branch: string | null }> = [];
  // The main checkout: a non-bare repo's common dir IS its `.git` dir.
  if (basename(common) === '.git') {
    const root = dirname(common);
    if (existsSync(root)) out.push({ root, branch: branchOfGitDir(common) });
  }
  const wtDir = join(common, 'worktrees');
  let entries: string[] = [];
  try {
    entries = existsSync(wtDir) ? readdirSync(wtDir) : [];
  } catch {
    entries = [];
  }
  for (const name of entries) {
    const gd = join(wtDir, name);
    try {
      const raw = readFileSync(join(gd, 'gitdir'), 'utf8').trim();
      // `gitdir` names the worktree's own `.git` FILE; its dirname is the root.
      const root = dirname(raw);
      if (!existsSync(root)) continue;
      const back = gitDirOf(root);
      if (!back || realpathSync(back) !== realpathSync(gd)) continue;
      out.push({ root, branch: branchOfGitDir(gd) });
    } catch {}
  }
  return out;
}

/**
 * Where an origin repo's file belongs RIGHT NOW: the worktree with `originRepo.branch`
 * checked out (git itself guarantees at most one), joined with the relPath.
 * `repoRoot` may be ANY checkout of the repo — the common dir is the
 * identity, so the origin repo keeps resolving after the checkout it was declared
 * from is gone.
 */
export function resolveOriginRepoCheckout(originRepo: DocOriginRepo): OriginRepoPlacement {
  const common = gitCommonDir(originRepo.repoRoot);
  if (!common) return { placed: false, reason: 'repo-missing' };
  for (const wt of listWorktrees(common)) {
    if (wt.branch === originRepo.branch) {
      if (placementEscapesRoot(wt.root, originRepo.relPath)) {
        return { placed: false, reason: 'path-escapes-checkout' };
      }
      return { placed: true, worktreeRoot: wt.root, absPath: join(wt.root, originRepo.relPath) };
    }
  }
  return { placed: false, reason: 'no-checkout-on-branch' };
}

export type OriginRepoVerdict =
  | 'ok'
  | 'wrong-branch'
  | 'wrong-path'
  | 'outside-repo'
  | 'repo-missing';

/**
 * Is `absFilePath` still the origin repo's file? The per-flush guard: cheap enough
 * to run before every write AND every disk→doc apply on a pinned doc, so a
 * checkout that switched branches under the binding is caught before either
 * direction moves bytes — not after the flush already landed on someone
 * else's feature branch, and not after the poll already pulled that branch's
 * copy into the live doc.
 */
export function verifyPathInOriginRepo(
  absFilePath: string,
  originRepo: DocOriginRepo,
): OriginRepoVerdict {
  const common = gitCommonDir(originRepo.repoRoot);
  if (!common) return 'repo-missing';
  const wtRoot = findWorktreeRoot(absFilePath);
  if (!wtRoot) return 'outside-repo';
  if (gitCommonDir(wtRoot) !== common) return 'outside-repo';
  if (checkoutBranch(wtRoot) !== originRepo.branch) return 'wrong-branch';
  const rel = relative(wtRoot, resolvePath(absFilePath)).split(sep).join('/');
  if (rel !== originRepo.relPath) return 'wrong-path';
  // The lexical spelling is the origin repo's; make sure the BYTES stay in the
  // checkout too — a symlinked parent directory would pass every check
  // above while the write lands outside the repo.
  if (placementEscapesRoot(wtRoot, rel)) return 'outside-repo';
  return 'ok';
}

/**
 * Validate a caller-supplied origin repo into the canonical shape, or say what is
 * wrong with it in words the caller can act on. relPath is the one field
 * that can reach outside the worktree, so it gets the traversal checks.
 */
export function normalizeDocOriginRepo(
  input: unknown,
): { ok: true; home: DocOriginRepo } | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'home must be an object { repoRoot, branch, relPath }' };
  }
  const { repoRoot, branch, relPath } = input as Record<string, unknown>;
  if (typeof repoRoot !== 'string' || !isAbsolute(repoRoot)) {
    return { ok: false, error: 'repoRoot must be an absolute path to a checkout of the repo' };
  }
  if (typeof branch !== 'string' || branch.trim() === '' || branch.startsWith('-')) {
    return { ok: false, error: 'branch must be a non-empty branch name' };
  }
  if (typeof relPath !== 'string' || relPath === '' || isAbsolute(relPath)) {
    return { ok: false, error: 'relPath must be a non-empty path relative to the repo root' };
  }
  const segments = relPath.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    return { ok: false, error: 'relPath must not contain empty, "." or ".." segments' };
  }
  if (segments[0] === '.git') {
    return { ok: false, error: 'relPath must not point into .git' };
  }
  return {
    ok: true,
    home: { repoRoot: resolvePath(repoRoot), branch: branch.trim(), relPath },
  };
}
