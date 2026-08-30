/**
 * The review shell's back arrow.
 *
 * `index.html` ships it as a static `href="/"`, which is the machine-wide
 * landing page — a list of every artifact on the box. That is the wrong
 * destination for a doc reached from a workspace board: the board is where
 * the work is, and returning to the index means finding the board again.
 *
 * The board can only come from the server (`backTo` on `/api/docs/<id>`),
 * because the page itself knows nothing about who linked to it — a doc URL
 * pasted into a message arrives with no referrer at all. So this module is
 * the small half: take the resolved board and point the arrow at it.
 *
 * Kept out of `app.ts` and applied by the router because the arrow is SHELL
 * chrome that outlives each per-doc mount: navigation is in-place, so an
 * arrow left pointing at the previous doc's board is a live wrong link.
 */

export interface BackTarget {
  workspaceId: string;
  name: string;
}

/**
 * The reader's place in the review queue, read off the doc's own URL.
 *
 * Only the walkthrough writes this, and only onto the link it mints for a doc
 * item — so its presence means "this reader is mid-sitting", and its absence
 * means a doc reached some other way. That is the whole reason the stamp is
 * on the URL rather than inferred: a pasted doc link must not return anyone
 * to a queue they were never in.
 */
export function returnItemFrom(search: string): string | null {
  const item = new URLSearchParams(search).get('item');
  return item ? item : null;
}

/** Where the arrow points and what it says it does. */
export function backLinkFor(
  backTo?: BackTarget | null,
  returnItem?: string | null,
): { href: string; label: string } {
  const id = backTo?.workspaceId;
  if (!id) return { href: '/', label: 'Back to all review docs' };
  const board = `/workspaces/${encodeURIComponent(id)}`;
  return {
    // Encoded because the stamp comes from the address bar: an un-encoded `/`
    // would turn this same-origin path into `//host`, an off-site link wearing
    // the back arrow's clothes.
    href: returnItem ? `${board}/home?item=${encodeURIComponent(returnItem)}` : board,
    // The id is a poor label and a correct one: it is what the board's own
    // URL says, so an unnamed board is still identifiable rather than blank.
    label: `Back to ${backTo?.name || id}`,
  };
}

/**
 * Point the shell's back arrow at `backTo`, or at the index when there is
 * none. Always writes both branches — a stale board target would otherwise
 * survive a navigation to a doc that has no board, and so would a stale
 * queue position: navigation is in-place, so the previous doc's `?item=`
 * would send this doc's reader back into someone else's sitting.
 *
 * The label goes on `aria-label` AND `title` and nowhere visible: at phone
 * width the crumb is the arrow plus an ellipsized file path (measured at
 * 440px: the path had 121px), so a board name rendered beside it would take
 * width from the one thing that identifies the document.
 */
export function applyBackLink(
  doc: Document,
  backTo?: BackTarget | null,
  returnItem?: string | null,
): void {
  const el = doc.querySelector('.doc-crumb .back-link');
  if (!el) return;
  const { href, label } = backLinkFor(backTo, returnItem);
  el.setAttribute('href', href);
  el.setAttribute('aria-label', label);
  el.setAttribute('title', label);
}
