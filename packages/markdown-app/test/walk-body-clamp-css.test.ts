import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The walkthrough card's long-detail clamp is CSS the DOM tests cannot see
 * (happy-dom resolves no layout), so this pins the rules to the classes
 * `walkReviewBody` actually produces (review-walkthrough.test.ts pins those).
 *
 * The contract: the clamp and its expand affordance live ONLY in the mobile
 * tier (≤1100px). Wider screens — the iPad in landscape at 1180 — render the
 * whole detail with no affordance, because the ticket's promise is that the
 * card shows the same words as the thread, and only the phone needs a fold to
 * stay scannable. How it LOOKS at 1180x820 and 430px is a browser check; see
 * the PR.
 */

const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule, by exact selector, searched within `scope`. */
function rule(selector: string, scope: string): string {
  const at = new RegExp(
    `(^|\\n|\\{|\\})\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(scope);
  return at?.[2] ?? '';
}

/** Everything inside the one mobile-tier media block that mentions the clamp. */
function mobileBlock(): string {
  const css = declarationsOnly(CSS);
  const blocks = css.split(/@media\s*\(max-width:\s*1100px\)\s*\{/).slice(1);
  const withClamp = blocks.find((b) => b.includes('.hub-walk-body-clamp'));
  return withClamp ?? '';
}

describe('the long-detail clamp is scoped to the mobile tier', () => {
  it('clamps the body by height inside the ≤1100px block, not globally', () => {
    const body = rule('.hub-walk-body-clamp', mobileBlock());
    expect(body).toContain('max-height');
    expect(body).toContain('overflow: hidden');
    // And NOT outside a media query: strip every media block and the clamp
    // selector must not carry a max-height at top level.
    const topLevel = declarationsOnly(CSS).replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '');
    expect(rule('.hub-walk-body-clamp', topLevel)).toBe('');
  });

  it('shows the expand affordance only there, at thumb size', () => {
    // Hidden by default (wide screens render the full body, no affordance)…
    const base = rule('.hub-walk-body-expand', declarationsOnly(CSS));
    expect(base).toContain('display: none');
    // …and a ≥36px target inside the mobile block (design-mobile.md).
    const mobile = rule('.hub-walk-body-expand', mobileBlock());
    const min = /min-height:\s*(\d+)px/.exec(mobile);
    expect(Number(min?.[1] ?? 0)).toBeGreaterThanOrEqual(36);
  });
});
