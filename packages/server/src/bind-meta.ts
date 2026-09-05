import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { type DocMeta, type DocType, attachmentIdOf } from '@feedback/core';
import type { BindDiffOpts } from './bind-diff.ts';
import type { DocRoom } from './doc-store.ts';
import type { DiffFileEntry } from './git-diff.ts';
import { isPrivateMetaKey } from './private-meta.ts';
/**
 * The shared vocabulary of a bind: the slice of `DocStore` the bind flows use,
 * the deterministic ids, and the small writers that put derived facts onto a
 * member's meta.
 *
 * It exists because `bindDiff` and `refreshWorkspace` are the same act at
 * different moments — one mints the members, the other re-reads them — and
 * both are written in these terms. Keeping the writers here is what stops
 * the two from drifting about what a `stale` flag or a group assignment
 * means, now that they are separate files.
 */

/** The slice of DocStore the bind flows actually need (avoids a runtime
 *  circular import; DocStore passes itself). */
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
  // Every attach here reads a path the CALLER supplied — a file in a repo
  // the bind was pointed at — so all three are the pool doors rather than the
  // synchronous ones. A bind loop over a repository whose folder has stopped
  // answering is the shape that parked production; there is no version of it
  // that may open a bound file on the main thread.
  attachFileAsync(docId: string, path: string): Promise<{ ok: boolean }>;
  attachReadonlyFileAsync(docId: string, path: string): Promise<{ ok: boolean }>;
  attachFlatFileAsync(
    docId: string,
    path: string,
    opts?: { writeBack?: boolean },
  ): Promise<{ ok: boolean }>;
  openContextFile(
    setId: string,
    relPath: string,
  ): Promise<{ ok: true; docId: string; meta: DocMeta } | { ok: false; error: string }>;
  list(): DocMeta[];
}

/** Files above this size are skipped — they'd bloat the ydoc and the
 *  browser payload without being meaningfully reviewable. */
export const MAX_REVIEW_FILE_BYTES = 512 * 1024;
export const DEFAULT_MAX_FILES = 300;

/** Deterministic member docId: group + relPath with `/`→`~` (why `~` is a
 *  legal docId char), hash fallback under the 100-char docId cap. Same file
 *  → same docId, so re-binding preserves threads. */
export function memberDocId(groupId: string, relPath: string): string {
  const docId = `${groupId}:${relPath.replaceAll('/', '~')}`;
  return docId.length > 100 ? `${groupId}:${shortHash(relPath)}` : docId;
}

export function normalizeExcludes(exclude?: string[]): string[] {
  return (exclude ?? []).map((p) => p.replace(/^\/+/, '').replace(/\/+$/, ''));
}

export function isExcluded(relPath: string, excludes: string[]): boolean {
  return excludes.some((p) => relPath === p || relPath.startsWith(`${p}/`));
}

/**
 * Refresh the derived diff fields (status, rename source, line counts) on
 * an existing room. `initDocMeta` is deliberately set-if-absent, which is
 * right for identity fields but wrong for these — in working-tree mode
 * they change every time the agent edits, and a re-bind should show the
 * current numbers, not the ones from the first bind.
 */
export function refreshDiffMeta(
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

/**
 * Replicate the workspace's bind-time config onto a member. Only writes what
 * the caller actually SUPPLIED: a group-less refresh must not erase the spec
 * it is in the middle of re-applying (same explicit-wins rule the diff group
 * assignment follows). Compared by value, so a repeat bind is a no-op rather
 * than a doc update.
 */
export function rememberWorkspaceConfig(
  host: BindHost,
  setId: string,
  opts: { exclude?: string[]; groups?: BindDiffOpts['groups']; maxFiles?: number },
): void {
  const next: Array<[keyof DocMeta, unknown]> = [];
  if (opts.exclude !== undefined) next.push(['workspaceExclude', normalizeExcludes(opts.exclude)]);
  if (opts.groups !== undefined) next.push(['workspaceGroups', opts.groups]);
  if (opts.maxFiles !== undefined) next.push(['workspaceMaxFiles', opts.maxFiles]);
  if (next.length === 0) return;
  for (const m of host.list()) {
    if (attachmentIdOf(m) === setId) writeMeta(host, m.docId, next);
  }
}

/** Set (or, for an undefined value, DELETE) meta keys on a room, skipping
 *  keys already at the target value. Compares by JSON so array/object values
 *  don't rewrite on every bind. */
export function writeMeta(
  host: BindHost,
  docId: string,
  entries: Array<[keyof DocMeta, unknown]>,
): void {
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
export function setStaleFlag(host: BindHost, docId: string, stale: boolean): void {
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
export function setGroupMeta(
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

export function shortHash(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 6);
}
