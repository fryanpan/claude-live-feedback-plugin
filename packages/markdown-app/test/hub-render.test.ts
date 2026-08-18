import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type ReviewItem,
  type UptimeReport,
  boardSections,
  clientDriftNotice,
  goalLabel,
  pluginDriftNotice,
  reviewQueue,
  unplacedNotice,
} from '../src/hub/hub-model.ts';
import {
  type BoardHandlers,
  type QuickAddHandlers,
  type TaskThread,
  discussionIsBusy,
  renderActivity,
  renderBoard,
  renderGoalStrip,
  renderHomeBrief,
  renderHomeReview,
  renderLeadStrip,
  renderPresence,
  renderQuickAdd,
  renderReviewBanner,
  renderTaskDetail,
  renderUnplacedStrip,
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

  // The inverse of what this test used to assert. The row carried a `💬 N`
  // badge; Bryan asked for it off the board on 2026-08-18 ("taking up space
  // for no reason"), knowing the cost — see the note in `taskBadges`. Pinned
  // as an absence so nothing re-adds it by accident, with two positive
  // controls in the same pass: another badge on the SAME row still renders
  // (so this is not "badges are broken"), and the count still reaches the
  // detail panel's discussion section.
  it('puts no discussion badge on a row, while other row badges still render', () => {
    const h = handlers();
    const discussed = task({ goal: 'g-pr', commentCount: 3, needs: 'decision' });
    renderBoard(root, boardSections(GOALS, [discussed], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${discussed.id}"]`);
    expect(row).not.toBeNull();
    // Control: the strip is alive and this row's other badge is in it.
    expect(row?.querySelector('.hub-badge-decision')).not.toBeNull();
    expect(row?.querySelector('.hub-badge-comments')).toBeNull();
    // …and no badge anywhere on the row spells the count either, which is what
    // a differently-classed replacement glyph would do.
    expect(row?.querySelector('.hub-task-badges')?.textContent ?? '').not.toContain('3');
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

  // The regression this pins, and the reason the risk dot could not simply be
  // dropped from the row renderer: `grid-template-columns` names N tracks and
  // grid auto-placement fills them CONSECUTIVELY, so a row emitting fewer
  // children than there are tracks slides every later cell one track LEFT.
  // That is how the title once landed in the risk dot's track — collapsed to
  // `0` by a `:not(:has(.hub-risk))` rule — and rendered at zero width on
  // every row without a tier, which was most rows.
  //
  // happy-dom runs no layout engine, so "the title is 0px wide" is not
  // measurable here; the browser pass on a real 430px build closes that half.
  // What IS measurable, and what actually DECIDES the width, is the
  // relationship between the two files: how many children `taskRow` emits, how
  // many tracks the stylesheet declares, and WHICH track the title lands on.
  // With the counts equal and the title's index equal to the `minmax(0, 1fr)`
  // track's index, no track can be both collapsed and holding the title.
  it('puts the title on the flexible track, with one child per declared grid track', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(
        GOALS,
        [
          // Deliberately varied: no badges / one badge / several badges. All
          // three must produce the same shape, because the row's guarantee is
          // that children which don't apply are inert, not absent — and the
          // empty-strip row is the one the risk-dot removal newly created.
          task({ goal: 'g-pr', id: 't-plain', title: 'no badges at all' }),
          task({ goal: 'g-pr', id: 't-one', title: 'one badge', needs: 'decision' }),
          task({
            goal: 'g-pr',
            id: 't-loud',
            title: 'several badges',
            needs: 'decision',
            after: ['t-plain'],
            dueAt: NOW - 86_400_000,
            commentCount: 3,
          }),
        ],
        filters,
      ),
      h,
    );
    const rows = [...root.querySelectorAll('.hub-task-row')] as HTMLElement[];
    expect(rows).toHaveLength(3);
    const shape = (r: HTMLElement) =>
      [...r.children].map((c) => (c as HTMLElement).className.split(' ')[0]);
    // Positive control FIRST: these really are different rows, so the shapes
    // agreeing below is not three empty rows agreeing about nothing.
    expect(rows[2].querySelectorAll('.hub-badge').length).toBeGreaterThan(0);
    expect(rows[0].querySelectorAll('.hub-badge')).toHaveLength(0);

    expect(shape(rows[1])).toEqual(shape(rows[0]));
    expect(shape(rows[2])).toEqual(shape(rows[0]));

    // The stylesheet's own declaration, read rather than restated — a literal
    // count here would just be a second place to forget to update.
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const decl = /\.hub-task-row\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(css)?.[1];
    expect(decl).toBeDefined();
    // `minmax(0, 1fr)` holds a space after its comma, so split on whitespace
    // that is not inside parentheses.
    const tracks = (decl as string).trim().split(/\s+(?![^(]*\))/);
    expect(tracks.length).toBeGreaterThan(1); // control: the split found tracks

    expect(shape(rows[0])).toHaveLength(tracks.length);
    const titleIndex = shape(rows[0]).indexOf('hub-task-title');
    expect(titleIndex).toBeGreaterThan(-1);
    expect(tracks[titleIndex]).toContain('1fr');
    // …and it is the ONLY flexible track, so "the title ellipsizes, everything
    // else is content-sized" stays true and the title cannot be squeezed to 0
    // by a sibling claiming the free space.
    expect(tracks.filter((t) => t.includes('fr'))).toHaveLength(1);
  });

  // Risk left the product on 2026-08-18 (Bryan: "over engineering … taking up
  // space for nothing", then "kill the risk gate and dot"), so neither surface
  // shows a tier any more — not the row, and not the detail panel, whose one
  // line existed to explain the gate when it fired. Both absences get a live
  // positive control in the same pass, because a board or a panel that failed
  // to render would report the same emptiness.
  it('shows no risk anywhere — not on the row, not in the detail panel', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    expect(root.querySelectorAll('.hub-task-row')).toHaveLength(1); // control
    expect(root.querySelector('.hub-risk')).toBeNull();
    expect(root.querySelector('.hub-risk-slot')).toBeNull();

    const panel = document.createElement('div');
    renderTaskDetail(panel, t, {
      onClose: vi.fn(),
      onStatusSet: vi.fn(),
      onTitleCommit: vi.fn(),
      onAnswer: vi.fn(),
      onAssign: vi.fn(),
    });
    // Control: the panel really did render its meta list.
    expect(panel.querySelectorAll('.hub-detail-meta dt').length).toBeGreaterThan(0);
    expect(panel.textContent).not.toContain('Risk');
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
  // Four states, not three. A named owner used to be drawn as an agent
  // whatever they were — so a person named Bryan and an agent were the same
  // mark — and the row now reads the kind the SERVER resolved (`ownerKind`)
  // rather than inferring one from the name. `hub-owner-unknown` is the state
  // that fold used to hide.
  it('marks a person, an agent, an undeclared owner and nobody apart', () => {
    const h = handlers({ knownAgentIds: ['Index Rebuild'] });
    const rows = [
      task({ goal: 'g-pr', order: 1, assignee: 'human' }),
      task({ goal: 'g-pr', order: 2, assignee: 'Index Rebuild', ownerKind: 'agent' }),
      task({ goal: 'g-pr', order: 3, assignee: 'Wren Halloway', ownerKind: 'person' }),
      task({ goal: 'g-pr', order: 4, assignee: 'Wren Halloway' }),
      task({ goal: 'g-pr', order: 5, assignee: 'agent' }),
    ];
    renderBoard(root, boardSections(GOALS, rows, filters), h);
    const classes = [...root.querySelectorAll('.hub-row-assignee')].map((el) =>
      [...el.classList].filter((c) => c.startsWith('hub-owner-')).join(),
    );
    expect(classes).toEqual([
      'hub-owner-human',
      'hub-owner-agent',
      'hub-owner-human',
      'hub-owner-unknown',
      'hub-owner-none',
    ]);
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

describe('renderHomeReview', () => {
  const strip = () => ({ onOpen: vi.fn(), onWalkthrough: vi.fn() });

  const threadItem = (over: Record<string, unknown> = {}) => ({
    kind: 'task-thread' as const,
    docId: 'task:t-x',
    threadId: `th-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 't-x',
    title: 'Some task',
    ask: 'Which repo does this land in?',
    askedBy: 'Helper',
    since: NOW - 2 * 86_400_000,
    direct: false,
    ...over,
  });

  it('heads the section "For Your Review" with the dark Review All button that starts the walkthrough', () => {
    const h = strip();
    const d = task({ needs: 'decision', assignee: 'human' });
    renderHomeReview(root, reviewQueue([d], [], NOW), h);
    expect(root.querySelector('.hub-home-heading')?.textContent).toBe('For Your Review');
    const go = root.querySelector('.hub-review-go') as HTMLButtonElement;
    expect(go.textContent).toBe('Review All');
    expect(go.className).toContain('hub-btn-ink');
    go.click();
    expect(h.onWalkthrough).toHaveBeenCalledTimes(1);
  });

  it('renders each item as a ranked row: the question as the title, the wait as the subline', () => {
    const h = strip();
    const d = task({ needs: 'decision', assignee: 'human', title: 'Ship now or wait?' });
    renderHomeReview(root, reviewQueue([d], [threadItem()], NOW), h, [], NOW);
    const rows = [...root.querySelectorAll('.hub-review-row')];
    expect(rows).toHaveLength(2);
    // The decision title IS the question; the thread row shows its ask, not
    // its task title — the row is the question itself (mockup anatomy).
    expect(rows[0]?.querySelector('.hub-review-row-title')?.textContent).toBe('Ship now or wait?');
    expect(rows[1]?.querySelector('.hub-review-row-title')?.textContent).toBe(
      'Which repo does this land in?',
    );
    expect(rows[1]?.querySelector('.hub-review-row-sub')?.textContent).toBe('waiting 2 days');
    (rows[1] as HTMLElement).click();
    expect(h.onOpen).toHaveBeenCalledTimes(1);
  });

  it('highlights the top live row — the one the walkthrough would open on', () => {
    const d = task({ needs: 'decision', assignee: 'human' });
    renderHomeReview(root, reviewQueue([d], [threadItem()], NOW), strip());
    const rows = [...root.querySelectorAll('.hub-review-row')];
    expect(rows[0]?.className).toContain('hub-review-row-current');
    expect(rows[1]?.className).not.toContain('hub-review-row-current');
  });

  it('empty queue says so plainly and offers no Review All', () => {
    renderHomeReview(root, reviewQueue([], [], NOW), strip());
    expect(root.querySelector('.hub-home-quiet')?.textContent).toContain(
      'Nothing is waiting for your review',
    );
    expect(root.querySelector('.hub-review-go')).toBeNull();
  });

  it('keeps settled items in the stack struck through, and only ones the queue really dropped', () => {
    const d = task({ needs: 'decision', assignee: 'human', title: 'Still open?' });
    const queue = reviewQueue([d], [], NOW);
    const stillLive = queue.items[0] as ReviewItem;
    const settledGone: ReviewItem = {
      key: 'decision:t-gone',
      kind: 'decision',
      title: 'Already answered one',
      ask: '',
      why: '',
      since: NOW - 3_600_000,
    };
    const h = strip();
    renderHomeReview(root, queue, h, [stillLive, settledGone]);
    // The still-open item renders once, as a live row — not twice.
    const titles = [...root.querySelectorAll('.hub-review-row-title')].map((n) => n.textContent);
    expect(titles.filter((t) => t === 'Still open?')).toHaveLength(1);
    const done = root.querySelector('.hub-review-row-done') as HTMLElement;
    expect(done.textContent).toContain('Already answered one');
    expect(done.querySelector('.hub-review-row-sub')?.textContent).toContain('answered');
    // A done row is still the way back to the thing just answered.
    done.click();
    expect(h.onOpen).toHaveBeenCalledWith(settledGone);
  });
});

describe('renderReviewBanner', () => {
  it('renders one line and a way to Home while items are open, nothing at all when none are', () => {
    const onGoHome = vi.fn();
    const d = task({ needs: 'decision', assignee: 'human' });
    renderReviewBanner(root, reviewQueue([d], [], NOW), { onGoHome });
    expect(root.querySelector('.hub-review-banner-text')?.textContent).toBe(
      'Something is waiting for your review',
    );
    (root.querySelector('.hub-review-banner-go') as HTMLElement).click();
    expect(onGoHome).toHaveBeenCalledTimes(1);
    // The banner exists only while items are open (approved design) — an
    // empty queue hides it entirely rather than announcing an all-clear.
    renderReviewBanner(root, reviewQueue([], [], NOW), { onGoHome });
    expect(root.classList.contains('hidden')).toBe(true);
    expect(root.children).toHaveLength(0);
  });

  it('still renders one countless line when several kinds are waiting', () => {
    const d = task({ needs: 'decision', assignee: 'human' });
    const thread = {
      kind: 'task-thread' as const,
      docId: 'task:t-b',
      threadId: 'th-b',
      title: 'Some task',
      ask: 'Green or blue?',
      askedBy: 'Helper',
      since: NOW - 60_000,
    };
    renderReviewBanner(root, reviewQueue([d], [thread], NOW), { onGoHome: vi.fn() });
    const text = root.querySelector('.hub-review-banner-text')?.textContent;
    expect(text).toBe('Something is waiting for your review');
    expect(text).not.toMatch(/\d/);
  });
});

describe('renderHomeBrief', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    workspaceId: 'w-1',
    lastReadAt: 0,
    since: NOW - 1000,
    instructions: 'Under 200 words.',
    brief: {
      markdown: '**Finished:** the retry rewrite landed.',
      generatedAt: NOW,
      source: 'deterministic' as const,
    },
    generating: false,
    ...over,
  });

  it('renders the brief as markdown under "What\'s New?", with the window in the head row', () => {
    renderHomeBrief(root, payload(), NOW, false, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions: vi.fn(),
      onEditRecipe: vi.fn(),
    });
    expect(root.querySelector('.hub-home-heading')?.textContent).toBe("What's New?");
    expect(root.querySelector('.hub-home-brief-body strong')?.textContent).toBe('Finished:');
    // The since-line is the window's real start, worded like the mockup —
    // "From <point> until now" — and it sits in the head row by the heading.
    const since = root.querySelector('.hub-home-review-head .hub-home-since');
    expect(since?.textContent).toMatch(/^From .+ until now$/);
    expect(since?.textContent).not.toContain('Updating');
  });

  it('generating appends Updating… to the window line', () => {
    renderHomeBrief(root, payload({ generating: true }), NOW, false, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions: vi.fn(),
      onEditRecipe: vi.fn(),
    });
    const since = root.querySelector('.hub-home-since')?.textContent ?? '';
    expect(since).toMatch(/^From .+ until now/);
    expect(since).toContain('Updating…');
  });

  it('Mark read is the dark button on the right; the edit link sits left and opens the editor', () => {
    const onMarkCaughtUp = vi.fn();
    const onEditRecipe = vi.fn();
    renderHomeBrief(root, payload(), NOW, false, {
      onMarkCaughtUp,
      onSaveInstructions: vi.fn(),
      onEditRecipe,
    });
    const mark = root.querySelector('.hub-home-mark-read') as HTMLElement;
    // Verbatim from the mockup: "Mark read", dark, bottom-right. ("Mark
    // caught up" was a judgment call and was rejected.)
    expect(mark.textContent).toBe('Mark read');
    expect(mark.className).toContain('hub-btn-ink');
    mark.click();
    expect(onMarkCaughtUp).toHaveBeenCalledTimes(1);
    const actions = root.querySelector('.hub-home-brief-actions') as HTMLElement;
    // DOM order: link first (left), Mark read last (right).
    expect(actions.firstElementChild?.classList.contains('hub-home-edit-recipe')).toBe(true);
    expect(actions.lastElementChild).toBe(mark);
    expect(root.querySelector('.hub-home-edit-recipe')?.textContent).toBe(
      'Edit how this gets generated',
    );
    (root.querySelector('.hub-home-edit-recipe') as HTMLElement).click();
    expect(onEditRecipe).toHaveBeenCalledWith(true);
    // Closed by default: the panel only exists when the app says it is open.
    expect(root.querySelector('.hub-home-recipe')).toBeNull();
  });

  it('the open recipe editor carries the exact approved copy and exactly two buttons', () => {
    const onSaveInstructions = vi.fn();
    const onEditRecipe = vi.fn();
    renderHomeBrief(root, payload(), NOW, true, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions,
      onEditRecipe,
    });
    expect(root.querySelector('.hub-home-recipe-hint')?.textContent).toBe(
      'Edit these instructions and they will be used on this summary and future summaries.',
    );
    const ta = root.querySelector('.hub-home-recipe-text') as HTMLTextAreaElement;
    expect(ta.value).toBe('Under 200 words.');
    const buttons = root.querySelectorAll('.hub-home-recipe button');
    expect([...buttons].map((b) => b.textContent)).toEqual(['Save & Update Summary', 'Cancel']);
    ta.value = 'Be terse.';
    (root.querySelector('.hub-home-recipe-save') as HTMLElement).click();
    expect(onSaveInstructions).toHaveBeenCalledWith('Be terse.');
    (root.querySelector('.hub-home-recipe-cancel') as HTMLElement).click();
    expect(onEditRecipe).toHaveBeenCalledWith(false);
  });

  it('a blank instructions box saves nothing — blanking the recipe is not expressible', () => {
    const onSaveInstructions = vi.fn();
    renderHomeBrief(root, payload(), NOW, true, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions,
      onEditRecipe: vi.fn(),
    });
    (root.querySelector('.hub-home-recipe-text') as HTMLTextAreaElement).value = '   ';
    (root.querySelector('.hub-home-recipe-save') as HTMLElement).click();
    expect(onSaveInstructions).not.toHaveBeenCalled();
  });

  it('no payload yet renders a loading line, not an empty card', () => {
    renderHomeBrief(root, null, NOW, false, {
      onMarkCaughtUp: vi.fn(),
      onSaveInstructions: vi.fn(),
      onEditRecipe: vi.fn(),
    });
    expect(root.querySelector('.hub-home-quiet')?.textContent).toBe('Loading…');
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

  // A NEW goal band nobody has re-looked at the bucket against. Its own chip,
  // because the two asks are settled by different moves — and because a board
  // that rendered only the north-star one would say "nothing waiting" while
  // this sat in a sidecar, which is the store-has-it/surface-can't-show-it
  // failure the projection next to it exists to prevent.
  const bucket = (taskIds: string[], bandTitles = ['Reviewer trust']) => ({
    batchId: 'b-2',
    taskIds,
    bandTitles,
    ts: 1_700_000_000_000,
    byName: 'Jordan',
  });

  it('a new goal band waiting on the lead is counted and named', () => {
    renderLeadStrip(
      root,
      'agent-relay',
      ['agent-relay'],
      { onLeadCommit: vi.fn() },
      undefined,
      bucket(['t-1', 't-2']),
    );
    const waiting = root.querySelector('.hub-lead-pending') as HTMLElement;
    expect(waiting.textContent).toContain('2 unplaced tasks');
    expect(waiting.textContent).toContain('New goal band waiting for the lead');
    expect(waiting.title).toContain('Reviewer trust');
    // It asks for a LOOK. A reader who takes this as "the bucket got emptied"
    // has been told the opposite of what happened.
    expect(waiting.title).toContain('Nothing has been placed');
  });

  it('with no lead at all the waiting band says nobody is going to do it', () => {
    renderLeadStrip(root, undefined, [], { onLeadCommit: vi.fn() }, undefined, bucket(['t-1']));
    const waiting = root.querySelector('.hub-lead-pending') as HTMLElement;
    expect(waiting.textContent).toContain('1 unplaced task');
    expect(waiting.textContent).toContain('nobody to do it');
  });

  it('both asks can be waiting at once, and each gets its own chip', () => {
    renderLeadStrip(
      root,
      'agent-relay',
      ['agent-relay'],
      { onLeadCommit: vi.fn() },
      pending(['t-1']),
      bucket(['t-2'], ['Reviewer trust', 'Mobile review']),
    );
    const chips = Array.from(root.querySelectorAll('.hub-lead-pending')) as HTMLElement[];
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain('to re-place');
    expect(chips[1]?.textContent).toContain('to re-look at');
    // Two bands are counted rather than one being picked to stand for both.
    expect(chips[1]?.title).toContain('2 new bands');
  });

  it('says nothing about a band when none is waiting', () => {
    // Non-vacuous because the three tests above render this same chip.
    renderLeadStrip(root, 'agent-relay', ['agent-relay'], { onLeadCommit: vi.fn() });
    expect(root.textContent).not.toContain('re-look at');
    renderLeadStrip(
      root,
      'agent-relay',
      ['agent-relay'],
      { onLeadCommit: vi.fn() },
      undefined,
      bucket([]),
    );
    expect(root.textContent).not.toContain('re-look at');
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

  // A shaped task carries the words it was shaped FROM, and an unlabelled
  // blockquote above a rewritten description cannot say which of the two
  // readings it is — "here is what you said" or "here is a source". Those want
  // opposite reactions from the reader, and every shaped row carries one.
  it('labels a preserved capture so it reads as provenance, not as a stray quote', () => {
    renderTaskDetail(
      root,
      task({
        quote: 'we should let people rename a goal without losing the tasks under it',
        body: 'Agent can rename a goal so that filed work survives the rename.',
      }),
      detailHandlers(),
    );
    const fig = root.querySelector('.hub-detail-quote-block');
    expect(fig).toBeTruthy();
    expect(fig?.querySelector('.hub-detail-quote-label')?.textContent).toBe('Original words');
    // The words themselves survive the wrapper — the label must not be the
    // only thing that made it into the DOM.
    expect(fig?.querySelector('.hub-detail-quote')?.textContent).toContain(
      'without losing the tasks under it',
    );
    // The label belongs to the quote, not to the panel: it is inside the
    // block, so nothing reads it as a heading over anything else.
    expect(root.querySelector('.hub-detail-quote-label')?.closest('.hub-detail-quote-block')).toBe(
      fig,
    );
  });

  // He sees his own superseded words above the description he maintains, every
  // time he opens the task. The ask was that they be MOVED and HIDDEN, never
  // dropped — so all three of these assert together, and the last one is what
  // stops "hidden" from being satisfied by deleting the preservation.
  it('keeps the preserved capture reachable but below the description, closed by default', () => {
    renderTaskDetail(
      root,
      task({
        quote: 'the original words, verbatim',
        body: 'Agent can rename a goal so that filed work survives the rename.',
      }),
      detailHandlers(),
    );
    const quote = root.querySelector('.hub-detail-quote-block') as HTMLDetailsElement;
    const desc = root.querySelector('.hub-detail-body');
    expect(quote).toBeTruthy();
    expect(desc).toBeTruthy();
    // Closed: `open` is absent, so the words are one tap away rather than in
    // the reader's face.
    expect(quote.hasAttribute('open')).toBe(false);
    // Below: DOCUMENT_POSITION_FOLLOWING from the description means the quote
    // comes after it. Asserted as a relationship rather than an index, so
    // inserting anything else between them cannot silently pass.
    expect(desc!.compareDocumentPosition(quote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Not dropped.
    expect(quote.textContent).toContain('the original words, verbatim');
  });

  it('shows no quote block at all on a task that never had one', () => {
    // Positive control first: the label renders when there IS a quote, so its
    // absence below means the branch was skipped rather than that this test
    // renders an empty panel.
    renderTaskDetail(root, task({ quote: 'the thing I actually said' }), detailHandlers());
    expect(root.querySelector('.hub-detail-quote-label')).toBeTruthy();

    renderTaskDetail(
      root,
      task({ body: 'A task filed with no captured words.' }),
      detailHandlers(),
    );
    expect(root.querySelector('.hub-detail-quote-block')).toBeNull();
    expect(root.querySelector('.hub-detail-quote-label')).toBeNull();
    // …on a panel that did render: the description is right there.
    expect(root.querySelector('.hub-detail-body')?.textContent).toContain('no captured words');
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

  const askItem = (over: Record<string, unknown> = {}) => ({
    kind: 'task-thread' as const,
    docId: 'task:t-1',
    threadId: 'th-1',
    taskId: 't-1',
    title: 'Some task',
    ask: 'Bryan: should we drop threading, or keep it for the 3 orphans?',
    askedBy: 'Live Feedback',
    since: NOW - 3_600_000,
    direct: true,
    ...over,
  });

  /**
   * The measured break in the review loop: the strip said something needed
   * him, and opening it showed a task rather than the request. The ask was
   * computed server-side and rendered on the strip the whole time — the panel
   * simply never received it.
   */
  /**
   * Found in a real browser at 430px, not in a unit test: opening a review
   * item left the panel at `scrollTop: 112` with the ask panel's heading cut
   * off above the fold. The deep link centres the focused thread, and the ask
   * panel had just hoisted that same thread's question to the top — so the
   * reader landed mid-page on a second copy of what they came for.
   *
   * happy-dom implements no `scrollIntoView`, so the element gets a stub and
   * the render's own `typeof === 'function'` guard does the rest.
   */
  const withScrollSpy = (fn: () => void): string[] => {
    const scrolled: string[] = [];
    const proto = (root.ownerDocument.defaultView as unknown as { Element: typeof Element }).Element
      .prototype as Element & { scrollIntoView?: unknown };
    const had = 'scrollIntoView' in proto;
    (proto as { scrollIntoView?: unknown }).scrollIntoView = function scrollIntoView(
      this: HTMLElement,
    ) {
      scrolled.push(this.dataset?.threadId ?? this.className);
    };
    try {
      fn();
    } finally {
      if (!had) {
        (proto as { scrollIntoView?: unknown }).scrollIntoView = undefined;
      }
    }
    return scrolled;
  };

  it('does not scroll past the ask panel to the thread it already quotes', () => {
    const scrolled = withScrollSpy(() => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        detailHandlers({ asks: [askItem({ threadId: 'th-1' })], now: NOW, focusThreadId: 'th-1' }),
        { loading: false, threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })] },
      );
    });
    // The panel is still aimed at that thread — this is about where the
    // viewport lands, not about losing the deep link.
    expect(root.querySelector('.hub-thread-focus')).toBeTruthy();
    expect(root.querySelector('.hub-detail-ask')).toBeTruthy();
    expect(scrolled).toEqual([]);
  });

  /** Positive control: the spy CAN see a scroll, and centring is still right
   *  when the focused thread is not the one the ask panel is quoting. */
  it('still centres a focused thread the ask panel is not about', () => {
    const scrolled = withScrollSpy(() => {
      renderTaskDetail(
        root,
        task({ id: 't-1' }),
        detailHandlers({ asks: [askItem({ threadId: 'th-1' })], now: NOW, focusThreadId: 'th-2' }),
        { loading: false, threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })] },
      );
    });
    expect(scrolled).toEqual(['th-2']);
  });

  it('states the ask at the top of the panel, above the description', () => {
    const t = task({ id: 't-1', body: 'The description, which is not the ask.' });
    renderTaskDetail(root, t, detailHandlers({ asks: [askItem()], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    const ask = root.querySelector('.hub-detail-ask');
    expect(ask).toBeTruthy();
    expect(ask?.textContent).toContain('should we drop threading');
    // Above the description — the requirement is "without scrolling on a
    // 430px phone", and a panel that opens on nine rows of identical metadata
    // spends the first screen on facts that are the same for every task.
    const desc = root.querySelector('.hub-detail-body');
    expect(desc).toBeTruthy();
    expect(ask!.compareDocumentPosition(desc!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and it says who is waiting, and how long they have been.
    expect(root.querySelector('.hub-detail-ask-meta')?.textContent).toContain('Live Feedback');
    expect(root.querySelector('.hub-detail-ask-meta')?.textContent).toContain('1h ago');
  });

  /** "Answer without leaving the screen you landed on." A button that scrolls
   *  to a composer further down the page satisfies that on a desktop only. */
  it('replies to the asking thread from the ask panel itself', async () => {
    const onComment = vi.fn().mockResolvedValue(true);
    const t = task({ id: 't-1' });
    renderTaskDetail(
      root,
      t,
      detailHandlers({ asks: [askItem({ threadId: 'th-9' })], now: NOW, onComment }),
      { loading: false, threads: [thread({ id: 'th-9' })] },
    );
    const form = root.querySelector('.hub-detail-ask-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Drop it, and prefix the 3 orphans.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // Posts onto the thread that asked, not into a new one — a reply that
    // opens a fresh thread is how an answer stops being an answer.
    expect(onComment).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      'Drop it, and prefix the 3 orphans.',
      'th-9',
    );
  });

  /**
   * Measured on the live board 2026-08-17: 23 review items, **0** of them
   * `direct` — every one an ellipsis-clipped PR announcement ("Done in PR
   * #154 — …") presented under a heading that reads as a question. Giving a
   * status note the words "what we need from you" is the reported defect, so
   * the heading has to tell the two apart.
   */
  it('does not call a status note a question', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      detailHandlers({
        asks: [askItem({ direct: false, ask: 'Done in PR #154 — CI green, not merged.' })],
        now: NOW,
      }),
      { loading: false, threads: [thread()] },
    );
    const kicker = root.querySelector('.hub-detail-ask-kicker')?.textContent ?? '';
    expect(kicker).not.toContain('need');
    // Says what is TRUE of the flag — nobody is named — rather than the
    // stronger claim that no question is present, which `direct` cannot
    // support at 1-in-3 recall.
    expect(kicker).toContain('not addressed to you by name');
    expect(kicker).not.toContain('no question');
    // The words are still shown — labelled honestly, not withheld.
    expect(root.querySelector('.hub-detail-ask-text')?.textContent).toContain('PR #154');
    expect(root.querySelector('.hub-detail-ask--direct')).toBeNull();
  });

  /** The positive control for the case above: the same renderer DOES give a
   *  real question the question heading, so the absence just asserted is a
   *  decision rather than a renderer that can only produce one string. */
  it('calls a direct question a question', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [askItem()], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    expect(root.querySelector('.hub-detail-ask-kicker')?.textContent).toContain(
      'What we need from you',
    );
    expect(root.querySelector('.hub-detail-ask--direct')).toBeTruthy();
  });

  it('shows no ask panel on a task nothing is waiting on', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    expect(root.querySelector('.hub-detail-ask')).toBeNull();
    // Positive control: the panel rendered at all, so the null above is about
    // the ask and not about an empty container.
    expect(root.querySelector('.hub-thread')).toBeTruthy();
  });

  /** Reported as "comments do not say who they are from, or whether they are a
   *  request for my input". The author was already there; the TIME was in a
   *  `title` attribute, which is a hover tooltip on a surface read on a
   *  phone, and the request marking did not exist at all. */
  it('shows each comment author and time as text, and marks a thread that is waiting', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      detailHandlers({ asks: [askItem({ threadId: 'th-w' })], now: NOW }),
      {
        loading: false,
        threads: [
          thread({
            id: 'th-w',
            comments: [{ author: 'Live Feedback', text: 'Which way?', ts: NOW - 7_200_000 }],
          }),
          thread({ id: 'th-quiet' }),
        ],
      },
    );
    const waiting = root.querySelector('.hub-thread[data-thread-id="th-w"]');
    expect(waiting?.querySelector('.hub-comment-author')?.textContent).toBe('Live Feedback');
    // Text, not a tooltip.
    expect(waiting?.querySelector('.hub-comment-when')?.textContent).toBe('2h ago');
    expect(waiting?.querySelector('.hub-thread-needs-you')).toBeTruthy();
    // Only the thread the server named — a mark on every thread marks nothing.
    expect(
      root.querySelector('.hub-thread[data-thread-id="th-quiet"] .hub-thread-needs-you'),
    ).toBeNull();
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

/**
 * The half `discussionIsBusy` cannot cover. That guard holds back a discussion
 * RELOAD while someone is typing, but a task transition arriving over SSE
 * repaints the whole panel through a different door (the tasks map observer),
 * and the repaint rebuilds the composer — typed-but-unsent text and focus were
 * gone and the caret dropped to body. Found while verifying the voice fix in
 * PR #222: the voice symptom went away, the text loss stayed.
 *
 * So the fix is at the choke point every repaint funnels through:
 * `renderTaskDetail` snapshots what each text control holds the instant
 * before it throws the old DOM away, and puts it back into the new one —
 * value, focus, and caret.
 */
describe('a repaint of the detail panel keeps what was typed', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const handlers = () => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(),
  });

  const thread = (id: string): TaskThread => ({
    id,
    status: 'open',
    comments: [{ author: 'Jordan', text: `Question in ${id}?`, ts: NOW }],
  });

  const ask = (taskId: string, threadId: string) => ({
    kind: 'task-thread' as const,
    docId: `task:${taskId}`,
    threadId,
    taskId,
    title: 'Some task',
    ask: 'Bryan: which one?',
    askedBy: 'Live Feedback',
    since: NOW - 3_600_000,
    direct: true,
  });

  const paint = (t: HubTask, extra: Record<string, unknown> = {}) =>
    renderTaskDetail(
      root,
      t,
      { ...handlers(), ...extra },
      { loading: false, threads: [thread('th-1'), thread('th-2')] },
    );

  const composer = () => root.querySelector('.hub-discussion textarea') as HTMLTextAreaElement;

  /** Type into a control the way a person does: value, focus, caret. */
  const typeInto = (el: HTMLTextAreaElement | HTMLInputElement, text: string, caret: number) => {
    el.value = text;
    el.focus();
    el.setSelectionRange(caret, caret);
  };

  it('the discussion composer survives a task transition — text, focus AND caret', () => {
    const t = task({ status: 'todo' });
    paint(t);
    const before = composer();
    typeInto(before, 'I think this is below the API work because', 12);
    expect(document.activeElement).toBe(before);

    // The SSE-driven repaint: same task, new status.
    paint({ ...t, status: 'in-progress' });

    // Positive control, two ways: the panel really was rebuilt (the chip
    // moved, and the composer is a NEW node), so a pass below is a restore
    // and not a repaint that never happened.
    expect(root.querySelector('.hub-chip-current')?.textContent).toBe('In progress');
    const after = composer();
    expect(after).not.toBe(before);

    expect(after.value).toBe('I think this is below the API work because');
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(12);
    expect(after.selectionEnd).toBe(12);
  });

  // The caret is restored where it was, not at the end — someone editing the
  // middle of a sentence keeps their place.
  it('keeps a mid-text selection, direction included', () => {
    const t = task();
    paint(t);
    const ta = composer();
    ta.value = 'drop the second half';
    ta.focus();
    ta.setSelectionRange(9, 20, 'backward');
    paint({ ...t, updatedAt: NOW + 1 });
    const after = composer();
    expect(after.selectionStart).toBe(9);
    expect(after.selectionEnd).toBe(20);
    expect(after.selectionDirection).toBe('backward');
  });

  // Text without focus is still a draft — the reader tapped away to read a
  // thread and is coming back to it. Restored, but the caret is left alone:
  // focusing a field the person left would steal it from wherever they went.
  it('keeps unfocused draft text without stealing focus', () => {
    const t = task();
    paint(t);
    composer().value = 'half a thought';
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.body.focus();
    paint({ ...t, updatedAt: NOW + 1 });
    expect(composer().value).toBe('half a thought');
    expect(document.activeElement).not.toBe(composer());
  });

  // The other text controls on the panel go through the same repaint and lose
  // the same way, so they ride the same fix.
  it('the ask panel reply box survives too', () => {
    const t = task();
    paint(t, { asks: [ask(t.id, 'th-1')] });
    const box = root.querySelector('.hub-detail-ask-form textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    typeInto(box, 'Keep threading.', 4);
    paint({ ...t, status: 'in-progress' }, { asks: [ask(t.id, 'th-1')] });
    const after = root.querySelector('.hub-detail-ask-form textarea') as HTMLTextAreaElement;
    expect(after).not.toBe(box);
    expect(after.value).toBe('Keep threading.');
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(4);
  });

  it('a decision answer being recorded survives too', () => {
    const t = task({ needs: 'decision' });
    paint(t);
    const box = root.querySelector('.hub-answer-form textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    typeInto(box, 'Option B, because', 8);
    paint({ ...t, updatedAt: NOW + 1 });
    const after = root.querySelector('.hub-answer-form textarea') as HTMLTextAreaElement;
    expect(after).not.toBe(box);
    expect(after.value).toBe('Option B, because');
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(8);
  });

  // The title editor is a control that only exists mid-edit, so a repaint
  // does not merely empty it — it closes it. Reopened with the typed text.
  it('a title being renamed survives, editor reopened with the typed text', () => {
    const t = task({ title: 'Old name' });
    paint(t);
    (root.querySelector('.hub-detail-title') as HTMLElement).click();
    const input = root.querySelector('.hub-title-input') as HTMLInputElement;
    expect(input).toBeTruthy();
    typeInto(input, 'Old name, sharper', 3);
    paint({ ...t, updatedAt: NOW + 1 });
    const after = root.querySelector('.hub-title-input') as HTMLInputElement;
    expect(after).toBeTruthy();
    expect(after).not.toBe(input);
    expect(after.value).toBe('Old name, sharper');
    expect(document.activeElement).toBe(after);
    expect(after.selectionStart).toBe(3);
  });

  // The boundary of the guarantee: a draft belongs to the task it was typed
  // on. Opening a DIFFERENT task in the same panel starts clean — carrying a
  // half-typed comment from one task onto another would post it in the wrong
  // place, which is worse than losing it.
  it('does not carry a draft from one task onto another', () => {
    const a = task();
    const b = task();
    paint(a);
    typeInto(composer(), 'about task A', 5);
    paint(b);
    expect(composer().value).toBe('');
    expect(document.activeElement).not.toBe(composer());
  });

  // A control that starts empty stays empty: the snapshot is not inventing
  // values, and a repaint of an untouched panel is a no-op for the fields.
  it('an untouched panel repaints untouched', () => {
    const t = task();
    paint(t);
    paint({ ...t, updatedAt: NOW + 1 });
    expect(composer().value).toBe('');
    expect(document.activeElement).not.toBe(composer());
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
 * happy-dom does no layout, so nothing else in this suite can see a fixed
 * launcher painting over a button. What it CAN see is the invariant: the
 * media block that takes the walkthrough full-screen must also reserve
 * bottom clearance in the card, or its last control ("Tell me more" on a
 * decision card) ends up under the bottom-docked mic/pencil launchers. The
 * old form of this test keyed the clearance to a sticky .hub-walk-nav; the
 * ‹ › stepper moved to the panel head (approved design), so the sticky bar
 * is gone and full-screen is now what forces the clearance.
 */
describe('the full-screen walkthrough reserves launcher clearance', () => {
  it('gives the card bottom clearance wherever the panel goes full-screen', async () => {
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
    const fullScreen = blocks.filter((b) =>
      /\.hub-walk-panel\s*\{[^}]*max-height:\s*100vh/.test(b),
    );
    // Positive control: the block this asserts about exists and was matched.
    expect(fullScreen.length).toBeGreaterThan(0);
    for (const b of fullScreen) {
      expect(b).toMatch(/\.hub-walk-card\s*\{[^}]*padding-bottom:\s*calc\([\d.]+px/);
    }
    // The stepper lives in the panel head now — nothing may make it sticky
    // again without restoring the reserve that travelled with the old bar.
    expect(css).not.toMatch(/\.hub-walk-nav\s*\{[^}]*position:\s*sticky/);
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

  it('renders nothing when there is no notice at all', () => {
    const host = document.createElement('div');
    // Positive control: the same call WITH a notice puts a .hub-drift in, so
    // this absence means the notice is what drives it.
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [drift()]);
    expect(host.querySelector('.hub-drift')).not.toBeNull();

    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [null]);
    expect(host.querySelector('.hub-drift')).toBeNull();
    expect(host.classList.contains('hidden')).toBe(true);
  });

  it('renders the clear reading quietly, and the alarm loudly', () => {
    // A coverage line is on the board permanently. If it wore the alarm's
    // styling it would teach everyone to skim past the alarm — so the class
    // has to differ, and both halves are asserted in the same pass so
    // neither is a claim about a world the other does not inhabit.
    const host = document.createElement('div');
    const clear = pluginDriftNotice({ version: '0.1.40', behind: [], checked: 1 });
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [clear]);
    const quiet = host.querySelector('.hub-drift');
    expect(quiet).not.toBeNull();
    expect(quiet?.classList.contains('hub-drift-quiet')).toBe(true);
    expect(quiet?.textContent).toContain('No attached session is behind 0.1.40 (1 checked)');
    expect(quiet?.textContent).toContain('a peer that never attached is absent here');

    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [drift()]);
    const loud = host.querySelector('.hub-drift');
    expect(loud?.classList.contains('hub-drift-quiet')).toBe(false);
  });

  it('a board nobody has attached to does not render as all-clear', () => {
    // The defect, in the surface: an empty `behind` list used to render as
    // nothing, and nothing reads exactly like clearance.
    const host = document.createElement('div');
    renderPresence(host, [], null, { onTap: () => {}, onLongPress: () => {} }, [
      pluginDriftNotice({ version: '0.1.40', behind: [], checked: 0 }),
    ]);
    expect(host.classList.contains('hidden')).toBe(false);
    expect(host.querySelector('.hub-drift')?.textContent).toContain(
      'no session has attached to this board',
    );
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

describe('renderUnplacedStrip', () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  function host(): HTMLElement {
    const el = document.createElement('div');
    el.className = 'hub-unplaced hidden';
    document.body.append(el);
    return el;
  }

  it('renders nothing and stays hidden on an empty bucket', () => {
    const el = host();
    // Positive control: the same container DOES fill when there is something
    // to say, so an empty one is the renderer's decision, not a dead call.
    renderUnplacedStrip(el, unplacedNotice([task({ unplacedSince: NOW - DAY })], NOW), {
      onOpenOldest: () => {},
    });
    expect(el.textContent).toContain('1 task has no goal yet');
    expect(el.classList.contains('hidden')).toBe(false);

    renderUnplacedStrip(el, unplacedNotice([task({ goal: 'g-pr' })], NOW), {
      onOpenOldest: () => {},
    });
    expect(el.childElementCount).toBe(0);
    expect(el.textContent).toBe('');
    expect(el.classList.contains('hidden')).toBe(true);
  });

  it('says how many and how old, and opens the longest-waiting task', () => {
    const el = host();
    const old = task({ id: 't-waited-longest', unplacedSince: NOW - 6 * DAY });
    const opened: string[] = [];
    renderUnplacedStrip(el, unplacedNotice([task({ unplacedSince: NOW - HOUR }), old], NOW), {
      onOpenOldest: (id) => opened.push(id),
    });
    expect(el.textContent).toContain('2 tasks have no goal yet');
    expect(el.textContent).toContain('oldest waiting 6d');

    const btn = el.querySelector<HTMLButtonElement>('.hub-unplaced-open');
    expect(btn).not.toBeNull();
    btn?.click();
    expect(opened).toEqual(['t-waited-longest']);
  });

  it('informs rather than scolds', () => {
    // A strip that reads as an accusation gets ignored, and an ignored strip
    // is the same as the silence it was built to break.
    const el = host();
    renderUnplacedStrip(el, unplacedNotice([task({ unplacedSince: NOW - 9 * DAY })], NOW), {
      onOpenOldest: () => {},
    });
    expect(el.textContent).not.toMatch(/\b(overdue|neglect\w*|ignored|stale|forgotten|should)\b/i);
    expect(el.textContent).not.toMatch(/[!⚠]/);
  });

  it('is drawn quieter than the decisions alarm above it', () => {
    // Same reason the coverage line is quieter than the drift alarm: if the
    // standing reading looks like the alarm, people learn to skim the alarm.
    const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
    const strip = css.slice(css.indexOf('.hub-unplaced {'));
    const block = strip.slice(0, strip.indexOf('.hub-walkthrough {'));
    expect(block).toContain('--fg-muted');
    expect(block).not.toContain('--yellow');
    // The tap target still has to be reachable on a phone.
    expect(block).toMatch(/min-height:\s*36px/);
  });
});
