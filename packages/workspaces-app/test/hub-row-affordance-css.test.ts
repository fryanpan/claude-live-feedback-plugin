import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The task row's title affordance, read off the cascade.
 *
 * Bryan, 2026-08-21, on the title: *"entering edit mode must NOT shift the
 * text — zero layout jump"*, and *"hovering over the title TEXT shows a subtle
 * rectangle around it … on click the rectangle goes away — you're left with
 * just the text caret at the click position."*
 *
 * Zero shift is structural in TS — the words are edited in place, so no
 * element is swapped and no box is rebuilt (`hub-render.test.ts`, "edits the
 * words where they are"). What CSS can still undo is exactly that: a border,
 * a padding, a font or a margin added for the resting or the editing state
 * puts the jump straight back. That is what is measured here — the resting
 * span and the editing span are both built and their computed boxes read, so
 * a rule that grows one of them fails rather than surviving as a substring in
 * a file nobody rendered.
 *
 * The HOVER half stays a browser check (`bun run ui:shot`): happy-dom has no
 * pointer, so `:hover` never applies, and it matches `hover: hover` and
 * `pointer: fine` at every viewport, so it cannot see that the rectangle is
 * scoped to a pointer that can hover either. What is checkable here is the
 * resting declaration the hover only recolours — the outline is already
 * painted, transparent, so the hover changes a colour and nothing else.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/**
 * Anything that occupies space. `outline` is the one border-like paint that
 * does not, which is why the rectangle is drawn with it. An unset property
 * computes to `''` here, not to its CSS initial value, so "takes no space" is
 * read as "the cascade declares nothing", with the outline read alongside as
 * the control that the element IS reached by a rule.
 */
const TAKES_SPACE = [
  'border-top-width',
  'border-left-width',
  'padding-top',
  'padding-left',
  'margin-top',
  'margin-left',
  'width',
  'height',
] as const;

/** The row, its title cell, and a title span in one of its two states. */
function titleRow(state: 'resting' | 'editing') {
  const row = attach('hub-task-row');
  const cell = attach(state === 'editing' ? 'hub-task-title hub-title-editing' : 'hub-task-title', {
    parent: row,
  });
  const text = attach('hub-task-title-text', {
    tag: 'span',
    parent: cell,
    attrs: state === 'editing' ? { contenteditable: 'true' } : {},
  });
  return { row: styleOf(row), cell: styleOf(cell), text: styleOf(text), cellEl: cell };
}

const px = (v: string) => Number.parseFloat(v);

describe('the row title, resting and edited', () => {
  it('reserves the hover rectangle as a transparent outline that costs no space', () => {
    // Declared transparent rather than absent: the hover then changes a colour
    // and nothing else, and — the half that is easy to lose — the declaration
    // is already there to beat the UA focus ring when this span takes focus.
    const { text } = titleRow('resting');
    expect(text.outlineStyle).toBe('solid');
    expect(text.outlineColor).toBe('transparent');
    expect(px(text.outlineWidth)).toBeGreaterThan(0);
    expect(px(text.outlineOffset)).toBeGreaterThan(0);
    for (const prop of TAKES_SPACE) {
      expect(text.getPropertyValue(prop), `${prop} is declared on the title span`).toBe('');
    }
  });

  it('leaves the words at the cell’s own type, so nothing reflows around them', () => {
    // A font-size or a line-height on the span is the other way to move the
    // text without declaring a box. Inherited values are equal to the cell's;
    // an override would not be.
    const { cell, text } = titleRow('resting');
    expect(text.fontSize).toBe(cell.fontSize);
    expect(text.lineHeight).toBe(cell.lineHeight);
  });

  it('says the words are typeable', () => {
    // The same question `finePointer()` asks in TS. That it is SCOPED to a
    // fine pointer is a browser check — happy-dom reports a fine, hover-capable
    // pointer at every viewport, so it cannot tell a scoped rule from an
    // unscoped one.
    expect(titleRow('resting').text.cursor).toBe('text');
  });

  it('adds no box while editing either', () => {
    // The instant after the click the same span is contenteditable. If the
    // editing rule brought a border or a padding with it, the words would
    // jump on the click — the one thing Bryan named.
    const { text } = titleRow('editing');
    expect(text.outlineColor).toBe('transparent');
    for (const prop of TAKES_SPACE) {
      expect(text.getPropertyValue(prop), `${prop} is declared while editing`).toBe('');
    }
  });

  it('leaves the rectangle room inside the cell that clips it', () => {
    // The failure this pins is specific and was measured in Chrome before it
    // was fixed: `overflow: hidden` clips at the padding box, the cell had no
    // padding, so the outline — drawn 2px outside the words — survived only on
    // the right, where the flexible track leaves slack. It rendered as one
    // stroke down the end of the title rather than a rectangle.
    //
    // The padding opens the room; the negative margin gives the same space
    // back to the grid so nothing moves. They are one declaration, and either
    // one alone is a bug — hence asserted as a pair, with the sum checked.
    const { cell, text } = titleRow('resting');
    expect(px(cell.paddingTop)).toBeGreaterThan(0);
    expect(px(cell.marginTop)).toBe(-px(cell.paddingTop));
    expect(px(cell.paddingLeft)).toBe(px(cell.paddingTop));
    expect(px(cell.marginLeft)).toBe(-px(cell.paddingTop));
    // …and enough of it: the outline sits `outline-offset` away from the words
    // and is `outline-width` thick, so anything less clips it again.
    expect(px(cell.paddingTop)).toBeGreaterThanOrEqual(
      px(text.outlineOffset) + px(text.outlineWidth),
    );
    // The ellipsis is why the clip is there at all, so it must still be.
    expect(cell.overflow).toBe('hidden');
  });

  it('stops truncating a title that is being typed into', () => {
    // An ellipsis over an open edit is a lie about the text: the reader is
    // typing into characters the row is still drawing as "…".
    expect(titleRow('editing').cell.textOverflow).toBe('clip');
    // Positive control: the resting cell really does truncate, so the rule
    // above is turning something off rather than agreeing with the default.
    expect(titleRow('resting').cell.textOverflow).toBe('ellipsis');
  });

  it('keeps one grid track per row child, with the flexible one under the title', () => {
    // Auto-placement fills CONSECUTIVE tracks, so the count here and the child
    // list in `hub-render.test.ts` are one fact in two files: six children,
    // six tracks, and the third — the title — is the one that flexes. Get the
    // count wrong and the title slides into a fixed track and renders at that
    // track's width on every row.
    const tracks = titleRow('resting')
      .row.gridTemplateColumns.replace('minmax(0, 1fr)', 'FLEX')
      .trim()
      .split(/\s+/);
    expect(tracks).toEqual(['auto', 'auto', 'FLEX', 'auto', 'auto', 'auto']);
  });
});
