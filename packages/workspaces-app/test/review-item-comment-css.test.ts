import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * Commenting on a review item, as LAYOUT: the pill, the thread card, the
 * "See thread" link and the revised-phrase mark, at the two sizes the
 * project verifies (1180×820 iPad landscape, where HEIGHT is the scarce
 * axis; 430px phone, where thumbs are).
 *
 * Read off the cascade, not out of the stylesheet's text. That change is not
 * cosmetic here: the phone-tier touch floors live in a `@media (max-width:
 * 1100px)` block, a media query adds NO specificity, and the base rules they
 * override are declared LATER in hub.css. Two of the three never win. The
 * regex this file used to run found `min-height: 44px` inside the block and
 * passed for months; measuring the element at 430px is what surfaced it — see
 * the recorded defect below, which is deliberately left unfixed and reported
 * rather than patched.
 *
 * happy-dom still has no layout engine, so a browser measurement against a
 * real build closes the criterion.
 */

let cleanup = () => {};
beforeEach(() => {
  // The board's real cascade order: `renderHubShell` (packages/server/src/
  // shells.ts) loads hub.css BEFORE styles.css, and says why — the hub block
  // used to sit a twelfth of the way into styles.css, so most of that file
  // came after it and won every equal-specificity tie. tokens.css is left out:
  // the served sheet is the vendored Open Props subset concatenated with
  // src/tokens.css, and the mapping layer alone resolves to nothing.
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

const floorOf = (el: Element) => Number.parseFloat(styleOf(el).minHeight);

describe('the review-item comment furniture is thumb-sized and height-frugal', () => {
  it('the See-thread link is an atomic box with a 36px floor', () => {
    setViewport(IPAD);
    const link = attach('hub-walk-thread-link', { tag: 'button' });
    expect(styleOf(link).display).toBe('inline-flex');
    expect(floorOf(link)).toBeGreaterThanOrEqual(36);
  });

  it('on the phone tier the pill grows to 44px', () => {
    setViewport(PHONE);
    const pill = attach('hub-walk-pill', { tag: 'button' });
    expect(floorOf(pill)).toBeGreaterThanOrEqual(44);
    expect(Number.parseFloat(styleOf(pill).minWidth)).toBeGreaterThanOrEqual(44);
    // …and only there, so this is a tier rule and not a global size.
    setViewport(IPAD);
    expect(floorOf(attach('hub-walk-pill', { tag: 'button' })) || 0).toBeLessThan(44);
  });

  /**
   * RECORDED DEFECT, not a passing contract. Both "See thread" links are
   * supposed to reach 44px on the phone tier alongside the pill. They do not:
   * hub.css declares them at 44px inside the ≤1100px block (lines ~1205 and
   * ~1208) and then declares their 36px base rules LATER in the file (~1293
   * and ~1904). A media query adds no specificity, so source order settles it
   * and both compute to 36px at 430px. The sheet even carries the fix for the
   * neighbouring question link — `.hub-walk-actions .hub-walk-question-link`,
   * with a comment saying it was measured at 36px before the extra class was
   * added — so the pattern was known and these two were missed.
   *
   * Left broken on purpose: this pass converts tests, it does not change CSS.
   * `it.fails` states the contract and records that it does not hold, so the
   * day someone gives these two rules the specificity they need, THIS test
   * goes red and gets promoted to a plain `it`.
   */
  it.fails('KNOWN BROKEN: both thread links should reach 44px at 430px too', () => {
    setViewport(PHONE);
    for (const sel of ['hub-walk-thread-link', 'hub-review-thread-link']) {
      expect(floorOf(attach(sel, { tag: 'button' })), sel).toBeGreaterThanOrEqual(44);
    }
  });

  it('the thread card takes no fixed height — 1180×820 has ~750px usable', () => {
    setViewport(IPAD);
    const card = styleOf(attach('hub-walk-thread'));
    expect(card.height === '' || card.height === 'auto').toBe(true);
    expect(card.minHeight === '' || card.minHeight === '0px').toBe(true);
    // Positive control in the same pass: the card IS styled, so the emptiness
    // above is the absence of a height and not of the sheet.
    expect(card.padding).not.toBe('');
  });

  it('the ask boxes stack under a thumb like the answer box does', () => {
    // The stacked-composer rule the answer box has at ≤900px must reach the
    // thread form AND the question form too, or the field and its button sit
    // side by side at 430px.
    setViewport(PHONE);
    for (const sel of ['hub-walk-answer', 'hub-walk-thread-form', 'hub-walk-question-form']) {
      expect(styleOf(attach(sel)).flexDirection, sel).toBe('column');
    }
    // …and it really is the narrow tier doing it: on the iPad the same three
    // are rows, which no source search of the ≤900px block could tell you.
    setViewport(IPAD);
    for (const sel of ['hub-walk-answer', 'hub-walk-thread-form', 'hub-walk-question-form']) {
      expect(styleOf(attach(sel)).flexDirection, sel).not.toBe('column');
    }
  });

  it('the revised phrase wears the editor’s resolved-range treatment inside the card body', () => {
    setViewport(IPAD);
    const body = attach('hub-walk-body');
    const open = styleOf(attach('thread-range', { parent: body })).backgroundColor;
    const resolved = styleOf(attach('thread-range resolved', { parent: body })).backgroundColor;
    expect(open).not.toBe('');
    expect(resolved).not.toBe('');
    // Resolved is a different mark from an open one — the distinction is the
    // whole point of carrying the editor's treatment into the card.
    expect(resolved).not.toBe(open);
  });

  it('at 1180px the stage is two columns — the thread beside the card; one column at 430px', () => {
    // 1180×820: HEIGHT is the scarce axis, so the thread card takes a margin
    // column beside the card (approved mock: `minmax(0, 1fr) 300px`) rather
    // than a slice of the card's height.
    setViewport(IPAD);
    const open = styleOf(attach('hub-walk-stage hub-walk-stage-open'));
    expect(open.display).toBe('grid');
    expect(open.gridTemplateColumns).toMatch(/^minmax\(0, 1fr\)\s+\d+px$/);
    expect(open.alignItems).toBe('start');
    // The second column exists only while a thread is open. A bare stage —
    // no thread — is one column at every width: a reserved-but-empty 300px
    // margin squeezed the card to a third of a desktop screen (Bryan,
    // 2026-08-29, "review items only take up a narrow part of the screen").
    expect(styleOf(attach('hub-walk-stage')).gridTemplateColumns).toBe('');
    // And below the boundary the open stage stacks — the plain one-column
    // flow it is at top level, with the margin below the card.
    setViewport(PHONE);
    expect(styleOf(attach('hub-walk-stage hub-walk-stage-open')).gridTemplateColumns).toBe('');
  });

  it('the old “Tell me more” box left with its rules', () => {
    // Negative control on the positive assertions above: an element carrying a
    // class the sheet no longer knows reads unstyled on every property those
    // assertions use.
    setViewport(IPAD);
    for (const sel of ['hub-walk-more', 'hub-walk-info']) {
      const ghost = styleOf(attach(sel));
      expect(ghost.padding, sel).toBe('');
      expect(ghost.backgroundColor, sel).toBe('');
      expect(ghost.minHeight, sel).toBe('');
    }
    // Control: a class the sheet DOES know reads styled in the same pass.
    expect(styleOf(attach('hub-walk-thread')).padding).not.toBe('');
  });
});
