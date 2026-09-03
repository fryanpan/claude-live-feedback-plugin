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

  it('leaves room under the last line for the dock that sits over it', () => {
    // Without this the paragraph most likely to be commented on is the one
    // hidden behind the Comment button.
    setViewport(IPAD);
    const prose = document.createElement('div');
    prose.className = 'ProseMirror';
    pane().appendChild(prose);
    expect(Number.parseFloat(styleOf(prose).paddingBottom)).toBeGreaterThanOrEqual(60);
  });
});
