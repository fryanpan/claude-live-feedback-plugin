import { afterEach, describe, expect, it } from 'vitest';
import {
  type HubTask,
  archivedTasks,
  boardSections,
  describeEvent,
  isTaskArchived,
  taskVisible,
} from '../src/hub/hub-model.ts';
import {
  type ArchivedViewHandlers,
  type DetailHandlers,
  renderArchivedList,
} from '../src/hub/hub-render.ts';
import { disposeBoards, renderBoard } from './support/board.ts';
import { renderTaskDetail } from './support/task-detail.ts';

// The board is a mounted island now, not a call that returns; every mount
// holds a live subscription to the module-level signal until it is disposed.
afterEach(disposeBoards);

/**
 * The browser half of archiving a task.
 *
 * The server hides archived rows from every LISTING; the projection
 * deliberately does not hide them from the BOARD STATE, because the Undo
 * toast, the "N archived" count and the restore list all read the same
 * projected rows the lanes do. So the browser is where "off the board" is
 * actually decided, and these tests pin that in both directions — an archived
 * row leaves the lanes, and a restored one comes back — because a filter that
 * only ever hides is a board that has silently lost work.
 *
 * Fixtures are synthetic.
 */

function task(over: Partial<HubTask> = {}): HubTask {
  return {
    id: 't1',
    title: 'Wire the index',
    status: 'todo',
    assignee: 'Search Revamp',
    goal: 'g1',
    order: 1,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: 'task:t1',
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

const FILTERS = { tab: 'all' as const, userName: 'Bryan', doneWindow: 'all' as const, now: 1000 };
const GOALS = [{ id: 'g1', title: '1. Ship it' }];

describe('archived rows and the board', () => {
  it('isTaskArchived reads the stamp, and asks nothing about the clock', () => {
    expect(isTaskArchived(task())).toBe(false);
    expect(isTaskArchived(task({ archivedAt: 500 }))).toBe(true);
    // A park expires; an archive does not. A stamp far in the past is still
    // archived, which is the difference from `isTaskParked`.
    expect(isTaskArchived(task({ archivedAt: 1 }))).toBe(true);
  });

  it('taskVisible drops an archived row and keeps an ordinary one', () => {
    expect(taskVisible(task({ archivedAt: 500 }), FILTERS)).toBe(false);
    expect(taskVisible(task(), FILTERS)).toBe(true); // positive control
  });

  it('an archived row leaves its lane, and a restore puts it back', () => {
    const live = task({ id: 't-live', title: 'Still here' });
    const gone = task({ id: 't-gone', title: 'Archived', archivedAt: 500 });
    const withArchived = boardSections(GOALS, [live, gone], FILTERS);
    const ids = withArchived.flatMap((s) => s.tasks.map((t) => t.id));
    expect(ids).toContain('t-live');
    expect(ids).not.toContain('t-gone');

    // The same row with the stamp cleared — which is exactly what the server
    // projects after a restore, since the refresh deletes absent keys.
    const restored = task({ id: 't-gone', title: 'Archived' });
    const after = boardSections(GOALS, [live, restored], FILTERS);
    expect(after.flatMap((s) => s.tasks.map((t) => t.id))).toContain('t-gone');
  });

  it('archivedTasks lists only archived rows, newest removal first', () => {
    const rows = archivedTasks([
      task({ id: 'a', archivedAt: 100 }),
      task({ id: 'b' }),
      task({ id: 'c', archivedAt: 900 }),
    ]);
    expect(rows.map((t) => t.id)).toEqual(['c', 'a']);
  });

  it('the trail says who archived what, and why', () => {
    const line = describeEvent(
      {
        event: 'task.archived',
        taskId: 't1',
        title: 'Wire the index',
        reason: 'duplicate of the index row',
        actor: { name: 'Bryan', kind: 'person' },
        ts: 1,
      } as unknown as Parameters<typeof describeEvent>[0],
      () => 'unused',
    );
    expect(line).toBe('Bryan archived “Wire the index” — duplicate of the index row');
    const back = describeEvent(
      {
        event: 'task.restored',
        taskId: 't1',
        title: 'Wire the index',
        actor: { name: 'Bryan', kind: 'person' },
        ts: 2,
      } as unknown as Parameters<typeof describeEvent>[0],
      () => 'unused',
    );
    expect(back).toBe('Bryan restored “Wire the index”');
  });
});

describe('the board meta line', () => {
  const handlers = {
    onStatusSet: () => {},
    onGoalTitleCommit: () => {},
    onOpenTask: () => {},
    onReorder: () => {},
    onTitleCommit: () => {},
    onAssign: () => {},
  };

  it('draws the archived count and opens the list', () => {
    const el = document.createElement('div');
    let opened = 0;
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 3,
      onShowArchived: () => {
        opened += 1;
      },
    });
    const link = el.querySelector<HTMLButtonElement>('.hub-board-meta-archived');
    expect(link?.textContent).toBe('3 archived');
    link?.click();
    expect(opened).toBe(1);
  });

  it('draws nothing at all when the board has archived nothing', () => {
    const el = document.createElement('div');
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 0,
      onShowArchived: () => {},
    });
    expect(el.querySelector('.hub-board-meta')).toBeNull();
    // Positive control: the same call with a count DOES draw one.
    renderBoard(el, boardSections(GOALS, [task()], FILTERS), {
      ...handlers,
      archivedCount: 1,
      onShowArchived: () => {},
    });
    expect(el.querySelector('.hub-board-meta')).not.toBeNull();
  });
});

describe('the restore list', () => {
  function fixture(tasks: HubTask[]) {
    const el = document.createElement('div');
    const restored: string[] = [];
    const opened: string[] = [];
    let back = 0;
    const handlers: ArchivedViewHandlers = {
      onRestore: (t) => restored.push(t.id),
      onOpenTask: (t) => opened.push(t.id),
      onBack: () => {
        back += 1;
      },
    };
    renderArchivedList(el, tasks, handlers);
    return { el, restored, opened, backCount: () => back };
  }

  it('draws one row per archived task, with who and why, and restores it', () => {
    const { el, restored } = fixture([
      task({ id: 't-a', title: 'Duplicate row', archivedAt: 900, archivedBy: 'Bryan' }),
    ]);
    const row = el.querySelector<HTMLElement>('.hub-archived-row');
    expect(row?.dataset.taskId).toBe('t-a');
    expect(el.querySelector('.hub-archived-title')?.textContent).toBe('Duplicate row');
    expect(el.querySelector('.hub-archived-why')?.textContent).toContain('by Bryan');
    el.querySelector<HTMLButtonElement>('.hub-archived-restore')?.click();
    expect(restored).toEqual(['t-a']);
  });

  it('shows the reason when there is one', () => {
    const { el } = fixture([
      task({ id: 't-a', archivedAt: 900, archivedBy: 'Bryan', archiveReason: 'not doing this' }),
    ]);
    expect(el.querySelector('.hub-archived-why')?.textContent).toContain('not doing this');
  });

  it('says so when nothing is archived, rather than rendering an empty list', () => {
    const { el } = fixture([]);
    expect(el.querySelector('.hub-archived-list')).toBeNull();
    expect(el.querySelector('.hub-section-empty')?.textContent).toContain('Nothing archived');
  });

  it('offers the way back to the board', () => {
    const { el, backCount } = fixture([task({ id: 't-a', archivedAt: 900 })]);
    el.querySelector<HTMLButtonElement>('.hub-archived-back')?.click();
    expect(backCount()).toBe(1);
  });
});

describe('the detail panel', () => {
  const base: DetailHandlers = {
    onClose: () => {},
    onStatusSet: () => {},
    onTitleCommit: () => {},
    onAnswer: () => undefined,
    onAssign: () => {},
  };

  function render(t: HubTask, over: Partial<DetailHandlers>): HTMLElement {
    const el = document.createElement('div');
    renderTaskDetail(el, t, { ...base, ...over });
    return el;
  }

  it('puts Archive in the head actions of a live task', () => {
    const el = render(task(), { onArchive: () => {} });
    const btn = el.querySelector<HTMLButtonElement>('.hub-detail-head-actions .hub-detail-archive');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toContain('Archive');
  });

  it('the head button archives the task it is drawn for', () => {
    const archived: string[] = [];
    const el = render(task({ id: 't-x' }), { onArchive: (t) => archived.push(t.id) });
    el.querySelector<HTMLButtonElement>('.hub-detail-archive')?.click();
    expect(archived).toEqual(['t-x']);
  });

  it('an archived task gets Restore instead, plus a note saying who and why', () => {
    const restored: string[] = [];
    const el = render(
      task({ id: 't-x', archivedAt: 900, archivedBy: 'Bryan', archiveReason: 'obsolete' }),
      { onArchive: () => {}, onRestore: (t) => restored.push(t.id) },
    );
    const head = el.querySelector<HTMLButtonElement>('.hub-detail-archive');
    expect(head?.getAttribute('aria-label')).toContain('Restore');
    const note = el.querySelector<HTMLElement>('.hub-archived-note');
    expect(note?.textContent).toContain('Bryan');
    expect(note?.textContent).toContain('obsolete');
    note?.querySelector<HTMLButtonElement>('.hub-archived-restore')?.click();
    expect(restored).toEqual(['t-x']);
  });

  it('draws no archived note on a live task', () => {
    const el = render(task(), { onArchive: () => {} });
    expect(el.querySelector('.hub-archived-note')).toBeNull();
  });

  it('draws no archive control at all when the caller passes no handler', () => {
    const el = render(task(), {});
    expect(el.querySelector('.hub-detail-archive')).toBeNull();
    // Positive control: the close button is there either way, so the query
    // above is looking at a panel that really rendered.
    expect(el.querySelector('.hub-detail-close')).not.toBeNull();
  });
});
