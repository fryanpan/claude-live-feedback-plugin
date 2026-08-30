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
    // 160px, not the 96px it shipped as: at 430px the default wrapped to
    // ~280px of prose in a 110px box and was sliced mid-sentence. The floor
    // is ~8 lines and the rest scrolls, which is stated rather than left to
    // the UA default. What this file CANNOT prove is the rendered height —
    // happy-dom does no layout; the 110px was measured in a real browser.
    const floor = /min-height:\s*(\d+)px/.exec(box);
    expect(floor?.[1]).toBeDefined();
    expect(Number(floor?.[1])).toBeGreaterThanOrEqual(160);
    expect(box).toContain('overflow: auto');
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

  /**
   * The override has to READ as a control with no pointer on the page.
   *
   * Unlike everything else in this file these are real `getComputedStyle`
   * reads: happy-dom does no layout, but it does run the cascade and resolve
   * `var()`, so colour, weight and decoration are measurable even though a
   * pixel height is not. What is NOT measurable here is `:hover` — happy-dom
   * has no pointer, so nothing can put an element into that state; those
   * declarations are read as text below and are marked as such.
   */
  describe('the override looks like a control at rest (computed)', () => {
    function paint(cls: string) {
      const style = document.createElement('style');
      style.textContent = CSS;
      document.head.appendChild(style);
      document.body.innerHTML = `<p class="hub-decide-held"><span class="hub-decide-held-foot">
        <span class="hub-decide-held-meta">Filed by Index Keeper</span>
        <button class="${cls}">Ask me anyway</button></span></p>`;
      const btn = document.querySelector('button') as HTMLElement;
      const meta = document.querySelector('.hub-decide-held-meta') as HTMLElement;
      const note = document.querySelector('.hub-decide-held') as HTMLElement;
      return {
        btn: getComputedStyle(btn),
        meta: getComputedStyle(meta),
        noteBg: getComputedStyle(note).backgroundColor,
      };
    }

    it('does not wear the same colour as the meta text beside it', () => {
      const { btn, meta, noteBg } = paint('hub-btn hub-decide-held-release');
      // The finding: measured at rest, the button was rgb(110,119,129) at
      // 13px/400 — the meta's own colour, on the meta's own line.
      expect(btn.color).not.toBe(meta.color);
      // And it sits on a surface of its own rather than on the note's.
      expect(btn.backgroundColor).not.toBe(noteBg);
      expect(btn.backgroundColor).not.toBe('');
      // Two more affordances that survive with no pointer and no colour
      // vision: it is underlined, and it is heavier than the prose.
      expect(btn.textDecorationLine).toContain('underline');
      expect(btn.fontWeight).toBe('500');
      expect(meta.fontWeight).not.toBe('500');
    });

    it('positive control: the ghost variant it shipped as DOES match the meta', () => {
      // Without this the test above could pass by measuring nothing — it
      // reproduces the reported defect through the same code path, so a
      // regression to `.hub-btn-ghost` fails the assertion above rather than
      // quietly passing it.
      const { btn, meta } = paint('hub-btn hub-btn-ghost hub-decide-held-release-control');
      expect(btn.color).toBe(meta.color);
    });
  });

  it('inverts on hover, active and keyboard focus (rule text — see above)', () => {
    // `:hover` cannot be entered in happy-dom, so this reads the declaration.
    // The defect it guards: `.hub-btn:hover` paints `--bg-hover`, which is
    // the background `.hub-decide-held` already sits on, so the hover was
    // invisible — the state change has to be an inversion, not a tint.
    const at = CSS.indexOf('.hub-decide-held-release:hover');
    expect(at, 'no hover rule for the override').toBeGreaterThan(-1);
    const rule = CSS.slice(at, CSS.indexOf('}', at));
    for (const state of [':hover', ':focus-visible', ':active']) {
      expect(rule).toContain(`.hub-decide-held-release${state}`);
    }
    expect(rule).toContain('background: var(--accent)');
    expect(rule).toContain('color: #fff');
    // The control: the base hover really is the one that collides, so the
    // override above is doing work rather than restating what it inherits.
    expect(block('.hub-btn:hover {')).toContain('background: var(--bg-hover)');
    expect(block('.hub-decide-held {')).toContain('background: var(--bg-hover)');
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
