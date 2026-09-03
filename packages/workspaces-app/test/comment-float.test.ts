import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mountCommentFloat } from '../src/doc/comment-float.ts';
import { floatDock } from '../src/float-dock.ts';
import { IPAD, PHONE, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The way to start a comment that does not have to be discovered.
 *
 * Before this, the doc's only entry point was the pill that appears beside a
 * selection: a fine gesture, and invisible until you have already made the
 * selection that reveals it. The float is the one a reader can find, so what
 * these assert is that it is REACHABLE — present without a selection, pinned
 * where it cannot scroll away, and at both of this project's verified sizes.
 */

let cleanupSheets: (() => void) | null = null;
const listeners: Array<() => void> = [];

function listen(target: EventTarget, type: string, fn: (ev: Event) => void): void {
  target.addEventListener(type, fn);
  listeners.push(() => target.removeEventListener(type, fn));
}

beforeEach(() => {
  cleanupSheets = installSheets('styles.css');
});

afterEach(() => {
  for (const off of listeners.splice(0)) off();
  cleanupSheets?.();
  cleanupSheets = null;
  for (const n of Array.from(document.body.children)) n.remove();
  setViewport({ width: 1024, height: 768 });
});

function pane(): HTMLElement {
  const el = document.createElement('div');
  el.id = 'editor-pane';
  document.body.appendChild(el);
  return el;
}

describe('the Comment float', () => {
  it('is on the page with nothing selected, and says what it does', () => {
    const btn = mountCommentFloat({ anchor: pane(), onComment: () => {}, listen });
    expect(btn.isConnected).toBe(true);
    expect(btn.textContent).toContain('Comment');
    expect(btn.hidden).toBe(false);
  });

  it('starts a comment when tapped', () => {
    const onComment = vi.fn();
    const btn = mountCommentFloat({ anchor: pane(), onComment, listen });
    btn.click();
    expect(onComment).toHaveBeenCalledTimes(1);
  });

  it('does not take focus off the prose, so the selection survives the tap', () => {
    // The composer anchors to whatever is selected right now. A button that
    // focuses itself on mousedown blurs the editor first, which is why the
    // selection pill cancels its own mousedown too.
    const btn = mountCommentFloat({ anchor: pane(), onComment: () => {}, listen });
    const ev = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    btn.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('rides the dock, which is pinned to the pane rather than to the prose', () => {
    // "Always in view" is this: the dock is positioned against the pane, so
    // scrolling the document moves the text under it and never carries it off
    // the bottom of the screen.
    setViewport(IPAD);
    const anchor = pane();
    const btn = mountCommentFloat({ anchor, onComment: () => {}, listen });
    const dock = btn.closest('.doc-floats') as HTMLElement;
    expect(dock).not.toBe(null);
    expect(dock.parentElement).toBe(anchor);
    const s = styleOf(dock);
    expect(s.position).toBe('absolute');
    expect(s.bottom).toBe('22px');
  });

  it('is pinned at 430px too, above the home indicator', () => {
    setViewport(PHONE);
    const btn = mountCommentFloat({ anchor: pane(), onComment: () => {}, listen });
    const dock = btn.closest('.doc-floats') as HTMLElement;
    const s = styleOf(dock);
    expect(s.position).toBe('absolute');
    // The phone rule swaps the centred pill for an edge-to-edge row and lifts
    // it clear of the safe area. Reading the two insets proves THAT rule won,
    // not just that some rule did.
    expect(s.left).toBe('12px');
    expect(s.right).toBe('12px');
  });

  it('shares the dock rather than starting a second one', () => {
    // Make Plan and Review already live there. Two docks would put two
    // centred rows on top of each other, which is the bug float-dock.ts was
    // written to end.
    const anchor = pane();
    const existing = floatDock(anchor);
    const btn = mountCommentFloat({ anchor, onComment: () => {}, listen });
    expect(btn.parentElement).toBe(existing);
    expect(anchor.querySelectorAll('.doc-floats')).toHaveLength(1);
  });

  it('reserves no room of its own in any OTHER editor in the pane', () => {
    // The dock needs the last paragraph to clear it, and the first version of
    // that rule asked the whole pane for the room: `#editor-pane .ProseMirror
    // { padding-bottom: 84px }`. Every reply composer in the pane is a
    // ProseMirror too — an inline card's and a margin balloon's both live
    // inside #editor — and one id beats the two classes of
    // `.md-composer-surface .ProseMirror`, so an empty reply box opened with
    // 84px of dead space under the caret. The clearance comes from #editor's
    // own bottom padding instead, which reaches nothing nested.
    setViewport(IPAD);
    const editor = document.createElement('div');
    editor.id = 'editor';
    pane().appendChild(editor);

    const composer = document.createElement('div');
    composer.className = 'md-composer-surface';
    const composerProse = document.createElement('div');
    composerProse.className = 'ProseMirror';
    composer.appendChild(composerProse);
    editor.appendChild(composer);
    expect(Number.parseFloat(styleOf(composerProse).paddingBottom) || 0).toBeLessThan(60);

    // Two controls, because a negative on its own is also what an element no
    // rule reaches would give. The sheet IS installed and the selectors DO
    // resolve: the document's own surface is a direct child of #editor and
    // picks up the rules written for it, and the composer above is inside the
    // pane where the deleted rule would have caught it.
    const docProse = document.createElement('div');
    docProse.className = 'ProseMirror';
    editor.appendChild(docProse);
    expect(styleOf(docProse).fontSize).toBe('18px');
    expect(styleOf(composerProse).fontSize).not.toBe('18px');
    expect(composerProse.closest('#editor-pane')).not.toBe(null);
  });
});
