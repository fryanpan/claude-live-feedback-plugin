import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The reassign menu's SHAPE, read off the cascade rather than out of the
 * stylesheet's text.
 *
 * The old version of this file matched source: it found the `@media
 * (max-width: 560px)` block, checked the declarations inside it, and then
 * asserted SOURCE ORDER separately, because a media query adds no specificity
 * and order is the whole of the fight. Measuring the element at 430px settles
 * all three at once — if the sheet loses the fight, the computed value says
 * so, whatever the source looks like.
 *
 * `bun run ui:shot` still owns what happy-dom cannot resolve, and two things
 * that used to be asserted here are now among them (see the notes below):
 * the `::after` hit-box overlay on a touch pointer, and the `?` the unsure
 * chip draws in `::before` — pseudo-element styles come back empty.
 */

let cleanup = () => {};
beforeEach(() => {
  // The review editor's page loads styles.css; the board loads board.css before
  // it (`renderBoardShell`, packages/server/src/shells.ts). tokens.css is left
  // out on purpose: the served sheet is the vendored Open Props subset
  // concatenated with src/tokens.css, and the mapping layer alone resolves its
  // `var(--gray-9)` chain to nothing, which would blank every colour below.
  cleanup = installSheets('board.css', 'styles.css', 'doc.css');
});
afterEach(() => {
  cleanup();
  setPointer('fine');
  document.documentElement.style.removeProperty('--kb-bottom');
  document.body.replaceChildren();
});

/**
 * Make the media features a touch device reports match.
 *
 * happy-dom answers `(pointer: coarse)` and `(hover: none)` from
 * `navigator.maxTouchPoints`, which is a WINDOW-wide setting rather than
 * something `setViewport` carries — so it is set and reset explicitly, and
 * `afterEach` puts it back or the next file in the same worker inherits a
 * touch device.
 */
function setPointer(kind: 'fine' | 'coarse'): void {
  (
    window as unknown as { happyDOM: { settings: { navigator: { maxTouchPoints: number } } } }
  ).happyDOM.settings.navigator.maxTouchPoints = kind === 'coarse' ? 5 : 0;
}

/** A speaker tag as the editor renders it: `#editor > .ProseMirror > a`. */
function speakerTag(href: string): HTMLElement {
  const editor = attach('', { attrs: { id: 'editor' } });
  const prose = attach('ProseMirror', { parent: editor });
  return attach('', { tag: 'a', parent: prose, attrs: { href } });
}

describe('the reassign menu in the stylesheet', () => {
  it('becomes a bottom sheet at phone width, beating the inline placement', () => {
    setViewport(PHONE);
    const menu = styleOf(attach('speaker-menu'));
    expect(menu.position).toBe('fixed');
    // The inline placement JS writes top/left; the sheet has to win, and
    // `top: auto` / `left: 0` computed IS that fight's verdict — which is why
    // the separate "declared after the base rule" source-order test this file
    // used to carry is gone: order is one of the things being measured.
    expect(menu.top).toBe('auto');
    expect(menu.left).toBe('0px');
    // Pinned to the bottom, like the threads sheet.
    expect(menu.bottom).toBe('0px');
  });

  it('rides above the keyboard rather than behind it', () => {
    // `bottom: var(--kb-bottom, 0px)` — the same variable the threads pane
    // uses. A menu behind the keyboard cannot be tapped, so what matters is
    // that the sheet MOVES when that variable does, not that the declaration
    // mentions it.
    setViewport(PHONE);
    document.documentElement.style.setProperty('--kb-bottom', '291px');
    expect(styleOf(attach('speaker-menu')).bottom).toBe('291px');
  });

  it('stays an anchored popover on a pointer', () => {
    setViewport(IPAD);
    const menu = styleOf(attach('speaker-menu'));
    expect(menu.position).toBe('absolute');
    expect(menu.top).not.toBe('auto');
  });

  it('dims the page behind the sheet, and only there', () => {
    setViewport(PHONE);
    expect(styleOf(attach('speaker-menu-scrim')).backgroundColor).not.toBe('');
    // On a pointer the scrim only catches the dismissing click; a dimmed
    // page for a small menu next to the cursor would be a modal, and this
    // is not one.
    setViewport(IPAD);
    const wide = styleOf(attach('speaker-menu-scrim'));
    expect(wide.backgroundColor).toBe('');
    // Control: the scrim is still styled at this width, so the emptiness above
    // is the absence of a colour and not of the rule.
    expect(wide.position).toBe('fixed');
  });

  it('makes the tag itself look like the control it now is', () => {
    setViewport(IPAD);
    expect(styleOf(speakerTag('speaker:Cara')).cursor).toBe('pointer');
  });

  it('gives the tag a positioned box on a touch pointer only', () => {
    // An inline chip is ~23px tall, under a fingertip. On a touch pointer the
    // hit box grows past the ink via an `::after` overlay, which needs the
    // chip to be a containing block — and the same overlay on a mouse would
    // reach into neighbouring lines and steal their tags' clicks, so it is
    // touch-only.
    //
    // The overlay's own `inset: -10px -3px` is NOT asserted here and was in
    // the text version: happy-dom returns nothing for `::after`. The half that
    // is measurable is the anchor it hangs off, and its tier.
    setViewport(PHONE);
    setPointer('coarse');
    expect(styleOf(speakerTag('speaker:Cara')).position).toBe('relative');
    setPointer('fine');
    expect(styleOf(speakerTag('speaker:Cara')).position).toBe('');
  });
});

describe('an attribution the engine could not settle', () => {
  const UNSURE = 'speaker:Cara?unsure=1';

  it('is marked in the chip, not only in the href', () => {
    // The href says `unsure=1` and a reader of the raw .md can see it; a
    // reader of the DOC sees only what the stylesheet draws, so the mark has
    // to reach the chip or the correction is invisible to the person it is
    // for. Measured as a DIFFERENCE from a settled chip, which is also what
    // the old "declared after the base rule" source-order test was for.
    setViewport(IPAD);
    const unsure = styleOf(speakerTag(UNSURE));
    const settled = styleOf(speakerTag('speaker:Cara'));
    expect(unsure.color).not.toBe('');
    expect(unsure.color).not.toBe(settled.color);
    // The warning colour the rest of the app uses, resolved through its token.
    expect(unsure.color).toBe(
      styleOf(document.documentElement).getPropertyValue('--warn-fg').trim(),
    );
    // NOT asserted, and dropped from the text version: the `?` the chip draws
    // in `::before`. happy-dom returns an empty declaration for a pseudo
    // element, so the glyph is a `bun run ui:shot` check.
  });

  it('does not grow the chip box the touch target is measured against', () => {
    // The mobile hit area is an overlay on the chip's own box. A border
    // would move that box; an inset shadow draws the same ring and does not.
    setViewport(IPAD);
    const unsure = styleOf(speakerTag(UNSURE));
    expect(unsure.boxShadow).toContain('inset');
    expect(unsure.borderTopWidth === '' || unsure.borderTopWidth === '0px').toBe(true);
    // Control: a settled chip carries no such ring, so the shadow above is the
    // unsure rule's and not the base chip's.
    expect(styleOf(speakerTag('speaker:Cara')).boxShadow).toBe('');
  });
});
