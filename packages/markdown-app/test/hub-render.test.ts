import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type UptimeReport,
  boardSections,
  clientDriftNotice,
  goalLabel,
  pluginDriftNotice,
  reviewQueue,
} from '../src/hub/hub-model.ts';
import {
  type BoardHandlers,
  type QuickAddHandlers,
  type TaskThread,
  discussionIsBusy,
  renderActivity,
  renderBoard,
  renderGoalStrip,
  renderLeadStrip,
  renderPresence,
  renderQuickAdd,
  renderReviewStrip,
  renderTaskDetail,
} from '../src/hub/hub-render.ts';

/** All fixtures are synthetic — invented names, jordan@partner.example register. */

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

const GOALS: HubGoal[] = [
  { id: 'g-pr', title: '1. Get the PR out', subgoals: [{ id: 'g-sub', title: '1.1 Tickets' }] },
];

const filters: BoardFilters = {
  tab: 'all',
  userName: 'Jordan',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

/** Desktop by default: a fine, hovering pointer is what makes tap-to-rename
 *  on the title safe (see `renderTaskRow`). Coarse-pointer cases opt in. */
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

describe('renderBoard', () => {
  it('renders goal sections in order with Chores last, done rows styled done in place', () => {
    const done = task({
      goal: 'g-pr',
      order: 1,
      status: 'done',
      transitions: [{ ts: NOW, from: 'todo', to: 'done', by: { name: 'Agent', kind: 'agent' } }],
    });
    const open = task({ goal: 'g-pr', order: 2 });
    renderBoard(root, boardSections(GOALS, [done, open], filters), handlers());
    const sections = Array.from(root.querySelectorAll('.hub-section'));
    expect(sections.map((s) => (s as HTMLElement).dataset.goalId)).toEqual([
      'g-pr',
      'g-sub',
      CHORES_ID,
    ]);
    // Done is a status, not a group: the done row keeps its priority slot…
    const rows = Array.from(sections[0]?.querySelectorAll('.hub-task-row') ?? []);
    expect(rows.map((r) => (r as HTMLElement).dataset.taskId)).toEqual([done.id, open.id]);
    // …and is drawn in the done style.
    expect((rows[0] as HTMLElement).classList.contains('hub-done')).toBe(true);
    expect((rows[1] as HTMLElement).classList.contains('hub-done')).toBe(false);
  });

  // Every status is one gesture away — the point of replacing the cycle. A
  // done → todo pick is the case the cycle got wrong: it cost two moves and
  // wrote two audit events for something that happened once.
  it('the status dropdown offers every status and reports the one picked', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', status: 'done' });
    renderBoard(root, boardSections(GOALS, [t], { ...filters, doneWindow: 'all' }), h);
    const select = root.querySelector('.hub-status-select') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value).sort()).toEqual(['done', 'in-progress', 'todo']);
    expect(select.value).toBe('done');
    select.value = 'todo';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'todo');
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  // A comment nobody can see from the board is a comment nobody reads: with
  // no mark on the row, finding a discussion means opening every task.
  it('marks a row whose task has a discussion, and leaves a quiet one unmarked', () => {
    const h = handlers();
    const discussed = task({ goal: 'g-pr', commentCount: 3 });
    const quiet = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [discussed, quiet], filters), h);
    const badgeOf = (t: HubTask) =>
      root
        .querySelector(`.hub-task-row[data-task-id="${t.id}"]`)
        ?.querySelector('.hub-badge-comments');
    expect(badgeOf(discussed)?.textContent).toContain('3');
    expect(badgeOf(quiet)).toBeNull();
  });

  it('a change event that re-picks the current status writes nothing', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const select = root.querySelector('.hub-status-select') as HTMLSelectElement;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).not.toHaveBeenCalled();
  });

  // The status name isn't drawn as body text in the row, so the accessible
  // name is what carries it. A row control labelled '' reads as "combo box"
  // and nothing else.
  it('the status dropdown still names its status for assistive tech', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const mark = root.querySelector('.hub-status-select') as HTMLElement;
    expect(mark.getAttribute('aria-label') ?? '').toContain('To do');
    expect(mark.title).toContain('To do');
  });

  // Every row is one grid line: the layout property the whole change is for.
  it('keeps the title on one line so the status marks stay in a column', () => {
    const h = handlers();
    const long = task({
      goal: 'g-pr',
      title: 'B16: drop the 10s age bound; suppress the installer auto-launch on cold start',
    });
    renderBoard(root, boardSections(GOALS, [long], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    // Not `white-space: normal` — that (plus flex-wrap) is what wrapped a
    // long title under its own status control and misaligned the column.
    expect(title.className).toContain('hub-task-title');
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    // Order is the contract the grid tracks are written against — and it is
    // the row anatomy itself: handle, open zone, status, title, assignee.
    expect([...row.children].map((c) => (c as HTMLElement).className.split(' ')[0])).toEqual([
      'hub-drag-handle',
      'hub-open-zone',
      'hub-status-ctl',
      'hub-risk-slot',
      'hub-task-title',
      'hub-task-badges',
      'hub-owner-ctl',
    ]);
  });

  // The two controls that flank the title used to spend ~200px of every row
  // drawing the words "In progress" and an agent id, on a surface whose whole
  // job is reading titles. They are round marks now, and the words they used
  // to draw must not come back as visible text — that regression would be
  // invisible to every other assertion here, because the SELECT still holds
  // the labels and still reports the same values.
  it('draws status and owner as marks, not as words in the row', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', status: 'in-progress' })], filters),
      h,
    );
    const ctl = root.querySelector('.hub-status-ctl') as HTMLElement;
    const mark = ctl.querySelector('.hub-status-mark') as HTMLElement;
    expect(mark.className).toContain('hub-status-mark-in-progress');
    // The mark carries no label text — the status is shape and colour.
    expect(mark.textContent?.trim()).toBe('');
    // …and the picker underneath is untouched: same class, same options.
    const select = ctl.querySelector('.hub-status-select') as HTMLSelectElement;
    expect(select.value).toBe('in-progress');
    select.value = 'done';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(h.onStatusSet).toHaveBeenCalled();
  });

  // One or two letters, never the whole id. The name still has to be reachable
  // — a circle reading "TL" with no way to learn whose it is trades one
  // unreadable row for one unanswerable one.
  it('shows the owner as initials, keeping the full name reachable', () => {
    const h = handlers();
    const rows: [string, string][] = [
      ['team-lead-fleet', 'TL'],
      ['human', 'H'],
      ['agent-live-feedback', 'LF'],
    ];
    for (const [assignee, expected] of rows) {
      root.replaceChildren();
      renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', assignee })], filters), h);
      const avatar = root.querySelector('.hub-owner-avatar') as HTMLElement;
      expect(avatar.textContent).toBe(expected);
      expect((root.querySelector('.hub-row-assignee') as HTMLElement).title).toContain(assignee);
    }
  });

  // Unowned is a hole in the board, and it has to look like one rather than
  // like a third person — this is the row the initials scheme has no input for.
  it('marks an unowned task rather than inventing initials for it', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', assignee: 'agent' })], filters),
      h,
    );
    const avatar = root.querySelector('.hub-owner-avatar') as HTMLElement;
    expect(avatar.textContent).toBe('?');
    expect(avatar.className).toContain('hub-owner-none');
  });

  // The bug this pins: `grid-template-columns` names four tracks, and grid
  // auto-placement fills them CONSECUTIVELY. A row that omitted the risk dot
  // put its title in the dot's track — which a `:not(:has(.hub-risk))` rule
  // had collapsed to `0` — so every title on a row without a risk tier
  // rendered at zero width. happy-dom does no layout, so the assertion that
  // catches it is the child SHAPE, identical either way. An earlier version
  // of this test asserted the three-child order and therefore pinned the bug
  // in place instead of catching it.
  it('a row without a risk tier has the same grid children as one with', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(
        GOALS,
        [
          task({ goal: 'g-pr', id: 't-plain', title: 'no tier' }),
          task({ goal: 'g-pr', id: 't-risky', title: 'has tier', riskTier: 'red' }),
        ],
        filters,
      ),
      h,
    );
    const rows = [...root.querySelectorAll('.hub-task-row')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    const shape = (r: HTMLElement) =>
      [...r.children].map((c) => (c as HTMLElement).className.split(' ')[0]);
    expect(shape(rows[0])).toEqual(shape(rows[1]));
    expect(shape(rows[0])).toHaveLength(7);
    // Positive control: the tiers really do differ, so the shapes matching
    // above is not two identically-empty rows agreeing about nothing.
    expect(rows[0].querySelector('.hub-risk')).toBeNull();
    expect(rows[1].querySelector('.hub-risk')).not.toBeNull();
  });

  // The rest of the row was never the problem, but it is the positive control
  // for the title assertions below: if opening broke everywhere, "the title
  // renamed instead of opening" would pass for the wrong reason.
  it('tapping the row anywhere else opens the task too', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    (root.querySelector('.hub-task-row') as HTMLElement).click();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });

  it('goal titles are editable in place too; Chores is not', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [], filters), h);
    const goalTitle = root.querySelector(
      '.hub-section[data-goal-id="g-pr"] .hub-section-title-text',
    ) as HTMLElement;
    goalTitle.click();
    const input = goalTitle.querySelector('input') as HTMLInputElement;
    input.value = '1. Ship the PR';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onGoalTitleCommit).toHaveBeenCalledWith('g-pr', '1. Ship the PR');
    const choresTitle = root.querySelector(
      `.hub-section[data-goal-id="${CHORES_ID}"] .hub-section-title-text`,
    ) as HTMLElement;
    choresTitle.click();
    expect(choresTitle.querySelector('input')).toBeNull();
  });
});

// ── The Asana row anatomy: handle · open zone · status · title · assignee ──

describe('the open zone', () => {
  // The deliberate space whose only job is opening the task. It is what makes
  // restoring inline title editing safe: with the title editable, the row
  // needs a target that can only ever mean "open".
  it('opens the task and says so to assistive tech', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Open me' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const zone = root.querySelector('.hub-open-zone') as HTMLButtonElement;
    expect(zone.getAttribute('aria-label') ?? '').toContain('Open me');
    zone.click();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });
});

describe('inline title editing', () => {
  // Restored deliberately — and it re-opens the bug that removed it, so the
  // gate is the pointer, not the title.
  it('a fine pointer renames in place; Enter commits', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    const input = title.querySelector('input') as HTMLInputElement;
    expect(input).not.toBeNull();
    // The click that entered edit mode must not also have opened the task.
    expect(h.onOpenTask).not.toHaveBeenCalled();
    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onTitleCommit).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'New title',
    );
  });

  it('Escape cancels without writing', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', title: 'Keep me' })], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    const input = title.querySelector('input') as HTMLInputElement;
    input.value = 'Discard me';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(title.textContent).toBe('Keep me');
  });

  // Keyboard parity: a rename reachable only by clicking is a rename a
  // keyboard user cannot perform.
  it('is reachable from the keyboard — the title is focusable and Enter starts it', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    expect(title.tabIndex).toBe(0);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(title.querySelector('input')).not.toBeNull();
    // …and starting an edit must not also open the task behind it.
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  // THE mobile decision. A phone has no hover and a fat pointer: the title is
  // ~60% of a 430px row, so tap-to-rename there is the exact bug that removed
  // inline editing an hour before this shipped ("I can't open a task to see
  // what's inside"). On a coarse pointer the title opens, and renaming lives
  // in the detail panel — one tap away, full-width target.
  it('a coarse pointer opens the task instead of renaming it', () => {
    const h = handlers({ inlineTitleEdit: () => false });
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    expect(title.querySelector('input')).toBeNull();
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
    // The open zone is still there and still works — the anatomy does not
    // change shape between pointers, only what the title's tap means.
    expect(root.querySelector('.hub-open-zone')).not.toBeNull();
  });
});

describe('the row assignee', () => {
  const pickerIn = (el: HTMLElement) => el.querySelector('.hub-row-assignee') as HTMLSelectElement;
  const values = (sel: HTMLSelectElement) => [...sel.options].map((o) => o.value);

  // The gesture used to be a two-word toggle: tap and the owner flipped
  // between 'human' and the bare word 'agent'. That word names a category
  // rather than somebody — two agents in the same workspace could not tell
  // their queues apart — and the API now refuses it outright, so the toggle
  // could only ever hand a task to nobody or take it away from a named agent.
  it("offers the workspace's agents and human, and never the generic word", () => {
    const h = handlers({ knownAgentIds: ['Index Rebuild', 'Search Revamp'] });
    const t = task({ goal: 'g-pr', assignee: 'Search Revamp' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const pick = pickerIn(root);
    expect(pick.tagName).toBe('SELECT');
    expect(values(pick)).toEqual(
      expect.arrayContaining(['human', 'Index Rebuild', 'Search Revamp']),
    );
    expect(values(pick)).not.toContain('agent');
    expect(pick.value).toBe('Search Revamp');
  });

  it('hands the task to whoever was picked, without opening it', () => {
    const h = handlers({ knownAgentIds: ['Index Rebuild'] });
    const t = task({ goal: 'g-pr', assignee: 'human' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const pick = pickerIn(root);
    pick.value = 'Index Rebuild';
    pick.dispatchEvent(new Event('change'));
    expect(h.onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'Index Rebuild');
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  // A workspace's attachments are the agents live RIGHT NOW. An owner who has
  // since detached — or a person who was never an attachment — must still be
  // shown as the owner, or the row silently renames somebody's work.
  it('keeps an owner who is not among the attached agents', () => {
    const h = handlers({ knownAgentIds: ['Index Rebuild'] });
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', assignee: 'Jordan' })], filters),
      h,
    );
    const pick = pickerIn(root);
    expect(pick.value).toBe('Jordan');
    expect(values(pick)).toContain('Index Rebuild');
  });

  it('reads a task still sitting on the generic owner as unassigned', () => {
    const h = handlers({ knownAgentIds: ['Index Rebuild'] });
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', assignee: 'agent' })], filters),
      h,
    );
    const pick = pickerIn(root);
    expect(pick.value).toBe('');
    expect(pick.selectedOptions[0]?.textContent ?? '').toMatch(/unassigned/i);
    expect(pick.classList.contains('hub-owner-none')).toBe(true);
  });

  // 'human' and a named agent are the two answers a reader acts on
  // differently, so they cannot look the same at a glance — and the mobile
  // pill is narrow enough that the text alone will not carry it.
  it('marks a person, an agent, and nobody apart from each other', () => {
    const h = handlers({ knownAgentIds: ['Index Rebuild'] });
    const rows = [
      task({ goal: 'g-pr', order: 1, assignee: 'human' }),
      task({ goal: 'g-pr', order: 2, assignee: 'Index Rebuild' }),
      task({ goal: 'g-pr', order: 3, assignee: 'agent' }),
    ];
    renderBoard(root, boardSections(GOALS, rows, filters), h);
    const classes = [...root.querySelectorAll('.hub-row-assignee')].map((el) =>
      [...el.classList].filter((c) => c.startsWith('hub-owner-')).join(),
    );
    expect(classes).toEqual(['hub-owner-human', 'hub-owner-agent', 'hub-owner-none']);
  });

  // It used to be a badge that rendered only when the assignee was not the
  // default 'agent' — so most rows showed no owner at all, and the one place
  // it appeared was also the place a long name could win the row.
  it('is on every row, including one nobody owns', () => {
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', assignee: 'agent' })], filters),
      handlers(),
    );
    expect(root.querySelectorAll('.hub-row-assignee')).toHaveLength(1);
    // …and no longer duplicated as a badge.
    expect(root.querySelector('.hub-badge-assignee')).toBeNull();
  });
});

describe('the drag handle', () => {
  it('is a real control with an accessible name, at the far left of the row', () => {
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), handlers());
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    const handle = row.firstElementChild as HTMLButtonElement;
    expect(handle.className).toContain('hub-drag-handle');
    expect(handle.tagName).toBe('BUTTON');
    expect(handle.getAttribute('aria-label') ?? '').toMatch(/reorder|move/i);
  });

  // Mockup v2's rule: finishing a task doesn't move it, so a done row has no
  // handle. The ELEMENT stays (the grid fills tracks consecutively — a
  // missing child slides every later cell one track left), it is just inert.
  it('is inert on a done row, without changing the row shape', () => {
    const done = task({
      goal: 'g-pr',
      status: 'done',
      transitions: [{ ts: NOW, from: 'todo', to: 'done', by: { name: 'Agent', kind: 'agent' } }],
    });
    const open = task({ goal: 'g-pr' });
    renderBoard(
      root,
      boardSections(GOALS, [done, open], { ...filters, doneWindow: 'all' }),
      handlers(),
    );
    const rows = [...root.querySelectorAll('.hub-task-row')] as HTMLElement[];
    const handleOf = (r: HTMLElement) => r.querySelector('.hub-drag-handle') as HTMLButtonElement;
    expect(rows[0].children.length).toBe(rows[1].children.length);
    expect(handleOf(rows[0]).disabled).toBe(true);
    // Positive control: the open row's handle is live, so `disabled` above is
    // this row's state and not the element's default.
    expect(handleOf(rows[1]).disabled).toBe(false);
  });

  it('a disabled handle refuses to reorder even if a key reaches it', () => {
    const h = handlers();
    const done = task({
      goal: 'g-pr',
      status: 'done',
      transitions: [{ ts: NOW, from: 'todo', to: 'done', by: { name: 'Agent', kind: 'agent' } }],
    });
    renderBoard(
      root,
      boardSections(GOALS, [done, task({ goal: 'g-pr' })], { ...filters, doneWindow: 'all' }),
      h,
    );
    const handle = root.querySelector('.hub-drag-handle') as HTMLButtonElement;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(h.onReorder).not.toHaveBeenCalled();
  });
});

describe('keyboard reordering', () => {
  const three = () => [
    task({ id: 'k-a', goal: 'g-pr', order: 1 }),
    task({ id: 'k-b', goal: 'g-pr', order: 2 }),
    task({ id: 'k-c', goal: 'g-pr', order: 3 }),
  ];

  it('the focused handle moves its row with the arrow keys', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, three(), filters), h);
    const handle = root.querySelector('[data-task-id="k-a"] .hub-drag-handle') as HTMLButtonElement;
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(h.onReorder).toHaveBeenCalledWith(expect.objectContaining({ id: 'k-a' }), {
      goal: 'g-pr',
      position: 2.5,
    });
  });

  // j/k focuses the ROW, not the handle, so a reorder that only worked from
  // the handle would mean tabbing out of the navigation you are already in.
  it('Alt+Arrow works from the row itself, where j/k leaves the focus', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, three(), filters), h);
    const row = root.querySelector('[data-task-id="k-c"]') as HTMLElement;
    row.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }),
    );
    expect(h.onReorder).toHaveBeenCalledWith(expect.objectContaining({ id: 'k-c' }), {
      goal: 'g-pr',
      position: 1.5,
    });
  });

  // Bare arrows on a row must stay the browser's (scrolling, and the status
  // dropdown's own key handling); only the modified chord reorders.
  it('a bare Arrow on the row does not reorder', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, three(), filters), h);
    const row = root.querySelector('[data-task-id="k-c"]') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(h.onReorder).not.toHaveBeenCalled();
  });

  it('Enter still opens the row it is focused on', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, three(), filters), h);
    const row = root.querySelector('[data-task-id="k-b"]') as HTMLElement;
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: 'k-b' }));
  });
});

describe('renderReviewStrip', () => {
  it('shows a chip per open decision and opens it on tap', () => {
    const onOpen = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human', title: 'Ship now or wait?' });
    const strip = { onOpen, onWalkthrough: vi.fn() };
    renderReviewStrip(root, reviewQueue([d], [], NOW), strip);
    const chip = root.querySelector('.hub-decision-chip') as HTMLElement;
    expect(chip.textContent).toContain('Ship now or wait?');
    chip.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Empty → the strip hides instead of rendering an empty shell.
    renderReviewStrip(root, reviewQueue([], [], NOW), strip);
    expect(root.classList.contains('hidden')).toBe(true);
  });
});

describe('renderGoalStrip', () => {
  it('renders the goal as markdown and commits an edit through the handler', () => {
    const onGoalCommit = vi.fn();
    renderGoalStrip(root, 'Ship **search v2**.', { onGoalCommit });
    expect(root.querySelector('.hub-goal-body strong')?.textContent).toBe('search v2');
    (root.querySelector('.hub-goal-edit') as HTMLElement).click();
    const ta = root.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Ship search v3.';
    (root.querySelector('.hub-btn-primary') as HTMLElement).click();
    // The second argument is the ≤20-word display line; empty leaves the
    // strip on its deterministic clip. See hub-goal-collapse.test.ts.
    expect(onGoalCommit).toHaveBeenCalledWith('Ship search v3.', '');
  });

  it('leads with start-planning on an empty workspace instead of an empty strip', () => {
    renderGoalStrip(root, '', { onGoalCommit: vi.fn() });
    expect(root.textContent).toContain('start planning');
  });
});

describe('renderLeadStrip', () => {
  it('names the lead and lists every known agent as a reassignment target', () => {
    const onLeadCommit = vi.fn();
    renderLeadStrip(root, 'agent-relay', ['agent-helper', 'agent-relay'], { onLeadCommit });
    expect(root.textContent).toContain('Lead agent');
    expect(root.classList.contains('hub-lead-empty')).toBe(false);
    const select = root.querySelector('select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['agent-helper', 'agent-relay']);
    expect(select.value).toBe('agent-relay');

    select.value = 'agent-helper';
    select.dispatchEvent(new Event('change'));
    expect(onLeadCommit).toHaveBeenCalledWith('agent-helper');
  });

  it('picking the agent that already leads commits nothing', () => {
    const onLeadCommit = vi.fn();
    renderLeadStrip(root, 'agent-relay', ['agent-helper'], { onLeadCommit });
    const select = root.querySelector('select') as HTMLSelectElement;
    // Positive control that this select can fire at all is the test above.
    select.value = 'agent-relay';
    select.dispatchEvent(new Event('change'));
    expect(onLeadCommit).not.toHaveBeenCalled();
  });

  it('an empty seat reads as a state to fix, and still offers the attached agents', () => {
    const onLeadCommit = vi.fn();
    renderLeadStrip(root, undefined, ['agent-helper'], { onLeadCommit });
    expect(root.textContent).toContain('No lead agent');
    expect(root.classList.contains('hub-lead-empty')).toBe(true);
    const select = root.querySelector('select') as HTMLSelectElement;
    expect(select.value).toBe('');
    select.value = 'agent-helper';
    select.dispatchEvent(new Event('change'));
    expect(onLeadCommit).toHaveBeenCalledWith('agent-helper');
  });

  it('with nothing to pick from it says the seat is empty rather than showing a dead dropdown', () => {
    renderLeadStrip(root, undefined, [], { onLeadCommit: vi.fn() });
    expect(root.textContent).toContain('No lead agent');
    expect(root.querySelector('select')).toBeNull();
  });

  const pending = (taskIds: string[]) => ({
    batchId: 'b-1',
    taskIds,
    ts: 1_700_000_000_000,
    byName: 'Jordan',
  });

  it('a goal edit waiting on the lead is counted, not merely announced', () => {
    renderLeadStrip(
      root,
      'agent-relay',
      ['agent-relay'],
      { onLeadCommit: vi.fn() },
      pending(['t-1', 't-2', 't-3']),
    );
    const waiting = root.querySelector('.hub-lead-pending') as HTMLElement;
    expect(waiting.textContent).toContain('3 tasks');
    expect(waiting.textContent).toContain('waiting for the lead');
    expect(waiting.title).toContain('Jordan');
  });

  it('with no lead at all the waiting edit says nobody is going to do it', () => {
    renderLeadStrip(root, undefined, [], { onLeadCommit: vi.fn() }, pending(['t-1']));
    const waiting = root.querySelector('.hub-lead-pending') as HTMLElement;
    // Singular, because "1 tasks" is how a count stops being trusted.
    expect(waiting.textContent).toContain('1 task to re-place');
    expect(waiting.textContent).toContain('nobody to do it');
  });

  it('says nothing when nothing is waiting', () => {
    // The absence assertions above are only worth anything because the two
    // tests before this one show the strip CAN render the pending line.
    renderLeadStrip(root, 'agent-relay', ['agent-relay'], { onLeadCommit: vi.fn() });
    expect(root.querySelector('.hub-lead-pending')).toBeNull();
    renderLeadStrip(root, 'agent-relay', ['agent-relay'], { onLeadCommit: vi.fn() }, pending([]));
    expect(root.querySelector('.hub-lead-pending')).toBeNull();
  });
});

describe('renderActivity', () => {
  const events = [
    { event: 'task.created', ts: NOW - 60_000, task: { id: 't-1', title: 'A' }, goal: 'chores' },
    {
      event: 'task.transitioned',
      ts: NOW - 30_000,
      taskId: 't-1',
      from: 'todo',
      to: 'done',
      actor: { name: 'Jordan', kind: 'person' },
    },
  ];

  it('has exactly two filters and swaps rows between them', () => {
    const onFilter = vi.fn();
    renderActivity(root, events, 'all', () => 'A', onFilter);
    const tabs = Array.from(root.querySelectorAll('.hub-activity-filters .hub-tab'));
    expect(tabs.map((t) => t.textContent)).toEqual(['All', 'Decisions']);
    expect(root.querySelectorAll('.hub-activity-row')).toHaveLength(2);
    (tabs[1] as HTMLElement).click();
    expect(onFilter).toHaveBeenCalledWith('decisions');
    renderActivity(root, events, 'decisions', () => 'A', onFilter);
    // Positive control above proved rows render at all; Decisions drops the
    // plain transition.
    const rows = Array.from(root.querySelectorAll('.hub-activity-row'));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.textContent).toContain('created');
  });

  const uptime = (over: Partial<UptimeReport> = {}): UptimeReport => ({
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

  it('renders the uptime banner — ok styling when the 99% target is met', () => {
    renderActivity(root, events, 'all', () => 'A', vi.fn(), uptime());
    const banner = root.querySelector('.hub-uptime');
    expect(banner).not.toBeNull();
    expect(banner?.classList.contains('hub-uptime-ok')).toBe(true);
    expect(banner?.textContent).toContain('Uptime 100%');
    expect(banner?.textContent).toContain('target 99%');
  });

  it('a missed target gets the miss styling and shows the downtime', () => {
    renderActivity(
      root,
      events,
      'all',
      () => 'A',
      vi.fn(),
      uptime({ uptimeRatio: 0.97, meetsTarget: false, downMs: 5 * 60 * 60_000 }),
    );
    const banner = root.querySelector('.hub-uptime');
    expect(banner?.classList.contains('hub-uptime-miss')).toBe(true);
    expect(banner?.textContent).toContain('down 5h');
  });

  it('no report, no banner (the two tests above are the presence control)', () => {
    renderActivity(root, events, 'all', () => 'A', vi.fn(), null);
    expect(root.querySelector('.hub-uptime')).toBeNull();
  });
});

describe('renderTaskDetail', () => {
  const detailHandlers = () => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
  });

  const metaValue = (key: string): string | null => {
    const dts = [...root.querySelectorAll('.hub-detail-meta dt')];
    const dds = [...root.querySelectorAll('.hub-detail-meta dd')];
    const i = dts.findIndex((dt) => dt.textContent === key);
    return i === -1 ? null : (dds[i]?.textContent ?? null);
  };

  // The board spends a whole section header naming the goal; the panel you
  // open to find out what a task is FOR printed `g1-loop`. An id is a fact
  // about the store, not an answer to "which goal does this serve".
  it('names the goal the way the board does', () => {
    renderTaskDetail(root, task({ goal: 'g-pr' }), {
      ...detailHandlers(),
      goalLabel: (id) => goalLabel(GOALS, id),
    });
    expect(metaValue('Goal')).toBe('1. Get the PR out');
  });

  // Chores is a real section with a real header, and it is also where an
  // orphaned task lands — so both have to say Chores here, not `chores`.
  it('says Chores for a chore and for a goal that no longer exists', () => {
    for (const goal of [CHORES_ID, 'g-deleted']) {
      root.replaceChildren();
      renderTaskDetail(root, task({ goal }), {
        ...detailHandlers(),
        goalLabel: (id) => goalLabel(GOALS, id),
      });
      expect(metaValue('Goal')).toBe('Chores');
    }
  });

  it('falls back to the id when no lookup is wired in', () => {
    renderTaskDetail(root, task({ goal: 'g-pr' }), detailHandlers());
    // Positive control for the tests above: the label comes from the lookup,
    // so without one the row still says something rather than going blank.
    expect(metaValue('Goal')).toBe('g-pr');
  });

  // The server accepted, keyed and backlinked `url` refs before anything
  // drew them — stored and unreachable, which is the same failure this
  // codebase already hit with resolved threads. So this asserts the SURFACE,
  // not the model: a stored ref nothing renders is not a feature.
  describe('the history rows say how well proven each move is', () => {
    const moved = (t: Partial<HubTask['transitions'][number]>) =>
      task({
        status: 'done',
        transitions: [
          {
            ts: NOW - 60_000,
            from: 'in-progress',
            to: 'done',
            by: { name: 'Search Revamp', kind: 'agent' },
            ...t,
          },
        ],
      });

    const rows = () => [...root.querySelectorAll('.hub-detail-transitions > li')];

    it('marks a forward move that carries no proof', () => {
      renderTaskDetail(root, moved({}), detailHandlers());
      const row = rows()[0];
      expect(row?.classList.contains('unproven')).toBe(true);
      expect(row?.textContent).toContain('no evidence');
    });

    it('does not mark a move that came with a commit — the positive control', () => {
      renderTaskDetail(root, moved({ evidence: { commit: '621f371abc' } }), detailHandlers());
      const row = rows()[0];
      expect(row?.classList.contains('unproven')).toBe(false);
      expect(row?.textContent).toContain('621f371');
    });

    it('clears the mark when an amendment supplied the missing evidence', () => {
      renderTaskDetail(
        root,
        moved({
          amendments: [
            {
              ts: NOW,
              by: { name: 'Search Revamp', kind: 'agent' },
              evidence: { commit: '621f371abc' },
            },
          ],
        }),
        detailHandlers(),
      );
      const row = rows()[0];
      expect(row?.classList.contains('unproven')).toBe(false);
      // …and the row still says the proof arrived late. The shading answers
      // "is there proof"; the row keeps the narrower fact the board drops.
      expect(row?.textContent).toContain('621f371');
      expect(row?.textContent?.toLowerCase()).toContain('added');
    });

    it('marks the ORIGINAL commit as superseded when a correction replaced it', () => {
      renderTaskDetail(
        root,
        moved({
          evidence: { commit: 'b2ba21edef' },
          amendments: [
            {
              ts: NOW,
              by: { name: 'Search Revamp', kind: 'agent' },
              evidence: { commit: '621f371abc' },
              supersedes: { commit: 'b2ba21edef' },
              note: 'wrote it from memory',
            },
          ],
        }),
        detailHandlers(),
      );
      const row = rows()[0];
      // Never unproven, before or after — so if the surface only reacted to
      // the shading, a sha that resolves to nothing would still read as live
      // proof here. It has to be struck at the row.
      expect(row?.classList.contains('unproven')).toBe(false);
      expect(row?.querySelector('.hub-evidence-superseded')?.textContent).toContain('b2ba21e');
      expect(row?.textContent).toContain('621f371');
      expect(row?.textContent).toContain('wrote it from memory');
    });

    it('does not strike a commit that nothing superseded', () => {
      renderTaskDetail(root, moved({ evidence: { commit: '621f371abc' } }), detailHandlers());
      expect(root.querySelector('.hub-evidence-superseded')).toBeNull();
      // Positive control that the probe can see one when it IS there.
      root.replaceChildren();
      renderTaskDetail(
        root,
        moved({
          evidence: { commit: 'b2ba21edef' },
          amendments: [
            { ts: NOW, by: { name: 'Bryan', kind: 'person' }, evidence: { commit: '621f371abc' } },
          ],
        }),
        detailHandlers(),
      );
      expect(root.querySelector('.hub-evidence-superseded')).not.toBeNull();
    });

    it('never marks a move back to todo — undoing work owes no proof', () => {
      renderTaskDetail(
        root,
        task({
          transitions: [
            { ts: NOW, from: 'done', to: 'todo', by: { name: 'Bryan', kind: 'person' } },
          ],
        }),
        detailHandlers(),
      );
      expect(rows()[0]?.classList.contains('unproven')).toBe(false);
    });
  });

  it('renders a url ref as a real anchor', () => {
    const pr = 'https://github.com/example-org/example-repo/pull/1669';
    renderTaskDetail(root, task({ links: [{ kind: 'url', url: pr }] }), detailHandlers());
    const chip = root.querySelector('.hub-detail-links a') as HTMLAnchorElement;
    expect(chip).toBeTruthy();
    expect(chip.getAttribute('href')).toBe(pr);
    // Opening someone else's link must not hand them this window.
    expect(chip.rel).toContain('noopener');
    // The host is the legible part; the full URL stays in the tooltip so a
    // query string can't stretch the chip.
    expect(chip.textContent).toBe('github.com');
    expect(chip.title).toBe(pr);
  });

  it('never emits a non-http(s) href, even for a ref stored before the check existed', () => {
    // The server refuses these on the way in now, but the panel is built
    // from whatever the doc currently holds — including refs persisted
    // earlier. Positive control first: the good one DOES render, so "no
    // anchor" below means refused rather than "this test renders nothing".
    renderTaskDetail(
      root,
      task({ links: [{ kind: 'url', url: 'https://example.com/ok' }] }),
      detailHandlers(),
    );
    expect(root.querySelectorAll('.hub-detail-links a').length).toBe(1);

    for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>']) {
      renderTaskDetail(root, task({ links: [{ kind: 'url', url }] }), detailHandlers());
      expect(root.querySelectorAll('.hub-detail-links a').length).toBe(0);
    }
  });

  it('survives a ref kind it has never heard of', () => {
    // An older client must not break when a newer server adds a kind: a
    // task that won't open is worse than a chip that isn't drawn.
    expect(() =>
      renderTaskDetail(
        root,
        task({
          links: [
            { kind: 'quasar', quasarId: 'q-1' },
            { kind: 'doc', docId: 'd-1' },
          ],
        }),
        detailHandlers(),
      ),
    ).not.toThrow();
    // …and the ref it DOES understand still made it through.
    expect(root.querySelector('.hub-detail-links')?.textContent).toContain('d-1');
  });

  it('shows the answer form for an unanswered decision and records verbatim text', () => {
    const onAnswer = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human' });
    renderTaskDetail(root, d, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer,
      onAssign: vi.fn(),
    });
    const ta = root.querySelector('.hub-answer-form textarea') as HTMLTextAreaElement;
    ta.value = 'Go with option B, ship Thursday.';
    (root.querySelector('.hub-answer-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ id: d.id }),
      'Go with option B, ship Thursday.',
    );
  });

  it('renders the recorded answer instead of the form once answered', () => {
    const d = task({
      needs: 'decision',
      assignee: 'human',
      answer: { text: 'Option B', by: 'Jordan', ts: NOW },
    });
    renderTaskDetail(root, d, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign: vi.fn(),
    });
    expect(root.querySelector('.hub-answer-form')).toBeNull();
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Option B');
  });

  it('links to the live task body doc', () => {
    const t = task();
    renderTaskDetail(root, t, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign: vi.fn(),
    });
    const a = root.querySelector('.hub-detail-body-link a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(`/review/${encodeURIComponent(t.bodyDocId)}`);
  });

  // The description was stored on every task and the panel rendered only a
  // link to another page — so "what is this task for" cost a navigation, and
  // the board read as a list of bare titles. Same shape as the resolved-thread
  // report: the store had it, no surface could show it.
  it('renders the description on the task itself, as markdown', () => {
    const t = task({
      body: 'Agent can **read** the description here so that it can pick a task up cold.',
    });
    renderTaskDetail(root, t, detailHandlers());
    const desc = root.querySelector('.hub-detail-body');
    expect(desc?.textContent).toContain('pick a task up cold');
    // Rendered, not dumped: the marks became elements rather than asterisks.
    expect(desc?.querySelector('strong')?.textContent).toBe('read');
    expect(desc?.textContent).not.toContain('**');
  });

  it('escapes markup in a description rather than executing it', () => {
    renderTaskDetail(root, task({ body: '<img src=x onerror=alert(1)>' }), detailHandlers());
    expect(root.querySelector('.hub-detail-body img')).toBeNull();
    expect(root.querySelector('.hub-detail-body')?.textContent).toContain('<img');
  });

  it('says a task has no description rather than showing nothing', () => {
    // Positive control: with a body there is no empty note, so its presence
    // below means the branch ran rather than "this test renders nothing".
    renderTaskDetail(root, task({ body: 'Something specific.' }), detailHandlers());
    expect(root.querySelector('.hub-detail-body-empty')).toBeNull();

    renderTaskDetail(root, task(), detailHandlers());
    expect(root.querySelector('.hub-detail-body-empty')).toBeTruthy();
    // The link out stays either way — the doc is where you edit and comment.
    expect(root.querySelector('.hub-detail-body-link a')).toBeTruthy();
  });

  it('says so when the projected description is only the head of a longer one', () => {
    renderTaskDetail(root, task({ body: 'The first part.' }), detailHandlers());
    expect(root.querySelector('.hub-detail-body-more')).toBeNull();

    renderTaskDetail(
      root,
      task({ body: 'The first part.', bodyTruncated: true }),
      detailHandlers(),
    );
    expect(root.querySelector('.hub-detail-body-more')).toBeTruthy();
  });

  it('the assignee row picks who takes it — the same choice the board row offers', () => {
    const onAssign = vi.fn();
    const t = task({ assignee: 'agent' });
    renderTaskDetail(root, t, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign,
      knownAgentIds: ['Index Rebuild'],
    });
    const pick = root.querySelector('.hub-assignee-btn') as HTMLSelectElement;
    // Nobody owns it yet — the generic word is not somebody.
    expect(pick.value).toBe('');
    expect([...pick.options].map((o) => o.value)).toEqual(
      expect.arrayContaining(['human', 'Index Rebuild']),
    );
    pick.value = 'Index Rebuild';
    pick.dispatchEvent(new Event('change'));
    expect(onAssign).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }), 'Index Rebuild');
  });
});

/**
 * The task detail panel is where a person pushes back on a task. Before this,
 * the only comment affordance on the board was a LINK to the task doc — so
 * disagreeing with a task meant leaving the board, and in practice it meant
 * saying it in chat instead, where it reaches nobody the task reaches.
 */
describe('renderTaskDetail — discussion', () => {
  const detailHandlers = (over: Record<string, unknown> = {}) => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(),
    ...over,
  });

  const thread = (over: Partial<TaskThread> = {}): TaskThread => ({
    id: 'th-1',
    status: 'open',
    comments: [{ author: 'Jordan', text: 'Is the index really first?', ts: NOW }],
    ...over,
  });

  /**
   * "Each item goes exactly to the place where I need to review" is the
   * strip's whole claim. On a task with several discussions, opening the task
   * is not that — the reviewer still has to find the one they were sent for.
   */
  it('marks the thread the queue aimed at, and only that one', () => {
    renderTaskDetail(root, task(), detailHandlers({ focusThreadId: 'th-2' }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' }), thread({ id: 'th-3' })],
    });
    const marked = [...root.querySelectorAll('.hub-thread-focus')];
    // Positive control: all three rendered, so "only one marked" means
    // something. Then: it is the RIGHT one.
    expect(root.querySelectorAll('.hub-thread')).toHaveLength(3);
    expect(marked).toHaveLength(1);
    expect((marked[0] as HTMLElement).dataset.threadId).toBe('th-2');
  });

  it('marks nothing when the panel was opened any other way', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })],
    });
    expect(root.querySelectorAll('.hub-thread')).toHaveLength(2);
    expect(root.querySelectorAll('.hub-thread-focus')).toHaveLength(0);
  });

  it('shows each comment with who said it', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [
        thread({
          comments: [
            { author: 'Jordan', text: 'Is the index really first?', ts: NOW },
            { author: 'Search Revamp', text: 'It unblocks two others.', ts: NOW + 1000 },
          ],
        }),
      ],
    });
    const comments = root.querySelectorAll('.hub-comment');
    expect(comments).toHaveLength(2);
    expect(comments[0]?.textContent).toContain('Jordan');
    expect(comments[0]?.textContent).toContain('Is the index really first?');
    expect(comments[1]?.textContent).toContain('Search Revamp');
  });

  // The acceptance: an empty description is the NORMAL state of a task worth
  // arguing about, so the composer cannot be gated on there being something
  // to reply to.
  it('offers a composer on a task with no description and no comments', () => {
    const onComment = vi.fn();
    const t = task({ body: undefined });
    renderTaskDetail(root, t, detailHandlers({ onComment }), { loading: false, threads: [] });

    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'This assumes the index ships first.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // No threadId — a new thread about the task itself.
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'This assumes the index ships first.',
      undefined,
    );
  });

  /**
   * The acceptance line for the two-composers report: "a task with one thread
   * presents exactly one obvious way to reply". It used to present two — a
   * reply box inside the thread and a new-thread box under it, distinguishable
   * only by placeholder text.
   */
  it('offers exactly one composer, whatever the thread count', () => {
    for (const threads of [
      [],
      [thread({ id: 'th-1' })],
      [thread({ id: 'th-1' }), thread({ id: 'th-2' }), thread({ id: 'th-3' })],
    ]) {
      renderTaskDetail(root, task(), detailHandlers(), { loading: false, threads });
      expect(root.querySelectorAll('.hub-discussion textarea')).toHaveLength(1);
    }
    // Positive control: the last pass really did render three threads, so the
    // count above is one composer over three conversations, not an empty panel.
    expect(root.querySelectorAll('.hub-thread')).toHaveLength(3);
  });

  it('defaults to replying to the thread the composer sits under', () => {
    const onComment = vi.fn();
    const t = task();
    renderTaskDetail(root, t, detailHandlers({ onComment }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-77' })],
    });
    expect((root.querySelector('.hub-composer-target') as HTMLElement).textContent).toContain(
      'Replying to',
    );
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Because it unblocks two others.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'Because it unblocks two others.',
      'th-77',
    );
  });

  it('a thread’s Reply button points the composer at THAT thread', () => {
    const onReplyTarget = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onReplyTarget }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })],
    });
    const buttons = [...root.querySelectorAll<HTMLElement>('.hub-thread-reply')];
    expect(buttons).toHaveLength(2);
    buttons[0]?.click();
    expect(onReplyTarget).toHaveBeenCalledWith('th-1');
  });

  it('switching to a new thread survives the next repaint', () => {
    const onComment = vi.fn();
    const t = task();
    const threads = [thread({ id: 'th-1' })];
    // An explicit null, which is what the "New thread" button sends. A repaint
    // that re-applied the default would silently move the reader back onto a
    // reply — and they would find out by reading their own words in the wrong
    // conversation.
    renderTaskDetail(root, t, detailHandlers({ onComment, replyThreadId: null }), {
      loading: false,
      threads,
    });
    expect((root.querySelector('.hub-composer-target') as HTMLElement).textContent).toContain(
      'Starting a new thread',
    );
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Separate point.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'Separate point.',
      undefined,
    );
  });

  it('the queue’s aim wins over the default, so you answer what you were sent for', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment, focusThreadId: 'th-1' }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Yes, ship it.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'Yes, ship it.', 'th-1');
  });

  it('a target that no longer resolves posts a new thread, not into nowhere', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment, replyThreadId: 'th-deleted' }), {
      loading: false,
      threads: [thread({ id: 'th-1' })],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Still worth saying.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'Still worth saying.', undefined);
  });

  /**
   * The premise correction behind the whole change. Task threads are NOT
   * arbitrary groupings: on the live board 34 of 37 carry a text-range anchor
   * into the description (agents' `create_thread(… find: …)` calls) and 3 do
   * not. The surface rendered none of them, which is what made two threads
   * look like two indistinguishable piles.
   */
  it('shows what each thread is anchored to, and names it in the composer', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [
        thread({ id: 'th-1' }),
        thread({ id: 'th-2', anchorText: 'the mtime poll runs every 500ms' }),
      ],
    });
    const anchors = [...root.querySelectorAll('.hub-thread-anchor')];
    // One of the two, not both: a subject-anchored thread is about the task as
    // a whole, and quoting the description above its own thread says nothing.
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.textContent).toContain('the mtime poll runs every 500ms');
    expect((root.querySelector('.hub-composer-target') as HTMLElement).textContent).toContain(
      'the mtime poll runs every 500ms',
    );
  });

  it('names a subject-anchored thread by who opened it', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-1', comments: [{ author: 'Jordan', text: 'Why?', ts: NOW }] })],
    });
    expect((root.querySelector('.hub-composer-target') as HTMLElement).textContent).toContain(
      'Jordan',
    );
  });

  /**
   * Nothing an agent posts may stop arriving. An agent's comment lands as a
   * thread on `task:<id>` — anchored or not — and a person has to be able to
   * answer it. Both shapes, in the same pass.
   */
  it('every thread stays replyable, anchored or not, open or resolved', () => {
    const onReplyTarget = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onReplyTarget }), {
      loading: false,
      threads: [
        thread({ id: 'th-open', anchorText: 'a line of the description' }),
        thread({ id: 'th-subject' }),
        thread({ id: 'th-done', status: 'resolved' }),
      ],
    });
    const rows = [...root.querySelectorAll<HTMLElement>('.hub-thread')];
    expect(rows.map((r) => r.dataset.threadId)).toEqual(['th-open', 'th-subject', 'th-done']);
    for (const row of rows) {
      const btn = row.querySelector<HTMLElement>('.hub-thread-reply');
      expect(btn).toBeTruthy();
      btn?.click();
    }
    expect(onReplyTarget.mock.calls.map((c) => c[0])).toEqual(['th-open', 'th-subject', 'th-done']);
  });

  /**
   * A comment lost to a dropped connection is worse than one that never
   * sent: the box is empty, the toast is gone in three seconds, and the
   * person believes they said it. The text stays put until the post is
   * acknowledged.
   */
  it('keeps the text in the box when the post fails', async () => {
    const onComment = vi.fn(() => Promise.resolve(false));
    renderTaskDetail(root, task(), detailHandlers({ onComment }), {
      loading: false,
      threads: [],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'This is below the API work.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('This is below the API work.');
    expect(ta.disabled).toBe(false);
  });

  // Positive control: the box does empty on the ordinary path, so the test
  // above is about the failure and not about a box that never clears.
  it('empties the box once the post is acknowledged', async () => {
    const onComment = vi.fn(() => Promise.resolve(true));
    renderTaskDetail(root, task(), detailHandlers({ onComment }), {
      loading: false,
      threads: [],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Agreed, it goes first.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(ta.value).toBe('');
  });

  it('an empty box posts nothing', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment }), { loading: false, threads: [] });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = '   ';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).not.toHaveBeenCalled();
  });

  // A resolved thread is still part of the argument. Hiding it here would
  // repeat the drawer bug where a reply existed in the store and no surface
  // could reach it.
  it('keeps a resolved thread visible, marked as resolved', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-r', status: 'resolved' })],
    });
    const el = root.querySelector('.hub-thread') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.classList.contains('resolved')).toBe(true);
  });

  // Grounded in the fetch, not inferred from anything: the panel says
  // "loading" only while a load is actually in flight.
  it('distinguishes "still loading" from "nothing to say yet"', () => {
    renderTaskDetail(root, task(), detailHandlers(), { loading: true, threads: [] });
    expect(root.querySelector('.hub-discussion-loading')).toBeTruthy();
    expect(root.querySelector('.hub-discussion-empty')).toBeNull();

    renderTaskDetail(root, task(), detailHandlers(), { loading: false, threads: [] });
    expect(root.querySelector('.hub-discussion-loading')).toBeNull();
    expect(root.querySelector('.hub-discussion-empty')).toBeTruthy();
  });

  it('renders comment text as inert markup', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [
        thread({
          comments: [{ author: 'Jordan', text: '<img src=x onerror="boom()"> **real**', ts: NOW }],
        }),
      ],
    });
    const body = root.querySelector('.hub-comment-body') as HTMLElement;
    expect(body.querySelector('img')).toBeNull();
    expect(body.innerHTML).toContain('<strong>real</strong>');
  });

  // Without a discussion argument at all the panel is exactly what it was —
  // the hub renders detail before the threads have been fetched.
  it('renders with no discussion supplied', () => {
    renderTaskDetail(root, task({ title: 'Wire the index' }), detailHandlers());
    expect(root.querySelector('.hub-detail-title')?.textContent).toBe('Wire the index');
    expect(root.querySelector('.hub-comment-form')).toBeNull();
  });
});

/**
 * A comment can land while the panel is open — an agent replying to the
 * question you just asked is the case the whole surface is for. Repainting
 * the panel is how that reply appears, and repainting rebuilds the composer,
 * so the refresh has to know when someone's hands are on it.
 */
describe('discussionIsBusy', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const open = () =>
    renderTaskDetail(
      root,
      task(),
      {
        onClose: vi.fn(),
        onStatusSet: vi.fn(),
        onTitleCommit: vi.fn(),
        onAnswer: vi.fn(),
        onAssign: vi.fn(),
        onComment: vi.fn(),
      },
      { loading: false, threads: [] },
    );

  // Positive control for the two below: an untouched composer is refreshable,
  // so "busy" is a statement about the typing and not about the panel.
  it('is quiet when the composer is empty and unfocused', () => {
    open();
    expect(root.querySelector('.hub-discussion textarea')).toBeTruthy();
    expect(discussionIsBusy(root)).toBe(false);
  });

  it('is busy while a draft is sitting in the composer', () => {
    open();
    const ta = root.querySelector('.hub-discussion textarea') as HTMLTextAreaElement;
    ta.value = 'I think this is below the API work because';
    expect(discussionIsBusy(root)).toBe(true);
  });

  // Focus alone counts: someone who has tapped in has not typed a character
  // yet, and yanking the field out from under them is the same rudeness.
  it('is busy while the composer has focus', () => {
    open();
    const ta = root.querySelector('.hub-discussion textarea') as HTMLTextAreaElement;
    ta.focus();
    expect(discussionIsBusy(root)).toBe(true);
  });
});

describe('renderQuickAdd', () => {
  it('captures on Enter and clears, and Shift+Enter does not file a half-typed idea', async () => {
    const onCapture = vi.fn(() => Promise.resolve(true));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'Rework the strip';
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    expect(onCapture).not.toHaveBeenCalled();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('Rework the strip', undefined);
    // Cleared, so the next idea starts empty rather than appended to the last.
    await Promise.resolve();
    expect(box.value).toBe('');
  });

  it('files nothing for whitespace, from either the key or the button', () => {
    const onCapture = vi.fn(() => Promise.resolve(true));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = '   ';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    (root.querySelector('.hub-quick-form') as HTMLFormElement).dispatchEvent(
      new Event('submit', { cancelable: true }),
    );
    expect(onCapture).not.toHaveBeenCalled();
  });

  /**
   * Clearing on dispatch rather than on success means an offline phone eats
   * the idea and shows a toast — the one failure this box exists to prevent,
   * at the exact moment (no signal, thought half-formed) it matters most.
   */
  it('keeps the text when the capture fails, and clears it when it lands', async () => {
    let outcome = Promise.resolve(false);
    renderQuickAdd(root, { onCapture: () => outcome });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'Rework the strip';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await outcome;
    expect(box.value).toBe('Rework the strip');

    outcome = Promise.resolve(true);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await outcome;
    // Positive control: the same box does clear once the task really lands.
    expect(box.value).toBe('');
  });

  it('does not file the same idea twice while the first one is in flight', async () => {
    let release = (_ok: boolean) => {};
    const onCapture = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'Rework the strip';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledTimes(1);
    release(true);
    await Promise.resolve();
  });

  // The board repaints on every ydoc change. A composer that re-rendered with
  // it would take the caret out of a half-typed idea — which is the exact
  // friction this box exists to remove, reintroduced by the region pattern
  // every other renderer here follows.
  it('mounts once and leaves a half-typed idea alone on a repaint', () => {
    const stub = () => Promise.resolve(true);
    renderQuickAdd(root, { onCapture: stub });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'half an idea';
    renderQuickAdd(root, { onCapture: stub });
    expect(root.querySelectorAll('.hub-quick-input')).toHaveLength(1);
    expect((root.querySelector('.hub-quick-input') as HTMLTextAreaElement).value).toBe(
      'half an idea',
    );
  });
});

/**
 * A percentage max-width on a grid item resolves against its own grid AREA.
 * `.hub-task-badges` sits in an `auto` track — a track sized FROM the item —
 * so `max-width: 30%` meant "30% of yourself", and with `overflow: hidden`
 * the `decision` pill rendered as the two letters "de" on a phone. Nothing
 * else in this suite can see it: happy-dom has no layout, the DOM is
 * identical either way, and the row's grid template is already asserted
 * above and was correct the whole time. Found by looking at a staging board
 * at 430px, which is the only way this class of defect is ever found.
 */
describe('the row badges are capped against the viewport, not against themselves', () => {
  it('never uses a percentage max-width on .hub-task-badges', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    // vitest runs from the repo root (vitest.config.ts lives there).
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rules = [...css.matchAll(/\.hub-task-badges\s*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    // Positive control: the rules this asserts about really were found, and
    // one of them really does cap the width.
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.some((r) => /max-width/.test(r))).toBe(true);
    for (const r of rules) expect(r).not.toMatch(/max-width:\s*[\d.]+%/);
  });
});

/**
 * happy-dom does no layout, so nothing else in this suite can see a sticky
 * bar painting over a button. What it CAN see is the invariant: the media
 * block that makes the nav sticky must also reserve its height in the
 * scroller, or the card's last control ends up under it.
 */
describe('the sticky walkthrough nav reserves its own height', () => {
  it('gives the card bottom clearance wherever the nav is sticky', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    // The media blocks are the unit: sticky nav and card clearance have to
    // travel together, so find the block and assert about that one text.
    // Brace-scanned rather than regexed — a media block holds nested rules,
    // and a pattern that assumes otherwise matches nothing and proves nothing.
    const blocks: string[] = [];
    for (const m of css.matchAll(/@media[^{]*\{/g)) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
      }
      blocks.push(css.slice(start, i - 1));
    }
    const sticky = blocks.filter((b) => /\.hub-walk-nav\s*\{[^}]*position:\s*sticky/.test(b));
    // Positive control: the block this asserts about exists and was matched.
    expect(sticky.length).toBeGreaterThan(0);
    for (const b of sticky) {
      expect(b).toMatch(/\.hub-walk-card\s*\{[^}]*padding-bottom:\s*[\d.]+px/);
    }
  });
});

describe('renderPresence — plugin drift', () => {
  const drift = () =>
    pluginDriftNotice({
      version: '0.1.26',
      behind: [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }],
    });

  it('shows the notice even when nobody is present to draw a chip for', () => {
    // An away session draws no chip, and an away session is exactly the one
    // most likely to be stranded on an old bundle. Hiding the region on
    // "no chips" would hide the drift with it.
    const host = document.createElement('div');
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [drift()]);
    expect(host.classList.contains('hidden')).toBe(false);
    const note = host.querySelector('.hub-drift');
    expect(note?.textContent).toContain('older plugin than 0.1.26');
    expect(note?.textContent).toContain('agent-quill 0.1.12');
    expect(note?.textContent).toContain(
      'command claude plugin update live-feedback@claude-live-feedback',
    );
  });

  it('renders nothing extra when every agent is current', () => {
    const host = document.createElement('div');
    // Positive control: the same call WITH a notice puts a .hub-drift in, so
    // this absence means the notice is what drives it.
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [drift()]);
    expect(host.querySelector('.hub-drift')).not.toBeNull();

    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [null]);
    expect(host.querySelector('.hub-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });
});

describe('renderPresence — client release drift', () => {
  const now = Date.UTC(2026, 7, 16, 12, 0, 0);
  const stale = () =>
    clientDriftNotice(
      {
        releaseId: '20260813T014455123Z-000003',
        publishedAt: now - 72 * 60 * 60 * 1000,
        ageMs: 72 * 60 * 60 * 1000,
        sourceRef: 'a1b2c3d',
        consecutiveFailures: 2,
        failingSince: now - 10 * 60 * 60 * 1000,
        lastError: 'client release: markdownApp bundle is incomplete — app.js missing',
        stale: true,
      },
      now,
    );
  const pluginDrift = () =>
    pluginDriftNotice({
      version: '0.1.26',
      behind: [{ agentId: 'agent-quill', pluginVersion: '0.1.12' }],
    });

  it('shows the stale-client notice on a board with nobody present', () => {
    // Nobody being present is not a reason to hide it — it is about every
    // browser that loads this board, including the one reading it now.
    const host = document.createElement('div');
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [stale()]);
    expect(host.classList.contains('hidden')).toBe(false);
    const note = host.querySelector('.hub-drift');
    expect(note?.textContent).toContain('3d ago');
    expect(note?.textContent).toContain('app.js missing');
    expect(note?.textContent).toContain('restart');
  });

  it('shows both drifts at once — they are different problems', () => {
    // The agents being behind on the plugin and the browser being behind on
    // the client are independent failures with different fixes; one must not
    // hide the other.
    const host = document.createElement('div');
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [
      pluginDrift(),
      stale(),
    ]);
    const notes = [...host.querySelectorAll('.hub-drift')];
    expect(notes.length).toBe(2);
    expect(notes[0]?.textContent).toContain('older plugin than 0.1.26');
    expect(notes[1]?.textContent).toContain('published 3d ago');
  });

  it('draws nothing when neither drift is real', () => {
    const host = document.createElement('div');
    // Positive control first, so the absence below means something.
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [stale()]);
    expect(host.querySelector('.hub-drift')).not.toBeNull();

    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [null, null]);
    expect(host.querySelector('.hub-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });
});

describe('renderQuickAdd — dictating into the box', () => {
  /** The parts `mountVoice` is handed, captured at mount. */
  type VoiceParts = Parameters<NonNullable<QuickAddHandlers['mountVoice']>>[0];
  function mount(onCapture = vi.fn(() => Promise.resolve(true))) {
    const sink: VoiceParts[] = [];
    renderQuickAdd(root, { onCapture, mountVoice: (p) => void sink.push(p) });
    const parts = sink[0];
    if (!parts) throw new Error('mountVoice was never called');
    return {
      onCapture,
      parts,
      box: root.querySelector('.hub-quick-input') as HTMLTextAreaElement,
    };
  }

  it('hands the voice layer a button that lives inside the form', () => {
    // Inside the form, not floating next to it: the mic has to be reachable
    // with the thumb that is already on the box, on a phone.
    const { parts } = mount();
    expect(parts.button.closest('.hub-quick-form')).not.toBeNull();
    expect(parts.button.type).toBe('button'); // never submits the form
  });

  it('appends what was said to what was typed, and files both with the quote', async () => {
    const { onCapture, parts, box } = mount();
    box.value = 'Fix the goal card';
    parts.deliver('it is too tall on a phone');
    expect(box.value).toBe('Fix the goal card it is too tall on a phone');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith(
      'Fix the goal card it is too tall on a phone',
      'it is too tall on a phone',
    );
    await Promise.resolve();
  });

  it('does not file the previous utterance as the next task’s quote', async () => {
    // The failure this guards: dictate one task, file it, TYPE the next one,
    // and the second task carries words its author never said about it.
    const { onCapture, parts, box } = mount();
    parts.deliver('add a mic to the board');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await Promise.resolve();
    expect(box.value).toBe('');

    box.value = 'ship the release notes';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenLastCalledWith('ship the release notes', undefined);
  });

  it('forgets the utterance when the person clears the box themselves', () => {
    const { onCapture, parts, box } = mount();
    parts.deliver('add a mic to the board');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.value = 'something else entirely';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('something else entirely', undefined);
  });

  it('keeps the quote when a misheard word is corrected before filing', () => {
    // Editing the text must NOT drop the quote — the agent seeing both the
    // corrected task and the raw utterance is the reason to keep one.
    const { onCapture, parts, box } = mount();
    parts.deliver('add a mike to the board');
    box.value = 'add a mic to the board';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('add a mic to the board', 'add a mike to the board');
  });

  it('keeps an utterance dictated while the previous capture was in flight', async () => {
    // The box deliberately stays live during the POST. `deliver` appends, so
    // the accumulated quote is now BOTH utterances — clearing it wholesale on
    // the resolve files the second idea with no record of what was said.
    let settle: ((ok: boolean) => void) | undefined;
    const onCapture = vi.fn(
      () =>
        new Promise<boolean>((r) => {
          settle = r;
        }),
    );
    const { parts, box } = mount(onCapture);
    parts.deliver('fix the login bug');
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('fix the login bug', 'fix the login bug');

    parts.deliver('also update the docs');
    settle?.(true);
    await Promise.resolve();
    await Promise.resolve();

    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenLastCalledWith(
      'fix the login bug also update the docs',
      'also update the docs',
    );
  });

  it('drops the quote when the box is retyped from scratch', () => {
    // Select-all-and-retype is ONE input event with a non-empty value, so the
    // "emptied by hand" reset never fires and the new task would be filed
    // quoting an utterance about entirely different work.
    const { onCapture, parts, box } = mount();
    parts.deliver('buy milk');
    box.value = 'review the deploy script';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('review the deploy script', undefined);
  });

  it('mounts the dictation indicator hidden', () => {
    // `flex-basis: 100%` in a wrapping row: visible from first paint it claims
    // its own flex line, so the form sheds a row-gap the first time anything
    // is dictated and never gets it back.
    const { parts } = mount();
    expect(parts.indicator.className).toContain('hub-quick-mic-state');
    expect(parts.indicator.classList.contains('hidden')).toBe(true);
  });

  it('still mounts, and still captures, with no voice layer at all', () => {
    // Positive control for the whole describe: every assertion above depends
    // on mountVoice being called, so a build where speech is unavailable must
    // be shown to leave the typed path exactly as it was.
    const onCapture = vi.fn(() => Promise.resolve(true));
    renderQuickAdd(root, { onCapture });
    const box = root.querySelector('.hub-quick-input') as HTMLTextAreaElement;
    box.value = 'typed only';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onCapture).toHaveBeenCalledWith('typed only', undefined);
  });
});

/**
 * Wiring, asserted against the source, because the failure is silent.
 *
 * `hub-app.ts` mounts two voice captures on one page. Space is a singleton
 * gesture: if both bind it, one press starts both recognizers and each
 * finalizes its own transcript — the utterance goes to the agent AND into the
 * capture box, and nothing errors. Only one of the two may own Space, and no
 * unit test on `createVoiceCapture` can see which mounts opted out.
 */
describe('hub-app voice wiring', () => {
  /** Comment lines stripped — prose ABOUT `spaceHotkey: false` must not count
   *  as a call site that sets it. (It did, on the first run of this test.) */
  function code(): string {
    const src = readFileSync(resolve('packages/markdown-app/src/hub/hub-app.ts'), 'utf8');
    return src
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
  }

  it('mounts exactly one capture that owns the Space hotkey', () => {
    const src = code();
    const mounts = src.split('createVoiceCapture({').length - 1;
    // Positive control: this counts real call sites, not zero of them.
    expect(mounts).toBe(2);
    expect(src.split('spaceHotkey: false').length - 1).toBe(mounts - 1);
  });

  it('the dictation ack does not claim the task was filed', () => {
    // The whole design point is that dictation does NOT file — it fills the
    // box and waits for a tap. "Added" is the one word that says it did.
    const src = code();
    const mountVoice = src.slice(src.indexOf('mountVoice:'));
    const body = mountVoice.slice(0, mountVoice.indexOf('\n    });'));
    const ack = /ack:\s*'([^']*)'/.exec(body)?.[1];
    // Positive control: the assertions below are about a string we found, not
    // about `undefined` quietly satisfying every `not.toMatch`.
    expect(ack).toBeTruthy();
    expect(ack).not.toMatch(/\b(added|created|filed|captured|saved)\b/i);
    // And it still names the tap that would file it.
    expect(ack).toMatch(/\bAdd\b/);
  });

  it('never files a dictated task without a human tap', () => {
    // The quick-add mic delivers into the box; only Add / Enter files. A
    // `send` that POSTed would file whatever the recognizer heard.
    const src = code();
    const mountVoice = src.slice(src.indexOf('mountVoice:'));
    const body = mountVoice.slice(0, mountVoice.indexOf('\n    });'));
    expect(body).toContain('deliver(transcript)');
    expect(body).not.toContain('captureTask');
  });
});
