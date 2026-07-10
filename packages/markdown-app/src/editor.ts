import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import { Image } from '@tiptap/extension-image';
import { Table } from '@tiptap/extension-table';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TableRow } from '@tiptap/extension-table-row';
import StarterKit from '@tiptap/starter-kit';
// IMPORTANT: these must come from @tiptap/y-tiptap, not y-prosemirror.
// Tiptap's Collaboration extension registers the sync plugin under its own
// PluginKey instance re-exported from @tiptap/y-tiptap; importing from
// y-prosemirror gets a *different* key and `getState()` always returns
// undefined — which was the real cause of "no selection" errors.
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from '@tiptap/y-tiptap';
import { Markdown } from 'tiptap-markdown';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { MermaidCodeBlock } from './mermaid-code-block.ts';
import { ThreadDecorations, type ThreadRange, setThreadDecorations } from './thread-decorations.ts';

/**
 * WYSIWYG markdown editor backed by Tiptap (ProseMirror) + Yjs collaboration.
 * Storage: content lives in a Y.XmlFragment named `prose`. (The pre-Tiptap
 * `content` Y.Text migration was removed 2026-07 after a scan showed no
 * persisted doc still needed it; `content` is now the CODE/DIFF surface.)
 */

export interface EditorHandle {
  editor: Editor;
  getSelectionRel: () => { start: Uint8Array; end: Uint8Array; snippet: string } | null;
  resolveRel: (startRel: Uint8Array, endRel: Uint8Array) => { from: number; to: number } | null;
  scrollToPos: (pos: number) => void;
  /** Brief highlight pulse on a text range — used when clicking a thread in the panel. */
  pulseRange: (from: number, to: number) => void;
  /** Update which thread anchors should be highlighted in the editor. */
  setThreadRanges: (ranges: ThreadRange[], activeId: string | null) => void;
  getText: () => string;
  setMarkdown: (md: string) => void;
  getMarkdown: () => string;
  destroy: () => void;
}

export interface CreateEditorOpts {
  parent: HTMLElement;
  ydoc: Y.Doc;
  awareness: Awareness;
  fragmentName?: string;
  onSelectionChange?: () => void;
  onUpdate?: () => void;
  user?: { name: string; color: string };
  seedMarkdown?: string;
}

export function createEditor(opts: CreateEditorOpts): EditorHandle {
  // Intentionally unused for now — y-prosemirror awareness cursors are a
  // follow-up once the Tiptap 3 cursor extension lands upstream.
  void opts.awareness;
  void opts.user;

  const fragmentName = opts.fragmentName ?? 'prose';

  const editor = new Editor({
    element: opts.parent,
    extensions: [
      StarterKit.configure({
        undoRedo: false, // Yjs Collaboration plugin owns undo/redo
        codeBlock: false, // replaced by MermaidCodeBlock below
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      MermaidCodeBlock,
      // Block-level images. The server-side markdown round-trip (packages/core
      // prose.ts) emits/consumes `image` nodes for `![alt](src)` lines; without
      // this extension the schema has no `image` node and sync would drop them.
      // Works for remote URLs and relative/local paths alike.
      Image.configure({ inline: false, allowBase64: false }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
      // GFM tables. resizable:false keeps the column widths inferred
      // from content — no drag handles competing with the comment pill.
      Table.configure({ resizable: false, HTMLAttributes: { class: 'prose-table' } }),
      TableRow,
      TableHeader,
      TableCell,
      Collaboration.configure({
        document: opts.ydoc,
        field: fragmentName,
      }),
      ThreadDecorations,
    ],
    onSelectionUpdate: () => opts.onSelectionChange?.(),
    onUpdate: () => opts.onUpdate?.(),
  });

  // Content arrives via Yjs sync from the server (which loaded it from the
  // bound .md file). The editor never seeds locally — that would race the
  // server's authoritative content.

  function syncState() {
    return ySyncPluginKey.getState(editor.state);
  }

  return {
    editor,
    getSelectionRel() {
      const sync = syncState();
      if (!sync?.binding) return null;
      const { mapping, type } = sync.binding;
      const toRel = (from: number, to: number) => {
        const startRel = absolutePositionToRelativePosition(from, type, mapping);
        const endRel = absolutePositionToRelativePosition(to, type, mapping);
        const snippet = editor.state.doc.textBetween(from, to, ' ').slice(0, 80);
        return {
          start: Y.encodeRelativePosition(startRel),
          end: Y.encodeRelativePosition(endRel),
          snippet,
        };
      };
      // 1) ProseMirror's own selection — authoritative in edit mode.
      const { from, to, empty } = editor.state.selection;
      if (!empty) return toRel(from, to);
      // 2) Fall back to the raw DOM selection. In VIEW mode (contenteditable
      //    =false) a long-press text selection — notably on iOS Safari —
      //    never propagates into ProseMirror's selection state, so the PM
      //    selection reads empty even though the user has visibly selected
      //    text. Map the DOM range back to document positions via posAtDOM so
      //    commenting works without making the doc editable.
      const dom = window.getSelection();
      if (!dom || dom.rangeCount === 0 || dom.isCollapsed) return null;
      const range = dom.getRangeAt(0);
      const view = editor.view;
      if (!view.dom.contains(range.startContainer) || !view.dom.contains(range.endContainer)) {
        return null;
      }
      let a: number;
      let b: number;
      try {
        a = view.posAtDOM(range.startContainer, range.startOffset);
        b = view.posAtDOM(range.endContainer, range.endOffset);
      } catch {
        return null;
      }
      if (a < 0 || b < 0 || a === b) return null;
      return toRel(Math.min(a, b), Math.max(a, b));
    },
    resolveRel(startRel, endRel) {
      const sync = syncState();
      if (!sync?.binding) return null;
      const { mapping, type } = sync.binding;
      const startAbs = relativePositionToAbsolutePosition(
        opts.ydoc,
        type,
        Y.decodeRelativePosition(startRel),
        mapping,
      );
      const endAbs = relativePositionToAbsolutePosition(
        opts.ydoc,
        type,
        Y.decodeRelativePosition(endRel),
        mapping,
      );
      if (startAbs == null || endAbs == null) return null;
      const from = Math.min(startAbs, endAbs);
      const to = Math.max(startAbs, endAbs);
      if (from === to) return null;
      return { from, to };
    },
    scrollToPos(pos) {
      const clamped = Math.max(0, Math.min(pos, editor.state.doc.content.size));
      editor.commands.setTextSelection(clamped);
      editor.commands.scrollIntoView();
      editor.commands.focus();
    },
    pulseRange(from, to) {
      // Pulse the range by emitting a pulseId meta; the extension adds a
      // transient .pulse class. We pass a synthetic id (from-to) so repeated
      // clicks on the same thread retrigger the animation.
      const pulseId = `pulse-${from}-${to}-${Date.now()}`;
      setThreadDecorations(editor.view, { pulseId });
      setTimeout(() => setThreadDecorations(editor.view, { pulseId: null }), 1200);
    },
    setThreadRanges(ranges, activeId) {
      setThreadDecorations(editor.view, { ranges, activeId });
    },
    getText() {
      return editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n');
    },
    setMarkdown(md) {
      editor.commands.setContent(md, { emitUpdate: true });
    },
    getMarkdown() {
      type MarkdownStorage = { getMarkdown: () => string };
      const store = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown;
      return store?.getMarkdown() ?? this.getText();
    },
    destroy() {
      editor.destroy();
    },
  };
}
