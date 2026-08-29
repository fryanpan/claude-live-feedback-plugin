import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { reviewItemBodyMarkdown } from '@feedback/core';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_REFRESH_EVENTS,
  type ActivityEvent,
  type BlockerRow,
  type BoardFilters,
  CHORES_ID,
  type ClientRelease,
  DEFAULT_DONE_WINDOW,
  GOAL_STATUS_ORDER,
  type HubGoal,
  type HubTask,
  type ReviewItem,
  type ReviewThreadItem,
  TASK_STATUS_ORDER,
  type UptimeReport,
  activityRows,
  appendDictation,
  askedMeta,
  askedMetaLine,
  blockedNoteLine,
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
  initialsOf,
  panelAsks,
  parseQuickAdd,
  pluginDriftNotice,
  presenceChips,
  presenceHue,
  quoteAfterCapture,
  quoteAfterEdit,
  quoteForCapture,
  reviewCardHeadline,
  reviewItemBadge,
  reviewQueue,
  reviewReplyRequest,
  reviewRow,
  stepTarget,
  taskActivity,
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
  it('orders sections by goal priority, subgoals nested after their parent, Backlog last', () => {
    const sections = boardSections(GOALS, [], filters);
    expect(sections.map((s) => s.id)).toEqual(['g-pr', 'g-pr-tickets', 'g-blog', CHORES_ID]);
    expect(sections.map((s) => s.depth)).toEqual([0, 1, 0, 0]);
    expect(sections[3]?.isChores).toBe(true);
    expect(sections[3]?.title).toBe('Backlog');
  });

  it('places tasks in their goal or subgoal section, sorted by fractional order', () => {
    const a = task({ goal: 'g-pr', order: 2 });
    const b = task({ goal: 'g-pr', order: 1.5 });
    const sub = task({ goal: 'g-pr-tickets', order: 1 });
    const sections = boardSections(GOALS, [a, b, sub], filters);
    expect(sections[0]?.tasks.map((t) => t.id)).toEqual([b.id, a.id]);
    expect(sections[1]?.tasks.map((t) => t.id)).toEqual([sub.id]);
  });

  it('renders a task whose goal id no longer exists under Backlog rather than dropping it', () => {
    const orphan = task({ goal: 'g-deleted' });
    const sections = boardSections(GOALS, [orphan], filters);
    // Positive control: the task is somewhere at all.
    expect(sections.flatMap((s) => s.tasks).map((t) => t.id)).toContain(orphan.id);
    expect(sections.find((s) => s.isChores)?.tasks.map((t) => t.id)).toContain(orphan.id);
  });

  it("carries a goal's status onto its section, so a done band reads differently from an open one", () => {
    const goals: HubGoal[] = [
      {
        id: 'g-pr',
        title: '1. Get the PR out',
        status: 'done',
        doneAt: NOW - HOUR,
        doneBy: { name: 'Jordan', kind: 'person' },
        subgoals: [{ id: 'g-pr-tickets', title: '1.1 Post-PR tickets', status: 'todo' }],
      },
      { id: 'g-blog', title: '2. Blog post' },
    ];
    const sections = boardSections(goals, [], filters);
    expect(sections[0]).toMatchObject({
      id: 'g-pr',
      status: 'done',
      doneAt: NOW - HOUR,
      doneBy: { name: 'Jordan', kind: 'person' },
    });
    expect(sections[1]).toMatchObject({ id: 'g-pr-tickets', status: 'todo' });
    // A goal the projection has not decorated (an older server) claims
    // nothing, and Backlog is a bucket rather than a goal — never a status.
    expect(sections[2]?.status).toBeUndefined();
    expect(sections.find((s) => s.isChores)?.status).toBeUndefined();
  });

  // The owner rides the same way the status trio does: verbatim when the
  // projection decorated the band, absent — not fabricated — when it did not.
  // Backlog is a bucket and can never carry one.
  it("carries a goal's projected owner onto its section, absent when unclaimed", () => {
    const goals: HubGoal[] = [
      { id: 'g-pr', title: '1. Get the PR out', assignee: 'team-lead-fleet', ownerKind: 'agent' },
      { id: 'g-blog', title: '2. Blog post' },
    ];
    const sections = boardSections(goals, [], filters);
    expect(sections[0]).toMatchObject({ assignee: 'team-lead-fleet', ownerKind: 'agent' });
    expect(sections[1] !== undefined && 'assignee' in sections[1]).toBe(false);
    const chores = sections.find((s) => s.isChores);
    expect(chores !== undefined && 'assignee' in chores).toBe(false);
  });
});

describe('goalLabel', () => {
  it('names a goal and a subgoal the way its section header does', () => {
    expect(goalLabel(GOALS, 'g-pr')).toBe('1. Get the PR out');
    expect(goalLabel(GOALS, 'g-pr-tickets')).toBe('1.1 Post-PR tickets');
  });

  // Anything boardSections drops into Backlog has to READ as Backlog. A row
  // sitting under a header that says one thing while its detail panel says
  // another is the same defect as printing the raw id.
  it('says Backlog for the catch-all and for a goal that no longer exists', () => {
    expect(goalLabel(GOALS, CHORES_ID)).toBe('Backlog');
    expect(goalLabel(GOALS, 'g-deleted')).toBe('Backlog');
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
    expect([...TASK_STATUS_ORDER].sort()).toEqual(['done', 'in-progress', 'todo', 'triage']);
  });

  it('leaves triage out of the GOAL list — a goal is never filed unvetted', () => {
    expect([...GOAL_STATUS_ORDER]).toEqual(['todo', 'in-progress', 'done']);
    expect(GOAL_STATUS_ORDER).not.toContain('triage');
    // Same members otherwise, so the two lists cannot drift into disagreeing
    // about what a status IS — only about which of them a goal may hold.
    expect(TASK_STATUS_ORDER.filter((s) => s !== 'triage')).toEqual([...GOAL_STATUS_ORDER]);
  });
});

describe('activityRows (exactly two filters)', () => {
  const events: ActivityEvent[] = [
    { event: 'task.created', ts: 1, task: { id: 't-1', title: 'A' } },
    { event: 'task.transitioned', ts: 2, taskId: 't-1', from: 'todo', to: 'done' },
    { event: 'task.regrouped', ts: 3, taskId: 't-1', fromGoal: 'chores', toGoal: 'g-pr' },
    { event: 'agent.heartbeat', ts: 4, agentId: 'agent-x' },
    { event: 'decision.answered', ts: 5, taskId: 't-2' },
    // One per agent turn — the activity pane's material, not the trail's.
    { event: 'task.noted', ts: 6, taskId: 't-1', kind: 'turn', text: 'Shipped it.' },
  ];

  it('All shows everything except heartbeat and turn-note noise, newest first', () => {
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

  it('a task’s own Activity tab drops turn notes too', () => {
    // (`task.created` carries the id under `task`, not `taskId`, so the tab
    // does not claim it; `task.transitioned` is rendered from the row.)
    const rows = taskActivity(events, 't-1');
    expect(rows.map((e) => e.event)).toEqual(['task.regrouped']);
  });
});

describe('ACTIVITY_REFRESH_EVENTS', () => {
  it('covers every event this feature writes to the trail, not only the founding set', () => {
    // The SSE wiring in hub-app iterates this list. An event the store emits
    // and `describeEvent` renders, but the list omits, is a trail that never
    // refreshes for it: the writer's own tab shows a due date it just set
    // with no Activity row, and a peer's undo leaves both browsers stale —
    // measured for `task.due_set` and `decision.answer_withdrawn` when the
    // list was hand-kept in hub-app and this branch forgot to extend it.
    //
    // `task.parked` is deliberately NOT here: nothing emits it since parking
    // became a move to triage plus a comment (2026-08-27). `describeEvent`
    // still renders it — the stored trail is full of real ones — but a list
    // entry for an event with no live emitter is a listener that can never
    // fire. The retired `task.gate_refused` sits out for the same reason.
    for (const ev of [
      'task.created',
      'task.transitioned',
      'task.assigned',
      'task.retitled',
      'task.due_set',
      'task.regrouped',
      'decision.answered',
      'decision.answer_withdrawn',
      'decision.info_requested',
      'workspace.goals_changed',
    ]) {
      expect(ACTIVITY_REFRESH_EVENTS, `${ev} would never refresh the trail`).toContain(ev);
    }
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

  it('reads a due date three ways — set, moved and cleared', () => {
    // `task.due_set` is new, so without a case here the feed prints the slug
    // with no actor and no title, the way `task.body_edited` did. Three
    // sentences because they read differently to whoever is scanning the trail
    // for what slipped: a date arriving, a date moving, a date going away.
    const due = (over: Record<string, unknown>) =>
      describeEvent(
        {
          event: 'task.due_set',
          ts: NOW,
          taskId: 't-1',
          actor: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
          ...over,
        },
        titleOf,
      );
    // Local noon, so the rendered day is the same one in every timezone.
    const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
    const shown = (t: number) => new Date(t).toLocaleDateString();

    const set = due({ from: null, to: day(2026, 9, 2) });
    expect(set).toContain('Jordan');
    expect(set).toContain('Fix ranking');
    expect(set).toContain(shown(day(2026, 9, 2)));
    expect(set).not.toContain('task.due_set');

    const moved = due({ from: day(2026, 9, 2), to: day(2026, 9, 9) });
    expect(moved).toContain(shown(day(2026, 9, 2)));
    expect(moved).toContain(shown(day(2026, 9, 9)));

    const cleared = due({ from: day(2026, 9, 9), to: null });
    expect(cleared).toContain('cleared');
    expect(cleared).toContain('Fix ranking');
    // A cleared date must not print the one it used to have as though it were
    // still set — "cleared … 9/9/2026" reads as a date somebody just chose.
    expect(cleared).not.toContain(shown(day(2026, 9, 9)));
  });

  // Retired as a WRITE on 2026-08-27; still rendered, because months of real
  // parks are in the stored trail and a removed case draws them as a raw
  // event name.
  it('still reads a stored park three ways, and always says what it was waiting for', () => {
    const park = (over: Record<string, unknown>) =>
      describeEvent(
        {
          event: 'task.parked',
          ts: NOW,
          taskId: 't-1',
          actor: { id: 'known-jordan', name: 'Jordan', kind: 'person' },
          ...over,
        },
        titleOf,
      );
    const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
    const shown = (t: number) => new Date(t).toLocaleDateString();

    const set = park({
      from: null,
      to: day(2026, 9, 2),
      reason: 'waiting on the index rebuild',
    });
    expect(set).toContain('Jordan');
    expect(set).toContain('Fix ranking');
    expect(set).toContain(shown(day(2026, 9, 2)));
    // The reason is the half somebody reads back weeks later when they ask
    // why the work never happened — a line with only a date cannot answer it.
    expect(set).toContain('waiting on the index rebuild');
    expect(set).not.toContain('task.parked');

    const moved = park({ from: day(2026, 9, 2), to: day(2026, 9, 9) });
    expect(moved).toContain(shown(day(2026, 9, 9)));

    const cleared = park({ from: day(2026, 9, 9), to: null });
    expect(cleared).toContain('un-parked');
    expect(cleared).toContain('Fix ranking');
    // A row that is no longer parked must not print the date it used to
    // carry, which would read as a park somebody just set.
    expect(cleared).not.toContain(shown(day(2026, 9, 9)));
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

  it('still reads back an evidence amendment written before the feature was removed', () => {
    // Evidence support went away on 2026-08-25 and nothing emits this any
    // more, but rows are already in `events.jsonl` and a person still opens
    // the feed. Without the case the fallback prints the bare slug
    // `task.evidence_amended` in a view built for people — the retired
    // `task.gate_refused` case exists for exactly this reason.
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

  it('keys a person on WHO they are, not on the connection they arrived over', () => {
    // A Yjs clientId is minted fresh on every connect, so keying rows on it
    // meant a reload came back as a stranger: a new row, a rebuilt node, and
    // a `followedKey` pointing at a connection that no longer exists.
    const chips = presenceChips(
      [{ clientId: 7, userId: 'anon-jj', name: 'Jordan', surface: 'hub', lastActive: NOW }],
      [],
      NOW,
    );
    const afterReload = presenceChips(
      [{ clientId: 9814, userId: 'anon-jj', name: 'Jordan', surface: 'hub', lastActive: NOW }],
      [],
      NOW,
    );
    expect(chips[0]?.key).toBe('p-anon-jj');
    expect(afterReload[0]?.key).toBe(chips[0]?.key);
  });

  it('keeps two people who share a display name apart', () => {
    // A name is not an identity. Folding on it would merge two humans into
    // one chip, and following either would sometimes land on the other's doc.
    const chips = presenceChips(
      [
        { clientId: 1, userId: 'anon-a', name: 'Alex', surface: 'hub', lastActive: NOW },
        { clientId: 2, userId: 'anon-b', name: 'Alex', surface: 'hub', lastActive: NOW },
      ],
      [],
      NOW,
    );
    expect(chips).toHaveLength(2);
    expect(new Set(chips.map((c) => c.key)).size).toBe(2);
  });

  it('falls back to the CONNECTION, not the name, for a tab that sends no id', () => {
    // A tab on an older bundle behaves exactly as every tab did before the id
    // existed — its own row, keyed on its connection — and folds with nobody.
    // Falling back to the name would merge two strangers who share one, and a
    // wrong identity is a wrong person, where an unstable key is only a lost
    // DOM node.
    const chips = presenceChips(
      [
        { clientId: 1, name: 'Alex', surface: 'hub', lastActive: NOW },
        { clientId: 2, name: 'Alex', surface: 'hub', lastActive: NOW },
      ],
      [],
      NOW,
    );
    expect(chips.map((c) => c.key)).toEqual(['p-c1', 'p-c2']);
  });

  it('folds one person’s several tabs into one chip, reading from the live one', () => {
    // Two tabs are two awareness entries and one human. Left unfolded they
    // drew the same person twice and burned two of the four circle slots.
    const chips = presenceChips(
      [
        {
          clientId: 1,
          userId: 'anon-jj',
          name: 'Jordan',
          surface: 'hub',
          lastActive: NOW - 600_000,
          self: true,
        },
        {
          clientId: 2,
          userId: 'anon-jj',
          name: 'Jordan',
          surface: 'doc',
          docId: 'doc-live',
          lastActive: NOW - 5_000,
        },
        { clientId: 3, userId: 'anon-ana', name: 'Ana', surface: 'hub', lastActive: NOW },
      ],
      [],
      NOW,
    );
    expect(chips.map((c) => c.key)).toEqual(['p-anon-ana', 'p-anon-jj']);
    const jordan = chips[1];
    // The most recently active tab is where they actually are…
    expect(jordan?.where).toBe('doc-live');
    expect(jordan?.docId).toBe('doc-live');
    expect(jordan?.title).toContain('5s ago');
    // …and being idle in one of your own tabs must not stop you being you.
    expect(jordan?.label).toBe('Jordan (you)');
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

describe('initialsOf (the letters a presence circle carries)', () => {
  it('takes the first letters of the first two words', () => {
    expect(initialsOf('Ana Reyes')).toBe('AR');
    expect(initialsOf('Ana')).toBe('A');
  });
  it('treats separator-joined agent ids as words', () => {
    expect(initialsOf('task-list-ux')).toBe('TL');
    expect(initialsOf('agent_search.revamp')).toBe('AS');
  });
  it('drops the "(you)" marker rather than reading its parenthesis', () => {
    expect(initialsOf('Ana (you)')).toBe('A');
  });
  it('never comes back empty — a blank circle reads as a broken one', () => {
    expect(initialsOf('')).toBe('?');
    expect(initialsOf('   ')).toBe('?');
  });
});

describe('presenceHue (deterministic circle colour)', () => {
  it('is stable and in range', () => {
    const h = presenceHue('Ana Reyes');
    expect(h).toBe(presenceHue('Ana Reyes'));
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThan(360);
  });
  it('gives you and the person watching you the same colour', () => {
    // The self chip's label carries "(you)"; the colour must not.
    expect(presenceHue('Ana Reyes (you)')).toBe(presenceHue('Ana Reyes'));
  });
  it('separates different names (the reason for a hash over a constant)', () => {
    expect(presenceHue('Ana Reyes')).not.toBe(presenceHue('Ben Ito'));
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
    // The derived second line belongs to the undeclared rows: a declared
    // item's second line is the one its author wrote.
    const q = reviewQueue(
      [],
      [note({ threadId: 'a', direct: true }), note({ threadId: 'b', kind: 'doc-thread' })],
      T0,
    );
    expect(q.items[0].why).toContain('asked you');
    expect(q.items[1].why).toContain('posted');
    expect(q.items[1].why).not.toContain('asked');
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
    expect(q.items[0].why).toContain('asked you 1m ago');
    expect(q.items[0].why).not.toContain('1d ago');
    // The wait itself is unchanged — this is a wording fix, not a re-rank.
    expect(q.items[0].since).toBe(T0 - 86_400_000);
  });

  it('falls back to the wait when an older server sends no askedAt', () => {
    const q = reviewQueue([], [note({ threadId: 'a', direct: true, since: T0 - 60_000 })], T0);
    expect(q.items[0].why).toContain('asked you 1m ago');
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

  /**
   * TICKET-borne review items (`kind: 'task-review'`) are placed like any
   * other declared ask. This queue used to skip them wholesale, which is the
   * measured defect: a review item filed with `create_tasks` / `add_review_item`
   * — the verbs agents are told to use — was shipped by the route and rendered
   * by NOTHING, so a decision addressed to a person never reached their Home
   * queue at all. Task status was never the gate; the row's kind was.
   */
  const ticketRowItem = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem =>
    ({
      kind: 'task-review',
      band: 'declared',
      review: {
        shape: 'decision',
        headline: 'Which cache do we keep?',
        options: [
          { id: 'o-disk', label: 'Keep disk' },
          { id: 'o-mem', label: 'Keep memory' },
        ],
      },
      taskId: 'tk-1',
      reviewItemId: 'r-1',
      title: 'Ship the widget',
      ask: 'Which cache do we keep?',
      askedBy: 'Helper',
      since: T0,
      direct: true,
      askedAt: T0,
      ...over,
    }) as unknown as ReviewThreadItem;

  it('places a ticket-borne review item with its own key and the authored why', () => {
    const q = reviewQueue([], [ticketRowItem()], T0);
    expect(q.items).toHaveLength(1);
    expect(q.items[0]).toMatchObject({
      key: 'task-review:tk-1:r-1',
      kind: 'task-review',
      title: 'Ship the widget',
    });
    expect(q.items[0].review?.headline).toBe('Which cache do we keep?');
    expect(q.total).toBe(1);
  });

  // The row must surface even when its carrying task is not on the caller's
  // task list — a triage row is on the board but a stale read may not hold
  // it, and the ask is an ask whatever the row's vetting status is. It lands
  // in the tail rank rather than vanishing.
  it('places the item even when its task is missing from the board read', () => {
    const q = reviewQueue([], [ticketRowItem({ taskId: 'tk-unseen' } as never)], T0);
    expect(q.items.map((i) => i.key)).toEqual(['task-review:tk-unseen:r-1']);
  });

  /**
   * The one row that must NOT be admitted: the store derives a `r-legacy`
   * review item from every legacy `needs: 'decision'` task, and that decision
   * already arrives here as a `decision` row read off the board projection.
   * Admitting the derived copy too would list one question twice.
   */
  it('skips the derived legacy row — its decision row already lists it', () => {
    const q = reviewQueue(
      [decision({ id: 'tk-1' })],
      [ticketRowItem({ reviewItemId: 'r-legacy' } as never)],
      T0,
    );
    expect(q.items.map((i) => i.kind)).toEqual(['decision']);
    expect(q.total).toBe(1);
  });

  // One task, two asks, two rows — a thread-borne declaration and a
  // ticket-borne item are different questions and neither may shadow the
  // other, nor list twice. (Team Lead re-filed ticket items as thread
  // payloads as a stopgap; a board holding both shapes must stay readable.)
  it('lists a thread-borne and a ticket-borne ask on one task once each', () => {
    const q = reviewQueue(
      [],
      [threadItem({ taskId: 'tk-1', threadId: 'th-1' }), ticketRowItem()],
      T0,
    );
    const keys = q.items.map((i) => i.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys).toContain('task-review:tk-1:r-1');
  });

  // A malformed row (no ids to answer at) is still skipped, not half-built:
  // a card whose answer posts nowhere is worse than no card.
  it('skips a ticket row missing the ids its answer path needs', () => {
    const q = reviewQueue(
      [],
      [ticketRowItem({ reviewItemId: undefined } as never), threadItem({ threadId: 'th-kept' })],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['th-kept']);
    expect(q.total).toBe(1);
  });

  /**
   * The SECOND consumer of the same array, which is where the guard above was
   * missing.
   *
   * The task detail panel takes this task's rows and renders the lead one as
   * "What we need from you" — with option buttons and a reply box that both
   * post a COMMENT on `item.threadId`. A ticket-borne row has no `threadId`,
   * so those controls file a stray discussion comment and record no answer;
   * and because such a row is always `direct`, it always wins the lead and
   * always renders on top. On a legacy decision that put a dead copy of the
   * option buttons directly above the live ones.
   *
   * So the panel takes only the rows whose answer path it actually
   * implements. The ticket-borne rows come back when the panel learns to
   * answer them at `POST /api/tasks/:id/review-items/:rid/answer`.
   */
  it('hands the detail panel only the rows whose answer path it implements', () => {
    const ticketRow = {
      ...threadItem({ threadId: 'th-ignored' }),
      kind: 'task-review',
      taskId: 'tk-1',
      threadId: undefined,
      docId: undefined,
    } as unknown as ReviewThreadItem;
    const mine = threadItem({ threadId: 'th-mine', taskId: 'tk-1' });
    const other = threadItem({ threadId: 'th-other', taskId: 'tk-2' });
    const docRow = threadItem({ kind: 'doc-thread', threadId: 'th-doc', docId: 'doc-9' });
    // biome-ignore lint/performance/noDelete: the row under test has no taskId at all.
    delete (docRow as { taskId?: string }).taskId;

    expect(panelAsks([ticketRow, mine, other, docRow], 'tk-1').map((i) => i.threadId)).toEqual([
      'th-mine',
    ]);
    // POSITIVE CONTROL: the by-taskId filter is unchanged for the rows that
    // were already reaching the panel — a doc row still never matches, and
    // another ticket's row still never matches.
    expect(panelAsks([mine, other, docRow], 'tk-2').map((i) => i.threadId)).toEqual(['th-other']);
    expect(panelAsks([ticketRow], 'tk-1')).toEqual([]);
  });

  /**
   * ONE spelling of "where does this answer go". The walkthrough's reply
   * handler used to build its two thread routes inline, and a ticket-borne row
   * reaching it would have posted a comment at `/api/docs/undefined/...` —
   * an answer that lands nowhere while the card advances. The routing is a
   * pure function so the test can hold all three doors.
   */
  describe('reviewReplyRequest', () => {
    const base = (): ReviewItem => {
      const q = reviewQueue([], [threadItem({ threadId: 'th-1', taskId: 'tk-1' })], T0);
      return q.items[0];
    };

    it('answers a ticket-borne item at the task review-item route', () => {
      const item: ReviewItem = {
        key: 'task-review:tk-1:r-1',
        kind: 'task-review',
        title: 'Ship the widget',
        ask: 'Which cache?',
        why: '',
        since: T0,
        review: { shape: 'decision', headline: 'Which cache?' },
        thread: {
          kind: 'task-review',
          taskId: 'tk-1',
          reviewItemId: 'r-1',
        } as unknown as ReviewThreadItem,
      };
      expect(reviewReplyRequest(item, 'Keep disk', 'o-disk')).toEqual({
        path: '/api/tasks/tk-1/review-items/r-1/answer',
        body: { text: 'Keep disk', answeredWith: 'o-disk' },
      });
      // Typed words carry no candidate id — nothing invents one.
      expect(reviewReplyRequest(item, 'Neither, drop both')).toEqual({
        path: '/api/tasks/tk-1/review-items/r-1/answer',
        body: { text: 'Neither, drop both' },
      });
    });

    it('answers a declared thread item against its declaring comment', () => {
      const item = base();
      expect(reviewReplyRequest(item, 'Green', 'g')).toEqual({
        path: '/api/docs/task%3Atk-1/threads/th-1/answer',
        body: { text: 'Green', commentId: 'c-1', optionId: 'g' },
      });
    });

    it('replies to an undeclared thread item as a plain comment', () => {
      const q = reviewQueue([], [note({ threadId: 'th-1', taskId: 'tk-1' })], T0);
      expect(reviewReplyRequest(q.items[0], 'On it')).toEqual({
        path: '/api/docs/task%3Atk-1/threads/th-1/comments',
        body: { text: 'On it' },
      });
    });

    it('refuses a row with nowhere to write', () => {
      const item: ReviewItem = {
        key: 'task-review:x',
        kind: 'task-review',
        title: 't',
        ask: '',
        why: '',
        since: T0,
        thread: { kind: 'task-review' } as unknown as ReviewThreadItem,
      };
      expect(reviewReplyRequest(item, 'words')).toBeNull();
      expect(reviewReplyRequest({ ...item, thread: undefined }, 'words')).toBeNull();
    });
  });
});

describe('reviewQueue — a blocker is task state, not a review item (design point 5)', () => {
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
      // Human-owned and open, but nothing names it.
      t({ id: 'h-retro', assignee: 'human', title: 'Read the retro' }),
      // An agent's task that other agent work waits on.
      t({ id: 'a-gate', assignee: 'Helper', title: 'Land the schema change' }),
      t({ id: 'a-1', assignee: 'Helper', after: ['h-tunnel'] }),
      t({ id: 'a-2', assignee: 'Helper', after: ['h-tunnel', 'h-key'], afterEnforce: ['h-key'] }),
      // Finished work waits on nothing — this edge must not count.
      t({ id: 'a-3', assignee: 'Helper', after: ['h-key'], status: 'done' }),
      t({ id: 'a-4', assignee: 'Helper', after: ['a-gate'] }),
    ];
  }

  // A blocker was never a question — there is nothing to answer, only work to
  // do — so it does not belong in a queue whose promise is "things you can
  // clear from here". It lives on its TASK instead: the panel note below.
  it('puts no human-owned blocker in the queue, while the panel still sees the rows', () => {
    const tasks = boardWithEdges();
    // Positive control FIRST: the same board still yields blocker rows for
    // the task panel's note. Only the queue stopped reading them.
    expect(humanBlockerRows(tasks).map((r) => r.task.id)).toEqual(['h-key', 'h-tunnel']);
    const q = reviewQueue(tasks, [], T0);
    expect(q.items).toEqual([]);
    expect(q.total).toBe(0);
  });

  // The count at the top means "act now, from here". With blockers off the
  // queue it is decisions with dependents, and nothing else.
  it('counts only decisions with dependents as blocking', () => {
    const d = t({ id: 'd-1', assignee: 'human', needs: 'decision', title: 'Blue or green?' });
    const board = [...boardWithEdges(), d, t({ id: 'a-d', assignee: 'Helper', after: ['d-1'] })];
    const q = reviewQueue(board, [], T0);
    expect(q.items.map((i) => i.key)).toEqual(['decision:d-1']);
    expect(q.blocking).toBe(1);
    expect(q.total).toBe(1);
  });

  it('keeps a decision a decision — dependents do not also make it a blocker row', () => {
    const d = t({ id: 'd-1', assignee: 'human', needs: 'decision', title: 'Blue or green?' });
    const waiting = t({ id: 'a-1', assignee: 'Helper', after: ['d-1'] });
    const q = reviewQueue([d, waiting], [], T0);
    expect(q.items.map((i) => i.kind)).toEqual(['decision']);
    expect(q.total).toBe(1);
    expect(q.blocking).toBe(1);
  });

  // The wording the task panel's note is built from: the count phrase the
  // decision rows already use, then the NAMES of what is standing behind the
  // task — the note is read on the task, where "2 tasks" alone answers
  // nothing.
  it('spells the note line off the row — the count, then what stands behind it', () => {
    const gate = t({ id: 'h-1', assignee: 'human', title: 'Turn on the tunnel' });
    const rows = humanBlockerRows([
      gate,
      t({ id: 'a-1', assignee: 'Helper', title: 'Ship the widget', after: ['h-1'] }),
      t({ id: 'a-2', assignee: 'Helper', title: 'Wire the badge', after: ['h-1'] }),
    ]);
    expect(blockedNoteLine(rows[0] as BlockerRow)).toBe(
      'Blocking 2 tasks: Ship the widget, Wire the badge',
    );
    const hard = humanBlockerRows([
      gate,
      t({
        id: 'a-3',
        assignee: 'Helper',
        title: 'Cut the release',
        after: ['h-1'],
        afterEnforce: ['h-1'],
      }),
    ]);
    expect(blockedNoteLine(hard[0] as BlockerRow)).toBe('Hard-blocking 1 task: Cut the release');
  });
});

/**
 * "Always order asks by task priority" (Bryan, 2026-08-18, answering
 * the ask-ordering ticket). Priority means the BOARD's order — goal band, then the
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
    review: { shape: 'review', headline: 'Which one?' },
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
  it('goalRank agrees with the board’s section order, Backlog and strays last', () => {
    const rank = goalRank(GOALS);
    const sectionIds = boardSections(GOALS, [], filters).map((s) => s.id);
    expect(sectionIds.map(rank)).toEqual(sectionIds.map((_, i) => i));
    // A goal id no section carries renders under Backlog on the board, so it
    // must rank there too rather than at the front.
    expect(rank('g-deleted')).toBe(rank(CHORES_ID));
  });

  // The goal band outranks everything inside a band. The fixture inverts the
  // other signals: the low-priority ask is older, holds board order 1, and is
  // the one holding work up.
  it('a lower goal band loses to a higher one, whatever else is true of it', () => {
    const late = t({
      id: 'd-late',
      goal: 'g-blog',
      order: 1,
      createdAt: T0 - HOUR,
      assignee: 'human',
      needs: 'decision',
    });
    const early = t({
      id: 'd-early',
      goal: 'g-pr',
      order: 99,
      assignee: 'human',
      needs: 'decision',
    });
    const board = [late, early, t({ id: 'a-1', assignee: 'Helper', after: ['d-late'] })];
    expect(ids(reviewQueue(board, [], T0, GOALS))).toEqual(['decision:d-early', 'decision:d-late']);
    // Positive control on the fixture: same inputs, no goal list, so there is
    // no band to rank by and `order` alone decides — and the pair comes back
    // the other way round. That is what makes the assertion above about the
    // GOAL ranking rather than about anything else in the fixture.
    expect(ids(reviewQueue(board, [], T0, []))).toEqual(['decision:d-late', 'decision:d-early']);
  });

  it('inside one band, the board’s own order decides', () => {
    const top = t({ id: 'd-top', goal: 'g-pr', order: 1, assignee: 'human', needs: 'decision' });
    const mid = t({ id: 'd-mid', goal: 'g-pr', order: 2, assignee: 'human', needs: 'decision' });
    const sub = t({
      id: 'd-sub',
      goal: 'g-pr-tickets',
      order: 1,
      assignee: 'human',
      needs: 'decision',
    });
    const q = reviewQueue([mid, sub, top], [], T0, GOALS);
    // A subgoal is its own band, nested directly after its parent — the same
    // sequence `boardSections` renders.
    expect(ids(q)).toEqual(['decision:d-top', 'decision:d-mid', 'decision:d-sub']);
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
      t({ id: 'd-b', goal: 'g-blog', order: 2, assignee: 'human', needs: 'decision' }),
      t({ id: 'd-a', goal: 'g-pr', order: 1, assignee: 'human', needs: 'decision' }),
      t({ id: 'a-1', assignee: 'Helper', after: ['d-a', 'd-b'] }),
    ];
    const first = ids(reviewQueue(tasks, [], T0));
    expect(first).toEqual(['decision:d-a', 'decision:d-b']);
    expect(ids(reviewQueue([...tasks].reverse(), [], T0))).toEqual(first);
  });
});

describe('reviewQueue — every row the server ships is placed', () => {
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
      },
      ...over,
    });

  // Membership moved server-side (2026-08-21): the route ships a thread row
  // only for a declared item or a surviving direct ask, so every row that
  // arrives names something waiting on a person. The client's job is to PLACE
  // them all — the old undeclared shelf rendered nowhere, which made a
  // computed direct ask invisible on Home.
  it('places a declared item and an undeclared direct ask in the one queue', () => {
    const q = reviewQueue(
      [],
      [
        declared({ threadId: 'a', since: T0 - 90_000 }),
        base({ threadId: 'b', direct: true, askedAt: T0 - 30_000 }),
      ],
      T0,
    );
    // The direct question leads: among rows of equal task priority the
    // comparator puts an addressed question first, declared or not —
    // declaring changes the card, not the rank.
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['b', 'a']);
    expect(q.total).toBe(2);
    // The shelf is retired outright — a row is in the queue or it does not
    // exist, and a field nothing renders is where rows go to vanish.
    expect('unreplied' in q).toBe(false);
  });

  // Nothing vanishes. A row that stops rendering is indistinguishable from
  // data loss to whoever wrote it — so the one list must hold every thread
  // the server shipped, banded or not.
  it('accounts for every thread in the one list, whatever their bands', () => {
    const items = [
      declared({ threadId: 'a' }),
      base({ threadId: 'b' }),
      declared({ threadId: 'c', kind: 'task-thread', taskId: 'tk-1', docId: 'task:tk-1' }),
      base({ threadId: 'd', kind: 'task-thread', taskId: 'tk-1', docId: 'task:tk-1' }),
    ];
    const q = reviewQueue([], items, T0);
    const seen = q.items.map((i) => i.thread?.threadId).sort();
    expect(seen).toEqual(['a', 'b', 'c', 'd']);
    expect(q.total).toBe(4);
  });

  // Declared and inferred rank by the ONE comparator, interleaved — being
  // declared is not a priority band, so an old declared item cannot pin the
  // top of the queue against a direct question asked days before it.
  it('ranks declared and undeclared rows by the same rule, interleaved', () => {
    const q = reviewQueue(
      [],
      [
        base({ threadId: 'newer', since: T0 - 1_000 }),
        base({ threadId: 'older', since: T0 - 90_000 }),
        declared({ threadId: 'd-newer', since: T0 - 2_000 }),
        declared({ threadId: 'd-older', since: T0 - 100_000 }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual([
      'd-older',
      'older',
      'd-newer',
      'newer',
    ]);
  });

  // Two rows from ONE doc are two asks, not one row with a doc behind it.
  // Each ranks on its own clock and carries its own question — the data-level
  // half of telling apart rows that share a title.
  it('ranks two rows from the same doc independently, each with its own ask', () => {
    const q = reviewQueue(
      [],
      [
        base({ threadId: 'th-late', since: T0 - 1_000, ask: 'Second question?', direct: true }),
        base({ threadId: 'th-early', since: T0 - 90_000, ask: 'First question?', direct: true }),
      ],
      T0,
    );
    expect(q.items.map((i) => i.thread?.threadId)).toEqual(['th-early', 'th-late']);
    expect(q.items.map((i) => i.ask)).toEqual(['First question?', 'Second question?']);
    // Same doc, same title — the asks are what distinguish them.
    expect(q.items[0].title).toBe(q.items[1].title);
  });

  // A payload from a server older than the band field is still a row the
  // server chose to ship. With the shelf retired there is exactly one place
  // for it, and hiding it would be the vanishing-row bug this queue exists
  // to prevent.
  it('places a row with no band at all', () => {
    const q = reviewQueue([], [base({ band: undefined })], T0);
    expect(q.items).toHaveLength(1);
    expect(q.total).toBe(1);
  });

  // A band claiming declared with no payload is a half-written row. It is
  // still placed — membership is the server's call — but as an ordinary ask
  // with the derived second line, never as a declared card whose headline
  // would be blank.
  it('places a declared band with no payload as an ordinary ask, not a card', () => {
    const q = reviewQueue([], [base({ band: 'declared' })], T0);
    expect(q.items).toHaveLength(1);
    expect(q.items[0].review).toBeUndefined();
    expect(q.items[0].why).toContain('ago');
  });

  // This asserted the opposite until 2026-08-25: a declared row substituted
  // its author's `why` here while every other row got the derived provenance
  // line. That field is gone from the payload, and its words are read where
  // the author wrote them — in the card's one body — so the row's second line
  // is now one sentence with one meaning for every row that has one.
  it("takes a declared item's second line from the clock, like every other row", () => {
    const q = reviewQueue([], [declared()], T0);
    expect(q.items[0].why).toContain('ago');
    // Positive control: the same derived line, on an undeclared row.
    expect(reviewQueue([], [base()], T0).items[0].why).toContain('ago');
  });
});

describe('reviewCardHeadline — an authored headline is never clipped', () => {
  const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    key: 'k',
    kind: 'doc-thread',
    why: '',
    title: 'Onboarding copy',
    ask: 'Ship v2 now. Or wait for the rebuild?',
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
        item({ review: { shape: 'decision', headline: 'Ship v2 now. Or wait?' } }),
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
    why: '',
    since: 0,
    ...(review ? { review } : {}),
  });

  it('reads a declared decision as a Decision wherever it arrived from', () => {
    expect(reviewItemBadge(item({ shape: 'decision', headline: 'h' })).label).toBe('Decision');
    expect(reviewItemBadge(item({ shape: 'review', headline: 'h' })).label).toBe('Question');
    // Positive control: an undeclared thread keeps the pre-existing badge.
    expect(reviewItemBadge(item()).label).toBe('Needs your reply');
  });
});

describe('askedMeta — the one provenance line the card head carries', () => {
  const T0 = 1_700_000_000_000;
  const DAY = 86_400_000;
  const item = (over: Partial<ReviewItem> = {}): ReviewItem => ({
    key: 'k',
    kind: 'task-thread',
    title: 'Ship the widget',
    ask: 'Green or blue?',
    why: '',
    since: T0 - 2 * DAY,
    thread: {
      kind: 'task-thread',
      docId: 'task:t-1',
      threadId: 'th-1',
      taskId: 't-1',
      title: 'Ship the widget',
      ask: 'Green or blue?',
      askedBy: 'Harbor agent',
      since: T0 - 2 * DAY,
    },
    ...over,
  });
  const declared = (over: Partial<ReviewItem> = {}): ReviewItem =>
    item({ review: { shape: 'review', headline: 'Green or blue?' }, ...over });

  it('says Asked by <who> N days ago, singular and plural off one clock', () => {
    expect(askedMeta(declared(), T0)).toBe('Asked by Harbor agent 2 days ago');
    const one = declared({ since: T0 - DAY });
    if (one.thread) one.thread.since = T0 - DAY;
    expect(askedMeta(one, T0)).toBe('Asked by Harbor agent 1 day ago');
  });

  it('a declaration is always an ask, whatever direct measured', () => {
    // The declared fixture carries no `direct` at all — the flag is the
    // inferred band's evidence, and a declaration outranks it.
    expect(askedMeta(declared(), T0)).toMatch(/^Asked by/);
  });

  it('the inferred band keeps its measured Posted/Asked wording', () => {
    expect(askedMeta(item(), T0)).toBe('Posted by Harbor agent 2 days ago');
    const direct = item();
    if (direct.thread) direct.thread.direct = true;
    expect(askedMeta(direct, T0)).toMatch(/^Asked by Harbor agent/);
  });

  it("the clock beside Asked is the question's, not the run's", () => {
    const q = declared();
    if (q.thread) q.thread.askedAt = T0 - DAY;
    expect(askedMeta(q, T0)).toBe('Asked by Harbor agent 1 day ago');
  });

  it('a decision names the first recorded actor, or states the clock alone', () => {
    const d: ReviewItem = {
      key: 'decision:d-1',
      kind: 'decision',
      title: 'Blue or green?',
      ask: '',
      why: '',
      since: T0 - DAY,
      decision: {
        task: task({
          createdAt: T0 - DAY,
          transitions: [
            { ts: T0 - DAY, from: 'todo', to: 'todo', by: { name: 'Harbor agent', kind: 'agent' } },
          ],
        }),
        blocks: [],
        hard: false,
      },
    };
    expect(askedMeta(d, T0)).toBe('Asked by Harbor agent 1 day ago');
    const bare: ReviewItem = { ...d, decision: { task: task({}), blocks: [], hard: false } };
    expect(askedMeta(bare, T0)).toBe('Asked 1 day ago');
  });

  it('askedMetaLine is the shared spelling for surfaces with their own rows', () => {
    expect(askedMetaLine('Harbor agent', true, T0 - 3_600_000, T0)).toBe(
      'Asked by Harbor agent 1 hour ago',
    );
    expect(askedMetaLine(undefined, false, T0 - 3_600_000, T0)).toBe('Posted 1 hour ago');
  });
});

// This used to join three authored fields. It reads one now — `why` and
// `lookFor` are gone from the payload, and `readReviewPayload` has already
// folded any legacy text into `detail` before a renderer ever sees it. The
// join itself moved there; what stays here is the surfaces' one answer to
// "what is the body", so three renderers cannot each decide it.
describe('reviewItemBodyMarkdown — the one body a card renders', () => {
  it('is the detail, markdown and links intact', () => {
    expect(
      reviewItemBodyMarkdown({
        detail: 'The change is in [the PR](https://example.test/pr/12).',
      }),
    ).toBe('The change is in [the PR](https://example.test/pr/12).');
  });

  it('is empty when the author wrote no body — no labels, no placeholders', () => {
    expect(reviewItemBodyMarkdown({})).toBe('');
    expect(reviewItemBodyMarkdown({ detail: '  ' })).toBe('');
  });
});

describe('reviewRow — the row an item carries, when it carries one', () => {
  it('answers for a decision, and not for a comment', () => {
    const T0 = 1_700_000_000_000;
    const d = task({ id: 'd-1', assignee: 'human', needs: 'decision', createdAt: T0 });
    const q = reviewQueue(
      [d, task({ id: 'a-1', after: ['d-1'] })],
      [
        {
          kind: 'doc-thread',
          band: 'declared',
          review: { shape: 'review', headline: 'Still true?' },
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
      'Run: command claude plugin update claude-workspaces@claude-workspaces — then restart that session.',
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

  it('reads unplacedSince, not "is it in Backlog" — the proxy that was wrong both ways', () => {
    // Direction 1: an explicit `goal: 'chores'` IS a placement. It sits in
    // Backlog with no marker and must not be counted.
    const deliberateChore = task({ goal: CHORES_ID });
    // Direction 2: a task swept out of a removed band keeps the
    // `triagedAgainst` of the placement it lost, so the old predicate never
    // saw it. The marker does.
    const swept = task({
      goal: CHORES_ID,
      triagedAgainst: { goalId: 'g-gone', ts: NOW - 5 * DAY },
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

/**
 * The panel's ask rows come from `panelAsks`, not from an inline filter.
 *
 * A source-text assertion, because this is the ONE thing the unit test above
 * cannot see: `panelAsks` can be perfectly correct while nothing calls it. The
 * inline `state.reviewItems.filter((i) => i.taskId === task.id)` that used to
 * sit here is what fed ticket-borne rows — which carry no `threadId` — into a
 * panel whose option buttons answer by posting a comment on one.
 *
 * Paired with a positive control in the same read, so a mistyped path or an
 * empty file cannot read as a clean result.
 */
describe('the detail panel takes its asks through panelAsks', () => {
  const hubApp = readFileSync(resolve(import.meta.dirname, '../src/hub/hub-app.ts'), 'utf8');

  it('calls panelAsks and no longer filters reviewItems by taskId inline', () => {
    // Positive control: the read found the real file.
    expect(hubApp).toContain('state.reviewItems');
    expect(hubApp).toContain('panelAsks(state.reviewItems, task.id)');
    expect(hubApp).not.toContain('state.reviewItems.filter');
  });
});
