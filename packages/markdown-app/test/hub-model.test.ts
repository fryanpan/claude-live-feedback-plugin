import { describe, expect, it } from 'vitest';
import {
  type ActivityEvent,
  type BoardFilters,
  CHORES_ID,
  type ClientRelease,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type ReviewItem,
  type ReviewThreadItem,
  TASK_STATUS_ORDER,
  type UptimeReport,
  activityRows,
  appendDictation,
  boardSections,
  clientDriftNotice,
  decisionRows,
  describeEvent,
  doneAt,
  dropIndexFor,
  dropTarget,
  goalLabel,
  parseQuickAdd,
  pluginDriftNotice,
  positionBetween,
  presenceChips,
  quoteAfterCapture,
  quoteAfterEdit,
  quoteForCapture,
  reviewQueue,
  reviewRow,
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

  it('says what an evidence amendment corrected, and what it replaced', () => {
    // Same shape as the row above: the fallback would print
    // `task.evidence_amended` and read as a log line in a view built for
    // people. Two facts have to survive — that proof arrived late, and
    // whether it REPLACED a claim that was wrong.
    const filled = describeEvent(
      {
        event: 'task.evidence_amended',
        ts: NOW,
        taskId: 't-1',
        evidence: { commit: '621f371abc' },
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
      },
      titleOf,
    );
    expect(filled).toContain('Search Revamp');
    expect(filled).toContain('Fix ranking');
    expect(filled).toContain('621f371');
    expect(filled).not.toContain('task.evidence_amended');

    const corrected = describeEvent(
      {
        event: 'task.evidence_amended',
        ts: NOW,
        taskId: 't-1',
        evidence: { commit: '621f371abc' },
        supersedes: { commit: 'b2ba21edef' },
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
      },
      titleOf,
    );
    // The wrong-sha case has to read differently from filling a gap — the
    // superseded sha is the one someone may already have tried to follow.
    expect(corrected).toContain('b2ba21e');
    expect(corrected).not.toBe(filled);
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

describe('reviewQueue — human-owned work that agent work is waiting on', () => {
  const T0 = 1_700_000_000_000;
  const t = (over: Partial<HubTask>): HubTask => task({ createdAt: T0, updatedAt: T0, ...over });

  /**
   * A board with edges, and nothing else contrived about it. Every id is
   * spelled out so the expectation below can be re-derived from the `after`
   * arrays rather than copied off the implementation's output.
   */
  function boardWithEdges(): HubTask[] {
    return [
      t({ id: 'h-tunnel', assignee: 'human', title: 'Turn on the tunnel' }),
      t({ id: 'h-key', assignee: 'human', title: 'Grant the deploy key' }),
      // Human-owned and open, but nothing names it: criterion 3's case.
      t({ id: 'h-retro', assignee: 'human', title: 'Read the retro' }),
      // An agent's task that other agent work waits on. Blocking, but nobody
      // needs a person for it — the band is about what a person is holding.
      t({ id: 'a-gate', assignee: 'Helper', title: 'Land the schema change' }),
      t({ id: 'a-1', assignee: 'Helper', after: ['h-tunnel'] }),
      t({ id: 'a-2', assignee: 'Helper', after: ['h-tunnel', 'h-key'], afterEnforce: ['h-key'] }),
      // Finished work waits on nothing — this edge must not count.
      t({ id: 'a-3', assignee: 'Helper', after: ['h-key'], status: 'done' }),
      t({ id: 'a-4', assignee: 'Helper', after: ['a-gate'] }),
    ];
  }

  /** What a reader would say by hand, read off the edges — not off the code. */
  function blockersByHand(tasks: HubTask[]): Map<string, number> {
    const open = tasks.filter((x) => x.status !== 'done');
    const out = new Map<string, number>();
    for (const h of open) {
      // Decisions have their own band; this one is about everything else a
      // person owns.
      if (h.assignee !== 'human' || h.needs === 'decision') continue;
      const waiting = open.filter((x) => x.id !== h.id && x.after.includes(h.id));
      if (waiting.length > 0) out.set(h.id, waiting.length);
    }
    return out;
  }

  // Criterion 2, as a relationship rather than a number: whatever the fixture
  // says, the band says the same thing.
  it('surfaces exactly the human tasks the edges point at, with the same counts', () => {
    const tasks = boardWithEdges();
    const byHand = blockersByHand(tasks);
    // The fixture is not vacuous — it has edges to find.
    expect(byHand.size).toBeGreaterThan(0);

    const q = reviewQueue(tasks, [], T0);
    const band = q.items.filter((i) => i.kind === 'blocker');
    expect(new Set(band.map((i) => i.blocker?.task.id))).toEqual(new Set(byHand.keys()));
    for (const item of band) {
      expect(item.blocker?.blocks.length).toBe(byHand.get(item.blocker?.task.id ?? ''));
    }
  });

  // Criterion 3. The decision band shows a decision with nothing waiting on it
  // ("Nothing is waiting on this yet"); this band must not, or every human task
  // on the board joins the strip.
  it('leaves out a human task nothing depends on', () => {
    const tasks = boardWithEdges();
    const q = reviewQueue(tasks, [], T0);
    const ids = q.items.filter((i) => i.kind === 'blocker').map((i) => i.blocker?.task.id);
    // Positive control first: the band can see a human task at all.
    expect(ids).toContain('h-tunnel');
    expect(ids).not.toContain('h-retro');
  });

  // A decision is also assigned to somebody. Counting it in both bands would
  // double it in the number at the top of the board.
  it('never counts a decision twice — it stays in the decision band only', () => {
    const d = t({ id: 'd-1', assignee: 'human', needs: 'decision', title: 'Blue or green?' });
    const waiting = t({ id: 'a-1', assignee: 'Helper', after: ['d-1'] });
    const q = reviewQueue([d, waiting], [], T0);
    expect(q.items.filter((i) => i.kind === 'decision')).toHaveLength(1);
    expect(q.items.filter((i) => i.kind === 'blocker')).toHaveLength(0);
    expect(q.total).toBe(1);
    expect(q.blocking).toBe(1);
  });

  it('drops a human blocker once it is done, and ignores done dependents', () => {
    const finished = t({ id: 'h-done', assignee: 'human', status: 'done' });
    const open = t({ id: 'h-open', assignee: 'human' });
    const waits = [
      t({ id: 'a-1', assignee: 'Helper', after: ['h-done'] }),
      t({ id: 'a-2', assignee: 'Helper', after: ['h-open'], status: 'done' }),
    ];
    const q = reviewQueue([finished, open, ...waits], [], T0);
    expect(q.items.filter((i) => i.kind === 'blocker')).toHaveLength(0);
  });

  // The count at the top means "act now". A blocker is blocking by definition
  // — that is the condition for being in the band — so it belongs in it.
  it('counts blockers as blocking, alongside decisions', () => {
    const q = reviewQueue(boardWithEdges(), [], T0);
    expect(q.blocking).toBe(2);
    expect(q.total).toBe(2);
  });

  it('bands blockers under decisions and above the comment bands', () => {
    const d = t({ id: 'd-1', assignee: 'human', needs: 'decision' });
    const tasks = [...boardWithEdges(), d, t({ id: 'a-9', assignee: 'Helper', after: ['d-1'] })];
    const q = reviewQueue(
      tasks,
      [
        {
          kind: 'task-thread',
          docId: 'task:a-1',
          threadId: 'th-1',
          taskId: 'a-1',
          title: 'Ship it',
          ask: 'Which repo?',
          askedBy: 'Helper',
          since: T0 - 1_000,
        },
      ],
      T0,
    );
    expect(q.items.map((i) => i.kind)).toEqual(['decision', 'blocker', 'blocker', 'task-thread']);
  });

  // Same rule the decision band uses: an enforced edge outranks a bigger soft
  // one, because that work cannot proceed at all.
  it('orders by what is enforced first, then by how much is waiting', () => {
    const q = reviewQueue(boardWithEdges(), [], T0);
    const band = q.items.filter((i) => i.kind === 'blocker');
    expect(band.map((i) => i.blocker?.task.id)).toEqual(['h-key', 'h-tunnel']);
    expect(band[0]?.blocker?.hard).toBe(true);
    expect(band[0]?.why).toContain('Hard-blocking');
    expect(band[1]?.why).toContain('Blocking 2 tasks');
  });

  // Pinning a scope choice, not celebrating it: ownership in this band is the
  // literal `human`, so a task handed to a person by name is out. Keying the
  // band on the viewer's own name — the other half of `taskVisible`'s My-Tasks
  // rule — would make one shared strip count differently per reader, and would
  // sweep in every agent-owned blocker for a reader whose typed name matches an
  // agent's. Changing this should be a decision, which is why it has a test.
  it('does not (yet) recognise a person addressed by display name', () => {
    const named = t({ id: 'p-1', assignee: 'Jordan', title: 'Sign the renewal' });
    const literal = t({ id: 'h-1', assignee: 'human', title: 'Turn on the tunnel' });
    const tasks = [
      named,
      literal,
      t({ id: 'a-1', assignee: 'Helper', after: ['p-1'] }),
      t({ id: 'a-2', assignee: 'Helper', after: ['h-1'] }),
    ];
    const ids = reviewQueue(tasks, [], T0)
      .items.filter((i) => i.kind === 'blocker')
      .map((i) => i.blocker?.task.id);
    // Positive control: the identical shape with the literal owner IS found,
    // so this is about the spelling and not about the edge.
    expect(ids).toEqual(['h-1']);
  });

  it('gives a blocker a stable key that cannot collide with a decision', () => {
    const q = reviewQueue(boardWithEdges(), [], T0);
    const keys = q.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('blocker:h-tunnel');
  });
});

describe('reviewRow — the row an item carries, whichever band it came from', () => {
  it('answers for a decision and a blocker, and not for a comment', () => {
    const T0 = 1_700_000_000_000;
    const d = task({ id: 'd-1', assignee: 'human', needs: 'decision', createdAt: T0 });
    const h = task({ id: 'h-1', assignee: 'human', createdAt: T0 });
    const q = reviewQueue(
      [d, h, task({ id: 'a-1', after: ['d-1'] }), task({ id: 'a-2', after: ['h-1'] })],
      [
        {
          kind: 'doc-thread',
          docId: 'doc-1',
          threadId: 'th-1',
          title: 'Launch plan',
          ask: 'Still true?',
          askedBy: 'Helper',
          since: T0,
        },
      ],
      T0,
    );
    const rowOf = (kind: string) => reviewRow(q.items.find((i) => i.kind === kind) as ReviewItem);
    expect(rowOf('decision')?.task.id).toBe('d-1');
    expect(rowOf('blocker')?.task.id).toBe('h-1');
    expect(rowOf('doc-thread')).toBeUndefined();
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

// ─────────────────────────────────────────────────────────────────────────────
// Plugin drift notice
// ─────────────────────────────────────────────────────────────────────────────

describe('pluginDriftNotice', () => {
  const rel = (
    version: string | null,
    behind: Array<{ agentId: string; pluginVersion?: string }>,
    checked?: number,
  ) => ({ version, behind, ...(checked === undefined ? {} : { checked }) });

  it('says who is behind, what current is, and both steps of the fix', () => {
    const n = pluginDriftNotice(
      rel('0.1.26', [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }]),
    );
    if (!n) throw new Error('expected a notice');
    expect(n.kind).toBe('alert');
    expect(n.headline).toBe('1 agent is running an older plugin than 0.1.26');
    expect(n.detail).toContain('agent-quill 0.1.12');
    // Both steps, in order. Restarting first pulls whatever the cache already
    // holds — which has moved a session BACKWARDS a version.
    // `command` bypasses shell functions and aliases. This machine wraps
    // `claude` in one that injects flags ahead of the subcommand, so the
    // bare form is parsed as a prompt and fails — printing a remediation
    // that does not work is worse than printing none. Harmless everywhere
    // that has no such wrapper.
    expect(n.fix).toBe(
      'Run: command claude plugin update live-feedback@claude-live-feedback — then restart that session.',
    );
  });

  it('pluralises, and lists every session', () => {
    const n = pluginDriftNotice(
      rel('0.2.0', [
        { agentId: 'agent-quill', pluginVersion: '0.1.12' },
        { agentId: 'agent-vane', pluginVersion: '0.1.30' },
      ]),
    );
    expect(n?.headline).toBe('2 agents are running an older plugin than 0.2.0');
    expect(n?.detail).toContain('agent-quill 0.1.12, agent-vane 0.1.30');
  });

  it('names a session that could not report a version', () => {
    // It is on a bundle older than the one that added the field, so "older
    // than we can name" is the true statement — not a blank.
    const n = pluginDriftNotice(rel('0.1.26', [{ agentId: 'agent-old' }]));
    expect(n?.detail).toContain('agent-old (too old to report)');
  });

  it('puts the domain and the denominator on the alarm too', () => {
    // "1 agent is behind" is also a statement about attached sessions only,
    // and 1-out-of-1 is a different thing to act on than 1-out-of-9.
    const n = pluginDriftNotice(rel('0.1.26', [{ agentId: 'agent-quill' }], 9));
    expect(n?.detail).toContain('of 9 checked');
    expect(n?.detail).toContain('a peer that never attached is absent here, not current');
  });

  // ── The defect this section exists for ────────────────────────────────
  //
  // Measured in the field 2026-08-17: the board rendered NOTHING over a
  // single attachment while sessions elsewhere in the fleet were releases
  // behind. Nothing reads exactly like all-clear, and fixing that one
  // session took the reading from "names one" to "names nobody" without
  // moving the fleet's drift at all.

  it('states its domain and its count instead of going silent when nobody is behind', () => {
    const n = pluginDriftNotice(rel('0.1.40', [], 1));
    if (!n) throw new Error('a clear result must still say what it covers');
    expect(n.kind).toBe('coverage');
    // The count is the whole point: 1 is not a fleet.
    expect(n.headline).toBe('No attached session is behind 0.1.40 (1 checked)');
    expect(n.detail).toContain('Only sessions that attach to this board are checked');
    expect(n.fix).toContain('Not a fleet-wide clearance');
  });

  it('a board nobody has attached to reads as unchecked, not as clear', () => {
    const n = pluginDriftNotice(rel('0.1.40', [], 0));
    expect(n?.kind).toBe('coverage');
    expect(n?.headline).toBe(
      'Nothing has been checked against 0.1.40 — no session has attached to this board',
    );
  });

  it('states the domain without inventing a count when the server sent none', () => {
    // A client can outlive the server release that added `checked`. Guessing
    // a denominator would be worse than omitting it.
    const n = pluginDriftNotice(rel('0.1.40', []));
    expect(n?.headline).toBe('No attached session is behind 0.1.40');
    expect(n?.headline).not.toContain('checked)');
    expect(n?.detail).toContain('Only sessions that attach to this board are checked');
  });

  it('says it cannot check rather than saying nothing when the version is unknown', () => {
    // The manifest was unreadable. Claiming drift would be inventing it — but
    // so would silence, which reads as "checked, all fine".
    const n = pluginDriftNotice(rel(null, [{ agentId: 'a', pluginVersion: '0.1.0' }], 3));
    expect(n?.kind).toBe('coverage');
    expect(n?.headline).toBe("Plugin versions can't be checked here");
    expect(n?.detail).toContain('(3 checked)');
    expect(n?.fix).toContain('is a clearance until that manifest reads');
  });

  it('is silent only when there is no attachments read at all', () => {
    // The one honest silence: the domain itself is unknown, so there is no
    // sentence to write. Positive control: every case above returns a notice.
    expect(pluginDriftNotice(undefined)).toBeNull();
    expect(pluginDriftNotice(null)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Client release notice — "every browser here is running an old client"
// ─────────────────────────────────────────────────────────────────────────────

describe('clientDriftNotice', () => {
  const HOUR = 60 * 60 * 1000;
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const release = (over: Partial<ClientRelease> = {}): ClientRelease => ({
    releaseId: '20260813T014455123Z-000003',
    publishedAt: now - 72 * HOUR,
    ageMs: 72 * HOUR,
    sourceRef: 'a1b2c3d',
    consecutiveFailures: 2,
    failingSince: now - 10 * HOUR,
    lastError: 'client release: markdownApp bundle is incomplete — app.js missing',
    stale: true,
    ...over,
  });

  it('says how old the served client is, since when the build has failed, and why', () => {
    const n = clientDriftNotice(release(), now);
    if (!n) throw new Error('expected a notice');
    // The age is the point: "stale" alone does not say whether the split is
    // minutes or a week, and the gap is what makes it urgent.
    expect(n.headline).toContain('3d ago');
    expect(n.detail).toContain('2 builds');
    expect(n.detail).toContain('10h ago');
    expect(n.detail).toContain('app.js missing');
    // Freshness of the artifact is not freshness of the source, so the
    // commit it was built from is part of the reading.
    expect(n.detail).toContain('a1b2c3d');
    // The restart IS the client deploy — without it a fixed build changes
    // nothing for any browser.
    expect(n.fix).toContain('restart');
  });

  it('says nothing while the deployment is healthy', () => {
    // Positive control: the same shape with stale:true does produce one.
    expect(clientDriftNotice(release(), now)).not.toBeNull();
    expect(clientDriftNotice(release({ stale: false }), now)).toBeNull();
    expect(clientDriftNotice(null, now)).toBeNull();
    expect(clientDriftNotice(undefined, now)).toBeNull();
  });

  it('does not invent an age when nothing was ever published', () => {
    const n = clientDriftNotice(
      release({ releaseId: null, publishedAt: null, ageMs: null, sourceRef: null }),
      now,
    );
    expect(n?.headline).not.toContain('NaN');
    expect(n?.headline.toLowerCase()).toContain('no client');
  });

  it('does not name a source the release never recorded', () => {
    const n = clientDriftNotice(release({ sourceRef: null }), now);
    expect(n?.detail).not.toContain('built from');
  });
});

// ── Dictation into the capture box ─────────────────────────────────────────

describe('appendDictation', () => {
  it('fills an empty box and makes the transcript the quote', () => {
    expect(appendDictation('', '  file a bug about the mic  ')).toEqual({
      text: 'file a bug about the mic',
      quote: 'file a bug about the mic',
    });
  });

  it('appends to what is already there rather than replacing it', () => {
    // Someone types half an idea, then finishes it out loud. Replacing would
    // eat the typed half — the one failure this whole box exists to prevent.
    expect(appendDictation('Fix the goal card', 'it is too tall on a phone')).toEqual({
      text: 'Fix the goal card it is too tall on a phone',
      quote: 'it is too tall on a phone',
    });
  });

  it('accumulates the quote across two utterances', () => {
    const first = appendDictation('', 'add a mic to the board');
    const second = appendDictation(first.text, 'and keep what I said', first.quote);
    expect(second.text).toBe('add a mic to the board and keep what I said');
    // Both utterances are what was SAID, so both belong to the quote.
    expect(second.quote).toBe('add a mic to the board and keep what I said');
  });

  it('quotes only the spoken half, never the typed half', () => {
    // The point of the quote: the agent gets the phrasing as spoken. Text
    // that was typed is already the task; it was never a quote of anyone.
    const r = appendDictation('typed words', 'spoken words');
    expect(r.quote).toBe('spoken words');
    expect(r.quote).not.toContain('typed');
  });

  it('an empty transcript changes nothing', () => {
    expect(appendDictation('already here', '   ', 'said before')).toEqual({
      text: 'already here',
      quote: 'said before',
    });
  });
});

describe('quoteForCapture', () => {
  it('survives an edit to the text it was dictated into', () => {
    // Dictation heard "mike"; he fixed it to "mic" before filing. The quote is
    // still what he SAID — the agent seeing both is the whole reason to keep
    // one, so this must NOT be conditioned on the text still matching.
    expect(quoteForCapture('add a mike to the board')).toBe('add a mike to the board');
  });

  it('has no quote for a task nobody spoke', () => {
    expect(quoteForCapture(undefined)).toBeUndefined();
  });

  it('treats a blank utterance as no quote rather than an empty one', () => {
    // An empty string would file `quote: ''` — a claim that words were spoken.
    expect(quoteForCapture('   ')).toBeUndefined();
  });
});

describe('quoteAfterCapture', () => {
  it('drops the utterance the filed task carried away with it', () => {
    expect(quoteAfterCapture('add a mic to the board', 'add a mic to the board')).toBe('');
  });

  it('keeps what was dictated while the capture was still in flight', () => {
    // The POST is pending, the box deliberately stays live, and a second
    // utterance lands. Only the filed half leaves; the rest belongs to the
    // idea still sitting in the box.
    expect(quoteAfterCapture('fix the login bug also update the docs', 'fix the login bug')).toBe(
      'also update the docs',
    );
  });

  it('keeps an accumulation that no longer starts with what was filed', () => {
    // The box was cleared mid-flight, so the quote was already dropped and
    // re-accumulated from a fresh utterance. Removing a prefix that isn't
    // there would eat words nobody has filed.
    expect(quoteAfterCapture('a brand new thought', 'fix the login bug')).toBe(
      'a brand new thought',
    );
  });

  it('keeps everything when the filed task carried no quote', () => {
    expect(quoteAfterCapture('said after a typed task filed', undefined)).toBe(
      'said after a typed task filed',
    );
  });
});

describe('quoteAfterEdit', () => {
  it('keeps the quote when a misheard word is corrected', () => {
    // "mike" → "mic": the box still holds the utterance, one word off. This
    // is the case the quote exists for.
    expect(quoteAfterEdit('add a mic to the board', 'add a mike to the board')).toBe(
      'add a mike to the board',
    );
  });

  it('keeps the quote when the person keeps typing after dictating', () => {
    expect(quoteAfterEdit('buy milk and oats on the way home', 'buy milk')).toBe('buy milk');
  });

  it('drops the quote when the box is retyped from scratch', () => {
    // Select-all-and-retype fires ONE input event with a non-empty value, so
    // "cleared to empty" never happens — and the new task would otherwise be
    // filed quoting words about entirely different work.
    expect(quoteAfterEdit('review the deploy script', 'buy milk')).toBe('');
  });

  it('drops the quote when the box is emptied by hand', () => {
    expect(quoteAfterEdit('', 'buy milk')).toBe('');
  });

  it('has nothing to keep when nothing was spoken', () => {
    expect(quoteAfterEdit('typed only', '')).toBe('');
  });
});
