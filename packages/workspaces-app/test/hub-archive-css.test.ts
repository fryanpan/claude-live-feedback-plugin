import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The archive feature's LAYOUT rules, read off the cascade.
 *
 * Two properties are load-bearing rather than cosmetic, and both are about the
 * 430px end of the range. The restore row WRAPS, so a long reason drops the
 * Restore button to its own line instead of squeezing the title to nothing;
 * and every control this feature adds clears the thumb floor from
 * design-mobile.md — the Undo especially, since it is the only thing standing
 * in for the confirm dialog this design deliberately does not ask for.
 *
 * This file used to read `hub.css` as text and brace-walk its own copy of the
 * `@media (max-width: 1100px)` blocks to answer "what does the phone tier give
 * this selector". That reimplemented the cascade in the test, and a rule the
 * walker's regex did not shape-match was invisible to it. The sheets are
 * installed here and the elements are built at each viewport instead, so the
 * phone tier is applied by the same machinery a browser applies it with.
 *
 * happy-dom lays nothing out, so a `min-height` below is a declared floor, not
 * a measured box; the rendered rows stay a `bun run ui:shot` check.
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

/**
 * `min-height` for one class at one viewport, taken on the spot.
 *
 * happy-dom's computed style resolves lazily and stays live, so a declaration
 * held across a `setViewport` re-answers for the new window — two viewports
 * compared through held objects silently compare the second against itself.
 */
function floorOf(vp: { width: number; height: number }, classes: string, tag = 'button'): number {
  setViewport(vp);
  return Number.parseFloat(styleOf(attach(classes, { tag })).minHeight);
}

describe('archive CSS', () => {
  it('the restore row wraps, so the button drops rather than crushing the title', () => {
    setViewport(PHONE);
    const row = styleOf(attach('hub-archived-row', { tag: 'li' }));
    expect(row.display).toBe('flex'); // positive control: the rule reaches it
    expect(row.flexWrap).toBe('wrap');
  });

  it('the archived title can shrink — min-width:0 is what allows the ellipsis', () => {
    setViewport(PHONE);
    const title = styleOf(attach('hub-archived-title', { tag: 'span' }));
    expect(title.flex).toBe('1 1 12ch'); // control: this is the styled title
    expect(title.minWidth).toBe('0');
  });

  it('every added control clears the 36px thumb floor', () => {
    for (const sel of ['hub-archived-restore', 'hub-toast-action']) {
      expect(floorOf(PHONE, sel), sel).toBeGreaterThanOrEqual(36);
      expect(floorOf(IPAD, sel), sel).toBeGreaterThanOrEqual(36);
    }
    // Positive control: an unstyled button has no floor at all, so the reads
    // above are a rule talking rather than a default.
    setViewport(PHONE);
    expect(styleOf(attach('hub-archived-not-a-control', { tag: 'button' })).minHeight).toBe('');
  });

  it('the toast lays its action out beside the text rather than under it', () => {
    setViewport(PHONE);
    const toast = styleOf(attach('hub-toast'));
    expect(toast.display).toBe('flex');
    expect(toast.alignItems).toBe('center');
    // …and it is hidden by a class, not by being unbuilt — control that the
    // same element's cascade can be flipped.
    expect(styleOf(attach('hub-toast hidden')).display).toBe('none');
  });

  it('the board foot line is small and quiet, and a 44px thumb target on the phone tier', () => {
    // Bryan, 2026-08-29: the archived link moved from above the first goal
    // to after the last band. Down there it is a footnote — muted text, not a
    // button skin, no right-alignment pulling the eye — but the thing you tap
    // still has to clear the phone-tier floor from design-mobile.md.
    setViewport(IPAD);
    const foot = styleOf(attach('hub-board-foot'));
    expect(foot.display).toBe('flex'); // control: the foot is a styled row
    expect(foot.justifyContent).not.toBe('flex-end');
    expect(styleOf(attach('hub-board-foot-archived', { tag: 'button' })).fontSize).toBe('12.5px');
    // The target grows on the phone tier; the type does not.
    expect(floorOf(PHONE, 'hub-board-foot-archived')).toBeGreaterThanOrEqual(44);
    expect(floorOf(IPAD, 'hub-board-foot-archived')).toBeLessThan(44);
    // Positive control that the phone tier really is being applied here, on a
    // control that has carried the same floor since before this line moved.
    setViewport(PHONE);
    const quick = attach('hub-quick-actions');
    expect(
      Number.parseFloat(styleOf(attach('hub-btn', { tag: 'button', parent: quick })).minHeight),
    ).toBeGreaterThanOrEqual(44);
    // …and the old top-of-board rule is gone rather than merely joined by a
    // new one: nothing in the cascade reaches its class, so a bare <div>
    // carrying it computes the UA's own `display: block`.
    expect(styleOf(attach('hub-board-meta')).display).toBe('block');
  });

  it('the archived note is its own quiet boxed panel, not another row in the list', () => {
    // It exists because a deep link or the restore list can open a task that
    // is on no board, and a panel that looked like any other's would make that
    // absence read as a bug. The WASH it wears — the parked note's neutral
    // `color-mix(...)`, deliberately not an alarm amber — is not readable
    // here: happy-dom does not compute `color-mix()`, so the property comes
    // back empty whatever the value. That half is a browser check.
    setViewport(PHONE);
    const note = styleOf(attach('hub-archived-note'));
    expect(note.padding).toBe('11px 12px');
    expect(note.borderWidth).toBe('1px');
    expect(note.fontSize).toBe('13.5px');
  });
});
