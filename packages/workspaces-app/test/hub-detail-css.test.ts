import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, attach, installSheets, setViewport, styleOf } from './css-harness.ts';

/**
 * The task panel's LAYOUT rules — the half of the redesign no DOM test used
 * to be able to see, now read off the cascade instead of out of the
 * stylesheet's text.
 *
 * Three of Bryan's eight anchored comments on the 2026-08-18 staging build are
 * pure CSS: the panel's width, the goal field's own line, and the Description
 * heading's separation. Each is asserted here by the number he gave, so a
 * later edit that quietly halves one goes red rather than merely looking
 * different. (A fourth was the mic clearance at 430px; it moved out of this
 * file when the mic stopped floating over the panel — see
 * `hub-mic-dock-css.test.ts`.)
 *
 * HOW THE NUMBERS GET HERE. Every token below is read by spending it: a probe
 * rule sets `max-width: var(--token)` on an attached element and the computed
 * value comes back with `vw`/`vh` already substituted against the current
 * viewport. That is what makes the split-pane arithmetic honest — the same
 * expression genuinely resolves to different numbers at 1180 and at 1920, and
 * the old regex over `:root`'s source could only ever see one string. The
 * breakpoint itself is MEASURED rather than restated: a bisection finds the
 * width at which the split rules start applying.
 *
 * WHAT HAPPY-DOM WILL NOT COMPUTE, and so is no longer asserted anywhere in
 * this file (all three are `bun run ui:shot` checks now, and each is named
 * again at the place it was lost):
 *   · any `width` built from `min()` / `calc()` / `var()` — it returns '' —
 *     which costs the two assertions that the panel SPENDS `--hub-detail-w`
 *     in the modal and `--hub-detail-pane-w` in the split pane;
 *   · `padding-right` carrying a percentage — also '' — which costs the
 *     assertion that `.hub-main`'s reservation exists and is clamped. The
 *     model below still assumes the clamp; its presence is the one input it
 *     can no longer verify;
 *   · `::before` / `::after`, so the comment-focus marker is out of the dead
 *     rule sweep's control set.
 *
 * The rendered result is checked in a real browser at desktop and at 430px;
 * that is what closes the criterion. What this file prevents is a rule being
 * deleted or re-valued with nothing to notice.
 */

/** The query the split-pane block is keyed off, as a fact to be MEASURED
 *  rather than a number restated from the sheet — see `splitBreakpoint`. */
const SPLIT_PROBE_RANGE = { low: 1000, high: 3000 };

let cleanup = () => {};
beforeEach(() => {
  // The board's real cascade order — `renderHubShell`, packages/server/src/
  // shells.ts loads hub.css BEFORE styles.css, and says why: the hub block
  // used to sit a twelfth of the way into styles.css, so most of that file
  // came after it and won every equal-specificity tie. tokens.css is left out
  // on purpose — the served /app/tokens.css is the vendored Open Props subset
  // concatenated with src/tokens.css, and the mapping layer alone resolves its
  // `var(--gray-9)` chain to nothing. tokens-css.test.ts installs the pair.
  cleanup = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.body.className = '';
});

// ───────────────────────────── reading lengths ─────────────────────────────

/** Split on commas that are not inside a nested function. */
function topLevelSplit(text: string, sep: ',' | '+-'): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && sep === ',' && ch === ',') {
      out.push(text.slice(start, i));
      start = i + 1;
    } else if (
      depth === 0 &&
      sep === '+-' &&
      (ch === '+' || ch === '-') &&
      /\s/.test(text[i - 1] ?? '')
    ) {
      out.push(text.slice(start, i));
      out.push(ch);
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((t) => t.trim()).filter((t) => t !== '');
}

const inner = (v: string) => v.slice(v.indexOf('(') + 1, v.lastIndexOf(')'));

/**
 * Evaluate the length happy-dom hands back.
 *
 * It substitutes `var()` and `vw`/`vh` and then STOPS: `min()`, `max()` and
 * `calc()` come back unevaluated, e.g. `min(min(1100px, max(900px, 1190.4px)),
 * calc(1920px - calc(654px)))`. Doing the arithmetic here is not modelling the
 * browser — the viewport substitution, which is the part that depends on the
 * cascade and on the screen, has already happened. `pct` is what `100%`
 * resolves against, and is only ever the box the rule itself names.
 */
function evalPx(value: string, pct = Number.NaN): number {
  const v = value.trim();
  if (v.startsWith('min('))
    return Math.min(...topLevelSplit(inner(v), ',').map((t) => evalPx(t, pct)));
  if (v.startsWith('max('))
    return Math.max(...topLevelSplit(inner(v), ',').map((t) => evalPx(t, pct)));
  if (v.startsWith('calc(')) {
    const parts = topLevelSplit(inner(v), '+-');
    let total = evalPx(parts[0] ?? '', pct);
    for (let i = 1; i < parts.length; i += 2) {
      const term = evalPx(parts[i + 1] ?? '', pct);
      total += parts[i] === '-' ? -term : term;
    }
    return total;
  }
  if (v.endsWith('%')) return (Number.parseFloat(v) / 100) * pct;
  return Number.parseFloat(v);
}

/** A custom property's value in px, read by SPENDING it: the probe rule puts
 *  the token in a `max-width`, which happy-dom does resolve `var()` and `vw`
 *  inside. `getPropertyValue('--x')` is no use — it returns the declaration's
 *  own text without following the chain. */
function tokenPx(name: string, viewportWidth: number, viewportHeight = 900): number {
  setViewport({ width: viewportWidth, height: viewportHeight });
  const probe = document.createElement('style');
  probe.textContent = `.hub-detail-token-probe { max-width: var(${name}); }`;
  document.head.appendChild(probe);
  const raw = styleOf(attach('hub-detail-token-probe')).maxWidth;
  probe.remove();
  return evalPx(raw);
}

/** True once the split-pane block applies: `.hub-detail` is only given
 *  `justify-content: flex-end` inside it. */
function splitApplies(viewportWidth: number): boolean {
  setViewport({ width: viewportWidth, height: 900 });
  return styleOf(attach('hub-detail')).justifyContent === 'flex-end';
}

/** The width the split actually starts at, found by bisection rather than
 *  copied from the media query — so a moved breakpoint is measured, not
 *  restated, and a stale copy of the number cannot silently search nothing. */
function splitBreakpoint(): number {
  let low = SPLIT_PROBE_RANGE.low;
  let high = SPLIT_PROBE_RANGE.high;
  if (splitApplies(low) || !splitApplies(high)) return Number.NaN;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (splitApplies(mid)) high = mid;
    else low = mid;
  }
  return high;
}

/** The panel while the split is open, at `vw`. */
function splitPanel(vw: number): CSSStyleDeclaration {
  setViewport({ width: vw, height: 900 });
  document.body.className = 'hub-detail-open';
  return styleOf(attach('hub-detail-panel', { parent: attach('hub-detail') }));
}

describe('the task panel is as wide as it was asked to be', () => {
  it('resolves its width from ONE expression: 1100 by default, floored at 900', () => {
    // *"default 1100px, at least 900px when space allows"*. Read as three
    // measurements of the same token rather than as a regex over its source:
    // the ceiling on a screen with room to spare, the floor on one without,
    // and the viewport-proportional middle in between.
    expect(tokenPx('--hub-detail-w', 6000)).toBe(1100);
    expect(tokenPx('--hub-detail-w', 400)).toBe(900);
    const at1600 = tokenPx('--hub-detail-w', 1600);
    const at1700 = tokenPx('--hub-detail-w', 1700);
    expect(at1600).toBeGreaterThan(900);
    expect(at1600).toBeLessThan(1100);
    // …and the middle really is proportional to the viewport, which is the
    // half a single measurement cannot tell from a constant.
    expect((at1700 - at1600) / 100).toBeCloseTo(0.62, 2);
  });

  it('positive control: an undefined token resolves to nothing at all', () => {
    // Without this every number above could come from a probe rule reaching
    // an element no `:root` declaration ever reached — `evalPx('')` is NaN,
    // and NaN survives `toBeGreaterThan` silently.
    expect(Number.isNaN(tokenPx('--hub-detail-not-a-token', 1600))).toBe(true);
    expect(Number.isFinite(tokenPx('--hub-detail-w', 1600))).toBe(true);
  });

  it('caps the pane by what the board keeps, from the same expression', () => {
    // The split resolves the width through `--hub-detail-pane-w`, which is the
    // same expression capped by what the board keeps. The 52vw this replaced
    // gave a 1512px laptop a 760px pane — the "cramped on bigger screens"
    // report unfixed. Asserted as the relationship between the two tokens at
    // several widths, which is what "derived from" means once it is measured.
    for (const vw of [1661, 1920, 2400, 4000]) {
      const keep = tokenPx('--hub-board-keep', vw);
      expect(tokenPx('--hub-detail-pane-w', vw), `${vw}px`).toBe(
        Math.min(tokenPx('--hub-detail-w', vw), vw - keep),
      );
    }
    // NOT asserted here, and asserted in the text version this replaces: that
    // `.hub-detail-panel` SPENDS these tokens in its `width`. happy-dom
    // returns '' for a `width` built from `min()`/`calc()`/`var()`, in the
    // modal form and in the split alike, so there is nothing to read.
  });

  it('reflows the board out from under the panel, and gives it back at full screen', () => {
    // The review banner and the quick-capture row ran under the panel's edge
    // and were clipped by it. Reserving the panel's own width is the fix.
    const vw = 1920;
    setViewport({ width: vw, height: 1080 });
    document.body.className = 'hub-detail-open hub-detail-full';
    // At full screen the panel covers the board, so the reservation is given
    // back — the readable half of the pair.
    expect(Number.parseFloat(styleOf(attach('hub-main')).paddingRight)).toBe(0);
    // The panel's own clamp is the other guarantee, and it IS readable: the
    // panel may never take so much that the board loses its floor.
    const keep = tokenPx('--hub-board-keep', vw);
    const clamp = evalPx(splitPanel(vw).maxWidth, vw);
    expect(clamp).toBe(vw - keep);
    // NOT asserted, and asserted in the text version: the reservation itself
    // (`padding-right: min(pane + gap, 100% - inset - board-min)` on
    // `.hub-main`). happy-dom returns '' for a padding carrying a percentage,
    // because a percentage padding needs a containing block it never lays out.
    // The model below assumes that clamp; a browser check is what confirms it.
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
 * accident goes red. The breakpoint is found by bisecting the viewport until
 * the split rules start applying, so it is the width the browser switches at
 * rather than a literal copied out of the query.
 */
describe('the split pane starts where both columns fit', () => {
  it('finds a breakpoint at all, and one the panel actually changes at', () => {
    const breakpoint = splitBreakpoint();
    expect(Number.isFinite(breakpoint), 'no width in 1000–3000 turns the split on').toBe(true);
    // Control on the bisection: one pixel below, the split is off.
    expect(splitApplies(breakpoint)).toBe(true);
    expect(splitApplies(breakpoint - 1)).toBe(false);
  });

  it('opens no lower than panel floor + board floor + chrome', () => {
    const breakpoint = splitBreakpoint();
    const panelMin = tokenPx('--hub-detail-w', 400);
    const boardMin = tokenPx('--hub-board-min', breakpoint);
    const chrome = tokenPx('--hub-board-chrome', breakpoint);
    expect(breakpoint).toBeGreaterThanOrEqual(panelMin + boardMin + chrome);
  });

  it('caps the pane so the board keeps its floor at every width above it', () => {
    // Without the cap the panel takes 62vw and the board takes the remainder,
    // which at the breakpoint is 297px — under its floor, i.e. the sliver
    // again, one breakpoint higher.
    const breakpoint = splitBreakpoint();
    const boardMin = tokenPx('--hub-board-min', breakpoint);
    const chrome = tokenPx('--hub-board-chrome', breakpoint);
    const panelMin = tokenPx('--hub-detail-w', 400);
    // The two floors are simultaneously satisfiable exactly there, which is
    // what makes this the lowest honest breakpoint rather than a guess.
    expect(breakpoint - boardMin - chrome).toBeGreaterThanOrEqual(panelMin);
    // And the cap is really in force: at the breakpoint the pane is the
    // remainder after the board's keep, not the panel's own preferred width.
    expect(tokenPx('--hub-detail-pane-w', breakpoint)).toBeLessThanOrEqual(
      breakpoint - tokenPx('--hub-board-keep', breakpoint),
    );
  });

  it('states the board’s keep as its floor plus the chrome, in one place', () => {
    // `--hub-board-keep` is what both the pane cap and the panel's own clamp
    // are written against; two hand-kept copies of it is how one of them ends
    // up a few pixels over the other.
    for (const vw of [1661, 1920, 2400]) {
      expect(tokenPx('--hub-board-keep', vw), `${vw}px`).toBe(
        tokenPx('--hub-board-min', vw) + tokenPx('--hub-board-chrome', vw),
      );
    }
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
 * first test below CALIBRATES that model against six independently measured
 * pixel counts before any of the others are allowed to mean anything.
 *
 * The inversion is the tell. 1661 → 1920 is +259px of screen and −193px of
 * board, and 1920 is the width of the display this is read on.
 *
 * Every input the model takes is now read from the cascade at the viewport it
 * is used at — the tokens through `tokenPx`, the open-state container cap
 * straight off `#hub-root`'s computed `max-width`. One input is not: the
 * reservation's own clamp, which happy-dom will not compute (see the note in
 * the block above). The model assumes it; a browser check confirms it.
 *
 * READ THE CONSEQUENCE BEFORE TRUSTING THIS BLOCK. Because the clamp lives in
 * `boardAt` rather than in the sheet the model reads, the three tests it
 * implies — the floor, the monotonicity, and the ceiling — follow
 * algebraically from it: `mainW - min(want, mainW - inset - boardMin) - inset`
 * is `max(boardMin, …)` whatever the tokens say. Verified by attempting to
 * falsify them, 2026-09-03: deleting the `#hub-root` growth, deleting the pane
 * cap, and moving `--hub-board-min`, `--hub-page-w` and `--hub-board-chrome`
 * all left them green. What still bites is the CALIBRATION test below (it
 * pins the model against six measured pixel counts) and the input test after
 * it (every token, plus the container cap and the panel clamp, read live from
 * the cascade) — those are the two that a stylesheet change can turn red.
 *
 * One input was never in the stylesheet at all: the nav rail's track is
 * `max-content`, so no literal states its width. It reaches this file only as
 * the chrome term of `--hub-board-keep`, which is why that constant being
 * viewport-relative rather than container-relative was able to be wrong for so
 * long without anything noticing.
 */
describe('the board keeps its floor in rendered pixels, not just in tokens', () => {
  /** The page's own gutters, derived from the same expression that builds
   *  `--hub-board-chrome`, so the model cannot drift from the stylesheet. */
  const gutters = (vw: number) =>
    tokenPx('--hub-board-chrome', vw) -
    tokenPx('--hub-board-inset', vw) -
    tokenPx('--hub-detail-gap', vw);

  /**
   * What `#hub-root` is capped at while the panel is open, READ FROM THE
   * CASCADE at this viewport rather than assumed. With no open-state override
   * the cap is the page's own, which is the state that rendered 166px and the
   * state this test has to be able to describe.
   */
  const openCapAt = (vw: number): number => {
    setViewport({ width: vw, height: 900 });
    document.body.className = 'hub-detail-open';
    const root = attach('', { attrs: { id: 'hub-root' } });
    return evalPx(styleOf(root).maxWidth, vw);
  };

  /**
   * The board's rendered width, all four boxes in the order the browser
   * resolves them: the layout viewport (`vw` MINUS the scrollbar), the
   * container's open-state cap, `.hub-main` inside its gutters, and the
   * clamped reservation taken out of that.
   *
   * All three of the defect's layers are visible here. `openCapAt` is what
   * made the reservation and the CONTAINER disagree; `vw - sb` is what made
   * it disagree with the LAYOUT; and the clamp is what makes the floor hold
   * anyway, because it is expressed in `.hub-main`'s own coordinates and so
   * never needs to know what `sb` is.
   *
   * `sb` is a parameter rather than a constant because it is the platform's
   * to choose — and because two runs of the same Chrome measured 15 and then
   * 19, which is precisely why no constant belongs in the stylesheet.
   */
  const boardAt = (vw: number, sb = 0): number => {
    const inset = tokenPx('--hub-board-inset', vw);
    const boardMin = tokenPx('--hub-board-min', vw);
    const rootW = Math.min(openCapAt(vw), vw - sb);
    const mainW = rootW - gutters(vw);
    const want = tokenPx('--hub-detail-pane-w', vw) + tokenPx('--hub-detail-gap', vw);
    return mainW - Math.min(want, mainW - inset - boardMin) - inset;
  };

  /** Overlay, both values this Chrome produced, Windows, and one absurdly
   *  wide — the floor must not depend on which of these it gets. */
  const scrollbars = [0, 15, 17, 19, 40];

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

  it('reads every number from the cascade, so the comparisons below are not vacuous', () => {
    for (const [name, n] of [
      ['--hub-board-min', tokenPx('--hub-board-min', 1920)],
      ['--hub-board-inset', tokenPx('--hub-board-inset', 1920)],
      ['--hub-board-chrome', tokenPx('--hub-board-chrome', 1920)],
      ['--hub-page-w', tokenPx('--hub-page-w', 1920)],
      ['--hub-detail-gap', tokenPx('--hub-detail-gap', 1920)],
      ['--hub-detail-w', tokenPx('--hub-detail-w', 1920)],
      ['--hub-detail-pane-w', tokenPx('--hub-detail-pane-w', 1920)],
      ['the gutters term', gutters(1920)],
      ['the open-state container cap', openCapAt(1920)],
    ] as const) {
      expect(Number.isFinite(n), `${name} did not resolve`).toBe(true);
    }
    // The open-state cap must GROW with the pane, or the reservation and the
    // container disagree — which is the defect this whole block exists for,
    // and which is now read from the cascade rather than pattern-matched.
    expect(openCapAt(1920)).toBeGreaterThan(tokenPx('--hub-page-w', 1920));
    expect(openCapAt(1920)).toBeCloseTo(
      tokenPx('--hub-page-w', 1920) +
        tokenPx('--hub-detail-pane-w', 1920) +
        tokenPx('--hub-detail-gap', 1920),
      1,
    );
    // …and below the breakpoint it is the page's own cap, unchanged.
    expect(openCapAt(1400)).toBe(tokenPx('--hub-page-w', 1400));
    // The panel's clamp is in the stylesheet too; without it the model's
    // gap assertion below is describing a layout the page no longer has.
    expect(evalPx(splitPanel(1920).maxWidth, 1920)).toBe(1920 - tokenPx('--hub-board-keep', 1920));
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
      const inset = tokenPx('--hub-board-inset', vw);
      const keep = tokenPx('--hub-board-keep', vw);
      for (const sb of scrollbars) {
        const layout = vw - sb;
        const rootW = Math.min(openCapAt(vw), layout);
        const boardRight = (layout - rootW) / 2 + gutters(vw) / 2 + inset + boardAt(vw, sb);
        // The panel's own clamp, read from the cascade and resolved against
        // the layout box the fixed panel's percentage refers to.
        const panelW = Math.min(
          tokenPx('--hub-detail-pane-w', vw),
          evalPx(splitPanel(vw).maxWidth, layout),
        );
        expect(
          layout - panelW - boardRight,
          `board ends at ${boardRight}, panel starts at ${layout - panelW} (${vw}px, ${sb}px scrollbar)`,
        ).toBeGreaterThanOrEqual(0);
        // Control: the clamp really is doing the work at these widths — the
        // panel is not simply narrower than its own cap by accident.
        expect(Number.isFinite(panelW)).toBe(true);
        expect(layout - keep).toBeGreaterThanOrEqual(panelW - 0.001);
      }
    }
  });

  // 420px is where a row shows enough of a user story to be scanned rather
  // than guessed at — the number the whole breakpoint was derived from, and
  // the one that was never once reached.
  it('honours --hub-board-min at 1661, 1920 and 2400', () => {
    for (const vw of [1661, 1920, 2400]) {
      const boardMin = tokenPx('--hub-board-min', vw);
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
        const prev = boardAt(widths[i - 1] as number, sb);
        const here = boardAt(widths[i] as number, sb);
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
    const closedBoard =
      tokenPx('--hub-page-w', 4000) -
      tokenPx('--hub-board-chrome', 4000) +
      tokenPx('--hub-detail-gap', 4000);
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
  it('docks under the sticky head rather than sliding beneath it', () => {
    setViewport(IPAD);
    const tabs = styleOf(attach('hub-detail-tabs'));
    expect(tabs.position).toBe('sticky');
    // Opaque, or the comments scroll through the labels.
    expect(tabs.backgroundColor).not.toBe('');
    expect(styleOf(attach('hub-detail-tabs')).backgroundColor).toBe(
      styleOf(attach('hub-detail-panel')).backgroundColor,
    );
    // Over the content it is docked above, not under it.
    expect(Number(tabs.zIndex)).toBeGreaterThanOrEqual(1);
  });

  it('takes its offset from the head’s MEASURED height, with a usable fallback', () => {
    // Offset by the head's height as published by renderTaskDetail: the head
    // grows a line when a long title wraps, so a constant would be wrong on
    // exactly the tickets with the longest names. Measured as a RESPONSE to
    // the variable rather than as the declaration's text — set the variable
    // and the dock moves.
    setViewport(IPAD);
    const fallback = Number.parseFloat(styleOf(attach('hub-detail-tabs')).top);
    expect(fallback).toBeGreaterThan(0);
    document.documentElement.style.setProperty('--hub-detail-head-h', '137px');
    expect(styleOf(attach('hub-detail-tabs')).top).toBe('137px');
    document.documentElement.style.removeProperty('--hub-detail-head-h');
    expect(Number.parseFloat(styleOf(attach('hub-detail-tabs')).top)).toBe(fallback);
  });

  it('lands a switch under the head, not under the scrollport’s own top', () => {
    // `land()` calls scrollIntoView({block:'start'}), which aligns to the
    // scrollport top — the exact strip the head is painted over. The margin is
    // what makes "the top" mean "below the head", and it must be the SAME
    // offset the row sticks at or the two disagree by a tab's height. Checked
    // at the fallback AND at a published height, since a constant margin
    // beside a variable top passes the first and fails the second.
    setViewport(IPAD);
    for (const published of [null, '137px']) {
      if (published) document.documentElement.style.setProperty('--hub-detail-head-h', published);
      const tabs = styleOf(attach('hub-detail-tabs'));
      expect(tabs.scrollMarginTop, `published: ${published}`).toBe(tabs.top);
      document.documentElement.style.removeProperty('--hub-detail-head-h');
    }
  });
});

describe('the panel’s fields and headings', () => {
  /** The field grid the panel renders, at `viewport`. */
  function fields(viewport: { width: number; height: number }) {
    setViewport(viewport);
    return attach('hub-detail-fields', { parent: attach('hub-detail-panel') });
  }

  it('gives the goal its own line, because a goal title is free text', () => {
    // *"Goal field: own line — the goal title can be longer than the column
    // has room for."* An explicit modifier now, not a `:last-child` position
    // accident — the goal PANEL's own last field is Due, which must stay one
    // column wide, so the two panels cannot share a positional selector.
    const grid = fields(IPAD);
    const full = attach('hub-detail-field hub-detail-field--full', { parent: grid });
    expect(styleOf(full).gridColumn).toBe('1 / -1');
    // Status is emphatically no longer the full-width one: the FIRST field in
    // the grid, with no modifier, spans one column. Measured as the element's
    // own value, so a `:first-child` rule anywhere would show up here.
    const grid2 = fields(IPAD);
    const first = attach('hub-detail-field', { parent: grid2 });
    attach('hub-detail-field', { parent: grid2 });
    expect(styleOf(first).gridColumn).toBe('');
  });

  it('stacks the fields on a phone rather than orphaning one beside a gap', () => {
    // Measured in the browser at 430px, not reasoned from the file: the panel's
    // content box there is ~384px, so a column floor of 170 fits TWO columns —
    // and since GOAL takes the whole line, DUE ends up alone in a half cell
    // with an empty one beside it. The floor has to exceed half the phone's
    // content width for the grid to give up and stack.
    const grid = styleOf(fields(IPAD));
    expect(grid.display).toBe('grid');
    const floor = Number(/minmax\((\d+)px, 1fr\)/.exec(grid.gridTemplateColumns)?.[1]);
    expect(Number.isFinite(floor), 'the field grid lost its auto-fit floor').toBe(true);
    expect(floor).toBeGreaterThan(384 / 2);
    // …and the positive control, so this cannot be satisfied by a floor so
    // large that the split pane stacks too: four across must still fit the
    // 874px pane, i.e. 4 columns plus three 16px gaps.
    expect(floor * 4 + 16 * 3).toBeLessThanOrEqual(874);
  });

  it('holds the description to a readable measure when the panel goes wide', () => {
    // Measured in a browser in full screen at a 1512px window: the description
    // ran 1449px, about 177 characters a line, where the readable range tops
    // out near 75. The panel is width-flexible and prose is not.
    setViewport(IPAD);
    const slot = styleOf(attach('hub-detail-body-slot'));
    const measure = /^(\d+)ch$/.exec(slot.maxWidth);
    expect(measure, `the description has no ch measure: ${slot.maxWidth}`).not.toBeNull();
    expect(Number(measure?.[1])).toBeLessThanOrEqual(80);
    // A `ch` cap binds only where the panel is WIDER than it, so the phone is
    // untouched — that is the property worth pinning, since a px cap set from
    // the same measurement would also clamp the 383px phone column. The unit
    // survives into the computed value, so asserting it is asserting that.
    // And it stays in the panel's left column: centring one section breaks the
    // edge the fields and the queue above it are read down.
    expect(slot.marginLeft).toBe('0px');
    expect(slot.marginRight).toBe('0px');
  });

  it('draws all four values as one kind of control at one height', () => {
    setViewport(IPAD);
    const cell = attach('hub-detail-field hub-detail-field-v');
    for (const [cls, tag] of [
      ['hub-detail-select', 'select'],
      ['hub-detail-input', 'input'],
    ] as const) {
      const ctl = styleOf(attach(cls, { tag, parent: cell }));
      expect(Number.parseFloat(ctl.minHeight), cls).toBe(36);
      // A long goal title or agent id must not set the control's intrinsic
      // width and push the panel past a 430px viewport.
      expect(Number.parseFloat(ctl.minWidth), cls).toBe(0);
      expect(ctl.maxWidth, cls).toBe('100%');
    }
    // The board's 44px assignee pill is brought down to the same row height —
    // four boxes at two heights is the reported inconsistency in miniature.
    const pill = attach('hub-assignee-btn', { tag: 'button', parent: cell });
    expect(Number.parseFloat(styleOf(pill).minHeight)).toBe(36);
    // Control: the same pill OUTSIDE the panel keeps the board's own size, so
    // the 36 above is the panel rule's doing.
    expect(
      Number.parseFloat(styleOf(attach('hub-assignee-btn', { tag: 'button' })).minHeight),
    ).toBeGreaterThan(36);
  });

  it('puts the status mark and its dropdown on one line', () => {
    // *"Show ONLY the current status, with the status icon used in the summary
    // view, and a dropdown to change it."*
    setViewport(IPAD);
    const cell = attach('hub-detail-field hub-detail-field-v');
    const ctl = attach('hub-detail-statusctl', { parent: cell });
    const style = styleOf(ctl);
    expect(style.display).toBe('flex');
    expect(style.alignItems).toBe('center');
    // …and it fills its cell, so STATUS ends on the same right edge as the
    // other three. Its parent is a flex container, so the default `0 1 auto`
    // shrink-wraps it — measured at 137px inside a 383px cell at 430px.
    expect(style.flex).toBe('1 1 auto');
    // The mark keeps its 18px; the select takes the rest and may shrink.
    expect(styleOf(attach('hub-status-mark', { parent: ctl })).flex).toBe('0 0 auto');
    expect(
      Number.parseFloat(
        styleOf(attach('hub-detail-status', { tag: 'select', parent: ctl })).minWidth,
      ),
    ).toBe(0);
    // The chip row is GONE, not merely unused: an element carrying its class
    // reads exactly like one carrying no class at all.
    expect(styleOf(attach('hub-detail-statuses')).display).toBe('block');
    expect(styleOf(attach('hub-detail-statuses')).gap).toBe('');
  });

  it('separates the Description heading from the fields above it', () => {
    // *"Add a Description heading with proper spacing separating it from the
    // fields/decision area above."* 24 is this panel's between-sections step;
    // the slot below it collapses to 0 so the heading and its prose read as
    // one block rather than as two.
    setViewport(IPAD);
    const panel = attach('hub-detail-panel');
    const head = attach('hub-detail-body-head', { tag: 'h3', parent: panel });
    expect(styleOf(head).marginTop).toBe('24px');
    expect(styleOf(head).marginBottom).toBe('4px');
    // The sibling selector, measured as a sibling: a slot that follows the
    // heading collapses, one that does not keeps its own top margin.
    const after = attach('hub-detail-body-slot', { parent: panel });
    expect(styleOf(after).marginTop).toBe('0px');
    expect(Number.parseFloat(styleOf(attach('hub-detail-body-slot')).marginTop)).toBeGreaterThan(0);
  });

  it('keeps the live description on the panel’s spine, border included', () => {
    // -9 and not -8: the box has a 1px border, so at -8 the prose sat one
    // pixel right of the spine every other row in the panel shares.
    setViewport(IPAD);
    const live = styleOf(attach('hub-detail-body-live'));
    expect(live.marginLeft).toBe('-9px');
    expect(live.marginRight).toBe('-9px');
    expect(live.padding).toBe('8px');
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
    setViewport(IPAD);
    const step = styleOf(attach('hub-decide-step', { tag: 'button' }));
    expect(Number.parseFloat(step.minWidth)).toBeGreaterThanOrEqual(36);
    expect(Number.parseFloat(step.minHeight)).toBeGreaterThanOrEqual(36);
  });
});

describe('the record block still says it opens', () => {
  it('keeps the summary a list-item, so Chrome draws its disclosure triangle', () => {
    // `display: flex` on a `<summary>` removes the `::marker` Chrome draws the
    // triangle with — measured 2026-08-18: the row read as a heading, with
    // nothing saying it opened anything. The flex was there for vertical
    // alignment inside a 36px tap target, which `list-item` + padding buys
    // without touching the marker.
    setViewport(IPAD);
    const label = styleOf(
      attach('hub-detail-quote-label', { tag: 'summary', parent: attach('', { tag: 'details' }) }),
    );
    expect(label.display).toBe('list-item');
    // The tap target it was sized for is still there.
    expect(Number.parseFloat(label.minHeight)).toBe(36);
  });
});

describe('the threading UI left no rules behind', () => {
  /** The properties a retired rule would most plausibly still be setting.
   *  Compared against a class-less sibling rather than against '' so the
   *  inherited ones (colour, size) are part of the comparison too. */
  const SHAPE = [
    'display',
    'position',
    'margin',
    'padding',
    'backgroundColor',
    'color',
    'fontSize',
    'fontWeight',
    'borderTopWidth',
    'borderTopColor',
    'borderRadius',
    'minHeight',
    'minWidth',
    'maxWidth',
    'gap',
    'flex',
    'flexDirection',
    'alignItems',
    'textTransform',
    'overflow',
  ] as const;

  const shapeOf = (el: Element) => {
    const s = styleOf(el) as unknown as Record<string, string>;
    return Object.fromEntries(SHAPE.map((p) => [p, s[p] ?? '']));
  };

  it('has no rule for a control the panel no longer renders', () => {
    // *"Stop supporting threaded comments and clean up all code related to
    // this! Clean up the UX too."* Dead CSS is the half that outlives a
    // render change silently, and it is what a later reader copies.
    setViewport(IPAD);
    const host = attach('hub-detail-panel');
    const bare = shapeOf(attach('', { parent: host }));
    for (const sel of [
      'hub-comment-reply',
      'hub-comment-anchor',
      'hub-comment-status',
      'hub-comment-resolved',
      'hub-comment-needs-you',
      'hub-composer-target',
      'hub-composer-target-label',
      'hub-composer-switch',
      'hub-detail-ask',
      'hub-detail-ask-kicker',
      'hub-detail-ask-form',
      // Named here because it arrived on main AFTER the queue replaced this
      // region: the declared item's "why" line. Its behaviour survives in the
      // card's one markdown body (`.hub-decide-body`), so the rule it was
      // written against is dead CSS of exactly the kind this sweep exists to
      // catch.
      'hub-detail-ask-why',
      // The one-card anatomy (approved design, review-flow-mock-v1) collapsed
      // the labelled sub-sections into a single markdown body, on the
      // walkthrough card and the panel card alike — these are the classes the
      // collapse retired.
      'hub-walk-why',
      'hub-walk-ctx',
      'hub-walk-asked-line',
      'hub-walk-lookfor-text',
      'hub-walk-review-detail',
      'hub-review-row-why',
      'hub-decide-why',
      'hub-decide-detail',
      'hub-decide-lookfor',
      // The payload's own `why` went the same way on 2026-08-25 — the field
      // was deleted, not just the layout — so the two rules that styled its
      // line on the comment surfaces are dead for good. `.hub-comment-review-
      // why` had already lost its emitter before that; `.comment-review-why`
      // lost one in the same commit as the field.
      'hub-comment-review-why',
      'comment-review-why',
      // The status chip ROW went with the redesign too (replaced by the
      // status <select>), and it left these four rules behind: the chip base,
      // its two interaction states, and the -current variant only a row of
      // chips could mark. `.hub-chip-todo/-in-progress/-done` are NOT here —
      // the select still wears those for its color.
      'hub-status-chip',
      'hub-chip-current',
    ]) {
      expect(shapeOf(attach(sel, { parent: host })), `${sel} still has a rule`).toEqual(bare);
    }
    // Positive control, in the same pass and on the same sheet: the stream the
    // survivors belong to is still styled, so a comparison that matched
    // everything to `bare` would not read as a clean sweep.
    expect(shapeOf(attach('hub-comment', { parent: host }))).not.toEqual(bare);
    // …and the surviving status colors really survive: the <select> at
    // hub-render's status control still emits `hub-chip-<status>`.
    expect(shapeOf(attach('hub-chip-done', { parent: host }))).not.toEqual(bare);
    // NOT swept here, and swept in the text version: `.hub-status-chip:hover`
    // and `:focus-visible`. happy-dom has no pointer and no focus, so a rule
    // on either state is unreachable — `bun run ui:shot` owns them.
  });
});
