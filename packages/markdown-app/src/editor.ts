import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
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
import { ThreadDecorations, type ThreadRange, setThreadDecorations } from './thread-decorations.ts';

/**
 * WYSIWYG markdown editor backed by Tiptap (ProseMirror) + Yjs collaboration.
 * Storage: content lives in a Y.XmlFragment named `prose`. On first load, if
 * that fragment is empty but the legacy Y.Text `content` has data, the
 * content is migrated into the prose fragment so docs created with the old
 * CodeMirror source editor keep their text.
 */

export interface EditorHandle {
  editor: Editor;
  /** Seed the fragment with markdown if it's empty and not already seeded.
   *  Call AFTER the initial Yjs sync (from client.onReady). */
  seedIfEmpty: (markdown: string) => void;
  /** Migrate legacy Y.Text 'content' into the fragment, once per doc. */
  migrateLegacyIfNeeded: () => void;
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
  const fragment = opts.ydoc.getXmlFragment(fragmentName);
  const legacy = opts.ydoc.getText('content');

  const editor = new Editor({
    element: opts.parent,
    extensions: [
      StarterKit.configure({
        undoRedo: false, // Yjs Collaboration plugin owns undo/redo
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
      Collaboration.configure({
        document: opts.ydoc,
        field: fragmentName,
      }),
      ThreadDecorations,
    ],
    onSelectionUpdate: () => opts.onSelectionChange?.(),
    onUpdate: () => opts.onUpdate?.(),
  });

  // NOTE: seeding is the caller's responsibility via `seedIfEmpty()` below.
  // Seeding before the initial Yjs sync completes would duplicate content
  // (local seed + server's content both land in the fragment).

  function syncState() {
    return ySyncPluginKey.getState(editor.state);
  }

  return {
    editor,
    seedIfEmpty(markdown: string): void {
      // Must be called AFTER initial Yjs sync. Guards against double-seed
      // across reloads / multi-client opens using a meta flag.
      const meta = opts.ydoc.getMap('meta');
      if (fragment.length > 0) return; // already has content
      if (meta.get('seeded')) return; // another client beat us to it
      opts.ydoc.transact(() => {
        meta.set('seeded', true);
        if (legacy.length > 0) legacy.delete(0, legacy.length);
      });
      editor.commands.setContent(markdown, { emitUpdate: true });
    },
    migrateLegacyIfNeeded(): void {
      // Legacy Y.Text content from the old CodeMirror editor → migrate
      // exactly once per doc (guarded by meta.seeded), after initial sync.
      const meta = opts.ydoc.getMap('meta');
      if (fragment.length > 0) return;
      if (meta.get('seeded')) return;
      if (legacy.length === 0) return;
      const text = legacy.toString();
      opts.ydoc.transact(() => {
        meta.set('seeded', true);
        legacy.delete(0, legacy.length);
      });
      editor.commands.setContent(text, { emitUpdate: true });
    },
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
      editor.destroy();
    },
  };
}
