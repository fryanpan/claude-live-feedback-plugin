import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BALLOON_ROOM_QUERY,
  BALLOON_SHEET_QUERY,
  PLACEMENT_CHANGED_EVENT,
  PLACEMENT_PREF_KEY,
  applyPlacement,
  balloonMarginVisible,
  balloonsBecomeSheet,
  cardPlacement,
  inlineCardsVisible,
  otherPlacement,
  placementToggleLabel,
  readStoredPlacement,
  resolvePlacement,
  setCardPlacement,
} from '../src/card-placement.ts';
import { PHONE, setViewport } from './css-harness.ts';

/**
 * Where comment cards live is the READER's stored choice, and width only
 * picks the default. These drive the module rather than reading it: the
 * whole point of the change is that a zoomed iPad keeps the choice its owner
 * made, which is a behaviour, not a selector.
 */

afterEach(() => {
  try {
    localStorage.removeItem(PLACEMENT_PREF_KEY);
  } catch {
    // nothing stored to clear
  }
  document.body.removeAttribute('data-cards');
  vi.restoreAllMocks();
  setViewport({ width: 1024, height: 768 });
});

describe('resolvePlacement — stored choice beats the width default', () => {
  it('takes the width default when nothing is stored', () => {
    expect(resolvePlacement(null, true)).toBe('balloon');
    expect(resolvePlacement(null, false)).toBe('inline');
  });

  it('honours a stored choice at BOTH widths, in both directions', () => {
    // This is the whole feature: a reader who picked inline keeps inline on a
    // wide screen, and a reader who picked balloons keeps balloons on a
    // narrow one. A media query can express neither.
    expect(resolvePlacement('inline', true)).toBe('inline');
    expect(resolvePlacement('balloon', false)).toBe('balloon');
  });

  it('falls back to the width default for a value it cannot name', () => {
    // A truncated write or a token from a future version must not resolve to
    // a placement no surface implements.
    expect(resolvePlacement('ballo', true)).toBe('balloon');
    expect(resolvePlacement('', false)).toBe('inline');
    expect(resolvePlacement('sheet', false)).toBe('inline');
  });
});

describe('the two surface predicates', () => {
  function widthIs(width: number): void {
    setViewport({ width, height: 820 });
  }

  it('at 1180 with nothing stored: balloons, no inline cards', () => {
    widthIs(1180);
    expect(cardPlacement()).toBe('balloon');
    expect(balloonMarginVisible()).toBe(true);
    expect(inlineCardsVisible()).toBe(false);
  });

  it('at 430 with nothing stored: inline cards, no margin', () => {
    widthIs(430);
    expect(cardPlacement()).toBe('inline');
    expect(inlineCardsVisible()).toBe(true);
    expect(balloonMarginVisible()).toBe(false);
  });

  it('a stored choice moves the cards at a width that would have chosen the other', () => {
    widthIs(1180);
    setCardPlacement('inline');
    expect(inlineCardsVisible()).toBe(true);
    expect(balloonMarginVisible()).toBe(false);
  });

  it('balloons stored on a narrow screen become the sheet — no margin, no inline card', () => {
    // The mock's rule: under 900px there is no margin to ride in, so the
    // over-doc sheet is the comment surface. Neither in-flow surface renders.
    setViewport(PHONE);
    setCardPlacement('balloon');
    expect(cardPlacement()).toBe('balloon');
    expect(balloonsBecomeSheet()).toBe(true);
    expect(balloonMarginVisible()).toBe(false);
    expect(inlineCardsVisible()).toBe(false);
  });

  it('the two queries meet without a gap: 901–1100 has a margin only by choice', () => {
    // Positive control for the pair of constants — 1000px is below the
    // balloon default and above the sheet floor.
    widthIs(1000);
    expect(BALLOON_ROOM_QUERY).toBe('(min-width: 1101px)');
    expect(BALLOON_SHEET_QUERY).toBe('(max-width: 900px)');
    expect(cardPlacement()).toBe('inline');
    setCardPlacement('balloon');
    expect(balloonMarginVisible()).toBe(true);
  });
});

describe('storing, publishing and announcing', () => {
  beforeEach(() => {
    setViewport({ width: 1180, height: 820 });
  });

  it('writes the choice, publishes it on the body and announces it', () => {
    const heard: string[] = [];
    const listener = (ev: Event) => heard.push(String((ev as CustomEvent).detail));
    window.addEventListener(PLACEMENT_CHANGED_EVENT, listener);
    setCardPlacement('inline');
    window.removeEventListener(PLACEMENT_CHANGED_EVENT, listener);

    expect(readStoredPlacement()).toBe('inline');
    expect(document.body.dataset.cards).toBe('inline');
    expect(heard).toEqual(['inline']);
  });

  it('still applies the choice for this page when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    expect(() => setCardPlacement('inline')).not.toThrow();
    expect(document.body.dataset.cards).toBe('inline');
  });

  it('reads as null rather than throwing when storage is unavailable', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(readStoredPlacement()).toBeNull();
    // The width default still applies, so the page is never placement-less.
    expect(cardPlacement()).toBe('balloon');
  });

  it('applyPlacement with no argument publishes the placement in force', () => {
    applyPlacement();
    expect(document.body.dataset.cards).toBe('balloon');
  });
});

describe('the toggle control', () => {
  it('flips between the two placements', () => {
    expect(otherPlacement('inline')).toBe('balloon');
    expect(otherPlacement('balloon')).toBe('inline');
  });

  it('names the destination, not the current state, in both faces', () => {
    const inFlow = placementToggleLabel('inline');
    const inMargin = placementToggleLabel('balloon');
    expect(inFlow.title).toContain('to the margin');
    expect(inMargin.title).toContain('into the flow');
    // The two faces are actually different — a label that never changed
    // would satisfy a weaker assertion than this.
    expect(inFlow.glyph).not.toBe(inMargin.glyph);
    expect(inFlow.ariaLabel).not.toBe(inMargin.ariaLabel);
  });

  it('describes the sheet as a sheet, never as a margin that is not there', () => {
    // The stored choice and the surface differ in exactly one state, and the
    // button was wrong for all of it: at 430px with balloons stored nothing
    // renders in the flow and there is no margin, while the control said
    // "Comments in the margin" and announced the right margin as fact.
    const sheet = placementToggleLabel('sheet');
    expect(sheet.title).toContain('sheet');
    expect(sheet.title).not.toContain('margin');
    expect(sheet.ariaLabel).not.toContain('margin');
    // Still an offer to move into the flow, because the stored choice is
    // untouched and that is what tapping does.
    expect(sheet.title).toContain('into the flow');
    // Its own face, so a reader can tell the three states apart.
    const others = [placementToggleLabel('inline'), placementToggleLabel('balloon')];
    for (const other of others) {
      expect(sheet.glyph).not.toBe(other.glyph);
      expect(sheet.ariaLabel).not.toBe(other.ariaLabel);
    }
  });
});
