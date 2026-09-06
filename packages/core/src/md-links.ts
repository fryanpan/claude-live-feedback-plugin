/**
 * Every workspace-resource link a markdown body carries — the read half of
 * "the links inside the doc ARE the linkage" (Bryan, 2026-08-31: docs depend
 * on the links already in their prose, not on a separate surface).
 *
 * Sibling of `ws-link.ts` and deliberately in core: the server's ref backfill
 * and settle-time scan classify with the SAME `parseWorkspaceLink` the client
 * renderer uses, so what reads as a workspace link in a comment is what
 * counts as one in the ref store.
 *
 * Plain-text extraction, not a markdown parse. Three spellings are read —
 * `[label](url)` inline links, bare absolute http(s) URLs, and bare
 * root-relative paths (`/workspaces/…`, which real task bodies carry in
 * prose) — because those are the shapes people and agents actually write.
 * A URL quoted in a code span counts too; over-collecting is safe here
 * because a ref is an annotation ("a dangling annotation is visible and
 * harmless" — `isValidRef`'s stance), and under-collecting silently loses a
 * tie the reader can see with their own eyes.
 */

import { type WorkspaceLink, parseWorkspaceLink } from './ws-link.ts';

export interface ExtractedLink {
  /** The URL exactly as written (markdown target, or the bare match). */
  url: string;
  link: WorkspaceLink;
}

// The markdown target: everything up to the first `)` or whitespace — a
// title suffix (`[x](url "title")`) is cut at the space, never swallowed.
const MD_LINK = /\[[^\]]*\]\(\s*([^)\s]+)[^)]*\)/g;
// Bare absolute URL. Trailing punctuation that commonly ENDS a sentence
// around a pasted URL is trimmed after the match.
const BARE_ABS = /https?:\/\/[^\s<>()[\]{}"']+/g;
// Bare root-relative path, only the shapes `parseWorkspaceLink` can read —
// an unanchored `/` would match every fraction and file path in the text.
const BARE_REL = /(?:^|[\s([])(\/workspaces\/[^\s<>()[\]{}"']+)/g;

const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

/**
 * Every workspace link in `markdown`, first-occurrence order, one entry per
 * distinct URL string. Non-workspace URLs are dropped here rather than
 * handed back — the caller's question is "what does this body tie to".
 */
export function extractWorkspaceLinks(markdown: string): ExtractedLink[] {
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  const consider = (raw: string): void => {
    const url = raw.replace(TRAILING_PUNCTUATION, '');
    if (!url || seen.has(url)) return;
    seen.add(url);
    const link = parseWorkspaceLink(url);
    if (link) out.push({ url, link });
  };
  for (const m of markdown.matchAll(MD_LINK)) consider(m[1] ?? '');
  for (const m of markdown.matchAll(BARE_ABS)) consider(m[0]);
  for (const m of markdown.matchAll(BARE_REL)) consider(m[1] ?? '');
  return out;
}
