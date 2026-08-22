import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The phone task row's width budget.
 *
 * Measured at a true 430px viewport with the coarse-pointer rules forced on,
 * the row was 402px and its fixed chrome (handle 32 · open zone 0 · status 24 ·
 * risk 10 · owner 24 · six 6px gaps) cost 126px. What was left is shared by the
 * title and the badge strip — and the word badges are 55–75px EACH, so a row
 * carrying `decision` + `💬 3` gave its title 167px (42% of the row) and a row
 * carrying `💬 3` + `due Aug 19` gave it 152px (38%). Seven of thirty-three
 * rows fell under half. The risk dot and one 6px gap left the row on
 * 2026-08-18, so the chrome is 110px now; the budget got 16px looser, not
 * loose.
 *
 * Then the pencil's 0-width slot became the open caret and moved to the right
 * of the row (2026-08-21), which spends 14px of that: chrome is 124px and the
 * title gets 274px, 68% of the row. Re-measured rather than re-derived — 261px
 * of title in a 389px row at an emulated ~417px viewport, the same arithmetic
 * one size down. It is 14px well spent: on a pointer that cannot hover, the
 * caret is the only thing on the row that SAYS the row opens, which the
 * pencil — dead on a coarse pointer — never did.
 *
 * So on a phone the strip is hidden. It used to keep exactly one mark — the
 * discussion count — and that badge was removed from the row board-wide on
 * 2026-08-18 at Bryan's request, so there is nothing left to except. The word
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
 * zero minimum and render `💬 3` as an 11px sliver of a speech bubble. It
 * resolves to 0 today (no visible children on a phone) and is kept as the
 * standing guarantee for the next badge shown here, since getting it wrong is
 * silent.
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

/**
 * Comments stripped, because these assertions are about the CASCADE and a
 * comment is not in it — the "no bare `.hub-badge`" check reads its own
 * explanation of the bare rule as the bare rule otherwise.
 */
function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Body of the phone block that styles the badge strip, declarations only. */
function phoneRowBlock(): string {
  return declarationsOnly(rawPhoneRowBlock());
}

/** The same block with its comments, for the source-order arithmetic below. */
function rawPhoneRowBlock(): string {
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
  const body = rawPhoneRowBlock();
  return declarationsOnly(body === '' ? CSS : CSS.replace(body, ''));
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
    expect(/\.hub-task-badges \.hub-badge\s*\{[^}]*display:\s*none/.test(body)).toBe(true);
  });

  it('drops them from the STRIP only — the same class labels a goal section', () => {
    // `renderBoard` puts `hub-badge hub-badge-due` in `.hub-section-title` for
    // a goal's own due date: one per section, not per row, and it costs the
    // title nothing. A bare `.hub-badge { display: none }` took it with them.
    const selectors = phoneRowBlock()
      .split('}')
      .map((chunk) => chunk.split('{')[0]?.trim() ?? '')
      .filter((s) => s !== '');
    // Positive control: the block does have selectors to judge.
    expect(selectors.length).toBeGreaterThan(0);
    expect(selectors).not.toContain('.hub-badge');
    // And every badge selector it does carry is under the strip.
    for (const s of selectors) {
      if (s.includes('.hub-badge')) expect(s.startsWith('.hub-task-badges ')).toBe(true);
    }
  });

  // Until 2026-08-18 this block carried an exception that re-showed the
  // discussion count after the drop, and this case asserted the source order
  // that made it win. The badge is gone from the row entirely (Bryan's call —
  // see `taskBadges`), so the exception went with it and the phone strip is
  // now empty. Asserted as an absence with the drop rule as its control,
  // because an extractor returning '' would satisfy the absence on its own.
  it('carries no un-hiding exception — the phone strip is empty, not selective', () => {
    const body = phoneRowBlock();
    // Control: the rule the exception would have had to outrank is present.
    expect(body).toMatch(/\.hub-task-badges \.hub-badge\s*\{[^}]*display:\s*none/);
    expect(body).not.toMatch(/display:\s*inline/);
    expect(body).not.toContain('hub-badge-comments');
    // And the class is gone from the whole stylesheet, not merely from here.
    expect(declarationsOnly(CSS)).not.toContain('hub-badge-comments');
  });

  it('gives the strip a track minimum, so a chip is never clipped mid-glyph', () => {
    const body = phoneRowBlock();
    const rule = /\.hub-task-badges\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    expect(rule).toMatch(/min-width:\s*max-content/);
  });

  it('declares that minimum AFTER the base rule, or it silently loses', () => {
    // The one that cost a review round. A media query adds NO specificity, so
    // `min-width: max-content` in this block and `min-width: 0` on the bare
    // `.hub-task-badges` are one class each and SOURCE ORDER decides. Written
    // beside the rest of the phone row anatomy it computed to `0px` on a real
    // 430px coarse-pointer viewport while every other rule in the block
    // applied — the badges vanished as intended and the guarantee they were
    // traded for was not there. Nothing about the page looked wrong.
    const base = CSS.search(/\n\.hub-task-badges\s*\{/);
    const phone = CSS.indexOf(PHONE_CONDITION);
    expect(base).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(base);
    // Every OTHER `.hub-task-badges` rule in the file must also precede it —
    // the ≤900px block sets `max-width` on the same selector today, and a
    // min-width added there tomorrow would win from below.
    const all = [...CSS.matchAll(/\.hub-task-badges\s*\{/g)].map((m) => m.index);
    expect(all.length).toBeGreaterThan(1);
    expect(all.filter((i) => i > phone)).toHaveLength(1); // only this block's own
  });

  /**
   * The new chip and the budget it inherits. `parked` is a WORD badge like
   * `due`, so it is hidden on a phone with the rest of the strip — a
   * deliberate cost, not an oversight: on Bryan's iPad (1180x820, far above
   * this block) and on any laptop the chip shows, and on a phone a parked row
   * is title-only and its deferral lives one tap away in the panel's park
   * note, exactly where the overdue mark went.
   *
   * What this pins is that it takes no exception and adds no LAYOUT, so the
   * measured budget above is still the budget. A chip that grew a padding or
   * a min-width here would move numbers that were taken in a browser and
   * cannot be re-derived from the file.
   */
  it('gives the parked chip colour only, and no phone exception', () => {
    const rule = /\n\.hub-badge-parked\s*\{([^}]*)\}/.exec(declarationsOnly(CSS))?.[1] ?? '';
    expect(rule).not.toBe(''); // control: the chip has a rule at all
    expect(rule).toMatch(/border-color|background/);
    for (const layout of ['padding', 'margin', 'min-width', 'width', 'font-size', 'display']) {
      expect(rule, `${layout} would move the measured phone budget`).not.toContain(layout);
    }
    expect(phoneRowBlock()).not.toContain('hub-badge-parked');
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
