import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_GROUP_CAP,
  ACTIVITY_NOTE_CAP,
  ACTIVITY_WINDOW_MS,
  type ActivityGroup,
  DARK_AFTER_MS,
  asksOf,
  homeActivity,
} from '../src/hub/activity-model.ts';
import {
  CHORES_ID,
  type HubGoal,
  type HubNote,
  type HubTask,
  type ReviewItem,
} from '../src/hub/hub-model.ts';

/** All fixtures are synthetic — invented agents, short fake ids. */

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'in-progress',
    assignee: 'Quick Build',
    goal: 'g-pr',
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW - 3 * HOUR,
    updatedAt: NOW - 3 * HOUR,
    ...overrides,
  };
}

function note(agoMs: number, text: string, overrides: Partial<HubNote> = {}): HubNote {
  return { at: NOW - agoMs, kind: 'turn', text, agent: 'Quick Build', ...overrides };
}

const GOALS: HubGoal[] = [
  { id: 'g-pr', title: '1. Get the PR out', subgoals: [{ id: 'g-pr-sub', title: '1.1 Tickets' }] },
  { id: 'g-blog', title: '2. Blog post' },
  { id: 'g-old', title: '3. Shipped', status: 'done' },
];

function groups(tasks: HubTask[], extra: Partial<Parameters<typeof homeActivity>[0]> = {}) {
  return homeActivity({ tasks, goals: GOALS, now: NOW, ...extra });
}

describe('homeActivity', () => {
  it('returns nothing for no tasks, and nothing for tasks with no notes or transitions', () => {
    expect(groups([])).toEqual([]);
    expect(groups([task(), task({ notes: [] })])).toEqual([]);
  });

  it('groups by task, newest activity first, each group holding its notes newest first with bare ages', () => {
    const quiet = task({
      id: 't-q',
      title: 'Quiet one',
      notes: [note(2 * HOUR, 'Opened PR, CI running')],
    });
    const busy = task({
      id: 't-b',
      title: 'Busy one',
      notes: [note(4 * MIN, 'CSV writer done'), note(8 * MIN, 'Picked this up')],
    });
    const out = groups([quiet, busy]);
    expect(out.map((g) => g.taskId)).toEqual(['t-b', 't-q']);
    const busyGroup = out[0] as ActivityGroup;
    expect(busyGroup.title).toBe('Busy one');
    expect(busyGroup.status).toBe('in-progress');
    expect(busyGroup.flag).toBeUndefined();
    expect(busyGroup.more).toBe(0);
    expect(busyGroup.notes.map((n) => [n.text, n.age, n.agent, n.kind])).toEqual([
      ['CSV writer done', '4m', 'Quick Build', 'turn'],
      ['Picked this up', '8m', 'Quick Build', 'turn'],
    ]);
    expect(out[1]?.notes[0]?.age).toBe('2h');
  });

  it('sorts notes newest first even when the projection hands them in another order', () => {
    const t = task({ notes: [note(30 * MIN, 'older'), note(5 * MIN, 'newer')] });
    expect(groups([t])[0]?.notes.map((n) => n.text)).toEqual(['newer', 'older']);
  });

  it('shows at most three notes and counts the rest as more', () => {
    expect(ACTIVITY_NOTE_CAP).toBe(3);
    const t = task({
      notes: [
        note(1 * MIN, 'a'),
        note(2 * MIN, 'b'),
        note(3 * MIN, 'c'),
        note(4 * MIN, 'd'),
        note(5 * MIN, 'e'),
      ],
    });
    const g = groups([t])[0] as ActivityGroup;
    expect(g.notes.map((n) => n.text)).toEqual(['a', 'b', 'c']);
    expect(g.more).toBe(2);
  });

  it('keeps only activity from the last 24h, and drops a task with nothing inside the window', () => {
    expect(ACTIVITY_WINDOW_MS).toBe(24 * HOUR);
    const fresh = task({ notes: [note(1 * HOUR, 'recent'), note(25 * HOUR, 'yesterday')] });
    const old = task({ notes: [note(26 * HOUR, 'long ago')] });
    const out = groups([fresh, old]);
    expect(out.map((g) => g.taskId)).toEqual([fresh.id]);
    expect(out[0]?.notes.map((n) => n.text)).toEqual(['recent']);
    expect(out[0]?.more).toBe(0);
  });

  it('caps the pane at eight groups, keeping the eight with the newest activity', () => {
    expect(ACTIVITY_GROUP_CAP).toBe(8);
    const tasks = Array.from({ length: 10 }, (_, i) =>
      task({ id: `t-n${i}`, notes: [note((i + 1) * MIN, `note ${i}`)] }),
    );
    const out = groups(tasks);
    expect(out).toHaveLength(8);
    expect(out.map((g) => g.taskId)).toEqual(tasks.slice(0, 8).map((t) => t.id));
  });

  it('leaves archived tasks out entirely', () => {
    const t = task({ archivedAt: NOW - MIN, notes: [note(2 * MIN, 'gone')] });
    expect(groups([t])).toEqual([]);
  });

  describe('flags', () => {
    it('off-band: the task sits in Backlog, under no goal, or under a done goal', () => {
      const backlog = task({ goal: CHORES_ID, status: 'todo', notes: [note(MIN, 'x')] });
      const orphan = task({ goal: 'g-missing', status: 'todo', notes: [note(MIN, 'x')] });
      const shipped = task({ goal: 'g-old', status: 'todo', notes: [note(MIN, 'x')] });
      const inBand = task({ goal: 'g-pr', status: 'todo', notes: [note(MIN, 'x')] });
      const inSub = task({ goal: 'g-pr-sub', status: 'todo', notes: [note(MIN, 'x')] });
      const flagOf = (t: HubTask) => groups([t])[0]?.flag;
      expect(flagOf(backlog)).toBe('off-band');
      expect(flagOf(orphan)).toBe('off-band');
      expect(flagOf(shipped)).toBe('off-band');
      expect(flagOf(inBand)).toBeUndefined();
      expect(flagOf(inSub)).toBeUndefined();
    });

    it('stale: the newest note text repeats three times in a row', () => {
      const stale = task({
        status: 'todo',
        notes: [
          note(1 * MIN, 'Still waiting on login'),
          note(2 * MIN, 'still waiting on login '),
          note(3 * MIN, 'Still waiting on login'),
          note(4 * MIN, 'Migrated the cache'),
        ],
      });
      const twice = task({
        status: 'todo',
        notes: [
          note(1 * MIN, 'Still waiting'),
          note(2 * MIN, 'Still waiting'),
          note(3 * MIN, 'Moving'),
        ],
      });
      const brokenRun = task({
        status: 'todo',
        notes: [
          note(1 * MIN, 'New thing'),
          note(2 * MIN, 'Still waiting'),
          note(3 * MIN, 'Still waiting'),
          note(4 * MIN, 'Still waiting'),
        ],
      });
      expect(groups([stale])[0]?.flag).toBe('stale');
      expect(groups([twice])[0]?.flag).toBeUndefined();
      expect(groups([brokenRun])[0]?.flag).toBeUndefined();
    });

    it('stale reads the notes only — a status move between repeats does not break the run', () => {
      const t = task({
        status: 'todo',
        notes: [note(1 * MIN, 'same'), note(3 * MIN, 'same'), note(5 * MIN, 'same')],
        transitions: [
          {
            ts: NOW - 2 * MIN,
            from: 'in-progress',
            to: 'todo',
            by: { name: 'Quick Build', kind: 'agent' },
          },
        ],
      });
      expect(groups([t])[0]?.flag).toBe('stale');
    });

    it('dark: in-progress with no note or transition for 45 minutes', () => {
      expect(DARK_AFTER_MS).toBe(45 * MIN);
      const dark = task({ status: 'in-progress', notes: [note(50 * MIN, 'x')] });
      const alive = task({ status: 'in-progress', notes: [note(30 * MIN, 'x')] });
      const movedRecently = task({
        status: 'in-progress',
        notes: [note(50 * MIN, 'x')],
        transitions: [
          {
            ts: NOW - 10 * MIN,
            from: 'todo',
            to: 'in-progress',
            by: { name: 'Jordan', kind: 'person' },
          },
        ],
      });
      const notInProgress = task({ status: 'todo', notes: [note(50 * MIN, 'x')] });
      expect(groups([dark])[0]?.flag).toBe('dark');
      expect(groups([alive])[0]?.flag).toBeUndefined();
      expect(groups([movedRecently])[0]?.flag).toBeUndefined();
      expect(groups([notInProgress])[0]?.flag).toBeUndefined();
    });

    it('shows one flag: dark beats stale beats off-band', () => {
      const all = task({
        status: 'in-progress',
        goal: CHORES_ID,
        notes: [note(50 * MIN, 'same'), note(51 * MIN, 'same'), note(52 * MIN, 'same')],
      });
      const staleOffBand = task({
        status: 'todo',
        goal: CHORES_ID,
        notes: [note(1 * MIN, 'same'), note(2 * MIN, 'same'), note(3 * MIN, 'same')],
      });
      expect(groups([all])[0]?.flag).toBe('dark');
      expect(groups([staleOffBand])[0]?.flag).toBe('stale');
    });
  });

  describe('note kinds', () => {
    it('renders a transition as a move line, and one that put the task in another holder’s hands as a hand-off', () => {
      const t = task({
        assignee: 'Bike Map',
        notes: [note(20 * MIN, 'Picked this up', { agent: 'Bike Map' })],
        transitions: [
          {
            ts: NOW - 30 * MIN,
            from: 'triage',
            to: 'todo',
            by: { name: 'Jordan', kind: 'person' },
          },
          {
            ts: NOW - 25 * MIN,
            from: 'todo',
            to: 'in-progress',
            by: { name: 'Team Lead', kind: 'agent' },
          },
          {
            ts: NOW - 5 * MIN,
            from: 'in-progress',
            to: 'done',
            by: { name: 'Bike Map', kind: 'agent' },
          },
        ],
      });
      const g = groups([t])[0] as ActivityGroup;
      expect(g.notes.map((n) => [n.text, n.kind, n.agent])).toEqual([
        ['→ done', 'move', 'Bike Map'],
        ['Picked this up', 'turn', 'Bike Map'],
        ['handed to Bike Map', 'move', 'Team Lead'],
      ]);
      expect(g.more).toBe(1);
    });

    it('a holder moving their own task to in-progress is a move, not a hand-off', () => {
      const t = task({
        assignee: 'Quick Build',
        transitions: [
          {
            ts: NOW - 5 * MIN,
            from: 'todo',
            to: 'in-progress',
            by: { name: 'Quick Build', kind: 'agent' },
          },
        ],
      });
      expect(groups([t])[0]?.notes.map((n) => n.text)).toEqual(['→ in-progress']);
    });

    it('a task with only transitions still shows as movement', () => {
      const t = task({
        notes: undefined,
        transitions: [
          {
            ts: NOW - 5 * MIN,
            from: 'todo',
            to: 'in-progress',
            by: { name: 'Quick Build', kind: 'agent' },
          },
        ],
      });
      expect(groups([t]).map((g) => g.taskId)).toEqual([t.id]);
    });

    it('prefixes a denial with blocked:', () => {
      const t = task({
        notes: [note(12 * MIN, 'git rm in this repo', { kind: 'denial', agent: 'Bike Map' })],
      });
      const n = groups([t])[0]?.notes[0];
      expect(n?.text).toBe('blocked: git rm in this repo');
      expect(n?.kind).toBe('denial');
      expect(n?.agent).toBe('Bike Map');
    });
  });

  describe('the review queue above', () => {
    it('never repeats an ask that is already in the queue, but keeps the task', () => {
      const t = task({
        id: 't-ask',
        notes: [
          note(1 * MIN, 'Which tile host should I use?'),
          note(9 * MIN, 'Migrated the photo cache'),
        ],
      });
      const other = task({ id: 't-oth', notes: [note(2 * MIN, 'Which tile host should I use?')] });
      const out = groups([t, other], {
        asks: [{ taskId: 't-ask', text: 'Which tile host should I use?' }],
      });
      expect(out.map((g) => g.taskId)).toEqual(['t-oth', 't-ask']);
      expect(out[1]?.notes.map((n) => n.text)).toEqual(['Migrated the photo cache']);
      expect(out[0]?.notes.map((n) => n.text)).toEqual(['Which tile host should I use?']);
    });

    it('drops the task when the queued ask was its only activity', () => {
      const t = task({ id: 't-ask', notes: [note(1 * MIN, 'Which tile host?')] });
      expect(groups([t], { asks: [{ taskId: 't-ask', text: 'Which tile host?' }] })).toEqual([]);
    });
  });
});

describe('asksOf', () => {
  const base = { key: 'k', kind: 'task-thread' as const, why: '', since: NOW };
  it('reduces queue rows to the task each is about and the line the row shows', () => {
    const t = task({ id: 't-dec', title: 'Pick a cache' });
    const items: ReviewItem[] = [
      {
        ...base,
        key: 'k1',
        kind: 'decision',
        title: 'Pick a cache',
        ask: '',
        decision: { task: t, blocks: [], hard: false },
      },
      {
        ...base,
        key: 'k2',
        title: 'Some task',
        ask: 'Which cache do we keep?',
        thread: {
          kind: 'task-thread',
          band: 'declared',
          docId: 'task:t-th',
          threadId: 'th-1',
          taskId: 't-th',
          title: 'Some task',
          ask: 'Which cache do we keep?',
          askedBy: 'Helper',
          since: NOW,
          direct: true,
        },
      },
      {
        ...base,
        key: 'k3',
        kind: 'doc-thread',
        title: 'A doc',
        ask: 'Does this cover tables?',
        thread: {
          kind: 'doc-thread',
          band: 'declared',
          docId: 'd-1',
          threadId: 'th-2',
          title: 'A doc',
          ask: 'Does this cover tables?',
          askedBy: 'Helper',
          since: NOW,
          direct: true,
        },
      },
    ];
    expect(asksOf(items)).toEqual([
      { taskId: 't-dec', text: 'Pick a cache' },
      { taskId: 't-th', text: 'Which cache do we keep?' },
    ]);
  });
});
