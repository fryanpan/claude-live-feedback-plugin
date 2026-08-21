import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The long-thread modal's geometry, asserted against the stylesheet.
 *
 * happy-dom resolves no layout, so nothing in the DOM suite can see whether
 * this dialog fits on the screen it was designed for. The screen is an iPad in
 * landscape — 1180x820, roughly 750px usable — and its scarce axis is HEIGHT,
 * not width. A dialog that grows with its content is exactly the failure the
 * balloon column already had: the reply box lands below the fold, and reaching
 * it scrolls the DOCUMENT, which moves the thing being reached for.
 *
 * So: real width, a cap under the viewport, and the scroll inside the body.
 * How it LOOKS at 1180x820 and at 430px is a browser check, not this.
 */

const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule, by exact selector. */
function rule(selector: string): string {
  const at = new RegExp(
    `(^|\\n|\\})\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(declarationsOnly(CSS));
  return at?.[2] ?? '';
}

const decl = (selector: string, prop: string): string =>
  new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule(selector))?.[1]?.trim() ?? '';

describe('the modal is sized for the tablet tier', () => {
  it('exists as its own rule rather than borrowing the phone sheet', () => {
    expect(rule('.thread-modal')).not.toBe('');
    expect(rule('.thread-modal-body')).not.toBe('');
  });

  it('is far wider than the 300px column it replaces, and still fits 1180px', () => {
    const width = decl('.thread-modal', 'width');
    // `min(760px, calc(100vw - 64px))` — the fixed term is the width being
    // bought, the viewport term is what keeps it on a narrower screen.
    const fixed = Number(/(\d+)px/.exec(width)?.[1] ?? 0);
    expect(fixed).toBeGreaterThan(600);
    expect(fixed).toBeLessThanOrEqual(1180 - 64);
    expect(width).toContain('vw');
  });

  it('caps its height against the viewport, not against its content', () => {
    const max = decl('.thread-modal', 'max-height');
    expect(max).toContain('vh');
    // At 820px of viewport the cap has to land clear of the ~750px usable —
    // anything at or above 92vh is taller than the space that exists.
    const vh = Number(/(\d+)vh/.exec(max)?.[1] ?? 100);
    expect(vh).toBeLessThanOrEqual(88);
  });

  it('scrolls inside the body, so the document behind it never moves', () => {
    expect(decl('.thread-modal-body', 'overflow-y')).toBe('auto');
    expect(decl('.thread-modal-body', 'overscroll-behavior')).toBe('contain');
    // Without this the flex item's content floor pushes the dialog past its
    // own max-height and the scrollbar ends up on the page instead.
    expect(decl('.thread-modal-body', 'min-height')).toBe('0');
  });

  it('sits above the scrim, and the scrim above everything else on the page', () => {
    expect(Number(decl('.thread-modal', 'z-index'))).toBeGreaterThan(
      Number(decl('.thread-modal-scrim', 'z-index')),
    );
    expect(Number(decl('.thread-modal-scrim', 'z-index'))).toBeGreaterThan(1000);
  });

  it('lets the decision options use the width, which is why they came here', () => {
    expect(decl('.thread-modal-body .thread-item-options', 'flex-direction')).toBe('row');
    // The base rule pins an option to `width: 100%`; left alone it would put
    // one button per line and the row would buy nothing.
    expect(decl('.thread-modal-body .thread-item-option', 'width')).toBe('auto');
  });

  it('drops the card’s own frame — no border inside a bordered dialog', () => {
    expect(decl('.thread-modal-body .thread', 'border')).toBe('0');
    expect(decl('.thread-modal-body .thread', 'cursor')).toBe('default');
  });
});

/**
 * Evaluate the small subset of CSS length arithmetic these two rules use —
 * `min(<a>px, calc(100vw - <b>px))` and `min(<a>vh, <b>px)` — against a given
 * viewport. Nothing here resolves layout; it resolves the DECLARATION, which
 * is the half a stylesheet assertion can actually be honest about. Whether the
 * result looks right on the glass is a browser check.
 */
function evalLength(value: string, vw: number, vh: number): number {
  const terms = (/min\(([^)]*\)?[^)]*)\)\s*$/.exec(value.trim())?.[1] ?? value)
    .split(/,(?![^(]*\))/)
    .map((t) => t.trim());
  const one = (t: string): number => {
    const calc = /calc\(\s*100vw\s*-\s*(\d+(?:\.\d+)?)px\s*\)/.exec(t);
    if (calc) return vw - Number(calc[1]);
    if (t.endsWith('vh')) return (Number(t.slice(0, -2)) / 100) * vh;
    if (t.endsWith('vw')) return (Number(t.slice(0, -2)) / 100) * vw;
    return Number(t.replace('px', ''));
  };
  return Math.min(...terms.map(one));
}

describe('the numbers, worked out for the two viewports that matter', () => {
  const width = (vw: number, vh: number) => evalLength(decl('.thread-modal', 'width'), vw, vh);
  const height = (vw: number, vh: number) =>
    evalLength(decl('.thread-modal', 'max-height'), vw, vh);

  it('sanity-checks its own arithmetic before trusting it', () => {
    expect(evalLength('min(760px, calc(100vw - 64px))', 1180, 820)).toBe(760);
    expect(evalLength('min(760px, calc(100vw - 64px))', 430, 930)).toBe(366);
    expect(evalLength('min(84vh, 720px)', 1180, 820)).toBeCloseTo(688.8, 1);
  });

  it('iPad landscape, 1180x820: real width, and clear of the ~750px usable', () => {
    expect(width(1180, 820)).toBeGreaterThanOrEqual(700);
    expect(width(1180, 820)).toBeLessThanOrEqual(1180 - 48);
    // Roughly 750px is usable once browser chrome is taken off an 820px
    // viewport. The dialog has to finish inside that, with its own scroll.
    expect(height(1180, 820)).toBeLessThan(750);
  });

  it('a phone at 430px would still fit — the caller is not the only guard', () => {
    // The chrome refuses to open this below 1100px, but a rule whose only
    // protection is a caller is a rule one refactor away from overflowing.
    expect(width(430, 930)).toBeLessThanOrEqual(430);
    expect(height(430, 930)).toBeLessThan(930);
  });
});

describe('the modal hides the way the rest of the app hides', () => {
  it('is not on the list of elements that override display:none', () => {
    // `.hidden` is `display: none !important`; a handful of animated surfaces
    // undo that so their transition still renders. This one is not animated,
    // so if it ever joins that list it would sit invisible over the page.
    const overrides = /\.hidden\s*\{[^}]*\}([\s\S]*?)\/\* =/.exec(declarationsOnly(CSS))?.[1] ?? '';
    expect(overrides).not.toContain('.thread-modal');
  });
});

/**
 * The stylesheet's half of "the mic yields to an open card".
 *
 * The chrome's half — which widths set the class, and when it is dropped — is
 * in `thread-modal-chrome.test.ts`. This is the half that can silently go
 * missing: the class would still be applied, and nothing anywhere would move.
 */
describe('the floating mic stands down under an open card', () => {
  // Read off the raw stylesheet rather than through `rule()`: this one rule
  // deliberately carries two selectors, and the helper matches a single one.
  it('hides the mic, and the readout that rides above it', () => {
    const block =
      /body\.thread-card-open \.voice-mic,\s*body\.thread-card-open \.voice-indicator\s*\{([^}]*)\}/.exec(
        declarationsOnly(CSS),
      );
    expect(block?.[1]).toMatch(/display:\s*none/);
  });

  // The 1100px band lives in review-chrome.ts and must not be copied here —
  // a width constant that exists twice is one that drifts. The rule is
  // unconditional precisely because the class already carries the test.
  it('states no width of its own', () => {
    const at = CSS.indexOf('body.thread-card-open');
    expect(at).toBeGreaterThan(-1);
    const region = CSS.slice(Math.max(0, at - 400), at);
    expect(region).not.toMatch(/@media[^{]*max-width:\s*1100px[^{]*\{\s*$/);
  });
});
