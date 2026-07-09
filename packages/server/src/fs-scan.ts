import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { DocType } from '@feedback/core';

/** Filesystem scanning + file-type gating for folder binds. */

/** Extension → DocType. `.md` is editable markdown; everything else is
 *  read-only source. `include[]` (extensions like `.rb` or `rb`) extends
 *  the code set. */
export function buildAllowlist(include?: string[]): Map<string, DocType> {
  const map = new Map<string, DocType>([['.md', 'markdown']]);
  const code = [
    '.ts',
    '.tsx',
    '.js',
    '.jsx',
    '.mjs',
    '.cjs',
    '.java',
    '.kt',
    '.kts',
    '.py',
    '.json',
  ];
  for (const ext of code) map.set(ext, 'code');
  for (const raw of include ?? []) {
    const ext = raw.startsWith('.') ? raw.toLowerCase() : `.${raw.toLowerCase()}`;
    if (!map.has(ext)) map.set(ext, 'code');
  }
  return map;
}

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

/** Sniff the first 8 KB for a NUL byte — a cheap binary detector that
 *  keeps images/compiled output out of the text-only review surface. */
export function looksBinary(abs: string): boolean {
  try {
    const buf = readFileSync(abs);
    const len = Math.min(buf.length, 8 * 1024);
    for (let i = 0; i < len; i++) {
      if (buf[i] === 0) return true;
    }
    return false;
  } catch {
    return true;
  }
}
