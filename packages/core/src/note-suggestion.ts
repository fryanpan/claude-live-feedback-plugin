/**
 * How a meeting note asks "did you mean this row?" — the wire between the
 * server that writes the question and the client that turns a tap on it into
 * a link.
 *
 * WHY IT IS A LINK AND NOT A NODE TYPE. The note-taker's suggestion has to
 * survive being a `.md` file on somebody's disk, being read in a browser with
 * no script running, and being edited by a person mid-meeting. A custom node
 * survives none of those; a markdown link survives all three. So the question
 * is written as ordinary markdown pointing at the row itself, with one query
 * parameter saying that it is a question rather than a citation. Nothing has
 * to understand the marker for the link to work — it resolves to the row
 * either way — and the client that does understand it can offer the tap.
 *
 * WHY BOTH HALVES LIVE HERE. The server spells the href and the label; the
 * client reads them back to build the real link. Two copies of that shape
 * would drift into a suggestion nobody can accept, and the failure would be
 * silent: a link that still opens the right row and never becomes a citation.
 * One definition, imported by both.
 */

/** The query parameter that marks a written link as a question. */
export const SUGGEST_PARAM = 'suggest';

/** Only ever used to parse a relative href; never reaches anything written. */
const PLACEHOLDER_ORIGIN = 'http://placeholder.invalid';

/**
 * Rewrite a href's query, keeping everything else about it.
 *
 * Both directions go through this rather than through string concatenation,
 * because concatenation puts the marker in the wrong place the moment a URL
 * carries a fragment: `…?task=t-wheel#activity` + `&suggest=1` hides the
 * marker INSIDE the hash, where the reader cannot see it and the suggestion
 * silently stops being one. An href whose shape `URL` cannot read is handed
 * back untouched — a link nobody can parse is not one to rewrite.
 */
function withQuery(url: string, edit: (params: URLSearchParams) => void): string {
  try {
    const u = new URL(url, PLACEHOLDER_ORIGIN);
    edit(u.searchParams);
    const query = u.searchParams.toString();
    const absolute = /^https?:\/\//i.test(url.trim());
    const path = `${u.pathname}${query ? `?${query}` : ''}${u.hash}`;
    return absolute ? `${u.origin}${path}` : path;
  } catch {
    return url;
  }
}

/** The row's own URL, marked as a question rather than a citation. */
export function suggestionHref(url: string): string {
  return withQuery(url, (params) => params.set(SUGGEST_PARAM, '1'));
}

/** Is this href a note's question rather than one of its citations? */
export function isSuggestionHref(url: string): boolean {
  try {
    return new URL(url, PLACEHOLDER_ORIGIN).searchParams.get(SUGGEST_PARAM) === '1';
  } catch {
    return false;
  }
}

/**
 * The same URL with the question mark taken off — what the link becomes once
 * somebody accepts it.
 *
 * A href that never carried the marker comes back byte-identical rather than
 * reformatted: accepting changes one thing, and a link the reader can compare
 * against the one they tapped is the whole reason the gesture needs no
 * confirm step.
 */
export function acceptedHref(url: string): string {
  try {
    if (!new URL(url, PLACEHOLDER_ORIGIN).searchParams.has(SUGGEST_PARAM)) return url;
  } catch {
    return url;
  }
  return withQuery(url, (params) => params.delete(SUGGEST_PARAM));
}

/** The words a suggestion is written as: a question, because it is one. */
export function suggestionLabel(title: string): string {
  return `related: ${title}?`;
}

/**
 * The row's title back out of a written suggestion, or `null` when the text
 * is not one.
 *
 * Read rather than re-fetched because the label already holds the title the
 * server saw, and an accepted link should read as the row was named when the
 * question was asked. A person who edited the words gets `null` and keeps
 * what they wrote — their sentence is not ours to replace.
 */
export function titleFromSuggestionLabel(text: string): string | null {
  const match = /^related:\s+(.+)\?$/.exec(text.trim());
  return match?.[1]?.trim() || null;
}
