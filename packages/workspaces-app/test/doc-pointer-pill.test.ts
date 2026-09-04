import { prose } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { ChromeSelection } from '../src/doc/anchor-body.ts';
import { mountPointerPillLayer } from '../src/doc/doc-pointer-pill.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The pointer pill layer over a document (doc/doc-pointer-pill.ts).
 *
 * The pill exists only on a huddle doc, and it offers exactly one action:
 * Comment. It offered three until 2026-09-04 (Comment / Research / Create
 * Task) and the other two filed work straight from the selection, which is
 * why this file used to be mostly about a captured selection surviving the
 * tap that spent it. None of that is here any more — a comment leaves the
 * selection standing, because the composer anchors to it.
 *
 * What the pill hands to the composer is proved in `pill-comment-focus.test.ts`,
 * which wires this layer to the real chrome rather than a spy.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  document.body.innerHTML = '';
});

beforeEach(() => {
  document.body.innerHTML = '<div id="editor"></div>';
});

const pillEl = () => document.querySelector<HTMLElement>('.pointer-pill');
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.pointer-pill button')];
const button = (id: string) =>
  document.querySelector<HTMLButtonElement>(`.pointer-pill button[data-action="${id}"]`);

function mount(opts: { huddle: boolean; selection?: ChromeSelection | null }) {
  const ydoc = new Y.Doc();
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks('Ship the balloon margin\n'));
  const editorMount = document.getElementById('editor') as HTMLElement;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness: new Awareness(ydoc),
  });
  editor.editor.commands.setTextSelection({ from: 1, to: 24 });
  const selection = opts.selection === undefined ? editor.getSelectionRel() : opts.selection;
  const scope = new MountScope();
  const hideAll = vi.fn();
  const openComposer = vi.fn();
  const layer = mountPointerPillLayer({
    huddle: opts.huddle,
    editor,
    editorMount,
    scope,
    getSelection: () => selection,
    hideAll,
    openComposer,
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { layer, scope, editor, selection, hideAll, openComposer };
}

describe('off a huddle doc', () => {
  it('grows no pill at all, and showing one is a no-op', () => {
    const { layer } = mount({ huddle: false });
    expect(pillEl()).toBeNull();
    layer.show(1, 24);
    layer.hide();
    expect(pillEl()).toBeNull();
  });
});

describe('on a huddle doc', () => {
  it('offers one action, and it is Comment', () => {
    const { layer } = mount({ huddle: true });
    // Built at mount, hidden until a selection asks for it.
    expect(pillEl()?.classList.contains('hidden')).toBe(true);
    layer.show(1, 24);
    expect(pillEl()?.classList.contains('hidden')).toBe(false);
    expect(buttons().map((b) => b.textContent)).toEqual(['Comment']);
    // The two that went are gone from the pill, not merely relabelled: a
    // rename would still leave a button that files work on one tap.
    expect(button('research')).toBeNull();
    expect(button('task')).toBeNull();
  });

  it('stays down when there is no selection to act on', () => {
    const { layer } = mount({ huddle: true, selection: null });
    layer.show(1, 24);
    expect(pillEl()?.classList.contains('hidden')).toBe(true);
  });

  it('sends Comment to the composer, and files nothing', () => {
    const { layer, openComposer, hideAll } = mount({ huddle: true });
    layer.show(1, 24);
    button('comment')?.click();
    expect(openComposer).toHaveBeenCalledTimes(1);
    expect(hideAll).toHaveBeenCalledTimes(1);
  });

  it('leaves the standing selection alone — the composer anchors to it', () => {
    const { layer } = mount({ huddle: true });
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('editor') as HTMLElement);
    window.getSelection()?.addRange(range);
    // Positive control: the selection this test is about really is standing.
    expect(window.getSelection()?.rangeCount).toBe(1);

    layer.show(1, 24);
    button('comment')?.click();
    // A spin-off used to drop it here, so the pill could not grow back over
    // words that had already become a row. A comment files nothing, and the
    // composer needs those words to anchor its thread to.
    expect(window.getSelection()?.rangeCount).toBe(1);
  });

  it('ignores a click on a pill that is already down', () => {
    const { layer, openComposer } = mount({ huddle: true });
    layer.show(1, 24);
    layer.hide();
    button('comment')?.click();
    expect(openComposer).not.toHaveBeenCalled();
  });

  it('takes the pill off the page when the mount is torn down', () => {
    const { layer, scope } = mount({ huddle: true });
    layer.show(1, 24);
    expect(pillEl()).not.toBeNull();
    scope.dispose();
    expect(pillEl()).toBeNull();
  });
});
