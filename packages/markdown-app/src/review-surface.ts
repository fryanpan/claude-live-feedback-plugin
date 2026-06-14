/**
 * The slim editor abstraction the thread/comment flows in `app.ts` depend
 * on. Both the WYSIWYG markdown editor (Tiptap, `editor.ts`) and the
 * read-only code surface (CodeMirror, `code/code-editor.ts`) implement it,
 * so the create-thread / resolve / reveal / re-anchor paths work unchanged
 * regardless of which surface is mounted.
 *
 * The `EditorHandle` from `editor.ts` is a structural superset of this —
 * it adds Tiptap-specific members (`editor`, `getMarkdown`, …) that the
 * markdown-only code paths in `app.ts` gate behind `type === 'markdown'`.
 */
export interface SurfaceThreadRange {
  id: string;
  from: number;
  to: number;
  status: 'open' | 'resolved';
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
  /** Brief highlight pulse on a range — used when revealing a thread. */
  pulseRange: (from: number, to: number) => void;
  /** Update which thread anchors are highlighted, and which is active. */
  setThreadRanges: (ranges: SurfaceThreadRange[], activeId: string | null) => void;
  destroy: () => void;
}
