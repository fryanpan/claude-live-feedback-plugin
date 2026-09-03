/**
 * The legacy flat-setId sidebar's two decisions: what to ask the server for,
 * and which of the answer to keep.
 *
 * Both lived inside `renderSetNav`'s closure, where the cost of the first one
 * was invisible — it fetched `/api/docs` whole (4,205,683 bytes across 4,062
 * rows, measured 2026-08-21 on the live server) so that a `.filter` could pick
 * out the six docs sharing a setId. Out here they are two named functions with
 * a test each.
 */

/** The subset of a `/api/docs` row this sidebar reads. */
export interface SetDoc {
  docId: string;
  type: string;
  sourceUrl?: string;
  title?: string;
  setId?: string;
  /** Deprecated spelling of `setId`, still on docs written before the rename. */
  workspaceId?: string;
}

/** The listing URL scoped to one review set. */
export function setDocsUrl(setId: string): string {
  return `/api/docs?setId=${encodeURIComponent(setId)}`;
}

/**
 * This set's markdown docs, in the order the sidebar lists them.
 *
 * The filter is kept even though the server now applies the same one: a client
 * built against this route can be loaded from a server that predates it, which
 * answers `?setId=` with the whole listing. Filtering twice makes that case
 * slow; trusting the server there would make it wrong.
 */
export function selectSetSiblings(docs: SetDoc[], setId: string): SetDoc[] {
  const sortKey = (d: SetDoc) => (d.title ?? d.sourceUrl ?? d.docId).toLowerCase();
  return docs
    .filter((d) => (d.setId ?? d.workspaceId) === setId && d.type === 'markdown')
    .sort((a, b) => {
      const ka = sortKey(a);
      const kb = sortKey(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
}
