import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import {
  Compartment,
  EditorState,
  type Extension,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  GutterMarker,
  gutter,
  lineNumbers,
} from '@codemirror/view';
import { getContent } from '@feedback/core';
import * as Y from 'yjs';
import type { ReviewSurface, SurfaceThreadRange } from '../review-surface.ts';
import { encodeOffsetRel, resolveRelOffset, snapToLines } from './code-anchor.ts';
import {
  type DiffViewConfig,
  diffMergeExtensions,
  oldLineNumberGutter,
} from './diff-extensions.ts';
import { languageExtensionFor } from './languages.ts';

export type CodeViewMode = 'diff' | 'file';

export interface CreateCodeEditorOpts {
  parent: HTMLElement;
  ydoc: Y.Doc;
  sourceUrl: string;
  onSelectionChange?: () => void;
  /** Click handler for a gutter comment marker (the thread's id). */
  onMarkerClick?: (threadId: string) => void;
  /** When set, the surface starts in unified-diff mode against this base
   *  text; `setViewMode` toggles diff ↔ whole-file. Anchors are offsets into
   *  the same (target) document in both modes, so threads are unaffected. */
  diff?: DiffViewConfig;
}

/** A ReviewSurface that can also swap between diff and whole-file rendering. */
export interface CodeSurface extends ReviewSurface {
  setViewMode: (mode: CodeViewMode) => void;
  getViewMode: () => CodeViewMode;
}

// --- gutter comment markers --------------------------------------------------
// Driven by a StateField of resolved thread ranges. Each open thread gets a
// dot on its START line; the active thread's dot is highlighted.
interface MarkerLine {
  id: string;
  from: number;
  active: boolean;
}

const setMarkersEffect = StateEffect.define<MarkerLine[]>();

class CommentDotMarker extends GutterMarker {
  constructor(
    readonly id: string,
    readonly active: boolean,
  ) {
    super();
  }
  override eq(other: CommentDotMarker): boolean {
    return other.id === this.id && other.active === this.active;
  }
  override toDOM(): Node {
    const el = document.createElement('span');
    el.className = `cm-comment-dot${this.active ? ' active' : ''}`;
    el.setAttribute('data-thread-id', this.id);
    el.textContent = '●';
    return el;
  }
}

const markerField = StateField.define<RangeSet<GutterMarker>>({
  create() {
    return RangeSet.empty;
  },
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setMarkersEffect)) {
        const docLen = tr.state.doc.length;
        // One marker per thread start line, sorted by `from` (RangeSet
        // requires ascending order). Snap each `from` to its line start so
        // the dot lands on the gutter row.
        const lines = e.value
          .map((m) => {
            const pos = Math.max(0, Math.min(m.from, docLen));
            return { ...m, lineFrom: tr.state.doc.lineAt(pos).from };
          })
          .sort((a, b) => a.lineFrom - b.lineFrom);
        const builder = new RangeSetBuilder<GutterMarker>();
        for (const m of lines) {
          builder.add(m.lineFrom, m.lineFrom, new CommentDotMarker(m.id, m.active));
        }
        next = builder.finish();
      }
    }
    return next;
  },
});

// --- transient pulse line decoration ----------------------------------------
const setPulseEffect = StateEffect.define<{ from: number; to: number } | null>();
const pulseLineDeco = Decoration.line({ class: 'cm-pulse-line' });

const pulseField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(value, tr) {
    let next = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setPulseEffect)) {
        if (e.value == null) {
          next = Decoration.none;
        } else {
          const docLen = tr.state.doc.length;
          const from = Math.max(0, Math.min(e.value.from, docLen));
          const to = Math.max(0, Math.min(e.value.to, docLen));
          const builder = new RangeSetBuilder<Decoration>();
          const startLine = tr.state.doc.lineAt(from).number;
          const endLine = tr.state.doc.lineAt(to).number;
          for (let n = startLine; n <= endLine; n++) {
            const line = tr.state.doc.line(n);
            builder.add(line.from, line.from, pulseLineDeco);
          }
          next = builder.finish();
        }
      }
    }
    return next;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/**
 * A read-only, syntax-highlighted CodeMirror review surface for `type='code'`
 * docs. One-way bound to the Yjs `content` Y.Text: the CM document is seeded
 * from `content.toString()` and re-rendered on every `content` change (so
 * agent edits to the source file re-render the view). The browser never
 * edits — comments anchor to whole lines via the same `text-range` /
 * `Y.RelativePosition` wire shape the markdown editor uses.
 */
export function createCodeEditor(opts: CreateCodeEditorOpts): CodeSurface {
  const content = getContent(opts.ydoc);

  // Diff docs boot in diff mode; the toggle reconfigures this compartment.
  // The old-line gutter must precede lineNumbers() so base numbering renders
  // to the LEFT of target numbering (GitHub column order).
  const viewModeComp = new Compartment();
  let viewMode: CodeViewMode = opts.diff ? 'diff' : 'file';
  const modeExtensions = (mode: CodeViewMode): Extension[] =>
    mode === 'diff' && opts.diff
      ? [oldLineNumberGutter(), lineNumbers(), ...diffMergeExtensions(opts.diff)]
      : [lineNumbers()];

  const langExt = languageExtensionFor(opts.sourceUrl);
  const extensions: Extension[] = [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    viewModeComp.of(modeExtensions(viewMode)),
    syntaxHighlighting(defaultHighlightStyle),
    markerField,
    pulseField,
    gutter({
      class: 'cm-comment-gutter',
      markers: (view) => view.state.field(markerField),
      domEventHandlers: {
        mousedown: (_view, line, event) => {
          const target = event.target as HTMLElement | null;
          const dot = target?.closest('.cm-comment-dot') as HTMLElement | null;
          const id = dot?.getAttribute('data-thread-id');
          if (id) {
            opts.onMarkerClick?.(id);
            return true;
          }
          void line;
          return false;
        },
      },
    }),
    EditorView.updateListener.of((update) => {
      if (update.selectionSet) opts.onSelectionChange?.();
    }),
  ];
  if (langExt) extensions.push(langExt);

  const view = new EditorView({
    parent: opts.parent,
    doc: content.toString(),
    extensions,
  });

  // One-way bind: when the agent edits the source file, the server applies
  // it to `content`; mirror it into the CM doc by replacing the whole text.
  const onContentChange = () => {
    const text = content.toString();
    if (text === view.state.doc.toString()) return;
    const wasEmpty = view.state.doc.length === 0;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    // The merge machinery computes chunks incrementally, but its
    // collapse-unchanged ranges are built ONLY at field init — and at mount
    // time the doc is usually still empty (Yjs hasn't synced yet), so
    // nothing would ever collapse. Re-init the compartment once the real
    // content lands. Only on the empty→content transition: later live
    // edits (working-tree reviews re-render as the agent saves) flow
    // through the incremental chunk update, and a re-init there would
    // throw away the reviewer's expanded/collapsed regions.
    if (wasEmpty && viewMode === 'diff' && opts.diff) {
      view.dispatch({ effects: viewModeComp.reconfigure(modeExtensions('diff')) });
    }
  };
  content.observe(onContentChange);

  return {
    getSelectionRel() {
      const sel = view.state.selection.main;
      const { from, to } = snapToLines(view.state, sel.from, sel.to);
      if (from === to) return null;
      const snippet = view.state.doc.sliceString(from, to).slice(0, 120);
      return {
        start: encodeOffsetRel(content, from),
        end: encodeOffsetRel(content, to),
        snippet,
      };
    },
    resolveRel(startRel, endRel) {
      const a = resolveRelOffset(opts.ydoc, startRel);
      const b = resolveRelOffset(opts.ydoc, endRel);
      if (a == null || b == null) return null;
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      if (from === to) return null;
      return { from, to };
    },
    scrollToPos(pos) {
      const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
      view.dispatch({ effects: EditorView.scrollIntoView(clamped, { y: 'center' }) });
    },
    pulseRange(from, to) {
      view.dispatch({ effects: setPulseEffect.of({ from, to }) });
      setTimeout(() => view.dispatch({ effects: setPulseEffect.of(null) }), 1200);
    },
    setThreadRanges(ranges: SurfaceThreadRange[], activeId) {
      const markers: MarkerLine[] = ranges
        .filter((r) => r.status !== 'resolved')
        .map((r) => ({ id: r.id, from: r.from, active: r.id === activeId }));
      view.dispatch({ effects: setMarkersEffect.of(markers) });
    },
    setViewMode(mode: CodeViewMode) {
      if (mode === viewMode) return;
      viewMode = mode;
      view.dispatch({ effects: viewModeComp.reconfigure(modeExtensions(mode)) });
    },
    getViewMode() {
      return viewMode;
    },
    destroy() {
      content.unobserve(onContentChange);
      view.destroy();
    },
  };
}
