import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The walkthrough card's long-detail clamp, read off the cascade rather than
 * out of the stylesheet's text.
 *
 * The contract: the clamp and its expand affordance live ONLY in the mobile
 * tier (≤1100px). Wider screens — the iPad in landscape at 1180 — render the
 * whole detail with no affordance, because the ticket's promise is that the
 * card shows the same words as the thread, and only the phone needs a fold to
 * stay scannable.
 *
 * That tier boundary is exactly what a text read could not see: the old
 * version of this file searched for the clamp inside a `@media (max-width:
 * 1100px)` substring, which passes whether or not the query matches at the
 * width a reader is on, and passes whether or not a later rule un-clamps it.
 * Here the sheets are installed and the elements are built at each viewport,
 * so the assertion is the value the browser would use.
 *
 * The class chain (`hub-walk-body hub-walk-body-clamp`, and the sibling
 * `.hub-walk-body-expand`) is what `walkReviewBody` renders for a long ask;
 * `review-walkthrough.test.ts` pins that the island produces it. What is left
 * to the browser is the rendered height — happy-dom lays nothing out, so
 * `max-height` is read as a declared cap, not as a measured fold.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The body element the island renders for a long ask, at the given width. */
function clampedBody(viewport: { width: number; height: number }) {
  setViewport(viewport);
  return styleOf(attach('hub-walk-body hub-walk-body-clamp'));
}

/** The expand button the island renders alongside it. */
function expandButton(viewport: { width: number; height: number }) {
  setViewport(viewport);
  return styleOf(attach('hub-walk-body-expand', { tag: 'button' }));
}

describe('the long-detail clamp is scoped to the mobile tier', () => {
  it('folds the body on the phone', () => {
    const phone = clampedBody(PHONE);
    expect(phone.maxHeight).not.toBe('none');
    expect(phone.maxHeight).not.toBe('');
    expect(phone.overflow).toBe('hidden');
  });

  it('leaves the body whole on the iPad, where the card shows the same words as the thread', () => {
    const ipad = clampedBody(IPAD);
    expect(ipad.maxHeight === 'none' || ipad.maxHeight === '').toBe(true);
    expect(ipad.overflow === 'visible' || ipad.overflow === '').toBe(true);
  });

  it('shows the expand affordance only on the phone, at thumb size', () => {
    expect(expandButton(IPAD).display).toBe('none');
    const phone = expandButton(PHONE);
    expect(phone.display).toBe('inline-flex');
    expect(Number.parseFloat(phone.minHeight)).toBeGreaterThanOrEqual(36);
  });

  it('positive control: the cascade is live — the same element reads a rule that predates the clamp', () => {
    // Without this, a renamed class would make every assertion above pass by
    // measuring an element no rule reaches: an unstyled box has `max-height:
    // none`, `overflow: visible` and `display: block`, which is precisely the
    // iPad expectation.
    setViewport(PHONE);
    expect(styleOf(attach('hub-walk-body')).lineHeight).toBe('1.55');
    expect(styleOf(attach('hub-walk-body-clamp')).maxHeight).not.toBe('none');
  });
});
