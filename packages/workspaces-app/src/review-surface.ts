/**
 * The slim editor abstraction the thread/comment flows in `app.ts` depend
 * on. Both the WYSIWYG markdown editor (Tiptap, `editor.ts`) and the
 * read-only code surface (CodeMirror, `code/code-editor.ts`) implement it,
 * so the create-thread / resolve / reveal / re-anchor paths work unchanged
 * regardless of which surface is mounted.
 *
 * The `EditorHandle` from `editor.ts` is a structural superset of this —
 * it adds Tiptap-specific members (`editor`, `getMarkdown`, …) used only
 * by the markdown boot path.
 */
export interface SurfaceThreadRange {
  id: string;
  from: number;
  to: number;
  status: 'open' | 'resolved';
}

/**
 * One thread's card, to be placed IN THE FLOW of the document/source under
 * the text it points at — the mobile comment surface (see mobile-review.ts).
 *
 * The `el` is a live node the caller owns and REUSES across refreshes: a
 * freshly built node mounts at its final height and cannot morph, so a
 * surface must place this exact element rather than cloning or re-deriving
 * it, and must leave it alone when it is handed the same node again.
 */
export interface InlineThreadCard {
  id: string;
  from: number;
  to: number;
  el: HTMLElement;
}

export interface ReviewSurface {
  /** Current selection as a serialized text-range anchor, or null when the
   *  selection is empty / unresolvable. Wire-compatible with the REST
   *  thread routes (`Y.encodeRelativePosition` bytes). */
  getSelectionRel: () => { start: Uint8Array; end: Uint8Array; snippet: string } | null;
  /** Resolve a serialized anchor to absolute editor positions, or null when
   *  the anchor no longer resolves (orphaned). */
  resolveRel: (startRel: Uint8Array, endRel: Uint8Array) => { from: number; to: number } | null;
  scrollToPos: (pos: number) => void;
  /** 1-based line number for an offset — line-oriented surfaces (code/diff)
   *  implement it so comments can display "L293"; prose surfaces omit it. */
  lineForPos?: (pos: number) => number | null;
  /** Brief highlight pulse on a range — used when revealing a thread. */
  pulseRange: (from: number, to: number) => void;
  /** Update which thread anchors are highlighted, and which is active. */
  setThreadRanges: (ranges: SurfaceThreadRange[], activeId: string | null) => void;
  /** Place comment cards inline, under the text they point at (mobile). Pass
   *  an empty array to clear them. Optional: a surface that cannot host
   *  in-flow DOM simply omits it and mobile falls back to the sheet alone. */
  setInlineCards?: (cards: InlineThreadCard[]) => void;
  destroy: () => void;
}
