import type { EditorState } from '@codemirror/state';
import { anchors } from '@feedback/core';
import * as Y from 'yjs';

/**
 * Anchor helpers for the read-only code surface.
 *
 * The code surface seeds the CodeMirror document directly from the Yjs
 * `content` Y.Text (`content.toString()`), so CM character offsets are
 * BYTE-IDENTICAL to indices into the Y.Text. That lets us reuse the exact
 * same `text-range` anchor wire shape the markdown editor uses:
 * `Y.RelativePosition` encoded with `Y.encodeRelativePosition` and decoded
 * with `Y.decodeRelativePosition` — so anchors created on a code doc are
 * byte-compatible with the REST thread routes and the auto-reanchor stack.
 */

/** Build a serialized relative position for a CM offset into `content`. */
export function encodeOffsetRel(content: Y.Text, offset: number): Uint8Array {
  const clamped = Math.max(0, Math.min(offset, content.length));
  return Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(content, clamped));
}

/** Resolve a serialized relative position to an absolute CM offset. Returns
 *  null when the anchor no longer references a valid point in `content`. */
export function resolveRelOffset(ydoc: Y.Doc, encoded: Uint8Array): number | null {
  // An anchor written before the routes validated them can carry undecodable
  // bytes. Answer null (renders as unresolved) rather than throwing — an
  // exception here takes the whole surface down instead of one comment.
  const rel = anchors.decodeRelativePositionSafe(encoded);
  if (!rel) return null;
  const abs = Y.createAbsolutePositionFromRelativePosition(rel, ydoc);
  if (!abs) return null;
  return abs.index;
}

/**
 * Snap a `{from,to}` offset range to whole-line boundaries: extend `from`
 * back to the start of its line and `to` forward to the end of its line.
 * Code comments anchor to whole lines so the gutter marker and highlight
 * line up with the editor's line model. An empty selection snaps to the
 * single line the caret sits on.
 */
export function snapToLines(
  state: EditorState,
  from: number,
  to: number,
): { from: number; to: number } {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const startLine = state.doc.lineAt(lo);
  const endLine = state.doc.lineAt(hi);
  return { from: startLine.from, to: endLine.to };
}
