import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archiveConfirmLine } from '../src/hub/goal-detail-island.tsx';
import {
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  archivedGoals,
  boardSections,
  cascadePhrase,
  describeEvent,
  goalSection,
  isGoalArchived,
} from '../src/hub/hub-model.ts';
import { type GoalDetailHandlers, renderArchivedList } from '../src/hub/hub-render.ts';
import { GOAL_PLACEHOLDER_TEXT, PLACEHOLDER_TEXT } from '../src/hub/task-body-editor.ts';
import { disposeGoalDetail, renderGoalDetail } from './support/goal-detail.ts';

/**
 * A goal's extra actions — the ones a task row has had all along.
 *
 * Bryan by voice at the hub, 2026-08-29: *"add to the core flow that goals
 * should have the same additional extra actions that tasks do like being able
 * to Archive get a link and so on"*. The task panel's head carries copy-link,
 * full-screen and archive/restore; the goal panel's carried a close button and
 * nothing else, which made a goal the one row on the board whose menu was
 * short.
 *
 * Archive is the one that is not simply the task panel's control moved across.
 * It takes the band's tasks with it (Bryan, 2026-08-30), so it asks first —
 * and the ask has to carry the COUNT, because the blast radius is exactly the
 * part a reader cannot see from a band header. Most of this file is about that
 * sentence and about the panel refusing to commit without it.
 *
 * All fixtures are synthetic. The repo is public.
 */

const NOW = 1_700_000_000_000;

const filters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
} as const;

let seq = 0;
function task(over: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: 'g-pr',
    order: seq,
    after: [],
    links: [],
    transitions: [],
    bodyDocId: `task:t-${seq}`,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function handlers(over: Partial<GoalDetailHandlers> = {}): GoalDetailHandlers {
  return {
    onClose: vi.fn(),
    onTitleCommit: vi.fn(),
    onStatusSet: vi.fn(),
    ...over,
  };
}

function sectionOf(goal: Partial<HubGoal> & { id: string; title: string }) {
  const found = goalSection([goal as HubGoal], goal.id);
  if (!found) throw new Error('no section');
  return found;
}

describe('the sentence a goal archive asks before it commits', () => {
  it('names the number of tasks going with the band', () => {
    expect(archiveConfirmLine('Ship W3', { tasks: 14 })).toBe(
      'Archive “Ship W3” and its 14 tasks?',
    );
  });

  it('counts one task as one, not as “1 tasks”', () => {
    expect(archiveConfirmLine('Ship W3', { tasks: 1 })).toBe('Archive “Ship W3” and its 1 task?');
  });

  it('says plainly when nothing else goes with it', () => {
    expect(archiveConfirmLine('Ship W3', { tasks: 0 })).toBe(
      'Archive “Ship W3”? Nothing else is under it.',
    );
  });

  it('does not invent a number while the count is still in flight', () => {
    // A title with no digit of its own, so the "no number" half of this is
    // about the count rather than about the band's name.
    const line = archiveConfirmLine('Ship the widget', null);
    expect(line).toBe('Archive “Ship the widget” and everything under it?');
    expect(line).not.toMatch(/\d/);
  });
});

describe('the goal panel’s head actions', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    host.className = 'hub-detail hidden';
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    disposeGoalDetail();
    document.body.className = '';
  });

  const panel = () => {
    const el = host.querySelector('.hub-detail-panel');
    if (!(el instanceof HTMLElement)) throw new Error('no panel');
    return el;
  };
  const button = (cls: string) => panel().querySelector<HTMLButtonElement>(cls);

  it('carries the task panel’s set: copy link, full screen, archive, close', () => {
    renderGoalDetail(
      host,
      sectionOf({ id: 'g-pr', title: '1. Get the PR out' }),
      handlers({ onCopyLink: vi.fn(), onArchive: vi.fn(), onCascadeCount: vi.fn() }),
    );
    expect(button('.hub-detail-share')).not.toBeNull();
    expect(button('.hub-detail-expand')).not.toBeNull();
    expect(button('.hub-detail-archive')).not.toBeNull();
    expect(button('.hub-detail-close')).not.toBeNull();
  });

  it('copies a link to the goal it is open on', () => {
    const onCopyLink = vi.fn();
    const section = sectionOf({ id: 'g-pr', title: '1. Get the PR out' });
    renderGoalDetail(host, section, handlers({ onCopyLink }));
    button('.hub-detail-share')?.click();
    expect(onCopyLink).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-pr' }));
  });

  it('draws no share button when the app wired no handler', () => {
    // An affordance that copies nothing is worse than its absence — the task
    // panel's own rule, and the reason the button is conditional.
    renderGoalDetail(host, sectionOf({ id: 'g-pr', title: '1. Get the PR out' }), handlers());
    expect(button('.hub-detail-share')).toBeNull();
  });

  it('marks the board as full screen and takes it back', () => {
    renderGoalDetail(host, sectionOf({ id: 'g-pr', title: '1. Get the PR out' }), handlers());
    button('.hub-detail-expand')?.click();
    expect(host.classList.contains('hub-detail--full')).toBe(true);
    expect(document.body.classList.contains('hub-detail-full')).toBe(true);
    button('.hub-detail-expand')?.click();
    expect(host.classList.contains('hub-detail--full')).toBe(false);
  });
});

describe('archiving a goal from the panel', () => {
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    host.className = 'hub-detail hidden';
    document.body.replaceChildren(host);
  });

  afterEach(() => {
    disposeGoalDetail();
    document.body.className = '';
  });

  const panel = () => {
    const el = host.querySelector('.hub-detail-panel');
    if (!(el instanceof HTMLElement)) throw new Error('no panel');
    return el;
  };
  const button = (cls: string) => panel().querySelector<HTMLButtonElement>(cls);
  const ask = () => panel().querySelector('.hub-goal-archive-ask')?.textContent ?? '';

  /** A promise the test resolves by hand, so the window between the click and
   *  the answer is a state the assertions can stand in. */
  function deferred<T>() {
    let settle: (v: T) => void = () => {};
    const promise = new Promise<T>((res) => {
      settle = res;
    });
    return { promise, settle };
  }

  it('asks before it writes, and does not write on the icon alone', async () => {
    const onArchive = vi.fn();
    const count = deferred<{ tasks: number } | null>();
    renderGoalDetail(
      host,
      sectionOf({ id: 'g-pr', title: 'Ship W3' }),
      handlers({ onArchive, onCascadeCount: () => count.promise }),
    );
    button('.hub-detail-archive')?.click();
    expect(onArchive).not.toHaveBeenCalled();
    // While the count is in flight the bar is up and honest, and there is
    // nothing to press: a confirmation that cannot say what it is about to do
    // must not offer to do it.
    expect(ask()).toBe('Archive “Ship W3” and everything under it?');
    expect(button('.hub-goal-archive-go')).toBeNull();

    count.settle({ tasks: 14 });
    await count.promise;
    expect(ask()).toBe('Archive “Ship W3” and its 14 tasks?');
    button('.hub-goal-archive-go')?.click();
    expect(onArchive).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-pr' }));
  });

  it('closes the ask on Cancel, having written nothing', async () => {
    const onArchive = vi.fn();
    renderGoalDetail(
      host,
      sectionOf({ id: 'g-pr', title: 'Ship W3' }),
      handlers({ onArchive, onCascadeCount: async () => ({ tasks: 3 }) }),
    );
    button('.hub-detail-archive')?.click();
    await Promise.resolve();
    expect(panel().querySelector('.hub-goal-archive-confirm')).not.toBeNull();
    button('.hub-goal-archive-cancel')?.click();
    expect(panel().querySelector('.hub-goal-archive-confirm')).toBeNull();
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('a count that arrives after Cancel does not reopen the ask', async () => {
    const count = deferred<{ tasks: number } | null>();
    renderGoalDetail(
      host,
      sectionOf({ id: 'g-pr', title: 'Ship W3' }),
      handlers({ onArchive: vi.fn(), onCascadeCount: () => count.promise }),
    );
    button('.hub-detail-archive')?.click();
    button('.hub-goal-archive-cancel')?.click();
    count.settle({ tasks: 14 });
    await count.promise;
    await Promise.resolve();
    expect(panel().querySelector('.hub-goal-archive-confirm')).toBeNull();
  });

  it('offers no Archive when it could not find out what is under the band', async () => {
    renderGoalDetail(
      host,
      sectionOf({ id: 'g-pr', title: 'Ship W3' }),
      handlers({ onArchive: vi.fn(), onCascadeCount: async () => null }),
    );
    button('.hub-detail-archive')?.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(button('.hub-goal-archive-go')).toBeNull();
    const text = panel().querySelector('.hub-goal-archive-ask')?.textContent ?? '';
    expect(text).toContain('Nothing has been archived');
    // And the way out is still there — a dead bar with no Cancel would trap
    // the reader in a question nobody can answer.
    expect(button('.hub-goal-archive-cancel')).not.toBeNull();
  });

  it('shows Restore, and the record of who archived it, on an archived band', () => {
    const onRestore = vi.fn();
    renderGoalDetail(
      host,
      sectionOf({
        id: 'g-pr',
        title: 'Ship W3',
        archivedAt: NOW,
        archivedBy: 'Jordan',
        archiveReason: 'goal moved past',
      }),
      handlers({ onRestore, onArchive: vi.fn(), onCascadeCount: vi.fn() }),
    );
    const note = panel().querySelector('.hub-archived-note');
    expect(note?.textContent).toContain('Jordan');
    expect(note?.textContent).toContain('goal moved past');
    // The head's third control is the other face of the same slot — never
    // both, because an archived band has nothing left to archive.
    const head = button('.hub-detail-archive');
    expect(head?.getAttribute('aria-label')).toBe('Restore this goal to the board');
    head?.click();
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-pr' }));
    expect(panel().querySelector('.hub-goal-archive-confirm')).toBeNull();
  });

  // Every archived band restores on its own now — bands are a flat list, so
  // no goal is ever archived as somebody else's member.
  it('offers restore on any archived band, wherever it sits in the list', () => {
    const onRestore = vi.fn();
    const goals: HubGoal[] = [
      { id: 'g-pr', title: 'Ship the widget' },
      { id: 'g-sub', title: 'Land the diff', archivedAt: NOW },
    ];
    const section = goalSection(goals, 'g-sub');
    if (!section) throw new Error('goalSection lost the archived band');
    renderGoalDetail(host, section, handlers({ onRestore, onCascadeCount: vi.fn() }));
    panel().querySelector<HTMLButtonElement>('.hub-archived-restore')?.click();
    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-sub' }));
  });
});

describe('an archived band on the board', () => {
  const band = (over: Partial<HubGoal> = {}): HubGoal => ({
    id: 'g-pr',
    title: '1. Get the PR out',
    ...over,
  });

  it('leaves the lanes, and every other archived band with it', () => {
    const goals = [
      band({ archivedAt: NOW }),
      band({ id: 'g-sub', title: 'Land the diff', archivedAt: NOW }),
      band({ id: 'g-live', title: '2. Keep it live' }),
    ];
    const ids = boardSections(goals, [], filters).map((s) => s.id);
    expect(ids).not.toContain('g-pr');
    expect(ids).not.toContain('g-sub');
    // The other direction, in the same read: a filter that dropped every band
    // would pass the half above on its own.
    expect(ids).toContain('g-live');
  });

  it('does not take a straggling task down with it', () => {
    // A task restored by hand out of a cascade, or filed under the band after
    // it went. The board must still show it somewhere — a row the store holds
    // and no surface can draw is the bug this rule exists for.
    const goals = [band({ archivedAt: NOW })];
    const sections = boardSections(goals, [task({ goal: 'g-pr' })], filters);
    const backlog = sections.find((s) => s.isChores);
    expect(backlog?.tasks.map((t) => t.goal)).toEqual(['g-pr']);
  });

  it('is still reachable by id, which is where its Restore lives', () => {
    const goals = [band({ archivedAt: NOW, archivedBy: 'Jordan' })];
    expect(boardSections(goals, [], filters).find((s) => s.id === 'g-pr')).toBeUndefined();
    const found = goalSection(goals, 'g-pr');
    if (!found) throw new Error('goalSection lost an archived band');
    expect(found.title).toBe('1. Get the PR out');
    expect(found.archivedBy).toBe('Jordan');
    expect(isGoalArchived(found)).toBe(true);
  });

  it('lists newest removal first, and lists only the archived ones', () => {
    const goals = [
      band({ archivedAt: NOW }),
      band({ id: 'g-old', title: '0. Older', archivedAt: NOW - 1000 }),
      band({ id: 'g-live', title: '2. Keep it live' }),
      band({ id: 'g-newest', title: '3. Newest removal', archivedAt: NOW + 1000 }),
    ];
    expect(archivedGoals(goals).map((g) => g.id)).toEqual(['g-newest', 'g-pr', 'g-old']);
  });

  it('is findable by the lookup a deep link is judged against, archived or not', () => {
    // The boot deadline asks "is this goal still here?" four seconds after
    // the panel opens, and answers with THIS lookup. An ARCHIVED band is on
    // no board at all, so a check written against `boardSections` calls it
    // gone and the panel closes itself with a "nothing matches that link"
    // toast — including for the link the panel's own Copy button hands out.
    const goals = [band({}), band({ id: 'g-gone', title: 'Archived band', archivedAt: NOW })];
    for (const id of ['g-pr', 'g-gone']) {
      expect(goalSection(goals, id)?.id).toBe(id);
    }
    // What a board-shaped check sees: only the live band. Kept as the
    // contrast, because "goalSection finds it" means nothing without it.
    expect(boardSections(goals, [], filters).map((s) => s.id)).not.toContain('g-gone');
    // And it still says no to an id that really is not here — or the fix
    // would just be a lookup that never closes anything.
    expect(goalSection(goals, 'g-never')).toBeNull();
  });
});

describe('the restore list, with bands in it', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.replaceChildren(container);
  });

  const base = {
    onRestore: vi.fn(),
    onOpenTask: vi.fn(),
    onBack: vi.fn(),
  };

  it('draws a band above the tasks, marked as one, and restores it', () => {
    const onRestoreGoal = vi.fn();
    renderArchivedList(
      container,
      [task({ archivedAt: NOW, archivedBy: 'Jordan' })],
      { ...base, onRestoreGoal, onOpenGoal: vi.fn() },
      [{ id: 'g-pr', title: 'Ship W3', archivedAt: NOW, archivedBy: 'Jordan' }],
    );
    const rows = [...container.querySelectorAll('.hub-archived-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.classList.contains('hub-archived-row--goal')).toBe(true);
    expect(rows[0]?.querySelector('.hub-archived-kind')?.textContent).toBe('Goal');
    const restore = rows[0]?.querySelector<HTMLButtonElement>('.hub-archived-restore');
    // The label carries what "Restore" cannot: the tasks come back too.
    expect(restore?.getAttribute('aria-label')).toBe(
      'Restore “Ship W3” and its tasks to the board',
    );
    restore?.click();
    expect(onRestoreGoal).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-pr' }));
  });

  it('counts both kinds in the heading', () => {
    renderArchivedList(
      container,
      [task({ archivedAt: NOW })],
      { ...base, onRestoreGoal: vi.fn(), onOpenGoal: vi.fn() },
      [{ id: 'g-pr', title: 'Ship W3', archivedAt: NOW }],
    );
    expect(container.querySelector('.hub-section-title')?.textContent).toBe(
      '1 archived goal and 1 archived task',
    );
  });

  it('still says “archived tasks” when no band has been archived', () => {
    renderArchivedList(
      container,
      [task({ archivedAt: NOW }), task({ archivedAt: NOW })],
      { ...base, onRestoreGoal: vi.fn(), onOpenGoal: vi.fn() },
      [],
    );
    expect(container.querySelector('.hub-section-title')?.textContent).toBe('2 archived tasks');
  });

  it('counts every archived band in the heading, one row each', () => {
    renderArchivedList(
      container,
      [task({ archivedAt: NOW })],
      { ...base, onRestoreGoal: vi.fn(), onOpenGoal: vi.fn() },
      [
        { id: 'g-pr', title: 'Ship the widget', archivedAt: NOW },
        { id: 'g-sub', title: 'Land the diff', archivedAt: NOW },
      ],
    );
    expect(container.querySelector('.hub-section-title')?.textContent).toBe(
      '2 archived goals and 1 archived task',
    );
    // The heading and the list cannot disagree: every counted band is listed.
    expect(container.querySelectorAll('.hub-archived-row--goal')).toHaveLength(2);
  });

  it('draws no band when the caller wired no way to restore one', () => {
    renderArchivedList(container, [], base, [{ id: 'g-pr', title: 'Ship W3', archivedAt: NOW }]);
    expect(container.querySelector('.hub-archived-row--goal')).toBeNull();
    expect(container.querySelector('.hub-section-empty')).not.toBeNull();
  });
});

describe('one phrase for one archive, wherever it is described', () => {
  it('builds the same words the confirmation and the toast both use', () => {
    expect(cascadePhrase(5)).toBe('5 tasks');
    expect(cascadePhrase(1)).toBe('1 task');
    // Empty rather than a stray "and": the caller asks "is there anything to
    // name" by testing the string.
    expect(cascadePhrase(0)).toBe('');
  });

  it('is the phrase the confirmation asks with, so the toast cannot drift from it', () => {
    expect(archiveConfirmLine('Ship the widget', { tasks: 5 })).toBe(
      `Archive “Ship the widget” and its ${cascadePhrase(5)}?`,
    );
  });

  it('counts every archived band, and only the archived ones', () => {
    const goals: HubGoal[] = [
      { id: 'g-pr', title: '1. Get the PR out', archivedAt: NOW },
      { id: 'g-sub', title: 'Land the diff', archivedAt: NOW },
      { id: 'g-live', title: '2. Keep it live' },
    ];
    // Both are off the board, and both are restorable on their own.
    expect(archivedGoals(goals).map((g) => g.id)).toEqual(['g-pr', 'g-sub']);
  });
});

describe('what the empty description asks for', () => {
  it('asks a goal about the goal, in one line', () => {
    // Two things at once. The wording: the goal panel invited people to
    // "describe the task". And the length: Tiptap floats the placeholder with
    // `height: 0`, so it paints OUTSIDE the slot instead of growing it — at
    // 430px the task wording wraps to a second line and strikes through
    // "Open in the full editor" underneath (measured: slot clips at 41px,
    // content runs to 58px). Staying shorter than the task's is what keeps it
    // to one line there.
    expect(GOAL_PLACEHOLDER_TEXT).toContain('goal');
    expect(GOAL_PLACEHOLDER_TEXT).not.toContain('task');
    expect(GOAL_PLACEHOLDER_TEXT.length).toBeLessThan(PLACEHOLDER_TEXT.length);
  });
});

describe('the activity line for a band’s archive', () => {
  const titleOf = () => 'unused';

  it('says what went with it', () => {
    expect(
      describeEvent(
        {
          id: 'e1',
          ts: NOW,
          event: 'task.archived',
          taskId: 'g-pr',
          kind: 'goal',
          title: 'Ship W3',
          cascadeTasks: 14,
          actor: { name: 'Jordan', kind: 'person' },
        } as never,
        titleOf,
      ),
    ).toBe('Jordan archived “Ship W3”, with its 14 tasks');
  });

  it('leaves an ordinary task archive exactly as it was', () => {
    expect(
      describeEvent(
        {
          id: 'e2',
          ts: NOW,
          event: 'task.archived',
          taskId: 't-1',
          title: 'Wire the index',
          reason: 'duplicate',
          actor: { name: 'Jordan', kind: 'person' },
        } as never,
        titleOf,
      ),
    ).toBe('Jordan archived “Wire the index” — duplicate');
  });
});
