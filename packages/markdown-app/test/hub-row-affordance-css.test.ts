import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The task row's two hover affordances, in CSS.
 *
 * Bryan, 2026-08-21, on the title: *"entering edit mode must NOT shift the
 * text — zero layout jump"*, and *"hovering over the title TEXT shows a subtle
 * rectangle around it … on click the rectangle goes away — you're left with
 * just the text caret at the click position."*
 *
 * Zero shift is structural in TS — the words are edited in place, so no
 * element is swapped and no box is rebuilt (`hub-render.test.ts`, "edits the
 * words where they are"). What CSS can still undo is exactly that: a border,
 * a padding, a font or a margin added for the hover or the editing state puts
 * the jump straight back, and it would do so ONLY in a browser, where these
 * tests do not run. So the rules are read as text and the forbidden
 * properties named — happy-dom has no layout engine and no media queries, so
 * an assertion about a rendered pixel here would be an assertion about
 * nothing.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** The declarations of the first rule whose selector list contains `sel`. */
function block(sel: string): string {
  const at = CSS.indexOf(sel);
  expect(at, `no rule for ${sel}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

/**
 * Anything that occupies space. `outline` is the one border-like paint that
 * does not, which is why the rectangle is drawn with it.
 */
const TAKES_SPACE = ['border', 'padding', 'margin', 'font', 'line-height', 'width', 'height'];

describe('the row title, hovered and edited', () => {
  it('draws the hover rectangle with an outline, and reserves it when resting', () => {
    // Declared transparent rather than absent: the hover then changes a colour
    // and nothing else, and — the half that is easy to lose — the declaration
    // is already there to beat the UA focus ring when this span takes focus.
    const base = block('.hub-task-title-text {');
    expect(base).toMatch(/outline:\s*1px solid transparent/);
    expect(base).toContain('outline-offset');
    for (const prop of TAKES_SPACE) expect(base).not.toContain(`${prop}:`);

    // The hover itself, inside the fine-pointer query, changing colour only.
    const hover = block('.hub-task-title-text:hover {');
    expect(hover).toContain('outline-color:');
    for (const prop of TAKES_SPACE) expect(hover).not.toContain(`${prop}:`);
    // The dotted underline this replaced is gone: it was a decoration on the
    // text, not a rectangle around it, and Bryan asked for the rectangle.
    expect(hover).not.toContain('text-decoration');
  });

  it('scopes the rectangle to the pointer that can hover', () => {
    // The same question `finePointer()` asks in TS, and it must be the same
    // question: on a coarse pointer the words carry no rename at all, so a
    // rectangle there would advertise a gesture that does nothing.
    const query = '@media (hover: hover) and (pointer: fine) {';
    const at = CSS.indexOf(query);
    expect(at).toBeGreaterThan(-1);
    const scoped = CSS.slice(at, CSS.indexOf('\n}', at));
    expect(scoped).toContain('.hub-task-title-text:hover');
    expect(scoped).toContain('cursor: text');
  });

  it('takes the rectangle away while editing, and adds no box in its place', () => {
    const editingRule = block('.hub-task-title-text[contenteditable] {');
    expect(editingRule).toMatch(/outline-color:\s*transparent/);
    for (const prop of TAKES_SPACE) expect(editingRule).not.toContain(`${prop}:`);
    // …including when the pointer is still over the words it is editing, which
    // is the state a reader is actually in the instant after clicking. The
    // hover rule and this one have equal specificity, so the editing state
    // needs the extra `:hover` clause to win it.
    expect(CSS).toContain('.hub-task-title-text:hover[contenteditable]');
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
    const cell = block('.hub-task-title {');
    const pad = /padding:\s*(\d+)px;/.exec(cell)?.[1];
    const mar = /margin:\s*-(\d+)px;/.exec(cell)?.[1];
    expect(pad).toBeDefined();
    expect(mar).toBe(pad);
    // …and enough of it: the outline sits `outline-offset` away from the words
    // and is `outline-width` thick, so anything less clips it again.
    const base = block('.hub-task-title-text {');
    const offset = Number(/outline-offset:\s*(\d+)px/.exec(base)?.[1]);
    const width = Number(/outline:\s*(\d+)px/.exec(base)?.[1]);
    expect(Number(pad)).toBeGreaterThanOrEqual(offset + width);
    // The ellipsis is why the clip is there at all, so it must still be.
    expect(cell).toContain('overflow: hidden');
  });

  it('stops truncating a title that is being typed into', () => {
    // An ellipsis over an open edit is a lie about the text: the reader is
    // typing into characters the row is still drawing as "…".
    expect(block('.hub-task-title.hub-title-editing {')).toContain('text-overflow: clip');
    // Positive control: the resting cell really does truncate, so the rule
    // above is turning something off rather than agreeing with the default.
    expect(block('.hub-task-title {')).toContain('text-overflow: ellipsis');
  });

  it('keeps one grid track per row child, with the flexible one under the title', () => {
    // Auto-placement fills CONSECUTIVE tracks, so the count here and the child
    // list in `hub-render.test.ts` are one fact in two files: six children,
    // six tracks, and the third — the title — is the one that flexes. Get the
    // count wrong and the title slides into a fixed track and renders at that
    // track's width on every row.
    const tracks = /grid-template-columns:([^;]*);/
      .exec(block('.hub-task-row {'))?.[1]
      .trim()
      .replace(/minmax\(0, 1fr\)/, 'FLEX')
      .split(/\s+/);
    expect(tracks).toEqual(['auto', 'auto', 'FLEX', 'auto', 'auto', 'auto']);
  });
});
