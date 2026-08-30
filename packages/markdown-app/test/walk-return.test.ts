import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLOSED_WALK, walkAimAfterOpen } from '../src/hub/hub-model';

/**
 * Back from a doc has to land where the reader was.
 *
 * Reported from a phone: opened a doc from the review queue on Home, pressed
 * back, and arrived on a rebuilt Home with the queue closed. Measured
 * headlessly at 430px, the browser was blameless — bfcache restored the page
 * with `?item=` intact and the walkthrough open, correct for ~15ms. Then the
 * app replaced the URL with a bare Home and the queue closed behind it.
 *
 * The cause is here. Opening an item closes the walkthrough IN STATE before
 * calling the opener, deliberately: the close and the open have to reach
 * `syncBoardUrl` as one step, or the close's `history.back()` — an async
 * traversal — lands after the open's `pushState` and bounces the reader home.
 * But when the item is a DOC, the opener leaves the page instead of painting,
 * so the close never reaches a render. All it does is poison the snapshot
 * bfcache is about to take: the restored page believes the walkthrough was
 * closed, and the first render after restore normalises the surviving deep
 * link away.
 *
 * So the close is conditional on staying. `walkAimAfterOpen` is that
 * condition, kept pure because the failure was invisible in code review for
 * as long as it lived inline.
 */
describe('walkAimAfterOpen', () => {
  const aim = { index: 2, key: 'doc-thread:d-1:th-1', hold: null };

  it('a same-page open leaves the walkthrough closed', () => {
    // The panel took over the screen; the walk is genuinely put away, and the
    // URL should say so.
    expect(walkAimAfterOpen(aim, true)).toEqual({
      index: CLOSED_WALK.index,
      key: CLOSED_WALK.key,
      hold: null,
    });
  });

  it('an open that LEAVES the page keeps the aim — bfcache is about to save it', () => {
    expect(walkAimAfterOpen(aim, false)).toEqual(aim);
  });

  it('keeps the hold too, so an item waiting on its owner is still held on return', () => {
    const held = { index: 1, key: 'k', hold: { key: 'k', index: 1, item: null } };
    expect(walkAimAfterOpen(held as never, false)).toEqual(held);
  });

  it('an already-closed walk stays closed either way', () => {
    const closed = { index: -1, key: null, hold: null };
    expect(walkAimAfterOpen(closed, true)).toEqual(closed);
    expect(walkAimAfterOpen(closed, false)).toEqual(closed);
  });
});

// hub-app has no boot harness (same pin pattern as walk-handoff.test.ts): the
// wiring is asserted in source. The behaviour itself was verified headlessly
// at 430px against a built client — see the PR.
describe('hub-app wires the return', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

  it('both walkthrough openers route their aim through openFromWalk', () => {
    // Two handlers, one rule. `onOpenThread` reaches the same doc jump when
    // the item has no task thread to aim at, so it fails the same way — the
    // shared helper is what stops the two drifting apart again.
    expect(src).toMatch(/onOpenItem: \(item\) => openFromWalk\(/);
    expect(src).toMatch(/onOpenThread: \(item\) => openFromWalk\(/);
    expect(src).toMatch(/function openFromWalk[\s\S]{0,600}walkAimAfterOpen\(aim, stillHere\)/);
    // Negative control: the old inline clear is gone from both handlers, so
    // this is a pin on the new path rather than on a leftover of the old one.
    expect(src).not.toMatch(
      /onOpen(Item|Thread): \(item\) => \{[\s\S]{0,400}state\.walkIndex = -1/,
    );
  });

  it('the doc jump carries the reader’s queue position on the link it mints', () => {
    expect(src).toMatch(/item=\$\{encodeURIComponent\(returnItem\)\}/);
  });

  it('only an OPEN walk hands out a return position', () => {
    // A doc opened from a board row or a pasted link must not stamp one, or
    // its back arrow would drop the reader into a sitting they never started.
    expect(src).toMatch(/aim\.index >= 0 \? aim\.key : null/);
  });
});
