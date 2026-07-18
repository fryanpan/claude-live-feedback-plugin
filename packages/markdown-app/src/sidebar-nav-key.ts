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
