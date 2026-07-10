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
import { safeLinkHref } from './link-open.ts';
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

  // Links are non-navigable on a plain click (openOnClick:false) so the cursor
  // can be placed inside them to edit — but a Cmd/Ctrl+Click should open the
  // link in a new tab, matching the browser convention for opening links in a
  // read-only surface. Bound at the DOM level so it works in both edit and
  // view mode. Script-bearing schemes are filtered by safeLinkHref.
  const onLinkClick = (ev: MouseEvent) => {
    if (!(ev.metaKey || ev.ctrlKey)) return;
    const target = ev.target as HTMLElement | null;
    const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!anchor) return;
    const href = safeLinkHref(anchor.getAttribute('href'));
    if (!href) return;
    ev.preventDefault();
    ev.stopPropagation();
    window.open(href, '_blank', 'noopener,noreferrer');
  };
  editor.view.dom.addEventListener('click', onLinkClick);

  function syncState() {
    return ySyncPluginKey.getState(editor.state);
  }

  return {
    editor,
    getSelectionRel() {
      const { from, to, empty } = editor.state.selection;
      if (empty) return null;
      const sync = syncState();
      if (!sync?.binding) return null;
      const { mapping, type } = sync.binding;
      const startRel = absolutePositionToRelativePosition(from, type, mapping);
      const endRel = absolutePositionToRelativePosition(to, type, mapping);
      const snippet = editor.state.doc.textBetween(from, to, ' ').slice(0, 80);
      return {
        start: Y.encodeRelativePosition(startRel),
        end: Y.encodeRelativePosition(endRel),
        snippet,
      };
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
      editor.view.dom.removeEventListener('click', onLinkClick);
      editor.destroy();
    },
  };
}
