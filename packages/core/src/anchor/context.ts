import type { AnchorContext } from '../types.ts';

/** Is any field of the context set? Used to decide whether to embed one in a new anchor. */
export function hasContext(c: AnchorContext | undefined | null): boolean {
  return !!(c && (c.url || c.view));
}

/**
 * Pin/highlight filter for anchored comments.
 *
 * Rules:
 *   - Anchor has no context (legacy comments from before context was
 *     added): show everywhere. Back-compat.
 *   - Anchor.url present: must equal current.url exactly. `location.pathname`
 *     is included alongside `search + hash`, so SPAs that carry meaningful
 *     state in the query string don't accidentally match each other.
 *   - Anchor.view present: must equal current.view. When the user's UI
 *     is in a different dynamic state, the pin stays hidden until the
 *     host app calls `setContext({ view: …})` back to the original.
 *
 * Off-context threads still appear in the sidebar — they're just not
 * overlaid on the page.
 */
export function contextMatches(
  anchor: AnchorContext | undefined | null,
  current: AnchorContext,
): boolean {
  if (!anchor) return true;
  if (anchor.url && anchor.url !== current.url) return false;
  if (anchor.view && anchor.view !== current.view) return false;
  return true;
}
