import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Decision-option hover rules are hover-only, in CSS.
 *
 * On touch there is no hover state to leave: the accent border a
 * `:hover` rule paints sticks to the last-tapped option until the next tap
 * lands somewhere else, and a stuck accent border on a decision option reads
 * as a recorded choice. So both option selectors take their hover treatment
 * inside `@media (hover: hover)` — same precedent as the task-title hover
 * affordance. Read as text because a layout-free runner cannot evaluate a
 * media query; each probe asserts it FOUND the rule before judging where it
 * sits, so a renamed selector fails loudly rather than passing empty.
 */

const CSS = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

/** Every `@media (hover: hover)…{ … }` block's inner text, brace-matched. */
function hoverGuardedCss(): string {
  const out: string[] = [];
  let idx = 0;
  for (;;) {
    const at = CSS.indexOf('@media (hover: hover)', idx);
    if (at === -1) break;
    const open = CSS.indexOf('{', at);
    let depth = 1;
    let i = open + 1;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      if (CSS[i] === '}') depth--;
      i++;
    }
    out.push(CSS.slice(open + 1, i - 1));
    idx = i;
  }
  return out.join('\n');
}

describe('decision option hover rules', () => {
  const guarded = hoverGuardedCss();

  for (const selector of ['.hub-decide-option:hover', '.thread-item-option:hover']) {
    it(`${selector} exists, and only where hover exists`, () => {
      // Positive control first: the rule is still spelled this way at all.
      expect(CSS).toContain(selector);
      expect(guarded).toContain(selector);
      // …and no copy of it survives outside the guard.
      const unguarded = CSS.split(selector).length - 1 - (guarded.split(selector).length - 1);
      expect(unguarded, `${selector} outside @media (hover: hover)`).toBe(0);
    });
  }
});
