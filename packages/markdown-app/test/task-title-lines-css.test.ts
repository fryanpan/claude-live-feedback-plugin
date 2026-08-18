import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * How much of a task title the board actually shows.
 *
 * The ask (Bryan, 2026-08-18): *"a lot of the tickets descriptions are cut off
 * … I want both desktop and mobile views to be clear … on desktop, feel free to
 * widen the task list so more can fit. On mobile, feel free to use up to two
 * lines. I think just about any task can fit in about 20 words or 100
 * characters."* So 100 characters is the unit, one line on desktop and two on a
 * phone.
 *
 * ── What was measured, and how ────────────────────────────────────────────
 * A static page built from the REAL `renderBoard` output and the REAL
 * stylesheet, loaded in Chrome inside a same-origin iframe of an exact width
 * (the ux-review skill's method — Chrome will not make a WINDOW narrower than
 * ~500px, and this machine's window manager ignored a resize to 1512 as well).
 * The coarse-pointer rules were forced on by mutating `CSSMediaRule.media
 * .mediaText` IN PLACE, never by unwrapping rules into an appended <style>,
 * which would hand them last-wins position and measure a cascade no browser
 * produces.
 *
 *   1512px viewport, before: `#hub-root` 1280 · `.hub-main` `220px 712px
 *   280px` · row 712 · title 578 · **78 characters**. A row carrying the
 *   `decision` badge (60px) gave its title 518 — 70 characters.
 *   430px viewport, coarse pointer forced on, before: row 402 · title 288 on
 *   ONE line — **39 of 96 characters**, the other 57 behind an ellipsis.
 *
 * Two constants come out of that and both are used below:
 *   • the row's fixed chrome is **134px** — handle 18 · open zone 16 · status
 *     24 · owner 24 · five 8px gaps · 12px row padding — confirmed by
 *     712 − 578 = 134 in the browser, not only by adding the declarations up;
 *   • a real sentence in `--sans` at 16px costs **7.32px per character**
 *     (measured over a 96-character title, so it is an average over real
 *     letter frequencies rather than an `em` guess).
 *
 * happy-dom resolves no media queries and runs no layout, so what this file
 * asserts is the CASCADE SHAPE and the WIDTH ARITHMETIC the stylesheet
 * commits to. The rendered rows at 430px and 1512px are what close the
 * criterion, and those numbers are in the PR.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** Comments stripped — a comment is not in the cascade, and these assertions
 *  are about the cascade. (The phone-row budget test learned this the hard
 *  way: its own prose about a rule matched as the rule.) */
function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Body of the `@media (max-width: <=560px)` block that clamps the title. */
const NARROW_CONDITION = '@media (max-width: 560px) {';

function blockBodyContaining(condition: string, needle: string): string {
  let from = 0;
  for (;;) {
    const at = CSS.indexOf(condition, from);
    if (at === -1) return '';
    let depth = 1;
    let i = at + condition.length;
    const start = i;
    while (i < CSS.length && depth > 0) {
      if (CSS[i] === '{') depth++;
      else if (CSS[i] === '}') depth--;
      i++;
    }
    const body = CSS.slice(start, i - 1);
    if (body.includes(needle)) return body;
    from = at + condition.length;
  }
}

function twoLineBlock(): string {
  return declarationsOnly(blockBodyContaining(NARROW_CONDITION, '.hub-task-title'));
}

/** The `.hub-task-title` rule that is NOT inside the narrow block. */
function baseTitleRule(): string {
  const outside = declarationsOnly(CSS.replace(twoLineBlock(), ''));
  return /\n\.hub-task-title\s*\{([^}]*)\}/.exec(outside)?.[1] ?? '';
}

// ── the numbers the browser gave, used as thresholds ──────────────────────
/** Fixed, non-title width of one desktop row: handle · open zone · status ·
 *  owner · five gaps · padding. Measured 712 − 578 at a 1512px viewport. */
const ROW_CHROME_PX = 134;
/** A real sentence in `--sans` at 16px, averaged over a 96-character title. */
const PX_PER_CHAR = 7.32;
/** The `decision` badge, the widest single mark a row carries on desktop.
 *  Included so the criterion holds on a row that has one, not only on a bare
 *  row — a threshold that only the emptiest row can meet is not the criterion
 *  Bryan asked for. */
const BADGE_PX = 60;
const TARGET_CHARS = 100;

/**
 * The page's own geometry, read out of the stylesheet rather than restated —
 * a literal here would just be a second place to forget to update.
 */
function pageGeometry(): {
  maxWidth: number;
  padX: number;
  sides: number[];
  gap: number;
  stackAt: number;
} {
  const bare = declarationsOnly(CSS);
  const rootRule = /#hub-root\s*\{([^}]*)\}/.exec(bare)?.[1] ?? '';
  const maxWidth = Number(/max-width:\s*(\d+)px/.exec(rootRule)?.[1]);
  // `padding: 0 14px calc(...)` — the second value is the horizontal one.
  const padX = Number(/padding:\s*\S+\s+(\d+)px/.exec(rootRule)?.[1]);
  const mainRule = /\.hub-main\s*\{([^}]*)\}/.exec(bare)?.[1] ?? '';
  const cols = /grid-template-columns:\s*([^;]+);/.exec(mainRule)?.[1] ?? '';
  const gap = Number(/gap:\s*(\d+)px/.exec(mainRule)?.[1]);
  const sides = [...cols.matchAll(/(\d+)px/g)].map((m) => Number(m[1]));
  // The widest viewport that still gets three columns is one pixel above the
  // block that collapses `.hub-main` to a single track.
  const stackAt = Number(
    /@media \(max-width:\s*(\d+)px\)\s*\{\s*\.hub-main\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/.exec(
      bare,
    )?.[1],
  );
  // Positive controls: every input parsed, so a regex that silently missed
  // cannot make the arithmetic below pass with NaN or 0.
  expect(Number.isFinite(maxWidth)).toBe(true);
  expect(Number.isFinite(padX)).toBe(true);
  expect(Number.isFinite(gap)).toBe(true);
  expect(Number.isFinite(stackAt)).toBe(true);
  expect(sides).toHaveLength(2);
  expect(cols).toContain('minmax(0, 1fr)');
  return { maxWidth, padX, sides, gap, stackAt };
}

/** Title-track width for a given viewport, while three columns are showing. */
function titleWidthAt(viewport: number, badgePx: number): number {
  const g = pageGeometry();
  const root = Math.min(viewport, g.maxWidth);
  return root - 2 * g.padX - g.sides[0] - g.sides[1] - 2 * g.gap - ROW_CHROME_PX - badgePx;
}

describe('a task title on desktop', () => {
  it('stays on one line and ends in an ellipsis, never a mid-word clip', () => {
    const rule = baseTitleRule();
    expect(rule).not.toBe(''); // control: the rule was found
    expect(rule).toMatch(/white-space:\s*nowrap/);
    expect(rule).toMatch(/text-overflow:\s*ellipsis/);
    expect(rule).toMatch(/overflow:\s*hidden/);
  });

  it('gets a board wide enough for 100 characters PLUS a badge at full width', () => {
    const g = pageGeometry();
    expect(titleWidthAt(g.maxWidth, BADGE_PX)).toBeGreaterThanOrEqual(
      Math.ceil(TARGET_CHARS * PX_PER_CHAR),
    );
  });

  // The band this catches is the counter-intuitive one: the two side columns
  // and their gaps cost a FLAT 500px however narrow the window gets, so the
  // three-column layout is at its worst at the bottom of its own range. At a
  // 901px viewport it gave a title 239px — about 32 characters, worse than the
  // same board on a 430px phone — and one pixel narrower it stacked and gave
  // it 938px. A ceiling on the page's width cannot see that; only the FLOOR of
  // the three-column band can.
  it('never shows less than half a title, even on the narrowest three-column window', () => {
    const g = pageGeometry();
    expect(titleWidthAt(g.stackAt + 1, 0)).toBeGreaterThanOrEqual(
      Math.ceil((TARGET_CHARS / 2) * PX_PER_CHAR),
    );
  });
});

describe('a task title on a phone', () => {
  it('gets two lines, not one', () => {
    const body = twoLineBlock();
    // Control for every assertion in this describe: an extractor that came
    // back empty would let each of them pass by measuring nothing.
    expect(body).not.toBe('');
    expect(body).toContain('.hub-task-title');
    const rule = /\.hub-task-title\s*\{([^}]*)\}/.exec(body)?.[1] ?? '';
    expect(rule).toMatch(/display:\s*-webkit-box/);
    expect(rule).toMatch(/-webkit-box-orient:\s*vertical/);
    expect(rule).toMatch(/-webkit-line-clamp:\s*2/);
    // Standard `line-clamp` alongside the prefixed one, or the rule stops
    // working the day a browser drops the `-webkit-` alias.
    expect(rule).toMatch(/[^-]line-clamp:\s*2/);
    // The base rule's `nowrap` has to be undone here or there is only ever
    // one line to clamp — the declaration that makes the other three mean
    // anything.
    expect(rule).toMatch(/white-space:\s*normal/);
  });

  it('breaks an unbreakable token rather than letting it set the row width', () => {
    // `minmax(0, 1fr)` stops the TRACK from growing; without this the token
    // itself still overflows its own line box and is clipped mid-glyph with
    // no ellipsis in sight.
    const rule = /\.hub-task-title\s*\{([^}]*)\}/.exec(twoLineBlock())?.[1] ?? '';
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it('declares the clamp AFTER every other rule for the title, or it silently loses', () => {
    // The one this repo has already paid for. A media query adds NO
    // specificity: `white-space: normal` in a `@media` block and
    // `white-space: nowrap` on the bare `.hub-task-title` are one class each,
    // so SOURCE ORDER decides. Written above the base rule the block would
    // match, show in devtools, and compute to `nowrap` — the quietest possible
    // failure.
    const narrow = CSS.indexOf(NARROW_CONDITION + '\n  .hub-task-title');
    const at = narrow === -1 ? CSS.indexOf(NARROW_CONDITION) : narrow;
    expect(at).toBeGreaterThan(-1);
    const all = [...CSS.matchAll(/\.hub-task-title[^{]*\{/g)].map((m) => m.index as number);
    expect(all.length).toBeGreaterThan(1); // control: there ARE other rules
    // Exactly one `.hub-task-title` rule sits after the block opens: the
    // block's own.
    expect(all.filter((i) => i > at)).toHaveLength(1);
  });

  it('leaves the wider row on one line — this is a phone budget, not a redesign', () => {
    // Absence, so it needs the presence above it: the clamp exists (asserted
    // in the first case) and it is confined to the narrow block. Scoped to
    // the TITLE's own rules — three other surfaces in this stylesheet clamp
    // legitimately (an anchor quote, a diff group's file list, a balloon), so
    // a file-wide search for `line-clamp` measures them and not this.
    const outside = declarationsOnly(CSS.replace(twoLineBlock(), ''));
    for (const m of outside.matchAll(/\.hub-task-title[^{]*\{([^}]*)\}/g)) {
      expect(m[1]).not.toContain('line-clamp');
    }
    expect(baseTitleRule()).toMatch(/white-space:\s*nowrap/);
  });
});
