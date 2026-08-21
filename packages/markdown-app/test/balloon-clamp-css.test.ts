import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * An expanded comment balloon must not be taller than the screen.
 *
 * Measured on the staging build: a declared thread's balloon runs ~700px open
 * — head, opening message, the full item card, the options, the answer
 * composer, the foot. Bryan reads on an iPad in landscape whose usable height
 * is about 750px, so on any anchor below the first screenful the composer and
 * the Answer button start below the fold, and reaching them scrolls the
 * DOCUMENT — which moves the balloon they were reaching for.
 *
 * The fix is the clamp the rest of this stylesheet already uses for anything
 * that can outgrow the viewport (`min(<n>vh, <n>px)` plus `overflow-y: auto`),
 * applied to the balloon so the scrolling happens INSIDE it and the item head
 * and composer stay reachable without the document moving. `offsetHeight`
 * honours a max-height, so `layoutBalloons` stacks the clamped height and the
 * column stays correct.
 *
 * Layout is what no DOM test in this suite can see (happy-dom resolves none),
 * so this asserts the rule exists and is keyed off the classes the code
 * actually produces — `markup-margin.test.ts` pins that an open balloon
 * carries `.lf-balloon-comment` and `.expanded` on one element. How it LOOKS
 * at 1180x820 and at 430px is a browser check; see the report.
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

const CLAMPED = '.lf-balloon-comment.expanded';

describe('the expanded comment balloon clamps itself to the viewport', () => {
  it('caps its height against the viewport, not against its content', () => {
    const body = rule(CLAMPED);
    const max = /max-height:\s*([^;]+);/.exec(body)?.[1] ?? '';
    expect(max).toContain('vh');
  });

  it('scrolls INSIDE the balloon, so the composer is reachable without moving the doc', () => {
    expect(rule(CLAMPED)).toMatch(/overflow-y:\s*auto/);
  });

  it('positive control: the same lookup finds a rule that has always been there', () => {
    // Without this, a selector typo would return '' and every assertion above
    // would pass by searching nothing.
    expect(rule('.lf-balloon-comment')).toMatch(/cursor:\s*pointer/);
  });
});
