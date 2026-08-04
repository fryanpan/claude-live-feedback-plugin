/**
 * Shared schema for suggested edits (redlining Phase 2).
 *
 * A suggestion is stored as an ordinary ProseMirror/Yjs text mark — one of
 * two mark names, each carrying the same attribute shape. Marks travel with
 * the text through concurrent edits (that's the point of mark-based storage:
 * no RelativePositions to re-resolve), persist through `.ydoc` snapshots like
 * any other mark, and are invisible to disk because the markdown serializer
 * emits the ACCEPTED state (see prose.ts: `suggestInsert` text is omitted,
 * `suggestDelete` text is emitted without the mark).
 *
 * Attribute types are load-bearing (docs/process/learnings.md, the
 * heading-level bug): y-prosemirror passes Yjs attribute values to the editor
 * verbatim, so writers MUST store four strings and a numeric `ts` — never a
 * stringified number.
 */

/** Mark carried by proposed NEW text. Present in the live doc, excluded from
 *  serialization until accepted. */
export const SUGGEST_INSERT_MARK = 'suggestInsert';

/** Mark carried by text proposed FOR REMOVAL. The text stays in the doc and
 *  keeps serializing (it is still part of the accepted state) until the
 *  suggestion is accepted. */
export const SUGGEST_DELETE_MARK = 'suggestDelete';

/** Attributes on both suggestion marks. One `sid` groups the ranges of one
 *  proposal — a "replace" is a suggestDelete range plus an adjacent
 *  suggestInsert range sharing a sid. */
export interface SuggestionAttrs {
  /** Suggestion id — groups all ranges of one proposal. */
  sid: string;
  authorId: string;
  authorName: string;
  authorColor: string;
  /** Creation time, epoch ms. A NUMBER — see module doc. */
  ts: number;
}

/**
 * Read a suggestion mark's attribute value defensively. Returns null when the
 * value isn't a suggestion payload (no usable `sid`). Readers tolerate a
 * stringified `ts` from legacy/foreign writers, but writers must store a
 * number.
 */
export function readSuggestionAttrs(value: unknown): SuggestionAttrs | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.sid !== 'string' || v.sid.length === 0) return null;
  const str = (x: unknown): string => (typeof x === 'string' ? x : '');
  const ts = Number(v.ts);
  return {
    sid: v.sid,
    authorId: str(v.authorId),
    authorName: str(v.authorName),
    authorColor: str(v.authorColor),
    ts: Number.isFinite(ts) ? ts : 0,
  };
}
