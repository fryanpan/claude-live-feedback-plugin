/**
 * Tapping Home lands on the main Home page, from anywhere inside Home.
 *
 * Home has one drill-in: the review walkthrough. It is a PAGE inside Home
 * rather than an overlay — `renderWalkthrough` hides `#board-home-page` whenever
 * the queue position resolves to 0 or more, and that covers both the card
 * itself and the end-of-queue done state you land on after answering the last
 * item. The card carries its item in `?item=`; `/workspaces/<id>/home` with no
 * item is the main Home page.
 *
 * So the Home nav item had nothing to do: `setNav` saw `state.nav === 'home'`
 * already, skipped the pushState, re-rendered the same three regions, and the
 * walkthrough — held in `walkIndex` / `walkKey`, which nothing in that path
 * touched — stayed up. One tap, no visible change, and the only way back to
 * the Home page was the card's own close button.
 *
 * The fix is that arriving at Home closes the walkthrough, whichever way you
 * arrive (nav tap, the board banner's "go home", or Back onto `/home`). The
 * URL is the authority and the walkthrough is not in it.
 *
 * All fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type BoardTask, CHORES_ID } from '../src/board/board-model.ts';
import { CLOSED_WALK, reviewQueue, walkPosition } from '../src/board/board-review-model.ts';
import {
  type Booted,
  NOW,
  WS,
  boardRow,
  bootTestBoard,
  click,
  el,
  resetBoardServer,
} from './support/board-drive.ts';

/** A row the review queue picks up: open, human-owned, needing a decision. */
const decisionRow = (n: number): BoardTask =>
  boardRow(`t-${n}`, {
    title: `Decision ${n}`,
    assignee: 'human',
    needs: 'decision',
    goal: CHORES_ID,
    order: n,
  });

function decision(n: number): BoardTask {
  return {
    id: `t-${n}`,
    title: `Decision ${n}`,
    status: 'todo',
    assignee: 'human',
    needs: 'decision',
    goal: CHORES_ID,
    order: n,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${n}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** The one expression the render path reads: `#board-home-page` is hidden while
 *  this is 0 or more, so "the reader is on a Home subpage" and "this is not
 *  -1" are the same statement. */
const onSubpage = (index: number, key: string | null) =>
  walkPosition(reviewQueue([decision(1), decision(2)], [], NOW), index, key) >= 0;

describe('CLOSED_WALK — the pair that means the Home page is showing', () => {
  const queue = reviewQueue([decision(1), decision(2)], [], NOW);

  it('positive control: an aimed walkthrough really is a subpage', () => {
    // Without this the -1 below could be a queue that was empty all along
    // rather than a walkthrough that closed.
    expect(onSubpage(0, queue.items[0]?.key ?? null)).toBe(true);
  });

  it('positive control: so is the done state you run off the end into', () => {
    // Answering the last item leaves the index past the end. The card that
    // says "all caught up" is still a page over Home, and a Home tap from it
    // was just as silent.
    expect(onSubpage(queue.items.length, null)).toBe(true);
  });

  it('resolves to no card, so the Home page renders', () => {
    expect(walkPosition(queue, CLOSED_WALK.index, CLOSED_WALK.key)).toBe(-1);
    expect(onSubpage(CLOSED_WALK.index, CLOSED_WALK.key)).toBe(false);
  });
});

/**
 * The tap, on a real board.
 *
 * DRIVEN, NOT GREPPED. All four cases below used to cut `setNav` and
 * `renderWalkthrough` out of the concatenated boot modules with a regex and
 * match strings inside them — including two ABSENCES (`not.toContain('same')`
 * on one line, `history.pushState` nowhere in `setNav`). An absence in a
 * function body is the weakest evidence there is: the same guard spelled
 * `alreadyHere`, or moved one call deeper, passes every one of them. What
 * Bryan reported is a TAP that changed nothing on screen, so tap it.
 */
describe('the Home nav item resets Home', () => {
  const rows = [decisionRow(1), decisionRow(2)];

  beforeEach(resetBoardServer);
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const homePageShowing = () =>
    document.getElementById('board-home-page')?.classList.contains('hidden') === false;
  const walkPositionText = () =>
    document.querySelector('.board-walk-pos')?.textContent ??
    document.querySelector('[class*=board-walk-pos]')?.textContent ??
    null;

  /** Boot on Home and drill into the queue, the way the card is reached. */
  async function openWalkthrough(): Promise<Booted> {
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home`,
      tasks: rows,
    });
    expect(homePageShowing(), 'Home did not start on the Home page').toBe(true);
    await click(el('board-home').querySelector('.board-review-go') as HTMLElement);
    expect(homePageShowing(), 'Review All did not drill in').toBe(false);
    return board;
  }

  it('a Home tap from the card lands on the Home page — the whole bug', async () => {
    // `setNav` saw `state.nav === 'home'` already and short-circuited: one
    // tap, no visible change, and the only way back was the card's own close.
    // Home is ALREADY the destination here, which is the case that broke.
    const board = await openWalkthrough();
    await click(document.querySelector('[data-nav=home]') as HTMLElement);
    expect(homePageShowing()).toBe(true);
    // And the card is gone from the address too — the URL is the authority.
    expect(board.location.href).not.toContain('item=');
  });

  it('writes history only through the one address writer', async () => {
    // `syncBoardUrl` owns push-vs-replace-vs-unwind. A raw history call in the
    // nav handler would be a second, drifting opinion — visible here as an
    // extra entry, because the drill-in and the tap out are ONE step: a push
    // for the card, and the unwind that takes it back off.
    const board = await openWalkthrough();
    const beforeTap = board.history.entries.length;
    await click(document.querySelector('[data-nav=home]') as HTMLElement);
    const added = board.history.entries.slice(beforeTap);
    expect(added, 'the tap wrote more than the one unwind').toEqual([{ kind: 'back' }]);
  });

  it('closes it on the way in from anywhere — Back onto /home included', async () => {
    // The board banner's "go home" and a browser Back land on the same rule:
    // arriving at Home closes the card, whichever way you arrive.
    const board = await openWalkthrough();
    await board.traverseTo(`https://board.test/workspaces/${WS}/home`);
    expect(homePageShowing()).toBe(true);
  });

  it('closes it the same way the card’s own close button does', async () => {
    // Two spellings of "closed" is how the walkthrough comes back with a
    // stale tally under it: a close that clears the INDEX but leaves the KEY
    // resumes on the item the reader had walked to.
    const viaCard = await openWalkthrough();
    await click(document.querySelector('.board-walk-skip') as HTMLElement);
    expect(walkPositionText(), 'the skip did not move the card').toContain('2 of 2');
    await click(document.querySelector('.board-walk-home') as HTMLElement);
    expect(homePageShowing()).toBe(true);
    await click(el('board-home').querySelector('.board-review-go') as HTMLElement);
    const afterCardClose = walkPositionText();
    expect(afterCardClose).toContain('1 of 2');
    expect(viaCard.location.href).toContain('/home');

    document.body.innerHTML = '';
    resetBoardServer();

    await openWalkthrough();
    await click(document.querySelector('.board-walk-skip') as HTMLElement);
    expect(walkPositionText()).toContain('2 of 2');
    await click(document.querySelector('[data-nav=home]') as HTMLElement);
    expect(homePageShowing()).toBe(true);
    await click(el('board-home').querySelector('.board-review-go') as HTMLElement);
    // The two routes out leave the queue in the SAME place. A second spelling
    // of closed is exactly the difference this compares.
    expect(walkPositionText()).toBe(afterCardClose);
  });
});
