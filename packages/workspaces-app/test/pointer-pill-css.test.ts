import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mountPointerPill } from '../src/pointer-pill.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The pointer pill's stylesheet contract, read off the cascade with the REAL
 * component mounted.
 *
 * What `mountPointerPill` cannot prove about itself is that the rules reach
 * the element it builds: that the pill is positioned in viewport coordinates
 * (the placement function works in nothing else), that hiding keeps its box
 * (it is measured while hidden, and a tap that blurred the editor first still
 * has to land on it), that a finger gets a 44px target on the touch tiers,
 * and — the one this replaces — that there is NO bottom-sheet form at any
 * width. The previous menu became a sheet at 560px; a pill that leaves the
 * pointer for the bottom of the screen on a phone is the reach the pointer
 * anchor exists to remove.
 *
 * The old version of this file matched the stylesheet's TEXT, which passes
 * whether or not the media block it searched matches at the width a reader is
 * on and whether or not the class chain is one the component ever emits. Both
 * halves are answered here: the element under test is the one `mountPointerPill`
 * produced, and every measurement names its viewport.
 *
 * Still a browser check (`bun run ui:shot`), because happy-dom resolves
 * neither: how it reads at 1180×820 and 430px, and the `::after` arrow —
 * pseudo-element styles come back empty, so the arrow's `--arrow-x` placement
 * and its `no-arrow` suppression are not asserted here at all.
 */

let cleanup = () => {};
beforeEach(() => {
  // The review editor's page loads styles.css; the board loads board.css before
  // it (`renderBoardShell`, packages/server/src/shells.ts). tokens.css is left
  // out on purpose — the served /app/tokens.css is the vendored Open Props
  // subset concatenated with src/tokens.css, and the mapping layer alone
  // resolves its `var(--gray-9)` chain to nothing.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The pill the app actually builds, at `viewport`. */
function pill(viewport: { width: number; height: number }) {
  setViewport(viewport);
  const handle = mountPointerPill({
    actions: [
      { id: 'task', label: 'Make a task' },
      { id: 'thread', label: 'Comment' },
    ],
    onPick: () => {},
  });
  const btn = handle.el.querySelector<HTMLElement>('.pointer-pill-btn');
  if (!btn) throw new Error('the pill mounted no buttons');
  return { handle, el: handle.el, btn };
}

describe('the pointer pill is placed in viewport coordinates', () => {
  it('is fixed, and above the comment pill that made the selection', () => {
    const { handle, el } = pill(IPAD);
    const style = styleOf(el);
    expect(style.position).toBe('fixed');
    // The caret pill sits at 800; a pill that opened BEHIND it would look
    // like one that failed to open.
    expect(Number(style.zIndex)).toBeGreaterThan(800);
    handle.destroy();
  });

  it('keeps its layout box while hidden', () => {
    // The component starts hidden, which is the state this is about.
    const { handle, el } = pill(IPAD);
    expect(handle.hidden).toBe(true);
    const style = styleOf(el);
    expect(style.opacity).toBe('0');
    expect(style.pointerEvents).toBe('none');
    // The app's global `.hidden` is `display: none !important`; this one has
    // to beat it, and a computed `inline-flex` is that fight's verdict rather
    // than a restatement of the declaration that fights it.
    expect(style.display).toBe('inline-flex');
    handle.destroy();
  });
});

describe('the buttons are targets, not text', () => {
  it('reach 44px on the touch tiers and stay clickable at a pointer', () => {
    const wide = pill(IPAD);
    expect(Number.parseFloat(styleOf(wide.btn).minHeight)).toBeGreaterThanOrEqual(36);
    wide.handle.destroy();
    const narrow = pill(PHONE);
    expect(Number.parseFloat(styleOf(narrow.btn).minHeight)).toBeGreaterThanOrEqual(44);
    narrow.handle.destroy();
  });
});

describe('there is no bottom sheet', () => {
  it('places the pill the same way at 430px as at 1180px', () => {
    // The sheet breakpoint the old menu used is 560px, so a phone is inside
    // it. Measuring the pill there is what the old "the block does not mention
    // `.pointer-pill`" text search was standing in for — and unlike that
    // search it also catches a sheet written into any OTHER block.
    const narrow = pill(PHONE);
    const style = styleOf(narrow.el);
    expect(style.position).toBe('fixed');
    // A sheet pins itself to the bottom and spans the width; the pill does
    // neither, at any width. `''` is what an undeclared inset computes to.
    expect(style.bottom).toBe('');
    expect(style.left).toBe('');
    expect(style.right).toBe('');
    narrow.handle.destroy();
  });

  it('the old menu is gone with its sheet — no selector left to style', () => {
    setViewport(PHONE);
    const ghost = styleOf(attach('spinoff-menu'));
    expect(ghost.position).toBe('');
    expect(ghost.background).toBe('');
    // Control: an element that IS styled reads differently in the same pass,
    // so the emptiness above is the class's absence and not the sheet's.
    expect(styleOf(attach('pointer-pill')).position).toBe('fixed');
  });
});
