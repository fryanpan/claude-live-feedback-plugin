/**
 * Shared sidebar-render signature. All three sidebar renderers — the diff-nav
 * (`diff-nav.ts`), the folder tree (`workspace-tree.ts`), and the legacy setId
 * list (`app.ts renderSetNav`) — write into the SAME `#set-pane-list` slot, so
 * they must share ONE render-state slot, not one per renderer.
 *
 * The regression this fixes: with a per-renderer key, a stale key from renderer
 * X suppressed a needed rebuild by renderer Y (e.g. Back from a folder-tree
 * workspace to a diff workspace saw the diff key still matching and left the
 * folder tree on screen — wrong tree for the open file).
 *
 * The signature encodes the rendered CONTENT (renderer namespace + workspace +
 * view + the file list's structural identity), NOT badge counts. Renderers
 * re-fetch on every navigation and rebuild the DOM only when the signature
 * changed; an unchanged signature just moves the active marker, preserving the
 * reviewer's scroll. A newly-changed file (or a different workspace) changes the
 * signature and forces the rebuild, so the list stays fresh in place.
 */

/**
 * Reserve (or give back) the sidebar's grid column.
 *
 * Call this with a list you have ALREADY fetched, never with a set id you have
 * merely read off doc meta. `has-set` used to go on the body synchronously
 * from meta, before the fetch that would fill the column — and every failure
 * mode of that fetch left the same artifact. Reported 2026-08-19 on an iPad
 * over the tailnet: *"an empty 'In this review' left panel that still takes up
 * space but has nothing in it"*, then *"in this review loaded in eventually"*.
 * A slow fetch flashed the empty column, a failed one left it there
 * permanently, and a set with no markdown members rendered it with zero rows.
 *
 * The retraction is for a KNOWN-empty list only. A failed refresh must not
 * collapse the column under a reviewer who is reading the rows in it, and a
 * failed FIRST load never committed, so it has nothing to give back.
 */
export function commitSidebarColumn(hasRows: boolean): void {
  document.body.classList.toggle('has-set', hasRows);
  document.getElementById('set-pane')?.setAttribute('aria-hidden', hasRows ? 'false' : 'true');
}

let renderedSig: string | null = null;

/** True when the sidebar already shows exactly `sig` and still has content —
 *  the caller may skip the DOM rebuild and only move the active marker. */
export function sidebarShowsSignature(sig: string): boolean {
  const list = document.getElementById('set-pane-list');
  return renderedSig === sig && (list?.childElementCount ?? 0) > 0;
}

/** Record the signature just rendered into the sidebar. */
export function setSidebarSignature(sig: string): void {
  renderedSig = sig;
}

/** Forget the current signature (e.g. after clearing the sidebar for a doc that
 *  has no review set) so the next render always rebuilds. */
export function resetSidebarSignature(): void {
  renderedSig = null;
}

/**
 * Monotonic sidebar-render epoch — an optimistic-concurrency token for the
 * shared sidebar. Any code about to (re)build it claims a token via
 * `beginSidebarRender()` BEFORE its first await, then after each await checks
 * `isCurrentSidebarRender(token)` and bails if a newer render has since claimed
 * the sidebar. This makes the last claim win, catching supersessions
 * `scope.disposed` cannot: a view-toggle whose workspace was navigated away
 * during its on-demand fetch, or two same-mount fetches (e.g. legacy-set meta
 * ticks) resolving out of order. It complements `scope.disposed` (which catches
 * a mount torn down with no newer render to bump the epoch) rather than
 * replacing it.
 */
let renderEpoch = 0;

/** Claim the sidebar for the caller's render; returns the token to re-check
 *  after each await. */
export function beginSidebarRender(): number {
  renderEpoch += 1;
  return renderEpoch;
}

/** True while `token` is still the newest claim — i.e. no later render has
 *  superseded this one. */
export function isCurrentSidebarRender(token: number): boolean {
  return token === renderEpoch;
}
