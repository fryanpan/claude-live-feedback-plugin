/**
 * Pure decision for "open this link" behaviour. The editor keeps links
 * non-navigable on a plain click (so you can place the cursor to edit them);
 * a Cmd/Ctrl+Click opens them instead. This helper answers only the "what URL,
 * if any, is safe to open" half so it can be unit-tested without a DOM.
 *
 * Permissive by design — a review doc's own links (relative paths, anchors,
 * mailto/tel) should all open — EXCEPT script-bearing schemes, which must
 * never be handed to window.open.
 */
const UNSAFE_SCHEME = /^(?:javascript|data|vbscript):/i;

export function safeLinkHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  if (UNSAFE_SCHEME.test(trimmed)) return null;
  return trimmed;
}
