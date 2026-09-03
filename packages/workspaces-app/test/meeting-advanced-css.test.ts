import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The Advanced Options panel's SIZING, read off the cascade at each of the two
 * viewports this project verifies.
 *
 * A fresh-eyes UX review of the panel at 430px found it shipped with no
 * `@media` rules at all: the desktop sizes rendered on the phone, giving
 * 36×32 stepper buttons, a 34×20 toggle (under even the 24px desktop floor)
 * and 16px-tall slider targets, against an approved mock whose 430 frame
 * promises ≥44px. The same review at 1180×820 — the iPad tier, where HEIGHT
 * is the scarce axis — found Start Recording pushed below the fold once the
 * panel expanded, with nothing saying the popover scrolls.
 *
 * This file used to read `styles.css` as text and assert three things about
 * its shape: that the rules exist, that they sit inside a `@media (max-width:
 * 1100px)` block, and that they are written AFTER the base rules they have to
 * beat (a media query adds no specificity, so source order is the whole of
 * it). All three were proxies for one question — what size does a control
 * come out at on a phone — and the cascade answers that question directly.
 * The elements are built at each viewport and the computed value is read, so
 * a rule moved above its base, or scoped to a query that no longer matches,
 * fails here rather than passing on a surviving substring.
 *
 * What still belongs to the browser: the `::-webkit-slider-thumb` /
 * `::-moz-range-thumb` sizing and the track's gradient fill. happy-dom
 * returns nothing for a pseudo-element, so the 24px thumb and the painted
 * progress fill are checked in `bun run ui:shot`, not here.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The Advanced Options panel and the controls inside it, at one viewport. */
function panel(viewport: { width: number; height: number }) {
  setViewport(viewport);
  const adv = attach('meeting-adv');
  const seg = attach('meeting-adv-seg', { parent: adv });
  const stepper = attach('meeting-adv-stepper', { parent: adv });
  return {
    head: styleOf(attach('meeting-adv-head', { parent: adv })),
    reset: styleOf(attach('meeting-adv-reset', { tag: 'button', parent: adv })),
    range: styleOf(attach('', { tag: 'input', parent: adv, attrs: { type: 'range' } })),
    segButton: styleOf(attach('', { tag: 'button', parent: seg })),
    stepperButton: styleOf(attach('', { tag: 'button', parent: stepper })),
    chips: styleOf(attach('meeting-adv-chips', { parent: adv })),
    toggle: styleOf(attach('meeting-adv-toggle', { parent: adv })),
  };
}

const px = (v: string) => Number.parseFloat(v);

describe('the mobile tier sizes every Advanced Options tap target', () => {
  it('grows each control to the 44px the mock promises', () => {
    const phone = panel(PHONE);
    // Each control the review measured under target, and the dimension that
    // was under it. 44 is the number the approved mock promises.
    expect(px(phone.head.minHeight)).toBeGreaterThanOrEqual(44);
    expect(px(phone.reset.minHeight)).toBeGreaterThanOrEqual(44);
    // The INPUT is the 44px target the review measured at 16px; the thumb
    // inside it is a pseudo-element, so its 24px is a browser check.
    expect(px(phone.range.height)).toBeGreaterThanOrEqual(44);
    expect(px(phone.segButton.minHeight)).toBeGreaterThanOrEqual(44);
    expect(px(phone.stepperButton.minWidth)).toBeGreaterThanOrEqual(44);
    expect(px(phone.stepperButton.minHeight)).toBeGreaterThanOrEqual(44);
    // The well, not the field inside it: clicking the well focuses the
    // field, so the well is the target.
    expect(px(phone.chips.minHeight)).toBeGreaterThanOrEqual(44);
  });

  it('sizes the switch to the platform pill, the mock’s one deliberate exception', () => {
    // 51×31 is the platform-standard switch, and it clears the mock's own
    // 44×26 on both axes while sitting in a row that is itself ≥44 tall.
    const phone = panel(PHONE);
    expect(phone.toggle.width).toBe('51px');
    expect(phone.toggle.height).toBe('31px');
  });

  it('gives up the native slider, which is what makes a thumb sizeable at all', () => {
    // The 24px thumb itself is drawn on `::-webkit-slider-thumb` /
    // `::-moz-range-thumb`; happy-dom resolves no pseudo-element, so what is
    // checkable here is the precondition — a native control cannot be resized.
    expect(panel(PHONE).range.appearance).toBe('none');
  });

  it('positive control: the same controls read their DESKTOP sizes at 1180×820', () => {
    // The three things the old text version asserted separately — the rules
    // exist, they are inside the ≤1100px block, and they are written after
    // the base rules they beat — are all one observation: the phone reads the
    // mobile value and the iPad reads the desktop one. A mobile block moved
    // above its base would make these two identical.
    const ipad = panel(IPAD);
    expect(px(ipad.head.minHeight)).toBeLessThan(44);
    expect(px(ipad.stepperButton.minHeight)).toBeLessThan(44);
    expect(ipad.toggle.width).toBe('34px');
    expect(ipad.toggle.height).toBe('20px');
    // …and the slider carries no height of its own until the mobile block.
    expect(ipad.range.height).toBe('');
  });
});

describe('the popover on the iPad tier, where height is scarce', () => {
  it('keeps the recording verb reachable inside a popover that scrolls', () => {
    // The popover has always scrolled; what it lacked was any sign that it
    // does, and a verb that survived the scroll. Sticky does both: the CTA
    // holds the scrollport's bottom edge and content slides under it.
    setViewport(IPAD);
    const cta = styleOf(attach('meeting-stop-cta', { tag: 'button' }));
    expect(cta.position).toBe('sticky');
    expect(cta.bottom).toBe('0px');
    // Opaque, or the content sliding under it shows through and the cue
    // reads as a rendering bug. `var(--red)` resolved through the cascade.
    expect(cta.backgroundColor).toBe('#d73a49');
    // And the scrollport it sticks to is the popover itself. The cap is
    // `calc(100dvh - env(…) - 70px)`, which happy-dom returns unevaluated —
    // so what is asserted is that a cap exists at all, not its pixels.
    const pop = styleOf(attach('meeting-pop'));
    expect(pop.overflow).toBe('auto');
    expect(pop.maxHeight === 'none' || pop.maxHeight === '').toBe(false);
    expect(pop.maxHeight).toContain('100dvh');
  });

  it('goes edge-to-edge under the bar on a narrow viewport', () => {
    // Positive control for the popover reads above, and the narrow-width
    // half of the same rule: at 1180 the popover is a 320px card pinned to
    // the right; below 640 it is a sheet spanning the width.
    setViewport(IPAD);
    expect(styleOf(attach('meeting-pop')).width).toBe('320px');
    setViewport({ width: 600, height: 900 });
    const narrow = styleOf(attach('meeting-pop'));
    expect(narrow.width).toBe('auto');
    expect(narrow.left).toBe('6px');
    expect(narrow.right).toBe('6px');
  });
});
