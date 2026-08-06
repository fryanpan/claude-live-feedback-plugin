import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { describe, expect, it } from 'vitest';
import {
  ThreadDecorations,
  setThreadDecorations,
  threadDecorationsKey,
} from '../src/thread-decorations.ts';

function mount(content: string): Editor {
  const editor = new Editor({
    extensions: [StarterKit.configure({ undoRedo: false }), ThreadDecorations],
    content,
  });
  return editor;
}

/** The text a thread's highlight currently covers. */
function highlighted(editor: Editor, id: string): string {
  const state = threadDecorationsKey.getState(editor.state);
  // Decoration.inline puts the DOM attrs on `type.attrs`, not on `spec`.
  const found = state?.deco
    .find()
    .find(
      (d) =>
        (d as unknown as { type?: { attrs?: Record<string, string> } }).type?.attrs?.[
          'data-thread-id'
        ] === id,
    );
  if (!found) return '';
  return editor.state.doc.textBetween(found.from, found.to);
}

describe('thread highlights track edits', () => {
  // "Hello brave world" — highlight "brave".
  const CONTENT = '<p>Hello brave world</p>';
  const FROM = 7; // start of "brave" (doc pos 1 = start of paragraph text)
  const TO = 12;

  function withHighlight() {
    const editor = mount(CONTENT);
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: FROM, to: TO, status: 'open' }],
    });
    expect(highlighted(editor, 't1')).toBe('brave');
    return editor;
  }

  it('stays on its words when text is typed BEFORE it', () => {
    const editor = withHighlight();
    // This is the reported bug: every character typed ahead of a comment
    // pushed its highlight further out of alignment.
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('does not drift as more is typed', () => {
    const editor = withHighlight();
    for (const word of ['aaa ', 'bbbb ', 'cc ']) {
      editor.chain().focus().insertContentAt(1, word).run();
    }
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('follows a deletion before it', () => {
    const editor = withHighlight();
    editor.chain().focus().deleteRange({ from: 1, to: 7 }).run(); // drop "Hello "
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('grows when text is typed INSIDE it', () => {
    const editor = withHighlight();
    editor.chain().focus().insertContentAt(9, 'aa').run(); // br|aa|ave
    expect(highlighted(editor, 't1')).toBe('braaave');
    editor.destroy();
  });

  it('does not swallow text typed at either edge', () => {
    const editor = withHighlight();
    editor.chain().focus().insertContentAt(TO, 'XX').run(); // after "brave"
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('is unaffected by edits after it', () => {
    const editor = withHighlight();
    editor
      .chain()
      .focus()
      .insertContentAt(editor.state.doc.content.size - 1, ' indeed')
      .run();
    expect(highlighted(editor, 't1')).toBe('brave');
    editor.destroy();
  });

  it('still accepts a fresh set of ranges', () => {
    const editor = withHighlight();
    editor.chain().focus().insertContentAt(1, 'Oh! ').run();
    setThreadDecorations(editor.view, {
      ranges: [{ id: 't1', from: 1, to: 4, status: 'open' }],
    });
    expect(highlighted(editor, 't1')).toBe('Oh!');
    editor.destroy();
  });
});
