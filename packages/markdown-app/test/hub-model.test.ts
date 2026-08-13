import { describe, expect, it } from 'vitest';
import {
  type ActivityEvent,
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  TASK_STATUS_ORDER,
  type UptimeReport,
  activityRows,
  boardSections,
  decisionRows,
  describeEvent,
  doneAt,
  presenceChips,
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
