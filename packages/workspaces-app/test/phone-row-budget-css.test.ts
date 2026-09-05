import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The phone task row's width budget, measured on the cascade rather than
 * matched in the stylesheet's text.
 *
 * Measured at a true 430px viewport with the coarse-pointer rules forced on,
 * the row was 402px and its fixed chrome (handle 32 · open zone 0 · status 24 ·
 * risk 10 · owner 24 · six 6px gaps) cost 126px. What was left is shared by the
 * title and the badge strip — and the word badges are 55–75px EACH, so a row
 * carrying `decision` + `💬 3` gave its title 167px (42% of the row) and a row
 * carrying `💬 3` + `due Aug 19` gave it 152px (38%). Seven of thirty-three
 * rows fell under half. The risk dot and one 6px gap left the row on
 * 2026-08-18, so the chrome is 110px now; the budget got 16px looser, not
 * loose.
 *
 * Then the pencil's 0-width slot became the open caret and moved to the right
 * of the row (2026-08-21), which spends 14px of that: chrome is 124px and the
 * title gets 274px, 68% of the row. Re-measured rather than re-derived — 261px
 * of title in a 389px row at an emulated ~417px viewport, the same arithmetic
 * one size down. It is 14px well spent: on a pointer that cannot hover, the
 * caret is the only thing on the row that SAYS the row opens, which the
 * pencil — dead on a coarse pointer — never did.
 *
 * So on a phone the strip is hidden. It used to keep exactly one mark — the
 * discussion count — and that badge was removed from the row board-wide on
 * 2026-08-18 at Bryan's request, so there is nothing left to except. The word
 * badges say in eight characters what the detail panel says in a sentence, and
 * `needs: decision` additionally has the board's own review strip. Same trade
 * the status word and the owner name already made on this row. "A phone" is
 * both halves — coarse pointer AND narrow viewport — because either alone hits
 * somebody with width to spare, and that claim is now four measurements rather
 * than a substring of the query.
 *
 * `min-width: max-content` is the other half, and it is the one that makes
 * "whole or not at all" structural rather than arithmetic: the strip's grid
 * track can then never be squeezed below its content, so a chip is never
 * clipped mid-glyph — the title (whose track floor is 0) absorbs the shortfall
 * instead. The base rule's `min-width: 0` is what let the track contribute a
 * zero minimum and render `💬 3` as an 11px sliver of a speech bubble. It
 * resolves to 0 today (no visible children on a phone) and is kept as the
 * standing guarantee for the next badge shown here, since getting it wrong is
 * silent.
 *
 * That guarantee cost a review round, and it is the reason this file is worth
 * converting. A media query adds NO specificity, so `min-width: max-content`
 * in the phone block and `min-width: 0` on the bare `.board-task-badges` are one
 * class each and SOURCE ORDER decides. Written beside the rest of the phone
 * row anatomy it computed to `0px` on a real 430px coarse-pointer viewport
 * while every other rule in the block applied — the badges vanished as
 * intended and the guarantee they were traded for was not there, and nothing
 * about the page looked wrong. The old version of this file answered that with
 * an index comparison over the source; this one reads the value.
 *
 * happy-dom still has no layout engine, so the rendered 430px row is measured
 * in a browser against a real build; that is what closes the criterion.
 */

let cleanup = () => {};
beforeEach(() => {
  // The board's real cascade order — `renderBoardShell`, packages/server/src/
  // shells.ts: board.css loads BEFORE styles.css. tokens.css is left out: the
  // served sheet is the vendored Open Props subset concatenated with
  // src/tokens.css, and the mapping layer alone resolves to nothing.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  setPointer('fine');
  document.body.replaceChildren();
});

/**
 * Make the media features a touch device reports match. happy-dom answers
 * `(pointer: coarse)` and `(hover: none)` from `navigator.maxTouchPoints`,
 * which is WINDOW-wide rather than something `setViewport` carries — hence
 * the explicit reset in `afterEach`, or the next file in this worker
 * inherits a touch device.
 */
function setPointer(kind: 'fine' | 'coarse'): void {
  (
    window as unknown as { happyDOM: { settings: { navigator: { maxTouchPoints: number } } } }
  ).happyDOM.settings.navigator.maxTouchPoints = kind === 'coarse' ? 5 : 0;
}

/** The badge strip on a task row, with one word badge in it, as a given
 *  device would resolve them. `renderBoard` emits this chain. */
function row(pointer: 'fine' | 'coarse', viewport: { width: number; height: number }) {
  setPointer(pointer);
  setViewport(viewport);
  const strip = attach('board-task-badges');
  const badge = attach('board-badge board-badge-due', { parent: strip });
  return { strip: styleOf(strip), badge: styleOf(badge) };
}

describe('the phone task row', () => {
  it('is scoped to a coarse pointer AND a narrow viewport, not either alone', () => {
    // The four corners. Dropping either half of the query changes who is hit:
    // a coarse pointer alone would strip a 1024px tablet that can afford the
    // badges, a width alone would strip a desktop window nobody reviews on.
    expect(row('coarse', PHONE).badge.display, 'phone').toBe('none');
    expect(row('coarse', IPAD).badge.display, 'touch tablet').not.toBe('none');
    expect(row('fine', PHONE).badge.display, 'narrow mouse window').not.toBe('none');
    expect(row('fine', IPAD).badge.display, 'laptop').not.toBe('none');
  });

  it('positive control: the badge is a styled element in every one of those states', () => {
    // Without this the corners above pass by measuring an element no rule
    // reaches: an unstyled div computes `display: block`, which satisfies
    // three of the four on its own.
    for (const [pointer, viewport] of [
      ['coarse', PHONE],
      ['coarse', IPAD],
      ['fine', PHONE],
      ['fine', IPAD],
    ] as const) {
      expect(row(pointer, viewport).badge.borderRadius, `${pointer} ${viewport.width}`).not.toBe(
        '',
      );
    }
  });

  it('drops them from the STRIP only — the same class labels a goal section', () => {
    // `renderBoard` puts `board-badge board-badge-due` in `.board-section-title` for
    // a goal's own due date: one per section, not per row, and it costs the
    // title nothing. A bare `.board-badge { display: none }` took it with them.
    setPointer('coarse');
    setViewport(PHONE);
    const inSection = attach('board-badge board-badge-due', {
      parent: attach('board-section-title'),
    });
    expect(styleOf(inSection).display).not.toBe('none');
    // …and the row's own badge really is hidden in the same pass, so this is a
    // scoping check and not a pair of elements nothing reached.
    expect(row('coarse', PHONE).badge.display).toBe('none');
  });

  it('carries no un-hiding exception — the phone strip is empty, not selective', () => {
    // Until 2026-08-18 this block carried an exception that re-showed the
    // discussion count after the drop. The badge is gone from the row entirely
    // (Bryan's call — see `taskBadges`), so the exception went with it: every
    // badge in the strip is hidden, including the class the exception named.
    setPointer('coarse');
    setViewport(PHONE);
    const strip = attach('board-task-badges');
    for (const variant of ['board-badge-due', 'board-badge-overdue', 'board-badge-comments']) {
      const badge = attach(`board-badge ${variant}`, { parent: strip });
      expect(styleOf(badge).display, variant).toBe('none');
    }
    // And `board-badge-comments` is gone from the whole stylesheet, not merely
    // un-excepted: it styles nothing anywhere.
    setPointer('fine');
    setViewport(IPAD);
    const ghost = styleOf(attach('board-badge-comments'));
    expect(ghost.borderRadius).toBe('');
    expect(ghost.borderTopColor).toBe('');
    // Controls: the base class still draws the chip, and a VARIANT that
    // survived still recolours it — so the emptiness above is this class's
    // own. (`color` is no use on either side: it inherits, so an unstyled
    // element reports the body's.)
    expect(styleOf(attach('board-badge')).borderRadius).not.toBe('');
    expect(styleOf(attach('board-badge-overdue')).borderTopColor).not.toBe('');
  });

  it('gives the strip a track minimum, so a chip is never clipped mid-glyph', () => {
    // The one that cost a review round: this is the declaration that lost to
    // source order while every other rule in the block applied. Read as a
    // computed value it cannot lose silently — a `min-width: 0` declared
    // anywhere below the phone block shows up here as `0px`.
    expect(row('coarse', PHONE).strip.minWidth).toBe('max-content');
  });

  it('leaves the wider row alone — this is a phone budget, not a redesign', () => {
    // The base strip keeps the zero minimum that lets a wide badge strip
    // ellipsize on a desktop row, where there is width to spare.
    for (const [pointer, viewport] of [
      ['fine', IPAD],
      ['coarse', IPAD],
      ['fine', PHONE],
    ] as const) {
      const floor = row(pointer, viewport).strip.minWidth;
      expect(floor, `${pointer} ${viewport.width}`).not.toBe('max-content');
      expect(Number.parseFloat(floor), `${pointer} ${viewport.width}`).toBe(0);
    }
  });

  it('has no parked chip left to budget for, on the phone row or off it', () => {
    setPointer('coarse');
    setViewport(PHONE);
    const parked = styleOf(attach('board-badge-parked', { parent: attach('board-task-badges') }));
    expect(parked.borderRadius).toBe('');
    expect(parked.borderTopColor).toBe('');
    // Control: a variant that survived still recolours the chip, in the same
    // pass and on the same sheet.
    setPointer('fine');
    setViewport(IPAD);
    expect(styleOf(attach('board-badge-overdue')).borderTopColor).not.toBe('');
  });
});
