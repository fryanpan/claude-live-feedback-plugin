/**
 * The lazily-loaded half of the composer editor: Tiptap, configured for a box
 * somebody types a comment into. Reached ONLY through the dynamic `import()`
 * in md-composer.ts, so the hub build splits it into its own chunk and the
 * board's entry stays a board. Import nothing from here statically.
 *
 * The extension list is the description editor's, minus what a composer has
 * no use for: no Collaboration (the words are private until they are posted,
 * so there is no room to join), no thread decorations or suggestion marks
 * (nobody comments on a comment being written), no tables or mermaid. What is
 * left is the part Bryan asked for — markdown, live, as you type.
 */
import { Editor } from '@tiptap/core';
import Placeholder from '@tiptap/extension-placeholder';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from 'tiptap-markdown';
import type {
  ComposerEditor,
  ComposerFocusOpts,
  ComposerSelection,
  CreateComposerEditorOpts,
} from './md-composer.ts';

export function createComposerEditor(opts: CreateComposerEditorOpts): ComposerEditor {
  const editor = new Editor({
    element: opts.parent,
    extensions: [
      StarterKit.configure({
        // Undo/redo is ON here, unlike the document surfaces — no Yjs history
        // plugin owns it in a composer, and a box with no undo is a box that
        // loses a paragraph to one stray Cmd+A.
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          autolink: true,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      Placeholder.configure({ placeholder: opts.placeholder }),
      Markdown.configure({
        html: false,
        tightLists: true,
        linkify: true,
        breaks: false,
        transformPastedText: true,
      }),
    ],
    onUpdate: () => opts.onUpdate(),
  });

  const clamp = (pos: number) => Math.max(0, Math.min(pos, editor.state.doc.content.size));

  return {
    getMarkdown() {
      type MarkdownStorage = { getMarkdown: () => string };
      const store = (editor.storage as unknown as { markdown?: MarkdownStorage }).markdown;
      return (
        store?.getMarkdown() ?? editor.state.doc.textBetween(0, editor.state.doc.content.size, '\n')
      );
    },
    setMarkdown(md: string) {
      // `emitUpdate: false` is load-bearing rather than an optimisation. A
      // seed that emitted would push the serializer's rendering of the words
      // back into `ta.value`, so a comment handed back after a refused post
      // would come back subtly rewritten instead of verbatim.
      editor.commands.setContent(md, { emitUpdate: false });
    },
    focus(sel: ComposerSelection | null, opts: ComposerFocusOpts = {}) {
      const scrollIntoView = opts.scroll !== false;
      if (sel) {
        editor.commands.setTextSelection({ from: clamp(sel.from), to: clamp(sel.to) });
        editor.commands.focus(undefined, { scrollIntoView });
      } else {
        editor.commands.focus('end', { scrollIntoView });
      }
    },
    selection() {
      const { from, to } = editor.state.selection;
      return { from, to };
    },
    isFocused: () => editor.isFocused,
    // `emitUpdate: false` for the same reason `setMarkdown` passes it:
    // Tiptap's default is to announce an update, and a composer that answered
    // "the words changed" because it was disabled mid-send would push the
    // editor's rendering of them back over the textarea a caller is about to
    // hand back verbatim.
    setEditable: (on: boolean) => editor.setEditable(on, false),
    destroy: () => editor.destroy(),
  };
}
