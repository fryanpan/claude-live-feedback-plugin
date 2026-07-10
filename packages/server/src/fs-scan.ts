import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** Filesystem scanning + file-type gating for folder binds. */

/**
 * Enumerate the files in `root`. Prefer `git ls-files` (cached + untracked,
 * honoring .gitignore) so node_modules/dist/etc are skipped for free; fall
 * back to a recursive readdir with a hardcoded skip set when the folder
 * isn't inside a git repo or git isn't available. Returns absolute paths.
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
      out.push(abs);
    }
  }
  return out;
}
