import { describe, expect, it } from 'vitest';
import {
  CARET_MARGIN,
  type CaretBand,
  caretScrollDelta,
  isTextEntry,
  stripYield,
} from '../src/edit-viewport.ts';

/**
 * The two decisions behind "editing on a phone is not broken": whether the
 * meeting strip gives its row back, and how far the caret has to move to get
 * out from under the keyboard. Both are pure; the wiring that calls them
 * needs a real browser and is verified in a browser (see the PR body).
 */

describe('stripYield — does the voice strip give its row back?', () => {
  it('keeps the strip whenever nothing is being edited', () => {
    expect(stripYield({ narrow: true, editing: false, live: false })).toBe('full');
    expect(stripYield({ narrow: true, editing: false, live: true })).toBe('full');
  });

  it('keeps the strip above the phone breakpoint, editing or not', () => {
    // The iPad reads a 40px bar, not the stacked panel, and its complaint has
    // never been this one. Yielding there would spend a change on a width
    // nobody reported.
    expect(stripYield({ narrow: false, editing: true, live: false })).toBe('full');
    expect(stripYield({ narrow: false, editing: true, live: true })).toBe('full');
  });

  it('hides an idle strip while a phone-width editor has focus', () => {
    expect(stripYield({ narrow: true, editing: true, live: false })).toBe('hidden');
  });

  it('collapses rather than hides a strip that is RECORDING', () => {
    // A live mic with no indicator on screen is the one thing this must not
    // do, however much room the keyboard wants.
    expect(stripYield({ narrow: true, editing: true, live: true })).toBe('compact');
  });
});

const band = (over: Partial<CaretBand> = {}): CaretBand => ({
  // An iPhone 16 Pro Max in portrait with the keyboard up: 932px window,
  // visual viewport 932 - 336 = 596, less the 46px accessory bar = 550.
  // The scroller runs from under the format bar to the window's bottom, so
  // the keyboard is what closes the band here.
  caretTop: 400,
  caretBottom: 424,
  vvTop: 0,
  vvBottom: 550,
  viewTop: 48,
  viewBottom: 932,
  margin: CARET_MARGIN,
  scrollTop: 500,
  scrollMax: 4000,
  ...over,
});

describe('caretScrollDelta — keeping the caret above the keyboard', () => {
  it('leaves a caret that is already in the visible band alone', () => {
    // Every keystroke calls this. A caret that is fine must not be nudged.
    expect(caretScrollDelta(band())).toBe(0);
  });

  it('scrolls a caret that the keyboard is covering up into the band', () => {
    // Caret bottom 700 against a band ending at 550 - 26.
    const d = caretScrollDelta(band({ caretTop: 676, caretBottom: 700 }));
    expect(d).toBe(700 - (550 - CARET_MARGIN));
    expect(d).toBeGreaterThan(0);
  });

  it('scrolls back DOWN for a caret above the band', () => {
    // Band top is the scroller's own top (48, under the format bar) + margin.
    const d = caretScrollDelta(band({ caretTop: 4, caretBottom: 28 }));
    expect(d).toBe(4 - (48 + CARET_MARGIN));
    expect(d).toBeLessThan(0);
  });

  it('measures the band from the visual viewport offset, not the window top', () => {
    // iOS scrolls the layout viewport under the visual one; a band computed
    // from 0 would be off by exactly that much.
    const d = caretScrollDelta(
      band({ vvTop: 120, vvBottom: 670, caretTop: 796, caretBottom: 820 }),
    );
    expect(d).toBe(820 - (670 - CARET_MARGIN));
  });

  it('takes the band from the SCROLLER when the scroller is the shorter one', () => {
    // A recording meeting strip takes its row back mid-edit: the window is
    // unchanged, `#editor` gets shorter, and a caret measured against the
    // window alone reads as fine while sitting below the scroller's clip box.
    // Measured in a browser: strip bottom edge at 505 against a 550 band.
    const d = caretScrollDelta(band({ viewBottom: 505, caretTop: 511, caretBottom: 531 }));
    expect(d).toBe(531 - (505 - CARET_MARGIN));
    expect(d).toBeGreaterThan(0);
  });

  it('scrolls a caret hidden under the format bar back down into view', () => {
    expect(caretScrollDelta(band({ viewTop: 48, caretTop: 50, caretBottom: 70 }))).toBe(
      50 - (48 + CARET_MARGIN),
    );
  });

  it('does nothing when the band has collapsed to nothing', () => {
    // A keyboard taller than the scroller. There is no position to aim at, and
    // aiming anyway would jump the document for no visible gain.
    expect(caretScrollDelta(band({ viewTop: 400, vvBottom: 420, caretBottom: 900 }))).toBe(0);
  });

  it('clamps to the scroll the container can actually do — the LAST LINE', () => {
    // The bug's hardest case: caret under the keyboard, scroller at its
    // maximum. Without runway there is nothing to give, and this must say so
    // rather than report a scroll that will not happen.
    expect(
      caretScrollDelta(band({ caretTop: 676, caretBottom: 700, scrollTop: 4000, scrollMax: 4000 })),
    ).toBe(0);
    // With the runway `#editor`'s keyboard-aware bottom padding adds, the same
    // caret moves the whole way.
    expect(
      caretScrollDelta(band({ caretTop: 676, caretBottom: 700, scrollTop: 4000, scrollMax: 4382 })),
    ).toBe(700 - (550 - CARET_MARGIN));
  });

  it('never scrolls a container that is already at the top past it', () => {
    expect(caretScrollDelta(band({ caretTop: 4, caretBottom: 28, scrollTop: 0 }))).toBe(0);
    expect(caretScrollDelta(band({ caretTop: 4, caretBottom: 28, scrollTop: 10 }))).toBe(-10);
    // …and the full move once there is room for all of it.
    expect(caretScrollDelta(band({ caretTop: 4, caretBottom: 28, scrollTop: 900 }))).toBe(-70);
  });
});

describe('isTextEntry — what counts as an editor holding focus', () => {
  function make(html: string): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = html;
    return host.firstElementChild as HTMLElement;
  }

  it('accepts the surfaces that open a keyboard', () => {
    const ce = make('<div contenteditable="true"></div>');
    // happy-dom does not derive isContentEditable from the attribute.
    Object.defineProperty(ce, 'isContentEditable', { value: true });
    expect(isTextEntry(ce)).toBe(true);
    expect(isTextEntry(make('<textarea></textarea>'))).toBe(true);
    expect(isTextEntry(make('<input type="text">'))).toBe(true);
    expect(isTextEntry(make('<input>'))).toBe(true);
  });

  it('rejects controls that are inputs in name only, and nothing at all', () => {
    expect(isTextEntry(make('<input type="checkbox">'))).toBe(false);
    expect(isTextEntry(make('<input type="range">'))).toBe(false);
    expect(isTextEntry(make('<button>Start</button>'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
  });
});
