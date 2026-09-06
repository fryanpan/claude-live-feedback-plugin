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
 *
 * PERMANENT SOURCE-SHAPE SITES, and counted as such. Two of the audit's
 * source-shape floor lives here (scripts/test-audit.baseline.json names all
 * three). A `:hover` treatment inside `@media (hover: hover)` needs a real layout engine, and the only browser this repo
 * has is `bun run ui:shot`, which is a local dev tool: it wants a Chrome
 * binary and a running server, and CI runs neither. Moving this there would
 * not convert the test — it would retire it, swapping a gate that runs on
 * every PR for one nobody runs. It carries no `audit: not-source` marker
 * because it IS a source read; what it is not is an unconverted leftover.
 */

// The board's cascade is two files since the board block moved to board.css:
// styles.css keeps the shared chrome, board.css carries the board's own rules,
// and the board shell loads them in that order. A rule this suite pins may sit
// in either, so read the pair the page actually loads. Two reads on purpose:
// a one-line read is what `bun run test:audit` counts, and folding them into
// a loop would hide a source-shape site rather than remove one.
const CSS = [
  readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8'),
  readFileSync(resolve(import.meta.dirname, '../src/board.css'), 'utf8'),
].join('\n');

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

  for (const selector of ['.board-decide-option:hover', '.thread-item-option:hover']) {
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
