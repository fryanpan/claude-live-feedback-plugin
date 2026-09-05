import { type DocMeta, attachmentIdOf, isAttachmentMember } from '@feedback/core';

/**
 * Every attachment set belongs to a workspace — including the ones made before that
 * was true.
 *
 * `fileUnderBoardWorkspace` has filed each new bind and diff attachment set onto a
 * workspace since it was written, defaulting to the "Unfiled" board. Attachment sets
 * created BEFORE it was written were never filed and nothing has gone back for
 * them. Measured in the live data dir on 2026-08-21: 23 attachment sets exist, 3 are
 * filed, 20 are not. So the invariant the code asserts in prose ("Every doc
 * and every group bind belongs to a board workspace") is currently false for
 * most of the data.
 *
 * That was survivable while a set's URL was `/review/<docId>`, which needs no
 * workspace. It stops being survivable the moment resources live under
 * `/workspaces/<id>/…`: an unfiled set has no workspace to name, so it has no
 * address.
 *
 * ADDITIVE AND IDEMPOTENT, deliberately. This runs at every boot, so it must
 * be a no-op on the second one — it only ever appends a `docIds` entry to a
 * workspace, and only for an attachment set that has none. It writes nothing to any
 * `.ydoc`, moves no file, and deletes nothing. An attachment set filed here can be
 * moved afterwards with `attach_doc` and this pass will not put it back,
 * because it asks "is it filed anywhere", not "is it filed where I would have
 * put it".
 */

/**
 * The attachment sets that exist in the doc set but sit on no workspace, each named
 * once, sorted so two boots produce the same list.
 */
export function attachmentIdsNeedingFiling(
  docs: readonly DocMeta[],
  isFiled: (attachmentId: string) => boolean,
): string[] {
  const seen = new Set<string>();
  for (const meta of docs) {
    // An attachment set, not merely a shared `setId` — a batch of docs
    // registered together for one sidebar is not a set and must not become
    // a row.
    if (!isAttachmentMember(meta)) continue;
    const id = attachmentIdOf(meta);
    if (id === undefined || seen.has(id)) continue;
    if (isFiled(id)) continue;
    seen.add(id);
  }
  return Array.from(seen).sort();
}

export interface AttachmentBackfillDeps {
  docs: () => readonly DocMeta[];
  /** Whether this attachment set is already attached to some workspace. */
  isFiled: (attachmentId: string) => boolean;
  /** Attach the attachment set and answer which workspace took it. */
  file: (attachmentId: string) => string;
}

export interface AttachmentBackfillResult {
  filed: Array<{ attachmentId: string; workspaceId: string }>;
  failed: string[];
}

export function backfillAttachmentFiling(deps: AttachmentBackfillDeps): AttachmentBackfillResult {
  const filed: AttachmentBackfillResult['filed'] = [];
  const failed: string[] = [];
  for (const attachmentId of attachmentIdsNeedingFiling(deps.docs(), deps.isFiled)) {
    try {
      filed.push({ attachmentId, workspaceId: deps.file(attachmentId) });
    } catch {
      // One set that cannot be filed must not strand the rest, and must
      // not take the boot down with it — the server is useful either way, and
      // the next start tries again.
      failed.push(attachmentId);
    }
  }
  return { filed, failed };
}
