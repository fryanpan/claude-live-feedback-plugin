import { spawnSync } from 'node:child_process';
import type { DiffFileStatus } from '@feedback/core';

/**
 * Git plumbing for diff reviews. Every call shells out with an argv array
 * (never a shell string) and passes `--` separators, so repo paths and refs
 * can't smuggle options. Refs beginning with `-` are rejected outright.
 */

const MAX_GIT_BUFFER = 64 * 1024 * 1024;

function git(repo: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const res = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    maxBuffer: MAX_GIT_BUFFER,
  });
  return {
    ok: res.status === 0,
    stdout: typeof res.stdout === 'string' ? res.stdout : '',
    stderr: typeof res.stderr === 'string' ? res.stderr : '',
  };
}

/** A ref we're willing to hand to git: no leading '-', no whitespace/NUL. */
export function isSafeRef(ref: string): boolean {
  return ref.length > 0 && ref.length <= 256 && !ref.startsWith('-') && !/[\s\0]/.test(ref);
}

/** Resolve a ref to a full commit hash, or null if it doesn't name a commit. */
export function resolveCommit(repo: string, ref: string): string | null {
  if (!isSafeRef(ref)) return null;
  const res = git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const hash = res.stdout.trim();
  return res.ok && /^[0-9a-f]{40}$/.test(hash) ? hash : null;
}

export interface DiffFileEntry {
  /** Path at the target commit (or at base, for deletions). */
  relPath: string;
  status: DiffFileStatus;
  /** Path at the base commit when renamed (differs from relPath). */
  oldPath?: string;
  /** Line counts from --numstat; undefined for binary files. */
  additions?: number;
  deletions?: number;
  binary: boolean;
  /**
   * True when the file's every changed line differs only in whitespace —
   * a formatter run, a reindent, trailing-space cleanup. Derived by asking
   * git the same question twice, once with `-w`: a file the plain pass
   * reports and the `-w` pass drops has nothing to read.
   *
   * The file is NOT withheld from the review; the sidebar ranks it last.
   */
  whitespaceOnly?: boolean;
}

/** Parsed `--numstat -z` record, keyed by the file's path at the target. */
type NumstatEntry = { additions?: number; deletions?: number; binary: boolean };

/**
 * Parse `git diff --numstat -z` output.
 *
 * The -z form is "add\tdel\tpath\0" normally, but for renames and copies the
 * path field is EMPTY and followed by two extra NUL-terminated fields:
 * "add\tdel\t\0old\0new\0".
 */
function parseNumstat(stdout: string): Map<string, NumstatEntry> {
  const counts = new Map<string, NumstatEntry>();
  const t = stdout.split('\0');
  for (let i = 0; i < t.length; ) {
    const rec = t[i];
    if (!rec) break;
    const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/s);
    if (!m) break;
    const binary = m[1] === '-';
    const entry: NumstatEntry = {
      additions: binary ? undefined : Number(m[1]),
      deletions: binary ? undefined : Number(m[2]),
      binary,
    };
    if (m[3] === '') {
      const newPath = t[i + 2];
      i += 3;
      if (newPath) counts.set(newPath, entry);
    } else {
      counts.set(m[3] as string, entry);
      i += 1;
    }
  }
  return counts;
}

/**
 * List the files changed between a base commit and either a target commit
 * or — when `target` is null — the WORKING TREE (the folder as it is now,
 * uncommitted edits included; untracked files are appended as additions).
 * Rename detection on, per-file line counts joined in. Copies (C) are
 * treated as additions.
 */
export function diffFiles(
  repo: string,
  base: string,
  target: string | null,
): { ok: true; files: DiffFileEntry[] } | { ok: false; error: string } {
  const range = target ? [base, target] : [base];
  const ns = git(repo, ['diff', '--name-status', '-z', '-M', ...range, '--']);
  if (!ns.ok) return { ok: false, error: ns.stderr.trim() || 'git diff failed' };

  const files: DiffFileEntry[] = [];
  const tok = ns.stdout.split('\0');
  for (let i = 0; i < tok.length; ) {
    const status = tok[i];
    if (!status) break;
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const oldPath = tok[i + 1];
      const newPath = tok[i + 2];
      i += 3;
      if (!oldPath || !newPath) break;
      if (letter === 'R') {
        files.push({ relPath: newPath, status: 'renamed', oldPath, binary: false });
      } else {
        files.push({ relPath: newPath, status: 'added', binary: false });
      }
      continue;
    }
    const path = tok[i + 1];
    i += 2;
    if (!path) break;
    const mapped: DiffFileStatus =
      letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
    files.push({ relPath: path, status: mapped, binary: false });
  }

  // Working-tree mode: untracked files never show up in `git diff` — append
  // them as additions so a brand-new file the agent just wrote is reviewable.
  if (!target) {
    const untracked = git(repo, ['ls-files', '--others', '--exclude-standard', '-z']);
    if (untracked.ok) {
      const known = new Set(files.map((f) => f.relPath));
      for (const path of untracked.stdout.split('\0')) {
        if (path && !known.has(path)) {
          files.push({ relPath: path, status: 'added', binary: false });
        }
      }
    }
  }

  // Join in line counts; numstat reports "-\t-" for binary files.
  const num = git(repo, ['diff', '--numstat', '-z', '-M', ...range, '--']);
  if (num.ok) {
    const counts = parseNumstat(num.stdout);
    for (const f of files) {
      const c = counts.get(f.relPath);
      if (c) {
        f.additions = c.additions;
        f.deletions = c.deletions;
        f.binary = c.binary;
      }
    }

    // Second pass, whitespace-insensitive. Every file the plain pass listed
    // that this one drops changed only in whitespace. Restricted to files
    // that were MODIFIED: an add or a delete is never "only whitespace" in
    // any useful sense, and an untracked file appears in neither numstat.
    // `-w` covers indentation and trailing space but NOT added/removed blank
    // lines, which every formatter also produces — `--ignore-blank-lines` is
    // a separate flag and both are needed to describe "a formatter ran".
    const ws = git(repo, [
      'diff',
      '-w',
      '--ignore-blank-lines',
      '--numstat',
      '-z',
      '-M',
      ...range,
      '--',
    ]);
    if (ws.ok) {
      const survives = parseNumstat(ws.stdout);
      for (const f of files) {
        if (f.binary) continue;
        if (f.status !== 'modified' && f.status !== 'renamed') continue;
        if (!counts.has(f.relPath)) continue; // not in the plain pass either
        if (!survives.has(f.relPath)) f.whitespaceOnly = true;
      }
    }
  }

  return { ok: true, files };
}

/** Read a file's bytes at a commit. Returns null when the path doesn't exist there. */
export function showFile(repo: string, commit: string, relPath: string): string | null {
  const res = git(repo, ['show', `${commit}:${relPath}`]);
  return res.ok ? res.stdout : null;
}

/** Cheap binary sniff on already-read content (NUL in the first 8 KB). */
export function textLooksBinary(text: string): boolean {
  const len = Math.min(text.length, 8 * 1024);
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 0) return true;
  }
  return false;
}
