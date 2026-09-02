/**
 * Bind a git diff for review — the flow that turns a range into a review's
 * members.
 *
 * Split out of `binds.ts`, which keeps the folder flow. The two share their
 * skeleton (enumerate → filter → guardrail → deterministic docIds →
 * getOrCreate + attach) and their writers, and the writers now live in
 * `bind-meta.ts` so neither file owns the other's rules.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { type DocMeta, type DocType, reviewIdOf } from '@feedback/core';
import {
  type BindHost,
  DEFAULT_MAX_FILES,
  MAX_REVIEW_FILE_BYTES,
  deriveDiffReviewId,
  deriveWorkspaceId,
  isExcluded,
  memberDocId,
  normalizeExcludes,
  refreshDiffMeta,
  rememberWorkspaceConfig,
  setStaleFlag,
} from './bind-meta.ts';
import {
  MAX_GROUP_DETAILS,
  assignGroups,
  findMalformedGroups,
  findOverlongGroupDetails,
} from './diff-groups.ts';
import { isReservedDocId } from './doc-ids.ts';
import { scanFolder } from './fs-scan.ts';
import {
  type DiffFileEntry,
  diffFiles,
  resolveCommit,
  showFile,
  textLooksBinary,
} from './git-diff.ts';

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
        | 'reserved-namespace'
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
  // The review id is the `groupId` half of every member docId this bind is
  // about to mint, so a reserved one mints reserved rooms: `reviewId: 'task'`
  // over a folder with a README produced a real `task:README.md`. The seam in
  // `getOrCreate` refuses those anyway — this is here so the caller gets one
  // legible 400 naming the id it chose, instead of a throw from the middle of
  // a file loop.
  if (opts.reviewId !== undefined && isReservedDocId(`${opts.reviewId}:`)) {
    return {
      ok: false,
      error: 'reserved-namespace',
      detail: `"${opts.reviewId}" names a namespace the server owns; pick another review id.`,
    };
  }
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
