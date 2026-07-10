import { type Chunk, getChunks, getOriginalDoc, unifiedMergeView } from '@codemirror/merge';
import type { Extension, Text } from '@codemirror/state';
import { EditorView, GutterMarker, ViewPlugin, type ViewUpdate, gutter } from '@codemirror/view';

/**
 * PR-style extras layered onto @codemirror/merge's unified view:
 *  - an OLD-line-number gutter (base-commit numbering) next to the standard
 *    NEW-line-number gutter, GitHub style;
 *  - old line numbers stamped onto each deleted line inside the deletion
 *    widgets (they're widget DOM, not document lines, so no gutter reaches
 *    them — CSS renders the number from `data-old-line`).
 *
 * The editor document is the file at the TARGET commit; `original` is the
 * base text. Both are immutable here, so the chunk set is computed once.
 */

/**
 * Old-file line number for the line starting at `pos` in the new document,
 * or null when the line lies inside a changed chunk (an added/updated line
 * has no old number). Outside chunks the two texts are identical, so the
 * old position is the new position shifted by the accumulated size delta of
 * every chunk that ended earlier.
 */
export function oldLineForPos(
  chunks: readonly Chunk[],
  original: Text,
  pos: number,
): number | null {
  let delta = 0;
  for (const c of chunks) {
    if (pos >= c.fromB && pos < c.toB) return null;
    if (c.toB <= pos) {
      delta += c.toA - c.fromA - (c.toB - c.fromB);
      continue;
    }
    break;
  }
  const posA = pos + delta;
  if (posA < 0 || posA > original.length) return null;
  return original.lineAt(posA).number;
}

class OldLineMarker extends GutterMarker {
  constructor(readonly label: string) {
    super();
  }
  override eq(other: OldLineMarker): boolean {
    return other.label === this.label;
  }
  override toDOM(): Node {
    return document.createTextNode(this.label);
  }
}

export function oldLineNumberGutter(): Extension {
  return gutter({
    class: 'cm-old-line-gutter',
    lineMarker(view, line) {
      const info = getChunks(view.state);
      if (!info) return null;
      const n = oldLineForPos(info.chunks, getOriginalDoc(view.state), line.from);
      return new OldLineMarker(n == null ? '' : String(n));
    },
    lineMarkerChange: () => false,
  });
}

/**
 * Stamp `data-old-line` onto every `.cm-deletedLine` inside each deletion
 * widget. Widgets are matched to chunks by document position (widgets sit
 * at their chunk's `fromB`), not DOM order, because off-viewport widgets
 * aren't in the DOM.
 */
const numberDeletedLines = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      requestAnimationFrame(() => this.stamp(view));
    }
    update(u: ViewUpdate): void {
      if (u.docChanged || u.viewportChanged || u.geometryChanged) {
        requestAnimationFrame(() => this.stamp(u.view));
      }
    }
    stamp(view: EditorView): void {
      const info = getChunks(view.state);
      if (!info) return;
      const original = getOriginalDoc(view.state);
      const deleters = info.chunks.filter((c) => c.toA > c.fromA);
      for (const widget of view.dom.querySelectorAll('.cm-deletedChunk')) {
        let pos: number;
        try {
          pos = view.posAtDOM(widget as HTMLElement);
        } catch {
          continue;
        }
        const chunk = deleters.find((c) => Math.abs(c.fromB - pos) <= 1);
        if (!chunk) continue;
        let n = original.lineAt(Math.min(chunk.fromA, original.length)).number;
        for (const lineEl of widget.querySelectorAll('.cm-deletedLine')) {
          lineEl.setAttribute('data-old-line', String(n++));
        }
      }
    }
  },
);

export interface DiffViewConfig {
  /** The file's text at the base commit ('' for added files). */
  baseText: string;
  /** Collapse long unchanged stretches (diff mode). File mode passes false
   *  so the whole file shows, with added/changed lines still highlighted. */
  collapse?: boolean;
}

/**
 * The merge machinery for diff mode (swapped in/out by the view toggle).
 * Gutter ORDER is the caller's job: put `oldLineNumberGutter()` before
 * `lineNumbers()` in the same extension list so the base numbering renders
 * left of the target numbering, GitHub style.
 */
export function diffMergeExtensions(cfg: DiffViewConfig): Extension[] {
  return [
    unifiedMergeView({
      original: cfg.baseText,
      mergeControls: false,
      ...(cfg.collapse !== false ? { collapseUnchanged: { margin: 3, minSize: 6 } } : {}),
      diffConfig: { scanLimit: 2000 },
    }),
    numberDeletedLines,
  ];
}
