import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The reconnecting state existed on the review surface for months and was
 * invisible on a phone: one `.save-state { display: none }` inside the ≤720px
 * block hid it, and a deploy usually catches Bryan on his phone.
 *
 * This file used to brace-walk `styles.css` for that block and compare the two
 * rules' OFFSETS, on the reasoning that equal specificity makes source order
 * the decider. That reasoning was right and the test still could not see the
 * answer: it never asked whether the block matched at 430px, and a third rule
 * anywhere else in the cascade would have re-hidden the badge with both
 * offsets unchanged. The sheet is installed here and the badge is built at
 * each viewport, so the assertion IS the cascade's verdict — which is also why
 * the old comment about `display:\\s*(?!none)` backtracking is gone with the
 * regex it was about.
 *
 * SHEETS: the review shell links `styles.css` (then `tokens.css`, left out
 * here — the served file is a vendored Open Props subset plus `src/tokens.css`,
 * and the mapping half alone re-points every remapped token at an undefined
 * `var(--gray-N)`).
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The routine badge and the reconnecting one, as the topbar renders them. */
function badges(vp: { width: number; height: number }) {
  setViewport(vp);
  return {
    saved: styleOf(attach('save-state save-state--saved', { tag: 'span' })),
    offline: styleOf(attach('save-state save-state--offline', { tag: 'span' })),
  };
}

describe('the phone breakpoint', () => {
  it('still hides the routine saved/dirty badge', () => {
    expect(badges(PHONE).saved.display).toBe('none');
  });

  it('un-hides the reconnecting one — the phone shows "we lost the server"', () => {
    // Same specificity (one class each) so source order decides, and this is
    // where that decision lands. A hide that came back later in the cascade
    // would read here as `none`, whatever the two offsets in the file said.
    const { offline } = badges(PHONE);
    expect(offline.display).toBe('inline-block');
  });

  it('positive control: the hide is scoped to the phone, and the base rule is live above it', () => {
    // Without this the two assertions above could both pass on a stylesheet
    // that failed to attach at all — an unstyled span reads '' for display,
    // and `''` is not `'none'`, so "un-hidden" would be free.
    const { saved, offline } = badges(IPAD);
    expect(saved.display).toBe('');
    expect(offline.display).toBe('');
    expect(saved.fontSize).toBe('11.5px'); // the shared base rule, still there
  });
});

describe('the board connection banner', () => {
  it('is styled, and sits in flow rather than over the page', () => {
    // A fixed/absolute banner covers a control for the whole outage, which at
    // 430px is every control there is.
    setViewport(PHONE);
    const banner = styleOf(attach('conn-banner'));
    expect(banner.padding).toBe('7px 14px'); // control: the rule reaches it
    expect(banner.position === 'static' || banner.position === '').toBe(true);
  });
});
