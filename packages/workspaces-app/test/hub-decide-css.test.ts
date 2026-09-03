import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The decision card's SPACING, which is the whole of what was reported.
 *
 * Bryan, 2026-08-18, about the same card on the Home review queue: *"options
 * crammed against their details, no spacing between the answer buttons, no
 * spacing between buttons and comment text, nothing aligned."* The task-detail
 * copy emitted `hub-detail-options` / `hub-detail-option` /
 * `hub-detail-option-label` / `hub-detail-option-detail` and the stylesheet had
 * **no rule for any of them** — so the browser's defaults stacked the options
 * edge to edge and jammed the answer box against them. `hub-render.test.ts`
 * asserts the structure the rules hang off; this asserts that the rules reach
 * it.
 *
 * "Reach it" is the word that changed. This file used to regex `hub.css` for a
 * rule whose selector matched each class — which says a rule exists SOMEWHERE,
 * not that anything lands on the element. The sheets are installed here and
 * every class is built, so an emitted class with nothing styling it — the
 * exact state the report described — comes back as an unstyled box and fails.
 *
 * happy-dom lays nothing out, so the numbers are declared spacing rather than
 * measured gaps; the rendered card stays a browser check.
 *
 * SHEETS: `hub.css` before `styles.css` is the order `renderHubShell` links
 * them in; `tokens.css` is left out because the served file is a vendored Open
 * Props subset plus `src/tokens.css`, and the mapping half alone re-points
 * every remapped token at an undefined `var(--gray-N)`.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
  // 430px, the width the report was written from. Nothing in this card is
  // media-scoped, but a test that cares about a rule has to say which cascade
  // it is reading — happy-dom's default 1024 is inside the mobile tier.
  setViewport(PHONE);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** One of the card's elements, built where the panel builds it. */
function el(classes: string, tag = 'div', parent?: Element) {
  return styleOf(attach(classes, { tag, parent }));
}

/** Every class the card emits, with one declaration its rule owns. The pair is
 *  the point: a class with no rule reads '' for its property and fails here. */
const CARD: ReadonlyArray<readonly [string, keyof CSSStyleDeclaration, string]> = [
  ['hub-decide', 'padding', '16px'],
  ['hub-decide-head', 'display', 'flex'],
  ['hub-decide-kicker', 'fontWeight', '700'],
  ['hub-decide-card-head', 'alignItems', 'baseline'],
  ['hub-decide-k', 'padding', '2px 7px'],
  ['hub-decide-headline', 'lineHeight', '1.4'],
  ['hub-decide-body', 'lineHeight', '1.5'],
  ['hub-decide-meta', 'fontSize', '12px'],
  ['hub-decide-walk', 'display', 'flex'],
  ['hub-decide-step', 'display', 'inline-flex'],
  ['hub-decide-count', 'whiteSpace', 'nowrap'],
  ['hub-decide-options', 'flexDirection', 'column'],
  ['hub-decide-option', 'padding', '12px'],
  ['hub-decide-option-label', 'fontWeight', '600'],
  ['hub-decide-option-detail', 'lineHeight', '1.4'],
  ['hub-decide-form', 'flexDirection', 'column'],
  ['hub-decide-form-hint', 'fontSize', '13px'],
];

describe('the decision card has the spacing it was reported for missing', () => {
  it('styles every class the card emits — the reported bug was that none of them were', () => {
    for (const [cls, prop, value] of CARD) {
      expect(el(cls)[prop], cls).toBe(value);
    }
    // POSITIVE CONTROL: the same reads over a class no rule owns come back
    // empty, so the list above is discriminating rather than measuring the
    // browser's defaults.
    const missing = el('hub-decide-nothing-owns-this');
    expect(missing.padding).toBe('');
    expect(missing.flexDirection).toBe('');
    expect(missing.fontWeight).toBe('normal');
  });

  it('lets the blurb run to as many lines as it needs', () => {
    // *"The blurb may run a few lines — design for that."* The failure this
    // guards is a one-liner: any of these three turns a three-line question
    // into a clipped one, and a clipped decision question is unanswerable.
    for (const cls of ['hub-decide-headline', 'hub-decide-body']) {
      const r = el(cls);
      expect(r.getPropertyValue('-webkit-line-clamp'), cls).toBe('');
      expect(r.overflow, cls).not.toBe('hidden');
      expect(r.whiteSpace, cls).not.toBe('nowrap');
      // Control, and the one thing they DO declare about wrapping: a long
      // unbroken token wraps rather than widening the panel.
      expect(r.overflowWrap, cls).toBe('anywhere');
    }
  });

  it('lets the asked-by meta wrap — it is a sentence now, and 430px is real', () => {
    // The walkthrough head meta used to be a bare duration ("2 days") and
    // wore `white-space: nowrap`. It reads "Asked by <who> N days ago" now,
    // which nowrap would push out of a 430px head row.
    expect(el('hub-walk-wait', 'span').whiteSpace).not.toBe('nowrap');
    expect(el('hub-decide-meta').whiteSpace).not.toBe('nowrap');
    // Control: the reader CAN see a nowrap when one is there — the count next
    // to them still has it, so the two negatives above are not empty reads.
    expect(el('hub-decide-count', 'span').whiteSpace).toBe('nowrap');
  });

  it('puts the walkthrough beside the kicker without moving it', () => {
    // With one item there is no walk at all, and the requirement is that the
    // card then *"look like today's single card"* — which `space-between`
    // gives for free, leaving the kicker exactly where it was.
    const head = el('hub-decide-head');
    expect(head.display).toBe('flex');
    expect(head.justifyContent).toBe('space-between');
    // A step control is a tap target — at design-mobile.md's 36px floor, not
    // the 32 it shipped with.
    expect(Number.parseFloat(el('hub-decide-step', 'button').minHeight)).toBeGreaterThanOrEqual(36);
    // Only one card is on screen; the rest are hidden rather than unbuilt.
    expect(el('hub-decide-card hidden').display).toBe('none');
    expect(el('hub-decide-card').display).not.toBe('none'); // control
  });

  it('puts real space between the answer buttons', () => {
    // "No spacing between the answer buttons." A column with a gap, so the
    // spacing is a property of the group rather than a margin every button has
    // to remember — and one answer per row, since a row of pills puts two
    // answers under one thumb on a phone.
    const opts = el('hub-decide-options');
    expect(opts.display).toBe('flex');
    expect(opts.flexDirection).toBe('column');
    expect(opts.gap).toBe('8px');
  });

  it('gives each option padding, and its detail its own line', () => {
    // "Options crammed against their details." The label and the detail are
    // separate elements; without a column and a gap they render as one run of
    // text with a space in it, which is what "crammed" describes.
    const opt = el('hub-decide-option', 'button');
    expect(opt.padding).toBe('12px');
    expect(opt.flexDirection).toBe('column');
    expect(opt.gap).toBe('4px');
    // "Nothing aligned": a button's text centres by default, so a two-line
    // option would centre both lines against each other.
    expect(opt.textAlign).toBe('left');
    expect(opt.alignItems).toBe('flex-start');
    // The tap target design-mobile.md asks for.
    expect(Number.parseFloat(opt.minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('separates the free-text box from the options above it, and only then', () => {
    // "No spacing between buttons and comment text." Space AND a rule, because
    // the box is an alternative to the options rather than the next step after
    // them — and only when there are options for it to follow, which is why
    // this is the adjacent-sibling rule and not `.hub-decide-form` itself.
    const card = attach('hub-decide-card');
    attach('hub-decide-options', { parent: card });
    const after = styleOf(attach('hub-decide-form', { parent: card }));
    expect(after.marginTop).toBe('16px');
    expect(after.paddingTop).toBe('16px');
    expect(Number.parseFloat(after.borderTopWidth)).toBeGreaterThan(0);
    // Control, and the scoping the sibling selector exists for: a form with no
    // options in front of it takes none of that separation.
    const alone = styleOf(attach('hub-decide-form', { parent: attach('hub-decide-card') }));
    expect(alone.marginTop).toBe('0px');
    expect(alone.borderTopWidth).toBe('');
  });

  it('is written to be reusable by the Home card, not scoped to the panel', () => {
    // The Home queue's copy of this card is a separate ticket, on hold. These
    // names are the point: it should adopt them rather than grow a second
    // layout that drifts. So the card must compute the same layout wherever it
    // is mounted — a selector scoped to the detail panel would style nothing
    // once the card moved, which is the failure this guards.
    const inPanel = attach('hub-decide', {
      parent: attach('hub-detail-panel', { parent: attach('hub-detail') }),
    });
    const onHome = attach('hub-decide', { parent: attach('hub-home') });
    for (const prop of ['padding', 'margin', 'borderWidth', 'borderRadius'] as const) {
      expect(styleOf(inPanel)[prop], prop).toBe(styleOf(onHome)[prop]);
    }
    // Control: the reads above are a rule's values, not two empty strings.
    expect(styleOf(onHome).padding).toBe('16px');
  });
});
