import { type DocMeta, isReviewMember, reviewIdOf } from '@feedback/core';

/**
 * Every review belongs to a workspace — including the ones made before that
 * was true.
 *
 * `fileUnderHubWorkspace` has filed each new bind and diff review onto a
 * workspace since it was written, defaulting to the "Unfiled" board. Reviews
 * created BEFORE it was written were never filed and nothing has gone back for
 * them. Measured in the live data dir on 2026-08-21: 23 reviews exist, 3 are
 * filed, 20 are not. So the invariant the code asserts in prose ("Every doc
 * and every group bind belongs to a hub workspace") is currently false for
 * most of the data.
 *
 * That was survivable while a review's URL was `/review/<docId>`, which needs
 * no workspace. It stops being survivable the moment resources live under
 * `/workspaces/<id>/…`: an unfiled review has no workspace to name, so it has
 * no address.
 *
 * ADDITIVE AND IDEMPOTENT, deliberately. This runs at every boot, so it must
 * be a no-op on the second one — it only ever appends a `docIds` entry to a
 * workspace, and only for a review that has none. It writes nothing to any
 * `.ydoc`, moves no file, and deletes nothing. A review filed here can be
 * moved afterwards with `attach_doc` and this pass will not put it back,
 * because it asks "is it filed anywhere", not "is it filed where I would have
 * put it".
 */

/**
 * The reviews that exist in the doc set but sit on no workspace, each named
 * once, sorted so two boots produce the same list.
 */
export function reviewIdsNeedingFiling(
  docs: readonly DocMeta[],
  isFiled: (reviewId: string) => boolean,
): string[] {
  const seen = new Set<string>();
  for (const meta of docs) {
    // A review, not merely a shared `setId` — a batch of docs registered
    // together for one sidebar is not a review and must not become a row.
    if (!isReviewMember(meta)) continue;
    const id = reviewIdOf(meta);
    if (id === undefined || seen.has(id)) continue;
    if (isFiled(id)) continue;
    seen.add(id);
  }
  return Array.from(seen).sort();
}

export interface ReviewBackfillDeps {
  docs: () => readonly DocMeta[];
  /** Whether this review is already attached to some workspace. */
  isFiled: (reviewId: string) => boolean;
  /** Attach the review and answer which workspace took it. */
  file: (reviewId: string) => string;
}

export interface ReviewBackfillResult {
  filed: Array<{ reviewId: string; workspaceId: string }>;
  failed: string[];
}

export function backfillReviewFiling(deps: ReviewBackfillDeps): ReviewBackfillResult {
  const filed: ReviewBackfillResult['filed'] = [];
  const failed: string[] = [];
  for (const reviewId of reviewIdsNeedingFiling(deps.docs(), deps.isFiled)) {
    try {
      filed.push({ reviewId, workspaceId: deps.file(reviewId) });
    } catch {
      // One review that cannot be filed must not strand the rest, and must
      // not take the boot down with it — the server is useful either way, and
      // the next start tries again.
      failed.push(reviewId);
    }
  }
  return { filed, failed };
}
