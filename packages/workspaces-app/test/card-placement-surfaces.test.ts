import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLACEMENT_PREF_KEY, applyPlacement, setCardPlacement } from '../src/card-placement.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * Which comment surface is actually on the page, read from the cascade.
 *
 * The rule these guard is the one that used to be a media query: exactly one
 * always-on comment surface, and the READER picks which. Asserting it through
 * the stylesheet rather than through `cardPlacement()` is the point — a
 * predicate that returns the right answer while `body[data-cards]` moves no
 * pixels is the failure this catches.
 */

let cleanupSheets: (() => void) | null = null;

beforeEach(() => {
  cleanupSheets = installSheets('styles.css', 'doc.css');
});

afterEach(() => {
  cleanupSheets?.();
  cleanupSheets = null;
  try {
    localStorage.removeItem(PLACEMENT_PREF_KEY);
  } catch {
    // nothing stored
  }
  document.body.removeAttribute('data-cards');
  for (const n of Array.from(document.body.children)) n.remove();
  setViewport({ width: 1024, height: 768 });
});

/** The three things that move, built the way the app builds them. */
function surfaces(): {
  layout: HTMLElement;
  margin: HTMLElement;
  inline: HTMLElement;
} {
  const layout = attach('redline-layout', { attrs: { id: 'editor' } });
  const margin = attach('markup-margin', { parent: layout });
  const inline = attach('lf-inline-card thread', { parent: layout });
  return { layout, margin, inline };
}

describe('the surface in force, read from the cascade', () => {
  it('balloons on a wide screen: a margin column, no inline card', () => {
    setViewport(IPAD);
    setCardPlacement('balloon');
    const { layout, margin, inline } = surfaces();
    expect(styleOf(layout).display).toBe('grid');
    expect(styleOf(margin).display).not.toBe('none');
    expect(styleOf(inline).display).toBe('none');
  });

  it('inline on the SAME wide screen once the reader asks for it', () => {
    // The whole feature in one test: nothing about the window changed.
    setViewport(IPAD);
    setCardPlacement('inline');
    const { layout, margin, inline } = surfaces();
    expect(styleOf(layout).display).toBe('block');
    expect(styleOf(margin).display).toBe('none');
    expect(styleOf(inline).display).not.toBe('none');
  });

  it('balloons chosen at 430px become the sheet: neither surface in the flow', () => {
    setViewport(PHONE);
    setCardPlacement('balloon');
    const { layout, margin, inline } = surfaces();
    // `data-cards` carries the EFFECTIVE surface, which is what makes this a
    // third state rather than a broken balloon.
    expect(document.body.dataset.cards).toBe('sheet');
    expect(styleOf(layout).display).toBe('block');
    expect(styleOf(margin).display).toBe('none');
    expect(styleOf(inline).display).toBe('none');
  });

  it('keeps a readable measure when the cards move into the flow', () => {
    // The freed margin column must not become paragraph width: a card in the
    // flow is as wide as the prose, so an 1100px measure is an 1100px card.
    setViewport(IPAD);
    const layout = attach('redline-layout', { attrs: { id: 'editor' } });
    const prose = attach('ProseMirror', { parent: layout });
    setCardPlacement('inline');
    expect(styleOf(prose).maxWidth).toBe('min(100%, 900px)');
    // The reader's own reading-width choice is narrower still, and wins.
    document.body.classList.add('is-reading-width');
    expect(styleOf(prose).maxWidth).toBe('576px');
    document.body.classList.remove('is-reading-width');
  });

  it('the fallback chips take over wherever the margin is not in force', () => {
    // Positive control for the pair: the chips are the deletion and
    // suggestion markers a balloon would otherwise carry, so "no margin" has
    // to mean "chips", not "nothing".
    setViewport(IPAD);
    setCardPlacement('inline');
    const chip = attach('lf-del-chip');
    expect(styleOf(chip).display).toBe('inline-flex');
    setCardPlacement('balloon');
    expect(styleOf(chip).display).not.toBe('inline-flex');
  });

  it('crossing the sheet floor moves the surface without changing the choice', () => {
    setViewport(IPAD);
    setCardPlacement('balloon');
    expect(document.body.dataset.cards).toBe('balloon');
    // What `onPlacementChange` does on the media-query event.
    setViewport(PHONE);
    applyPlacement();
    expect(document.body.dataset.cards).toBe('sheet');
    // And the stored choice is untouched, so going back restores balloons
    // rather than leaving the reader on whatever the phone gave them.
    setViewport(IPAD);
    applyPlacement();
    expect(document.body.dataset.cards).toBe('balloon');
  });
});
