import { prose } from '@feedback/core';
import type { EditorView } from '@tiptap/pm/view';
import { afterEach, describe, expect, it } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { type EditorHandle, createEditor } from '../src/editor.ts';

/**
 * Bullet-list ergonomics (list-behavior.ts, meeting-notes UX plan AC 3):
 * Tab indents a first/sole list item, Shift-Tab lifts it back without
 * stranding the empty host bullet, and adjacent same-type sibling lists
 * auto-join so a split-then-delete numbered list renumbers sequentially.
 * Tests run through the REAL createEditor (full app extension list over a
 * Y.Doc), same as suggest-input.test.ts: verify at the layer it lives in.
 */

const open: Array<{ handle: EditorHandle; parent: HTMLElement }> = [];
afterEach(() => {
  for (const o of open.splice(0)) {
    o.handle.destroy();
    o.parent.remove();
  }
});

function mountEditor(md: string) {
  const ydoc = new Y.Doc();
  const fragment = prose.getProseFragment(ydoc);
  if (md !== '') fragment.push(prose.parseMarkdownBlocks(md));
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = createEditor({ parent, ydoc, awareness: new Awareness(ydoc) });
  open.push({ handle, parent });
  return { ydoc, fragment, handle, view: handle.editor.view as EditorView };
}

/** Simulate a keydown through the view's prop chain (our keymap first). */
function press(view: EditorView, key: string, init: KeyboardEventInit = {}): boolean {
  return (
    view.someProp('handleKeyDown', (f) =>
      f(view, new KeyboardEvent('keydown', { key, ...init })),
    ) ?? false
  );
}

/** Top-level node type names, e.g. ['orderedList', 'paragraph']. */
function topKinds(handle: EditorHandle): string[] {
  const kinds: string[] = [];
  handle.editor.state.doc.forEach((n) => kinds.push(n.type.name));
  return kinds;
}

describe('Tab on a sole list item', () => {
  it('indents it: the item nests one level deeper inside a same-type list', () => {
    const { handle, view } = mountEditor('- alpha\n');
    handle.editor.commands.setTextSelection(3); // inside 'alpha'
    expect(press(view, 'Tab')).toBe(true);

    const doc = handle.editor.state.doc;
    // (StarterKit's TrailingNode keeps an empty paragraph after a final list.)
    expect(topKinds(handle)).toEqual(['bulletList', 'paragraph']);
    const outer = doc.child(0);
    expect(outer.childCount).toBe(1);
    const host = outer.child(0);
    expect(host.type.name).toBe('listItem');
    // Schema forces the host item to open with a paragraph; it stays empty.
    expect(host.childCount).toBe(2);
    expect(host.child(0).type.name).toBe('paragraph');
    expect(host.child(0).content.size).toBe(0);
    const inner = host.child(1);
    expect(inner.type.name).toBe('bulletList');
    expect(inner.childCount).toBe(1);
    expect(inner.child(0).textContent).toBe('alpha');
    // The caret stays in the moved text (every position shifts by +4).
    expect(view.state.selection.from).toBe(7);
  });

  it('works for an ordered list too, nesting into a nested orderedList', () => {
    const { handle, view } = mountEditor('1. alpha\n');
    handle.editor.commands.setTextSelection(3);
    expect(press(view, 'Tab')).toBe(true);
    const host = handle.editor.state.doc.child(0).child(0);
    expect(host.child(1).type.name).toBe('orderedList');
    expect(host.child(1).child(0).textContent).toBe('alpha');
  });

  it('Shift-Tab lifts it back out — the empty host bullet does not survive', () => {
    const { fragment, handle, view } = mountEditor('- alpha\n');
    handle.editor.commands.setTextSelection(3);
    press(view, 'Tab');
    expect(press(view, 'Tab', { shiftKey: true })).toBe(true);

    const doc = handle.editor.state.doc;
    expect(topKinds(handle)).toEqual(['bulletList', 'paragraph']);
    expect(doc.child(0).childCount).toBe(1);
    expect(doc.child(0).child(0).childCount).toBe(1); // just the paragraph
    expect(doc.child(0).child(0).textContent).toBe('alpha');
    expect(view.state.selection.from).toBe(3);
    // Round-trip is exact on disk as well.
    expect(prose.serializeFragmentToMarkdown(fragment)).toBe('- alpha\n');
  });

  it('does nothing outside a list (falls through)', () => {
    const { handle, view } = mountEditor('Just a paragraph.\n');
    handle.editor.commands.setTextSelection(3);
    expect(press(view, 'Tab')).toBe(false);
    expect(topKinds(handle)).toEqual(['paragraph']);
  });

  it('still sinks normally when a preceding sibling exists', () => {
    const { handle, view } = mountEditor('- alpha\n- beta\n');
    handle.editor.commands.setTextSelection(12); // inside 'beta'
    expect(press(view, 'Tab')).toBe(true);
    const list = handle.editor.state.doc.child(0);
    expect(list.childCount).toBe(1); // beta sank under alpha
    const alpha = list.child(0);
    expect(alpha.child(0).textContent).toBe('alpha');
    expect(alpha.child(1).type.name).toBe('bulletList');
    expect(alpha.child(1).child(0).textContent).toBe('beta');
  });
});

describe('Adjacent same-type lists auto-join', () => {
  it('Enter-split an ordered list then Backspace the empty item → ONE sequential orderedList', () => {
    const { fragment, handle, view } = mountEditor('1. one\n2. two\n');
    handle.editor.commands.setTextSelection(6); // end of 'one'
    press(view, 'Enter'); // new empty item between one and two
    press(view, 'Enter'); // empty item lifts out → paragraph splits the list
    expect(topKinds(handle).slice(0, 3)).toEqual(['orderedList', 'paragraph', 'orderedList']);
    press(view, 'Backspace'); // delete the empty paragraph → lists become adjacent → join

    expect(topKinds(handle)[0]).toBe('orderedList');
    expect(topKinds(handle).filter((k) => k === 'orderedList')).toHaveLength(1);
    const list = handle.editor.state.doc.child(0);
    expect(list.childCount).toBe(2);
    expect(list.attrs.start ?? 1).toBe(1);
    expect(prose.serializeFragmentToMarkdown(fragment).trimEnd()).toBe('1. one\n2. two');
  });

  it('joins nested sibling lists of the same type', () => {
    const { handle, view } = mountEditor('- top\n  - a\n');
    // Plant a second bulletList right after the nested one, inside the item.
    const { state } = view;
    let innerPos = -1;
    state.doc.descendants((node, pos) => {
      if (pos > 0 && node.type.name === 'bulletList') innerPos = pos;
      return true;
    });
    expect(innerPos).toBeGreaterThan(0);
    const inner = state.doc.nodeAt(innerPos);
    if (!inner) throw new Error('nested list not found');
    const { bulletList, listItem, paragraph } = state.schema.nodes;
    const second = bulletList.create(
      null,
      listItem.create(null, paragraph.create(null, state.schema.text('b'))),
    );
    view.dispatch(state.tr.insert(innerPos + inner.nodeSize, second));

    const top = handle.editor.state.doc.child(0).child(0);
    const nested = top.child(1);
    expect(nested.type.name).toBe('bulletList');
    expect(nested.childCount).toBe(2); // a + b in ONE list
    expect(nested.child(0).textContent).toBe('a');
    expect(nested.child(1).textContent).toBe('b');
  });

  it('leaves different-type neighbours (ul next to ol) alone', () => {
    const { handle, view } = mountEditor('- alpha\n');
    const { state } = view;
    const { orderedList, listItem, paragraph } = state.schema.nodes;
    const ol = orderedList.create(
      null,
      listItem.create(null, paragraph.create(null, state.schema.text('one'))),
    );
    // Insert DIRECTLY after the bulletList (before the trailing paragraph)
    // so the two lists are true siblings — which must NOT join.
    view.dispatch(state.tr.insert(state.doc.child(0).nodeSize, ol));
    expect(topKinds(handle).slice(0, 2)).toEqual(['bulletList', 'orderedList']);
  });
});
