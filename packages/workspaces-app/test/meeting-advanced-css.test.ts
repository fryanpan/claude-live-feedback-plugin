import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The Advanced Options panel's SIZING, which no DOM test can see.
 *
 * A fresh-eyes UX review of the panel at 430px found it shipped with no
 * `@media` rules at all: the desktop sizes rendered on the phone, giving
 * 36×32 stepper buttons, a 34×20 toggle (under even the 24px desktop floor)
 * and 16px-tall slider targets, against an approved mock whose 430 frame
 * promises ≥44px. The same review at 1180×820 — the iPad tier, where HEIGHT
 * is the scarce axis — found Start Recording pushed below the fold once the
 * panel expanded, with nothing saying the popover scrolls.
 *
 * happy-dom resolves no media queries and has no layout engine, so this
 * asserts the CASCADE SHAPE: the rules exist, they are scoped to the mobile
 * block, and they declare AFTER the base rules they have to beat. A media
 * query adds no specificity ("A media query adds no specificity" in
 * learnings.md), so source order is the whole of it. The rendered sizes are
 * measured in a browser against a real build; that is what closes the
 * criterion.
 */
// Comments are stripped before anything is parsed: a selector is read as the
// text before a rule's `{`, and prose commas inside a preceding comment would
// otherwise split that text and hide the selector.
const CSS = readFileSync(resolve('packages/workspaces-app/src/styles.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/** The mobile tier per design-mobile.md, opened verbatim. */
const MOBILE_CONDITION = '@media (max-width: 1100px) {';

/** The body of the mobile block that carries the Advanced Options group. */
function advancedMobileBlock(): { body: string; at: number } {
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(MOBILE_CONDITION, from);
    if (at === -1) throw new Error('no mobile block carries the Advanced Options rules');
    let depth = 1;
    let i = at + MOBILE_CONDITION.length;
    for (; i < CSS.length && depth > 0; i++) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
    }
    const body = CSS.slice(at + MOBILE_CONDITION.length, i - 1);
    if (body.includes('.meeting-adv')) return { body, at };
    from = at + MOBILE_CONDITION.length;
  }
}

/**
 * Every declaration block in `css` whose selector list names `selector`.
 * Selectors are grouped (`.a,\n.b { … }`), so a rule cannot be found by
 * looking for "selector {".
 */
function rulesFor(css: string, selector: string): string[] {
  const out: string[] = [];
  for (const rule of css.split('}')) {
    const brace = rule.indexOf('{');
    if (brace === -1) continue;
    const selectors = rule
      .slice(0, brace)
      .split(',')
      .map((s) => s.trim());
    if (selectors.includes(selector)) out.push(rule.slice(brace + 1));
  }
  return out;
}

describe('the mobile tier', () => {
  it('grows every Advanced Options tap target to the 44px the mock promises', () => {
    const { body } = advancedMobileBlock();
    // Each control the review measured under target, and the dimension that
    // was under it. 44 is the number the approved mock promises.
    const sized: ReadonlyArray<[string, RegExp]> = [
      ['.meeting-adv-head', /min-height:\s*44px/],
      ['.meeting-adv-reset', /min-height:\s*44px/],
      // The INPUT is the 44px target the review measured at 16px; the thumb
      // inside it is sized separately, below.
      ['.meeting-adv input[type="range"]', /height:\s*44px/],
      ['.meeting-adv-seg button', /min-height:\s*44px/],
      ['.meeting-adv-stepper button', /min-(?:width|height):\s*44px/],
      // The well, not the field inside it: clicking the well focuses the
      // field, so the well is the target.
      ['.meeting-adv-chips', /min-height:\s*44px/],
    ];
    for (const [selector, dimension] of sized) {
      const rules = rulesFor(body, selector);
      expect(rules.length, `${selector} has no mobile rule`).toBeGreaterThan(0);
      expect(
        rules.some((r) => dimension.test(r)),
        `${selector} is not sized to the 44px target`,
      ).toBe(true);
    }
    // The switch is the mock's one deliberate exception: 51×31 is the
    // platform-standard pill, and it clears the mock's own 44×26 on both
    // axes while sitting in a row that is itself ≥44 tall.
    const toggle = rulesFor(body, '.meeting-adv-toggle').join('');
    expect(toggle).toMatch(/width:\s*51px/);
    expect(toggle).toMatch(/height:\s*31px/);
  });

  it('paints a 24px slider thumb, and the fill the native control stops providing', () => {
    const { body } = advancedMobileBlock();
    // Sizing a thumb at all requires giving up the native control.
    const input = rulesFor(body, '.meeting-adv input[type="range"]').join('');
    expect(input).toMatch(/-webkit-appearance:\s*none/);
    expect(input).toMatch(/(^|[^-])appearance:\s*none/);
    // The mock's 24px, on both engines' pseudo-elements.
    for (const thumb of [
      '.meeting-adv input[type="range"]::-webkit-slider-thumb',
      '.meeting-adv input[type="range"]::-moz-range-thumb',
    ]) {
      const rule = rulesFor(body, thumb).join('');
      expect(rule, `${thumb} is missing`).not.toBe('');
      expect(rule, `${thumb} is not 24px`).toMatch(/width:\s*24px/);
      expect(rule, `${thumb} is not 24px`).toMatch(/height:\s*24px/);
    }
    // `appearance: none` costs Chrome its progress fill (there is no
    // ::-webkit-slider-progress), so the track paints it from --fill. Losing
    // this leaves a flat grey track under a thumb that appears to do nothing.
    const track = rulesFor(
      body,
      '.meeting-adv input[type="range"]::-webkit-slider-runnable-track',
    ).join('');
    expect(track).toMatch(/var\(--fill/);
    expect(track).toMatch(/linear-gradient/);
    // Firefox paints its own, so it gets the progress pseudo-element instead.
    expect(
      rulesFor(body, '.meeting-adv input[type="range"]::-moz-range-progress').join(''),
    ).toMatch(/background:\s*var\(--accent\)/);
  });

  it('declares after the desktop sizes it has to beat', () => {
    const { at } = advancedMobileBlock();
    // The base rules carry no media query, so only source order separates
    // them from the mobile block. Each must appear BEFORE it.
    for (const base of ['.meeting-adv-toggle {', '.meeting-adv-stepper button {']) {
      const baseAt = CSS.indexOf(base);
      expect(baseAt, `${base} is missing`).toBeGreaterThan(-1);
      expect(baseAt, `${base} declares after the mobile block`).toBeLessThan(at);
    }
  });
});

describe('the popover on the iPad tier, where height is scarce', () => {
  it('keeps the recording verb reachable inside a popover that scrolls', () => {
    // The popover has always scrolled; what it lacked was any sign that it
    // does, and a verb that survived the scroll. Sticky does both: the CTA
    // holds the scrollport's bottom edge and content slides under it.
    const cta = CSS.slice(CSS.indexOf('.meeting-stop-cta,'));
    const block = cta.slice(0, cta.indexOf('}'));
    expect(block).toContain('position: sticky');
    expect(block).toContain('bottom: 0');
    // Opaque, or the content sliding under it shows through and the cue
    // reads as a rendering bug.
    expect(block).toMatch(/background:\s*var\(--red\)/);
    // And the scrollport it sticks to is the popover itself.
    const pop = CSS.slice(CSS.indexOf('.meeting-pop {'));
    const popBlock = pop.slice(0, pop.indexOf('}'));
    expect(popBlock).toContain('overflow: auto');
    expect(popBlock).toMatch(/max-height:\s*calc\(100dvh/);
  });
});
