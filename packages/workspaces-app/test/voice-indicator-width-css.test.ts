import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * How wide the dictation readout gets, read off the cascade rather than out
 * of the stylesheet's text.
 *
 * The bubble is where a live transcript appears while someone talks, and at
 * 420px a spoken sentence wrapped into five or six short lines that re-flowed
 * on every interim result — the text moved faster than it could be read. The
 * ask was to roughly double it.
 *
 * A single number cannot do that on its own: doubled, it is wider than a
 * phone. So the width is a PAIR — a ceiling that gives the tablet and the
 * laptop the doubling, and a viewport-relative cap that keeps the phone's
 * bubble inside the screen. The old version of this file matched the PAIR's
 * source text with a regex, which passes whichever half is actually winning
 * at the width a reader is on. Here the sheets are installed and the element
 * is measured at each viewport, so `vw` is resolved against the viewport the
 * assertion names and the number under test is the one the browser would use.
 *
 * What a browser still has to confirm is how the wider bubble READS; that is
 * in the PR body. happy-dom lays nothing out, so `max-width` is a declared
 * cap here, not a measured box.
 */

let cleanup = () => {};
beforeEach(() => {
  // The real cascade order — see `renderBoardShell` in packages/server/src/shells.ts:
  // board.css loads BEFORE styles.css on the board. `tokens.css` is left out on
  // purpose: the served /app/tokens.css is the vendored Open Props subset
  // concatenated with src/tokens.css, and installing the mapping layer alone
  // resolves its `var(--gray-9)` chain to nothing. tokens-css.test.ts installs
  // the pair.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/**
 * The number a `min(a, b)` computed value settles on. happy-dom substitutes
 * `vw`/`vh` against the current viewport but does not do the arithmetic, so
 * the cap arrives as `min(395.6px, 840px)` — two resolved lengths and the
 * comparison left to the reader.
 */
function px(value: string): number {
  const inner = /^min\((.*)\)$/.exec(value.trim());
  const terms = inner?.[1] ? inner[1].split(',') : [value];
  return Math.min(...terms.map((t) => Number.parseFloat(t)));
}

/** The readout as the app mounts it, measured at `viewport`. */
function readout(viewport: { width: number; height: number }): CSSStyleDeclaration {
  setViewport(viewport);
  return styleOf(attach('voice-indicator'));
}

/** The same element docked in the board's nav rail. */
function docked(viewport: { width: number; height: number }): CSSStyleDeclaration {
  setViewport(viewport);
  return styleOf(attach('voice-indicator', { parent: attach('board-nav-dock') }));
}

describe('the dictation readout is wide enough to follow', () => {
  it('caps at a width that reads as prose on a tablet or a laptop', () => {
    // At 1180 the viewport term is 1085px, so the CEILING is what binds — and
    // it is doubled from the 420px that made the readout too narrow to follow
    // in the first place, stated as that constant rather than as 840.
    expect(px(readout(IPAD).maxWidth)).toBe(2 * 420);
  });

  it('still fits a phone, because the other half of the pair is the viewport', () => {
    // At 430px the ceiling is unreachable and the viewport term is what
    // applies. It has to leave room for the gutter the floating form sits in
    // (`left: 16px`) — and for a classic scrollbar, which `100vw` counts and
    // the client area does not.
    const cap = px(readout(PHONE).maxWidth);
    expect(cap + 16).toBeLessThanOrEqual(430);
    // …and it must still be most of the screen, or the phone gains nothing.
    expect(cap).toBeGreaterThanOrEqual(0.8 * 430);
  });

  it('sizes itself from the sentence, so the cap above is not decorative', () => {
    // The pair above is a CEILING, and a ceiling only bites something that
    // wants to be taller. An absolutely positioned box with a `left` and no
    // `width` is shrink-to-fit, whose upper bound is the room left in its
    // containing block — the viewport while the mic floats, and the dock's own
    // column once it is docked. `max-width` cannot raise that bound, so on the
    // board the two numbers above applied to nothing: measured 2026-08-21
    // against a full sentence, the readout came out 45px wide and 978px tall
    // in the collapsed rail — 49 lines of roughly one syllable, the top 248px
    // of it above the viewport. `max-content` is what makes the sentence, not
    // the column, decide.
    expect(readout(IPAD).width).toBe('max-content');
    expect(readout(PHONE).width).toBe('max-content');
  });

  it('gives the docked copy the same width behaviour, not a second copy of it', () => {
    // The board docks the same element in its nav (`.board-nav-dock`), where it is
    // wider than the rail on purpose. Two hand-kept copies of a width is how
    // one surface gets the fix and the other keeps the bug — and what a reader
    // can observe is not whether the rule was restated but whether the two
    // resolve to the same thing, at both sizes. (The old text version asserted
    // the absence of a `max-width` declaration under `.board-nav-dock`; a
    // restatement that happened to agree was already indistinguishable to it.)
    for (const viewport of [IPAD, PHONE]) {
      expect(docked(viewport).maxWidth).toBe(readout(viewport).maxWidth);
      expect(docked(viewport).width).toBe(readout(viewport).width);
    }
  });

  it('positive control: the cascade is live — an unstyled box reads none of this', () => {
    // Without this, a renamed class would satisfy every assertion above by
    // measuring an element no rule reaches: `max-width` and `width` both come
    // back '' there, and `px('')` is NaN, which no comparison catches.
    setViewport(IPAD);
    expect(styleOf(attach('voice-indicator-not-a-class')).maxWidth).toBe('');
    expect(readout(IPAD).maxWidth).not.toBe('');
  });
});
