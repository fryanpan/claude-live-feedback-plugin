/**
 * A withdrawn ask leaves the held index — the whole path, from the store that
 * holds the row to the frames the nudger sends.
 *
 * WHAT WENT WRONG. `withdrawReview` keeps the standing verdict on purpose: a
 * reinstated item the gate held is still held, so the stamp has to survive the
 * round trip. `isReviewItemHeld` read that verdict and the wrapper's `answer`
 * and nothing else, so an item its asker took back kept answering "held"
 * forever — and nothing could ever clear it, because `revise_review_item`
 * refuses a withdrawn item and answering it is the reader's door, which a
 * withdrawal is the act of closing. A peer lead measured the cost: a
 * `workspace.review_item_held` at the filer every few minutes for hours after
 * the withdrawal, and the same items named inside every `workspace.stalled`
 * frame.
 *
 * WHY THIS FILE EXISTS RATHER THAN A UNIT TEST ON THE PREDICATE. The predicate
 * has one in `review-item.test.ts`. What that cannot show is that the FRAMES
 * stop, and the frames are what the peer was reading — three layers sit
 * between the verdict and the wake (`heldReviewItems` builds the list,
 * `overdueHeldItems` ages it, `StallNudger` addresses it), and each is free to
 * reintroduce the row. So the composition is assembled here exactly as
 * `server.ts` assembles it, and the assertions are about what arrives.
 *
 * All fixtures are synthetic — invented ids and generic personas. The repo is
 * public.
 */
import { describe, expect, it } from 'bun:test';
import type { ReviewPayload } from '@feedback/core';
import type { Task } from '@feedback/core/task-wire';
import { ReviewJudgementStore } from '../src/review-items/judgements.ts';
import type {
  ReviewItemPersistence,
  ReviewItemStoreEvent,
} from '../src/review-items/persistence.ts';
import { ReviewItemQueries } from '../src/review-items/queries.ts';
import { ReviewItemStore } from '../src/review-items/store.ts';
import { HELD_ITEM_DEFAULT_MS, overdueHeldItems } from '../src/stall-gate.ts';
import {
  REVIEW_ITEM_HELD_EVENT,
  type ReviewItemHeldFrame,
  STALL_EVENT,
  type StallNudgeFrame,
  StallNudger,
  type StallSnapshot,
} from '../src/stall-nudge.ts';
import type { HubWorkspace } from '../src/tasks.ts';

const FILER = { id: 'agent-almanac', name: 'Almanac Agent', kind: 'known' };
const READER = { id: 'known-reviewer', name: 'Reviewer', kind: 'known' };
const LEAD = 'agent-cartographer';
const WS = 'w-fake';
const TASK = 't-legend';

/** A fixed clock, so every age in here is the injected one. */
const T0 = 1_800_000_000_000;

function payload(headline: string): ReviewPayload {
  return {
    shape: 'decision',
    headline,
    detail: 'Both readings are defensible and the renderer has to pick one before the next pass.',
    options: [
      { id: 'o-4c1e', label: 'Keep the wider bound' },
      { id: 'o-9ab2', label: 'Narrow it' },
    ],
  } as ReviewPayload;
}

/** The row, the board and the clock — the whole world these stores may see. */
function fake() {
  const row: Task = {
    id: TASK,
    workspaceId: WS,
    title: 'Pick the legend’s tie-break rule',
    assignee: 'Almanac Agent',
    goal: 'chores',
    order: 1,
    status: 'in-progress',
    after: [],
    links: [],
    transitions: [],
    createdAt: T0 - 5_000,
    updatedAt: T0 - 5_000,
  } as Task;
  const rows = new Map([[row.id, row]]);
  const workspace: HubWorkspace = {
    id: WS,
    name: 'Fake board',
    goals: [],
    docIds: [],
    createdAt: T0 - 10_000,
  };
  const events: ReviewItemStoreEvent[] = [];
  let clock = T0;
  const persistence: ReviewItemPersistence = {
    getTask: (taskId) => rows.get(taskId),
    listTasksIn: (workspaceId) => (workspaceId === WS ? Array.from(rows.values()) : []),
    listWorkspaceIds: () => [WS],
    getWorkspaceRecord: (workspaceId) => (workspaceId === WS ? workspace : undefined),
    save: () => {},
    emit: (event) => {
      events.push(event);
    },
    now: () => clock,
    noteBodyEdited: () => true,
    renameTask: (taskId) => {
      const found = rows.get(taskId);
      return found ? { ok: true, task: found, changed: false } : { ok: false, error: 'not-found' };
    },
  };
  return {
    store: new ReviewItemStore(persistence),
    judgements: new ReviewJudgementStore(persistence),
    queries: new ReviewItemQueries(persistence),
    events,
    tick: (to: number) => {
      clock = to;
    },
    now: () => clock,
  };
}

/** File one item and have the gate hold it, exactly as the filing route does. */
function fileHeld(f: ReturnType<typeof fake>, headline: string, reason: string): string {
  const added = f.store.addReviewItem(TASK, payload(headline), { actor: FILER });
  if (!added.ok) throw new Error('unreachable');
  const judged = f.judgements.recordReviewJudgement(
    TASK,
    added.item.id,
    { at: f.now(), verdict: 'held', reason },
    { actor: FILER },
  );
  if (!judged.ok) throw new Error('unreachable');
  return added.item.id;
}

/**
 * The held list the stall monitor reads, assembled the way `server.ts`
 * assembles it: the store's held rows, aged by `overdueHeldItems`. Nothing
 * here is a copy of the production expression's RESULT — it is the expression.
 */
function heldNow(f: ReturnType<typeof fake>) {
  return overdueHeldItems(f.queries.heldReviewItems(WS), f.now(), HELD_ITEM_DEFAULT_MS);
}

/** A nudger over one board, with both deliveries recorded. */
function nudger(f: ReturnType<typeof fake>) {
  const stalls: StallNudgeFrame[] = [];
  const toFilers: ReviewItemHeldFrame[] = [];
  const board = (): StallSnapshot => ({
    workspaceId: WS,
    leadAgentId: LEAD,
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 1,
    undetermined: [],
    ...(heldNow(f).length > 0 ? { held: heldNow(f) } : {}),
  });
  return {
    stalls,
    toFilers,
    nudger: new StallNudger({
      now: f.now,
      snapshot: () => [board()],
      canReach: (_ws, agentId) => agentId === LEAD || agentId === FILER.id,
      attachedAgents: () => [LEAD, FILER.id],
      send: (_ws, _agentId, frame) => {
        stalls.push(frame);
        return 1;
      },
      sendToFiler: (_ws, _agentId, frame) => {
        toFilers.push(frame);
        return 1;
      },
    }),
  };
}

describe('a withdrawn review item leaves the held index', () => {
  it('stops the filer’s held nudge and drops out of the lead’s stall frame', () => {
    const f = fake();
    const kept = fileHeld(f, 'Which tie-break wins?', 'the headline names no decision');
    const takenBack = fileHeld(f, 'Do we still need the legend?', 'no options named');

    // Past the hold window, so both are overdue rather than freshly filed.
    f.tick(T0 + HELD_ITEM_DEFAULT_MS + 60_000);
    const first = nudger(f);
    first.nudger.tick();

    expect(first.toFilers.map((frm) => frm.reviewItemId).sort()).toEqual([kept, takenBack].sort());
    expect(first.toFilers.every((frm) => frm.event === REVIEW_ITEM_HELD_EVENT)).toBe(true);
    expect(first.stalls).toHaveLength(1);
    expect(first.stalls[0]?.event).toBe(STALL_EVENT);
    expect((first.stalls[0]?.heldItems ?? []).map((item) => item.reviewItemId).sort()).toEqual(
      [kept, takenBack].sort(),
    );

    // The asker takes one back. Nothing else about the board changes.
    const withdrawn = f.store.withdrawReviewItem(TASK, takenBack, {
      actor: FILER,
      reason: 'answered on the ticket instead',
    });
    expect(withdrawn.ok).toBe(true);
    expect(f.events.at(-1)?.type).toBe('review_item.withdrawn');

    // The hold's own verdict is deliberately still standing — that is what
    // made the bug survivable-looking, so it is asserted rather than assumed.
    expect(withdrawn.ok && withdrawn.item.judge?.verdict).toBe('held');

    // AC1: no further held event for it, however long the clock runs.
    f.tick(T0 + 6 * 60 * 60_000);
    first.nudger.tick();
    first.nudger.tick();
    expect(first.toFilers.filter((frm) => frm.reviewItemId === takenBack)).toHaveLength(1);

    // AC2: the board still wakes over the item that IS held, and the frame
    // names only that one. A board that had merely gone empty would pass a
    // weaker assertion here without proving anything.
    const second = nudger(f);
    second.nudger.tick();
    expect(second.stalls).toHaveLength(1);
    expect((second.stalls[0]?.heldItems ?? []).map((item) => item.reviewItemId)).toEqual([kept]);
    expect(second.toFilers.map((frm) => frm.reviewItemId)).toEqual([kept]);
  });

  it('an ANSWERED held item is out of the index too, on the same rule', () => {
    const f = fake();
    const answered = fileHeld(f, 'Which tie-break wins?', 'the headline names no decision');
    f.tick(T0 + HELD_ITEM_DEFAULT_MS + 60_000);
    expect(heldNow(f).map((item) => item.reviewItemId)).toEqual([answered]);

    const res = f.store.answerTaskReview(TASK, answered, 'Keep the wider bound', {
      actor: READER,
      answeredWith: 'o-4c1e',
    });
    expect(res.ok).toBe(true);
    expect(heldNow(f)).toEqual([]);
  });

  it('reinstating puts it back — the hold was never erased, only unread', () => {
    const f = fake();
    const item = fileHeld(f, 'Which tie-break wins?', 'the headline names no decision');
    f.tick(T0 + HELD_ITEM_DEFAULT_MS + 60_000);

    expect(f.store.withdrawReviewItem(TASK, item, { actor: FILER }).ok).toBe(true);
    expect(heldNow(f)).toEqual([]);

    expect(f.store.withdrawReviewItem(TASK, item, { actor: FILER, undo: true }).ok).toBe(true);
    expect(heldNow(f).map((row) => row.reviewItemId)).toEqual([item]);
  });
});
