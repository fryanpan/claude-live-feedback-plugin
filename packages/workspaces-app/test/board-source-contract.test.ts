import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHORES_ID, unplacedNotice } from '../src/board/board-model.ts';
import { SPACE_HOLD_ARM_MS } from '../src/voice-capture.ts';
import { IPAD, PHONE, attach, installSheets, setViewport, styleOf } from './css-harness.ts';
import { NOW, WS, boardRow, bootTestBoard, el, resetBoardServer } from './support/board-drive.ts';

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
 *
 * The cap survived that fix; the CLIP did not. It sat on the strip, where
 * anything too wide simply stopped existing at the strip's edge — which is
 * how the pill lost its tail without saying so, and how a second row later
 * lost the word "triage" down to "t". The clip now sits on each chip, with
 * an ellipsis, so a chip that has to give way says that it did.
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

  it('positive control: the cap is what the phone adds, and the clip it protects announces itself', () => {
    // Half one, unchanged: the cap is a phone rule, absent at 1180.
    expect(badgeCap(1180)).toBe('');
    setViewport(PHONE);
    const strip = attach('board-task-badges', { parent: attach('board-task-row') });
    // Half two, moved. The strip no longer hides anything — it wraps — and the
    // chip inside it owns the crop. Read both, because a chip with
    // `text-overflow` and no `overflow: hidden` ellipses nothing at all, and
    // that pair failing open is exactly the silent cut this guards.
    expect(styleOf(strip).flexWrap).toBe('wrap');
    expect(['', 'visible']).toContain(styleOf(strip).overflow);
    const chip = attach('board-badge', { parent: strip });
    expect(styleOf(chip).overflow).toBe('hidden');
    expect(styleOf(chip).textOverflow).toBe('ellipsis');
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
 * One Space press starts ONE recognizer.
 *
 * The board used to mount two voice captures on one page. Space is a
 * singleton gesture: if both bind it, one press starts both recognizers and
 * each finalizes its own transcript — the utterance goes to the agent AND
 * into the capture box, and nothing errors.
 *
 * DRIVEN, NOT GREPPED. This used to concatenate the seventeen boot modules,
 * strip the comment lines and COUNT `createVoiceCapture({` in the result. A
 * count over a fixed list of files can only see a second mount if it happens
 * to be in one of them: a capture mounted from `board-live-wiring.ts`, from
 * the doc surface, or from anything else the list does not name reads as one.
 * The failure is silent in the browser too — so install a recognizer that
 * counts itself, boot the board, and hold Space.
 */
describe('board-app voice wiring', () => {
  /** A SpeechRecognition that records every start instead of opening a mic. */
  class CountingRecognition {
    static started: CountingRecognition[] = [];
    continuous = false;
    interimResults = false;
    lang = '';
    onresult: ((ev: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((ev: unknown) => void) | null = null;
    start(): void {
      CountingRecognition.started.push(this);
    }
    stop(): void {}
  }

  /** Hold Space on the page for longer than the arm delay. */
  async function holdSpace(): Promise<void> {
    vi.useFakeTimers();
    try {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      await vi.advanceTimersByTimeAsync(SPACE_HOLD_ARM_MS + 50);
    } finally {
      vi.useRealTimers();
    }
  }

  let wasSecure: unknown;
  beforeEach(() => {
    (globalThis as Record<string, unknown>).SpeechRecognition = CountingRecognition;
    // The capture refuses to arm on an insecure origin, and says so on the
    // button — a real gate, and one happy-dom leaves false.
    wasSecure = (globalThis as Record<string, unknown>).isSecureContext;
    (globalThis as Record<string, unknown>).isSecureContext = true;
    CountingRecognition.started = [];
    resetBoardServer();
  });
  afterEach(() => {
    (globalThis as Record<string, unknown>).SpeechRecognition = undefined;
    (globalThis as Record<string, unknown>).isSecureContext = wasSecure;
    document.body.innerHTML = '';
  });

  it('one press, one recognizer — and the board carries one mic to press', async () => {
    await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/tasks`,
      tasks: [boardRow('t-1')],
    });
    // Positive control: the press really armed something. Without it, "not
    // two" is satisfied by a board whose mic never binds Space at all.
    await holdSpace();
    expect(CountingRecognition.started.length, 'the hold armed no recognizer').toBe(1);
    // And exactly one button to press: a second capture is a second mic.
    expect(document.querySelectorAll('.voice-mic')).toHaveLength(1);
  });

  it('a second press does not stack a second recognizer while the first is live', async () => {
    // The same singleton rule inside one capture: the auto-repeat of a held
    // key, and a second key going down, are the hold that is already running.
    await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/tasks`,
      tasks: [boardRow('t-1')],
    });
    await holdSpace();
    await holdSpace();
    expect(CountingRecognition.started.length).toBe(1);
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
  it('a board full of unplaced rows says nothing about them above the board', async () => {
    // DRIVEN, NOT GREPPED. This used to read the seventeen boot modules as one
    // string and assert `board-unplaced` and `renderUnplacedStrip` were absent
    // from it. Two absences in source text, and an absence is the weakest
    // evidence there is: the same strip mounted under any other name passes
    // both. What Bryan objected to is a SENTENCE on his board — so build the
    // board he was looking at and read it.
    resetBoardServer();
    const unplaced = Array.from({ length: 3 }, (_, i) =>
      boardRow(`t-${i + 1}`, { goal: CHORES_ID, order: i + 1, unplacedSince: NOW - 86_400_000 }),
    );
    await bootTestBoard({ url: `https://board.test/workspaces/${WS}/tasks`, tasks: unplaced });

    // Positive control: the rows really are unplaced and really are on screen,
    // in the Backlog band that already holds every one of them. Without this,
    // "no notice" is satisfied by a board that failed to boot.
    const notice = unplacedNotice(unplaced, NOW);
    expect(notice?.count, 'the fixture is not actually unplaced').toBe(3);
    expect(document.querySelectorAll('.board-task-row')).toHaveLength(3);

    const board = el('board');
    expect(board.textContent).toContain('Backlog');
    // The line itself, in the model's own words rather than hand-copied.
    expect(board.textContent, 'the unplaced strip is back').not.toContain(notice?.label);
    expect(board.textContent).not.toContain('have no goal yet');
    expect(board.textContent).not.toContain('has no goal yet');
    expect(board.querySelector('.board-unplaced')).toBeNull();
    document.body.innerHTML = '';
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
