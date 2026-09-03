import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLACEMENT_PREF_KEY, cardPlacement, setCardPlacement } from '../src/card-placement.ts';
import { wireCardPlacementToggle } from '../src/review-chrome.ts';
import { IPAD, PHONE, setViewport } from './css-harness.ts';

/**
 * The control that moves the cards, wired the way the topbar wires it.
 *
 * It sits beside the doc-list and comments toggles because it is the same
 * kind of thing — a stored per-device view preference. What matters here is
 * that a reader can reach BOTH surfaces from it at any width, which is the
 * half a media query could never do.
 */

function topbarButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.id = 'toggle-cards';
  btn.type = 'button';
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  setViewport(IPAD);
});

afterEach(() => {
  try {
    localStorage.removeItem(PLACEMENT_PREF_KEY);
  } catch {
    // nothing stored
  }
  document.body.removeAttribute('data-cards');
  for (const n of Array.from(document.body.children)) n.remove();
  setViewport({ width: 1024, height: 768 });
});

describe('the placement toggle', () => {
  it('moves the cards into the flow and back, from one control', () => {
    const btn = topbarButton();
    wireCardPlacementToggle();
    expect(cardPlacement()).toBe('balloon');

    btn.click();
    expect(cardPlacement()).toBe('inline');
    expect(document.body.dataset.cards).toBe('inline');

    btn.click();
    expect(cardPlacement()).toBe('balloon');
    expect(document.body.dataset.cards).toBe('balloon');
  });

  it('shows the placement in force and offers the other one', () => {
    const btn = topbarButton();
    wireCardPlacementToggle();
    const inMargin = { glyph: btn.textContent, title: btn.title };
    expect(inMargin.title).toContain('into the flow');

    btn.click();
    expect(btn.textContent).not.toBe(inMargin.glyph);
    expect(btn.title).toContain('to the margin');
    expect(btn.getAttribute('aria-label')).toContain('Move them to the right margin');
  });

  it('survives a reload: the choice is read back, not re-derived from the width', () => {
    setCardPlacement('inline');
    const btn = topbarButton();
    wireCardPlacementToggle();
    // A fresh page at a width whose DEFAULT is balloons.
    expect(btn.title).toContain('to the margin');
    expect(document.body.dataset.cards).toBe('inline');
  });

  it('offers the margin at 430px too, where a width rule would refuse', () => {
    // The reader is on a phone and wants balloons back for when they pick
    // their tablet up again. The control has to accept that even though the
    // margin cannot be shown here — and the app shows the sheet meanwhile.
    setViewport(PHONE);
    const btn = topbarButton();
    wireCardPlacementToggle();
    btn.click();
    expect(cardPlacement()).toBe('balloon');
    expect(document.body.dataset.cards).toBe('sheet');
  });

  it('wires once, however many times chrome remounts', () => {
    // `mountReviewChrome` runs on every doc change. A second listener would
    // flip the placement twice per click and land back where it started.
    const btn = topbarButton();
    wireCardPlacementToggle();
    wireCardPlacementToggle();
    btn.click();
    expect(cardPlacement()).toBe('inline');
  });
});
