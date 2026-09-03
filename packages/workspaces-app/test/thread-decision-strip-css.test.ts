import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The settled item's DECISION strip — the layout half, read off the cascade
 * rather than out of the stylesheet's text.
 *
 * The strip exists because the outcome used to be a fragment of a sentence
 * ("Answered by Cara: “AssemblyAI — go with what we prototyped”"), so the one
 * thing a person opens a settled item to read had no visual home. The
 * approved mock gives it a label beside the words at reading width, and
 * stacks the label ABOVE the words at a phone's — where a label and a
 * sentence on one line leave the sentence wrapping under a hanging label.
 *
 * The stacking is the half a text read could not honestly hold: it lives in a
 * `@media (max-width: 640px)` block, and matching that block's source proves
 * nothing about the width a reader is on, nor about a later rule un-stacking
 * it. Here the sheets are installed and the element is measured at each
 * viewport, so the assertion is the value the browser would use. How it
 * actually reads at 1180 and 430 is still checked in a browser — happy-dom
 * lays nothing out.
 *
 * 430 rather than "just under 640": 430px is the phone this project verifies
 * (docs/product/design-mobile.md), and the breakpoint's own number is now a
 * detail of how the stack is reached rather than something a test restates.
 */

/** The phone this project verifies. Inside the 640px breakpoint by 210px. */
const PHONE_430 = { width: 430, height: 932 } as const;

let cleanup = () => {};
beforeEach(() => {
  // The doc surface loads styles.css; the board loads hub.css first (see
  // `renderHubShell` in packages/server/src/shells.ts). tokens.css stays out:
  // the served sheet is the Open Props subset plus src/tokens.css, and the
  // mapping layer alone resolves its `var(--gray-9)` chain to nothing.
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

function strip(viewport: { width: number; height: number }): CSSStyleDeclaration {
  setViewport(viewport);
  return styleOf(attach('thread-decision-strip'));
}

describe('the settled item’s decision strip', () => {
  it('puts the label beside the words at reading width', () => {
    const wide = strip(IPAD);
    expect(wide.display).toBe('flex');
    // Baseline, not centre: a one-word label against three lines of outcome
    // centres to the middle of the paragraph and reads as unattached.
    expect(wide.alignItems).toBe('baseline');
    // Row is flex's default, so the absence of a column here is the claim —
    // and an unset property computes to '' rather than to `row`, which is why
    // both are accepted.
    expect(wide.flexDirection === '' || wide.flexDirection === 'row').toBe(true);
  });

  it('keeps the label a label — uppercase, and never shrinking to fit', () => {
    setViewport(IPAD);
    const label = styleOf(attach('thread-decision-label'));
    expect(label.textTransform).toBe('uppercase');
    // `flex: 0 0 auto` is what stops the label wrapping mid-word to give the
    // outcome room, which is the failure that makes a strip look broken.
    expect(label.flex).toBe('0 0 auto');
  });

  it('stacks the label above the words at 430px', () => {
    expect(strip(PHONE_430).flexDirection).toBe('column');
    // …and only there: the same element measured on the iPad is still a row,
    // which is what makes this a tier boundary rather than a global stack.
    expect(strip(IPAD).flexDirection).not.toBe('column');
  });

  it('lets a long outcome break rather than widening the card', () => {
    // A pasted identifier or URL in a free-text answer is the case that
    // overflows a fixed-width margin rail.
    setViewport(IPAD);
    expect(styleOf(attach('thread-answer-words')).overflowWrap).toBe('anywhere');
  });

  it('positive control: the cascade is live — an unstyled box reads none of it', () => {
    // Without this a renamed class would satisfy the row assertion above by
    // measuring an element no rule reaches: `flex-direction` is '' there,
    // which the `'' || row` allowance accepts, and `overflow-wrap` is '' too.
    setViewport(IPAD);
    const nothing = styleOf(attach('thread-decision-strip-not-a-class'));
    expect(nothing.display).toBe('block');
    expect(nothing.alignItems).toBe('');
    expect(strip(IPAD).display).toBe('flex');
  });
});
