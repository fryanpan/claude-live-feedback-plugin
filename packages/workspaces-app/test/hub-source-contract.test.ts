/**
 * The hub's SOURCE contracts: six facts that no rendered DOM can witness.
 *
 * Each one asserts on the text of `hub.css` or a hub source file, because
 * the failure it guards against is silent — happy-dom does no layout, so a
 * percentage max-width, a missing safe-area inset or a second voice capture
 * all render identically to the correct thing and fail no DOM test. Several
 * were found by looking at a staging board at 430px, which is the only way
 * that class of defect is ever found.
 *
 * They lived at the bottom of `hub-render.test.ts` and touched neither its
 * `root` beforeEach nor any render function, which is what made that file
 * unreadable as one harness. Every assertion here is paired with a positive
 * control on the same read, so a renamed selector or a moved file fails loudly
 * rather than passing vacuously.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A percentage max-width on a grid item resolves against its own grid AREA.
 * `.hub-task-badges` sits in an `auto` track — a track sized FROM the item —
 * so `max-width: 30%` meant "30% of yourself", and with `overflow: hidden`
 * the `decision` pill rendered as the two letters "de" on a phone. Nothing
 * else in this suite can see it: happy-dom has no layout, the DOM is
 * identical either way, and the row's grid template is already asserted
 * above and was correct the whole time. Found by looking at a staging board
 * at 430px, which is the only way this class of defect is ever found.
 */
describe('the row badges are capped against the viewport, not against themselves', () => {
  it('never uses a percentage max-width on .hub-task-badges', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // vitest runs from the repo root (vitest.config.ts lives there).
    const css = readFileSync(resolve('packages/markdown-app/src/hub.css'), 'utf8');
    const rules = [...css.matchAll(/\.hub-task-badges\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    // Positive control: the rules this asserts about really were found, and
    // one of them really does cap the width.
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.some((r) => /max-width/.test(r))).toBe(true);
    for (const r of rules) expect(r).not.toMatch(/max-width:\s*[\d.]+%/);
  });
});

/**
 * happy-dom does no layout, so nothing else in this suite can see a fixed
 * launcher painting over a button. What it CAN see is the invariant: the
 * phone media block that restyles the walkthrough must also reserve bottom
 * clearance in the card, or its last control ("Tell me more" on a decision
 * card) ends up under the bottom-docked mic/pencil launchers.
 *
 * The anchor for "the phone block" has moved twice, each time because the
 * surface changed shape: first a sticky .hub-walk-nav, then a panel taken to
 * max-height: 100vh. It is now the stacked reply form, because the
 * walkthrough is a PAGE in the Home column (approved mockup) and no longer
 * goes full-screen at all — which is also why this file asserts, below, that
 * nothing puts it back on `position: fixed`.
 */
describe('the walkthrough page reserves launcher clearance on a phone', () => {
  it('gives the card bottom clearance wherever the phone block restyles it', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve('packages/markdown-app/src/hub.css'), 'utf8');
    // The media blocks are the unit: sticky nav and card clearance have to
    // travel together, so find the block and assert about that one text.
    // Brace-scanned rather than regexed — a media block holds nested rules,
    // and a pattern that assumes otherwise matches nothing and proves nothing.
    const blocks: string[] = [];
    for (const m of css.matchAll(/@media[^{]*\{/g)) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
      }
      blocks.push(css.slice(start, i - 1));
    }
    const phone = blocks.filter((b) => /\.hub-walk-answer[^{]*\{/.test(b));
    // Positive control: the block this asserts about exists and was matched.
    expect(phone.length).toBeGreaterThan(0);
    for (const b of phone) {
      expect(b).toMatch(/\.hub-walk-card\s*\{[^}]*padding-bottom:\s*calc\([\d.]+px/);
    }
    // The stepper lives in the head now — nothing may make it sticky again
    // without restoring the reserve that travelled with the old bar.
    expect(css).not.toMatch(/\.hub-walk-nav\s*\{[^}]*position:\s*sticky/);
    // And the page must stay a page: a fixed overlay over the board is the
    // layout that got rejected, and it takes the Back-to-Home link's meaning
    // with it.
    expect(css).not.toMatch(/\.hub-walk(through|-panel)[^{]*\{[^}]*position:\s*fixed/);
  });
});

/**
 * happy-dom does no layout, so what is checkable here is the rule that makes
 * the phone layout work. Measured in a real 430px frame: the kind badge takes
 * ~180px of the line, and a title free to shrink to zero comes out about
 * 110px wide — a one-line question stacked seven words tall. The floor is
 * what makes the head WRAP instead, which is what the mockup draws.
 */
describe('the walkthrough card head keeps a readable title on a phone', () => {
  it('gives the title a width floor rather than letting it shrink to nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve('packages/markdown-app/src/hub.css'), 'utf8');
    const rule = css.match(/\.hub-walk-title\s*\{([^}]*)\}/)?.[1] ?? '';
    // Positive control: the rule this asserts about was found and is the one
    // that lays the title out.
    expect(rule).toMatch(/flex:\s*1/);
    const floor = rule.match(/min-width:\s*(\d+)px/)?.[1];
    expect(Number(floor ?? 0)).toBeGreaterThanOrEqual(120);
    // The floor only works because a long unbroken token has its own escape.
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
  });
});

/**
 * happy-dom does no layout, so the popover and the 430px fit are pinned at
 * the rule level, the same way the walkthrough title floor is above: assert
 * the declarations that make the behaviour, with a presence check first so
 * a renamed selector fails loudly rather than passing vacuously.
 */
describe('settings popover + presence visibility (CSS contract)', () => {
  const css = readFileSync(resolve('packages/markdown-app/src/hub.css'), 'utf8');

  it('the settings panel floats instead of shifting the page', () => {
    const rule = css.match(/\.hub-settings-panel\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('background'); // positive control: found the rule
    expect(rule).toMatch(/position:\s*absolute/);
    // Anchored to the header, which must therefore be a positioned ancestor.
    const topbar = css.match(/\.hub-topbar\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(topbar).toMatch(/position:\s*relative/);
  });

  it('no width band hides the circle presence strip any more', () => {
    // The old ≤560px rule was `.hub-presence.hub-people { display: none }`.
    // The circles fit, so nothing may hide the strip at any width.
    const peopleRules = [...css.matchAll(/\.hub-presence\.hub-people\s*\{([^}]*)\}/g)];
    expect(peopleRules.length).toBeGreaterThan(0); // positive control
    for (const [, body] of peopleRules) {
      expect(body).not.toMatch(/display:\s*none/);
    }
  });
});

/**
 * Wiring, asserted against the source, because the failure is silent.
 *
 * `hub-app.ts` mounts two voice captures on one page. Space is a singleton
 * gesture: if both bind it, one press starts both recognizers and each
 * finalizes its own transcript — the utterance goes to the agent AND into the
 * capture box, and nothing errors. Only one of the two may own Space, and no
 * unit test on `createVoiceCapture` can see which mounts opted out.
 */
describe('hub-app voice wiring', () => {
  /** Comment lines stripped — prose ABOUT a call must not count as a call
   *  site. (It did, on the first run of this test.) */
  function code(): string {
    const src = readFileSync(resolve('packages/markdown-app/src/hub/hub-app.ts'), 'utf8');
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
 * draws it. Asserted against the source because the failure is silent: a
 * strip that came back would render fine and fail no DOM test.
 */
describe('the unplaced banner is gone from the board', () => {
  function code(path: string): string {
    return readFileSync(resolve(path), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it('hub-app neither hosts the strip nor renders it', () => {
    const src = code('packages/markdown-app/src/hub/hub-app.ts');
    expect(src).not.toContain('hub-unplaced');
    expect(src).not.toContain('renderUnplacedStrip');
    // Positive control: the board host it used to sit above is still there.
    expect(src).toContain('id="hub-board"');
  });

  it('the stylesheet carries no rule for it', () => {
    const css = readFileSync(resolve('packages/markdown-app/src/hub.css'), 'utf8');
    expect(css).not.toMatch(/\.hub-unplaced/);
    // Positive control: the board's own rules are still read from this file.
    expect(css).toMatch(/\.hub-board-foot/);
  });
});
