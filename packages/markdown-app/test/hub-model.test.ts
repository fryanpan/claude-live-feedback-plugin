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
  goalRank,
  humanBlockerRows,
  parseQuickAdd,
  pluginDriftNotice,
  presenceChips,
  quoteAfterCapture,
  quoteAfterEdit,
  quoteForCapture,
  reviewCardHeadline,
  reviewItemBadge,
  reviewQueue,
  reviewRow,
  stepTarget,
  taskVisible,
  timeAgo,
  unplacedNotice,
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

  it('names BOTH titles when a rewrite reshaped the row', () => {
    // Triage shaping a raw capture replaces the clipped fragment the person
    // filed. "rewrote the description of <new title>" is useless to them —
    // the new title is one they have never seen, and the old one survives
    // nowhere else on the board once the row is shaped. The old name is the
    // only handle back to what they typed.
    const s = describeEvent(
      {
        event: 'task.body_edited',
        ts: NOW,
        taskId: 't-1',
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
        titleFrom: 'And also it is really hard to go from one shel…',
        titleTo: 'Moving between shelves loses your place',
      },
      titleOf,
    );
    expect(s).toContain('Search Revamp');
    expect(s).toContain('And also it is really hard to go from one shel…');
    expect(s).toContain('Moving between shelves loses your place');
    expect(s).not.toContain('task.body_edited');
  });

  it('names a title-only rename with both names and the reason, not the raw slug', () => {
    // task.retitled is new (renames used to emit nothing), so without a case
    // here the feed prints the slug. The OLD name leads: it is the only one
    // the person who filed the row would recognise.
    const s = describeEvent(
      {
        event: 'task.retitled',
        ts: NOW,
        taskId: 't-1',
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
        titleFrom: 'fix the thing with the search',
        titleTo: 'Person can find results by relevance',
        reason: 'named the outcome instead of the artifact',
      },
      titleOf,
    );
    expect(s).toContain('Search Revamp');
    expect(s).toContain('fix the thing with the search');
    expect(s).toContain('Person can find results by relevance');
    expect(s).toContain('named the outcome instead of the artifact');
    expect(s).not.toContain('task.retitled');
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

  // The risk gate was removed on 2026-08-18 and nothing emits this again —
  // which is exactly why the case has to stay. Rows are already in
  // `events.jsonl` (two on the live board), and a type with no case falls
  // through to the test above's bare-slug behaviour: a log line in a feed
  // written for people. Same trap as "A new emitted event reaches the surface
  // as a bare slug" in learnings.md, running backwards.
  it('still describes a historical gate refusal rather than printing its slug', () => {
    const s = describeEvent(
      {
        event: 'task.gate_refused',
        ts: NOW,
        taskId: 't-1',
        to: 'done',
        riskTier: 'yellow',
        reason: 'needs-confirmation',
        actor: { id: 'agent-x', name: 'Search Revamp', kind: 'agent' },
      },
      titleOf,
    );
    // The sentence, not the key: actor, task title, tier and target status.
    expect(s).toContain('Search Revamp');
    expect(s).toContain('Fix ranking');
    expect(s).toContain('yellow');
    expect(s).toContain('done');
    // And the discriminating assertion — the fallback would have produced
    // exactly this string, so nothing above rules it out on its own.
    expect(s).not.toContain('task.gate_refused');
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
// A drop names the ROW it lands behind, not a number. These cases used to
// assert the fractional `position` the drop computed — 2.5 between orders 2
// and 3 — and every one of them passed while the feature was broken, because
// nothing here ever built the input that breaks it: two rows sharing an
// `order`. Fixtures were written 1, 2, 3, so the arithmetic always had room.
// The tie is the ordinary state of a real board (`set_task_goal` stores
// whatever number a caller sends), and between two tied rows no number can
// express "between them" at all. So the assertions below are about which row
// is named, and the fixture ties on purpose.
//
// The DOM-facing half (which row is under the pointer) is browser-only; these
// are the pure halves it feeds.

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
  // b and c TIE on order — the shape that broke the arithmetic, and the shape
  // a board reaches on its own. createdAt is spaced so the board's tiebreak
  // puts them in a known sequence rather than comparing two ids.
  const dropSections = () =>
    boardSections(
      GOALS,
      [
        task({ id: 'a', goal: 'g-pr', order: 1, createdAt: 100 }),
        task({ id: 'b', goal: 'g-pr', order: 2, createdAt: 200 }),
        task({ id: 'c', goal: 'g-pr', order: 2, createdAt: 300 }),
        task({ id: 'z', goal: 'g-blog', order: 1, createdAt: 400 }),
      ],
      filters,
    );

  it('names the row it lands behind, so tied neighbours are still distinguishable', () => {
    // The fixture is what makes this case worth having: b and c share an
    // order, so "between b and c" has no numeric answer — and these two drops
    // used to produce values that both sorted after c, i.e. one outcome for
    // two different destinations.
    expect(dropSections()[0]?.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    // 'a' dropped at index 1 of the remaining [b, c] → directly behind b.
    expect(dropTarget(dropSections(), 'a', 'g-pr', 1)).toEqual({ goal: 'g-pr', after: 'b' });
    // …and one further down is behind c.
    expect(dropTarget(dropSections(), 'a', 'g-pr', 2)).toEqual({ goal: 'g-pr', after: 'c' });
  });

  it('the top of a section is `after: null` rather than a row', () => {
    expect(dropTarget(dropSections(), 'c', 'g-pr', 0)).toEqual({ goal: 'g-pr', after: null });
  });

  it('moving to another goal is the same call with a different goal', () => {
    expect(dropTarget(dropSections(), 'a', 'g-blog', 0)).toEqual({ goal: 'g-blog', after: null });
    expect(dropTarget(dropSections(), 'a', 'g-blog', 1)).toEqual({ goal: 'g-blog', after: 'z' });
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
    expect(stepTarget(stepSections(), 'a', 1)).toEqual({ goal: 'g-pr', after: 'b' });
    expect(stepTarget(stepSections(), 'b', -1)).toEqual({ goal: 'g-pr', after: null });
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

  /** A DECLARED item — an agent said it is asking for something — which is
   *  what puts a thread in the queue proper. The ranking cases below are all
   *  about that queue, so this is their default. */
  const threadItem = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem => ({
    kind: 'task-thread',
    band: 'declared',
    review: {
      shape: 'decision',
      headline: 'Green or blue?',
      why: 'Blocks the widget.',
      options: [
        { id: 'g', label: 'Green' },
        { id: 'b', label: 'Blue' },
      ],
    },
    commentId: 'c-1',
    docId: 'task:tk-1',
    threadId: 'th-1',
    taskId: 'tk-1',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    askedBy: 'Helper',
    since: T0,
    ...over,
  });

  /** An agent comment nobody replied to that declared nothing — the inferred
   *  band. Its second line is DERIVED, which is what the lines below test. */
  const note = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem => {
    const { band, review, commentId, ...rest } = threadItem(over);
    void band;
    void review;
    void commentId;
    return rest;
  };

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

  // A question addressed to the reader outranks a note left for them, even a
  // much older one. Age alone put status updates at the top of the band — the
  // part of the strip that actually gets read — while the answerable rows sank.
  it('puts a direct question above an older status note', () => {
    const q = reviewQueue(
      [],
      [
        threadItem({ threadId: 'note-old', since: T0 - 90_000 }),
        threadItem({ threadId: 'asked', since: T0 - 1_000, direct: true }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['asked', 'note-old']);
  });

  it('still ranks by longest wait among the questions themselves', () => {
    const q = reviewQueue(
      [],
      [
        threadItem({ threadId: 'newer-ask', since: T0 - 1_000, direct: true }),
        threadItem({ threadId: 'older-ask', since: T0 - 90_000, direct: true }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['older-ask', 'newer-ask']);
  });

  // "asked you" is a claim that there is a question. A row that makes it over
  // a status note is the strip promising something it cannot deliver.
  it('says asked you only for a question, and posted otherwise', () => {
    // The derived second line belongs to the INFERRED band now: a declared
    // item's second line is the one its author wrote.
    const q = reviewQueue(
      [],
      [note({ threadId: 'a', direct: true }), note({ threadId: 'b', kind: 'doc-thread' })],
      T0,
    );
    expect(q.unreplied[0].why).toContain('asked you');
    expect(q.unreplied[1].why).toContain('posted');
    expect(q.unreplied[1].why).not.toContain('asked');
  });

  // The clock beside "asked" is the QUESTION's, not the run's. An agent that
  // posts status for a day and only then asks has a run starting a day ago and
  // a question minutes old; reading `since` there told the reader they had been
  // sitting on something they were just handed. Ranking still uses `since`.
  it('dates asked you from the question, not from the start of the wait', () => {
    const q = reviewQueue(
      [],
      [note({ threadId: 'a', direct: true, since: T0 - 86_400_000, askedAt: T0 - 60_000 })],
      T0,
    );
    expect(q.unreplied[0].why).toContain('asked you 1m ago');
    expect(q.unreplied[0].why).not.toContain('1d ago');
    // The wait itself is unchanged — this is a wording fix, not a re-rank.
    expect(q.unreplied[0].since).toBe(T0 - 86_400_000);
  });

  it('falls back to the wait when an older server sends no askedAt', () => {
    const q = reviewQueue([], [note({ threadId: 'a', direct: true, since: T0 - 60_000 })], T0);
    expect(q.unreplied[0].why).toContain('asked you 1m ago');
  });

  // A payload from a server that predates the field must order exactly as it
  // did before — undefined is not "true".
  it('treats a missing direct flag as a note', () => {
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

  // Kind is no longer a band (Bryan, 2026-08-18: "Always order asks by task
  // priority"). The fixture is built so the two rules DISAGREE: the decision
  // sits at the BOTTOM of the board and the blockers above it, so a run that
  // still bands by kind puts the decision first and this goes red. A fixture
  // where the board order happened to agree — which is what the previous
  // version of this test had — cannot tell the two rules apart at all.
  it('ranks a blocker above a lower-priority decision, kind notwithstanding', () => {
    const tasks = [...boardWithEdges(), t({ id: 'a-9', assignee: 'Helper', after: ['d-1'] })];
    // Ordered last on the board, so board order and the old kind-band order
    // point opposite ways.
    tasks.push(t({ id: 'd-1', assignee: 'human', needs: 'decision', order: 9_000 }));
    const q = reviewQueue(
      tasks,
      [
        {
          kind: 'task-thread',
          band: 'declared',
          review: { shape: 'decision', headline: 'Which repo?', why: 'Blocks the ship.' },
          commentId: 'c-1',
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
    // h-tunnel, h-key and a-1 all outrank d-1 on the board, so they come
    // first; the decision is last because its ROW is last, not because a
    // decision ranks low.
    expect(q.items.map((i) => i.kind)).toEqual(['blocker', 'blocker', 'task-thread', 'decision']);
  });

  // Enforced-first / most-blocked-first was the decision band's own primary
  // key and is no longer the queue's — board order decides, and this fixture
  // is the case where they disagree (h-key carries the enforced edge and
  // still sits second because h-tunnel is above it on the board). What the
  // enforced edge still does is choose the WORDING, so both halves are
  // asserted here: a change that dropped `hard` would otherwise pass.
  it('orders blockers by board position, and still says which edge is enforced', () => {
    const q = reviewQueue(boardWithEdges(), [], T0);
    const band = q.items.filter((i) => i.kind === 'blocker');
    expect(band.map((i) => i.blocker?.task.id)).toEqual(['h-tunnel', 'h-key']);
    // The enforced one is the second row now, and still knows it is enforced.
    expect(band[1]?.blocker?.hard).toBe(true);
    expect(band[1]?.why).toContain('Hard-blocking');
    expect(band[0]?.why).toContain('Blocking 2 tasks');
    // `decisionQueue`'s own ordering is untouched — the board's strip still
    // ranks the enforced edge first. Only the review queue re-ranks.
    expect(humanBlockerRows(boardWithEdges()).map((r) => r.task.id)).toEqual(['h-key', 'h-tunnel']);
  });

  // Ownership in this band used to be the literal `human`, which left a task
  // handed to a person by NAME out of it. It is now the kind the server
  // resolved — so the declaration is what admits a named person, and a name
  // that nobody declared still does not. The scope choice that stayed: keying
  // the band on the VIEWER's name would make one shared strip count
  // differently per reader and would sweep in every agent-owned blocker for a
  // reader whose typed name matches an agent's.
  it('recognises a person addressed by display name once the kind is declared', () => {
    const declared = t({
      id: 'p-1',
      assignee: 'Jordan',
      ownerKind: 'person',
      title: 'Sign the renewal',
    });
    const undeclared = t({ id: 'p-2', assignee: 'Wren Halloway', title: 'Renew the cert' });
    const literal = t({ id: 'h-1', assignee: 'human', title: 'Turn on the tunnel' });
    const tasks = [
      declared,
      undeclared,
      literal,
      t({ id: 'a-1', assignee: 'Helper', after: ['p-1'] }),
      t({ id: 'a-3', assignee: 'Helper', after: ['p-2'] }),
      t({ id: 'a-2', assignee: 'Helper', after: ['h-1'] }),
    ];
    const ids = reviewQueue(tasks, [], T0)
      .items.filter((i) => i.kind === 'blocker')
      .map((i) => i.blocker?.task.id);
    // The named person is in alongside the literal one; the identical shape
    // with nothing declared about it stays out, on the same read. Order is
    // the band's own (asserted above), so compare as a set.
    expect([...ids].sort()).toEqual(['h-1', 'p-1']);
  });

  it('gives a blocker a stable key that cannot collide with a decision', () => {
    const q = reviewQueue(boardWithEdges(), [], T0);
    const keys = q.items.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('blocker:h-tunnel');
  });
});

/**
 * "Always order asks by task priority" (Bryan, 2026-08-18, answering
 * t-vrwyE8YcVD-J). Priority means the BOARD's order — goal band, then the
 * task's position in it — so every case below is built so that the new key
 * and the key it replaced point in OPPOSITE directions. A fixture where they
 * agree cannot tell them apart, which is how the previous version of the
 * blocker-ordering test passed against both rules at once.
 */
describe('reviewQueue — task priority is the primary key', () => {
  const T0 = 1_700_000_000_000;
  const t = (over: Partial<HubTask>): HubTask => task({ createdAt: T0, updatedAt: T0, ...over });

  // Declared, because these cases rank asks in the queue proper against each
  // other and against task rows.
  const thread = (over: Partial<ReviewThreadItem>): ReviewThreadItem => ({
    kind: 'task-thread',
    band: 'declared',
    review: { shape: 'review', headline: 'Which one?', why: 'Waiting on you.' },
    commentId: 'c-x',
    docId: 'task:x',
    threadId: 'th-x',
    title: 'A task',
    ask: 'Which one?',
    askedBy: 'Helper',
    since: T0,
    ...over,
  });

  const ids = (q: ReturnType<typeof reviewQueue>) => q.items.map((i) => i.key);

  // The rank and the board's own section order have to be one answer. Nothing
  // in the four gates reads them together, so this is the only thing standing
  // between them and a silent drift — including the fallback, which is the
  // half most likely to be changed in one place.
  it('goalRank agrees with the board’s section order, Chores and strays last', () => {
    const rank = goalRank(GOALS);
    const sectionIds = boardSections(GOALS, [], filters).map((s) => s.id);
    expect(sectionIds.map(rank)).toEqual(sectionIds.map((_, i) => i));
    // A goal id no section carries renders under Chores on the board, so it
    // must rank there too rather than at the front.
    expect(rank('g-deleted')).toBe(rank(CHORES_ID));
  });

  // The goal band outranks everything inside a band. The fixture inverts every
  // other signal: the low-priority ask is a decision, is older, and is the one
  // holding work up.
  it('a lower goal band loses to a higher one, whatever else is true of it', () => {
    const late = t({
      id: 'd-late',
      goal: 'g-blog',
      order: 1,
      createdAt: T0 - HOUR,
      assignee: 'human',
      needs: 'decision',
    });
    const early = t({ id: 'h-early', goal: 'g-pr', order: 99, assignee: 'human' });
    const board = [late, early, t({ id: 'a-1', assignee: 'Helper', after: ['d-late', 'h-early'] })];
    expect(ids(reviewQueue(board, [], T0, GOALS))).toEqual(['blocker:h-early', 'decision:d-late']);
    // Positive control on the fixture: same inputs, no goal list, so there is
    // no band to rank by and `order` alone decides — and the pair comes back
    // the other way round. That is what makes the assertion above about the
    // GOAL ranking rather than about anything else in the fixture.
    expect(ids(reviewQueue(board, [], T0, []))).toEqual(['decision:d-late', 'blocker:h-early']);
  });

  it('inside one band, the board’s own order decides', () => {
    const top = t({ id: 'h-top', goal: 'g-pr', order: 1, assignee: 'human' });
    const mid = t({ id: 'h-mid', goal: 'g-pr', order: 2, assignee: 'human' });
    const sub = t({ id: 'h-sub', goal: 'g-pr-tickets', order: 1, assignee: 'human' });
    const waits = [
      t({ id: 'a-1', assignee: 'Helper', after: ['h-top'] }),
      t({ id: 'a-2', assignee: 'Helper', after: ['h-mid'] }),
      t({ id: 'a-3', assignee: 'Helper', after: ['h-sub'] }),
    ];
    const q = reviewQueue([mid, sub, top, ...waits], [], T0, GOALS);
    // A subgoal is its own band, nested directly after its parent — the same
    // sequence `boardSections` renders.
    expect(ids(q)).toEqual(['blocker:h-top', 'blocker:h-mid', 'blocker:h-sub']);
  });

  // Kind stops being a band and becomes a tiebreak inside one task: the row
  // first, then the discussion on it. Asks about a higher-priority task all
  // come first, comments included.
  it('groups every ask about one task together, in board order across tasks', () => {
    const first = t({ id: 'd-1', goal: 'g-pr', order: 1, assignee: 'human', needs: 'decision' });
    const second = t({ id: 'k-2', goal: 'g-pr', order: 2 });
    const q = reviewQueue(
      [first, second, t({ id: 'a-1', assignee: 'Helper', after: ['d-1'] })],
      [
        thread({ threadId: 'th-2', taskId: 'k-2', docId: 'task:k-2' }),
        thread({ threadId: 'th-1', taskId: 'd-1', docId: 'task:d-1' }),
      ],
      T0,
      GOALS,
    );
    expect(ids(q)).toEqual([
      'decision:d-1',
      'task-thread:task:d-1:th-1',
      'task-thread:task:k-2:th-2',
    ]);
  });

  // Oldest-first is the rule that stops an agent's own follow-ups burying its
  // question, and that happens inside one thread stack — which is exactly
  // where it still applies. Across tasks the instruction overrides it.
  it('keeps question-first then oldest-first, but only among asks of equal priority', () => {
    const one = t({ id: 'k-1', goal: 'g-pr', order: 1 });
    const two = t({ id: 'k-2', goal: 'g-pr', order: 2 });
    const q = reviewQueue(
      [one, two],
      [
        // On the LOWER-priority task: a real question, and the oldest wait of
        // the three. Under the previous rule it led the queue.
        thread({
          threadId: 'th-old',
          taskId: 'k-2',
          docId: 'task:k-2',
          direct: true,
          since: T0 - 10 * HOUR,
        }),
        thread({ threadId: 'th-new', taskId: 'k-1', docId: 'task:k-1', since: T0 - HOUR }),
        thread({
          threadId: 'th-ask',
          taskId: 'k-1',
          docId: 'task:k-1',
          direct: true,
          since: T0 - 5 * HOUR,
        }),
      ],
      T0,
      GOALS,
    );
    expect(ids(q)).toEqual([
      // k-1's two, question before note…
      'task-thread:task:k-1:th-ask',
      'task-thread:task:k-1:th-new',
      // …and only then the older, direct ask on the lower-priority task.
      'task-thread:task:k-2:th-old',
    ]);
  });

  // A doc comment has no task priority, so the primary key cannot speak about
  // it and it sorts after everything the key can rank. That is a position, not
  // a shelf: it is in the same queue and the same walkthrough, which is what
  // "it's okay to mix in 15-30 minute doc reads with quick decisions" asks for.
  it('sorts asks with no task after every ask that has one, and keeps them in the queue', () => {
    const only = t({ id: 'k-1', goal: 'g-blog', order: 500 });
    const q = reviewQueue(
      [only],
      [
        thread({ threadId: 'th-doc', kind: 'doc-thread', docId: 'doc-1', since: T0 - 9 * HOUR }),
        thread({ threadId: 'th-task', taskId: 'k-1', docId: 'task:k-1', since: T0 }),
      ],
      T0,
      GOALS,
    );
    expect(ids(q)).toEqual(['task-thread:task:k-1:th-task', 'doc-thread:doc-1:th-doc']);
    expect(q.total).toBe(2);
  });

  // The safety property: re-ranking must never make an ask disappear. A
  // discussion whose task is not in the projection yet has no priority to
  // rank by, and lands at the tail rather than being dropped — the
  // store-has-it/surface-cannot-show-it failure this queue exists to fix.
  it('still shows a discussion whose task is not on the board', () => {
    const q = reviewQueue(
      [t({ id: 'k-1', goal: 'g-pr', order: 1 })],
      [
        thread({ threadId: 'th-orphan', taskId: 't-gone', docId: 'task:t-gone' }),
        thread({ threadId: 'th-known', taskId: 'k-1', docId: 'task:k-1' }),
      ],
      T0,
      GOALS,
    );
    expect(ids(q)).toEqual(['task-thread:task:k-1:th-known', 'task-thread:task:t-gone:th-orphan']);
  });

  // The goal list is optional so no caller can get a partial order out of
  // this; without one every task is in a single band and board order alone
  // decides. Degraded, never arbitrary.
  it('is a total order with no goal list, and never reorders on a repeat call', () => {
    const tasks = [
      t({ id: 'h-b', goal: 'g-blog', order: 2, assignee: 'human' }),
      t({ id: 'h-a', goal: 'g-pr', order: 1, assignee: 'human' }),
      t({ id: 'a-1', assignee: 'Helper', after: ['h-a', 'h-b'] }),
    ];
    const first = ids(reviewQueue(tasks, [], T0));
    expect(first).toEqual(['blocker:h-a', 'blocker:h-b']);
    expect(ids(reviewQueue([...tasks].reverse(), [], T0))).toEqual(first);
  });
});

describe('reviewQueue — declared review items vs the inferred band', () => {
  const T0 = 1_700_000_000_000;
  const base = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem => ({
    kind: 'doc-thread',
    docId: 'doc-1',
    threadId: 'th-1',
    title: 'Onboarding copy',
    ask: 'Read the new onboarding copy',
    askedBy: 'Onboarding Rework',
    since: T0 - 60_000,
    ...over,
  });
  const declared = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem =>
    base({
      band: 'declared',
      commentId: 'c-1',
      review: {
        shape: 'review',
        headline: 'Read the new onboarding copy',
        why: 'Ships with the next release; nobody outside the team has read it.',
      },
      ...over,
    });

  // The whole point of the change: only what an agent DECLARED is work.
  it('puts a declared item in the queue and an undeclared one in unreplied', () => {
    const q = reviewQueue([], [declared({ threadId: 'a' }), base({ threadId: 'b' })], T0);
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['a']);
    expect(q.unreplied.map((i) => i.thread?.threadId)).toEqual(['b']);
    // The count and the walkthrough are the queue proper, so a status note
    // no longer inflates either.
    expect(q.total).toBe(1);
  });

  // Nothing vanishes. 105 inferred rows existed the day this shipped, and a
  // row that stops rendering is indistinguishable from data loss to whoever
  // wrote it — so the two lists together must still hold every thread.
  it('accounts for every thread across the two lists, whatever their bands', () => {
    const items = [
      declared({ threadId: 'a' }),
      base({ threadId: 'b' }),
      declared({ threadId: 'c', kind: 'task-thread', taskId: 'tk-1', docId: 'task:tk-1' }),
      base({ threadId: 'd', kind: 'task-thread', taskId: 'tk-1', docId: 'task:tk-1' }),
    ];
    const q = reviewQueue([], items, T0);
    const seen = [...q.items, ...q.unreplied].map((i) => i.thread?.threadId).sort();
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    // ...and the split really did split, so the assertion above is not
    // satisfied by everything landing in one list.
    expect(q.items).toHaveLength(2);
    expect(q.unreplied).toHaveLength(2);
  });

  // The two lists are sorted by ONE comparator. Ranking them apart is how
  // they would come to disagree about what important means.
  it('ranks the inferred list by the same rule as the queue', () => {
    const q = reviewQueue(
      [],
      [
        base({ threadId: 'newer', since: T0 - 1_000 }),
        base({ threadId: 'older', since: T0 - 90_000 }),
        declared({ threadId: 'd-newer', since: T0 - 1_000 }),
        declared({ threadId: 'd-older', since: T0 - 90_000 }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['d-older', 'd-newer']);
    expect(q.unreplied.map((i) => i.thread?.threadId)).toEqual(['older', 'newer']);
  });

  // A payload from a server older than the field carries no band at all. It
  // must keep its pre-existing meaning rather than be promoted into a queue
  // it never declared for.
  it('treats a missing band as unreplied', () => {
    const q = reviewQueue([], [base({ band: undefined })], T0);
    expect(q.items).toHaveLength(0);
    expect(q.unreplied).toHaveLength(1);
  });

  // A band claiming declared with no payload is a half-written row. The
  // renderers all read `item.review`, so admitting it would put a card with
  // no headline at the top of somebody's queue.
  it('does not admit a declared band with no payload', () => {
    const q = reviewQueue([], [base({ band: 'declared' })], T0);
    expect(q.items).toHaveLength(0);
    expect(q.unreplied).toHaveLength(1);
  });

  it("takes a declared item's second line from its author, not from the clock", () => {
    const q = reviewQueue([], [declared()], T0);
    expect(q.items[0].why).toBe(
      'Ships with the next release; nobody outside the team has read it.',
    );
    expect(q.items[0].why).not.toContain('ago');
    // Positive control: the derived line is still what an undeclared row gets.
    expect(reviewQueue([], [base()], T0).unreplied[0].why).toContain('ago');
  });
});

describe('reviewCardHeadline — an authored headline is never clipped', () => {
  const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    key: 'k',
    kind: 'doc-thread',
    title: 'Onboarding copy',
    ask: 'Ship v2 now. Or wait for the rebuild?',
    why: 'w',
    since: 0,
    ...over,
  });

  // The derived heading stops at the first sentence, which on this string
  // throws the question away — exactly the unreadable row the declaration
  // exists to replace.
  it('shows a declared headline as written where the derived one would clip', () => {
    expect(reviewCardHeadline(item())).toBe('Ship v2 now.');
    expect(
      reviewCardHeadline(
        item({ review: { shape: 'decision', headline: 'Ship v2 now. Or wait?', why: 'w' } }),
      ),
    ).toBe('Ship v2 now. Or wait?');
  });
});

describe('reviewItemBadge', () => {
  const item = (review?: ReviewItem['review']): ReviewItem => ({
    key: 'k',
    kind: 'doc-thread',
    title: 't',
    ask: 'a',
    why: 'w',
    since: 0,
    ...(review ? { review } : {}),
  });

  it('reads a declared decision as a Decision wherever it arrived from', () => {
    expect(reviewItemBadge(item({ shape: 'decision', headline: 'h', why: 'w' })).label).toBe(
      'Decision',
    );
    expect(reviewItemBadge(item({ shape: 'review', headline: 'h', why: 'w' })).label).toBe(
      'Review',
    );
    // Positive control: an undeclared thread keeps the pre-existing badge.
    expect(reviewItemBadge(item()).label).toBe('Needs your reply');
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
          band: 'declared',
          review: { shape: 'review', headline: 'Still true?', why: 'Ships Friday.' },
          commentId: 'c-1',
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

describe('unplacedNotice — the quiet bucket says how many and how long', () => {
  const DAY = 24 * HOUR;

  it('is silent on an empty bucket rather than rendering a zero', () => {
    // Positive control first: the same call with one unplaced task DOES
    // answer, so "null" here is a decision and not a broken selection.
    const placed = [task({ goal: 'g-pr' }), task({ goal: CHORES_ID })];
    expect(unplacedNotice([...placed, task({ unplacedSince: NOW - DAY })], NOW)).not.toBeNull();
    expect(unplacedNotice(placed, NOW)).toBeNull();
    expect(unplacedNotice([], NOW)).toBeNull();
  });

  it('counts how many and dates the oldest', () => {
    const n = unplacedNotice(
      [
        task({ unplacedSince: NOW - 2 * DAY }),
        task({ unplacedSince: NOW - 6 * DAY }),
        task({ unplacedSince: NOW - HOUR }),
      ],
      NOW,
    );
    expect(n?.count).toBe(3);
    expect(n?.label).toBe('3 tasks have no goal yet');
    expect(n?.detail).toBe('oldest waiting 6d');
    expect(n?.oldestSince).toBe(NOW - 6 * DAY);
  });

  it('drops the comparison when there is only one to compare', () => {
    const n = unplacedNotice([task({ unplacedSince: NOW - 3 * HOUR })], NOW);
    expect(n?.label).toBe('1 task has no goal yet');
    expect(n?.detail).toBe('waiting 3h');
  });

  it('names the longest-waiting task so the strip can open it', () => {
    const old = task({ id: 't-oldest', unplacedSince: NOW - 9 * DAY });
    const n = unplacedNotice([task({ unplacedSince: NOW - DAY }), old], NOW);
    expect(n?.oldestTaskId).toBe('t-oldest');
  });

  it('breaks a tie on id so the strip names the same task twice running', () => {
    const ts = NOW - DAY;
    const a = task({ id: 't-aaa', unplacedSince: ts });
    const b = task({ id: 't-bbb', unplacedSince: ts });
    expect(unplacedNotice([a, b], NOW)?.oldestTaskId).toBe('t-aaa');
    expect(unplacedNotice([b, a], NOW)?.oldestTaskId).toBe('t-aaa');
  });

  it('reads unplacedSince, not "is it in Chores" — the proxy that was wrong both ways', () => {
    // Direction 1: an explicit `goal: 'chores'` IS a placement. It sits in
    // Chores with no marker and must not be counted.
    const deliberateChore = task({ goal: CHORES_ID });
    // Direction 2: a task swept out of a removed band keeps the
    // `triagedAgainst` of the placement it lost, so the old predicate never
    // saw it. The marker does.
    const swept = task({
      goal: CHORES_ID,
      triagedAgainst: { goalId: 'g-gone', goal: 'A band that was deleted', ts: NOW - 5 * DAY },
      unplacedSince: NOW - 5 * DAY,
    });
    const n = unplacedNotice([deliberateChore, swept], NOW);
    expect(n?.count).toBe(1);
    expect(n?.oldestTaskId).toBe(swept.id);
  });

  it('stops counting a task once it is done, marker or not', () => {
    const open = task({ unplacedSince: NOW - DAY });
    const finished = task({ status: 'done', unplacedSince: NOW - 8 * DAY });
    const n = unplacedNotice([open, finished], NOW);
    expect(n?.count).toBe(1);
    // The done task is the OLDER one, so a selection that leaked it would
    // show up in the age as well as the count.
    expect(n?.detail).toBe('waiting 1d');
  });
});
