import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Filesystem scanning + file-type gating for folder binds. */

/**
 * Enumerate the files in `root`. Prefer `git ls-files` (cached + untracked,
 * honoring .gitignore) so node_modules/dist/etc are skipped for free; fall
 * back to a recursive readdir with a hardcoded skip set when the folder
 * isn't inside a git repo or git isn't available. Returns absolute paths.
 *
 * The two modes are not equally safe and the fallback knows it: there is no
 * `.gitignore` to honour outside a repo, so it applies `isSecretShapedName`
 * of its own. See `isListedFile` — this listing IS the rule for what a share
 * visitor may open.
 */
export function scanFolder(root: string): string[] {
  try {
    const res = spawnSync(
      'git',
      ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (res.status === 0 && typeof res.stdout === 'string') {
      const out: string[] = [];
      for (const line of res.stdout.split('\n')) {
        const rel = line.trim();
        if (rel) out.push(join(root, rel));
      }
      return out;
    }
  } catch {
    // git missing or threw — fall through to readdir.
  }
  return readdirRecursive(root);
}

/** Repo-relative POSIX paths for every scanned file, sorted. */
export function scanFolderPaths(root: string): string[] {
  return scanFolder(root)
    .map((abs) => relative(root, abs).split(sep).join('/'))
    .sort();
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', 'coverage']);

/**
 * Filenames the fallback refuses even though nothing ignored them.
 *
 * `isListedFile` is the rule that decides what a share visitor may open, and
 * the guarantee behind it is `git ls-files --exclude-standard` — a gitignored
 * `.env` never appears in the listing, so it can never be opened. Outside a
 * git repo there is no ignore file to honour and no `git` answer to trust, so
 * the fallback has to carry its own floor. It used to have none: the
 * dot-prefix test applied to DIRECTORIES only, so a `bind_folder` on a
 * non-repo directory listed `.env`, `.npmrc` and `.netrc` in the tree and
 * `openContextFile` served them.
 *
 * Deliberately conservative rather than clever. A dotfile in a directory
 * nobody has put under version control is far more likely to be configuration
 * than something a reviewer wants to read, and a false refusal here shows up
 * as one missing row in a tree — a visible, harmless failure — while a false
 * admission is a credential leaving the box.
 */
function isSecretShapedName(name: string): boolean {
  // Every dotfile. `.env`, `.env.local`, `.npmrc`, `.netrc`, `.pgpass`,
  // `.aws/…` (its directory is skipped anyway) — one rule instead of a list
  // that stops being complete.
  if (name.startsWith('.')) return true;
  const lower = name.toLowerCase();
  // Key and certificate material, which carries no dot prefix.
  if (lower.endsWith('.pem') || lower.endsWith('.key') || lower.endsWith('.p12')) return true;
  if (lower.endsWith('.pfx') || lower.endsWith('.keystore')) return true;
  // `id_rsa`, `id_ed25519`, and every other ssh private key's default name.
  if (lower.startsWith('id_')) return true;
  return false;
}

function readdirRecursive(dir: string): string[] {
  const out: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const name = entry.name;
    const abs = join(dir, name);
    if (entry.isDirectory()) {
      // Skip .git, any dotdir, and the hardcoded heavy dirs.
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      out.push(...readdirRecursive(abs));
    } else if (entry.isFile()) {
      if (isSecretShapedName(name)) continue;
      out.push(abs);
    }
  }
  return out;
}

/**
 * Is `relPath` one of the files the tree SHOWS for `root`?
 *
 * The all-files tree is `scanFolderPaths(root)` — `git ls-files --cached
 * --others --exclude-standard` in a repo — so an ignored file never appears
 * in it. OUTSIDE a repo the listing falls back to a recursive readdir, which
 * has no ignore file to honour; there it carries its own floor instead and
 * omits every dotfile and every key-shaped name (`isSecretShapedName`). `openContextFile` / `openEditableFile` used to accept any path that
 * merely existed under the root, which let a caller who knew the name open
 * `.env` or a credentials dump the tree had deliberately hidden; and a
 * review root is a whole repository, reachable by a share visitor.
 * (Urgent-fixes ticket, 2026-09-02.) The rule is now the tree's rule: a path
 * opens only if the listing contains it.
 *
 * Anything under `.git/` is refused before the listing is consulted. Git
 * never lists its own directory, but a rescan is a subprocess and `.git`
 * holds the one thing (config, hooks, packed refs) that should never need
 * one to be refused.
 *
 * Cached per root so this is not a subprocess per request: a hit is served
 * from a listing up to `LISTING_TTL_MS` old, and a MISS on a listing older
 * than `MISS_RESCAN_MS` rescans once before answering — a file created a
 * moment ago (an agent writing while the reviewer clicks) is found rather
 * than refused for the rest of the window. A miss on a fresh listing stays a
 * miss, which bounds a hammering caller to one subprocess per
 * `MISS_RESCAN_MS` per root.
 */
export function isListedFile(root: string, relPath: string): boolean {
  if (relPath.split('/').includes('.git')) return false;
  const now = Date.now();
  let entry = listingCache.get(root);
  if (!entry || now - entry.at > LISTING_TTL_MS) entry = refreshListing(root, now);
  if (entry.paths.has(relPath)) return true;
  if (now - entry.at >= MISS_RESCAN_MS) entry = refreshListing(root, now);
  return entry.paths.has(relPath);
}

/** Forget every cached listing. Tests only. */
export function clearListingCache(): void {
  listingCache.clear();
}

const LISTING_TTL_MS = 5_000;
const MISS_RESCAN_MS = 250;
const LISTING_CACHE_MAX_ROOTS = 64;
const listingCache = new Map<string, { at: number; paths: Set<string> }>();

function refreshListing(root: string, now: number): { at: number; paths: Set<string> } {
  const entry = { at: now, paths: new Set(scanFolderPaths(root)) };
  // Re-insert so the Map keeps insertion order as recency; evict the oldest
  // root once too many reviews have been opened on distinct repos.
  listingCache.delete(root);
  listingCache.set(root, entry);
  if (listingCache.size > LISTING_CACHE_MAX_ROOTS) {
    const oldest = listingCache.keys().next().value;
    if (oldest !== undefined) listingCache.delete(oldest);
  }
  return entry;
}
