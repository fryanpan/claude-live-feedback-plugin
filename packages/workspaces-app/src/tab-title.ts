/**
 * Browser tab titles: the specific name first, the product name last.
 *
 * A tab strip gives each title roughly twenty characters before it truncates,
 * and every surface here used to spend all twenty on the same leading word —
 * so a reader with a board, three review docs and a diff open saw one word
 * five times over and had to click to find out which tab was which. Leading
 * with the doc / workspace name puts the varying half where the reader can
 * see it and lets the product name be the part that gets cut.
 *
 * ` · ` rather than an em dash, because that is the separator the
 * server-rendered titles already use (`<project> · Workspaces`,
 * `Doc not found · Workspaces`) and two conventions would read as a bug.
 */

export const SITE_NAME = 'Workspaces';

const SEP = ' · ';

/**
 * Compose a tab title from `parts` in the order they should be read, with the
 * product name appended. Empty parts drop out, so a surface that has not
 * learned its name yet falls back to the product name alone rather than
 * leading with a stray separator.
 */
export function tabTitle(...parts: Array<string | null | undefined>): string {
  const named = parts.map((p) => (p ?? '').trim()).filter((p) => p.length > 0);
  return [...named, SITE_NAME].join(SEP);
}

/**
 * The tab-worthy part of a doc's label.
 *
 * A file-backed review doc labels itself with the full path on the host, which
 * is the one shape a tab handles worst: truncation eats from the right, so
 * `/Volumes/Data/Users/…` would fill the title and the filename — the only
 * part that differs between two open docs — would never appear. An absolute
 * path is therefore reduced to its basename. A repo-relative path is left
 * whole: `src/a.ts` and `test/a.ts` are two files in one diff review, and the
 * directory is what tells their tabs apart.
 */
export function tabName(label: string): string {
  let s = label.trim();
  if (!s) return '';
  try {
    if (/^https?:\/\//.test(s)) s = new URL(s).pathname;
  } catch {}
  if (!s.startsWith('/')) return s;
  const parts = s.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? s;
}

/** `tabTitle`, applied. Takes the document so a test can name its own. */
export function setTabTitle(doc: Document, ...parts: Array<string | null | undefined>): void {
  doc.title = tabTitle(...parts);
}
