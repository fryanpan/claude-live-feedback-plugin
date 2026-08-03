import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { getContent } from '@feedback/core';
import { afterEach, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { type CreateCodeEditorOpts, createCodeEditor } from '../src/code/code-editor.ts';

/**
 * The File view of a working-tree diff member is a live collaborative editor:
 * CM edits flow into the `content` Y.Text (and from there to the working
 * tree via the server's flat write-back), remote Yjs changes flow into CM
 * incrementally, and the Diff view of the same surface stays read-only.
 */

const SRC = 'fun main() {\n    println("one")\n}\n';

const open: HTMLElement[] = [];
afterEach(() => {
  for (const p of open.splice(0)) p.remove();
});

function mount(opts: Partial<CreateCodeEditorOpts> = {}) {
  const ydoc = new Y.Doc();
  const content = getContent(ydoc);
  content.insert(0, SRC);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  open.push(parent);
  const surface = createCodeEditor({
    parent,
    ydoc,
    sourceUrl: 'Main.kt',
    ...opts,
  });
  const view = EditorView.findFromDOM(parent);
  if (!view) throw new Error('no EditorView mounted');
  return { ydoc, content, parent, surface, view };
}

describe('editable code surface', () => {
  it('local edits flow into the content Y.Text', () => {
    const { content, view } = mount({ editable: true });
    const pos = view.state.doc.toString().indexOf('one');
    view.dispatch({ changes: { from: pos, to: pos, insert: 'typed-' } });
    expect(content.toString()).toContain('typed-one');
  });

  it('remote Y.Text edits flow into the editor', () => {
    const { content, view } = mount({ editable: true });
    content.insert(SRC.indexOf('one'), 'remote-');
    expect(view.state.doc.toString()).toContain('remote-one');
  });

  it('file mode is writable, diff mode on the same surface is not', () => {
    const { surface, view, parent } = mount({
      editable: true,
      diff: { baseText: SRC.replace('one', 'zero') },
      initialViewMode: 'file',
    });
    const v = () => EditorView.findFromDOM(parent) ?? view;
    expect(v().state.facet(EditorState.readOnly)).toBe(false);
    surface.setViewMode('diff');
    expect(v().state.facet(EditorState.readOnly)).toBe(true);
    surface.setViewMode('file');
    expect(v().state.facet(EditorState.readOnly)).toBe(false);
  });

  it('a non-editable surface stays read-only in file mode', () => {
    const { view } = mount({});
    expect(view.state.facet(EditorState.readOnly)).toBe(true);
  });

  it('non-editable surfaces still mirror remote content', () => {
    const { content, view } = mount({});
    content.insert(0, '// agent save\n');
    expect(view.state.doc.toString()).toContain('// agent save');
  });
});
