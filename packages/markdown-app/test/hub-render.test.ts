import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type UptimeReport,
  boardSections,
  decisionQueue,
  goalLabel,
} from '../src/hub/hub-model.ts';
import {
  type BoardHandlers,
  type TaskThread,
  discussionIsBusy,
  renderActivity,
  renderBoard,
  renderDecisions,
  renderGoalStrip,
  renderLeadStrip,
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
      'hub-status-select',
      'hub-risk-slot',
      'hub-task-title',
      'hub-task-badges',
      'hub-row-assignee',
    ]);
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

describe('renderDecisions', () => {
  it('shows a chip per open decision and opens it on tap', () => {
    const onOpen = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human', title: 'Ship now or wait?' });
    const strip = { onOpen, onWalkthrough: vi.fn() };
    renderDecisions(root, decisionQueue([d]), strip);
    const chip = root.querySelector('.hub-decision-chip') as HTMLElement;
    expect(chip.textContent).toContain('Ship now or wait?');
    chip.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
    // Empty → the strip hides instead of rendering an empty shell.
    renderDecisions(root, decisionQueue([]), strip);
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
    expect(onGoalCommit).toHaveBeenCalledWith('Ship search v3.');
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
    );
  });

  it('replies go to the thread they were typed under', () => {
    const onComment = vi.fn();
    const t = task();
    renderTaskDetail(root, t, detailHandlers({ onComment }), {
      loading: false,
      threads: [thread({ id: 'th-77' })],
    });
    const reply = root.querySelector('.hub-reply-form') as HTMLFormElement;
    const ta = reply.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Because it unblocks two others.';
    reply.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'Because it unblocks two others.',
      'th-77',
    );
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
