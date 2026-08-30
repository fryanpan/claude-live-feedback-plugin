import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The criteria field and the held note's foot, in CSS — the two boxes added
 * after the UX review, at the two sizes this project checks.
 *
 * WHAT THIS CAN AND CANNOT PROVE. happy-dom does no layout, so nothing here
 * measures a rendered pixel; the rules are read as text, the way
 * `hub-row-affordance-css.test.ts` and the widget's `tap-targets.test.ts` do.
 * What it guards is the handful of declarations that, if lost, break exactly
 * the two viewports in the project's convention — 1180x820 (iPad landscape,
 * where HEIGHT is the scarce axis, ~750px usable) and 430px (phone, where
 * width is).
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/**
 * The declarations of the first rule whose selector STARTS a line with `sel`.
 * Anchored to the line start on purpose: a plain `indexOf('.hub-btn {')` also
 * matches the descendant rule `.hub-criteria-actions .hub-btn {`, which is
 * how this file's own control first read the override it was controlling for.
 */
function block(sel: string): string {
  const at = CSS.indexOf(`\n${sel}`);
  expect(at, `no rule for ${sel}`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', at);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

describe('the criteria field at 1180x820 and at 430px', () => {
  it('never lets one field eat the panel’s height', () => {
    const box = block('.hub-criteria {');
    // The panel itself is capped and scrolls; the field inside it has to be
    // capped too, or the six-line default pushes the buttons below the fold
    // on the iPad, where the panel gets ~560px in total.
    expect(box).toMatch(/max-height:\s*\d+vh/);
    expect(box).toMatch(/min-height:\s*\d+px/);
    // The panel is what scrolls, and it already says so.
    expect(block('.hub-settings-panel {')).toContain('overflow-y: auto');
    expect(block('.hub-settings-panel {')).toMatch(/max-height:\s*min\(/);
  });

  it('fits the panel’s width at 430px instead of overflowing it', () => {
    const box = block('.hub-criteria {');
    expect(box).toContain('width: 100%');
    // Without this the padding and border are added OUTSIDE the 100%, and the
    // field is wider than the panel on the narrowest screen.
    expect(box).toContain('box-sizing: border-box');
    // The panel is already the header's width at 430px; the field inherits it.
    expect(block('.hub-settings-panel {')).toContain('width: min(560px, 100%)');
  });

  it('stacks the row, so the words get the full column', () => {
    const row = block('.hub-settings-row--criteria {');
    expect(row).toContain('flex-direction: column');
    expect(row).toContain('align-items: stretch');
  });

  it('keeps both buttons at the 44px touch floor and lets them wrap', () => {
    expect(block('.hub-criteria-actions {')).toContain('flex-wrap: wrap');
    // `.hub-btn` alone is 36px — a mouse target. These are pressed on a phone.
    expect(block('.hub-criteria-actions .hub-btn {')).toMatch(/min-height:\s*44px/);
    // The control: the base rule really is the smaller one, so this override
    // is doing work rather than restating what it inherits.
    expect(block('.hub-btn {')).toMatch(/min-height:\s*36px/);
  });
});

describe('the held note’s foot at 430px', () => {
  it('wraps the meta and the override apart instead of squeezing them', () => {
    const foot = block('.hub-decide-held-foot {');
    expect(foot).toContain('flex-wrap: wrap');
    expect(foot).toContain('justify-content: space-between');
  });

  it('keeps the override at the 44px touch floor', () => {
    expect(block('.hub-decide-held-release {')).toMatch(/min-height:\s*44px/);
  });

  it('adds no media query — width cannot identify a device here either', () => {
    // The project's rule: page zoom moves width, so per-device truth lives in
    // a stored preference. These boxes are fluid at every width instead.
    for (const sel of [
      '.hub-criteria {',
      '.hub-criteria-actions {',
      '.hub-settings-row--criteria {',
      '.hub-decide-held-foot {',
    ]) {
      expect(block(sel)).not.toContain('@media');
    }
  });
});
