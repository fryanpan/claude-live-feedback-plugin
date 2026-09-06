import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CLOSED_WALK,
  type ReviewItem,
  type ReviewThreadItem,
  walkAimAfterOpen,
} from '../src/board/board-review-model';
import { type WalkthroughView, walkthroughData } from '../src/board/walkthrough-island.tsx';
import {
  type Booted,
  NOW,
  WS,
  boardRow,
  bootTestBoard,
  closeDetailPanel,
  resetBoardServer,
  server,
  settle,
} from './support/board-drive.ts';

/** A question on a DOC — the jump that leaves the page. */
const DOC_ASK: ReviewThreadItem = {
  kind: 'doc-thread',
  docId: 'd-1',
  threadId: 'th-1',
  title: 'The hob spec',
  ask: 'Induction or gas?',
  askedBy: 'Ada',
  since: NOW - 60_000,
  band: 'declared',
};
/** A question on a TASK — the open that stays, and repaints the card. */
const TASK_ASK: ReviewThreadItem = {
  kind: 'task-thread',
  docId: 'task:t-1',
  threadId: 'th-2',
  taskId: 't-1',
  title: 'Fit the hob',
  ask: 'Before or after the worktop?',
  askedBy: 'Ada',
  since: NOW - 30_000,
  band: 'declared',
};

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
  const aim = { index: 2, key: 'doc-thread:d-1:th-1' };

  it('a same-page open leaves the walkthrough closed', () => {
    // The panel took over the screen; the walk is genuinely put away, and the
    // URL should say so.
    expect(walkAimAfterOpen(aim, true)).toEqual({
      index: CLOSED_WALK.index,
      key: CLOSED_WALK.key,
    });
  });

  it('an open that LEAVES the page keeps the aim — bfcache is about to save it', () => {
    expect(walkAimAfterOpen(aim, false)).toEqual(aim);
  });

  it('an already-closed walk stays closed either way', () => {
    const closed = { index: -1, key: null };
    expect(walkAimAfterOpen(closed, true)).toEqual(closed);
    expect(walkAimAfterOpen(closed, false)).toEqual(closed);
  });
});
// ── The two openers, driven ────────────────────────────────────────────────
//
// This used to be read out of the boot's source, on the grounds that the
// return hop leaves the page and a driven boot cannot follow it. It does not
// have to follow it: the jump goes through the INJECTED location, so the URL
// the reader would have landed on is recorded rather than travelled, and the
// aim bfcache would freeze is the state the next render reads.
describe('the walkthrough hands the doc a way back', () => {
  beforeEach(() => {
    resetBoardServer();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Boot straight into a sitting on ONE ask, and hand back the card's own
   * handlers — the ones this paint bound to the item it drew.
   *
   * One item, because the return position the opener stamps is the reader's
   * AIM, not the row passed in: a two-item queue would open item A and stamp
   * item B, which is right and unreadable as an assertion.
   */
  async function sitting(ask: ReviewThreadItem): Promise<{
    board: Booted;
    view: WalkthroughView;
    item: ReviewItem;
  }> {
    server.on(`/workspaces/${WS}/review-items`, { items: [ask] });
    const board = await bootTestBoard({
      url: `https://board.test/workspaces/${WS}/home?walk=1`,
      tasks: [boardRow('t-1', { title: 'Fit the hob' })],
    });
    const view = walkthroughData.value;
    const item = view.queue.items[view.index];
    if (!item) throw new Error('the sitting opened on nothing');
    return { board, view, item };
  }

  it('the doc jump carries the reader\u2019s queue position on the link it mints', async () => {
    const { board, view, item: doc } = await sitting(DOC_ASK);
    view.handlers.onOpenItem(doc);
    await settle();
    expect(board.location.navigations).toEqual([
      `/workspaces/${WS}/docs/d-1?thread=th-1&item=${encodeURIComponent(doc.key)}`,
    ]);
  });

  it('the thread opener mints the same link \u2014 one rule, two handlers', async () => {
    // `onOpenThread` reaches the same doc jump when the item has no task
    // thread to aim at, so it fails the same way if it skips the shared path.
    const { board, view, item: doc } = await sitting(DOC_ASK);
    view.handlers.onOpenThread(doc);
    await settle();
    expect(board.location.navigations).toEqual([
      `/workspaces/${WS}/docs/d-1?thread=th-1&item=${encodeURIComponent(doc.key)}`,
    ]);
  });

  it('the aim survives the leaving, so the page bfcache restores is still in the sitting', async () => {
    const { board, view, item: doc } = await sitting(DOC_ASK);
    view.handlers.onOpenItem(doc);
    await settle();
    // The restore: the frozen heap comes back and the first render normalises
    // the URL from it. If the close had stood, that render would strip the
    // deep link and the reader would arrive on a rebuilt, closed Home.
    await board.project([boardRow('t-1', { title: 'Fit the hob' })]);
    expect(board.history.url()).toContain(`item=${encodeURIComponent(doc.key)}`);
  });

  it('an open that STAYS on the page really does close the walk', async () => {
    const { board, view, item } = await sitting(TASK_ASK);
    view.handlers.onOpenItem(item);
    await settle();
    expect(board.location.navigations).toEqual([]);
    expect(document.getElementById('board-home-page')?.classList.contains('hidden')).toBe(false);
    expect(board.history.url()).toContain('task=t-1');
    expect(board.history.url()).not.toContain('item=');
    await closeDetailPanel(board);
  });

  it('a doc opened outside a sitting stamps no return position', async () => {
    // Otherwise its back arrow would drop the reader into a queue they never
    // started.
    const { board, view, item: doc } = await sitting(DOC_ASK);
    view.handlers.onClose();
    await settle();
    walkthroughData.value.handlers.onOpenThread(doc);
    await settle();
    expect(board.location.navigations).toEqual([`/workspaces/${WS}/docs/d-1?thread=th-1`]);
  });
});
