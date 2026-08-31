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
import { SPEAKER_TAG_SCHEME } from '@feedback/core';
import { docHref } from './doc-path.ts';

const UNSAFE_SCHEME = /^(?:javascript|data|vbscript):/i;

export function safeLinkHref(href: string | null | undefined): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // A speaker tag is a link in shape only: its href names the voice a note
  // came from (`speaker:B`), and there is nothing at the other end of it to
  // open. Refused here rather than left to `window.open`, which would answer
  // a Cmd+Click with a blank tab or a protocol prompt.
  if (trimmed.toLowerCase().startsWith(SPEAKER_TAG_SCHEME)) return null;
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

/**
 * Map a RELATIVE link inside a workspace-bound doc to the sibling doc's
 * in-SPA review URL, so "main doc links to secondary research doc" navigates
 * inside the app instead of 404ing on a raw relative URL.
 *
 * Member docIds are `${workspaceId}:${relPath.replaceAll('/', '~')}` (see
 * rooms.ts) — resolution is pure path math against the current doc's
 * repo-relative path. Returns null for anything that isn't an in-workspace
 * relative path (external URLs, absolute paths, anchor-only links, paths
 * escaping the workspace root, or paths containing the `~` separator, which
 * the encoding cannot represent) — callers fall back to window.open.
 */
export function resolveDocLink(opts: {
  href: string | null | undefined;
  /** The REVIEW this doc belongs to — member docIds are built from it. */
  reviewId: string | null | undefined;
  relPath: string | null | undefined;
  /** The WORKSPACE the sibling should be addressed under, when one is known.
   *  Passed in rather than read off `location` so this stays pure. */
  workspaceId?: string | null;
}): string | null {
  const { href, reviewId, relPath, workspaceId } = opts;
  if (!href || !reviewId || !relPath) return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Scheme-ful (`https:`, `mailto:`), protocol-relative, absolute, and
  // anchor-only links are not workspace-relative.
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  if (trimmed.startsWith('//') || trimmed.startsWith('/') || trimmed.startsWith('#')) return null;
  const pathPart = trimmed.split(/[?#]/, 1)[0];
  if (!pathPart) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    return null; // malformed %-escape
  }
  const segs = relPath.split('/').slice(0, -1);
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length === 0) return null; // would escape the workspace root
      segs.pop();
      continue;
    }
    if (seg.includes('~')) return null; // '~' is the docId path separator
    segs.push(seg);
  }
  if (segs.length === 0) return null;
  const memberDocId = `${reviewId}:${segs.join('~')}`;
  return docHref(memberDocId, workspaceId ?? null);
}
