import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The reconnecting state existed on the review surface for months and was
 * invisible on a phone: one `.save-state { display: none }` inside the ≤720px
 * block hid it, and a deploy usually catches Bryan on his phone.
 *
 * happy-dom has no layout engine and no cascade resolution for media queries,
 * so a rendered assertion isn't available here. This asserts the CASCADE
 * SHAPE instead — the rules exist, in the phone block, in an order where the
 * un-hide wins — and the 430px rendering is checked in a browser separately.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** Body of the first `@media (max-width: 720px)` block that styles .save-state. */
function phoneBlockWithSaveState(): string {
  const re = /@media \(max-width: 720px\) \{/g;
  let m: RegExpExecArray | null = re.exec(CSS);
  while (m !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
      i++;
    }
    const body = CSS.slice(start, i - 1);
    if (body.includes('.save-state')) return body;
    m = re.exec(CSS);
  }
  return '';
}

describe('the phone breakpoint', () => {
  it('has a ≤720px block that speaks about .save-state at all', () => {
    // POSITIVE CONTROL for the two assertions below: if the extractor came
    // back empty they would both pass by measuring nothing.
    expect(phoneBlockWithSaveState()).not.toBe('');
  });

  it('still hides the routine saved/dirty badge', () => {
    const body = phoneBlockWithSaveState();
    expect(/\.save-state\s*\{[^}]*display:\s*none/.test(body)).toBe(true);
  });

  it('un-hides the reconnecting one, after the hide so it wins', () => {
    const body = phoneBlockWithSaveState();
    const hide = body.search(/\.save-state\s*\{/);
    const show = body.search(/\.save-state--offline\s*\{/);
    expect(show).toBeGreaterThan(-1);
    // Same specificity (one class each), so source order decides.
    expect(show).toBeGreaterThan(hide);
    const rule = /\.save-state--offline\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    // Two assertions, not one negative lookahead: `display:\s*(?!none)` reads
    // as "a display that isn't none" and is satisfied by `display: none`,
    // because \s* backtracks to zero width and the lookahead then sees the
    // space. Caught by mutating the rule to `display: none` and watching this
    // pass.
    expect(rule).toMatch(/display:\s*\S/);
    expect(rule).not.toMatch(/display:\s*none/);
  });
});

describe('the board connection banner', () => {
  it('is styled, and sits in flow rather than over the page', () => {
    const rule = /\n\.conn-banner\s*\{([^}]*)\}/.exec(CSS)?.[1];
    expect(rule).toBeDefined();
    // A fixed/absolute banner covers a control for the whole outage, which at
    // 430px is every control there is.
    expect(rule).not.toMatch(/position:\s*(fixed|absolute)/);
  });
});
