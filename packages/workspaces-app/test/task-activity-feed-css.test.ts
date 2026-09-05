import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The task's Activity feed as LAYOUT: note rows, their kind label, the fold
 * on a long note, the marked phrase and the pill, at the two sizes the
 * project verifies (1180×820 iPad landscape, where HEIGHT is the scarce
 * axis; 430px phone, where thumbs are).
 *
 * Read off the cascade, not out of the stylesheet's text. The old version
 * matched declarations with a regex, which passes against a file that still
 * contains the string while the rule no longer applies — the phone-tier 44px
 * floors are the ones that matters for: they sit in a `@media (max-width:
 * 1100px)` block, add no specificity, and a base rule declared LATER in the
 * file silently outranks them. That failure is invisible to a text search and
 * is a measurement here. (It is not hypothetical: `review-item-comment-css.
 * test.ts` records two links in this same sheet where it has actually
 * happened.)
 *
 * happy-dom still has no layout engine, so a browser measurement against a
 * real build closes the criterion.
 */

let cleanup = () => {};
beforeEach(() => {
  // The board's real cascade order — `renderBoardShell`, packages/server/src/
  // shells.ts loads board.css BEFORE styles.css, and the order is load-bearing
  // for equal-specificity ties. tokens.css is deliberately absent: the served
  // /app/tokens.css is the vendored Open Props subset concatenated with
  // src/tokens.css, and the mapping layer alone resolves to nothing.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** A note body in the feed, folded or not, at `viewport`. */
function noteBody(viewport: { width: number; height: number }, folded: boolean) {
  setViewport(viewport);
  return attach(folded ? 'board-note-body is-folded' : 'board-note-body');
}

describe('the task Activity feed is height-frugal at the tablet tier', () => {
  it('a feed row and a note body take no fixed height', () => {
    setViewport(IPAD);
    for (const sel of ['board-hist-row', 'board-note-body']) {
      const box = styleOf(attach(sel));
      // An unset property computes to '' rather than to `auto`/`none`, so both
      // spellings of "not capped" are accepted — and the control below is what
      // stops that from being satisfied by an element no rule reaches.
      expect(box.height === '' || box.height === 'auto', sel).toBe(true);
      expect(box.minHeight === '' || box.minHeight === '0px', sel).toBe(true);
    }
    // Positive control, same pass: the two elements ARE styled, so the
    // emptiness above is the absence of a height and not of the sheet.
    expect(styleOf(attach('board-note-body')).overflowWrap).toBe('anywhere');
    expect(styleOf(attach('board-hist-row')).display).not.toBe('');
  });

  it('a folded note clips instead of running the length of the panel', () => {
    setViewport(IPAD);
    const folded = noteBody(IPAD, true);
    const cap = Number.parseFloat(styleOf(folded).maxHeight);
    expect(Number.isFinite(cap)).toBe(true);
    // It has to actually fold: a cap taller than the panel's own share of a
    // 750px-usable iPad viewport is a cap that never bites.
    expect(cap).toBeLessThan(0.4 * IPAD.height);
    expect(styleOf(folded).overflow).toBe('hidden');
    // NOT asserted here, and dropped from the text version this replaces: the
    // cap's UNIT. It is written as a line budget (`em`), and happy-dom
    // resolves em to px against a fixed 16px root rather than the element's
    // own size, so neither the unit nor the scaling it buys survives into the
    // computed value. `bun run ui:shot` is where the six-line fold is seen.
    // Control: an unfolded body has no cap at all, so the cap above belongs to
    // `.is-folded` rather than to every note in the feed.
    expect(styleOf(noteBody(IPAD, false)).maxHeight).toBe('');
    // The toggle is a control, not a band of its own height.
    const more = styleOf(attach('board-note-more', { tag: 'button' }));
    expect(more.height === '' || more.height === 'auto').toBe(true);
  });

  it('the kind label is a small caps token beside the agent and the age', () => {
    setViewport(IPAD);
    const kind = styleOf(attach('board-note-kind'));
    expect(kind.textTransform).toBe('uppercase');
    const size = Number.parseFloat(kind.fontSize);
    expect(size).toBeGreaterThanOrEqual(10);
    expect(size).toBeLessThanOrEqual(11);
    // …and smaller than the note it labels, which is the point of a token.
    expect(size).toBeLessThan(Number.parseFloat(styleOf(attach('board-note-body')).fontSize));
  });

  it('a note body wraps an unbroken token instead of widening the panel', () => {
    // A status note is posted raw (no reduction), so one 700-char hash or
    // path must wrap inside the row rather than scroll the whole panel.
    setViewport(IPAD);
    expect(styleOf(attach('board-note-body')).overflowWrap).toBe('anywhere');
    const code = styleOf(attach('cm-code', { tag: 'code' }));
    expect(code.whiteSpace).toBe('pre-wrap');
    expect(code.overflowWrap).toBe('anywhere');
  });

  it('a status token is tinted so a milestone reads apart from a routine turn', () => {
    setViewport(IPAD);
    const kindIn = (rowClass: string) =>
      styleOf(attach('board-note-kind', { parent: attach(`board-hist-row ${rowClass}`) })).color;
    const status = kindIn('board-hist-row-status');
    expect(status).not.toBe('');
    // Three different rows, three different marks: a status is not a denial,
    // and neither wears the plain feed colour.
    expect(status).not.toBe(kindIn('board-hist-row-denial'));
    expect(status).not.toBe(styleOf(attach('board-note-kind')).color);
  });

  it('the marked phrase in the feed wears the active thread-range treatment', () => {
    setViewport(IPAD);
    const mark = styleOf(
      attach('thread-range', { parent: attach('board-detail-transitions') }),
    ).backgroundColor;
    expect(mark).not.toBe('');
    // Control: the same class OUTSIDE the feed is a different treatment, so
    // the descendant rule is the one being measured.
    expect(mark).not.toBe(styleOf(attach('thread-range')).backgroundColor);
  });
});

describe('the task Activity feed is thumb-sized on the phone tier', () => {
  it('the fold toggle and the pill grow to 44px at 430px', () => {
    setViewport(PHONE);
    expect(Number.parseFloat(styleOf(attach('board-note-more', { tag: 'button' })).minHeight)).toBe(
      44,
    );
    const pill = styleOf(attach('board-hist-pill', { tag: 'button' }));
    expect(Number.parseFloat(pill.minWidth)).toBe(44);
    expect(Number.parseFloat(pill.minHeight)).toBe(44);
    // …and only on that tier: the iPad keeps the pointer-sized control, which
    // is what makes this a tier rule rather than a global one.
    setViewport(IPAD);
    expect(
      Number.parseFloat(styleOf(attach('board-hist-pill', { tag: 'button' })).minHeight) || 0,
    ).toBeLessThan(44);
  });

  it('negative control: a selector the sheet does not have reads as unstyled', () => {
    setViewport(PHONE);
    const nothing = styleOf(attach('board-hist-nothing'));
    expect(nothing.minHeight).toBe('');
    expect(nothing.textTransform).toBe('');
  });
});
