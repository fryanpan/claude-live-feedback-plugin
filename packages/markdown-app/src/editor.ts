import { Editor } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  ySyncPluginKey,
} from 'y-prosemirror';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

/**
 * WYSIWYG markdown editor backed by Tiptap (ProseMirror) + Yjs collaboration.
 * Storage: content lives in a Y.XmlFragment named `prose`. On first load, if
 * that fragment is empty but the legacy Y.Text `content` has data, the
 * content is migrated into the prose fragment so docs created with the old
 * CodeMirror source editor keep their text.
 */

export interface EditorHandle {
  editor: Editor;
  getSelectionRel: () => { start: Uint8Array; end: Uint8Array; snippet: string } | null;
  resolveRel: (startRel: Uint8Array, endRel: Uint8Array) => { from: number; to: number } | null;
  scrollToPos: (pos: number) => void;
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
    ],
    onSelectionUpdate: () => opts.onSelectionChange?.(),
    onUpdate: () => opts.onUpdate?.(),
  });

  // Seed from legacy Y.Text or caller-provided markdown. Runs once per doc.
  queueMicrotask(() => {
    if (fragment.length !== 0) return;
    const seed = legacy.length > 0 ? legacy.toString() : (opts.seedMarkdown ?? '');
    if (!seed) return;
    editor.commands.setContent(seed, { emitUpdate: true });
    if (legacy.length > 0) {
      opts.ydoc.transact(() => legacy.delete(0, legacy.length));
    }
  });

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
