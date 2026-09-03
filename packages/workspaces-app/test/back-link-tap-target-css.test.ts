import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The review shell's back arrow as a TAP TARGET, read off the cascade.
 *
 * design-mobile.md asks for the back arrow to stay tappable at ≥36px. The hub
 * topbar's arrow has had that rule since it was written (`.hub-topbar
 * .back-link`); the review app's arrow never did, and it is the one Bryan uses
 * — measured in a browser at a 440px viewport before this rule existed, the
 * review `←` was **26 × 20 CSS px**: a 16px glyph with `padding: 2px 6px` and
 * nothing else. The base rule is shared by both surfaces, so it cannot simply
 * grow: widening `.back-link` globally would relayout the hub arrow that
 * already has its own sizing.
 *
 * This file used to read `styles.css` + `hub.css` as text, brace-walk to the
 * phone block and regex the declarations out of it. That could not see the two
 * things that actually decide the outcome — whether the block MATCHES at the
 * width a reader is on, and whether anything later un-does it — so the sheets
 * are installed here and the arrow is built at each viewport instead. The
 * numbers below are the values the browser would use.
 *
 * The class chain is what `packages/workspaces-app/index.html` server-renders
 * for the review topbar (`<a class="back-link">` inside `.doc-crumb`) and what
 * `hub-app.ts`'s shell renders for the board (`.hub-topbar` > `.back-link`);
 * `hub-render.test.ts` and the shell tests pin that markup.
 *
 * The rendered box is still a browser check — happy-dom lays nothing out, so
 * `min-width`/`min-height` are read as declared floors, not as measured pixels.
 *
 * SHEETS: the real board page links `hub.css` BEFORE `styles.css`
 * (`renderHubShell` in packages/server/src/shells.ts says so, and the
 * `.hub-topbar .back-link:hover` rule is written against that order), so that
 * is the order installed here. `tokens.css` is deliberately left out: the file
 * the server serves is a vendored Open Props subset PLUS the mapping in
 * `src/tokens.css`, and installing the mapping half alone re-points every
 * remapped token at an undefined `var(--gray-N)`.
 */

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The review shell's topbar crumb and the arrow inside it, at `vp`. */
function reviewTopbar(vp: { width: number; height: number }) {
  setViewport(vp);
  const crumb = attach('doc-crumb');
  return {
    crumb: styleOf(crumb),
    arrow: styleOf(attach('back-link', { tag: 'a', parent: crumb })),
    path: styleOf(attach('doc-path', { tag: 'span', parent: crumb })),
    toolbar: styleOf(attach('toolbar')),
  };
}

/** The board's arrow, which shares the `.back-link` base and nothing else. */
function hubArrow(vp: { width: number; height: number }) {
  setViewport(vp);
  return styleOf(
    attach('back-link', { tag: 'a', parent: attach('hub-topbar', { tag: 'header' }) }),
  );
}

describe("the review shell's back arrow on a phone", () => {
  it('reaches the 44px target in BOTH dimensions', () => {
    // 26 × 20 was the measured size, so a height-only fix would still leave a
    // thumb missing it horizontally. 36 was the first floor; 44 is the one
    // the phone's only navigation affordance gets (review of #564).
    const { arrow, path } = reviewTopbar(PHONE);
    expect(arrow.minWidth).toBe('44px');
    expect(arrow.minHeight).toBe('44px');
    // Positive control that this is the topbar-tightening block talking and
    // not some other rule: the same block drops the path to 13px. Without it
    // a renamed class would read '' for every floor above and say nothing.
    expect(path.fontSize).toBe('13px');
  });

  it('centres the glyph in the grown box rather than letting it sit top-left', () => {
    // `min-height` on an inline element does nothing, and on a block it grows
    // the box while leaving the arrow at the top: the tap area would be right
    // and the arrow would visibly detach from the file path beside it.
    const { arrow } = reviewTopbar(PHONE);
    expect(arrow.display).toBe('inline-flex');
    expect(arrow.alignItems).toBe('center');
    expect(arrow.justifyContent).toBe('center');
  });

  it('keeps the crumb from collapsing under the toolbar in edit mode', () => {
    // Measured at 430px before the floor: the crumb was 8px wide with the
    // arrow and doc name clipped inside it. The floor holds the crumb open and
    // the toolbar is the side that yields — it may shrink and scroll, and it
    // must never push off-screen or clip the crumb.
    const { crumb, toolbar } = reviewTopbar(PHONE);
    expect(Number.parseFloat(crumb.minWidth)).toBeGreaterThanOrEqual(44);
    expect(toolbar.flex).toBe('0 1 auto');
    expect(toolbar.minWidth).toBe('0');
    expect(toolbar.overflowX).toBe('auto');
  });

  it('leaves the desktop arrow alone — the floor is the phone block, not the base rule', () => {
    // A phone tap target, not a redesign: on the iPad the base rule keeps its
    // compact padding and no floor at all.
    const { arrow } = reviewTopbar(IPAD);
    expect(arrow.minWidth).not.toBe('44px');
    expect(arrow.minHeight).not.toBe('44px');
    expect(arrow.display).not.toBe('inline-flex');
    // Positive control, and the reason the assertions above are not vacuous:
    // an element no rule reaches reads '' for everything, which is exactly
    // what "no floor" looks like. The base rule IS live here.
    expect(arrow.padding).toBe('2px 6px');
    expect(arrow.fontSize).toBe('16px');
  });

  it('leaves the hub arrow at the 36px it has always had, at every width', () => {
    // The board's arrow has its own sizing and must not inherit the review
    // shell's 44px floor (nor lose its own to it) — the two surfaces share
    // only the `.back-link` base.
    for (const vp of [IPAD, PHONE]) {
      const arrow = hubArrow(vp);
      expect(arrow.minWidth, `${vp.width}px`).toBe('36px');
      expect(arrow.minHeight, `${vp.width}px`).toBe('36px');
      expect(arrow.display, `${vp.width}px`).toBe('inline-flex');
      expect(arrow.fontSize, `${vp.width}px`).toBe('18px');
    }
  });
});
