import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The review card's `Task: … ↗` link as a TAP TARGET.
 *
 * It became load-bearing when the Home queue row stopped navigating: the row
 * opens the card, and this link is now the ONLY route from the queue to the
 * task or doc underneath it. design-mobile.md asks for ≥36px on anything
 * interactive, and an inline button takes its height from the line — 14px
 * text, `padding: 0`, so roughly 18px of thumb.
 *
 * happy-dom has no layout engine, so this asserts the DECLARATIONS that make
 * the box atomic and give it a floor. The rendered height is measured in a
 * browser against a real build; that is what closes the criterion.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function rule(selector: string): string {
  const at = new RegExp(`(^|\\n)${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(
    declarationsOnly(CSS),
  );
  return at?.[2] ?? '';
}

describe('the card’s pointer out is thumb-sized', () => {
  it('gives .hub-walk-where-link an atomic box with a 36px floor', () => {
    const body = rule('.hub-walk-where-link');
    // Positive control first: an extractor that found nothing would let both
    // assertions below pass by measuring an empty string.
    expect(body, '.hub-walk-where-link has no rule').not.toBe('');
    // `inline-flex` is the half that matters — `min-height` on a plain inline
    // box is ignored outright, so the floor without it says nothing.
    expect(body).toContain('inline-flex');
    expect(body).toMatch(/min-height:\s*36px/);
  });
});
