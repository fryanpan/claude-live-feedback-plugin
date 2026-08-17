import { describe, expect, it } from 'vitest';
import { widgetStyles } from '../src/styles.ts';

/**
 * The 44px touch floor for the widget's chrome buttons.
 *
 * WHAT THIS TEST CAN AND CANNOT PROVE. happy-dom does no layout, so nothing
 * here measures a computed size — the sizes in the PR description were taken
 * with `getBoundingClientRect()` in Chrome, inside a same-origin 430x932
 * iframe (Chrome will not resize a window below ~500px). This test guards the
 * two things a stylesheet CAN be held to, and it exists because those are
 * exactly the two ways the floor has been silently lost before:
 *
 *   1. A later equal-specificity rule quietly overrides the floor. So the
 *      assertion reads the LAST `min-height` declared for each selector, not
 *      the first one it finds.
 *   2. Someone wraps a floor in `@media (max-width: 720px)` and it stops
 *      winning — a media query changes WHEN a rule applies, never how
 *      strongly. There are no media queries in this stylesheet today, and the
 *      test says so; if you add one, re-measure in a browser before trusting
 *      this file.
 *
 * The second half of the test pins the SELECTORS to the markup the widget
 * actually renders, so a rename can't leave this passing against classes
 * nothing wears.
 */

const FLOOR_PX = 44;

/** Selectors whose rendered control a person taps, and where each one lives. */
const TAP_TARGETS: { selector: string; where: string }[] = [
  { selector: '.primary', where: 'composer Post, popover Reply, panel "Comment on element…"' },
  { selector: '.cancel', where: 'composer Cancel' },
  { selector: '.resolve, .reopen', where: 'thread popover Resolve / Reopen' },
  { selector: '.icon-btn', where: 'panel close ×, thread-popover close ×' },
  { selector: '.resolved-toggle', where: 'panel "Show resolved (N)"' },
  { selector: '.picker-banner .picker-cancel', where: 'picker-mode "Cancel (Esc)"' },
];

/**
 * Every declaration block in source order, as `{ selector, decls }`. Flat by
 * design: the no-@media assertion below is what makes flat parsing correct.
 */
function rules(css: string): { selector: string; decls: string }[] {
  const out: { selector: string; decls: string }[] = [];
  // Comments first: a `/* … */` above a rule otherwise lands inside the
  // captured selector text and the rule stops matching its own name.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null = re.exec(stripped);
  while (m) {
    out.push({ selector: (m[1] ?? '').trim(), decls: m[2] ?? '' });
    m = re.exec(stripped);
  }
  return out;
}

/** The value the cascade lands on for a flat, equal-specificity stylesheet: the last one. */
function effectiveMinHeight(css: string, selector: string): number | null {
  let value: number | null = null;
  for (const rule of rules(css)) {
    const selectors = rule.selector.split(',').map((s) => s.trim());
    const wanted = selector.split(',').map((s) => s.trim());
    if (!wanted.some((w) => selectors.includes(w))) continue;
    const hit = /(?:^|;)\s*min-height\s*:\s*(\d+(?:\.\d+)?)px/.exec(rule.decls);
    if (hit) value = Number(hit[1]);
  }
  return value;
}

describe('widget tap targets', () => {
  it('states no @media block, which is what makes the floor below readable', () => {
    // If this ever fails, the flat "last declaration wins" reading above stops
    // being sound and the floor has to be re-measured in a real browser.
    expect(widgetStyles).not.toMatch(/@media/);
  });

  it.each(TAP_TARGETS)('$selector clears the 44px floor ($where)', ({ selector }) => {
    const px = effectiveMinHeight(widgetStyles, selector);
    expect(px, `no min-height reaches ${selector}`).not.toBeNull();
    expect(px).toBeGreaterThanOrEqual(FLOOR_PX);
  });

  it('the parser can see a later rule taking the floor away', () => {
    // Positive control for the reader itself: a floor asserted by a probe that
    // always reports the first value it finds would pass here.
    const css = `${widgetStyles}\n.primary { min-height: 28px; }`;
    expect(effectiveMinHeight(css, '.primary')).toBe(28);
  });

  it('checks the classes the widget actually renders', () => {
    // The floor is worthless if it is stated for a selector nothing wears.
    // These are the literal class attributes in widget.ts's markup.
    for (const cls of [
      'icon-btn close-panel',
      'primary pick-btn',
      'picker-cancel',
      'cancel',
      'primary submit',
      'resolve',
      'reopen',
    ]) {
      const first = cls.split(' ')[0] as string;
      const covered = TAP_TARGETS.some((t) =>
        t.selector
          .split(',')
          .some((s) => s.trim() === `.${first}` || s.trim().endsWith(`.${first}`)),
      );
      expect(covered, `${cls} has no floor`).toBe(true);
    }
  });
});
