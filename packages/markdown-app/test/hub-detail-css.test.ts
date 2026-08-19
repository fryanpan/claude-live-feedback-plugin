import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The task panel's LAYOUT rules — the half of the redesign that no DOM test
 * can see, because happy-dom resolves no layout and every one of these is a
 * property of the stylesheet rather than of the tree.
 *
 * Three of Bryan's eight anchored comments on the 2026-08-18 staging build are
 * pure CSS: the panel's width, the goal field's own line, and the Description
 * heading's separation. Each is asserted here by the number he gave, so a
 * later edit that quietly halves one goes red rather than merely looking
 * different. (A fourth was the mic clearance at 430px; it moved out of this
 * file when the mic stopped floating over the panel — see
 * `hub-mic-dock-css.test.ts`.)
 *
 * The rendered result is checked in a real browser at desktop and at 430px;
 * that is what closes the criterion. What this file prevents is a rule being
 * deleted or re-valued with nothing to notice.
 */
const CSS = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

/** The query the split-pane block is keyed off. Named once: several tests
 *  scope themselves to that block, and a stale copy of the number would
 *  silently search nothing and pass. */
const SPLIT = '(min-width: 1660px)';

function declarationsOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The body of one rule. `within` scopes the search to a media block's text,
 *  which matters because the same selector is styled differently at each
 *  breakpoint and a file-wide search would return whichever came first. */
function rule(selector: string, within: string = declarationsOnly(CSS)): string {
  const at = new RegExp(
    `(^|\\n|\\{)\\s*${selector.replace(/[.+*[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`,
  ).exec(within);
  return at?.[2] ?? '';
}

/** Every `@media` block matching this query, concatenated, braces balanced by
 *  counting. ALL of them: this file carries five separate `max-width: 900px`
 *  blocks, and taking the first one silently searched the wrong 400 lines. */
function media(query: string): string {
  const css = declarationsOnly(CSS);
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const start = css.indexOf(`@media ${query}`, from);
    if (start < 0) break;
    let depth = 0;
    for (let i = css.indexOf('{', start); i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        out.push(css.slice(start, i));
        from = i;
        break;
      }
    }
    if (from <= start) break;
  }
  return out.join('\n');
}

describe('the task panel is as wide as it was asked to be', () => {
  it('resolves its width from ONE expression, used by the panel and the board', () => {
    // Positive control for every assertion below: if the token is not defined,
    // both use sites resolve to nothing and the width assertions pass while
    // measuring an empty string.
    expect(rule(':root')).toMatch(/--hub-detail-w:/);
    // 1100 by default, floored at 900 while the viewport can pay for it —
    // *"default 1100px, at least 900px when space allows"*.
    expect(rule(':root')).toMatch(/--hub-detail-w:\s*min\(1100px,\s*max\(900px,/);
  });

  it('uses that width in the modal AND in the split pane', () => {
    expect(rule('.hub-detail-panel')).toMatch(/width:\s*min\(var\(--hub-detail-w\)/);
    const split = media(SPLIT);
    expect(split, 'the split-pane block is missing').not.toBe('');
    // The split resolves it through `--hub-detail-pane-w`, which is the same
    // expression capped by what the board keeps. The 52vw this replaced gave a
    // 1512px laptop a 760px pane — the "cramped on bigger screens" report
    // unfixed.
    expect(rule(':root')).toMatch(/--hub-detail-pane-w:\s*min\(var\(--hub-detail-w\)/);
    expect(rule('.hub-detail-panel', split)).toMatch(/width:\s*var\(--hub-detail-pane-w\)/);
    expect(rule('.hub-detail-panel', split)).not.toMatch(/52vw/);
  });

  it('reflows the board out from under the panel instead of over-painting it', () => {
    // The review banner and the quick-capture row ran under the panel's edge
    // and were clipped by it. Reserving the panel's own width is the fix, and
    // it must reserve THE SAME width — hence the shared token.
    const split = media(SPLIT);
    // Inside a `min()` since the floor's clamp landed — the reservation is
    // still the pane's own width, now with a ceiling on how much of the board
    // it is allowed to take.
    expect(rule('body.hub-detail-open .hub-main', split).replace(/\s+/g, ' ')).toMatch(
      /padding-right: min\( calc\(var\(--hub-detail-pane-w\) \+ var\(--hub-detail-gap\)\),/,
    );
    // ...and give it back at full screen, where the panel covers the board.
    expect(rule('body.hub-detail-open.hub-detail-full .hub-main', split)).toMatch(
      /padding-right:\s*0/,
    );
  });
});

/**
 * The split's breakpoint is arithmetic, and this is the arithmetic.
 *
 * It started at 1024px on the reasoning that 1024 is "room for two columns".
 * It is not: the panel is floored at 900 and the board's column is what pays
 * for it, so every width from 1024 up to about 1650 reflowed the list into a
 * sliver and called it a split. Measured at 1191px — task rows 0px wide, the
 * capture input 42px, "Capture a task" rendering as "Ca"; at 1600px the column
 * was 274px and every user-story title clipped after ~20 characters.
 *
 * Asserted as a RELATIONSHIP between the numbers rather than as the numbers,
 * so moving any one of them on purpose stays possible and moving one by
 * accident goes red.
 */
describe('the split pane starts where both columns fit', () => {
  const px = (s: string | undefined) => Number(/(\d+)px/.exec(s ?? '')?.[1]);
  const root = rule(':root');
  const boardMin = px(/--hub-board-min:\s*([^;]+);/.exec(root)?.[1]);
  const panelMin = px(/--hub-detail-w:\s*min\([^,]+,\s*max\(([^,]+),/.exec(root)?.[1]);
  /** What `--hub-board-keep` adds on top of the board's own floor: the chrome
   *  between and around the two columns, summed from the parts the stylesheet
   *  states rather than from the total, because the total is a `calc()`. */
  const inset = px(/--hub-board-inset:\s*([^;]+);/.exec(root)?.[1]);
  const gutters = px(/--hub-board-chrome:\s*calc\(\s*([0-9]+px)/.exec(root)?.[1]);
  const detailGap = px(/--hub-detail-gap:\s*([^;]+);/.exec(root)?.[1]);
  const chrome = gutters + inset + detailGap;
  const breakpoint = px(SPLIT);

  it('reads all four numbers, so the comparison below is not vacuous', () => {
    for (const [name, n] of [
      ['--hub-board-min', boardMin],
      ['the panel floor inside --hub-detail-w', panelMin],
      ['--hub-board-inset', inset],
      ['the gutters term of --hub-board-chrome', gutters],
      ['--hub-detail-gap', detailGap],
      ['the split breakpoint', breakpoint],
    ] as const) {
      expect(Number.isFinite(n), `${name} did not parse`).toBe(true);
    }
  });

  it('opens no lower than panel floor + board floor + chrome', () => {
    expect(breakpoint).toBeGreaterThanOrEqual(panelMin + boardMin + chrome);
  });

  it('caps the pane so the board keeps its floor at every width above it', () => {
    // Without the cap the panel takes 62vw and the board takes the remainder,
    // which at the breakpoint is 297px — under its floor, i.e. the sliver
    // again, one breakpoint higher.
    expect(rule(':root').replace(/\s+/g, ' ')).toMatch(
      /--hub-detail-pane-w: min\(var\(--hub-detail-w\), calc\(100vw - var\(--hub-board-keep\)\)\)/,
    );
    // And the cap still leaves the panel its own floor at the breakpoint —
    // the two floors are simultaneously satisfiable exactly there, which is
    // what makes this the lowest honest breakpoint rather than a guess.
    expect(breakpoint - boardMin - chrome).toBeGreaterThanOrEqual(panelMin);
  });
});

/**
 * The board's floor, in RENDERED pixels, at the widths people actually use.
 *
 * The block above asserts a relationship between four tokens and passed while
 * the board rendered 166px at 1920 — because the reservation is derived from
 * `100vw` and then spent inside a container the page caps. Every number the
 * panel reserves is viewport-sized; every number the board has left is
 * container-sized; nothing compared the two.
 *
 * So this models what the browser does — cap, reservation, chrome — and the
 * first test below CALIBRATES that model against four independently measured
 * pixel counts before any of the others are allowed to mean anything.
 *
 * The inversion is the tell. 1661 → 1920 is +259px of screen and −193px of
 * board, and 1920 is the width of the display this is read on.
 *
 * One input here is measured rather than parsed: the nav rail's track is
 * `max-content`, so no stylesheet literal states its width. It reaches this
 * file only as the chrome term of `--hub-board-keep`, which is why that
 * constant being viewport-relative rather than container-relative was able to
 * be wrong for so long without anything noticing.
 */
describe('the board keeps its floor in rendered pixels, not just in tokens', () => {
  const px = (s: string | undefined) => Number(/(-?\d+)px/.exec(s ?? '')?.[1]);
  const root = rule(':root');
  const boardMin = px(/--hub-board-min:\s*([^;]+);/.exec(root)?.[1]);
  /** Everything left of the board inside `.hub-main`: the nav rail's track
   *  and the grid gap. The floor's clamp is written in these coordinates. */
  const inset = px(/--hub-board-inset:\s*([^;]+);/.exec(root)?.[1]);
  /** The page's own gutters, from the same expression that builds
   *  `--hub-board-chrome`, so the model cannot drift from the stylesheet. */
  const gutters = px(/--hub-board-chrome:\s*calc\(\s*([0-9]+px)/.exec(root)?.[1]);
  const pageW = px(/--hub-page-w:\s*([^;]+);/.exec(root)?.[1]);
  const gap = px(/--hub-detail-gap:\s*([^;]+);/.exec(root)?.[1]);
  const detailMax = px(/--hub-detail-w:\s*min\(([^,]+),/.exec(root)?.[1]);
  const detailMin = px(/--hub-detail-w:\s*min\([^,]+,\s*max\(([^,]+),/.exec(root)?.[1]);
  const detailVw = Number(/--hub-detail-w:[^;]*?(\d+)vw/.exec(root)?.[1]);

  /** The chrome in `#hub-root`'s coordinates, as `--hub-board-chrome` builds
   *  it: gutters both sides + the inset + the panel's offset. 234px. */
  const chrome = gutters + inset + gap;

  /** `--hub-detail-pane-w`, evaluated. Fed the viewport `100vw` reads, which
   *  on a classic-scrollbar platform is wider than anything it is spent in —
   *  the discrepancy the clamps below exist to absorb. */
  const paneAt = (vw: number) =>
    Math.min(
      Math.min(detailMax, Math.max(detailMin, (detailVw / 100) * vw)),
      vw - boardMin - chrome,
    );

  /**
   * What `#hub-root` is capped at while the panel is open, READ FROM THE CSS
   * rather than assumed — with no open-state override the cap is the page's
   * own, which is the state that rendered 166px and the state this test has
   * to be able to describe. Only the `+ pane + gap` shape is recognised,
   * because that is the only one that makes the reservation and the container
   * agree; anything else falls back and the floor assertion fails, which is
   * the correct outcome for a cap that does not grow with the panel.
   */
  const openRule = rule('body.hub-detail-open #hub-root', media(SPLIT));
  const capGrowsWithPane =
    /max-width:\s*calc\(\s*var\(--hub-page-w\)\s*\+\s*var\(--hub-detail-pane-w\)\s*\+\s*var\(--hub-detail-gap\)\s*\)/.test(
      openRule,
    );
  const openCapAt = (vw: number) => (capGrowsWithPane ? pageW + paneAt(vw) + gap : pageW);

  /**
   * The reservation `.hub-main` actually applies, INCLUDING its clamp — the
   * `min()` read from the CSS rather than assumed, so a stylesheet that drops
   * the clamp is modelled without it and fails the floor, which is the
   * correct outcome for a stylesheet that no longer guarantees one.
   */
  const mainRule = rule('body.hub-detail-open .hub-main', media(SPLIT));
  const reservationIsClamped =
    /padding-right:\s*min\(/.test(mainRule) &&
    /calc\(\s*100%\s*-\s*var\(--hub-board-inset\)\s*-\s*var\(--hub-board-min\)\s*\)/.test(mainRule);
  const padAt = (mainW: number, vw: number) => {
    const want = paneAt(vw) + gap;
    return reservationIsClamped ? Math.min(want, mainW - inset - boardMin) : want;
  };

  /**
   * The board's rendered width, all four boxes in the order the browser
   * resolves them: the layout viewport (`vw` MINUS the scrollbar), the
   * container's open-state cap, `.hub-main` inside its gutters, and the
   * clamped reservation taken out of that.
   *
   * All three of the defect's layers are visible here. `openCapAt` is what
   * made the reservation and the CONTAINER disagree; `vw - sb` is what made
   * it disagree with the LAYOUT; and `padAt`'s clamp is what makes the floor
   * hold anyway, because it is expressed in `.hub-main`'s own coordinates and
   * so never needs to know what `sb` is.
   *
   * `sb` is a parameter rather than a constant because it is the platform's
   * to choose — and because two runs of the same Chrome measured 15 and then
   * 19, which is precisely why no constant belongs in the stylesheet.
   */
  const boardAt = (vw: number, sb = 0) => {
    const rootW = Math.min(openCapAt(vw), vw - sb);
    const mainW = rootW - gutters;
    return mainW - padAt(mainW, vw) - inset;
  };
  /** Overlay, both values this Chrome produced, Windows, and one absurdly
   *  wide — the floor must not depend on which of these it gets. */
  const scrollbars = [0, 15, 17, 19, 40];
  const openCap = () => openCapAt(1920);

  /**
   * The model, fed the tokens as they stood when a reviewer measured the
   * rendered pixels, must return the pixels they measured. Without this the
   * assertions below are a model checking itself.
   *
   * Two constants are spelled out because they are the ones that MOVED: the
   * pane cap's chrome term was 334 (a viewport-relative number that folded in
   * the 100px the 1500px cap threw away at the 1600px window it was taken
   * from), while the chrome physically between the container's edge and the
   * list was 234 the whole time. One quantity, two values, and the gap
   * between them is the defect.
   */
  it('reproduces six measured pixel counts before asserting anything', () => {
    const paneThen = (vw: number, keep: number) =>
      Math.min(Math.min(1100, Math.max(900, 0.62 * vw)), vw - keep);
    /** The layout with NO clamp — every state this file has been in before
     *  the clamps, parameterised by the two things that moved. */
    const boardThen = (vw: number, keep: number, sb: number, cap: number) => {
      const pane = paneThen(vw, keep);
      return Math.min(cap, vw - sb) - pane - 234;
    };

    // The three the UX pass measured on the shipped branch: cap 1500, keep
    // 420 + 334. The page cap binds at all three, which is why the scrollbar
    // is invisible in them and why `sb` can be 0 here without being wrong.
    expect(boardThen(1661, 754, 0, 1500)).toBe(359);
    expect(boardThen(1920, 754, 0, 1500)).toBe(166);
    expect(boardThen(2400, 754, 0, 1500)).toBe(166);
    // And the one recorded in `--hub-board-min`'s own comment, from before a
    // pane cap existed at all: a 992px panel at 1600px left a 274px column.
    expect(Math.min(1500, 1600) - 992 - 234).toBe(274);

    // The last two are the ones that falsified a fix each, both measured in
    // Chrome at a 1661px frame where the page cap does NOT bind — which is
    // exactly why the four above could never have surfaced either of them.
    //
    // With the container cap fixed and keep = 420 + 234, `#hub-board` came
    // out 405 rather than the 420 the model predicted; the missing 15 was the
    // scrollbar. With a 17px allowance added — keep = 420 + 234 + 17 — it came
    // out 418, because the same Chrome reported 19 on the second run. Two
    // measurements of one constant, two different answers: the reason the
    // stylesheet now clamps against `100%` instead of naming a number.
    const grown = (vw: number, keep: number) => 1500 + paneThen(vw, keep) + 16;
    expect(boardThen(1661, 654, 15, grown(1661, 654))).toBe(405);
    expect(boardThen(1661, 671, 19, grown(1661, 671))).toBe(418);
  });

  it('reads every number, so the comparisons below are not vacuous', () => {
    for (const [name, n] of [
      ['--hub-board-min', boardMin],
      ['--hub-board-inset', inset],
      ['the gutters term of --hub-board-chrome', gutters],
      ['--hub-page-w', pageW],
      ['--hub-detail-gap', gap],
      ['the 1100 ceiling of --hub-detail-w', detailMax],
      ['the 900 floor of --hub-detail-w', detailMin],
      ['the vw term of --hub-detail-w', detailVw],
      ['the open-state cap', openCap()],
    ] as const) {
      expect(Number.isFinite(n), `${name} did not parse`).toBe(true);
    }
    // And the two clamps are actually in the stylesheet. Without this the
    // model silently drops to its unclamped branch and the floor tests below
    // would be asserting against a layout the page no longer has.
    expect(reservationIsClamped, "the reservation's floor clamp is missing").toBe(true);
    expect(rule('.hub-detail-panel', media(SPLIT))).toMatch(
      /max-width:\s*calc\(100%\s*-\s*var\(--hub-board-keep\)\)/,
    );
  });

  /**
   * The clamps are a PAIR, and they have to meet. The reservation's clamp
   * fixes the board's right edge at `gutter + inset + board-min`; the panel's
   * clamp keeps its left edge at least `board-keep` in from the layout's right
   * edge. If those ever crossed, the floor would be honoured by a board the
   * panel is sitting on top of — the exact failure the reservation was added
   * to prevent, reintroduced by the thing that enforces the floor.
   */
  it('leaves a gap between the board and the panel, not an overlap', () => {
    for (const vw of [1661, 1720, 1920, 2400, 4000]) {
      for (const sb of scrollbars) {
        const layout = vw - sb;
        const rootW = Math.min(openCapAt(vw), layout);
        const boardRight = (layout - rootW) / 2 + gutters / 2 + inset + boardAt(vw, sb);
        const panelLeft = layout - Math.min(paneAt(vw), layout - boardMin - chrome);
        expect(
          panelLeft - boardRight,
          `board ends at ${boardRight}, panel starts at ${panelLeft} (${vw}px, ${sb}px scrollbar)`,
        ).toBeGreaterThanOrEqual(0);
      }
    }
  });

  // 420px is where a row shows enough of a user story to be scanned rather
  // than guessed at — the number the whole breakpoint was derived from, and
  // the one that was never once reached.
  it('honours --hub-board-min at 1661, 1920 and 2400', () => {
    for (const vw of [1661, 1920, 2400]) {
      for (const sb of scrollbars) {
        const w = boardAt(vw, sb);
        expect(w, `board is ${w}px at ${vw}px with a ${sb}px scrollbar`).toBeGreaterThanOrEqual(
          boardMin,
        );
      }
    }
  });

  // The failure was not merely "too small" — it was BACKWARDS. A wider screen
  // gave a narrower list, so the machine this is read on was the worst case.
  it('never gives a wider screen a narrower board', () => {
    const widths = [1661, 1720, 1920, 2200, 2400, 2800];
    for (const sb of scrollbars) {
      for (let i = 1; i < widths.length; i += 1) {
        const prev = boardAt(widths[i - 1], sb);
        const here = boardAt(widths[i], sb);
        expect(
          here,
          `${widths[i - 1]}px gave ${prev}px, ${widths[i]}px gave ${here}px (${sb}px scrollbar)`,
        ).toBeGreaterThanOrEqual(prev);
      }
    }
  });

  // And the reader never gets a row WIDER than the page cap was willing to
  // give them with no panel open — the cap's own comment is about how much of
  // a sentence a row should show, and opening a panel must not overrun it.
  it('never lets the board exceed what the closed page would have given it', () => {
    const closedBoard = pageW - chrome + gap;
    expect(boardAt(4000)).toBeLessThanOrEqual(closedBoard);
  });
});

/**
 * The tabs were visible and dead at the place a reader reaches them: the head
 * is sticky, opaque and 90px tall, and the tab row scrolled to y 68–108, so
 * both tab centres sat underneath it while an 18px sliver stayed visible.
 * Clicking the label you could see hit the head and `aria-selected` never
 * moved.
 */
describe('the tab row is reachable where it appears', () => {
  const tabs = rule('.hub-detail-tabs');

  it('docks under the sticky head rather than sliding beneath it', () => {
    expect(tabs).toMatch(/position:\s*sticky/);
    // Offset by the head's MEASURED height, published by renderTaskDetail: the
    // head grows a line when a long title wraps, so a constant would be wrong
    // on exactly the tickets with the longest names. The fallback is for the
    // first paint and for environments that resolve no layout.
    expect(tabs).toMatch(/top:\s*var\(--hub-detail-head-h,\s*\d+px\)/);
    // Opaque, or the comments scroll through the labels.
    expect(tabs).toMatch(/background:\s*var\(--bg\)/);
    // Over the content it is docked above, not under it.
    expect(tabs).toMatch(/z-index:\s*1/);
  });

  it('lands a switch under the head, not under the scrollport’s own top', () => {
    // `land()` calls scrollIntoView({block:'start'}), which aligns to the
    // scrollport top — the exact strip the head is painted over. The margin is
    // what makes "the top" mean "below the head", and it must be the SAME
    // offset the row sticks at or the two disagree by a tab's height.
    const margin = /scroll-margin-top:\s*([^;]+);/.exec(tabs)?.[1]?.trim();
    const top = /top:\s*([^;]+);/.exec(tabs)?.[1]?.trim();
    expect(margin, 'the tab row has no scroll margin').toBeDefined();
    expect(margin).toBe(top);
  });
});

describe('the panel’s fields and headings', () => {
  it('gives the goal its own line, because a goal title is free text', () => {
    // *"Goal field: own line — the goal title can be longer than the column
    // has room for."* Goal is the LAST field, which is why the selector moved
    // off `:first-child` when the status chip row went away.
    expect(rule('.hub-detail-field:last-child')).toMatch(/grid-column:\s*1 \/ -1/);
    // Status is emphatically no longer the full-width one.
    expect(rule('.hub-detail-field:first-child')).toBe('');
  });

  it('stacks the fields on a phone rather than orphaning one beside a gap', () => {
    // Measured in the browser at 430px, not reasoned from the file: the panel's
    // content box there is ~384px, so a column floor of 170 fits TWO columns —
    // and since GOAL takes the whole line, DUE ends up alone in a half cell
    // with an empty one beside it. The floor has to exceed half the phone's
    // content width for the grid to give up and stack.
    const grid = rule('.hub-detail-fields');
    const floor = /minmax\((\d+)px, 1fr\)/.exec(grid)?.[1];
    expect(floor, 'the field grid lost its auto-fit floor').toBeDefined();
    expect(Number(floor)).toBeGreaterThan(384 / 2);
    // …and the positive control, so this cannot be satisfied by a floor so
    // large that the split pane stacks too: four across must still fit the
    // 874px pane, i.e. 4 columns plus three 16px gaps.
    expect(Number(floor) * 4 + 16 * 3).toBeLessThanOrEqual(874);
  });

  it('holds the description to a readable measure when the panel goes wide', () => {
    // Measured in a browser in full screen at a 1512px window: the description
    // ran 1449px, about 177 characters a line, where the readable range tops
    // out near 75. The panel is width-flexible and prose is not.
    const slot = rule('.hub-detail-body-slot');
    const measure = /max-width:\s*(\d+)ch/.exec(slot);
    expect(measure, 'the description has no measure').not.toBeNull();
    expect(Number(measure?.[1])).toBeLessThanOrEqual(80);
    // A `ch` cap binds only where the panel is WIDER than it, so the phone is
    // untouched — that is the property worth pinning, since a px cap set from
    // the same measurement would also clamp the 383px phone column. Asserting
    // the unit is asserting that.
    expect(slot).not.toMatch(/max-width:\s*\d+px/);
    // And it stays in the panel's left column: centring one section breaks the
    // edge the fields and the queue above it are read down.
    expect(slot).not.toMatch(/margin(-inline)?:\s*[^;]*auto/);
  });

  it('draws all four values as one kind of control at one height', () => {
    const ctl = rule('.hub-detail-select,\n.hub-detail-input');
    expect(ctl, 'the shared control rule is missing').not.toBe('');
    expect(ctl).toMatch(/min-height:\s*36px/);
    // A long goal title or agent id must not set the control's intrinsic width
    // and push the panel past a 430px viewport.
    expect(ctl).toMatch(/min-width:\s*0/);
    expect(ctl).toMatch(/max-width:\s*100%/);
    // The board's 44px assignee pill is brought down to the same row height —
    // four boxes at two heights is the reported inconsistency in miniature.
    expect(rule('.hub-detail-field-v .hub-assignee-btn')).toMatch(/min-height:\s*36px/);
  });

  it('puts the status mark and its dropdown on one line', () => {
    // *"Show ONLY the current status, with the status icon used in the summary
    // view, and a dropdown to change it."*
    const ctl = rule('.hub-detail-statusctl');
    expect(ctl).toMatch(/display:\s*flex/);
    expect(ctl).toMatch(/align-items:\s*center/);
    // …and it fills its cell, so STATUS ends on the same right edge as the
    // other three. Its parent is a flex container, so the default `0 1 auto`
    // shrink-wraps it — measured at 137px inside a 383px cell at 430px.
    expect(ctl).toMatch(/flex:\s*1 1 auto/);
    // The mark keeps its 18px; the select takes the rest and may shrink.
    expect(rule('.hub-detail-statusctl .hub-status-mark')).toMatch(/flex:\s*none/);
    expect(rule('.hub-detail-statusctl .hub-detail-status')).toMatch(/min-width:\s*0/);
    // The chip row is GONE, not merely unused.
    expect(rule('.hub-detail-statuses')).toBe('');
  });

  it('separates the Description heading from the fields above it', () => {
    // *"Add a Description heading with proper spacing separating it from the
    // fields/decision area above."* 24 is this panel's between-sections step;
    // the slot below it collapses to 0 so the heading and its prose read as
    // one block rather than as two.
    expect(rule('.hub-detail-body-head')).toMatch(/margin:\s*24px 0 4px/);
    expect(rule('.hub-detail-body-head + .hub-detail-body-slot')).toMatch(/margin-top:\s*0/);
  });

  it('keeps the live description on the panel’s spine, border included', () => {
    // -9 and not -8: the box has a 1px border, so at -8 the prose sat one
    // pixel right of the spine every other row in the panel shares.
    expect(rule('.hub-detail-body-live')).toMatch(/margin:\s*0 -9px/);
    expect(rule('.hub-detail-body-live')).toMatch(/padding:\s*8px/);
  });
});

/**
 * (The mic-clearance pair that used to be asserted here — the panel's tail
 * reservation and the right-aligned submits — is gone with the floating mic
 * that forced it. The mic is docked in the nav now and is over no page
 * content at any width; `hub-mic-dock-css.test.ts` holds that guarantee, and
 * asserts these rules stayed deleted.)
 */
describe('every control in the queue clears the touch-target floor', () => {
  it('keeps every control in the queue at the 36px floor', () => {
    // design-mobile.md: "Minimum 36×36px for any interactive element." The
    // queue's two chevrons were 32.
    const step = rule('.hub-decide-step');
    expect(Number(/min-width:\s*(\d+)px/.exec(step)?.[1])).toBeGreaterThanOrEqual(36);
    expect(Number(/min-height:\s*(\d+)px/.exec(step)?.[1])).toBeGreaterThanOrEqual(36);
  });
});

describe('the record block still says it opens', () => {
  it('keeps the summary a list-item, so Chrome draws its disclosure triangle', () => {
    // `display: flex` on a `<summary>` removes the `::marker` Chrome draws the
    // triangle with — measured 2026-08-18: the row read as a heading, with
    // nothing saying it opened anything. The flex was there for vertical
    // alignment inside a 36px tap target, which `list-item` + padding buys
    // without touching the marker.
    const label = rule('.hub-detail-quote-label');
    expect(label, 'the quote label lost its rule').not.toBe('');
    expect(label).toMatch(/display:\s*list-item/);
    expect(label).not.toMatch(/display:\s*flex/);
    // The tap target it was sized for is still there.
    expect(label).toMatch(/min-height:\s*36px/);
  });
});

describe('the threading UI left no rules behind', () => {
  it('has no rule for a control the panel no longer renders', () => {
    // *"Stop supporting threaded comments and clean up all code related to
    // this! Clean up the UX too."* Dead CSS is the half that outlives a
    // render change silently, and it is what a later reader copies.
    for (const sel of [
      '.hub-comment-reply',
      '.hub-comment-anchor',
      '.hub-comment-status',
      '.hub-comment-resolved',
      '.hub-comment-needs-you',
      '.hub-composer-target',
      '.hub-composer-target-label',
      '.hub-composer-switch',
      '.hub-detail-ask',
      '.hub-detail-ask-kicker',
      '.hub-detail-ask-form',
      // Named here because it arrived on main AFTER the queue replaced this
      // region: the declared item's "why" line. Its behaviour survives on
      // `.hub-decide-why`, so the rule it was written against is dead CSS of
      // exactly the kind this sweep exists to catch.
      '.hub-detail-ask-why',
      // The status chip ROW went with the redesign too (replaced by the
      // status <select>), and it left these four rules behind: the chip base,
      // its two interaction states, and the -current variant only a row of
      // chips could mark. `.hub-chip-todo/-in-progress/-done` are NOT here —
      // the select still wears those for its color.
      '.hub-status-chip',
      '.hub-status-chip:hover',
      '.hub-status-chip:focus-visible',
      '.hub-chip-current',
    ]) {
      expect(rule(sel), `${sel} still has a rule`).toBe('');
    }
    // Positive control, in the same pass and on the same file: the stream the
    // survivors belong to is still styled, so an extractor that matched
    // nothing would not read as a clean sweep.
    expect(rule('.hub-comment')).not.toBe('');
    expect(rule('.hub-comment-focus::before')).not.toBe('');
    // …and the surviving status colors really survive: the <select> at
    // hub-render's status control still emits `hub-chip-<status>`.
    expect(rule('.hub-chip-done')).not.toBe('');
  });
});
