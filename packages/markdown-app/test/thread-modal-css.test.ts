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

describe('the modal hides the way the rest of the app hides', () => {
  it('is not on the list of elements that override display:none', () => {
    // `.hidden` is `display: none !important`; a handful of animated surfaces
    // undo that so their transition still renders. This one is not animated,
    // so if it ever joins that list it would sit invisible over the page.
    const overrides = /\.hidden\s*\{[^}]*\}([\s\S]*?)\/\* =/.exec(declarationsOnly(CSS))?.[1] ?? '';
    expect(overrides).not.toContain('.thread-modal');
  });
});
