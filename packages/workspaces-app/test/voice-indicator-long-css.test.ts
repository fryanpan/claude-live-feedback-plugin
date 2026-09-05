import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The readout has to hold a 100-word status brief and stay readable — read
 * off the cascade rather than out of the stylesheet's text.
 *
 * Bryan, 2026-08-29: *"If I ask for a brief status update, that should be
 * able to show me a 100 word message."* The strip was sized for a sentence:
 * `width: max-content` under `min(92vw, 840px)`, no height rule at all. A
 * hundred words at 14px/1.4 is ~5 lines at 840px and ~11 at a phone's 395px
 * — fine as prose, but with no ceiling a longer ack could climb off the top
 * of a 750px-tall iPad viewport, and the box needs to scroll rather than
 * grow.
 *
 * The cap is a PAIR — `min(<vh>, <px>)` — and which half binds depends on the
 * viewport, which is exactly what the old regex over the declaration could
 * not see. Measured here at three heights: the two the project verifies, plus
 * a short one where the viewport-relative half is the one that applies. How
 * the long form READS at 1180x820 and 430px is stated in the PR body as not
 * visually verified; happy-dom lays nothing out, so the cap is a declared
 * ceiling here, not a measured box.
 */

let cleanup = () => {};
beforeEach(() => {
  // The doc page loads styles.css; the board loads board.css before it (see
  // `renderBoardShell`). tokens.css is deliberately absent — the served sheet is
  // the Open Props subset concatenated with src/tokens.css, and the mapping
  // layer alone resolves to nothing.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The number a `min(a, b)` computed value settles on. happy-dom substitutes
 *  `vh` against the current viewport but leaves the comparison unevaluated. */
function px(value: string): number {
  const inner = /^min\((.*)\)$/.exec(value.trim());
  const terms = inner?.[1] ? inner[1].split(',') : [value];
  return Math.min(...terms.map((t) => Number.parseFloat(t)));
}

function longForm(viewport: { width: number; height: number }): CSSStyleDeclaration {
  setViewport(viewport);
  return styleOf(attach('voice-indicator voice-indicator--long'));
}

/** A viewport short enough that the vh half of the pair is the one that
 *  binds — neither of the two the project verifies is. */
const SHORT = { width: 1180, height: 600 } as const;

describe('the long-ack form of the readout', () => {
  it('caps its height against the short axis on every screen it can reach', () => {
    // The iPad's is the case the cap was written for: ~750px usable out of
    // 820, and a brief that grows past it climbs off the top of the viewport.
    expect(px(longForm(IPAD).maxHeight)).toBeLessThanOrEqual(0.45 * IPAD.height);
    expect(px(longForm(PHONE).maxHeight)).toBeLessThanOrEqual(0.45 * PHONE.height);
  });

  it('follows the viewport on a short screen, rather than a fixed ceiling', () => {
    // At 820 and at 932 the px ceiling is the smaller of the pair, so neither
    // verified viewport can tell whether the vh term is sane. At 600 it binds,
    // and the band it has to sit in is 30–45% of the screen: under a third and
    // a brief is a peephole, over half and it is a wall.
    const cap = px(longForm(SHORT).maxHeight);
    expect(cap).toBeLessThanOrEqual(0.45 * SHORT.height);
    expect(cap).toBeGreaterThanOrEqual(0.3 * SHORT.height);
    // …and it really is lower than what the tall screens get, i.e. the pair is
    // a pair and not one number wearing two units.
    expect(cap).toBeLessThan(px(longForm(IPAD).maxHeight));
  });

  it('scrolls inside itself instead of pushing the page', () => {
    expect(longForm(IPAD).overflowY).toBe('auto');
  });

  it('wraps as prose — a 100-word ack is a paragraph, not a line', () => {
    setViewport(IPAD);
    expect(longForm(IPAD).whiteSpace).toBe('normal');
    // Control: the SHORT form does not say this, so the assertion above is
    // reading the long form's own declaration and not a UA default that every
    // element would satisfy.
    expect(styleOf(attach('voice-indicator')).whiteSpace).toBe('');
  });

  it('positive control: the cascade is live, and the cap is the long form’s', () => {
    // Without this every assertion above passes by measuring an element no
    // rule reaches: an unstyled box has no `max-height` and `px('')` is NaN,
    // which survives every comparison.
    setViewport(IPAD);
    expect(styleOf(attach('voice-indicator')).maxHeight).toBe('');
    expect(longForm(IPAD).maxHeight).not.toBe('');
    expect(styleOf(attach('voice-indicator-not-a-class')).overflowY).toBe('');
  });
});
