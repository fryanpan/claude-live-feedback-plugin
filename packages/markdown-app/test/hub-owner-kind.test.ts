/**
 * The board distinguishes a person's task from an agent's once the owner has
 * a NAME — the thing it could not do while ownership was the literal `human`.
 *
 * Two layers: the model's predicate and band (`ownedByPerson`,
 * `humanBlockerRows`), and the row the board actually draws, because a
 * distinction nobody renders is not a feature. Each pair is asserted on ONE
 * render so the person case and the agent case are compared against each
 * other rather than against separate runs.
 *
 * All fixtures are synthetic — invented names, invented agent ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  assignedToHuman,
  boardSections,
  humanBlockerRows,
  ownedByPerson,
  ownerKind,
  reviewQueue,
  taskVisible,
} from '../src/hub/hub-model.ts';
import { type BoardHandlers, renderBoard } from '../src/hub/hub-render.ts';

const NOW = 1_700_000_000_000;

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
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const GOALS: HubGoal[] = [{ id: 'g-pr', title: '1. Get the atlas out' }];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Ada Fenwick',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

function handlers(over: Partial<BoardHandlers> = {}): BoardHandlers {
  return {
    onStatusSet: vi.fn(),
    onGoalTitleCommit: vi.fn(),
    onOpenTask: vi.fn(),
    onReorder: vi.fn(),
    onTitleCommit: vi.fn(),
    onAssign: vi.fn(),
    inlineTitleEdit: () => true,
    ...over,
  };
}

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});

describe('ownerKind', () => {
  it('reads an absent field as unknown, never as a person', () => {
    // The server omits the key for a caller that could not know. Reading that
    // as the benign value is how a whole population goes invisible.
    expect(ownerKind(task({ assignee: 'Ada Fenwick' }))).toBe('unknown');
    expect(ownedByPerson(task({ assignee: 'Ada Fenwick' }))).toBe(false);
  });

  it('separates "a person owns it" from "it is in the unnamed-person bucket"', () => {
    const named = task({ assignee: 'Ada Fenwick', ownerKind: 'person' });
    const unnamed = task({ assignee: 'human', ownerKind: 'person' });
    expect(ownedByPerson(named)).toBe(true);
    expect(ownedByPerson(unnamed)).toBe(true);
    // …and My Tasks stays the viewer's own queue. Widening this one would
    // file somebody ELSE's task under the reader's tab.
    expect(assignedToHuman(unnamed)).toBe(true);
    expect(assignedToHuman(named)).toBe(false);
    const other = task({ assignee: 'Rowan Iles', ownerKind: 'person' });
    expect(taskVisible(other, { ...filters, tab: 'mine' })).toBe(false);
    // Positive control for that absence: the reader's OWN named task is in.
    expect(
      taskVisible(task({ assignee: 'Ada Fenwick', ownerKind: 'person' }), {
        ...filters,
        tab: 'mine',
      }),
    ).toBe(true);
  });
});

describe('humanBlockerRows', () => {
  it('bands a named person’s blocker and not a named agent’s, on one pass', () => {
    const person = task({ id: 't-person', assignee: 'Ada Fenwick', ownerKind: 'person' });
    const agent = task({ id: 't-agent', assignee: 'Cartographer', ownerKind: 'agent' });
    const undeclared = task({ id: 't-undeclared', assignee: 'Rowan Iles' });
    const waiters = [
      task({ after: ['t-person'] }),
      task({ after: ['t-agent'] }),
      task({ after: ['t-undeclared'] }),
    ];
    const rows = humanBlockerRows([person, agent, undeclared, ...waiters]);
    const ids = rows.map((r) => r.task.id);
    // The fix: a person named by NAME is in the band…
    expect(ids).toContain('t-person');
    // …and the two absences are read on the same list, so "contains nothing"
    // cannot be what makes them pass.
    expect(ids).not.toContain('t-agent');
    expect(ids).not.toContain('t-undeclared');
  });

  it('does not sweep in an agent whose display name is also the viewer’s', () => {
    // The rejected fix — matching the VIEWER's name — passes every other
    // assertion in this file and fails here: `filters.userName` is
    // 'Ada Fenwick', and an agent called that would drag its blockers into
    // the strip built to stay short. The queue takes no viewer at all, which
    // is what keeps the count at the top of the board one number.
    const tasks = [
      task({ id: 't-twin', assignee: 'Ada Fenwick', ownerKind: 'agent' }),
      task({ after: ['t-twin'] }),
      task({ id: 't-person', assignee: 'Rowan Iles', ownerKind: 'person' }),
      task({ after: ['t-person'] }),
    ];
    const ids = humanBlockerRows(tasks).map((r) => r.task.id);
    expect(ids).not.toContain('t-twin');
    // Positive control on the same list: the band is finding something.
    expect(ids).toContain('t-person');
    expect(reviewQueue(tasks, [], NOW).blocking).toBe(1);
  });
});

describe('the owner mark on a board row', () => {
  function marks(tasks: HubTask[]): { cls: string; label: string }[] {
    renderBoard(root, boardSections(GOALS, tasks, filters), handlers());
    return Array.from(root.querySelectorAll('.hub-task-row')).map((row) => ({
      cls: (row.querySelector('.hub-owner-avatar') as HTMLElement).className,
      label: (row.querySelector('.hub-row-assignee') as HTMLElement).getAttribute('aria-label') ?? '',
    }));
  }

  it('draws a named person differently from a named agent', () => {
    const [person, agent] = marks([
      task({ goal: 'g-pr', order: 1, assignee: 'Ada Fenwick', ownerKind: 'person' }),
      task({ goal: 'g-pr', order: 2, assignee: 'Cartographer', ownerKind: 'agent' }),
    ]);
    // Both rows rendered — the positive control for the inequality below.
    expect(person?.cls).toContain('hub-owner-avatar');
    expect(agent?.cls).toContain('hub-owner-avatar');
    expect(person?.cls).toContain('hub-owner-human');
    expect(agent?.cls).toContain('hub-owner-agent');
    expect(person?.cls).not.toContain('hub-owner-agent');
  });

  it('gives an undeclared owner its own mark, not the agent one', () => {
    const [undeclared, agent, unassigned] = marks([
      task({ goal: 'g-pr', order: 1, assignee: 'Rowan Iles' }),
      task({ goal: 'g-pr', order: 2, assignee: 'Cartographer', ownerKind: 'agent' }),
      task({ goal: 'g-pr', order: 3, assignee: 'agent' }),
    ]);
    expect(undeclared?.cls).toContain('hub-owner-unknown');
    expect(undeclared?.cls).not.toContain('hub-owner-agent');
    // Distinct from "nobody has this", which is a different question.
    expect(unassigned?.cls).toContain('hub-owner-none');
    expect(agent?.cls).toContain('hub-owner-agent');
  });

  it('says which kind in words, since colour alone is not a distinction', () => {
    const [person, agent, undeclared] = marks([
      task({ goal: 'g-pr', order: 1, assignee: 'Ada Fenwick', ownerKind: 'person' }),
      task({ goal: 'g-pr', order: 2, assignee: 'Cartographer', ownerKind: 'agent' }),
      task({ goal: 'g-pr', order: 3, assignee: 'Rowan Iles' }),
    ]);
    expect(person?.label).toContain('Ada Fenwick (person)');
    expect(agent?.label).toContain('Cartographer (agent)');
    expect(undeclared?.label).toContain('not recorded');
  });
});
