import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, relative, resolve as resolvePath, sep } from 'node:path';
import { type DocMeta, type DocType, reviewIdOf } from '@feedback/core';
import {
  MAX_GROUP_DETAILS,
  assignGroups,
  findMalformedGroups,
  findOverlongGroupDetails,
} from './diff-groups.ts';
import { scanFolder } from './fs-scan.ts';
import {
  type DiffFileEntry,
  diffFiles,
  resolveCommit,
  showFile,
  textLooksBinary,
} from './git-diff.ts';
import { isPrivateMetaKey } from './private-meta.ts';
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
  get(docId: string): DocRoom | undefined;
  /** Force a persistence pass for a doc whose in-memory meta changed without
   *  a CRDT update — the private sidecar keys have no Yjs write to ride. */
  persistMeta(docId: string): void;
  listThreads(docId: string, opts?: { status?: 'open' | 'resolved' }): Array<unknown>;
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
      diffWhitespaceOnly?: boolean;
      diffGroup?: string;
      diffGroupRank?: number;
      diffGroupDetails?: string;
    },
  ): DocRoom;
  attachFile(docId: string, path: string): { ok: boolean };
  attachReadonlyFile(docId: string, path: string): { ok: boolean };
  attachFlatFile(docId: string, path: string, opts?: { writeBack?: boolean }): { ok: boolean };
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
   *  title; over MAX_GROUP_DETAILS chars is REJECTED (error
   *  'group-details-too-long'), not truncated — callers must write a short
   *  intro. */
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
        | 'group-details-too-long'
        | 'bad-groups'
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

  // Shape first: a spec is PERSISTED on the members for refreshWorkspace to
  // replay, so one that would blow up assignGroups must never be written.
  if (opts.groups !== undefined) {
    const malformed = findMalformedGroups(opts.groups);
    if (malformed.length > 0) {
      return { ok: false, error: 'bad-groups', detail: malformed.join('; ') };
    }
  }

  // A group's `details` intro is capped HARD at MAX_GROUP_DETAILS and rejected
  // (not truncated) when over — this deliberately forces the caller to write a
  // short, curated intro rather than dump a commit body into the sidebar.
  const overlong = findOverlongGroupDetails(opts.groups);
  if (overlong.length > 0) {
    const which = overlong.map((g) => `"${g.title}" is ${g.length} chars`).join('; ');
    return {
      ok: false,
      error: 'group-details-too-long',
      detail: `${which} — max ${MAX_GROUP_DETAILS}. Write a short 1–2 sentence intro; don't paste the full commit body.`,
    };
  }

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
    // The workspace has no registry — its members ARE the record, so the
    // bind-time config rides along on them for refreshWorkspace to read back.
    rememberWorkspaceConfig(host, reviewId, opts);
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
    if (reviewIdOf(meta) !== reviewId || meta.type !== 'diff') continue;
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
      whitespaceOnly: entry.whitespaceOnly,
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
      diffWhitespaceOnly: entry.whitespaceOnly,
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
    // Being accepted here IS being part of the diff, so a member that had
    // gone stale stops rendering as a ghost. Re-running create_diff_review is
    // documented as an idempotent refresh path; leaving the flag set would
    // make it a half-refresh that needs refresh_workspace to finish.
    setStaleFlag(host, docId, false);
    if (target) {
      // Pinned mode: seed the target-commit content once; no file
      // binding, no poll — content can't change underneath us.
      const content = room.ydoc.getText('content');
      if (content.length === 0 && text.length > 0) {
        room.ydoc.transact(() => content.insert(0, text), 'file-seed');
      }
    } else if (entry.status !== 'deleted') {
      // Working-tree mode: bind the live file like a code doc — seeds the
      // content, arms the mtime poll (agent edits re-render in ~1s), and
      // for code members flows File-view edits back to the working tree.
      // `.md` members stay disk→doc only: their edits travel through the
      // companion prose doc, and a second writer on the same file would
      // race it.
      const isMd = entry.relPath.toLowerCase().endsWith('.md');
      host.attachFlatFile(docId, join(root, entry.relPath), { writeBack: !isMd });
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

  // AFTER the loop, and across EVERY member — not just the ones this bind
  // accepted. Narrowing a review leaves the newly-excluded members untouched,
  // so writing config only to accepted files would leave them holding the old
  // exclude/groups/maxFiles — and refreshWorkspace, which reads the config off
  // whichever member it finds first, would replay that obsolete scope.
  rememberWorkspaceConfig(host, reviewId, opts);

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
    // Explicitly false, not undefined: a file that STOPS being whitespace-only
    // (the agent added a real edit on a working-tree review) must clear the
    // flag, and refreshDiffMeta skips undefined values.
    diffWhitespaceOnly: entry.whitespaceOnly === true,
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

export interface WorkspaceMemberRef {
  docId: string;
  relPath?: string;
}

export type RefreshWorkspaceResult =
  | {
      ok: true;
      workspaceId: string;
      root: string;
      kind: 'diff' | 'browse';
      /** Files that became review members on THIS refresh. */
      added: WorkspaceMemberRef[];
      /** Members no longer part of the review, with the comments stranded on
       *  them. Reported every refresh while they stay stale, not just the
       *  first — a caller polling this needs the current picture. */
      stale: Array<WorkspaceMemberRef & { openThreads: number }>;
      /** Members that were stale and are back. */
      restored: WorkspaceMemberRef[];
      /** Diff: changed files. Browse: files the sidebar can open. */
      fileCount: number;
    }
  | {
      ok: false;
      error: 'not-found' | 'root-missing' | 'pinned' | 'too-many-files' | 'rebind-failed';
      detail?: string;
      fileCount?: number;
    };

/**
 * Re-reconcile a workspace against what's on disk RIGHT NOW, without
 * re-minting a single docId — which is the whole point, since a docId is
 * what every comment thread hangs off.
 *
 * A review's membership used to be decided once, at bind time. A file
 * changed afterwards stayed invisible to the sidebar unless someone
 * remembered the original base ref and re-ran the bind by hand; a file
 * deleted afterwards stayed listed forever, pointing at nothing.
 *
 * Two flavours, one contract:
 *   - DIFF review — re-runs the diff from the stored base, so files that
 *     changed since the bind join the review, and per-file status/line
 *     counts refresh. A member whose change was reverted is marked `stale`,
 *     NOT deleted: its threads are still someone's feedback, and the change
 *     may well come back. Pinned reviews refuse — their content is a
 *     commit, so there is nothing to re-read.
 *   - BROWSE workspace — members bind lazily (openContextFile), so there is
 *     nothing new to bind here; what refresh adds is the reverse sweep,
 *     flagging members whose file has since been deleted or renamed away.
 *
 * `stale` is always reversible: the next refresh that finds the file clears
 * the flag and reports it under `restored`.
 */
export function refreshWorkspace(host: BindHost, workspaceId: string): RefreshWorkspaceResult {
  const members = host.list().filter((m) => reviewIdOf(m) === workspaceId);
  // No members means nothing is bound — which is also the state a folder
  // bound while EMPTY is left in (a documented degenerate success that
  // creates no docs). The root can't be recovered from the hashed
  // workspaceId, so point the caller at the operation that can.
  const noRoot = {
    ok: false,
    error: 'not-found',
    detail:
      'no bound members for this workspace — re-run bind_folder / create_diff_review on the folder. It is idempotent and derives the same workspaceId, so shares and threads survive.',
  } as const;
  if (members.length === 0) return noRoot;
  const root = members.find((m) => m.workspaceRoot)?.workspaceRoot;
  if (!root) return noRoot;
  if (!existsSync(root)) return { ok: false, error: 'root-missing', detail: root };

  const diffMember = members.find((m) => m.type === 'diff');
  if (diffMember?.diffTarget) return { ok: false, error: 'pinned' };

  const before = new Set(members.map((m) => m.docId));
  // Snapshot staleness BEFORE the re-bind, which clears the flag on every
  // file it accepts — reading meta.stale afterwards would report nothing as
  // restored.
  const staleBefore = new Set(members.filter((m) => m.stale).map((m) => m.docId));
  const owner = members.find((m) => m.owner)?.owner;
  // Re-apply what the workspace was BOUND with. Without the exclude list a
  // refresh silently widens the review's scope; without the group spec every
  // newly-changed file lands in a heuristic bucket, so a sidebar the caller
  // organized by hand decays a little on each refresh.
  const exclude = members.find((m) => m.workspaceExclude)?.workspaceExclude;
  const groups = members.find((m) => m.workspaceGroups)?.workspaceGroups;
  const maxFiles = members.find((m) => m.workspaceMaxFiles !== undefined)?.workspaceMaxFiles;
  // Which relPaths the DIFF currently covers. Null for a browse workspace,
  // where "is it still there?" is answered by the filesystem instead.
  let liveRelPaths: Set<string> | null = null;
  let fileCount: number;

  if (diffMember) {
    const base = diffMember.diffBase;
    if (!base) return { ok: false, error: 'rebind-failed', detail: 'diff member has no base ref' };
    const res = bindDiff(host, {
      repoPath: root,
      base,
      reviewId: workspaceId,
      owner,
      ...(exclude ? { exclude } : {}),
      ...(groups ? { groups } : {}),
      ...(maxFiles !== undefined ? { maxFiles } : {}),
    });
    if (res.ok) {
      liveRelPaths = new Set(res.files.map((f) => f.relPath));
      fileCount = res.fileCount;
    } else if (res.error === 'empty-diff') {
      // Every change reverted. Not an error — every member goes stale.
      liveRelPaths = new Set();
      fileCount = 0;
    } else if (res.error === 'too-many-files') {
      // Distinct from a generic failure: the caller can act on it by raising
      // maxFiles (re-run the bind) or narrowing with exclude.
      return {
        ok: false,
        error: 'too-many-files',
        ...(res.fileCount !== undefined ? { fileCount: res.fileCount } : {}),
        detail: `the review now covers more files than its cap (${maxFiles ?? DEFAULT_MAX_FILES}) — raise maxFiles by re-running the bind, or narrow it with exclude`,
      };
    } else {
      return { ok: false, error: 'rebind-failed', detail: res.detail ?? res.error };
    }
  } else {
    const excludes = normalizeExcludes(exclude);
    fileCount = scanFolder(root)
      .map((abs) => relative(root, abs).split(sep).join('/'))
      .filter((rel) => !isExcluded(rel, excludes)).length;
  }

  // A `.md` diff member can have a companion EDITOR doc on the same relPath
  // (openEditableFile). It must follow its member out of the review, or the
  // workspace ends up half-stale for one path — and, because the companion
  // isn't a diff member, a share would start landing on the editor for a file
  // that is no longer under review. Context files (openContextFile) are a
  // different case: they were never in the diff, so only their file's absence
  // makes them stale.
  const staleDiffPaths = new Set<string>();
  if (liveRelPaths) {
    for (const meta of members) {
      if (meta.type === 'diff' && meta.relPath && !liveRelPaths.has(meta.relPath)) {
        staleDiffPaths.add(meta.relPath);
      }
    }
  }

  const added: WorkspaceMemberRef[] = [];
  const stale: Array<WorkspaceMemberRef & { openThreads: number }> = [];
  const restored: WorkspaceMemberRef[] = [];
  for (const meta of host.list()) {
    if (reviewIdOf(meta) !== workspaceId) continue;
    const ref: WorkspaceMemberRef = {
      docId: meta.docId,
      ...(meta.relPath ? { relPath: meta.relPath } : {}),
    };
    if (!before.has(meta.docId)) {
      // Bound moments ago by the re-diff above, so it is live by construction.
      added.push(ref);
      continue;
    }
    if (!meta.relPath) continue;
    // A diff member is judged by the diff (a DELETED file is legitimately
    // absent from disk — being gone IS its change); everything else by
    // whether the file is still there.
    const gone =
      meta.type === 'diff' && liveRelPaths
        ? !liveRelPaths.has(meta.relPath)
        : staleDiffPaths.has(meta.relPath) || !existsSync(join(root, meta.relPath));
    if (gone) {
      setStaleFlag(host, meta.docId, true);
      stale.push({ ...ref, openThreads: host.listThreads(meta.docId, { status: 'open' }).length });
    } else if (staleBefore.has(meta.docId)) {
      setStaleFlag(host, meta.docId, false);
      restored.push(ref);
    }
  }
  const bySortKey = (a: WorkspaceMemberRef, b: WorkspaceMemberRef) =>
    (a.relPath ?? a.docId).localeCompare(b.relPath ?? b.docId);
  added.sort(bySortKey);
  stale.sort(bySortKey);
  restored.sort(bySortKey);

  return {
    ok: true,
    workspaceId,
    root,
    kind: diffMember ? 'diff' : 'browse',
    added,
    stale,
    restored,
    fileCount,
  };
}

export type SetWorkspaceGroupsResult =
  | {
      ok: true;
      workspaceId: string;
      groups: Array<{ title: string; fileCount: number }>;
      /** Files no supplied group claimed — they land in "Other". */
      ungrouped: string[];
    }
  | {
      ok: false;
      error: 'not-found' | 'no-diff-members' | 'bad-groups' | 'group-details-too-long';
      detail?: string;
    };

/**
 * Re-group a diff review's sidebar in place. Grouping used to be decided
 * once, at bind time, so improving it meant tearing the review down and
 * rebuilding it — which throws away every thread.
 *
 * Pass an EMPTY array to fall back to the churn/bucket heuristic. Same
 * matching rules and the same hard `details` limit as bind time: a path
 * claims a file exactly or as a directory prefix, first group wins, and an
 * over-long intro is rejected rather than truncated.
 */
export function setWorkspaceGroups(
  host: BindHost,
  workspaceId: string,
  groups: Array<{ title: string; paths: string[]; details?: string }>,
): SetWorkspaceGroupsResult {
  const members = host.list().filter((m) => reviewIdOf(m) === workspaceId);
  if (members.length === 0) return { ok: false, error: 'not-found' };
  const diffMembers = members.filter(
    (m): m is typeof m & { relPath: string } => m.type === 'diff' && !!m.relPath,
  );
  if (diffMembers.length === 0) {
    return {
      ok: false,
      error: 'no-diff-members',
      detail: 'groups organize a diff review; this workspace has no changed-file members',
    };
  }
  // Validate the SHAPE before anything is written. The spec is persisted for
  // refreshWorkspace to replay, so a malformed one written before
  // assignGroups threw on it would leave the workspace permanently
  // un-refreshable — refresh would read it back and throw again.
  const malformed = findMalformedGroups(groups);
  if (malformed.length > 0) {
    return { ok: false, error: 'bad-groups', detail: malformed.join('; ') };
  }
  const overlong = findOverlongGroupDetails(groups);
  if (overlong.length > 0) {
    const which = overlong.map((g) => `"${g.title}" is ${g.length} chars`).join('; ');
    return {
      ok: false,
      error: 'group-details-too-long',
      detail: `${which} — max ${MAX_GROUP_DETAILS}. Write a short 1–2 sentence intro; don't paste the full commit body.`,
    };
  }

  const explicit = groups.length > 0 ? groups : undefined;
  const assignment = assignGroups(
    diffMembers.map((m) => ({
      relPath: m.relPath,
      additions: m.diffAdditions,
      deletions: m.diffDeletions,
      whitespaceOnly: m.diffWhitespaceOnly,
    })),
    explicit,
  );
  // Only now, with a spec proven to assign cleanly, persist it. Storing the
  // SPEC rather than just the resulting per-file assignment is what lets a
  // later refresh file newly-changed files into the right group instead of a
  // heuristic bucket.
  //
  // An EMPTY array is stored as an empty array, not deleted: "the heuristic
  // is the choice here" is itself a decision, and it has to survive. Deleting
  // it would make the reset a one-off — a group-less refresh preserves each
  // member's existing diffGroup (so it can't clobber agent-set groups), so
  // old members would stay frozen at the ranks they held at reset time while
  // new ones got freshly-computed ones, and the churn ordering would stop
  // meaning anything.
  for (const m of members) {
    writeMeta(host, m.docId, [['workspaceGroups', groups]]);
  }

  // Unmatched files get the sentinel rank assignGroups reserves for them —
  // read that rather than the title, so a group the caller actually named
  // "Other" isn't misreported as ungrouped.
  const ungroupedRank = explicit?.length ?? -1;
  const ungrouped: string[] = [];
  const summary = new Map<string, { rank: number; fileCount: number }>();
  for (const m of diffMembers) {
    const a = assignment.get(m.relPath);
    if (!a) continue;
    setGroupMeta(host, m.docId, a);
    if (a.rank === ungroupedRank) ungrouped.push(m.relPath);
    const prev = summary.get(a.group);
    if (prev) prev.fileCount += 1;
    else summary.set(a.group, { rank: a.rank, fileCount: 1 });
  }
  ungrouped.sort();

  return {
    ok: true,
    workspaceId,
    groups: Array.from(summary.entries())
      .sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]))
      .map(([title, g]) => ({ title, fileCount: g.fileCount })),
    ungrouped,
  };
}

/**
 * Replicate the workspace's bind-time config onto a member. Only writes what
 * the caller actually SUPPLIED: a group-less refresh must not erase the spec
 * it is in the middle of re-applying (same explicit-wins rule the diff group
 * assignment follows). Compared by value, so a repeat bind is a no-op rather
 * than a doc update.
 */
function rememberWorkspaceConfig(
  host: BindHost,
  workspaceId: string,
  opts: { exclude?: string[]; groups?: BindDiffOpts['groups']; maxFiles?: number },
): void {
  const next: Array<[keyof DocMeta, unknown]> = [];
  if (opts.exclude !== undefined) next.push(['workspaceExclude', normalizeExcludes(opts.exclude)]);
  if (opts.groups !== undefined) next.push(['workspaceGroups', opts.groups]);
  if (opts.maxFiles !== undefined) next.push(['workspaceMaxFiles', opts.maxFiles]);
  if (next.length === 0) return;
  for (const m of host.list()) {
    if (reviewIdOf(m) === workspaceId) writeMeta(host, m.docId, next);
  }
}

/** Set (or, for an undefined value, DELETE) meta keys on a room, skipping
 *  keys already at the target value. Compares by JSON so array/object values
 *  don't rewrite on every bind. */
function writeMeta(host: BindHost, docId: string, entries: Array<[keyof DocMeta, unknown]>): void {
  const room = host.get(docId);
  if (!room) return;
  const changed = entries.filter(([k, v]) => JSON.stringify(room.meta[k]) !== JSON.stringify(v));
  if (changed.length === 0) return;
  const m = room.ydoc.getMap('meta');
  room.ydoc.transact(() => {
    for (const [k, v] of changed) {
      // Host-describing keys never enter the CRDT — the sync channel hands
      // the whole doc to share visitors. They live in the sidecar, which
      // saveToDisk writes from `room.meta`, so updating the in-memory copy
      // below is the whole write. No call site passes one today; the guard
      // is here so a future one can't reopen the hole by accident.
      if (isPrivateMetaKey(k as string)) continue;
      if (v === undefined) m.delete(k as string);
      else m.set(k as string, v);
    }
  });
  for (const [k, v] of changed) {
    (room.meta as unknown as Record<string, unknown>)[k] = v;
  }
  // A private-only change makes no CRDT update, so nothing would schedule the
  // write that persists the sidecar. Ask for one explicitly.
  if (changed.some(([k]) => isPrivateMetaKey(k as string))) host.persistMeta(docId);
}

/** Flip a member's `stale` marker. Clearing DELETES the key rather than
 *  writing `false`, so a live member's meta looks the same as it did before
 *  this feature existed. */
function setStaleFlag(host: BindHost, docId: string, stale: boolean): void {
  const room = host.get(docId);
  if (!room) return;
  if (stale === (room.meta.stale === true)) return;
  const m = room.ydoc.getMap('meta');
  room.ydoc.transact(() => {
    if (stale) m.set('stale', true);
    else m.delete('stale');
  });
  if (stale) room.meta.stale = true;
  else room.meta.stale = undefined;
}

/** Write a group assignment onto a member, DELETING keys the new assignment
 *  doesn't carry — unlike refreshDiffMeta, which skips undefined. Re-grouping
 *  without a `details` intro must actually drop the old one. */
function setGroupMeta(
  host: BindHost,
  docId: string,
  assignment: { group: string; rank: number; details?: string },
): void {
  writeMeta(host, docId, [
    ['diffGroup', assignment.group],
    ['diffGroupRank', assignment.rank],
    ['diffGroupDetails', assignment.details],
  ]);
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
