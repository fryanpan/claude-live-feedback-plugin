import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The criteria field and the held note's foot — the two boxes added after the
 * UX review, at the two sizes this project checks.
 *
 * WHAT THIS CAN AND CANNOT PROVE. happy-dom does no layout, so nothing here
 * measures a rendered pixel. What it does run is the cascade, so every rule
 * below is read as the value the browser would USE rather than as a string
 * that survives in the file — which is the difference that matters for the
 * two boxes' caps and floors, all of which are overridable from a later rule
 * a text search cannot see. What is guarded is the handful of declarations
 * that, if lost, break exactly the two viewports in the project's convention
 * — 1180x820 (iPad landscape, where HEIGHT is the scarce axis, ~750px usable)
 * and 430px (phone, where width is).
 *
 * Two things the text version asserted are gone and are named where they
 * were: the panel's own `width: min(560px, 100%)`, which happy-dom will not
 * compute (a `width` built from `min()`/`calc()`/`var()` comes back empty),
 * and the override's `:hover` / `:focus-visible` / `:active` inversion, which
 * has no pointer to enter it. Both are `bun run ui:shot` checks.
 */

/** The phone this project verifies, at the iPad's height — so a comparison
 *  between the two isolates WIDTH-keyed rules from viewport-height maths. */
const NARROW = { width: 430, height: 820 } as const;

let cleanup = () => {};
beforeEach(() => {
  // The board's real cascade order — `renderBoardShell`, packages/server/src/
  // shells.ts loads board.css BEFORE styles.css. tokens.css is left out on
  // purpose: the served /app/tokens.css is the vendored Open Props subset
  // concatenated with src/tokens.css, and installing the mapping layer alone
  // resolves its `var(--gray-9)` chain to nothing, which would blank every
  // colour compared below.
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** The number a `min(a, b)` computed value settles on. happy-dom substitutes
 *  `vh` against the current viewport but leaves the comparison unevaluated. */
function px(value: string): number {
  const inner = /^min\((.*)\)$/.exec(value.trim());
  const terms = inner?.[1] ? inner[1].split(',') : [value];
  return Math.min(...terms.map((t) => Number.parseFloat(t)));
}

/** The settings panel, its criteria row, the field and the two buttons — the
 *  chain `renderSettingsPanel` emits. */
function panel(viewport: { width: number; height: number }) {
  setViewport(viewport);
  const box = attach('board-settings-panel');
  const row = attach('board-settings-row board-settings-row--criteria', { parent: box });
  const field = attach('board-criteria', { tag: 'textarea', parent: row });
  const actions = attach('board-criteria-actions', { parent: row });
  const button = attach('board-btn', { tag: 'button', parent: actions });
  return { box, row, field, actions, button };
}

describe('the criteria field at 1180x820 and at 430px', () => {
  it('never lets one field eat the panel’s height', () => {
    const { box, field } = panel(IPAD);
    // The panel itself is capped and scrolls; the field inside it has to be
    // capped too, or the six-line default pushes the buttons below the fold
    // on the iPad, where the panel gets ~560px in total.
    const cap = Number.parseFloat(styleOf(field).maxHeight);
    expect(cap).toBeGreaterThan(0);
    expect(cap).toBeLessThan(IPAD.height);
    // …and the cap is viewport-relative, not a constant: a shorter screen
    // gets a shorter field. That is what `vh` bought, asserted as the
    // behaviour rather than as the unit.
    const short = Number.parseFloat(styleOf(panel({ width: 1180, height: 500 }).field).maxHeight);
    expect(short).toBeLessThan(cap);
    // 160px, not the 96px it shipped as: at 430px the default wrapped to
    // ~280px of prose in a 110px box and was sliced mid-sentence. The floor
    // is ~8 lines and the rest scrolls, which is stated rather than left to
    // the UA default. What this file CANNOT prove is the rendered height —
    // happy-dom does no layout; the 110px was measured in a real browser.
    expect(Number.parseFloat(styleOf(field).minHeight)).toBeGreaterThanOrEqual(160);
    expect(styleOf(field).overflow).toBe('auto');
    // The panel is what scrolls, and it already says so.
    expect(styleOf(box).overflowY).toBe('auto');
    const panelCap = px(styleOf(box).maxHeight);
    expect(panelCap).toBeGreaterThan(0);
    expect(panelCap).toBeLessThan(IPAD.height);
  });

  it('fits the panel’s width at 430px instead of overflowing it', () => {
    const { field } = panel(NARROW);
    expect(styleOf(field).width).toBe('100%');
    // Without this the padding and border are added OUTSIDE the 100%, and the
    // field is wider than the panel on the narrowest screen.
    expect(styleOf(field).boxSizing).toBe('border-box');
    // NOT asserted, and dropped from the text version: the panel's own
    // `width: min(560px, 100%)`. happy-dom returns '' for any `width` built
    // from `min()`/`calc()`/`var()`, so there is nothing here to read.
  });

  it('stacks the row, so the words get the full column', () => {
    const { row } = panel(IPAD);
    expect(styleOf(row).flexDirection).toBe('column');
    expect(styleOf(row).alignItems).toBe('stretch');
  });

  it('keeps both buttons at the 44px touch floor and lets them wrap', () => {
    const { actions, button } = panel(IPAD);
    expect(styleOf(actions).flexWrap).toBe('wrap');
    // `.board-btn` alone is 36px — a mouse target. These are pressed on a phone.
    expect(Number.parseFloat(styleOf(button).minHeight)).toBe(44);
    // The control: the base rule really is the smaller one, so this override
    // is doing work rather than restating what it inherits — and, unlike the
    // source comparison this replaces, a later rule that undid the override
    // would show up as 36 here.
    expect(Number.parseFloat(styleOf(attach('board-btn', { tag: 'button' })).minHeight)).toBe(36);
  });
});

describe('the held note’s foot at 430px', () => {
  /** The held note, its foot, the meta line and the override button. */
  function heldNote(viewport: { width: number; height: number }) {
    setViewport(viewport);
    const note = attach('board-decide-held', { tag: 'p' });
    const foot = attach('board-decide-held-foot', { tag: 'span', parent: note });
    const meta = attach('board-decide-held-meta', { tag: 'span', parent: foot });
    const release = attach('board-btn board-decide-held-release', { tag: 'button', parent: foot });
    return { note, foot, meta, release };
  }

  it('wraps the meta and the override apart instead of squeezing them', () => {
    const { foot } = heldNote(NARROW);
    expect(styleOf(foot).flexWrap).toBe('wrap');
    expect(styleOf(foot).justifyContent).toBe('space-between');
  });

  it('keeps the override at the 44px touch floor', () => {
    expect(Number.parseFloat(styleOf(heldNote(NARROW).release).minHeight)).toBe(44);
  });

  /**
   * The override has to READ as a control with no pointer on the page.
   *
   * happy-dom does no layout, but it runs the cascade and resolves `var()`,
   * so colour, weight and decoration are measurable even though a pixel
   * height is not. What is NOT measurable is `:hover` / `:focus-visible` /
   * `:active` — there is no pointer, so nothing can put the element into
   * those states. The text version read those declarations instead; they are
   * dropped here and belong to `bun run ui:shot`. The defect they guard is
   * worth restating for whoever runs that check: `.board-btn:hover` paints
   * `--bg-hover`, which is the background `.board-decide-held` already sits on,
   * so the hover was invisible — the state change has to be an inversion, not
   * a tint.
   */
  it('does not wear the same colour as the meta text beside it', () => {
    const { note, meta, release } = heldNote(IPAD);
    const btn = styleOf(release);
    // The finding: measured at rest, the button was rgb(110,119,129) at
    // 13px/400 — the meta's own colour, on the meta's own line.
    expect(btn.color).not.toBe(styleOf(meta).color);
    // And it sits on a surface of its own rather than on the note's.
    expect(btn.backgroundColor).not.toBe('');
    expect(btn.backgroundColor).not.toBe(styleOf(note).backgroundColor);
    // Two more affordances that survive with no pointer and no colour
    // vision: it is underlined, and it is heavier than the prose.
    expect(btn.textDecorationLine).toContain('underline');
    expect(btn.fontWeight).toBe('500');
    expect(styleOf(meta).fontWeight).not.toBe('500');
  });

  it('positive control: the ghost variant it shipped as DOES match the meta', () => {
    // Without this the test above could pass by measuring nothing — it
    // reproduces the reported defect through the same code path, so a
    // regression to `.board-btn-ghost` fails the assertion above rather than
    // quietly passing it.
    setViewport(IPAD);
    const foot = attach('board-decide-held-foot', {
      tag: 'span',
      parent: attach('board-decide-held', { tag: 'p' }),
    });
    const meta = attach('board-decide-held-meta', { tag: 'span', parent: foot });
    const ghost = attach('board-btn board-btn-ghost', { tag: 'button', parent: foot });
    expect(styleOf(ghost).color).toBe(styleOf(meta).color);
  });

  it('adds no media query — width cannot identify a device here either', () => {
    // The project's rule: page zoom moves width, so per-device truth lives in
    // a stored preference. These boxes are fluid at every width instead —
    // measured as "the same computed values at 1180 and at 430", which is the
    // claim, rather than as "the rule's text carries no @media", which is not.
    // Both viewports are 820 tall so nothing viewport-height-relative moves.
    const wide = panel(IPAD);
    const wideFoot = attach('board-decide-held-foot', {
      tag: 'span',
      parent: attach('board-decide-held', { tag: 'p' }),
    });
    const wideValues = [
      styleOf(wide.field).maxHeight,
      styleOf(wide.field).minHeight,
      styleOf(wide.actions).flexWrap,
      styleOf(wide.row).flexDirection,
      styleOf(wideFoot).justifyContent,
    ];
    document.body.replaceChildren();
    const narrow = panel(NARROW);
    const narrowFoot = attach('board-decide-held-foot', {
      tag: 'span',
      parent: attach('board-decide-held', { tag: 'p' }),
    });
    expect([
      styleOf(narrow.field).maxHeight,
      styleOf(narrow.field).minHeight,
      styleOf(narrow.actions).flexWrap,
      styleOf(narrow.row).flexDirection,
      styleOf(narrowFoot).justifyContent,
    ]).toEqual(wideValues);
    // Control: the values compared are real, not five empty strings.
    expect(wideValues.every((v) => v !== '')).toBe(true);
  });
});
