import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * `doc.css` — the review editor's own surfaces, split out of `styles.css`.
 *
 * Three questions decide whether that split was safe, and this file asks all
 * three against the CASCADE rather than against either file's text:
 *
 *  1. A rule that moved still reaches its element on the review editor's
 *     page, which loads `styles.css` then `doc.css`.
 *  2. A rule that moved reaches NOTHING on the board, which loads
 *     `hub.css` then `styles.css` and never names `doc.css` — with a
 *     positive control, because an element no rule reaches satisfies almost
 *     any negative on its own.
 *  3. The link ORDER is load-bearing. `doc.css` sat interleaved through
 *     `styles.css`, so loading it second preserves every tie and loading it
 *     first flips twenty. The two `@media (max-width: 900px)` overrides
 *     below are two of those twenty: read them the wrong way round and the
 *     phone's comment sheet goes back to being a desktop side panel.
 *
 * SHEETS: `styles.css` then `doc.css` — the order `index.html` links them.
 * `tokens.css` is left out (the served file is a vendored Open Props subset
 * plus `src/tokens.css`, and the mapping half alone re-points every remapped
 * token at an undefined `var(--gray-N)`), so the assertions here are on
 * layout and box properties rather than on colours.
 */

let cleanup = () => {};
afterEach(() => cleanup());

describe('the editor page keeps every surface that moved', () => {
  beforeEach(() => {
    cleanup = installSheets('styles.css', 'doc.css');
    setViewport(IPAD);
  });

  it('lays #main out as the two-column review grid (MAIN LAYOUT)', () => {
    const main = attach('', { attrs: { id: 'main' } });
    const s = styleOf(main);
    expect(s.display).toBe('grid');
    expect(s.position).toBe('relative');
    expect(s.overflow).toBe('hidden');
  });

  it('indents one notch per nesting level in the file tree (WORKSPACE FILE TREE)', () => {
    const root = attach('tree-root', { tag: 'ul' });
    const nested = attach('', { tag: 'ul', parent: root });
    expect(styleOf(root).paddingLeft).toBe('0px');
    expect(styleOf(nested).paddingLeft).toBe('12px');
  });

  it('gives the format bar its wrapping row and its 44px floor (FORMAT BAR)', () => {
    const bar = attach('format-bar');
    const s = styleOf(bar);
    expect(s.display).toBe('flex');
    expect(s.flexWrap).toBe('wrap');
    expect(s.minHeight).toBe('44px');
  });

  it('keeps the meeting strip a flex row (MEETING RECORD CHROME)', () => {
    const strip = attach('meeting-strip');
    const s = styleOf(strip);
    expect(s.display).toBe('flex');
    expect(s.alignItems).toBe('center');
  });

  it('pins the diff nav toggle to the top of its column (DIFF NAV)', () => {
    const nav = attach('diff-nav-toggle');
    const s = styleOf(nav);
    expect(s.position).toBe('sticky');
    expect(s.display).toBe('flex');
  });

  it('boxes the in-flow comment card so code cannot widen it (INLINE THREAD CARDS)', () => {
    const card = attach('lf-inline-card');
    const s = styleOf(card);
    // Code scrolls sideways; the card is clamped so a comment on a long line
    // never needs a horizontal scroll of its own.
    expect(s.maxWidth).toBe('100%');
    expect(s.paddingTop).toBe('10px');
  });

  it('still paints the line chip on the editor page, where the split moved it', () => {
    // `.thread-line` is the one rule whose POSITION changed rather than its
    // file: every other rule was lifted in source order, but this one was
    // authored under the diff nav — a banner that went to doc.css whole — and
    // had to stay in the shared base, so it landed under the comment chrome
    // instead. That hop jumped it over the composers, the toast and the
    // banners. The editor page is where both sides of the hop are loaded, so
    // it is where a value would change if anything it passed could tie.
    const chip = attach('thread-line', { tag: 'span' });
    const s = styleOf(chip);
    expect(s.display).toBe('inline-block');
    expect(s.whiteSpace).toBe('nowrap');
    expect(s.marginRight).toBe('6px');
  });
});

describe('the board never loads doc.css, and loses nothing by it', () => {
  beforeEach(() => {
    // The order `renderHubShell` links them (packages/server/src/shells.ts).
    cleanup = installSheets('hub.css', 'styles.css');
    setViewport(IPAD);
  });

  it('leaves the editor-only surfaces unpainted on a board page', () => {
    expect(styleOf(attach('meeting-strip')).display).not.toBe('flex');
    expect(styleOf(attach('format-bar')).minHeight).not.toBe('44px');
    expect(styleOf(attach('diff-nav-toggle')).position).not.toBe('sticky');
    expect(styleOf(attach('lf-inline-card')).maxWidth).not.toBe('100%');
  });

  it('positive control: the shared chrome in styles.css still reaches the board', () => {
    // Without this, the negatives above are satisfied by an empty document
    // head — "no rule applied" would prove nothing about which file the rule
    // is in.
    expect(styleOf(attach('', { attrs: { id: 'toast' } })).position).toBe('fixed');
    const banner = styleOf(attach('conn-banner'));
    expect(banner.textAlign).toBe('center');
    expect(banner.fontWeight).toBe('600');
  });

  it('paints a pending suggestion, because the board mounts the same editor', () => {
    // The converse of the negatives above, and the check that would have
    // caught this: the board's task-body editor IS `createEditor` over the
    // `task:<id>` room (hub/task-body-editor.ts), and editor.ts registers
    // SuggestInsert, SuggestDelete and SuggestionChips in the BASE extension
    // list with no review-surface condition. So an agent's pending suggestion
    // on a task description renders here, and its rules have to be in the
    // board's cascade. Send them to doc.css and the proposal reads as plain
    // accepted prose — indistinguishable from text Bryan already agreed to.
    //
    // The underline and the strikethrough are what this asserts, not the
    // tint: color never carries the meaning alone here, and the tint is a
    // `color-mix()` happy-dom cannot resolve anyway. happy-dom does not
    // expand the shorthand, so `textDecoration` is the property that answers
    // — `textDecorationLine` reads `''` even when the rule applies.
    const editor = attach('ProseMirror');
    const ins = attach('lf-suggest-ins', { tag: 'span', parent: editor });
    expect(styleOf(ins).textDecoration).toBe('underline');
    const del = attach('lf-suggest-del', { tag: 'span', parent: editor });
    expect(styleOf(del).textDecoration).toBe('line-through');
  });

  it('hides the ✎ suggestion chip, which is the half that must not go missing', () => {
    // SuggestionChips always builds the chip; CSS alone decides whether it
    // shows, so the DEFAULT is what the board cannot do without. Lose it and
    // an unstyled `<button>✎ suggestion</button>` appears in the task detail
    // panel at every width — the failure inverts rather than disappearing,
    // which is why the negatives above do not cover this.
    expect(styleOf(attach('lf-suggest-chip', { tag: 'button' })).display).toBe('none');
  });

  it('keeps .thread-line in the shared base, because the board renders it too', () => {
    // The chip is authored beside the diff nav that mints it, so the obvious
    // split sends it to doc.css. The board puts the same chip on a task
    // discussion (`thread-line` in hub.js), which is how B2 lost
    // `.signin-bar` for a release — a rule can sit under one page's banner
    // and be reached by another.
    const chip = attach('thread-line', { tag: 'span' });
    const s = styleOf(chip);
    expect(s.display).toBe('inline-block');
    expect(s.whiteSpace).toBe('nowrap');
  });
});

describe('doc.css loads AFTER styles.css, and the phone proves it', () => {
  it('lets the over-doc sheet beat the desktop drawer at 430px', () => {
    // `#threads-pane { position: relative }` is in styles.css; the sheet's
    // `position: fixed` is in doc.css, inside `@media (max-width: 900px)`.
    // Same specificity, same property — document order is the only thing
    // that decides, and the page's order is styles.css first.
    cleanup = installSheets('styles.css', 'doc.css');
    setViewport(PHONE);
    expect(styleOf(attach('', { attrs: { id: 'threads-pane' } })).position).toBe('fixed');
    // The close button is the same tie read the other way: none → inline-flex.
    expect(styleOf(attach('threads-close', { tag: 'button' })).display).toBe('inline-flex');
  });

  it('reads the other way round when the sheets are installed the other way round', () => {
    // The control that makes the assertion above discriminating: install
    // doc.css FIRST and both ties change hands. This is what the shell would
    // ship if the two <link> tags were swapped, and it is why index.html
    // carries a comment saying not to.
    cleanup = installSheets('doc.css', 'styles.css');
    setViewport(PHONE);
    expect(styleOf(attach('', { attrs: { id: 'threads-pane' } })).position).toBe('relative');
    expect(styleOf(attach('threads-close', { tag: 'button' })).display).toBe('none');
  });

  it('still hides the close button on the iPad, where the drawer is a column', () => {
    cleanup = installSheets('styles.css', 'doc.css');
    setViewport(IPAD);
    expect(styleOf(attach('threads-close', { tag: 'button' })).display).toBe('none');
  });
});

describe('the two surfaces agree about the chip, at both widths', () => {
  /**
   * The chip's rules are split across the two files — the ≤1100px entry and
   * the base rule are in `styles.css` (both pages get them), the matching
   * `.lf-del-chip` pair stays in `doc.css` — so "does the board read what the
   * editor reads" is a question with two answers to compare, not one value to
   * assert. This is the case that stays honest if the ordering below is ever
   * changed on purpose.
   *
   * What it reads TODAY is `none` at both widths, on both pages. That is what
   * `origin/main` served from the single file and it is deliberate here: the
   * ≤1100px `display: inline-flex` is authored BEFORE the base
   * `display: none`, same specificity, so the base wins everywhere and the
   * mobile chip never appears. `.lf-del-chip` has the identical shape in
   * `doc.css`. Revealing either one is a product change; this split does not
   * make it.
   */
  const readChip = (sheets: Parameters<typeof installSheets>) => {
    cleanup = installSheets(...sheets);
    setViewport(IPAD);
    const ipad = styleOf(attach('lf-suggest-chip', { tag: 'button' })).display;
    setViewport(PHONE);
    const phone = styleOf(attach('lf-suggest-chip', { tag: 'button' })).display;
    cleanup();
    cleanup = () => {};
    document.body.replaceChildren();
    return { ipad, phone };
  };

  it('reads the same on the board as on the review editor', () => {
    const board = readChip(['hub.css', 'styles.css']);
    const editor = readChip(['styles.css', 'doc.css']);
    expect(board).toEqual(editor);
    expect(board).toEqual({ ipad: 'none', phone: 'none' });
  });
});
