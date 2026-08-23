import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubTask,
  boardSections,
} from '../src/hub/hub-model.ts';
import { type GoalDetailHandlers, renderGoalDetail } from '../src/hub/hub-render.ts';

/**
 * The goal DETAIL panel — the surface a goal row's tap opens (decision 4:
 * "mobile tap opens the detail panel and never edits the title"). The row
 * deliberately carries none of the working chrome, so this panel is where a
 * goal's status, owner, due date and task counts live — and where renaming
 * happens on the devices whose rows never edit in place.
 *
 * All fixtures are synthetic — invented names, jordan@partner.example
 * register. The repo is public.
 */

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

let seq = 0;
function task(overrides: Partial<HubTask> = {}): HubTask {
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
    ...overrides,
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

const filters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
} as const;

function sectionWith(
  goalOver: Record<string, unknown> = {},
  tasks: HubTask[] = [],
): ReturnType<typeof boardSections>[number] {
  const sections = boardSections(
    [{ id: 'g-pr', title: '1. Get the PR out', ...goalOver }],
    tasks,
    filters,
  );
  const section = sections.find((s) => s.id === 'g-pr');
  if (!section) throw new Error('section missing');
  return section;
}

let root: HTMLElement;
beforeEach(() => {
  document.body.replaceChildren();
  document.body.className = '';
  root = document.createElement('div');
  root.className = 'hub-detail hidden';
  document.body.append(root);
});

describe('renderGoalDetail', () => {
  it('opens on the goal: kind, id, title, and the close button closes', () => {
    const h = handlers();
    renderGoalDetail(root, sectionWith(), h);
    expect(root.classList.contains('hidden')).toBe(false);
    expect(document.body.classList.contains('hub-detail-open')).toBe(true);
    const panel = root.querySelector('.hub-detail-panel') as HTMLElement;
    expect(panel.dataset.goalId).toBe('g-pr');
    expect(panel.querySelector('.hub-detail-kind')?.textContent).toBe('Goal');
    expect(panel.querySelector('.hub-detail-id')?.textContent).toBe('g-pr');
    expect(panel.querySelector('.hub-detail-title')?.textContent).toBe('1. Get the PR out');
    (panel.querySelector('.hub-detail-close') as HTMLButtonElement).click();
    expect(h.onClose).toHaveBeenCalled();
  });

  it('renders nothing and hides when there is no goal to show', () => {
    renderGoalDetail(root, sectionWith(), handlers());
    renderGoalDetail(root, null, handlers());
    expect(root.classList.contains('hidden')).toBe(true);
    expect(document.body.classList.contains('hub-detail-open')).toBe(false);
    expect(root.querySelector('.hub-detail-panel')).toBeNull();
  });

  // The panel is where renaming lives on a coarse pointer (the row's tap
  // opens and never edits), so the title here is ALWAYS editable — same
  // unconditional affordance as the task panel's title.
  it('renames the goal from the panel title', () => {
    const h = handlers();
    renderGoalDetail(root, sectionWith(), h);
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    title.click();
    const input = title.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    input.value = '1. Ship the PR';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onTitleCommit).toHaveBeenCalledWith('g-pr', '1. Ship the PR');
  });

  // Declaring a goal done IS the feature goal rows exist for, and the server
  // route is the same one gate every status change goes through — so the
  // panel carries the select the mock draws, wired to the section's id.
  it('shows the goal status and lets somebody declare it', () => {
    const h = handlers();
    renderGoalDetail(root, sectionWith({ status: 'todo' }), h);
    const select = root.querySelector('.hub-goal-detail-status') as HTMLSelectElement;
    expect(select.value).toBe('todo');
    select.value = 'done';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).toHaveBeenCalledWith('g-pr', 'done');
  });

  it('attributes a declared done, and the counts say where the work is', () => {
    renderGoalDetail(
      root,
      sectionWith({ status: 'done', doneAt: NOW, doneBy: { name: 'Jordan', kind: 'person' } }, [
        task({ status: 'done' }),
        task({ status: 'in-progress' }),
        task(),
      ]),
      handlers(),
    );
    const text = (root.querySelector('.hub-detail-panel') as HTMLElement).textContent ?? '';
    expect(text).toContain('Declared by Jordan');
    expect(text).toContain('1 to do');
    expect(text).toContain('1 in progress');
    expect(text).toContain('1 done');
  });

  // The advisory, straight from the approved mock: open children never block
  // a done declaration (enforce:false on the server), but the panel SAYS what
  // the declaration leaves open. An already-done goal gets no advisory, and
  // neither does an open goal with nothing open in it.
  it('advises what a done declaration leaves open — only while that is true', () => {
    renderGoalDetail(root, sectionWith({}, [task(), task({ status: 'in-progress' })]), handlers());
    const advisory = root.querySelector('.hub-goal-advisory') as HTMLElement;
    expect(advisory).not.toBeNull();
    expect(advisory.textContent).toContain('2 open');
    renderGoalDetail(root, sectionWith({}, [task({ status: 'done' })]), handlers());
    expect(root.querySelector('.hub-goal-advisory')).toBeNull();
    renderGoalDetail(
      root,
      sectionWith({ status: 'done', doneAt: NOW, doneBy: { name: 'Jordan', kind: 'person' } }, [
        task(),
      ]),
      handlers(),
    );
    expect(root.querySelector('.hub-goal-advisory')).toBeNull();
  });

  it('draws the owner as a vacancy until the projection says otherwise, and the due date', () => {
    renderGoalDetail(root, sectionWith({ dueAt: NOW + DAY }), handlers());
    let text = (root.querySelector('.hub-detail-panel') as HTMLElement).textContent ?? '';
    expect(text).toContain('Nobody yet');
    expect(text).toContain('due');
    renderGoalDetail(root, sectionWith({ assignee: 'search-revamp' }), handlers());
    text = (root.querySelector('.hub-detail-panel') as HTMLElement).textContent ?? '';
    expect(text).toContain('search-revamp');
  });

  it('Escape closes the panel', () => {
    const h = handlers();
    renderGoalDetail(root, sectionWith(), h);
    const panel = root.querySelector('.hub-detail-panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.onClose).toHaveBeenCalled();
  });

  it('refuses the reserved bucket — Backlog has no detail to open', () => {
    const sections = boardSections([{ id: 'g-pr', title: 'G' }], [], filters);
    const chores = sections.find((s) => s.id === CHORES_ID);
    if (!chores) throw new Error('chores section missing');
    renderGoalDetail(root, chores, handlers());
    expect(root.querySelector('.hub-detail-panel')).toBeNull();
    expect(root.classList.contains('hidden')).toBe(true);
  });
});
