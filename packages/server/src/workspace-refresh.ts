/**
 * Re-reading a bound review: `refreshWorkspace` reconciles a folder or diff
 * review against disk without minting new docIds, and `setWorkspaceGroups`
 * re-groups a diff review's sidebar in place.
 *
 * Both exist because a review's threads are the expensive thing in it. The
 * cheap fix for a stale review — tear it down and bind it again — throws
 * every thread away, so these two do the work in place instead, and that is
 * the rule the whole file is written to.
 */
import { existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { attachmentIdOf } from '@feedback/core';
import { bindDiff } from './bind-diff.ts';
import {
  type BindHost,
  DEFAULT_MAX_FILES,
  isExcluded,
  normalizeExcludes,
  setGroupMeta,
  setStaleFlag,
  writeMeta,
} from './bind-meta.ts';
import {
  MAX_GROUP_DETAILS,
  assignGroups,
  findMalformedGroups,
  findOverlongGroupDetails,
} from './diff-groups.ts';
import { scanFolder } from './fs-scan.ts';

export interface WorkspaceMemberRef {
  docId: string;
  relPath?: string;
}

export type RefreshWorkspaceResult =
  | {
      ok: true;
      setId: string;
      /** Same value as `setId`, deprecated for one release. */
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
export async function refreshWorkspace(
  host: BindHost,
  setId: string,
): Promise<RefreshWorkspaceResult> {
  const members = host.list().filter((m) => attachmentIdOf(m) === setId);
  // No members means nothing is bound — which is also the state a folder
  // bound while EMPTY is left in (a documented degenerate success that
  // creates no docs). The root can't be recovered from the hashed
  // setId, so point the caller at the operation that can.
  const noRoot = {
    ok: false,
    error: 'not-found',
    detail:
      'no bound members for this workspace — re-run attach_folder / create_diff_review on the folder. It is idempotent and derives the same setId, so shares and threads survive.',
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
    const res = await bindDiff(host, {
      repoPath: root,
      base,
      reviewId: setId,
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
    if (attachmentIdOf(meta) !== setId) continue;
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
    setId,
    workspaceId: setId,
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
      setId: string;
      /** Same value as `setId`, deprecated for one release. */
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
  setId: string,
  groups: Array<{ title: string; paths: string[]; details?: string }>,
): SetWorkspaceGroupsResult {
  const members = host.list().filter((m) => attachmentIdOf(m) === setId);
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
    setId,
    workspaceId: setId,
    groups: Array.from(summary.entries())
      .sort((a, b) => a[1].rank - b[1].rank || a[0].localeCompare(b[0]))
      .map(([title, g]) => ({ title, fileCount: g.fileCount })),
    ungrouped,
  };
}
