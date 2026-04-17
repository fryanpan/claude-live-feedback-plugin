import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import {
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  StateEffect,
  StateField,
} from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import { yCollab } from 'y-codemirror.next';
import type { Awareness } from 'y-protocols/awareness';
import type * as Y from 'yjs';

export interface EditorHandle {
  view: EditorView;
  setActiveThread: (threadId: string | null) => void;
  setThreadRanges: (ranges: ThreadRange[]) => void;
  getSelectionOffsets: () => { start: number; end: number } | null;
  getText: () => string;
  scrollToOffset: (offset: number) => void;
}

export interface ThreadRange {
  threadId: string;
  start: number;
  end: number;
  status: 'open' | 'resolved';
}

const setRangesEffect = StateEffect.define<ThreadRange[]>();
const setActiveEffect = StateEffect.define<string | null>();

const rangesField = StateField.define<{ ranges: ThreadRange[]; active: string | null }>({
  create: () => ({ ranges: [], active: null }),
  update(value, tr) {
    let next = value;
    for (const e of tr.effects) {
      if (e.is(setRangesEffect)) next = { ...next, ranges: e.value };
      if (e.is(setActiveEffect)) next = { ...next, active: e.value };
    }
    return next;
  },
});

function buildDecorations(
  ranges: ThreadRange[],
  active: string | null,
  docLength: number,
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (const r of sorted) {
    if (r.start >= r.end) continue;
    const end = Math.min(r.end, docLength);
    const start = Math.max(0, Math.min(r.start, end));
    if (start === end) continue;
    const classes = [
      'cm-thread-anchor',
      r.status === 'resolved' ? 'resolved' : '',
      active === r.threadId ? 'active' : '',
    ]
      .filter(Boolean)
      .join(' ');
    builder.add(
      start,
      end,
      Decoration.mark({ class: classes, attributes: { 'data-thread-id': r.threadId } }),
    );
  }
  return builder.finish();
}

const threadHighlightPlugin = EditorView.decorations.compute([rangesField, 'doc'], (state) => {
  const { ranges, active } = state.field(rangesField);
  return buildDecorations(ranges, active, state.doc.length);
});

export function createEditor(opts: {
  parent: HTMLElement;
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: Awareness;
  onSelectionChange?: (start: number, end: number) => void;
}): EditorHandle {
  const state = EditorState.create({
    doc: opts.ytext.toString(),
    extensions: [
      lineNumbers(),
      highlightActiveLineGutter(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      yCollab(opts.ytext, opts.awareness),
      rangesField,
      threadHighlightPlugin,
      EditorView.lineWrapping,
      EditorView.updateListener.of((u) => {
        if (u.selectionSet) {
          const { main } = u.state.selection;
          opts.onSelectionChange?.(main.from, main.to);
        }
      }),
    ],
  });

  const view = new EditorView({ state, parent: opts.parent });

  return {
    view,
    setActiveThread(id) {
      view.dispatch({ effects: setActiveEffect.of(id) });
    },
    setThreadRanges(ranges) {
      view.dispatch({ effects: setRangesEffect.of(ranges) });
    },
    getSelectionOffsets() {
      const { main } = view.state.selection;
      if (main.empty) return null;
      return { start: main.from, end: main.to };
    },
    getText() {
      return view.state.doc.toString();
    },
    scrollToOffset(offset) {
      view.dispatch({
        selection: EditorSelection.cursor(offset),
        scrollIntoView: true,
      });
      view.focus();
    },
  };
}
