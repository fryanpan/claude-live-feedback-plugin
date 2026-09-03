import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * A decision's answers are targets, not banners.
 *
 * The options row was written when a comment card was only ever 260px wide:
 * `flex-direction: column` plus `width: 100%` gave one answer per row, which
 * is right on a phone, where the tap is the primary gesture and two answers
 * must never share one thumb. Once a card could sit in the flow of a 1180px
 * pane the same rule drew two 872px buttons for a two-word decision — measured
 * on the built page at 1180x820, 2026-09-03. The 900px prose cap narrowed the
 * card and could not reach the row inside it.
 *
 * One `flex: 1 1 240px` basis does both jobs, so what is asserted here is the
 * basis and the ceiling rather than a rendered width: happy-dom has no layout
 * engine, and how many buttons land on a row is a `bun run ui:shot` check.
 * The modal's own ceiling is in `thread-modal-css.test.ts`.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  setViewport({ width: 1024, height: 768 });
});

function row(): { options: HTMLElement; option: HTMLElement } {
  const options = attach('thread-item-options');
  const option = attach('thread-item-option', { tag: 'button', parent: options });
  return { options, option };
}

describe('the decision option row', () => {
  it('wraps rather than stretching, and stops well short of the pane', () => {
    setViewport(IPAD);
    const { options, option } = row();
    const s = styleOf(options);
    expect(s.flexDirection).toBe('row');
    expect(s.flexWrap).toBe('wrap');
    expect(Number.parseFloat(s.maxWidth)).toBeLessThanOrEqual(560);

    // The basis is what makes the row wrap instead of splitting into slivers,
    // and `width: 100%` is what it replaced — a full-width button for a
    // two-word label, at any card width.
    expect(styleOf(option).flexBasis).toBe('240px');
    expect(styleOf(option).width).not.toBe('100%');
  });

  it('keeps a thumb-sized target at 430px, which is what the column was for', () => {
    // The rule the original column was protecting still holds: at phone width
    // a 240px basis cannot fit two on a line, so each answer keeps its own
    // row, and the minimum height is what makes it a target rather than a
    // line of text.
    setViewport(PHONE);
    const { option } = row();
    expect(Number.parseFloat(styleOf(option).minHeight)).toBeGreaterThanOrEqual(44);
    expect(styleOf(option).flexBasis).toBe('240px');
  });

  it('leaves the folded card’s chips at content width', () => {
    // The compact row carries `.thread-item-option` too, for the frame and
    // the tap target, so it inherited the 240px basis written for the open
    // card and stretched a two-word option to 345px on line two of a folded
    // card in the flow. Folded, these are chips beside a topic.
    setViewport(IPAD);
    const compact = attach('thread-options-compact');
    const chip = styleOf(
      attach('thread-item-option thread-item-option-compact', { tag: 'button', parent: compact }),
    );
    expect(chip.flexGrow).toBe('0');
    expect(chip.flexBasis).toBe('auto');
    expect(chip.maxWidth).toBe('100%');

    // Control: the OPEN card's option still takes its share of the row, so
    // the reset above is scoped and did not undo the row it sits beside.
    const open = styleOf(
      attach('thread-item-option', { tag: 'button', parent: attach('thread-item-options') }),
    );
    expect(open.flexGrow).toBe('1');
    expect(open.flexBasis).toBe('240px');
  });

  it('reads a real cascade, not an element nothing reaches', () => {
    // Control. Every assertion above is on a property the sheet sets, and a
    // bare div satisfies most of them by having no rule at all.
    setViewport(IPAD);
    const naked = styleOf(attach('not-an-option', { tag: 'button' }));
    expect(naked.flexBasis === '' || naked.flexBasis === 'auto').toBe(true);
    expect(Number.parseFloat(naked.minHeight) || 0).toBe(0);
  });
});
