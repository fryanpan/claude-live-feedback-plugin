import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The buttons that replaced the Board's quick-add box, read off the cascade.
 *
 * At 1180×820 (the iPad, where HEIGHT is the scarce axis) the pair must cost
 * no more vertical room than the box it replaced; at 430px each button is a
 * thumb target. This file used to read `styles.css` and `hub.css` as text and
 * regex the declarations out of them, which passes against a rule that has
 * been overridden later in the cascade or scoped to a query that no longer
 * matches. The sheets are installed here instead and the numbers are the ones
 * a browser would use at each of the two verified viewports.
 *
 * What a browser still has to confirm is how the row READS — the glyph
 * weights, the wrap point, the spacing against the board beneath it.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The box the buttons replaced: `.hub-quick-input { min-height: 40px }`. */
const OLD_BOX_MIN_HEIGHT = 40;

/**
 * Every property the cascade sets on `classes` that it does not also set on
 * an identical element carrying a class nobody styles.
 *
 * This is how "no rule for this selector" is asserted without reading the
 * stylesheet: an unstyled element and a de-styled one are the same element,
 * so the control is built alongside and the difference is the answer. An
 * empty list means nothing in the installed sheets reaches that class.
 */
function stylingOf(classes: string, tag = 'div'): string[] {
  const parent = attach('hub-quick');
  const subject = styleOf(attach(classes, { tag, parent }));
  const control = styleOf(attach('hub-none-of-the-above', { tag, parent }));
  const out: string[] = [];
  for (let i = 0; i < subject.length; i++) {
    const prop = subject.item(i);
    if (subject.getPropertyValue(prop) !== control.getPropertyValue(prop)) {
      out.push(`${prop}: ${subject.getPropertyValue(prop)}`);
    }
  }
  return out;
}

const px = (v: string) => Number.parseFloat(v);

/** A quick-action button, mounted the way the row mounts it. */
function quickButton(viewport: { width: number; height: number }, classes = 'hub-btn') {
  setViewport(viewport);
  const row = attach('hub-quick-actions', { parent: attach('hub-quick') });
  return attach(classes, { tag: 'button', parent: row });
}

describe('the quick-add box is gone from the stylesheet too', () => {
  it('leaves the box, its form, its mic and its submit completely unstyled', () => {
    setViewport(IPAD);
    for (const [sel, tag] of [
      ['hub-quick-input', 'input'],
      ['hub-quick-form', 'form'],
      ['hub-quick-mic', 'button'],
      ['hub-quick-submit', 'button'],
    ] as const) {
      expect(stylingOf(sel, tag), `.${sel} is still styled`).toEqual([]);
    }
  });

  it('positive control: the slot they lived in is still styled', () => {
    // Without this, a sheet that failed to install would satisfy every
    // assertion above — an unstyled element and a de-styled one read alike.
    setViewport(IPAD);
    expect(stylingOf('hub-quick-actions').join(' ')).toContain('display: flex');
    expect(styleOf(attach('hub-quick')).marginBottom).not.toBe('');
  });
});

describe('the buttons sit in the slot the box had', () => {
  it('is one wrapping row', () => {
    setViewport(IPAD);
    const row = styleOf(attach('hub-quick-actions', { parent: attach('hub-quick') }));
    expect(row.display).toBe('flex');
    expect(row.flexWrap).toBe('wrap');
    expect(px(row.gap)).toBeGreaterThan(0);
  });

  it('costs no more height than the box at 1180×820', () => {
    // Whatever rule sizes the buttons on the tablet tier has to stay within
    // the 40px box they replaced — height is the scarce axis there.
    const button = styleOf(quickButton(IPAD));
    expect(px(button.minHeight)).toBeGreaterThan(0); // control: a floor exists
    expect(px(button.minHeight)).toBeLessThanOrEqual(OLD_BOX_MIN_HEIGHT);
    // The slot's own spacing did not grow with the swap.
    expect(px(styleOf(attach('hub-quick')).marginBottom)).toBeLessThanOrEqual(10);
  });

  it('is a 44px thumb target at 430px', () => {
    expect(px(styleOf(quickButton(PHONE)).minHeight)).toBeGreaterThanOrEqual(44);
    // …and it is the ROW's rule that raises it, not the button's own floor:
    // a bare `.hub-btn` elsewhere on the phone keeps the smaller size, so a
    // rule scoped to the wrong ancestor fails here rather than passing on the
    // base value.
    setViewport(PHONE);
    expect(px(styleOf(attach('hub-btn', { tag: 'button' })).minHeight)).toBeLessThan(44);
  });

  it('sizes EVERY quick-action glyph as a box, like every other mic', () => {
    // Measured in headless Chromium, 2026-08-30: the conversation button's
    // two-person glyph was left out of this rule and rendered at its
    // intrinsic 24px, which stretched the whole row from 44px to 71px — on
    // the tier where height is the scarce axis. A grouped rule is easy to add
    // a button beside and forget, so every button in the row is mounted with
    // a glyph inside it and each one is measured.
    for (const button of ['hub-quick-new', 'hub-huddle-start', 'hub-conversation-start']) {
      const host = quickButton(IPAD, button);
      const glyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      host.appendChild(glyph);
      const box = styleOf(glyph);
      expect(px(box.width), `.${button} svg sizes itself`).toBeGreaterThan(0);
      expect(px(box.height), `.${button} svg sizes itself`).toBeGreaterThan(0);
    }
    // Control: a glyph in a button nobody styles is left at its intrinsic
    // size, which is the failure the rule above prevents.
    const stray = quickButton(IPAD, 'hub-nonexistent-button');
    const strayGlyph = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    stray.appendChild(strayGlyph);
    expect(styleOf(strayGlyph).width).toBe('');
  });
});

describe('an unnamed task reads as a stand-in, not a title', () => {
  it('mutes the placeholder', () => {
    // task-detail-island toggles this class while `task.untitled` is set.
    setViewport(IPAD);
    const titled = styleOf(attach('hub-detail-title'));
    const placeholder = styleOf(attach('hub-detail-title hub-detail-title-placeholder'));
    expect(placeholder.color).not.toBe(titled.color);
    // `var(--fg-muted)`, compared against the token's own value as the
    // cascade resolves it rather than against a colour copied from the rule.
    expect(placeholder.color).toBe(
      styleOf(document.documentElement).getPropertyValue('--fg-muted'),
    );
    // Control: the title rule it modifies still applies to both.
    expect(placeholder.fontWeight).toBe(titled.fontWeight);
    expect(titled.fontWeight).not.toBe('');
  });
});

describe('the editor names a huddle in its crumb', () => {
  it('gives the label a pill of its own, distinct from a plain doc label', () => {
    // The tint is `color-mix(...)`, which happy-dom does not evaluate — what
    // is readable is the shape the tint sits in, and that it differs from the
    // unadorned label beside it.
    setViewport(IPAD);
    const huddle = styleOf(attach('doc-label-huddle', { tag: 'span' }));
    const plain = styleOf(attach('doc-label', { tag: 'span' }));
    expect(huddle.borderRadius).not.toBe('');
    expect(huddle.padding).not.toBe('');
    expect(huddle.fontWeight).not.toBe(plain.fontWeight);
    expect(huddle.color).not.toBe(plain.color);
  });
});
