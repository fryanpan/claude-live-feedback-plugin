import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The phone task row's width budget.
 *
 * Measured at a true 430px viewport with the coarse-pointer rules forced on,
 * the row is 402px and its fixed chrome (handle 32 · open zone 0 · status 24 ·
 * risk 10 · owner 24 · six 6px gaps) costs 126px. What is left is shared by the
 * title and the badge strip — and the word badges are 55–75px EACH, so a row
 * carrying `decision` + `💬 3` gave its title 167px (42% of the row) and a row
 * carrying `💬 3` + `due Aug 19` gave it 152px (38%). Seven of thirty-three
 * rows fell under half.
 *
 * So on a phone the strip carries one mark: the discussion count. The word
 * badges say in eight characters what the detail panel says in a sentence, and
 * `needs: decision` additionally has the board's own review strip. Same trade
 * the status word and the owner name already made on this row. "A phone" is
 * both halves — coarse pointer AND narrow viewport — because either alone hits
 * somebody with width to spare.
 *
 * `min-width: max-content` is the other half, and it is the one that makes
 * "whole or not at all" structural rather than arithmetic: the strip's grid
 * track can then never be squeezed below its content, so a chip is never
 * clipped mid-glyph — the title (whose track floor is 0) absorbs the shortfall
 * instead. The base rule's `min-width: 0` is what let the track contribute a
 * zero minimum and render `💬 3` as an 11px sliver of a speech bubble.
 *
 * happy-dom has no layout engine and resolves no media queries, so this
 * asserts the CASCADE SHAPE. The rendered 430px row is measured in a browser
 * against a real build; that is what closes the criterion.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/**
 * The phone block's condition, verbatim. Both halves are load-bearing and the
 * test says so: a coarse pointer alone would strip a 1024px tablet that can
 * afford the badges, a width alone would strip a desktop window nobody reviews
 * on.
 */
const PHONE_CONDITION =
  '@media (hover: none) and (max-width: 560px), (pointer: coarse) and (max-width: 560px) {';

/** Body of the phone block that styles the badge strip. */
function phoneRowBlock(): string {
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(PHONE_CONDITION, from);
    if (at === -1) return '';
    let depth = 1;
    let i = at + PHONE_CONDITION.length;
    const start = i;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
      i++;
    }
    const body = CSS.slice(start, i - 1);
    if (body.includes('.hub-task-badges')) return body;
    from = at + PHONE_CONDITION.length;
  }
}

/** Everything OUTSIDE that block — what a desktop row still gets. */
function outsidePhoneBlock(): string {
  const body = phoneRowBlock();
  return body === '' ? CSS : CSS.replace(body, '');
}

describe('the phone task row', () => {
  it('is scoped to a coarse pointer AND a narrow viewport, not either alone', () => {
    // POSITIVE CONTROL for every assertion below: an extractor that came back
    // empty would let each of them pass by measuring nothing.
    const body = phoneRowBlock();
    expect(body).not.toBe('');
    expect(body).toContain('.hub-task-badges');
    // And the condition itself, since dropping either half changes who is hit.
    expect(CSS).toContain(PHONE_CONDITION);
  });

  it('drops the word badges from the strip', () => {
    const body = phoneRowBlock();
    expect(/\.hub-badge\s*\{[^}]*display:\s*none/.test(body)).toBe(true);
  });

  it('keeps the discussion mark, after the drop so it wins', () => {
    const body = phoneRowBlock();
    const hide = body.search(/\.hub-badge\s*\{/);
    const show = body.search(/\.hub-badge-comments\s*\{/);
    expect(show).toBeGreaterThan(-1);
    // Same specificity (one class each), so source order decides.
    expect(show).toBeGreaterThan(hide);
    const rule = /\.hub-badge-comments\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    // Asserted positively, in two parts: `display:\s*(?!none)` is satisfied BY
    // `display: none`, because \s* backtracks to zero width and the lookahead
    // then sees the space.
    expect(rule).toMatch(/display:\s*\S/);
    expect(rule).not.toMatch(/display:\s*none/);
  });

  it('gives the strip a track minimum, so a chip is never clipped mid-glyph', () => {
    const body = phoneRowBlock();
    const rule = /\.hub-task-badges\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*max-content/);
  });

  it('leaves the wider row alone — this is a phone budget, not a redesign', () => {
    const outside = outsidePhoneBlock();
    // The base strip keeps the zero minimum that lets a wide badge strip
    // ellipsize on a desktop row, where there is width to spare.
    const base = /\n\.hub-task-badges\s*\{([^}]*)\}/.exec(outside)?.[1] ?? '';
    expect(base).toMatch(/min-width:\s*0/);
    // And no word badge is hidden outside the coarse block.
    expect(/\n\.hub-badge\s*\{[^}]*display:\s*none/.test(outside)).toBe(false);
  });
});
