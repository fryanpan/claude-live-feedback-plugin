import { prose } from '@feedback/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import { mountCommentPill, sentenceRangeAt } from '../src/doc/doc-comment-pill.ts';
import { type EditorHandle, createEditor } from '../src/editor.ts';
import { MountScope } from '../src/mount-scope.ts';

/**
 * The selection affordances over a markdown document (doc/doc-comment-pill.ts):
 * the round pill, the always-in-view Comment float, and the cached selection
 * both of them and the composer anchor to.
 *
 * They are one state machine, not three widgets, and the state that matters
 * is the CACHE: iOS blurs the editor between the pill appearing and the tap
 * landing, so what a comment anchors to has to survive the editor forgetting
 * it. The tests below drive the transitions that write it, and the huddle
 * routing that hands a range to the pointer pill instead.
 */

const open: Array<() => void> = [];
afterEach(() => {
  for (const f of open.splice(0).reverse()) f();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

beforeEach(() => {
  document.body.innerHTML = `
    <div id="toast" class="hidden"></div>
    <main id="editor-pane"><div id="editor"></div></main>
    <div id="composer" class="hidden"></div>
    <button id="comment-pill" class="hidden"></button>`;
});

const pill = () => document.getElementById('comment-pill') as HTMLButtonElement;
const float = () => document.getElementById('comment-float') as HTMLButtonElement;
const toastText = () =>
  (document.getElementById('toast')?.firstChild?.textContent ?? '').toString();

function mount(opts: { huddle?: boolean; markdown?: string } = {}) {
  const ydoc = new Y.Doc();
  const md = opts.markdown ?? 'One sentence. And a second one here.\n';
  prose.getProseFragment(ydoc).push(prose.parseMarkdownBlocks(md));
  const editorMount = document.getElementById('editor') as HTMLElement;
  const editor: EditorHandle = createEditor({
    parent: editorMount,
    ydoc,
    awareness: new Awareness(ydoc),
  });
  const scope = new MountScope();
  const pointer = { show: vi.fn(), hide: vi.fn() };
  const openComposer = vi.fn();
  const follow = vi.fn();
  const handle = mountCommentPill({
    huddle: opts.huddle === true,
    editor,
    editorMount,
    composer: document.getElementById('composer') as HTMLElement,
    commentPill: pill(),
    scope,
    pointer,
    openComposer,
    follow,
  });
  open.push(() => {
    scope.dispose();
    editor.destroy();
  });
  return { handle, editor, scope, pointer, openComposer, follow, editorMount };
}

/** Put a real DOM selection over the editor's prose — this is what the pill
 *  keys off in view mode, where ProseMirror never takes focus. */
function selectInEditor(editor: EditorHandle): void {
  const range = document.createRange();
  range.selectNodeContents(editor.editor.view.dom);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
}

/** Ask the controller to re-decide where the pill goes. A scroll is one of
 *  the signals it already listens for, so no private function is reached. */
function repositionViaScroll(editorMount: HTMLElement): void {
  editorMount.dispatchEvent(new Event('scroll'));
}

describe('the cached selection', () => {
  it('is the editor’s own while the editor still has one', () => {
    const { handle, editor } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    expect(handle.currentSelection()?.snippet).toBe('One sentence');
  });

  it('survives the editor losing it — which is what iOS does on the tap', () => {
    const { handle, editor } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    // Reading it through the controller is what caches it.
    handle.refreshSelection();
    editor.editor.commands.setTextSelection({ from: 1, to: 1 });
    expect(editor.getSelectionRel()).toBeNull();
    expect(handle.currentSelection()?.snippet).toBe('One sentence');
  });

  it('keeps the caret clear of the on-screen keyboard on every read', () => {
    const { handle, follow } = mount();
    handle.refreshSelection();
    expect(follow).toHaveBeenCalledTimes(1);
  });
});

describe('a range selection', () => {
  it('on a huddle doc goes to the pointer pill, and the round pill stands down', () => {
    const { editor, editorMount, pointer } = mount({ huddle: true });
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    selectInEditor(editor);
    repositionViaScroll(editorMount);
    expect(pointer.show).toHaveBeenCalledWith(1, 13);
    expect(pill().classList.contains('hidden')).toBe(true);
  });

  it('everywhere else raises the round pill instead', () => {
    const { editor, editorMount, pointer } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    selectInEditor(editor);
    repositionViaScroll(editorMount);
    expect(pointer.show).not.toHaveBeenCalled();
    expect(pill().classList.contains('hidden')).toBe(false);
  });

  it('is not repositioned while the composer is open', () => {
    const { editor, editorMount } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    selectInEditor(editor);
    (document.getElementById('composer') as HTMLElement).classList.remove('hidden');
    repositionViaScroll(editorMount);
    // The keyboard sliding up fires a resize; repainting the pill then would
    // put it back at a stale place mid-transition.
    expect(pill().classList.contains('hidden')).toBe(true);
  });
});

describe('tapping the round pill', () => {
  it('opens the composer on the standing selection', () => {
    const { editor, editorMount, openComposer } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    selectInEditor(editor);
    repositionViaScroll(editorMount);
    pill().click();
    expect(openComposer).toHaveBeenCalledTimes(1);
  });
});

describe('hiding', () => {
  it('takes both pills down together', () => {
    const { handle, editor, editorMount, pointer } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    selectInEditor(editor);
    repositionViaScroll(editorMount);
    expect(pill().classList.contains('hidden')).toBe(false);

    handle.hide();
    expect(pill().classList.contains('hidden')).toBe(true);
    expect(pointer.hide).toHaveBeenCalled();
  });

  it('happens when the editor is blurred', () => {
    const { editor, editorMount } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    selectInEditor(editor);
    repositionViaScroll(editorMount);
    editor.editor.emit('blur', {} as never);
    expect(pill().classList.contains('hidden')).toBe(true);
  });
});

describe('the always-in-view Comment float', () => {
  it('is mounted in the pane’s dock, labelled for what it does', () => {
    mount();
    expect(float()).not.toBeNull();
    expect(float().textContent).toBe('＋ Comment');
    expect(document.querySelector('#editor-pane')?.contains(float())).toBe(true);
  });

  it('opens the composer when there is already a selection', () => {
    const { editor, openComposer } = mount();
    editor.editor.commands.setTextSelection({ from: 1, to: 13 });
    float().click();
    expect(openComposer).toHaveBeenCalledTimes(1);
  });

  it('selects the SENTENCE at the caret when there is no selection', () => {
    const { editor, handle, openComposer } = mount();
    // A caret inside the second sentence.
    editor.editor.commands.setTextSelection({ from: 20, to: 20 });
    float().click();
    expect(openComposer).toHaveBeenCalledTimes(1);
    expect(handle.currentSelection()?.snippet).toBe('And a second one here.');
  });

  it('says what would make it work rather than opening an empty box', () => {
    const { openComposer } = mount({ markdown: '' });
    float().click();
    expect(openComposer).not.toHaveBeenCalled();
    expect(toastText()).toBe('Tap the sentence you want to comment on, then Comment.');
  });
});

describe('teardown', () => {
  it('drops a pending settle so it cannot run against the next document', () => {
    vi.useFakeTimers();
    const { editor, scope } = mount();
    // A view-mode selectionchange arms a 120ms settle.
    document.body.classList.add('view-mode');
    selectInEditor(editor);
    document.dispatchEvent(new Event('selectionchange'));
    scope.dispose();
    document.body.classList.remove('view-mode');
    // Nothing may run against the editor this mount just destroyed.
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
  });
});

describe('sentenceRangeAt', () => {
  it('expands a caret to the sentence it sits inside', () => {
    const { editor } = mount();
    const state = editor.editor.state;
    const text = (from: number, to: number) => state.doc.textBetween(from, to);
    const first = sentenceRangeAt(state, 5);
    expect(text(first.from, first.to)).toBe('One sentence.');
    const second = sentenceRangeAt(state, 20);
    expect(text(second.from, second.to)).toBe('And a second one here.');
  });

  it('steps back when the caret sits in the space after a terminator', () => {
    const { editor } = mount();
    const state = editor.editor.state;
    // Position 14 is the space between the two sentences.
    const r = sentenceRangeAt(state, 14);
    expect(state.doc.textBetween(r.from, r.to)).toBe('One sentence.');
  });

  it('gives the whole block back when there is no text to divide', () => {
    const { editor } = mount({ markdown: '' });
    const state = editor.editor.state;
    const r = sentenceRangeAt(state, 1);
    expect(r.from).toBeLessThanOrEqual(r.to);
  });
});
