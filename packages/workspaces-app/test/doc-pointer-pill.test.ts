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
 * The pill exists only on a huddle doc, and the selection it acts on is
 * CAPTURED when it appears — iOS blurs the editor before the tap on a button
 * lands, and by then there is nothing left to write the task's link beside.
 * That capture, and the fact that picking a spin-off drops the selection
 * before the pill can grow back over words that have already become a row,
 * are what these tests drive.
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
  const takeSpinoff = vi.fn();
  const layer = mountPointerPillLayer({
    huddle: opts.huddle,
    editor,
    editorMount,
    scope,
    getSelection: () => selection,
    hideAll,
    openComposer,
    takeSpinoff,
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { layer, scope, editor, selection, hideAll, openComposer, takeSpinoff };
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
  it('offers a comment and the two spin-offs, in that order', () => {
    const { layer } = mount({ huddle: true });
    // Built at mount, hidden until a selection asks for it.
    expect(pillEl()?.classList.contains('hidden')).toBe(true);
    layer.show(1, 24);
    expect(pillEl()?.classList.contains('hidden')).toBe(false);
    const labels = [...document.querySelectorAll('.pointer-pill button')].map((b) => b.textContent);
    expect(labels).toEqual(['Comment', 'Research', 'Create Task']);
  });

  it('stays down when there is no selection to act on', () => {
    const { layer } = mount({ huddle: true, selection: null });
    layer.show(1, 24);
    expect(pillEl()?.classList.contains('hidden')).toBe(true);
  });

  it('sends Comment to the composer, and files nothing', () => {
    const { layer, openComposer, takeSpinoff, hideAll } = mount({ huddle: true });
    layer.show(1, 24);
    button('comment')?.click();
    expect(openComposer).toHaveBeenCalledTimes(1);
    expect(takeSpinoff).not.toHaveBeenCalled();
    expect(hideAll).toHaveBeenCalledTimes(1);
  });

  it('hands a spin-off the selection captured when the pill appeared', () => {
    const { layer, takeSpinoff, openComposer, selection } = mount({ huddle: true });
    layer.show(1, 24);
    button('task')?.click();
    expect(openComposer).not.toHaveBeenCalled();
    expect(takeSpinoff).toHaveBeenCalledTimes(1);
    const [action, sel, range] = takeSpinoff.mock.calls[0];
    expect(action).toBe('task');
    expect(sel).toBe(selection);
    expect(range).toEqual({ from: 1, to: 24 });
  });

  it('carries no range when the pill was grown over a caret', () => {
    const { layer, takeSpinoff } = mount({ huddle: true });
    layer.show(5, 5);
    button('research')?.click();
    expect(takeSpinoff.mock.calls[0]?.[2]).toBeNull();
  });

  it('drops the standing selection once a spin-off has taken it', () => {
    const { layer } = mount({ huddle: true });
    const range = document.createRange();
    range.selectNodeContents(document.getElementById('editor') as HTMLElement);
    window.getSelection()?.addRange(range);
    // Positive control: the selection this test is about really is standing.
    expect(window.getSelection()?.rangeCount).toBe(1);

    layer.show(1, 24);
    button('task')?.click();
    // Left standing, the next positioning pass would grow the pill straight
    // back over words that have already become a row.
    expect(window.getSelection()?.rangeCount).toBe(0);
  });

  it('ignores a click on a pill that is already down', () => {
    const { layer, takeSpinoff } = mount({ huddle: true });
    layer.show(1, 24);
    layer.hide();
    button('task')?.click();
    expect(takeSpinoff).not.toHaveBeenCalled();
  });

  it('takes the pill off the page when the mount is torn down', () => {
    const { layer, scope } = mount({ huddle: true });
    layer.show(1, 24);
    expect(pillEl()).not.toBeNull();
    scope.dispose();
    expect(pillEl()).toBeNull();
  });
});
