import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The task panel ends ABOVE the on-screen keyboard, so its last control — the
 * Comment button — is reachable.
 *
 * Reported from an iPad: *"Comment button is hidden below the bottom of screen
 * … half of it is below the bottom of the task and I can't scroll far enough
 * to make it show up"*. Both halves of that sentence come from the same cause.
 * The panel's height is computed from `vh`, which counts the rows iOS covers
 * with the keyboard and — with a hardware keyboard attached — with the
 * shortcuts bar. So the panel's own box extends under that bar, the composer
 * is the last thing in it, and the panel is ALREADY scrolled to its end: there
 * is no scroll left to spend, which is exactly what "can't scroll far enough"
 * describes.
 *
 * The doc surface has never had this — `app.ts` publishes `--kb-bottom` from
 * the visual viewport and every bottom-docked element there rises by it. The
 * board is a different entry point and called none of it, so the fix is to share
 * the wiring (see keyboard-inset.test.ts) and spend the variable here.
 *
 * The variable is what makes this testable without a layout engine. Instead of
 * grepping `board.css` for `var(--kb-bottom)`, these DRIVE it: `--kb-bottom` is
 * published on the root exactly as `wireKeyboardInset` publishes it, and the
 * panel's own box is read back at each viewport. A rule that still carried the
 * string but had been overridden, or that sat in a block the phone does not
 * match, moves no pixel here.
 *
 * What a browser still has to confirm is the button's rect at 1180x820 with
 * the keyboard up.
 *
 * SHEETS: `board.css` before `styles.css` is the order `renderBoardShell` links
 * them in; `tokens.css` is left out because the served file is a vendored Open
 * Props subset plus `src/tokens.css`, and the mapping half alone re-points
 * every remapped token at an undefined `var(--gray-N)`.
 */
const SRC = resolve(import.meta.dirname, '../src');
const BOARD = readFileSync(resolve(SRC, 'board/board-app.ts'), 'utf8');

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css');
  // The board's own body class — the board's rules are written against it
  // (`body.board-body { --board-bottom-bar: 58px }` in the ≤900 block among them),
  // so the cascade read here is the one a board page gets.
  document.body.className = 'board-body';
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.className = '';
  document.documentElement.style.removeProperty('--kb-bottom');
});

/** Raise the on-screen keyboard the way `wireKeyboardInset` reports it. */
function keyboard(px: number): void {
  if (px === 0) document.documentElement.style.removeProperty('--kb-bottom');
  else document.documentElement.style.setProperty('--kb-bottom', `${px}px`);
}

/** The modal overlay's bottom edge at `vp`, taken on the spot — happy-dom's
 *  computed style is live, so a held declaration re-answers after a viewport
 *  or variable change. */
function overlayBottom(vp: { width: number; height: number }): string {
  setViewport(vp);
  return styleOf(attach('board-detail')).bottom;
}

describe('the task panel clears the on-screen keyboard', () => {
  it('wires the keyboard inset from the board entry, not only the doc app', () => {
    expect(BOARD).toContain('wireKeyboardInset');
  });

  it('ends the modal overlay above the keyboard', () => {
    // Control: with the keyboard down the overlay is `inset: 0` exactly as
    // before, so the rise below is the variable talking and not a default.
    keyboard(0);
    expect(overlayBottom(IPAD)).toBe('0px');
    keyboard(260);
    expect(overlayBottom(IPAD)).toBe('260px');
  });

  it('caps the panel against the overlay it sits in, not against the raw viewport', () => {
    // `min(92vh, 100%)` keeps today's 92vh everywhere the keyboard is down —
    // the overlay's content box IS 92vh then — and follows the overlay up
    // when it isn't. A bare `92vh` cannot: `vh` does not move. Read as two
    // strings at two window heights: the `100%` term is the half that tracks
    // the overlay, and the `vh` term has to still be there beside it.
    setViewport(IPAD);
    const tall = styleOf(
      attach('board-detail-panel', { parent: attach('board-detail') }),
    ).maxHeight;
    setViewport({ width: IPAD.width, height: 600 });
    const short = styleOf(
      attach('board-detail-panel', { parent: attach('board-detail') }),
    ).maxHeight;
    expect(tall).toContain('100%');
    expect(tall).not.toBe(short); // the vh half really is viewport-derived
  });

  it('hands the sheet edge to the phone sheet at 430px, where the bottom bar lives', () => {
    // The ≤900 block is where the keyboard is STACKED on top of the app's own
    // bottom bar rather than replacing it — three things can own the bottom of
    // a phone screen (the bar, the home indicator, the keyboard) and the sheet
    // ends above their sum. That SUM is not readable here: happy-dom does not
    // evaluate a `calc()` of several `var()` terms — it returns the last term
    // alone — and `--safe-bottom` is an `env()` it leaves unresolved. So the
    // arithmetic stays a browser check, and what this pins is the
    // precondition it depends on: that the phone block, not the desktop one,
    // owns the overlay and the panel at 430px.
    setViewport(PHONE);
    const overlay = styleOf(attach('board-detail'));
    expect(overlay.padding).toBe('0px'); // desktop's `4vh 14px` is overridden
    expect(
      styleOf(attach('board-detail-panel', { parent: attach('board-detail') })).maxHeight,
    ).toBe('100%'); // a full-height sheet, not the 92vh card
    // Control: the desktop values really are different, so the two reads above
    // are the phone block talking.
    setViewport(IPAD);
    expect(styleOf(attach('board-detail')).padding).not.toBe('0px');
  });
});
