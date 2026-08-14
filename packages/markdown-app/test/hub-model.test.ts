import { describe, expect, it } from 'vitest';
import {
  type ActivityEvent,
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type ReviewThreadItem,
  TASK_STATUS_ORDER,
  type UptimeReport,
  activityRows,
  boardSections,
  decisionRows,
  describeEvent,
  doneAt,
  dropIndexFor,
  dropTarget,
  goalLabel,
  parseQuickAdd,
  positionBetween,
  presenceChips,
  reviewQueue,
  stepTarget,
  taskVisible,
  timeAgo,
  uptimeSummary,
} from '../src/hub/hub-model.ts';

/** All fixtures are synthetic — invented names, jordan@partner.example register. */

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: CHORES_ID,
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...overrides,
  };
}

const GOALS: HubGoal[] = [
  {
    id: 'g-pr',
    title: '1. Get the PR out',
    subgoals: [{ id: 'g-pr-tickets', title: '1.1 Post-PR tickets' }],
  },
  { id: 'g-blog', title: '2. Blog post' },
];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

describe('boardSections', () => {
  it('orders sections by goal priority, subgoals nested after their parent, Chores last', () => {
    const sections = boardSections(GOALS, [], filters);
    expect(sections.map((s) => s.id)).toEqual(['g-pr', 'g-pr-tickets', 'g-blog', CHORES_ID]);
    expect(sections.map((s) => s.depth)).toEqual([0, 1, 0, 0]);
    expect(sections[3]?.isChores).toBe(true);
    expect(sections[3]?.title).toBe('Chores');
  });

  it('places tasks in their goal or subgoal section, sorted by fractional order', () => {
    const a = task({ goal: 'g-pr', order: 2 });
    const b = task({ goal: 'g-pr', order: 1.5 });
    const sub = task({ goal: 'g-pr-tickets', order: 1 });
    const sections = boardSections(GOALS, [a, b, sub], filters);
    expect(sections[0]?.tasks.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(sections[1]?.tasks.map((t) => t.id)).toEqual([sub.id]);
  });

  it('renders a task whose goal id no longer exists under Chores rather than dropping it', () => {
    const orphan = task({ goal: 'g-deleted' });
    const sections = boardSections(GOALS, [orphan], filters);
    // Positive control: the task is somewhere at all.
    expect(sections.flatMap((s) => s.tasks).map((t) => t.id)).toContain(orphan.id);
    expect(sections.find((s) => s.isChores)?.tasks.map((t) => t.id)).toContain(orphan.id);
  });
});

describe('goalLabel', () => {
  it('names a goal and a subgoal the way its section header does', () => {
    expect(goalLabel(GOALS, 'g-pr')).toBe('1. Get the PR out');
    expect(goalLabel(GOALS, 'g-pr-tickets')).toBe('1.1 Post-PR tickets');
  });

  // Anything boardSections drops into Chores has to READ as Chores. A row
  // sitting under a header that says one thing while its detail panel says
  // another is the same defect as printing the raw id.
  it('says Chores for the catch-all and for a goal that no longer exists', () => {
    expect(goalLabel(GOALS, CHORES_ID)).toBe('Chores');
    expect(goalLabel(GOALS, 'g-deleted')).toBe('Chores');
    // The pairing this has to hold: same input, same answer as the board.
    const section = boardSections(GOALS, [task({ goal: 'g-deleted' })], filters).find((s) =>
      s.tasks.some((t) => t.goal === 'g-deleted'),
    );
    expect(section?.title).toBe(goalLabel(GOALS, 'g-deleted'));
  });
});

describe('taskVisible (done window + tabs)', () => {
  const doneRecent = task({
    status: 'done',
    transitions: [
      { ts: NOW - HOUR, from: 'in-progress', to: 'done', by: { name: 'Agent', kind: 'agent' } },
    ],
  });
  const doneOld = task({
    status: 'done',
    transitions: [
      { ts: NOW - 26 * HOUR, from: 'todo', to: 'done', by: { name: 'Agent', kind: 'agent' } },
    ],
  });

  it('done stays visible within the window and drops outside it (default 3h)', () => {
    // Positive control first: an open task is always visible.
    expect(taskVisible(task(), filters)).toBe(true);
    expect(taskVisible(doneRecent, filters)).toBe(true);
    expect(taskVisible(doneOld, filters)).toBe(false);
  });

  it('window none hides every done task; window all keeps them forever', () => {
    expect(taskVisible(doneRecent, { ...filters, doneWindow: 'none' })).toBe(false);
    expect(taskVisible(doneOld, { ...filters, doneWindow: 'all' })).toBe(true);
  });

  it('doneAt reads the last transition to done, falling back to updatedAt', () => {
    expect(doneAt(doneRecent)).toBe(NOW - HOUR);
    const bare = task({ status: 'done', updatedAt: NOW - 2 * HOUR });
    expect(doneAt(bare)).toBe(NOW - 2 * HOUR);
  });

  it('My Tasks keeps human-assigned tasks and tasks assigned to me by name', () => {
    const mineTab = { ...filters, tab: 'mine' as const };
    expect(taskVisible(task({ assignee: 'human' }), mineTab)).toBe(true);
    expect(taskVisible(task({ assignee: 'jordan' }), mineTab)).toBe(true);
    expect(taskVisible(task({ assignee: 'agent' }), mineTab)).toBe(false);
  });
});

describe('decisionRows', () => {
  it('keeps open unanswered decisions only', () => {
    const open = task({ assignee: 'human', needs: 'decision' });
    const answered = task({
      assignee: 'human',
      needs: 'decision',
      answer: { text: 'ship it', by: 'Jordan', ts: NOW },
    });
    const done = task({ assignee: 'human', needs: 'decision', status: 'done' });
    const action = task({ assignee: 'human', needs: 'action' });
    const rows = decisionRows([answered, open, done, action]);
    expect(rows.map((t) => t.id)).toEqual([open.id]);
  });
});

describe('TASK_STATUS_ORDER', () => {
  it('offers every status, so no transition is two moves away', () => {
    expect([...TASK_STATUS_ORDER].sort()).toEqual(['done', 'in-progress', 'todo']);
  });
});

describe('activityRows (exactly two filters)', () => {
  const events: ActivityEvent[] = [
    { event: 'task.created', ts: 1, task: { id: 't-1', title: 'A' } },
    { event: 'task.transitioned', ts: 2, taskId: 't-1', from: 'todo', to: 'done' },
    { event: 'task.regrouped', ts: 3, taskId: 't-1', fromGoal: 'chores', toGoal: 'g-pr' },
    { event: 'agent.heartbeat', ts: 4, agentId: 'agent-x' },
    { event: 'decision.answered', ts: 5, taskId: 't-2' },
  ];

  it('All shows everything except heartbeat noise, newest first', () => {
    const rows = activityRows(events, 'all');
    expect(rows.map((e) => e.event)).toEqual([
      'decision.answered',
      'task.regrouped',
      'task.transitioned',
      'task.created',
    ]);
  });

  it('Decisions keeps only rows where an agent exercised placement judgment', () => {
    // Positive control: the same input has transition rows under All.
    expect(activityRows(events, 'all').some((e) => e.event === 'task.transitioned')).toBe(true);
    const rows = activityRows(events, 'decisions');
    expect(rows.map((e) => e.event)).toEqual(['task.regrouped', 'task.created']);
  });
});

describe('describeEvent', () => {
  const titleOf = (id: string) => (id === 't-1' ? 'Fix ranking' : id);

  it('describes a regroup with actor and both goals', () => {
    const s = describeEvent(
      {
        event: 'task.regrouped',
        ts: NOW,
        taskId: 't-1',
        fromGoal: 'chores',
        toGoal: 'g-pr',
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
      },
      titleOf,
    );
    expect(s).toContain('Search Revamp');
    expect(s).toContain('Fix ranking');
    expect(s).toContain('g-pr');
  });

  it('names a description rewrite, rather than printing the raw event slug', () => {
    // The feed's fallback prints the event name for anything the table
    // misses, so this row would have "worked" — as the literal string
    // `task.body_edited`, with no actor and no task title. A new emitted
    // event needs its row here or the surface shows a slug.
    const s = describeEvent(
      {
        event: 'task.body_edited',
        ts: NOW,
        taskId: 't-1',
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
      },
      titleOf,
    );
    expect(s).toContain('Search Revamp');
    expect(s).toContain('Fix ranking');
    expect(s).not.toContain('task.body_edited');
  });

  it('falls back to the event name for unknown rows', () => {
    expect(describeEvent({ event: 'voice.request', ts: NOW }, titleOf)).toContain('voice.request');
  });

  it('names a server restart plainly', () => {
    expect(describeEvent({ event: 'server.started', ts: NOW }, titleOf)).toBe('server restarted');
  });
});

describe('uptimeSummary (deploy readiness — §3.12 commit 11)', () => {
  const report = (over: Partial<UptimeReport> = {}): UptimeReport => ({
    target: 0.99,
    windowMs: 7 * 24 * 60 * 60_000,
    measuredMs: 7 * 24 * 60 * 60_000,
    downMs: 0,
    uptimeRatio: 1,
    meetsTarget: true,
    gaps: [],
    tickMs: 5 * 60_000,
    ...over,
  });

  it('a clean week reads as 100%, meeting the target, with no down clause', () => {
    const s = uptimeSummary(report());
    expect(s).not.toBeNull();
    expect(s?.label).toBe('Uptime 100%');
    expect(s?.ok).toBe(true);
    expect(s?.detail).toContain('target 99%');
    expect(s?.detail).toContain('7d');
    expect(s?.detail).not.toContain('down');
  });

  it('a miss shows the truncated percentage and the downtime', () => {
    const s = uptimeSummary(
      report({
        uptimeRatio: 0.985,
        meetsTarget: false,
        downMs: 60 * 60_000,
        gaps: [{ from: 0, to: 60 * 60_000, downMs: 60 * 60_000 }],
      }),
    );
    expect(s?.label).toBe('Uptime 98.5%');
    expect(s?.ok).toBe(false);
    expect(s?.detail).toContain('down 1h');
  });

  it('truncates rather than rounds — 98.99% must not display as the target met', () => {
    const s = uptimeSummary(report({ uptimeRatio: 0.98999, meetsTarget: false }));
    expect(s?.label).toBe('Uptime 98.9%');
  });

  it('passes null through: no report, no banner', () => {
    expect(uptimeSummary(null)).toBeNull();
  });
});

describe('timeAgo', () => {
  it('scales seconds → minutes → hours → days', () => {
    expect(timeAgo(NOW - 40_000, NOW)).toBe('40s ago');
    expect(timeAgo(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(timeAgo(NOW - 3 * HOUR, NOW)).toBe('3h ago');
    expect(timeAgo(NOW - 49 * HOUR, NOW)).toBe('2d ago');
  });
});

describe('presenceChips', () => {
  it('renders one chip per person and per agent, people first', () => {
    const chips = presenceChips(
      [
        {
          clientId: 7,
          name: 'Jordan',
          surface: 'hub',
          lastActive: NOW - 40_000,
          self: true,
        },
      ],
      [
        {
          agentId: 'agent-search-revamp',
          state: 'active',
          stateLabel: 'active',
          lastToolCallAt: NOW - 40_000,
        },
      ],
      NOW,
    );
    expect(chips).toHaveLength(2);
    expect(chips[0]?.kind).toBe('person');
    expect(chips[0]?.label).toContain('Jordan');
    expect(chips[0]?.label).toContain('you');
    expect(chips[1]?.kind).toBe('agent');
    expect(chips[1]?.title).toContain('40s ago');
  });

  it('surfaces the unresponsive state label on agent chips', () => {
    const chips = presenceChips(
      [],
      [
        {
          agentId: 'agent-x',
          state: 'unresponsive',
          stateLabel: 'process up, agent unresponsive',
          lastToolCallAt: NOW - 40 * 60_000,
        },
      ],
      NOW,
    );
    expect(chips[0]?.title).toContain('process up, agent unresponsive');
  });
});

// ── Reordering (drag handle + keyboard) ────────────────────────────────────
//
// `task.order` is fractional and `set_task_goal` already takes a fractional
// `position`, so dropping between two rows is arithmetic, not a new API. The
// DOM-facing half (which row is under the pointer) is browser-only; these are
// the pure halves it feeds.

describe('positionBetween', () => {
  it('lands a row exactly between its two new neighbours', () => {
    expect(positionBetween(task({ order: 1 }), task({ order: 2 }))).toBe(1.5);
    expect(positionBetween(task({ order: 1.5 }), task({ order: 2 }))).toBe(1.75);
  });

  it('appends past the last row and prepends before the first', () => {
    expect(positionBetween(task({ order: 7 }), undefined)).toBe(8);
    expect(positionBetween(undefined, task({ order: 7 }))).toBe(6);
    // An empty section has no neighbours at all.
    expect(positionBetween(undefined, undefined)).toBe(0);
  });

  // Two rows can carry the same order across a goal boundary (orders are only
  // dense within a goal). A plain midpoint would equal both, the server would
  // report changed:false, and the drop would silently do nothing.
  it('still produces a value greater than `before` when the neighbours tie', () => {
    expect(positionBetween(task({ order: 3 }), task({ order: 3 }))).toBeGreaterThan(3);
  });
});

describe('dropIndexFor', () => {
  const rects = [
    { top: 0, height: 40 },
    { top: 40, height: 40 },
    { top: 80, height: 40 },
  ];

  it('counts the rows whose midpoint the pointer has passed', () => {
    expect(dropIndexFor(rects, 5)).toBe(0); // above the first midpoint
    expect(dropIndexFor(rects, 25)).toBe(1); // past row 0's midpoint
    expect(dropIndexFor(rects, 65)).toBe(2);
    expect(dropIndexFor(rects, 500)).toBe(3); // below everything → append
  });

  it('an empty section takes the only index there is', () => {
    expect(dropIndexFor([], 123)).toBe(0);
  });
});

describe('dropTarget', () => {
  const dropSections = () =>
    boardSections(
      GOALS,
      [
        task({ id: 'a', goal: 'g-pr', order: 1 }),
        task({ id: 'b', goal: 'g-pr', order: 2 }),
        task({ id: 'c', goal: 'g-pr', order: 3 }),
        task({ id: 'z', goal: 'g-blog', order: 1 }),
      ],
      filters,
    );

  it('reorders inside a goal at the midpoint of the rows it lands between', () => {
    // 'a' dropped at index 1 of the remaining [b, c] → between b and c.
    expect(dropTarget(dropSections(), 'a', 'g-pr', 1)).toEqual({ goal: 'g-pr', position: 2.5 });
    // …and one further down is past c, i.e. appended.
    expect(dropTarget(dropSections(), 'a', 'g-pr', 2)).toEqual({ goal: 'g-pr', position: 4 });
  });

  it('moving to another goal is the same call with a different goal', () => {
    expect(dropTarget(dropSections(), 'a', 'g-blog', 0)).toEqual({ goal: 'g-blog', position: 0 });
    expect(dropTarget(dropSections(), 'a', 'g-blog', 1)).toEqual({ goal: 'g-blog', position: 2 });
  });

  it('a drop that changes nothing is not a write', () => {
    // 'b' is already the second row of g-pr; re-landing it there would still
    // stamp a triage and fire task.regrouped for a move that did not happen.
    expect(dropTarget(dropSections(), 'b', 'g-pr', 1)).toBeNull();
    // Positive control: one slot over IS a write.
    expect(dropTarget(dropSections(), 'b', 'g-pr', 2)).not.toBeNull();
  });

  it('refuses a section or task it cannot resolve rather than guessing', () => {
    expect(dropTarget(dropSections(), 'a', 'no-such-goal', 0)).toBeNull();
    expect(dropTarget(dropSections(), 'no-such-task', 'g-pr', 0)).toBeNull();
  });
});

describe('stepTarget (the keyboard half of reordering)', () => {
  const stepSections = () =>
    boardSections(
      GOALS,
      [
        task({ id: 'a', goal: 'g-pr', order: 1 }),
        task({ id: 'b', goal: 'g-pr', order: 2 }),
        task({ id: 'z', goal: 'g-blog', order: 5 }),
      ],
      filters,
    );

  it('moves a row one slot down and one slot up inside its goal', () => {
    expect(stepTarget(stepSections(), 'a', 1)).toEqual({ goal: 'g-pr', position: 3 });
    expect(stepTarget(stepSections(), 'b', -1)).toEqual({ goal: 'g-pr', position: 0 });
  });

  // The keyboard has to reach every drop a pointer can, including the one
  // that crosses a section boundary — otherwise reordering is pointer-only
  // for exactly the move that matters most (re-prioritising into a goal).
  it('crosses into the neighbouring section at the ends', () => {
    // 'b' is last in g-pr; down lands it in the next section (the subgoal).
    expect(stepTarget(stepSections(), 'b', 1)?.goal).toBe('g-pr-tickets');
    // 'z' is alone in g-blog; up lands it in the section above it.
    expect(stepTarget(stepSections(), 'z', -1)?.goal).toBe('g-pr-tickets');
  });

  it('stops at the ends of the board rather than wrapping', () => {
    expect(stepTarget(stepSections(), 'a', -1)).toBeNull();
    const last = boardSections(GOALS, [task({ id: 'q', goal: CHORES_ID, order: 1 })], filters);
    expect(stepTarget(last, 'q', 1)).toBeNull();
  });
});

// ── The review queue: one list of everything waiting on a person ───────────

describe('reviewQueue', () => {
  const T0 = 1_700_000_000_000;
  const decision = (over: Partial<HubTask> = {}) =>
    ({
      id: 'd-1',
      title: 'Pick the palette',
      status: 'todo',
      assignee: 'human',
      needs: 'decision',
      goal: CHORES_ID,
      order: 1,
      after: [],
      links: [],
      transitions: [],
      bodyDocId: 'task:d-1',
      createdAt: T0,
      updatedAt: T0,
      ...over,
    }) as HubTask;

  const threadItem = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem => ({
    kind: 'task-thread',
    docId: 'task:tk-1',
    threadId: 'th-1',
    taskId: 'tk-1',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    askedBy: 'Helper',
    since: T0,
    ...over,
  });

  // The ordering Bryan asked for, and the reason the queue exists: the thing
  // holding work up is first, and a doc comment is not allowed to outrank a
  // decision just because it is older.
  it('bands decisions above task threads above doc threads', () => {
    const q = reviewQueue(
      [decision()],
      [
        threadItem({ kind: 'doc-thread', threadId: 'th-doc', since: T0 - 100_000 }),
        threadItem({ threadId: 'th-task', since: T0 - 50_000 }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.kind)).toEqual(['decision', 'task-thread', 'doc-thread']);
    expect(q.total).toBe(3);
  });

  // Within a band the longest wait wins — a queue that ranks by recency
  // starves its own tail, which is the failure this list exists to prevent.
  it('puts the longest wait first within a band', () => {
    const q = reviewQueue(
      [],
      [
        threadItem({ threadId: 'newer', since: T0 - 1_000 }),
        threadItem({ threadId: 'older', since: T0 - 90_000 }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['older', 'newer']);
  });

  // An answered decision is gone from the board's strip today, and the same
  // has to be true of the merged queue — otherwise the count at the top keeps
  // promising work that is finished.
  it('drops an answered decision and a done one', () => {
    const q = reviewQueue(
      [
        decision({ id: 'd-ans', answer: { text: 'blue', by: 'Bryan', ts: T0 } }),
        decision({ id: 'd-done', status: 'done' }),
      ],
      [],
      T0,
    );
    expect(q.items).toEqual([]);
    expect(q.total).toBe(0);
  });

  // Every item needs a stable identity, because the walkthrough steps by
  // position and a re-fetch reorders the list under it. Keys that collide
  // would step to the wrong item; keys that churn would lose the place.
  it('gives every item a distinct, stable key', () => {
    const q = reviewQueue(
      [decision()],
      [threadItem({ threadId: 'a' }), threadItem({ threadId: 'b', kind: 'doc-thread' })],
      T0,
    );
    const keys = q.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(3);
    expect(
      reviewQueue([decision()], [threadItem({ threadId: 'a' })], T0 + 5_000).items[0].key,
    ).toBe(keys[0]);
  });

  // The count at the top says how many are holding work up. For a decision
  // that is its dependents; a thread blocks nothing structurally, so counting
  // it would inflate the number that is supposed to mean "act now".
  it('counts only decisions with dependents as blocking', () => {
    const gate = decision({ id: 'd-gate' });
    const waiting = {
      ...decision({ id: 'tk-w', needs: 'action', assignee: 'agent' }),
      after: ['d-gate'],
    } as HubTask;
    const q = reviewQueue([gate, waiting], [threadItem()], T0);
    expect(q.blocking).toBe(1);
    expect(q.total).toBe(2);
  });
});

describe('parseQuickAdd', () => {
  it('takes a short line as the title and writes no body', () => {
    expect(parseQuickAdd('  Fix the mobile row overflow  ')).toEqual({
      title: 'Fix the mobile row overflow',
    });
  });

  it('refuses nothing at all', () => {
    expect(parseQuickAdd('')).toBeNull();
    expect(parseQuickAdd('   \n  ')).toBeNull();
  });

  // The rule that matters: capture may never cost the speaker a word. If the
  // title had to drop anything — extra lines, or an over-long first line —
  // the whole utterance survives verbatim in the body.
  it('keeps the full text verbatim whenever the title could not hold it', () => {
    const multi = 'Rework the strip\nIt should lead with what is blocked.';
    expect(parseQuickAdd(multi)).toEqual({ title: 'Rework the strip', body: multi });

    const long = `${'the quick brown fox jumps over the lazy dog '.repeat(4)}end`;
    const parsed = parseQuickAdd(long);
    expect(parsed?.body).toBe(long);
    expect(parsed?.title.length).toBeLessThanOrEqual(91);
    expect(parsed?.title.endsWith('…')).toBe(true);
    // A relationship, not a hand-copied string: the stem is a real prefix of
    // what was typed, and it stops at a word boundary rather than mid-word.
    const stem = (parsed?.title ?? '').slice(0, -1);
    expect(long.startsWith(stem)).toBe(true);
    expect(long.slice(stem.length, stem.length + 1)).toBe(' ');
  });

  it('does not clip a long line mid-word when there is no space to clip at', () => {
    const parsed = parseQuickAdd('x'.repeat(200));
    expect(parsed?.title).toBe(`${'x'.repeat(90)}…`);
    expect(parsed?.body).toBe('x'.repeat(200));
  });
});
