import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * An expanded comment balloon must not be taller than the screen.
 *
 * Measured on the staging build: a declared thread's balloon runs ~700px open
 * — head, opening message, the full item card, the options, the answer
 * composer, the foot. Bryan reads on an iPad in landscape whose usable height
 * is about 750px, so on any anchor below the first screenful the composer and
 * the Answer button start below the fold, and reaching them scrolls the
 * DOCUMENT — which moves the balloon they were reaching for.
 *
 * The fix is the clamp the rest of this stylesheet already uses for anything
 * that can outgrow the viewport (`min(<n>vh, <n>px)` plus `overflow-y: auto`),
 * applied to the balloon so the scrolling happens INSIDE it and the item head
 * and composer stay reachable without the document moving. `offsetHeight`
 * honours a max-height, so `layoutBalloons` stacks the clamped height and the
 * column stays correct.
 *
 * This used to regex `max-height:` out of `styles.css` and check the value
 * contained "vh", which passes on a file that still carries the string even
 * where a later rule un-caps the balloon. The sheet is installed instead, so
 * what is read here is the cap the cascade actually applies. happy-dom does
 * not evaluate `min()` arithmetic, but it DOES resolve the `vh` inside it — so
 * the cap comes back as two different strings at two viewport heights, and
 * that difference is the whole claim: the ceiling is the SCREEN, not the
 * content.
 *
 * `.lf-balloon-comment` + `.expanded` on one element is what an open balloon
 * carries; `markup-margin.test.ts` pins that the code produces it. How the
 * clamped card LOOKS at 1180x820 and at 430px stays a browser check.
 *
 * SHEETS: the review shell links `styles.css` (then `tokens.css`, left out
 * here — the served file is a vendored Open Props subset plus `src/tokens.css`,
 * and the mapping half alone re-points every remapped token at an undefined
 * `var(--gray-N)`).
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css', 'doc.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/**
 * The cap an open balloon gets at `vp`, as a STRING taken on the spot.
 *
 * happy-dom's computed style resolves lazily and stays live: hold the
 * declaration across a `setViewport` and every property re-answers for the new
 * viewport, so two "different" viewports compare equal. Read the value out
 * before moving the window.
 */
function capAt(vp: { width: number; height: number }): string {
  setViewport(vp);
  return styleOf(attach('lf-balloon-comment expanded')).maxHeight;
}

/** An open balloon at `vp`, for properties that do not depend on the viewport. */
function expanded(vp: { width: number; height: number }) {
  setViewport(vp);
  return styleOf(attach('lf-balloon-comment expanded'));
}

describe('the expanded comment balloon clamps itself to the viewport', () => {
  it('caps its height against the viewport, not against its content', () => {
    const tall = capAt(IPAD);
    const short = capAt({ width: IPAD.width, height: 500 });
    expect(tall).not.toBe('');
    expect(tall).not.toBe('none');
    // A content-derived or a fixed cap would read the same at both heights.
    // A viewport-derived one cannot.
    expect(tall).not.toBe(short);
  });

  it('keeps the cap on the phone too, where the fold is even closer', () => {
    const phone = capAt(PHONE);
    expect(phone).not.toBe('');
    expect(phone).not.toBe('none');
  });

  it('scrolls INSIDE the balloon, so the composer is reachable without moving the doc', () => {
    const open = expanded(IPAD);
    expect(open.overflowY).toBe('auto');
    // …and the scroll stops at the balloon's own edge rather than chaining to
    // the document, which is the other half of "the anchor stays put".
    expect(open.overscrollBehavior).toBe('contain');
  });

  it('positive control: a CLOSED balloon is uncapped, and the sheet is live on it', () => {
    // Without this, a renamed class would make every assertion above pass by
    // measuring an element no rule reaches: an unstyled box reads '' for
    // max-height and overflow-y, which is what "uncapped" looks like.
    setViewport(IPAD);
    const closed = styleOf(attach('lf-balloon-comment'));
    expect(closed.cursor).toBe('pointer'); // the rule that predates the clamp
    expect(closed.maxHeight === 'none' || closed.maxHeight === '').toBe(true);
    expect(closed.overflowY === 'visible' || closed.overflowY === '').toBe(true);
  });
});
