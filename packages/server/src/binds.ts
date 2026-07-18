import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath, sep } from 'node:path';
import type { DocMeta, DocType } from '@feedback/core';
import { assignGroups } from './diff-groups.ts';
import { scanFolder } from './fs-scan.ts';
import {
  type DiffFileEntry,
  diffFiles,
  resolveCommit,
  showFile,
  textLooksBinary,
} from './git-diff.ts';
import type { DocRoom } from './rooms.ts';

/**
 * The two "bind a set of files as one workspace" flows — folder/worktree
 * (`bindFolder`) and git diff (`bindDiff`) — extracted from rooms.ts and
 * built on the same skeleton: enumerate candidates → filter
 * (exclude/size/binary, recording `skipped[]`) → maxFiles guardrail →
 * deterministic member docIds → getOrCreate + attach per file.
 */

/** The slice of Rooms the bind flows actually need (avoids a runtime
 *  circular import; Rooms passes itself). */
export interface BindHost {
  getOrCreate(
    docId: string,
    init?: {
      type?: DocType;
      sourceUrl?: string;
      title?: string;
      setId?: string;
      owner?: string;
      workspaceId?: string;
      relPath?: string;
      workspaceRoot?: string;
      producedBy?: { agentId?: string; sessionId?: string };
      diffBase?: string;
      diffTarget?: string;
      diffStatus?: DocMeta['diffStatus'];
      diffOldPath?: string;
      diffAdditions?: number;
      diffDeletions?: number;
      diffGroup?: string;
      diffGroupRank?: number;
      diffGroupDetails?: string;
    },
  ): DocRoom;
  attachFile(docId: string, path: string): { ok: boolean };
  attachReadonlyFile(docId: string, path: string): { ok: boolean };
  openContextFile(
    workspaceId: string,
    relPath: string,
  ): { ok: true; docId: string; meta: DocMeta } | { ok: false; error: string };
  list(): DocMeta[];
}

/** Files above this size are skipped — they'd bloat the ydoc and the
 *  browser payload without being meaningfully reviewable. */
const MAX_REVIEW_FILE_BYTES = 512 * 1024;
const DEFAULT_MAX_FILES = 300;

/** Deterministic member docId: group + relPath with `/`→`~` (why `~` is a
 *  legal docId char), hash fallback under the 100-char docId cap. Same file
 *  → same docId, so re-binding preserves threads. */
export function memberDocId(groupId: string, relPath: string): string {
  const docId = `${groupId}:${relPath.replaceAll('/', '~')}`;
  return docId.length > 100 ? `${groupId}:${shortHash(relPath)}` : docId;
}

function normalizeExcludes(exclude?: string[]): string[] {
  return (exclude ?? []).map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''));
}

function isExcluded(relPath: string, excludes: string[]): boolean {
  return excludes.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

export interface BindFolderOpts {
  folderPath: string;
  workspaceId?: string;
  title?: string;
  /** Accepted for back-compat; lazy opening made the allowlist obsolete. */
  include?: string[];
  exclude?: string[];
  /** Accepted for back-compat; browse mode binds lazily so no cap applies. */
  maxFiles?: number;
  owner?: string;
  producedBy?: { agentId?: string; sessionId?: string };
}

export type BindFolderResult =
  | {
      ok: true;
      workspaceId: string;
      root: string;
      fileCount: number;
      skipped: Array<{ path: string; reason: string }>;
      files: Array<{ docId: string; relPath: string; type: DocType; title: string }>;
    }
  | { ok: false; error: 'not-found' | 'too-many-files'; fileCount?: number };

/**
 * bind_folder is now an alias for a BROWSE-mode diff workspace (bindDiff
 * without a base): the whole folder is navigable from the all-files
 * sidebar, files open lazily (markdown editable, source read-only), and
 * only an entry doc binds eagerly. `fileCount` is the scan count, not a
 * bound-docs count — the old eager-bind-everything path (and its 300-file
 * cap + per-file pollers) is gone.
 */
export function bindFolder(host: BindHost, opts: BindFolderOpts): BindFolderResult {
  const res = bindDiff(host, {
    repoPath: opts.folderPath,
    reviewId: opts.workspaceId,
    title: opts.title,
    exclude: opts.exclude,
    owner: opts.owner,
    producedBy: opts.producedBy,
  });
  if (!res.ok) {
    if (res.error === 'empty-diff') {
      // An empty (but existing) folder is a degenerate success, matching
      // the old eager bind's behavior for a folder with no supported files.
      const root = resolvePath(opts.folderPath);
      return {
        ok: true,
        workspaceId: opts.workspaceId ?? deriveWorkspaceId(root),
        root,
        fileCount: 0,
        skipped: [],
        files: [],
      };
    }
    return { ok: false, error: 'not-found' };
  }
  return {
    ok: true,
    workspaceId: res.reviewId,
    root: res.root,
    fileCount: res.fileCount,
    skipped: res.skipped,
    files: res.files.map((f) => ({
      docId: f.docId,
      relPath: f.relPath,
      type: f.type,
      title: f.title,
    })),
  };
}

export interface BindDiffOpts {
  repoPath: string;
  /** Diff base ref. OMIT for BROWSE mode: no diff — the workspace is the
   *  folder itself, files open lazily from the all-files sidebar. */
  base?: string;
  /** Target commit for a pinned review; omit to review the working tree. */
  target?: string;
  reviewId?: string;
  title?: string;
  /** Path prefixes (relative to repo root) to leave out of the review. */
  exclude?: string[];
  /** Logical file groups for the sidebar (agent-supplied, like organizing
   *  commits). Unlisted changed files land in an "Other" group. When absent,
   *  a heuristic groups by Tests/Docs/Build buckets + top-level module.
   *  Optional per-group `details` renders as a short intro under the group
   *  title (capped at 500 chars). */
  groups?: Array<{ title: string; paths: string[]; details?: string }>;
  maxFiles?: number;
  owner?: string;
  producedBy?: { agentId?: string; sessionId?: string };
}

export type BindDiffResult =
  | {
      ok: true;
      reviewId: string;
      root: string;
      /** Resolved base hash; null in browse mode (no diff). */
      base: string | null;
      /** Resolved target hash for pinned reviews; null in working-tree mode. */
      target: string | null;
      /** True when this is a browse-mode workspace (no diff members). */
      browse?: boolean;
      fileCount: number;
      skipped: Array<{ path: string; reason: string }>;
      files: Array<{
        docId: string;
        relPath: string;
        type: DocType;
        title: string;
        status: DocMeta['diffStatus'];
        additions?: number;
        deletions?: number;
        group?: string;
      }>;
    }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'bad-ref'
        | 'diff-failed'
        | 'empty-diff'
        | 'too-many-files'
        | 'review-exists-different-range';
      detail?: string;
      fileCount?: number;
    };

/**
 * Bind a git diff for review. Two modes, chosen by whether `target` is
 * passed:
 *
 * WORKING-TREE (default, `target` omitted) — diff base → the folder as it
 * is NOW, uncommitted edits and untracked files included. Each doc binds
 * to the live file on disk (same mtime poll as code docs), so the agent
 * keeps editing and the review re-renders within ~1s. Line anchors ride
 * along via the snippet auto-reanchor sweep; when an anchored line is
 * gone, the thread orphans into the existing outdated-comments flow.
 * Re-binding the same review refreshes the changed-file list; threads
 * survive re-binds.
 *
 * PINNED (`target` passed) — content is the file at the target commit
 * (via `git show`), immutable, no poll. Re-binding the same review id
 * with a different range is rejected (threads anchor into the pinned
 * content).
 */
export function bindDiff(host: BindHost, opts: BindDiffOpts): BindDiffResult {
  const root = resolvePath(opts.repoPath);
  if (!existsSync(root)) return { ok: false, error: 'not-found' };

  // BROWSE mode — no base to diff against (plain folder, fresh repo, or the
  // caller just wants to look around). No eager per-file binds: files open
  // lazily from the all-files sidebar (openContextFile), which removes the
  // maxFiles ceiling and the per-file pollers. One ENTRY doc is opened
  // eagerly so the workspace exists and there's a page to land on.
  if (opts.base === undefined) {
    const reviewId = opts.reviewId ?? deriveWorkspaceId(root);
    const excludes = normalizeExcludes(opts.exclude);
    const scanned = scanFolder(root)
      .map((abs) => relative(root, abs).split(sep).join('/'))
      .filter((rel) => !isExcluded(rel, excludes))
      .sort();
    if (scanned.length === 0) return { ok: false, error: 'empty-diff' };
    const entryRel =
      scanned.find((r) => r.toLowerCase() === 'readme.md') ??
      scanned.find((r) => r.toLowerCase().endsWith('.md')) ??
      scanned[0];
    if (!entryRel) return { ok: false, error: 'empty-diff' };
    const opened = host.openContextFile(reviewId, entryRel);
    // First open must create workspace meta from nothing — openContextFile
    // derives root from members, so seed the entry doc directly here.
    if (!opened.ok) {
      const docId = memberDocId(reviewId, entryRel);
      const abs = join(root, entryRel);
      const isMd = entryRel.toLowerCase().endsWith('.md');
      host.getOrCreate(docId, {
        type: isMd ? 'markdown' : 'code',
        sourceUrl: abs,
        setId: reviewId,
        owner: opts.owner,
        workspaceId: reviewId,
        workspaceRoot: root,
        relPath: entryRel,
        title: opts.title ?? entryRel,
        producedBy: opts.producedBy,
      });
      if (isMd) host.attachFile(docId, abs);
      else host.attachReadonlyFile(docId, abs);
    }
    const entryDocId = memberDocId(reviewId, entryRel);
    return {
      ok: true,
      reviewId,
      root,
      base: null,
      target: null,
      browse: true,
      fileCount: scanned.length,
      skipped: [],
      files: [
        {
          docId: entryDocId,
          relPath: entryRel,
          type: entryRel.toLowerCase().endsWith('.md') ? 'markdown' : 'code',
          title: entryRel,
          status: undefined,
        },
      ],
    };
  }

  const base = resolveCommit(root, opts.base);
  const target = opts.target !== undefined ? resolveCommit(root, opts.target) : null;
  if (!base || (opts.target !== undefined && !target)) {
    return {
      ok: false,
      error: 'bad-ref',
      detail: `could not resolve ${!base ? opts.base : opts.target} to a commit in ${root}`,
    };
  }

  const listed = diffFiles(root, base, target);
  if (!listed.ok) return { ok: false, error: 'diff-failed', detail: listed.error };
  if (listed.files.length === 0) return { ok: false, error: 'empty-diff' };

  const reviewId = opts.reviewId ?? deriveDiffReviewId(root, base, target);

  // A review id is pinned to its range: threads anchor into that content,
  // so silently re-seeding a different range would corrupt them. (In
  // working-tree mode only the base is pinned — the target side is live
  // by design.)
  for (const meta of host.list()) {
    if (meta.workspaceId !== reviewId || meta.type !== 'diff') continue;
    if (meta.diffBase !== base || (meta.diffTarget ?? null) !== target) {
      return { ok: false, error: 'review-exists-different-range' };
    }
    break;
  }

  const excludes = normalizeExcludes(opts.exclude);
  const skipped: Array<{ path: string; reason: string }> = [];
  const accepted: Array<{ entry: DiffFileEntry; text: string }> = [];
  for (const entry of listed.files) {
    if (isExcluded(entry.relPath, excludes)) {
      skipped.push({ path: entry.relPath, reason: 'excluded' });
      continue;
    }
    if (entry.binary) {
      skipped.push({ path: entry.relPath, reason: 'binary' });
      continue;
    }
    // Working-tree mode reads the live file; pinned mode reads the blob at
    // the target commit. Deleted files carry no target-side content.
    let text = '';
    if (entry.status !== 'deleted') {
      if (target) {
        text = showFile(root, target, entry.relPath) ?? '';
      } else {
        try {
          text = readFileSync(join(root, entry.relPath), 'utf8');
        } catch {
          skipped.push({ path: entry.relPath, reason: 'read-failed' });
          continue;
        }
      }
    }
    if (text.length > MAX_REVIEW_FILE_BYTES) {
      skipped.push({ path: entry.relPath, reason: 'too-large' });
      continue;
    }
    if (textLooksBinary(text)) {
      skipped.push({ path: entry.relPath, reason: 'binary' });
      continue;
    }
    accepted.push({ entry, text });
  }

  const max = opts.maxFiles ?? DEFAULT_MAX_FILES;
  if (accepted.length > max) {
    return { ok: false, error: 'too-many-files', fileCount: accepted.length };
  }

  const groupOf = assignGroups(
    accepted.map(({ entry }) => ({
      relPath: entry.relPath,
      additions: entry.additions,
      deletions: entry.deletions,
    })),
    opts.groups,
  );

  const out: Array<{
    docId: string;
    relPath: string;
    type: DocType;
    title: string;
    status: DocMeta['diffStatus'];
    additions?: number;
    deletions?: number;
    group?: string;
  }> = [];
  for (const { entry, text } of accepted) {
    const docId = memberDocId(reviewId, entry.relPath);
    const room = host.getOrCreate(docId, {
      type: 'diff',
      setId: reviewId,
      owner: opts.owner,
      workspaceId: reviewId,
      workspaceRoot: root,
      relPath: entry.relPath,
      title: entry.relPath,
      producedBy: opts.producedBy,
      diffBase: base,
      ...(target ? { diffTarget: target } : {}),
      diffStatus: entry.status,
      diffOldPath: entry.oldPath,
      diffAdditions: entry.additions,
      diffDeletions: entry.deletions,
      diffGroup: groupOf.get(entry.relPath)?.group,
      diffGroupRank: groupOf.get(entry.relPath)?.rank,
      diffGroupDetails: groupOf.get(entry.relPath)?.details,
    });
    // initDocMeta is set-if-absent, but status/counts are DERIVED and go
    // stale as the working tree moves — refresh them on every (re)bind.
    // Groups refresh only when the caller PASSED groups (explicit wins) or
    // the file has none yet — a group-less refresh re-bind must not clobber
    // semantic groups an agent set earlier.
    const groupAssignment =
      opts.groups || room.meta.diffGroup === undefined ? groupOf.get(entry.relPath) : undefined;
    refreshDiffMeta(room, entry, groupAssignment);
    if (target) {
      // Pinned mode: seed the target-commit content once; no file
      // binding, no poll — content can't change underneath us.
      const content = room.ydoc.getText('content');
      if (content.length === 0 && text.length > 0) {
        room.ydoc.transact(() => content.insert(0, text), 'file-seed');
      }
    } else if (entry.status !== 'deleted') {
      // Working-tree mode: bind the live file like a code doc — seeds the
      // content, arms the mtime poll (agent edits re-render in ~1s), no
      // write-back. The wireEvents reanchor sweep keeps threads attached
      // or orphans them when their line disappears.
      host.attachReadonlyFile(docId, join(root, entry.relPath));
    }
    out.push({
      docId,
      relPath: entry.relPath,
      type: 'diff',
      title: entry.relPath,
      status: entry.status,
      additions: entry.additions,
      deletions: entry.deletions,
      group: groupOf.get(entry.relPath)?.group,
    });
  }

  return {
    ok: true,
    reviewId,
    root,
    base,
    target,
    fileCount: out.length,
    skipped,
    files: out,
  };
}

/**
 * Refresh the derived diff fields (status, rename source, line counts) on
 * an existing room. `initDocMeta` is deliberately set-if-absent, which is
 * right for identity fields but wrong for these — in working-tree mode
 * they change every time the agent edits, and a re-bind should show the
 * current numbers, not the ones from the first bind.
 */
function refreshDiffMeta(
  room: DocRoom,
  entry: DiffFileEntry,
  group?: { group: string; rank: number; details?: string },
): void {
  const next: Partial<DocMeta> = {
    diffStatus: entry.status,
    diffOldPath: entry.oldPath,
    diffAdditions: entry.additions,
    diffDeletions: entry.deletions,
    diffGroup: group?.group,
    diffGroupRank: group?.rank,
    diffGroupDetails: group?.details,
  };
  const m = room.ydoc.getMap('meta');
  const changed = (Object.entries(next) as Array<[keyof DocMeta, unknown]>).filter(
    ([k, v]) => v !== undefined && room.meta[k] !== v,
  );
  if (changed.length === 0) return;
  room.ydoc.transact(() => {
    for (const [k, v] of changed) m.set(k, v);
  });
  for (const [k, v] of changed) {
    (room.meta as unknown as Record<string, unknown>)[k] = v;
  }
}

/** Deterministic workspace id: folder basename + 6-char hash of the
 *  absolute path, so two folders named `core` don't collide. */
export function deriveWorkspaceId(absRoot: string): string {
  const base = basename(absRoot).replace(/[^a-zA-Z0-9_.\-]/g, '-') || 'workspace';
  return `${base}-${shortHash(absRoot)}`;
}

/** Deterministic diff-review id: repo basename + short hashes of the range
 *  ('live' for the working-tree side), so re-running the same
 *  create_diff_review lands on the same docs (threads survive) while a
 *  different range gets its own review. */
export function deriveDiffReviewId(absRoot: string, base: string, target: string | null): string {
  const name = basename(absRoot).replace(/[^a-zA-Z0-9_.\-]/g, '-') || 'repo';
  return `${name}-${base.slice(0, 7)}-${target ? target.slice(0, 7) : 'live'}`;
}

function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6);
}
