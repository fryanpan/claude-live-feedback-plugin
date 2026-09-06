import { beforeEach, describe, expect, it } from 'vitest';
/**
 * Following a person off the board — the one board action reachable only by a
 * gesture, driven end to end.
 *
 * `presence-island.test.tsx` already pins the gesture against fake handlers:
 * that a 550ms hold fires `onLongPress`, that a repaint under the press does
 * not eat it, that a cancel disarms. What it cannot see is the half that
 * happens after the handler — the follow is armed on `state.followedKey`, and
 * the navigation itself is fired much later, from the awareness listener in
 * `board-live-wiring.ts`, when the followed person's own row moves into a doc.
 * Nothing joined those two halves, so the `location.assign` PR #733 routed
 * through the injected `BootLocation` had no driven test behind it at all.
 *
 * So this boots the real board, presses a real circle, and reads the
 * destination off the injected address bar. The peer is a second `Awareness`
 * whose update is applied to the board's own, which is exactly how a second
 * browser reaches this one — not a hand-written `presenceData` write, which
 * would skip the chip-building and the identity resolution the follow depends
 * on.
 */
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
import * as Y from 'yjs';
import {
  type Booted,
  bootTestBoard,
  el,
  longPress,
  resetBoardServer,
  settle,
} from './support/board-drive.ts';

beforeEach(() => {
  resetBoardServer();
});

/**
 * A second browser on this board.
 *
 * ONE `Awareness` per peer, reused across their moves: a fresh one per update
 * would arrive as a fresh connection, and "the person I am following moved"
 * is a different claim from "somebody new appeared holding their name".
 */
function joinBoard(board: Booted, user: { id: string; name: string }) {
  const peer = new Awareness(new Y.Doc());
  return async function movesTo(where: { surface: string; docId?: string }): Promise<void> {
    peer.setLocalState({ user, lastActive: Date.now(), ...where });
    applyAwarenessUpdate(
      board.sockets.first().awareness,
      encodeAwarenessUpdate(peer, [peer.clientID]),
      'remote',
    );
    await settle();
  };
}

/** The circle in the top-right cluster standing for `name`. */
function circleFor(name: string): HTMLButtonElement {
  const found = el('board-people').querySelector<HTMLButtonElement>(
    `button[aria-label^="${name}"]`,
  );
  if (!found) throw new Error(`no presence circle for ${name}`);
  return found;
}

describe('following a person off the board', () => {
  it('a long-press on their circle sends this browser after them', async () => {
    const board = await bootTestBoard();
    const zoe = joinBoard(board, { id: 'u-zoe', name: 'Zoe Vance' });
    // She is on the board, not in a doc: there is nowhere to follow her TO
    // yet, so nothing that happens next can be a jump that was already due.
    await zoe({ surface: 'board' });

    const circle = circleFor('Zoe Vance');
    await longPress(board, circle);

    // Arming a follow is not itself a navigation — and the strip says so.
    expect(board.location.navigations).toEqual([]);
    expect(circleFor('Zoe Vance').classList.contains('board-following')).toBe(true);

    // She opens a doc. The follow is what takes this browser with her.
    await zoe({ surface: 'doc', docId: 'kitchen-notes' });

    expect(board.location.navigations).toEqual(['/review/kitchen-notes']);
  });

  it('a press released before the threshold arms nothing', async () => {
    // The control for the case above: the same events, the same peer move,
    // and the only difference is how long the finger stayed down. Without it
    // "it navigated" is satisfied by any touch on the circle at all.
    const board = await bootTestBoard();
    const zoe = joinBoard(board, { id: 'u-zoe', name: 'Zoe Vance' });
    await zoe({ surface: 'board' });

    // A tap, in milliseconds: well under the board's 550ms threshold. A
    // literal rather than `LONG_PRESS_MS - 50`, so that a threshold moved
    // down under this number fails the control loudly instead of asking the
    // clock to run backwards.
    await longPress(board, circleFor('Zoe Vance'), 100);
    expect(circleFor('Zoe Vance').classList.contains('board-following')).toBe(false);

    await zoe({ surface: 'doc', docId: 'kitchen-notes' });
    expect(board.location.navigations).toEqual([]);
  });

  it('a second long-press stops following, and her next move is hers alone', async () => {
    const board = await bootTestBoard();
    const zoe = joinBoard(board, { id: 'u-zoe', name: 'Zoe Vance' });
    await zoe({ surface: 'board' });

    await longPress(board, circleFor('Zoe Vance'));
    await zoe({ surface: 'doc', docId: 'kitchen-notes' });
    expect(board.location.navigations).toEqual(['/review/kitchen-notes']);

    await longPress(board, circleFor('Zoe Vance'));
    expect(circleFor('Zoe Vance').classList.contains('board-following')).toBe(false);

    await zoe({ surface: 'doc', docId: 'hob-spec' });
    // Still just the one: the second press unfollowed her.
    expect(board.location.navigations).toEqual(['/review/kitchen-notes']);
  });
});
