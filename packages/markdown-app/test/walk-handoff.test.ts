import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHORES_ID,
  type HubTask,
  type ReviewQueue,
  type ReviewThreadItem,
  reviewQueue,
  walkHandoff,
  walkHandoffReady,
  walkNextUrl,
  walkPosition,
} from '../src/hub/hub-model';

// The landing page's review chip and "Review all" bar (the walkthrough
// handoff ticket) hand
// the client `?walk=1` (open the walkthrough on arrival) and `&then=<ids>`
// (workspaces still holding items, to visit after this queue drains). These
// two pure helpers are the whole contract; hub-app just wires them.

describe('walkHandoff', () => {
  it('reads walk + the handoff chain from a query string', () => {
    expect(walkHandoff('?walk=1&then=w-a,w-b')).toEqual({ walk: true, chain: ['w-a', 'w-b'] });
  });

  it('is inert without the walk param — a plain ?task= link opens nothing', () => {
    expect(walkHandoff('?task=t-1')).toEqual({ walk: false, chain: [] });
  });

  it('walk with no chain is a single-board sitting', () => {
    expect(walkHandoff('?walk=1')).toEqual({ walk: true, chain: [] });
  });

  it('drops empty segments so a trailing comma cannot produce a hop to nowhere', () => {
    expect(walkHandoff('?walk=1&then=w-a,,')).toEqual({ walk: true, chain: ['w-a'] });
  });
});

describe('walkNextUrl', () => {
  it('builds the next hop and carries the rest of the chain', () => {
    expect(walkNextUrl(['w-a', 'w-b'])).toBe('/workspaces/w-a/home?walk=1&then=w-b');
  });

  it('the last hop carries no then', () => {
    expect(walkNextUrl(['w-a'])).toBe('/workspaces/w-a/home?walk=1');
  });

  it('an empty chain has nowhere to go', () => {
    expect(walkNextUrl([])).toBe(null);
  });
});

// hub-app has no boot harness (same pin pattern as home-nav-reset.test.ts):
// assert the wiring exists in source — the boot reads the handoff, an armed
// walk auto-opens after the first review-items load, and a drained queue
// chains to the next workspace instead of dead-ending on a cleared card.
describe('hub-app wires the handoff', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

  it('reads walkHandoff from the boot URL', () => {
    expect(src).toContain('walkHandoff(location.search)');
  });

  it('auto-opens the walkthrough after the first review-items load', () => {
    // `deepLinkTick` bundles the ?walk= flag with the ?item= boot deep link —
    // both wait on the same queue, so they share every retry hook.
    expect(src).toMatch(/loadReviewItems\(\)\.then\([\s\S]{0,120}deepLinkTick\(\)/);
    expect(src).toMatch(/const deepLinkTick[\s\S]{0,80}maybeAutoWalk\(\)/);
  });

  it('chains to walkNextUrl when the queue drains', () => {
    expect(src).toContain('walkNextUrl(');
  });

  // Decisions ride the ydoc task projection, not the REST review-items list,
  // so on a cold connection the first load can resolve before the board has
  // synced. An empty queue must NOT burn the one-shot flag — the walk retries
  // when the projection lands, and only a deadline concludes the board is
  // genuinely clear (hopping the chain instead of opening on nothing).
  it('retries the auto-walk when the task projection arrives', () => {
    expect(src).toMatch(/tasksMap\.observeDeep\([\s\S]{0,500}autoWalkTick\?\.\(\)/);
  });

  it('an empty queue leaves the flag armed until the deadline', () => {
    expect(src).toContain('WALK_HANDOFF_DEADLINE_MS');
  });
});

// ── Where the handoff walk STARTS ──────────────────────────────────────────
//
// The walk aims by item KEY (walkPosition), and the key is chosen from the
// queue as it stands when the walk opens. On a cold load the two halves of
// the queue land separately: the REST review-items list and the ydoc task
// projection. A queue built from review items alone has no tasks to rank
// against, so every item takes the tail rank ordered by age — and a walk that
// opened on it aimed at the OLDEST ask. When the projection landed, the key
// followed that ask to its real rank, which is the bottom of the queue:
// "Review all" opened on N of N. All fixtures are synthetic.

const NOW = 1_700_000_000_000;

function task(id: string, order: number): HubTask {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:${id}`,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function ask(taskId: string, ageMs: number): ReviewThreadItem {
  return {
    kind: 'task-thread',
    docId: `task:${taskId}`,
    threadId: `th-${taskId}`,
    taskId,
    title: `Task ${taskId}`,
    ask: `Question on ${taskId}?`,
    askedBy: 'Helper',
    since: NOW - ageMs,
    band: 'declared',
    commentId: `c-${taskId}`,
    review: { shape: 'review', headline: `Question on ${taskId}?`, detail: '' },
  };
}

// Board order is t-1, t-2, t-3; the OLDEST ask is on the LAST task.
const tasks = [task('t-1', 1), task('t-2', 2), task('t-3', 3)];
const asks = [ask('t-1', 60_000), ask('t-2', 120_000), ask('t-3', 180_000)];
const reviewItemsOnly = () => reviewQueue([], asks, NOW);
const fullQueue = () => reviewQueue(tasks, asks, NOW);

/** What `startWalkthrough` does: aim at the head of the queue it sees. */
const startAt = (queue: ReviewQueue) => ({ index: 0, key: queue.items[0]?.key ?? null });

describe('the handoff walk starts at item 1', () => {
  it('the mechanism: a walk opened on review items alone lands on the tail once tasks rank it', () => {
    const aim = startAt(reviewItemsOnly());
    // The premise the bug rests on — without tasks, the oldest ask is first.
    expect(aim.key).toBe('task-thread:task:t-3:th-t-3');
    expect(walkPosition(fullQueue(), aim.index, aim.key)).toBe(2); // "3 of 3"
  });

  it('waits for both halves of the queue before opening', () => {
    const partial = reviewItemsOnly();
    expect(partial.items).toHaveLength(3);
    expect(walkHandoffReady(partial, { reviewItems: true, projection: false })).toBe(false);
    expect(walkHandoffReady(fullQueue(), { reviewItems: false, projection: true })).toBe(false);
    const full = fullQueue();
    expect(walkHandoffReady(full, { reviewItems: true, projection: true })).toBe(true);
    // Entering from Home with a 3-item queue: item 1 of 3.
    const aim = startAt(full);
    expect(walkPosition(full, aim.index, aim.key)).toBe(0);
    expect(full.items[0]?.key).toBe('task-thread:task:t-1:th-t-1');
  });

  it('an empty queue is never ready — the flag stays armed for the projection', () => {
    expect(
      walkHandoffReady(reviewQueue([], [], NOW), { reviewItems: true, projection: true }),
    ).toBe(false);
  });

  it('the deadline opens on whatever has landed rather than hopping a board that has items', () => {
    const partial = reviewItemsOnly();
    expect(walkHandoffReady(partial, { reviewItems: true, projection: false }, true)).toBe(true);
    expect(
      walkHandoffReady(reviewQueue([], [], NOW), { reviewItems: true, projection: false }, true),
    ).toBe(false);
  });

  // Positive control: a deep link (`?item=<key>`) aims by key and is NOT
  // gated on the sources — `maybeOpenBootItem` waits for that item itself.
  it('a deep link to item 2 still opens item 2', () => {
    const full = fullQueue();
    const key = full.items[1]?.key ?? null;
    expect(key).toBe('task-thread:task:t-2:th-t-2');
    // openInQueue(item, idx) — and the key keeps the aim across a re-rank.
    expect(walkPosition(full, 1, key)).toBe(1); // "2 of 3"
    expect(walkPosition(reviewItemsOnly(), 1, key)).toBe(1);
  });
});

describe('hub-app gates the auto-walk on both sources', () => {
  const src = readFileSync(join(__dirname, '..', 'src', 'hub', 'hub-app.ts'), 'utf8');

  it('maybeAutoWalk asks walkHandoffReady, not queue length', () => {
    expect(src).toMatch(/const maybeAutoWalk[\s\S]{0,900}walkHandoffReady\(/);
  });

  it('the ydoc sync (onReady, empty doc included) marks the projection landed and re-ticks', () => {
    expect(src).toMatch(
      /client\.onReady\([\s\S]{0,600}walkSources\.projection = true[\s\S]{0,200}autoWalkTick\?\.\(\)/,
    );
  });

  it('the first review-items load marks that half landed before ticking', () => {
    expect(src).toMatch(/walkSources\.reviewItems = true[\s\S]{0,120}deepLinkTick\(\)/);
  });
});
