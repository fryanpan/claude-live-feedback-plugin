/**
 * Anchor validation, and the safe decode every reader of a stored anchor
 * needs.
 *
 * A `text-range` anchor's `startRel`/`endRel` are opaque encoded Yjs
 * RelativePositions. `Y.decodeRelativePosition` does not validate its input:
 * handed `undefined` it dies inside lib0 with `decoder.arr.length` undefined,
 * and handed arbitrary bytes it can throw anywhere in the varint reader.
 *
 * That matters far away from where the bad anchor was written. The re-anchor
 * sweep runs inside a debounced Yjs observer, so a throw there surfaces as an
 * unhandled async TypeError attributed to whatever request happens to be in
 * flight — a request that never touched the doc. A hand-written anchor posted
 * to `POST /api/docs/:id/threads` therefore used to be accepted, stored, and
 * then charged to somebody else.
 *
 * Two halves, and both are needed:
 *   - `validateAnchor` rejects the bad write at the call that made it, naming
 *     the field that is missing or undecodable.
 *   - `decodeRelativePositionSafe` makes every READER survive an anchor that
 *     is already persisted, because old docs carry ones written before the
 *     validation existed and a doc that cannot be swept is a doc that cannot
 *     be opened.
 */

import * as Y from 'yjs';

/**
 * Normalize the wire shapes `startRel`/`endRel` legitimately arrive in.
 *
 * The type says `Uint8Array`, but a Uint8Array nested in a plain object does
 * not survive Yjs's `encodeAny` (it JSON-stringifies to `{"0":2,…}`), so the
 * editor and `createThreadByFind` both send a `number[]` on purpose — see the
 * long note in `rooms.createThreadByFind`. Both are valid; anything else is
 * not, including the stringified-Uint8Array object shape, which is exactly
 * what a caller reconstructs when it round-trips an anchor through JSON
 * carelessly.
 *
 * Returns null rather than throwing — callers decide whether that's a 400 or
 * an orphan.
 */
export function toRelBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    for (const n of value) {
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 255) return null;
    }
    return Uint8Array.from(value as number[]);
  }
  return null;
}

/**
 * `Y.decodeRelativePosition` that answers null instead of throwing.
 *
 * Every server-side reader of a stored anchor goes through this. The failure
 * it absorbs is indistinguishable, at the call site, from "this position no
 * longer resolves" — which every caller already handles by falling back to
 * the snippet match. So a legacy malformed anchor doesn't merely stop
 * crashing: the sweep re-anchors it from its snippet and the doc repairs
 * itself.
 */
export function decodeRelativePositionSafe(value: unknown): Y.RelativePosition | null {
  const bytes = toRelBytes(value);
  if (!bytes) return null;
  try {
    return Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
}

export type AnchorValidation = { ok: true } | { ok: false; error: string };

/**
 * Gate for a caller-supplied anchor, at the routes that take one verbatim.
 *
 * Deliberately narrow: it fully validates `text-range`, the only kind whose
 * malformed shape can crash a reader, and otherwise only insists the anchor
 * is an object with a `kind`. Widening it to reject unknown kinds would be a
 * new way to break callers this bug never involved.
 *
 * The message names the offending field, because the entire point is that the
 * agent that wrote the anchor learns what is wrong with it at the call it
 * made.
 */
export function validateAnchor(anchor: unknown): AnchorValidation {
  if (!anchor || typeof anchor !== 'object' || Array.isArray(anchor)) {
    return { ok: false, error: 'anchor must be an object' };
  }
  const a = anchor as Record<string, unknown>;
  if (typeof a.kind !== 'string' || a.kind.length === 0) {
    return { ok: false, error: 'anchor.kind is required' };
  }
  if (a.kind !== 'text-range') return { ok: true };

  for (const field of ['startRel', 'endRel'] as const) {
    const raw = a[field];
    if (raw === undefined || raw === null) {
      return { ok: false, error: `anchor.${field} is required for a text-range anchor` };
    }
    if (!toRelBytes(raw)) {
      return {
        ok: false,
        error: `anchor.${field} must be encoded RelativePosition bytes (Uint8Array or number[])`,
      };
    }
    if (!decodeRelativePositionSafe(raw)) {
      return { ok: false, error: `anchor.${field} is not a decodable RelativePosition` };
    }
  }

  // The sweep reads `anchor.snippet.text` to re-anchor a broken position; a
  // missing snippet is the same class of deferred crash as a missing
  // startRel, one property deeper.
  const snippet = a.snippet as Record<string, unknown> | undefined;
  if (!snippet || typeof snippet !== 'object') {
    return { ok: false, error: 'anchor.snippet is required for a text-range anchor' };
  }
  if (typeof snippet.text !== 'string') {
    return { ok: false, error: 'anchor.snippet.text must be a string' };
  }
  return { ok: true };
}
