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
  // Browsers ignore embedded whitespace/control chars (tabs, newlines, NUL)
  // when resolving a URL's scheme — so `java\tscript:` still executes. Drop
  // every char with code point <= 0x20 before matching the denylist so
  // obfuscated scheme prefixes can't slip past. The original (only trimmed)
  // href is what we return/open.
  let forSchemeCheck = '';
  for (const ch of trimmed) {
    if (ch.charCodeAt(0) > 0x20) forSchemeCheck += ch;
  }
  if (UNSAFE_SCHEME.test(forSchemeCheck)) return null;
  return trimmed;
}
