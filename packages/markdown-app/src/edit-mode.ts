/**
 * View mode or edit mode, and — the part that is not a preference at all —
 * whether this browser is allowed to be in edit mode.
 *
 * The stored preference is global, cross-doc and permanent: `lf:edit-mode` is
 * written on every press of the pencil and never cleared, so anybody who has
 * once edited any doc in this browser arrives at every later doc with
 * `edit` stored. That is correct for a preference and catastrophic as an
 * answer, because the SERVER decides whether writing is possible and the
 * preference cannot know what it said.
 *
 * The mount used to read the preference, make the document editable, and only
 * then ask `/api/auth/session`. For one round trip — 0ms on loopback, ~200ms
 * over a Cloudflare Tunnel, which is this product's stated deployment — the
 * doc was live: it took typing, said "Unsaved changes", and then reverted with
 * no modal and no toast when the answer landed. The words were never in the
 * ydoc (the socket is read-only server-side) and were gone on reload. Prose
 * rides the yjs socket, so there is no HTTP 401 to catch it afterwards.
 *
 * So the answer is an ARGUMENT here, and `initialEditMode` is the only way in.
 * A caller that has not got the answer cannot express the question.
 */

export type EditMode = 'view' | 'edit';

/** Global across docs and browsers-tabs, by design: it is which mode this
 *  person likes, not which mode this document is in. */
export const EDIT_MODE_KEY = 'lf:edit-mode';

/**
 * Default to VIEW everywhere — a review surface reads first, edits by choice,
 * and view mode avoids the mobile keyboard popping up on tap. View-mode
 * commenting works: getSelectionRel() falls back to the raw DOM selection and
 * the pill keys off it, so an iOS long-press raises the pill even though the
 * doc is non-editable.
 */
export function defaultEditMode(): EditMode {
  return 'view';
}

/** The stored preference alone. Never the mount's answer — see
 *  `initialEditMode`, which is what a mount calls. */
export function readEditModePref(): EditMode {
  try {
    const stored = localStorage.getItem(EDIT_MODE_KEY);
    return stored === 'view' || stored === 'edit' ? stored : defaultEditMode();
  } catch {
    // A browser with storage denied still gets a working surface.
    return defaultEditMode();
  }
}

/** Remember the reader's choice. Only ever called from a toggle a browser
 *  that may write was allowed to press. */
export function writeEditModePref(mode: EditMode): void {
  try {
    localStorage.setItem(EDIT_MODE_KEY, mode);
  } catch {
    // Storage denied — the mode still applies for this page's life.
  }
}

/**
 * The mode a surface may mount in, given what the server already said.
 *
 * `canWrite` comes from the session answer `main()` awaits before the router
 * starts, carried to every mount on `MountContext`. False collapses the
 * preference to `view` WITHOUT clearing it: this browser may be signed in
 * again in a minute, and the preference is still what this person likes.
 */
export function initialEditMode(canWrite: boolean): EditMode {
  if (!canWrite) return 'view';
  return readEditModePref();
}
