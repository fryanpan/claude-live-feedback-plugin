import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * Line one does not move when the card opens — in the margin, where the claim
 * was made.
 *
 * "The title and the glyph stay put on expand" is what moved line one out of
 * the folding slots and into `.thread-head` in the first place. The head is
 * outside the fold, so nothing REBUILDS it; what was left was a rule that
 * restyled it. `.thread.expanded .thread-topic-line` dropped `nowrap` and
 * raised the size and the weight, and in a 260px column a topic that fits one
 * clipped row folded wraps to three rows open: the head grew from 18px to
 * 55px and `align-items: center` slid the glyph 20px down the row the reader
 * had just tapped. Measured in a browser at 1180x820 on 2026-09-03.
 *
 * These read the four declared properties that produce that geometry, because
 * happy-dom has no layout engine and `offsetHeight` is always 0 — the rendered
 * numbers stay a `bun run ui:shot` check. What is asserted here is that the
 * cascade hands the folded card and the open card the SAME values in the
 * margin, and different ones outside it, which is exactly the difference the
 * browser measured.
 *
 * SHEETS: `styles.css` alone. `tokens.css`'s mapping half re-points every
 * remapped colour at an undefined `var(--gray-N)`, and no colour is read here.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  setViewport({ width: 1024, height: 768 });
});

/** The four properties that decide whether line one keeps its row. */
function headShape(expanded: boolean, inMargin: boolean): Record<string, string> {
  const host = inMargin ? attach('markup-margin') : undefined;
  const card = attach(expanded ? 'thread expanded' : 'thread', { parent: host });
  const head = attach('thread-head', { parent: card });
  const s = styleOf(attach('thread-topic-line clip', { parent: head }));
  return {
    whiteSpace: s.whiteSpace,
    overflow: s.overflow,
    fontSize: s.fontSize,
    fontWeight: s.fontWeight,
  };
}

describe('line one across the fold', () => {
  it('keeps every geometry property in the balloon margin', () => {
    expect(headShape(true, true)).toEqual(headShape(false, true));
  });

  it('still lets it breathe where the card has the width for it', () => {
    // The control, and the reason this is scoped rather than deleted: in the
    // drawer, the modal and an inline card, an opened card is the header of
    // what you just opened and a long topic should read in full. A test that
    // only asserted the equality above would also pass if the rule had been
    // removed outright.
    const folded = headShape(false, false);
    const open = headShape(true, false);
    expect(open).not.toEqual(folded);
    expect(folded.whiteSpace).toBe('nowrap');
    expect(open.whiteSpace).toBe('normal');
  });

  it('reads the same folded values inside the margin as outside it', () => {
    // Positive control on the override itself: it restates the folded values
    // rather than reverting past them to the browser default, so a folded
    // card looks the same wherever it sits.
    expect(headShape(false, true)).toEqual(headShape(false, false));
  });
});
