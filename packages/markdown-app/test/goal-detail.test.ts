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

/** The commentForm submits on its own form element; find whichever node the
 *  helper actually built so the test does not encode its internals. */
function submitComposer(panel: HTMLElement): void {
  const form = panel.querySelector('.hub-comment-form');
  const target = form instanceof HTMLFormElement ? form : panel.querySelector('form');
  target?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
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

  // Attribution stays: a done goal is somebody's claim and the claim names
  // its author. The per-status breakdown does NOT — *"how many tasks are in
  // triage/todo/in-progress/done is just not useful information"* (Bryan,
  // 2026-08-24, reviewing the live panel). The band header on the board still
  // counts; this panel is where the number was noise rather than news.
  it('attributes a declared done, and no longer breaks its tasks down by status', () => {
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
    // The positive half first — without it every assertion below passes on a
    // panel that never rendered, which is the same shape as the feature
    // working.
    expect(text).toContain('Declared by Jordan');
    expect(text).not.toContain('1 to do');
    expect(text).not.toContain('1 in progress');
    // The field is GONE, not merely emptied — an empty `Tasks` row would still
    // spend a line of the panel's scarcest axis.
    const keys = [...root.querySelectorAll('.hub-detail-field-k')].map((n) => n.textContent);
    expect(keys).toContain('Status');
    expect(keys).not.toContain('Tasks');
  });

  // The "marking this goal done leaves N open tasks" advisory is gone in the
  // same pass. It was never a gate — the server has always accepted a done
  // declaration over open children (`enforce:false`) — so removing it changes
  // what the panel SAYS, not what anyone is allowed to do.
  it('no longer warns about what a done declaration would leave open', () => {
    renderGoalDetail(root, sectionWith({}, [task(), task({ status: 'in-progress' })]), handlers());
    const panel = root.querySelector('.hub-detail-panel') as HTMLElement;
    const text = panel.textContent ?? '';
    expect(text).toContain('1. Get the PR out');
    expect(root.querySelector('.hub-goal-advisory')).toBeNull();
    expect(text).not.toContain('open task');
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

  // The live board repaints the panel on every projection change, and a
  // repaint must not eat a rename mid-thought — the task panel's guarantee,
  // via the same keepFields/restoreFields pair.
  it('a repaint keeps a rename in flight', () => {
    const h = handlers();
    renderGoalDetail(root, sectionWith(), h);
    (root.querySelector('.hub-detail-title') as HTMLElement).click();
    const input = root.querySelector('.hub-detail-title input') as HTMLInputElement;
    input.value = '1. Ship';
    renderGoalDetail(root, sectionWith(), h);
    const again = root.querySelector('.hub-detail-title input') as HTMLInputElement;
    expect(again).not.toBeNull();
    expect(again.value).toBe('1. Ship');
  });

  it('Escape closes the panel', () => {
    const h = handlers();
    renderGoalDetail(root, sectionWith(), h);
    const panel = root.querySelector('.hub-detail-panel') as HTMLElement;
    panel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.onClose).toHaveBeenCalled();
  });

  /**
   * Description and discussion — the parity Bryan reopened the ticket for:
   * *"Goals are missing a bunch of the usual ticket behaviour -- no
   * description? no comments?"*
   *
   * Both are the TASK panel's own machinery pointed at the goal's body room,
   * which is `task:<goalId>` by the approved design's naming decision. So
   * these assert the seams the app wires into — the slot the live editor
   * mounts on, and the stream/composer the discussion renders — rather than
   * re-testing the editor or the comment renderer, which the task panel's
   * suites already cover.
   */
  it('shows the goal description, and offers a slot for the live editor', () => {
    renderGoalDetail(
      root,
      sectionWith({ bodyDocId: 'task:g-pr', body: 'Ten teams using it weekly, unprompted.' }),
      handlers(),
    );
    const panel = root.querySelector('.hub-detail-panel') as HTMLElement;
    expect(panel.textContent).toContain('Description');
    const slot = panel.querySelector('.hub-detail-body-slot') as HTMLElement;
    expect(slot).not.toBeNull();
    // The app keys `bodyEditor.sync` on this, and it is what `keptBodySlot`
    // matches to keep a mounted editor alive through a repaint.
    expect(slot.dataset.taskId).toBe('g-pr');
    expect(slot.textContent).toContain('Ten teams using it weekly');
  });

  it('says so plainly when nobody has described the goal yet', () => {
    renderGoalDetail(root, sectionWith({ bodyDocId: 'task:g-pr' }), handlers());
    const slot = root.querySelector('.hub-detail-body-slot') as HTMLElement;
    expect(slot.textContent).toContain('No description yet.');
  });

  it('renders the goal discussion and posts a comment to it', async () => {
    const onComment = vi.fn(async (_goalId: string, _text: string, _threadId?: string) => true);
    renderGoalDetail(root, sectionWith({ bodyDocId: 'task:g-pr' }), handlers({ onComment }), {
      loading: false,
      threads: [
        {
          id: 'th-1',
          comments: [{ author: 'Search Revamp', text: 'Ten teams, or ten that renew?', ts: NOW }],
        },
      ],
    });
    const panel = root.querySelector('.hub-detail-panel') as HTMLElement;
    expect(panel.querySelector('.hub-discussion')).not.toBeNull();
    expect(panel.textContent).toContain('Ten teams, or ten that renew?');
    const box = panel.querySelector('.hub-comment-form textarea') as HTMLTextAreaElement;
    expect(box).not.toBeNull();
    box.value = 'Ten that renew.';
    submitComposer(panel);
    await Promise.resolve();
    expect(onComment).toHaveBeenCalled();
    // The reply lands in the thread that is already there rather than opening
    // a second one — `composerTarget`'s derivation, same as a task's.
    expect(onComment.mock.calls[0]?.[2]).toBe('th-1');
  });

  it('carries no discussion at all when the app has not fetched one', () => {
    renderGoalDetail(root, sectionWith({ bodyDocId: 'task:g-pr' }), handlers());
    expect(root.querySelector('.hub-discussion')).toBeNull();
  });

  // A description is a live editor over a websocket. The repaint guarantee
  // that protects a task's — keep the SLOT node itself, never re-create it —
  // has to hold here too, or the board's own projection updates would tear
  // the editor down under whoever is typing in it.
  it('a repaint keeps a mounted description editor in place', () => {
    renderGoalDetail(root, sectionWith({ bodyDocId: 'task:g-pr' }), handlers());
    const slot = root.querySelector('.hub-detail-body-slot') as HTMLElement;
    slot.classList.add('hub-detail-body-live');
    slot.dataset.marker = 'mounted';
    renderGoalDetail(root, sectionWith({ bodyDocId: 'task:g-pr' }), handlers());
    const after = root.querySelector('.hub-detail-body-slot') as HTMLElement;
    expect(after.dataset.marker).toBe('mounted');
    expect(after).toBe(slot);
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
