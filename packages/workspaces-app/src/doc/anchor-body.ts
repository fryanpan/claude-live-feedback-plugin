/**
 * The selection a review surface hands the chrome, and the wire anchor built
 * from it.
 *
 * A LEAF on purpose: it imports nothing from this package, so every module
 * that has to build an anchor — `app.ts`, the composer, the thread actions,
 * the redline surface — can reach it without reaching back into
 * `review-chrome.ts`. That is not tidiness; when `anchorBody` still lived in
 * the chrome, the two modules extracted out of it imported a VALUE back from
 * their own parent, which is a cycle a bundler is free to order either way.
 */

export interface ChromeSelection {
  start: Uint8Array;
  end: Uint8Array;
  snippet: string;
  /**
   * Set by the redline surface when the selection was entirely base-only
   * (struck-through) text, which has no position in `content`. The anchor
   * snaps to the nearest following retained line; this records what the
   * comment was actually about.
   */
  deletedSnippet?: string;
}

/**
 * Build the wire anchor for a selection.
 *
 * ONE place on purpose. Every anchor body here is hand-built field by field,
 * so a new field added to ChromeSelection but not copied is silently dropped —
 * the server accepts it, returns 200, and the data is gone. That is exactly
 * how `deletedSnippet` first shipped broken (and how `groups` did before it;
 * see docs/process/learnings.md). Add new anchor fields HERE, not at the call
 * sites.
 */
export function anchorBody(sel: ChromeSelection) {
  return {
    kind: 'text-range' as const,
    startRel: Array.from(sel.start),
    endRel: Array.from(sel.end),
    snippet: { text: sel.snippet },
    ...(sel.deletedSnippet ? { deletedSnippet: sel.deletedSnippet } : {}),
  };
}
