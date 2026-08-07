import { basename } from 'node:path';
import type { DocMeta } from '@feedback/core';

/**
 * Strip a doc's metadata down to what a share visitor needs.
 *
 * `GET /api/docs/<id>` is in a share visitor's scope — they have to read it
 * to render the doc — but the full DocMeta is a description of Bryan's
 * machine, not of the document: an absolute `sourceUrl`
 * (`/Volumes/Data/Users/bryanchan/dev/<private-repo>/…`), an `owner` that is
 * an agent's project directory, a `workspaceRoot`, and a `reviewUrl` on the
 * tailnet hostname. None of it is needed to render a review, and together it
 * maps out a filesystem and a private network for someone who was handed one
 * link.
 *
 * Allowlist, not denylist: a field added later is redacted by default rather
 * than leaking until somebody notices.
 */
export function redactMetaForVisitor(meta: DocMeta & { reviewUrl?: string }): Partial<DocMeta> {
  return {
    docId: meta.docId,
    type: meta.type,
    createdAt: meta.createdAt,
    ...(meta.title !== undefined ? { title: meta.title } : {}),
    // relPath deliberately STAYS — it's the file's path within the review,
    // which is the thing being reviewed, and it's already in the sidebar.
    // When there isn't one (a standalone shared doc), fall back to the
    // BASENAME of the source path: the client picks its syntax-highlighting
    // language off this, so dropping it entirely would silently turn a
    // visitor's code view into plain text. A bare filename is already
    // visible as the title; the directories are what we're withholding.
    ...(meta.relPath !== undefined
      ? { relPath: meta.relPath }
      : meta.sourceUrl
        ? { relPath: basename(meta.sourceUrl) }
        : {}),
    ...(meta.workspaceId !== undefined ? { workspaceId: meta.workspaceId } : {}),
    ...(meta.setId !== undefined ? { setId: meta.setId } : {}),
    ...(meta.lastActivityAt !== undefined ? { lastActivityAt: meta.lastActivityAt } : {}),
    ...(meta.stale !== undefined ? { stale: meta.stale } : {}),
    // Diff presentation — line counts and status drive the badges the
    // visitor is looking at.
    //
    // diffTarget is LOAD-BEARING, not decoration: the client reads "pinned"
    // as "diffTarget is non-empty" (see code/editable-policy.ts), so dropping
    // it made every shared pinned review look like a live working-tree one
    // and UNLOCKED its editor. A visitor could then type into content that is
    // supposed to be immutable — no write-back to disk, but the Yjs doc
    // mutates and broadcasts to everyone else on the review.
    //
    // Keeping the hashes costs nothing worth protecting: a visitor holding
    // this link is already reading the diff's full contents, so the commit
    // ids they came from add no information.
    ...(meta.diffBase !== undefined ? { diffBase: meta.diffBase } : {}),
    ...(meta.diffTarget !== undefined ? { diffTarget: meta.diffTarget } : {}),
    ...(meta.diffStatus !== undefined ? { diffStatus: meta.diffStatus } : {}),
    ...(meta.diffAdditions !== undefined ? { diffAdditions: meta.diffAdditions } : {}),
    ...(meta.diffDeletions !== undefined ? { diffDeletions: meta.diffDeletions } : {}),
    ...(meta.diffOldPath !== undefined ? { diffOldPath: meta.diffOldPath } : {}),
    ...(meta.diffGroup !== undefined ? { diffGroup: meta.diffGroup } : {}),
    ...(meta.diffGroupRank !== undefined ? { diffGroupRank: meta.diffGroupRank } : {}),
    ...(meta.diffGroupDetails !== undefined ? { diffGroupDetails: meta.diffGroupDetails } : {}),
  };
}

/**
 * A review URL a visitor can actually use: same path, but rooted at the
 * host they arrived on rather than the tailnet name the server prefers.
 * Returns a relative URL, which is correct for every share mode and leaks
 * no hostname at all.
 */
export function relativeReviewUrl(reviewUrl: string | undefined): string | undefined {
  if (!reviewUrl) return undefined;
  try {
    const u = new URL(reviewUrl);
    return `${u.pathname}${u.search}`;
  } catch {
    // Already relative (or unparseable) — pass through only if it's a path.
    return reviewUrl.startsWith('/') ? reviewUrl : undefined;
  }
}
