import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';
import { BOARD_BOOT_SOURCES } from './support/board-boot-sources.ts';

/**
 * The mic is drawn the way the rest of the chrome is drawn.
 *
 * From the #250 fresh-eyes pass: the glyph was `🎙` — a colour emoji at 19px
 * in the system font stack — while every nav icon beside it is a stroked
 * 24×24 SVG on `currentColor`. It achieved "distinct" and read as unfinished,
 * on the one control Bryan reaches for most. Two more emoji mics were on the
 * same screen: the capture composer's `🎤` and the attachment's own `🎙`.
 *
 * The focus half of that pass was reported as a MISSING ring and is not one.
 * Measured 2026-08-21 in headless Chrome, ten Tab presses from the top of a
 * board: `#board-mic` matched `:focus-visible` and the UA drew
 * `outline: auto 1px rgb(0, 95, 204)`. What the rule below changes is the
 * COLOUR — the platform blue for the accent every other focusable here uses.
 * Written down because a test that asserts a ring exists would pass on main
 * just as happily, and would say nothing about why the rule was added. That
 * is why the ring is compared against its two siblings rather than against a
 * colour copied out of the ticket.
 *
 * What that ring must NOT do — fire on a bare `:focus`, so the press-and-hold
 * does not leave a ring behind after every utterance — stays a browser check.
 * happy-dom matches `:focus-visible` on a programmatic focus exactly as it
 * matches `:focus`, so the two are indistinguishable here; the separation is
 * only observable where a POINTER press can set one and not the other. The
 * old text version of this file asserted `.voice-mic:focus` was absent from
 * the stylesheet, which is the source-shape proxy this conversion drops.
 *
 * The stylesheet halves of this file used to be regexes over `styles.css` and
 * `board.css`; they are computed reads now. The MARKUP halves still read the app
 * source, because "which module mounts a mic" and "no emoji survives anywhere"
 * are facts about files, not about any one rendered element.
 */
const SRC = resolve(import.meta.dirname, '../src');
const ICONS = readFileSync(resolve(SRC, 'icons.ts'), 'utf8');
// The board's boot sources: `board-app.ts` and the three modules split out of
// it. Read as one string because these assertions are about the board's
// shape, not about which file a line ended up in — a move must not fail
// them, and an absence checked across all four is the stronger read.
const BOARD_APP = BOARD_BOOT_SOURCES.map((m) =>
  readFileSync(resolve(SRC, `board/${m}.ts`), 'utf8'),
).join('\n');
const BOARD_RENDER = readFileSync(resolve(SRC, 'board/board-render.ts'), 'utf8');

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css', 'doc.css');
  setViewport(IPAD);
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/**
 * The focus ring a control paints once it actually holds focus.
 *
 * `styleOf` cannot be used here: it drops happy-dom's computed-style cache by
 * detaching and re-attaching the node, and detaching a focused element BLURS
 * it — the ring vanishes before it can be read. So the element is built and
 * focused after the viewport is set and read once, straight, which is the
 * first read and therefore not a stale one. `:focus-visible` does match in
 * happy-dom; only `:hover` (which has no state to set) is out of reach.
 */
function ringOf(classes: string): string {
  const el = attach(classes, { tag: 'button' });
  el.focus();
  if (document.activeElement !== el) throw new Error(`.${classes} never took focus`);
  return getComputedStyle(el).outline;
}

/**
 * Every mic-bearing module, and the string each one mounts.
 *
 * board-render.ts used to be here: the board's entry button wore the mic while
 * it was called "Start a planning huddle". The round-4 entry rework renamed
 * the two buttons after their OUTCOMES — "Make a plan" (pencil) and "Have a
 * discussion" (speech) — so neither is a mic any more, and the docked
 * hold-to-talk control is the only mic the board draws. The negative
 * assertion below is what keeps that from being a silent regression to an
 * emoji rather than a decision.
 */
const MOUNTS: ReadonlyArray<[string, string]> = [
  ['the board’s docked mic (board-app.ts)', BOARD_APP],
];

describe('the mic wears the nav’s icon convention', () => {
  it('draws it as a stroked, currentColor SVG like every other glyph', () => {
    expect(ICONS, 'icons.ts lost MIC_ICON').toMatch(/export const MIC_ICON\s*=/);
    const icon = /export const MIC_ICON\s*=\s*`([^`]*)`/.exec(ICONS)?.[1] ?? '';
    expect(icon).toContain('<svg');
    // The vocabulary, via the shared attribute strings rather than a hand copy
    // of them — a second copy is how one glyph keeps a stroke width the others
    // have moved off.
    expect(icon).toContain('${SVG}');
    expect(icon).toContain('${SVG_ENDS}');
    expect(ICONS).toMatch(/stroke="currentColor"/);
    expect(ICONS).toMatch(/fill="none"/);
    expect(ICONS).toMatch(/viewBox="0 0 24 24"/);
  });

  it('is the single source every mic mounts', () => {
    for (const [where, src] of MOUNTS) {
      expect(src, `${where} does not use MIC_ICON`).toContain('MIC_ICON');
      expect(src, `${where} still imports nothing from icons.ts`).toMatch(
        /from '\.\.?\/(\.\.\/)?icons\.ts'/,
      );
    }
  });

  it('leaves no emoji mic anywhere in the app source', () => {
    // Positive control first: this sweep really is reading the files that used
    // to hold them, and really can see a glyph in them.
    for (const [where, src] of MOUNTS) {
      expect(src, `${where} is not the module that mounts a mic`).toMatch(
        /voice-mic|board-huddle-start|doc-mic/,
      );
      expect(src, `${where} still ships an emoji mic`).not.toMatch(/\u{1F399}|\u{1F3A4}/u);
    }
    // The board's entry buttons dropped the mic when they were renamed after
    // their outcomes; what they must never do is grow an emoji one back.
    expect(BOARD_RENDER, 'the board’s entry buttons ship an emoji mic').not.toMatch(
      /\u{1F399}|\u{1F3A4}/u,
    );
    // Control for that negative: the file really is the one drawing them.
    expect(BOARD_RENDER).toMatch(/board-huddle-start/);
  });

  it('sizes the glyph as a box, because a font-size no longer scales it', () => {
    // `.voice-mic` carried `font-size: 19px` and `.board-quick-mic` carried 16px
    // to size an emoji. An SVG ignores both, so leaving them set is how the
    // next reader concludes the glyph is still text. A button with no
    // font-size of its own computes `inherit` here; one that declares a size
    // computes the pixels — which is what the control below pins.
    for (const host of ['voice-mic', 'board-huddle-start']) {
      const button = attach(host, { tag: 'button' });
      const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      button.appendChild(glyph);
      expect(styleOf(button).fontSize, `.${host} still sizes a glyph as text`).toBe('inherit');
      const box = styleOf(glyph);
      expect(
        Number.parseFloat(box.width),
        `.${host} svg has no box, so the glyph sizes itself`,
      ).toBeGreaterThan(0);
      expect(Number.parseFloat(box.height)).toBeGreaterThan(0);
    }
    // Controls: a glyph in a button nobody styles is left at its intrinsic
    // size — the failure the rule above prevents — and a rule that DOES set a
    // font-size reads as pixels, so the `inherit` reads are not vacuous.
    const stray = attach('voice-mic-nonexistent', { tag: 'button' });
    const strayGlyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stray.appendChild(strayGlyph);
    expect(styleOf(strayGlyph).width).toBe('');
    expect(styleOf(attach('meeting-speaker-pill', { tag: 'span' })).fontSize).toMatch(/px$/);
  });
});

describe('the mic focuses in the same colour as its neighbours', () => {
  it('paints the accent ring the rest of the chrome paints', () => {
    // Not a colour copied from the ticket: the mic's ring is compared with
    // the two siblings whose ring it was written to match, so a token that
    // moves takes all three with it or fails here.
    const mic = ringOf('voice-mic');
    expect(mic).not.toBe('');
    expect(mic).toBe(ringOf('doc-switcher'));
    expect(mic).toBe(ringOf('thread-caret'));
    // …and it is 2px of the accent rather than the UA's own hairline.
    expect(mic).toContain('2px');
    expect(mic).toContain(styleOf(document.documentElement).getPropertyValue('--accent'));
  });
});
