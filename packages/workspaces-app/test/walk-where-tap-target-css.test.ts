import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The review card's `Task: … ↗` link as a TAP TARGET.
 *
 * It became load-bearing when the Home queue row stopped navigating: the row
 * opens the card, and this link is now the ONLY route from the queue to the
 * task or doc underneath it. design-mobile.md asks for ≥36px on anything
 * interactive, and an inline button takes its height from the line — 14px
 * text, `padding: 0`, so roughly 18px of thumb.
 *
 * happy-dom has no layout engine, so the rendered height is still a browser
 * check. What it CAN answer is whether the two declarations that make the box
 * atomic and give it a floor survive the cascade to the element — which is
 * what the old regex over `hub.css` could not, since a later rule putting the
 * button back to `display: inline` would have left the text read green.
 *
 * SHEETS: `hub.css` before `styles.css` is the order `renderHubShell` links
 * them in; `tokens.css` is left out because the served file is a vendored Open
 * Props subset plus `src/tokens.css`, and the mapping half alone re-points
 * every remapped token at an undefined `var(--gray-N)`.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

describe('the card’s pointer out is thumb-sized', () => {
  it('gives .hub-walk-where-link an atomic box with a 36px floor at every width', () => {
    for (const vp of [IPAD, PHONE]) {
      setViewport(vp);
      const link = styleOf(attach('hub-walk-where-link', { tag: 'button' }));
      // `inline-flex` is the half that matters — `min-height` on a plain
      // inline box is ignored outright, so the floor without it says nothing.
      expect(link.display, `${vp.width}px`).toBe('inline-flex');
      expect(Number.parseFloat(link.minHeight), `${vp.width}px`).toBeGreaterThanOrEqual(36);
    }
  });

  it('positive control: an unstyled button is neither, so the two reads above discriminate', () => {
    // A button the cascade never reaches computes the UA's `inline-block` and
    // no floor at all. Without this an empty stylesheet would look like a
    // renamed class rather than like a broken harness.
    setViewport(PHONE);
    const bare = styleOf(attach('hub-walk-where-link-not-a-class', { tag: 'button' }));
    expect(bare.display).toBe('inline-block');
    expect(bare.minHeight).toBe('');
  });
});
