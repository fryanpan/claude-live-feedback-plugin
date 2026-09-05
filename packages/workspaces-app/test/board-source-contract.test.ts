/**
 * The board's contracts that no rendered DOM used to be able to witness.
 *
 * Every one of these was found by looking at a staging board at 430px, which
 * is the only way this class of defect is ever found: the DOM is identical
 * either way, so nothing in the render suite goes red. They were written as
 * regexes over `board.css` for that reason. They are computed reads now — the
 * sheets are installed and the elements are built at the viewport the defect
 * appeared on, so a rule overridden later in the cascade, moved into a query
 * that no longer matches, or renamed off the element fails here.
 *
 * The two SOURCE contracts at the bottom stay source reads: "which module
 * mounts the voice capture" and "nothing renders the unplaced strip any more"
 * are facts about files, and no element can be built to witness them.
 *
 * Every assertion is paired with a positive control on the same read, so a
 * renamed selector or a sheet that failed to install fails loudly rather than
 * passing vacuously.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';
import { BOARD_BOOT_SOURCES } from './support/board-boot-sources.ts';

let cleanup = () => {};
beforeEach(() => {
  cleanup = installSheets('board.css', 'styles.css');
});
afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.style.cssText = '';
});

/**
 * Publish the insets the running app publishes.
 *
 * `:root { --safe-bottom: env(safe-area-inset-bottom, 0px) }` never lands
 * here — happy-dom drops `env()` — and its `var(--safe-bottom, 0px)` readers
 * do not fall back either, so a `calc()` chain that mentions it is discarded
 * whole and the property reads as if the rule did not exist. Setting the
 * variable to the value a device with no home indicator resolves it to puts
 * the chain back, unevaluated but readable.
 */
function publishInsets(safeBottom = '0px'): void {
  document.documentElement.style.setProperty('--safe-bottom', safeBottom);
}

const px = (v: string) => Number.parseFloat(v);

/**
 * A percentage max-width on a grid item resolves against its own grid AREA.
 * `.board-task-badges` sits in an `auto` track — a track sized FROM the item —
 * so `max-width: 30%` meant "30% of yourself", and with `overflow: hidden`
 * the `decision` pill rendered as the two letters "de" on a phone.
 */
describe('the row badges are capped against the viewport, not against themselves', () => {
  function badgeCap(width: number): string {
    setViewport({ width, height: 900 });
    return styleOf(attach('board-task-badges', { parent: attach('board-task-row') })).maxWidth;
  }

  it('caps them at a share of the SCREEN, so the cap moves with the viewport', () => {
    // The distinguishing observation: a self-relative cap is the same string
    // at every width, and a viewport-relative one is not. 30vw resolves here;
    // 30% would not move.
    const at430 = badgeCap(430);
    const at860 = badgeCap(860);
    expect(px(at430)).toBeGreaterThan(0);
    expect(px(at860)).toBeCloseTo(px(at430) * 2, 0);
    expect(at430).toMatch(/px$/);
  });

  it('positive control: the cap is what the phone adds, and the clip it protects is on the base rule', () => {
    // Without the cap the badges would still be `overflow: hidden` — which is
    // the half that turned an over-wide pill into "de". Both halves read.
    expect(badgeCap(1180)).toBe('');
    setViewport(PHONE);
    expect(
      styleOf(attach('board-task-badges', { parent: attach('board-task-row') })).overflow,
    ).toBe('hidden');
  });
});

/**
 * The phone block that restyles the walkthrough must also reserve bottom
 * clearance in the card, or its last control ends up under the bottom-docked
 * mic/pencil launchers. The two travel together: the block that stacks the
 * reply form is the block that owes the card its reserve.
 *
 * The anchor for "the phone block" has moved twice, each time because the
 * surface changed shape: first a sticky .board-walk-nav, then a panel taken to
 * max-height: 100vh. The walkthrough is a PAGE in the Home column (approved
 * mockup) and no longer goes full-screen at all — which is also why this file
 * asserts, below, that nothing puts it back on `position: fixed`.
 */
describe('the walkthrough page reserves launcher clearance on a phone', () => {
  it('stacks the reply form and reserves the card’s tail in the same breath', () => {
    publishInsets();
    setViewport(PHONE);
    expect(styleOf(attach('board-walk-answer', { tag: 'form' })).flexDirection).toBe('column');
    const reserve = styleOf(attach('board-walk-card')).paddingBottom;
    // A launcher's worth of room, plus the home-indicator inset. happy-dom
    // returns the calc unevaluated, so the number is read out of the chain.
    expect(reserve).toContain('60px');

    // Positive control and the point of the pairing: at 1180 the reply form
    // is a row and the card carries only its ordinary padding, so the reserve
    // is really something the phone block adds.
    setViewport(IPAD);
    expect(styleOf(attach('board-walk-answer', { tag: 'form' })).flexDirection).not.toBe('column');
    const ipadPad = styleOf(attach('board-walk-card')).paddingBottom;
    expect(ipadPad).not.toBe(reserve);
    expect(px(ipadPad)).toBeLessThan(60);
  });

  it('keeps the walkthrough a page: nothing sticks the stepper or floats the panel', () => {
    // The stepper lives in the head now — nothing may make it sticky again
    // without restoring the reserve that travelled with the old bar. And a
    // fixed overlay over the board is the layout that got rejected: it takes
    // the Back-to-Home link's meaning with it.
    for (const viewport of [PHONE, IPAD]) {
      setViewport(viewport);
      expect(styleOf(attach('board-walk-nav', { tag: 'nav' })).position).not.toBe('sticky');
      for (const cls of ['board-walkthrough', 'board-walk-panel']) {
        expect(styleOf(attach(cls)).position, `.${cls} is positioned again`).not.toBe('fixed');
      }
    }
    // Positive control: a `position` IS readable off this cascade — the task
    // overlay on the same page is fixed — so the reads above are not blind.
    expect(styleOf(attach('board-detail')).position).toBe('fixed');
  });
});

/**
 * Measured in a real 430px frame: the kind badge takes ~180px of the line,
 * and a title free to shrink to zero comes out about 110px wide — a one-line
 * question stacked seven words tall. The floor is what makes the head WRAP
 * instead, which is what the mockup draws.
 */
describe('the walkthrough card head keeps a readable title on a phone', () => {
  it('gives the title a width floor rather than letting it shrink to nothing', () => {
    setViewport(PHONE);
    const title = styleOf(attach('board-walk-title'));
    // Positive control: this really is the element that lays the title out.
    expect(title.flexGrow).toBe('1');
    expect(px(title.minWidth)).toBeGreaterThanOrEqual(120);
    // The floor only works because a long unbroken token has its own escape.
    expect(title.overflowWrap).toBe('anywhere');
  });
});

describe('settings popover + presence visibility', () => {
  it('the settings panel floats instead of shifting the page', () => {
    setViewport(IPAD);
    const panel = styleOf(attach('board-settings-panel'));
    expect(panel.backgroundColor).not.toBe(''); // positive control: rule found
    expect(panel.position).toBe('absolute');
    // Anchored to the header, which must therefore be a positioned ancestor.
    expect(styleOf(attach('board-topbar', { tag: 'header' })).position).toBe('relative');
  });

  it('no width band hides the circle presence strip any more', () => {
    // The old ≤560px rule was `.board-presence.board-people { display: none }`.
    // The circles fit, so nothing may hide the strip at any width — read at
    // the two verified viewports and at the width the old rule fired on.
    for (const width of [1180, 560, 430]) {
      setViewport({ width, height: 900 });
      const strip = styleOf(attach('board-presence board-people'));
      expect(strip.display, `the presence strip is hidden at ${width}px`).not.toBe('none');
      // Positive control: the strip really is styled at this width, so the
      // assertion is not reading an element no rule reaches.
      expect(strip.display, `nothing styles the strip at ${width}px`).not.toBe('');
    }
  });
});

/**
 * Wiring, asserted against the source, because the failure is silent and no
 * element can witness it.
 *
 * `board-app.ts` mounts two voice captures on one page. Space is a singleton
 * gesture: if both bind it, one press starts both recognizers and each
 * finalizes its own transcript — the utterance goes to the agent AND into the
 * capture box, and nothing errors. Only one of the two may own Space, and no
 * unit test on `createVoiceCapture` can see which mounts opted out.
 */
describe('board-app voice wiring', () => {
  /** Comment lines stripped — prose ABOUT a call must not count as a call
   *  site. (It did, on the first run of this test.) */
  function code(): string {
    const src = BOARD_BOOT_SOURCES.map((m) =>
      readFileSync(resolve(`packages/workspaces-app/src/board/${m}.ts`), 'utf8'),
    ).join('\n');
    return src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it('mounts exactly one capture, the docked one, and it owns the Space hotkey', () => {
    const src = code();
    const mounts = src.split('createVoiceCapture({').length - 1;
    // Positive control: this counts real call sites, not zero of them. The
    // quick-add box carried a second capture (`spaceHotkey: false`) until the
    // box was replaced by the New task / Start a planning huddle buttons.
    expect(mounts).toBe(1);
    expect(src.split('spaceHotkey: false').length - 1).toBe(0);
  });
});

/**
 * The "N tasks have no goal yet" banner is gone from the top of the board.
 *
 * Bryan, 2026-08-29, by voice on the board: *"the 44 tasks have no goal yet
 * up top is taking out space and all of it's not useful."* The Backlog band
 * already holds every unplaced row, so the count said nothing the board did
 * not; `unplacedNotice` stays in the model for the lead's tools, and nothing
 * draws it.
 */
describe('the unplaced banner is gone from the board', () => {
  it('board-app neither hosts the strip nor renders it', () => {
    const src = BOARD_BOOT_SOURCES.map((m) =>
      readFileSync(resolve(`packages/workspaces-app/src/board/${m}.ts`), 'utf8'),
    )
      .join('\n')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(src).not.toContain('board-unplaced');
    expect(src).not.toContain('renderUnplacedStrip');
    // Positive control: the board host it used to sit above is still there.
    expect(src).toContain('id="board"');
  });

  it('the stylesheet reaches no element carrying its class', () => {
    // Read as a computed style rather than as an absent string: a rule that
    // came back under a different selector but still landed on this class
    // would pass a text search for `.board-unplaced` and fail here.
    setViewport(IPAD);
    const board = attach('board');
    const strip = styleOf(attach('board-unplaced', { parent: board }));
    const control = styleOf(attach('board-none-of-the-above', { parent: board }));
    const declared: string[] = [];
    for (let i = 0; i < strip.length; i++) {
      const prop = strip.item(i);
      if (strip.getPropertyValue(prop) !== control.getPropertyValue(prop)) declared.push(prop);
    }
    expect(declared, 'something still styles the unplaced strip').toEqual([]);
    // Positive control: the board's own rules ARE reaching this subtree — the
    // foot that sits where the strip used to is styled.
    expect(styleOf(attach('board-foot', { parent: board })).display).toBe('flex');
  });
});
