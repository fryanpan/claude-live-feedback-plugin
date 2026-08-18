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

/** Where the arrow points and what it says it does. */
export function backLinkFor(backTo?: BackTarget | null): { href: string; label: string } {
  const id = backTo?.workspaceId;
  if (!id) return { href: '/', label: 'Back to all review docs' };
  return {
    href: `/workspaces/${encodeURIComponent(id)}`,
    // The id is a poor label and a correct one: it is what the board's own
    // URL says, so an unnamed board is still identifiable rather than blank.
    label: `Back to ${backTo?.name || id}`,
  };
}

/**
 * Point the shell's back arrow at `backTo`, or at the index when there is
 * none. Always writes both branches — a stale board target would otherwise
 * survive a navigation to a doc that has no board.
 *
 * The label goes on `aria-label` AND `title` and nowhere visible: at phone
 * width the crumb is the arrow plus an ellipsized file path (measured at
 * 440px: the path had 121px), so a board name rendered beside it would take
 * width from the one thing that identifies the document.
 */
export function applyBackLink(doc: Document, backTo?: BackTarget | null): void {
  const el = doc.querySelector('.doc-crumb .back-link');
  if (!el) return;
  const { href, label } = backLinkFor(backTo);
  el.setAttribute('href', href);
  el.setAttribute('aria-label', label);
  el.setAttribute('title', label);
}
