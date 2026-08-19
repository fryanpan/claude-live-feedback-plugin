import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  type PresenceChip,
  type ReviewItem,
  type ReviewThreadItem,
  type UptimeReport,
  boardSections,
  clientDriftNotice,
  goalLabel,
  pluginDriftNotice,
  reviewQueue,
  unplacedNotice,
} from '../src/hub/hub-model.ts';
import {
  BODY_LIVE_CLASS,
  type BoardHandlers,
  type QuickAddHandlers,
  type TaskThread,
  decisionBlurb,
  discussionIsBusy,
  flattenComments,
  panelReviewQueue,
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
    onGoalAdd: vi.fn(),
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
    const discussed = task({ goal: 'g-pr', commentCount: 3, after: ['t-a', 't-b'] });
    renderBoard(root, boardSections(GOALS, [discussed], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${discussed.id}"]`);
    expect(row).not.toBeNull();
    // Control: the strip is alive and this row's other badge is in it. (It
    // used to be the `decision` badge; that one is gone too — see below.)
    expect(row?.querySelector('.hub-badge-after')).not.toBeNull();
    expect(row?.querySelector('.hub-badge-comments')).toBeNull();
    // …and no badge anywhere on the row spells the count either, which is what
    // a differently-classed replacement glyph would do.
    expect(row?.querySelector('.hub-task-badges')?.textContent ?? '').not.toContain('3');
  });

  // Same request, same day, same reasoning ("not useful and a waste of
  // space"): `needs` labels the board's shape rather than the row, so on a
  // triaged board every row carried one. Pinned as an absence with a positive
  // control beside it — a row that WOULD have carried the badge still renders
  // its other badges, so this is not "the strip stopped rendering".
  it('puts no decision/action identifier on a row', () => {
    const h = handlers();
    const decide = task({ goal: 'g-pr', needs: 'decision', after: ['t-a'] });
    const act = task({ goal: 'g-pr', needs: 'action' });
    renderBoard(root, boardSections(GOALS, [decide, act], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${decide.id}"]`);
    expect(row?.querySelector('.hub-badge-after')).not.toBeNull();
    expect(root.querySelector('.hub-badge-decision')).toBeNull();
    expect(root.querySelector('.hub-badge-action')).toBeNull();
    // And no differently-classed replacement spells the words either.
    const badgeText = [...root.querySelectorAll('.hub-task-badges')]
      .map((b) => b.textContent ?? '')
      .join(' ');
    expect(badgeText).not.toContain('decision');
    expect(badgeText).not.toContain('action');
  });

  // Display-only flattening. The goal LIST still nests — `boardSections`
  // reports the subgoal at depth 1 and this test asserts that first, so a
  // change that flattened the DATA would fail here rather than pass quietly.
  // What stops is the indent: a subgoal is work with the same claim on the
  // day as anything else on the list.
  it('renders a subgoal as a plain section, with the nesting still in the model', () => {
    const h = handlers();
    const sections = boardSections(GOALS, [task({ goal: 'g-sub' })], filters);
    // The premise, asserted rather than assumed: this fixture HAS a subgoal.
    expect(sections.map((s) => s.depth)).toContain(1);
    renderBoard(root, sections, h);
    expect(root.querySelector('.hub-subgoal')).toBeNull();
    // Positive control: the section it would have been on is really there,
    // in board order, with its task in it.
    const rendered = [...root.querySelectorAll('.hub-section')].map(
      (s) => (s as HTMLElement).dataset.goalId,
    );
    expect(rendered).toEqual(sections.map((s) => s.id));
    expect(root.querySelector('.hub-section[data-goal-id="g-sub"] .hub-task-row')).not.toBeNull();
  });

  it('offers a goal-add row that reports the title and the band to follow', () => {
    const h = handlers();
    const sections = boardSections(GOALS, [], filters);
    renderBoard(root, sections, h);
    const btn = root.querySelector('.hub-goal-add-btn') as HTMLButtonElement;
    expect(btn).not.toBeNull();
    btn.click();
    const input = root.querySelector('.hub-goal-add-input') as HTMLInputElement;
    input.value = '  3. Cut support load  ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    // Trimmed, and placed after the last REAL band — never after Chores,
    // which always renders last and is not a band anyone files against.
    const lastReal = [...sections].reverse().find((s) => !s.isChores);
    expect(lastReal?.isChores).toBe(false);
    expect(h.onGoalAdd).toHaveBeenCalledWith('3. Cut support load', lastReal?.id);
    // The box closes and empties, so the next open does not offer the last
    // title back as though it were already typed.
    expect(input.value).toBe('');
    expect(input.classList.contains('hidden')).toBe(true);
  });

  it('files nothing for an empty goal title, or for Escape over a typed one', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [], filters), h);
    (root.querySelector('.hub-goal-add-btn') as HTMLButtonElement).click();
    const input = root.querySelector('.hub-goal-add-input') as HTMLInputElement;
    input.value = '   ';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    input.value = 'a real title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(h.onGoalAdd).not.toHaveBeenCalled();
    // Positive control in the same pass: the same box CAN file, so the two
    // absences above are refusals rather than a dead affordance.
    (root.querySelector('.hub-goal-add-btn') as HTMLButtonElement).click();
    input.value = 'a real title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onGoalAdd).toHaveBeenCalledWith('a real title', expect.any(String));
  });

  it('omits the goal-add row entirely when no handler is given', () => {
    const h = handlers();
    const { onGoalAdd: _drop, ...noAdd } = h;
    renderBoard(root, boardSections(GOALS, [], filters), noAdd as BoardHandlers);
    expect(root.querySelector('.hub-goal-add')).toBeNull();
    // Control: the board rendered.
    expect(root.querySelector('.hub-section')).not.toBeNull();
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
    // Third column: what the accessible name says. An agent's id IS its name
    // and reads fine; `human` is a reserved id meaning "a person,
    // unspecified", and saying the id out loud put an implementation detail in
    // the reader's ear and in the dropdown.
    const rows: [string, string, string][] = [
      ['team-lead-fleet', 'TL', 'team-lead-fleet'],
      ['human', 'H', 'A person'],
      ['agent-live-feedback', 'LF', 'agent-live-feedback'],
    ];
    for (const [assignee, expected, reads] of rows) {
      root.replaceChildren();
      renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', assignee })], filters), h);
      const avatar = root.querySelector('.hub-owner-avatar') as HTMLElement;
      expect(avatar.textContent).toBe(expected);
      const picker = root.querySelector('.hub-row-assignee') as HTMLSelectElement;
      expect(picker.title).toContain(reads);
      // The VALUE is untouched: what gets posted is still the id.
      expect(picker.value).toBe(assignee);
    }
  });

  it('offers the reserved person id under a name a reader can read', () => {
    // `human` is not a person's name and not an agent's — it is the id for
    // "somebody, unspecified", and it was rendered raw as an option label.
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', assignee: 'team-lead-fleet' })], filters),
      handlers({ knownAgentIds: ['team-lead-fleet'] }),
    );
    const picker = root.querySelector('.hub-row-assignee') as HTMLSelectElement;
    const labels = [...picker.options].map((o) => o.textContent);
    expect(labels).toContain('A person');
    expect(labels).not.toContain('human');
    // Positive control: an agent's own name is NOT relabelled.
    expect(labels).toContain('team-lead-fleet');
    // …and the option still carries the id, so the write is unchanged.
    expect([...picker.options].map((o) => o.value)).toContain('human');
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
    // Control: the panel really did render its key-fields row.
    expect(panel.querySelectorAll('.hub-detail-fields dt').length).toBeGreaterThan(0);
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

  it('Enter LEAVES edit mode, not just commits', () => {
    // *"title should save and switch back to not editable state"*. It
    // committed and left the input in place, relying on the caller's
    // re-render — and in the detail panel that re-render REOPENS the editor
    // for any title draft it finds, so Enter saved and put the reader
    // straight back into editing, every time.
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    title.click();
    const input = title.querySelector('input') as HTMLInputElement;
    input.value = 'New title';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onTitleCommit).toHaveBeenCalled();
    expect(title.querySelector('input')).toBeNull();
    // Showing the committed words, not the old ones — the caller re-renders,
    // but the element must not flash the pre-edit title in between.
    expect(title.textContent).toBe('New title');
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
      after: 'k-b',
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
      after: 'k-a',
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

  /** A thread an agent DECLARED as a review item — which is what puts a thread
   *  in the queue at all now. `note()` below is the undeclared twin. */
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
    band: 'declared' as const,
    commentId: 'c-1',
    review: {
      shape: 'review' as const,
      headline: 'Which repo does this land in?',
      why: 'The next commit goes to one of them and both are open.',
    },
    ...over,
  });

  /** An ordinary agent comment nobody declared anything on. */
  const note = (over: Record<string, unknown> = {}) => {
    const { band, commentId, review, ...rest } = threadItem(over);
    return rest;
  };

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

  // The band that used to render here ("N unanswered comments") is gone
  // outright — Bryan, 2026-08-18: "Remove the unanswered comments from home.
  // I don't need to know." The model still buckets undeclared threads into
  // `queue.unreplied` so they stay OUT of the declared queue; the page just
  // no longer shows them.
  it('does not render undeclared comments at all', () => {
    const h = strip();
    const d = task({ needs: 'decision', assignee: 'human', title: 'Ship now or wait?' });
    renderHomeReview(root, reviewQueue([d], [threadItem(), note()], NOW), h, [], NOW);
    expect(root.querySelector('.hub-review-unreplied-head')).toBeNull();
    expect(root.querySelector('.hub-review-unreplied-title')).toBeNull();
    const rows = [...root.querySelectorAll('.hub-review-row')];
    // Positive control: both DECLARED items rendered, so the absences above
    // are not a page that rendered nothing.
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.className.includes('hub-review-row-unreplied'))).toBe(false);
  });

  it('shows only the quiet line when the queue is empty, however many comments sit unreplied', () => {
    renderHomeReview(root, reviewQueue([], [note(), note()], NOW), strip(), [], NOW);
    expect(root.querySelector('.hub-home-quiet')?.textContent).toContain(
      'Nothing is waiting for your review',
    );
    expect(root.querySelector('.hub-review-unreplied-head')).toBeNull();
    expect(root.querySelectorAll('.hub-review-row')).toHaveLength(0);
    expect(root.querySelector('.hub-review-go')).toBeNull();
  });

  it('renders no band when every thread was declared', () => {
    renderHomeReview(root, reviewQueue([], [threadItem()], NOW), strip(), [], NOW);
    expect(root.querySelector('.hub-review-unreplied-head')).toBeNull();
    // Positive control: the declared one really did render, so the absence
    // above is not a page that rendered nothing.
    expect(root.querySelectorAll('.hub-review-row')).toHaveLength(1);
  });

  // The header is two lines and both of them belong on the surface being
  // SCANNED. A "why it matters" that is one tap away is not a header — the
  // queue row is where the reader decides what to open, which is the exact
  // judgement that line exists to serve.
  it('puts the declared why on the queue row, not only on the card it opens', () => {
    renderHomeReview(root, reviewQueue([], [threadItem(), note()], NOW), strip(), [], NOW);
    const rows = [...root.querySelectorAll('.hub-review-row')];
    // The undeclared note no longer renders a row, so only the declared one is here.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.querySelector('.hub-review-row-why')?.textContent).toBe(
      threadItem().review?.why,
    );
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

  /**
   * The voice half of the redesign. Opening a task from the board is a CLICK
   * on a task row, so focus stayed on the row — and a row is not "the page",
   * which is what `spaceHoldTargetsPage` requires. Hold-to-talk was therefore
   * dead for as long as any task was open ("holding space does nothing").
   */
  it('takes focus on open and declares itself page-like for the Space hold', () => {
    const opener = document.createElement('div');
    opener.tabIndex = 0;
    document.body.append(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    renderTaskDetail(root, task({ id: 't-focus' }), detailHandlers());
    const panel = root.querySelector<HTMLElement>('.hub-detail-panel');
    expect(panel).toBeTruthy();
    expect(panel?.getAttribute('data-space-hold')).toBe('page');
    expect(document.activeElement).toBe(panel);
  });

  /** A repaint must not re-take it: the panel repaints on every board change,
   *  and one that grabbed focus would pull the caret out of the composer
   *  every time a peer's comment landed. */
  it('does not re-take focus on a repaint of the same task', () => {
    const t = task({ id: 't-repaint' });
    const withComposer = () => ({ ...detailHandlers(), onComment: vi.fn() });
    const discussion = { loading: false, threads: [] };
    renderTaskDetail(root, t, withComposer(), discussion);
    const ta = root.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    // Positive control: there IS something else focusable in the panel, so
    // "focus went back to the composer" below is a decision rather than an
    // empty panel with nowhere else for it to go.
    expect(ta).toBeTruthy();
    ta?.focus();
    ta!.value = 'half a sentence';

    renderTaskDetail(root, t, withComposer(), discussion);
    const panel = root.querySelector('.hub-detail-panel');
    const rebuilt = root.querySelector<HTMLTextAreaElement>('.hub-detail-panel textarea');
    expect(document.activeElement).not.toBe(panel);
    expect(document.activeElement).toBe(rebuilt);
    expect(rebuilt?.value).toBe('half a sentence');
  });

  // Goal moved out of the reference list at the bottom and into the key-fields
  // row under the title, so this reads the row it now lives in.
  const metaValue = (key: string): string | null => {
    const dts = [...root.querySelectorAll('.hub-detail-fields dt')];
    const dds = [...root.querySelectorAll('.hub-detail-fields dd')];
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
    // The third argument is the option id, absent for free text. One `answer`
    // path serves both the buttons and the box, which is why it is always
    // passed rather than only when there is one.
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ id: d.id }),
      'Go with option B, ship Thursday.',
      undefined,
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

  it('does not scroll past the review queue to the thread it already quotes', () => {
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
    expect(root.querySelector('.hub-comment-focus')).toBeTruthy();
    expect(root.querySelector('.hub-decide-card[data-review-thread-id="th-1"]')).toBeTruthy();
    expect(scrolled).toEqual([]);
  });

  /** Positive control: the spy CAN see a scroll, and centring is still right
   *  when the focused thread is not the one the queue is carrying. */
  it('still centres a focused thread the review queue is not about', () => {
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
    const ask = root.querySelector('.hub-decide');
    expect(ask).toBeTruthy();
    expect(ask?.querySelector('.hub-decide-headline')?.textContent).toContain(
      'should we drop threading',
    );
    // Above the description — the requirement is "without scrolling on a
    // 430px phone", and a panel that opens on nine rows of identical metadata
    // spends the first screen on facts that are the same for every task.
    const desc = root.querySelector('.hub-detail-body');
    expect(desc).toBeTruthy();
    expect(ask!.compareDocumentPosition(desc!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // …and it says who is waiting, and how long they have been.
    expect(root.querySelector('.hub-decide-meta')?.textContent).toContain('Live Feedback');
    expect(root.querySelector('.hub-decide-meta')?.textContent).toContain('1h ago');
  });

  /** "Answer without leaving the screen you landed on." A button that scrolls
   *  to a composer further down the page satisfies that on a desktop only. */
  it('replies to the asking thread from the review card itself', async () => {
    const onAnswerThread = vi.fn().mockResolvedValue(true);
    const t = task({ id: 't-1' });
    renderTaskDetail(
      root,
      t,
      detailHandlers({ asks: [askItem({ threadId: 'th-9' })], now: NOW, onAnswerThread }),
      { loading: false, threads: [thread({ id: 'th-9' })] },
    );
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    expect(form).toBeTruthy();
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Drop it, and prefix the 3 orphans.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    // Posts onto the thread that asked, not into a new one — a reply that
    // opens a fresh thread is how an answer stops being an answer.
    expect(onAnswerThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      expect.objectContaining({ threadId: 'th-9' }),
      'Drop it, and prefix the 3 orphans.',
      undefined,
    );
    // The box is cleared as the answer goes, not after it lands: the write
    // repaints the panel from inside its own await, and a clear that runs
    // afterwards lands on a textarea that is no longer in the document.
    expect(ta.value).toBe('');
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
    const kicker = root.querySelector('.hub-decide-kicker')?.textContent ?? '';
    expect(kicker).not.toContain('Waiting on your review');
    // Says what is TRUE of the flag — nobody is named — rather than the
    // stronger claim that no question is present, which `direct` cannot
    // support at 1-in-3 recall.
    expect(kicker).toContain('not addressed to you by name');
    expect(kicker).not.toContain('no question');
    // The words are still shown — labelled honestly, not withheld.
    expect(root.querySelector('.hub-decide-headline')?.textContent).toContain('PR #154');
  });

  /** The positive control for the case above: the same renderer DOES give a
   *  real question the question heading, so the absence just asserted is a
   *  decision rather than a renderer that can only produce one string. */
  it('calls a direct question a question', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [askItem()], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    expect(root.querySelector('.hub-decide-kicker')?.textContent).toContain(
      'Waiting on your review',
    );
  });

  it('shows no review queue on a task nothing is waiting on', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ asks: [], now: NOW }), {
      loading: false,
      threads: [thread()],
    });
    expect(root.querySelector('.hub-decide')).toBeNull();
    // Positive control: the panel rendered at all, so the null above is about
    // the queue and not about an empty container.
    expect(root.querySelector('.hub-comment')).toBeTruthy();
  });

  /** Reported as "comments do not say who they are from, or whether they are a
   *  request for my input". The author was already there; the TIME was in a
   *  `title` attribute, which is a hover tooltip on a surface read on a
   *  phone, and the request marking did not exist at all. */
  it('shows each comment author and time as text, and leaves waiting to the queue', () => {
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
    const waiting = root.querySelector('.hub-comment[data-thread-id="th-w"]');
    expect(waiting?.querySelector('.hub-comment-author')?.textContent).toBe('Live Feedback');
    // Text, not a tooltip.
    expect(waiting?.querySelector('.hub-comment-when')?.textContent).toBe('2h ago');
    // "Needs your reply" was a THREAD badge, and threading left the surface with
    // it. The signal did NOT leave: it renders once, in the queue at the top of
    // the panel, naming that same thread and nothing else — which is above the
    // fold rather than two hundred pixels down a comment stream.
    expect(root.querySelectorAll('.hub-comment [class*="needs"]')).toHaveLength(0);
    const carded = [...root.querySelectorAll<HTMLElement>('.hub-decide-card')].map(
      (c) => c.dataset.reviewThreadId,
    );
    expect(carded).toEqual(['th-w']);
  });

  /** A declared comment is a request, and the thread it lives in is usually
   *  fourteen status notes with one of these somewhere in the middle. Without
   *  its own chrome the request is the same grey block as the notes. */
  it('sets a declared comment apart, with its header above the words', () => {
    renderTaskDetail(root, task({ id: 't-1' }), detailHandlers({ now: NOW }), {
      loading: false,
      threads: [
        thread({
          id: 'th-d',
          comments: [
            { author: 'Onboarding Rework', text: 'Pushed the first pass.', ts: NOW - 7_200_000 },
            {
              author: 'Onboarding Rework',
              text: 'Both screens are built; details in the PR.',
              ts: NOW - 3_600_000,
              review: {
                shape: 'decision',
                headline: 'Where should the trial banner live?',
                why: 'Blocks the rework; both screens are built either way.',
              },
            },
          ],
        }),
      ],
    });
    const comments = [...root.querySelectorAll('.hub-comment')];
    // The declaration rides the comment that made it, so the status note
    // above it stays a status note.
    expect(comments.map((c) => c.className.includes('hub-comment-review'))).toEqual([false, true]);
    const declared = comments[1] as HTMLElement;
    expect(declared.querySelector('.hub-comment-review-k')?.textContent).toBe('Decision');
    expect(declared.querySelector('.hub-comment-review-headline')?.textContent).toBe(
      'Where should the trial banner live?',
    );
    expect(declared.querySelector('.hub-comment-review-why')?.textContent).toBe(
      'Blocks the rework; both screens are built either way.',
    );
    // Above the words, not instead of them — the text is what the agent said.
    expect(declared.querySelector('.hub-comment-body')?.textContent).toContain(
      'Both screens are built',
    );
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
    const marked = [...root.querySelectorAll('.hub-comment-focus')];
    // Positive control: all three rendered, so "only one marked" means
    // something. Then: it is the RIGHT one.
    expect(root.querySelectorAll('.hub-comment')).toHaveLength(3);
    expect(marked).toHaveLength(1);
    expect((marked[0] as HTMLElement).dataset.threadId).toBe('th-2');
  });

  it('marks nothing when the panel was opened any other way', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-2' })],
    });
    expect(root.querySelectorAll('.hub-comment')).toHaveLength(2);
    expect(root.querySelectorAll('.hub-comment-focus')).toHaveLength(0);
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
    expect(root.querySelectorAll('.hub-comment')).toHaveLength(3);
  });

  /**
   * The destination is DERIVED and never announced. Bryan, 2026-08-18: *"Stop
   * supporting threaded comments and clean up all code related to this! Clean
   * up the UX too."* So there is no Reply button, no "Replying to …" bar and no
   * "New thread" control — but a comment still has to REACH the agent watching
   * the conversation, which is what this asserts.
   */
  it('sends a comment to the newest conversation, with nothing on screen saying so', () => {
    const onComment = vi.fn();
    const t = task();
    renderTaskDetail(root, t, detailHandlers({ onComment }), {
      loading: false,
      threads: [thread({ id: 'th-1' }), thread({ id: 'th-77' })],
    });
    // Not merely "no reply buttons": no control anywhere names a thread.
    expect(root.querySelector('.hub-comment-reply')).toBeNull();
    expect(root.querySelector('.hub-composer-target')).toBeNull();
    expect(root.querySelector('.hub-composer-switch')).toBeNull();
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

  /** A deep link can outlive the thread it names. Falling back to the newest
   *  live conversation keeps the comment reaching somebody; the alternative the
   *  title warns about is a `threadId` the server cannot resolve. */
  it('an aim that no longer resolves falls back to a live thread, not into nowhere', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment, focusThreadId: 'th-deleted' }), {
      loading: false,
      threads: [thread({ id: 'th-1' })],
    });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'Still worth saying.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'Still worth saying.', 'th-1');
  });

  /** …and with nothing to fall back to it opens one, rather than sending an id
   *  it made up. The pair is the point: neither answer is "no destination". */
  it('opens a conversation when the task has none', () => {
    const onComment = vi.fn();
    renderTaskDetail(root, task(), detailHandlers({ onComment }), { loading: false, threads: [] });
    const form = root.querySelector('.hub-comment-form') as HTMLFormElement;
    (form.querySelector('textarea') as HTMLTextAreaElement).value = 'First word on this.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onComment).toHaveBeenLastCalledWith(expect.anything(), 'First word on this.', undefined);
  });

  /**
   * Nothing an agent posts may stop arriving. An agent's comment lands as a
   * thread on `task:<id>` — anchored or not, open or resolved — and every one
   * of them has to appear in the one stream, in time order, with no per-thread
   * chrome telling them apart.
   */
  it('puts every thread’s comments in one stream, anchored or not, open or resolved', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [
        thread({ id: 'th-open', anchorText: 'a line of the description' }),
        thread({ id: 'th-subject' }),
        thread({ id: 'th-done', status: 'resolved' }),
      ],
    });
    const rows = [...root.querySelectorAll<HTMLElement>('.hub-comment')];
    expect(rows.map((r) => r.dataset.threadId)).toEqual(['th-open', 'th-subject', 'th-done']);
    // The anchor quote was the last place a thread showed through in the UX.
    expect(root.querySelector('.hub-comment-anchor')).toBeNull();
    // One box for all three, at the end of the stream.
    const boxes = [...root.querySelectorAll('.hub-discussion textarea')];
    expect(boxes).toHaveLength(1);
    const form = root.querySelector('.hub-comment-form') as HTMLElement;
    expect(rows[2]!.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  // could reach it. What went away with threading is the STATUS chrome: a
  // comment reads as a comment whatever the thread around it is marked, which
  // is what "one sequence" means. `status` is untouched in storage.
  it('keeps a resolved thread’s words in the stream, with no status chrome', () => {
    renderTaskDetail(root, task(), detailHandlers(), {
      loading: false,
      threads: [thread({ id: 'th-r', status: 'resolved' })],
    });
    const el = root.querySelector('.hub-comment') as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.textContent).toContain('Is the index really first?');
    expect(el.classList.contains('hub-comment-resolved')).toBe(false);
    expect(el.querySelector('.hub-comment-status')).toBeNull();
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

    // Positive control, two ways: the panel really was rebuilt (the status
    // control moved, and the composer is a NEW node), so a pass below is a
    // restore and not a repaint that never happened.
    expect((root.querySelector('.hub-detail-status') as HTMLSelectElement).value).toBe(
      'in-progress',
    );
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
  it('the review card’s answer box survives too', () => {
    const t = task();
    paint(t, { asks: [ask(t.id, 'th-1')] });
    const box = root.querySelector('.hub-decide-form textarea') as HTMLTextAreaElement;
    expect(box).toBeTruthy();
    typeInto(box, 'Keep threading.', 4);
    paint({ ...t, status: 'in-progress' }, { asks: [ask(t.id, 'th-1')] });
    const after = root.querySelector('.hub-decide-form textarea') as HTMLTextAreaElement;
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

  // The two guarantees in one pass. They are implemented by opposite
  // mechanisms — a draft is snapshot and restored around the rebuild, the
  // description slot is the node the rebuild goes AROUND — so a change that
  // reintroduced a blanket `replaceChildren` would satisfy neither, and one
  // that stopped rebuilding at all would silently freeze the panel.
  it('keeps a live description AND a half-typed comment across the same repaint', () => {
    const t = task({ status: 'todo', body: 'The description as the store has it.' });
    paint(t);
    const slot = root.querySelector('.hub-detail-body-slot') as HTMLElement;
    slot.classList.add(BODY_LIVE_CLASS);
    slot.replaceChildren(document.createTextNode('what the editor is showing'));
    typeInto(composer(), 'and a comment mid-sentence', 9);

    paint({ ...t, status: 'in-progress' });

    // Positive control: the panel really was repainted around the slot.
    expect((root.querySelector('.hub-detail-status') as HTMLSelectElement).value).toBe(
      'in-progress',
    );
    expect(root.querySelector('.hub-detail-body-slot')).toBe(slot);
    expect(slot.textContent).toBe('what the editor is showing');
    expect(composer().value).toBe('and a comment mid-sentence');
    expect(document.activeElement).toBe(composer());
    expect(composer().selectionStart).toBe(9);
  });
});

/**
 * The reorganisation Bryan asked for: *"title prominent; key fields up top;
 * review item / decision visible next so I can act above the fold; then
 * description; then comments; Activity behind a second tab."*
 */
describe('renderTaskDetail — the reorganised panel', () => {
  const handlers = (over: Record<string, unknown> = {}) => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    ...over,
  });

  const keys = (): string[] =>
    [...root.querySelectorAll('.hub-detail-fields dt')].map((dt) => dt.textContent ?? '');
  /** The VALUE cell of a field. All four are controls now, so a caller reads
   *  the control rather than the cell's text — `textContent` on a `<select>` is
   *  every option concatenated, which reads as a pass while measuring nothing
   *  about what is selected. */
  const cell = (key: string): HTMLElement | null => {
    const dts = [...root.querySelectorAll('.hub-detail-fields dt')];
    const dds = [...root.querySelectorAll<HTMLElement>('.hub-detail-fields dd')];
    const i = dts.findIndex((dt) => dt.textContent === key);
    return i === -1 ? null : (dds[i] ?? null);
  };
  const value = (key: string): string | null => {
    const el = cell(key)?.querySelector<HTMLSelectElement | HTMLInputElement>('select, input');
    return el?.value ?? null;
  };
  /** Where a node sits in the panel, so ORDER can be asserted rather than
   *  presence — the complaint was about arrangement, not about absence. */
  const at = (sel: string): number => {
    const panel = root.querySelector('.hub-detail-panel');
    const all = panel ? [...panel.querySelectorAll('*')] : [];
    const el = panel?.querySelector(sel);
    return el ? all.indexOf(el) : -1;
  };

  it('puts the four key facts in one row under the title, all four editable', () => {
    renderTaskDetail(root, task({ assignee: 'Jordan', goal: 'g-pr' }), {
      ...handlers(),
      goalLabel: (id) => goalLabel(GOALS, id),
    });
    expect(keys()).toEqual(['Status', 'Assignee', 'Due', 'Goal']);
    expect(value('Goal')).toBe('g-pr');
    expect(cell('Goal')?.querySelector('option[value="g-pr"]')?.textContent).toBe(
      '1. Get the PR out',
    );
  });

  /**
   * *"Status should only show current status with a dropdown to change the
   * status"* — one value and one control, not a row of chips with the current
   * one rendered as a disabled unbordered word beside its pill siblings.
   */
  it('shows the current status once, as a dropdown beside the board’s own mark', () => {
    const h = handlers();
    renderTaskDetail(root, task({ status: 'in-progress' }), h);
    const status = cell('Status') as HTMLElement;
    // The chip row is gone — not hidden, not disabled, absent.
    expect(status.querySelectorAll('.hub-chip')).toHaveLength(0);
    expect(status.querySelectorAll('select')).toHaveLength(1);
    const sel = status.querySelector('select') as HTMLSelectElement;
    expect(sel.value).toBe('in-progress');
    // The same round mark the board rows use, so the two surfaces cannot
    // disagree about what "in progress" looks like.
    expect(status.querySelector('.hub-status-mark-in-progress')).toBeTruthy();

    sel.value = 'done';
    sel.dispatchEvent(new Event('change'));
    expect(h.onStatusSet).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'in-progress' }),
      'done',
    );
  });

  /** `dueAt` had no route after creation until this branch added
   *  `POST /api/tasks/:id/due`, so the cell was prose. It is a date control
   *  now, and the value is a LOCAL calendar day both ways — `toISOString`
   *  shows yesterday to anyone west of UTC for an evening deadline. */
  it('leaves the due control empty when nothing is due, and round-trips a local day', () => {
    const onDueSet = vi.fn();
    renderTaskDetail(root, task(), handlers({ onDueSet }));
    expect(value('Due')).toBe('');

    root.replaceChildren();
    // Noon local on the 20th, built the way the reader's own calendar would.
    const due = new Date(2026, 7, 20, 12).getTime();
    renderTaskDetail(root, task({ dueAt: due }), handlers({ onDueSet }));
    expect(value('Due')).toBe('2026-08-20');

    const input = cell('Due')?.querySelector('input') as HTMLInputElement;
    input.value = '2026-09-02';
    input.dispatchEvent(new Event('change'));
    const [, ts] = onDueSet.mock.calls[0] ?? [];
    const back = new Date(ts as number);
    expect([back.getFullYear(), back.getMonth(), back.getDate()]).toEqual([2026, 8, 2]);

    // Clearing it is expressible, and is not the same as sending a bad date.
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(onDueSet).toHaveBeenLastCalledWith(expect.anything(), null);
  });

  /**
   * The whole ticket in one assertion. Every one of these existed before; the
   * complaint was the ORDER, so presence assertions alone would have passed
   * against the panel being complained about.
   */
  it('orders the panel title → fields → what is waiting → description → tabs', () => {
    const t = task({ needs: 'decision', options: [{ id: 'o-1', label: 'Ship it' }] });
    renderTaskDetail(root, t, handlers(), { loading: false, threads: [] });
    const order = [
      at('.hub-detail-title'),
      at('.hub-detail-fields'),
      at('.hub-decide'),
      at('.hub-detail-body-slot'),
      at('.hub-detail-tabs'),
    ];
    expect(order).not.toContain(-1); // control: every region rendered
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  /**
   * The decision card's layout, which is the piece reported as janky on the
   * Home queue: *"options crammed against their details, no spacing between
   * the answer buttons, no spacing between buttons and comment text, nothing
   * aligned."* The structure is what the stylesheet hangs off, so the grouping
   * is asserted here and the gaps in `hub-decide-css.test.ts`.
   */
  it('groups a decision’s options, and separates them from the free-text box', () => {
    const t = task({
      needs: 'decision',
      options: [
        { id: 'o-1', label: 'Ship it blue', detail: 'Matches the rest of the nav' },
        { id: 'o-2', label: 'Ship it green' },
      ],
    });
    const h = handlers();
    renderTaskDetail(root, t, h);
    const card = root.querySelector('.hub-decide') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.querySelector('.hub-decide-kicker')?.textContent).toBe('Waiting on your decision');

    // Every option is a child of ONE group — the gap between buttons is a
    // property of that group, so options scattered among siblings cannot be
    // spaced consistently however the stylesheet is written.
    const group = card.querySelector('.hub-decide-options') as HTMLElement;
    const opts = [...group.querySelectorAll('.hub-decide-option')];
    expect(opts).toHaveLength(2);
    expect(opts.every((o) => o.parentElement === group)).toBe(true);
    // Label and detail are separate elements rather than one run of text, which
    // is what "crammed against their details" describes.
    expect(opts[0]?.querySelector('.hub-decide-option-label')?.textContent).toBe('Ship it blue');
    expect(opts[0]?.querySelector('.hub-decide-option-detail')?.textContent).toBe(
      'Matches the rest of the nav',
    );
    expect(opts[1]?.querySelector('.hub-decide-option-detail')).toBeNull();

    // The box is an ALTERNATIVE to the options, and says so.
    const form = card.querySelector('.hub-decide-form') as HTMLElement;
    expect(form.querySelector('.hub-decide-form-hint')?.textContent).toBe(
      'Or answer in your own words',
    );
    expect(group.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    (opts[0] as HTMLElement).click();
    expect(h.onAnswer).toHaveBeenCalledWith(t, 'Ship it blue', 'o-1');
  });

  it('drops the "or" from the hint when there is nothing to choose between', () => {
    renderTaskDetail(root, task({ needs: 'decision' }), handlers());
    expect(root.querySelector('.hub-decide-options')).toBeNull();
    expect(root.querySelector('.hub-decide-form-hint')?.textContent).toBe(
      'Answer in your own words',
    );
  });

  it('shows no decision card on a task nothing is waiting on', () => {
    renderTaskDetail(root, task(), handlers());
    expect(root.querySelector('.hub-decide')).toBeNull();
    // Control: the panel rendered, so the null is about the card.
    expect(root.querySelector('.hub-detail-fields')).toBeTruthy();
  });

  it('opens on Comments, with Activity present but hidden', () => {
    renderTaskDetail(root, task({ transitions: [] }), handlers(), {
      loading: false,
      threads: [],
    });
    const comments = root.querySelector('.hub-detail-tabpanel-comments') as HTMLElement;
    const activity = root.querySelector('.hub-detail-tabpanel-activity') as HTMLElement;
    expect(comments.classList.contains('hidden')).toBe(false);
    expect(activity.classList.contains('hidden')).toBe(true);
    expect(root.querySelector('.hub-detail-tab-comments')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    // The record really is over there rather than nowhere.
    expect(activity.querySelector('.hub-detail-body-link')).toBeTruthy();
  });

  /**
   * The panel repaints on every ydoc change — a peer's comment, a status flip,
   * the reader's own typing — so a tab choice that reset on the next repaint
   * would be a tab nobody could use. Same mechanism as `priorTaskId`: read the
   * state off the panel before the swap throws it away.
   */
  it('keeps the chosen tab across a repaint, and resets it on another task', () => {
    const t = task();
    renderTaskDetail(root, t, handlers(), { loading: false, threads: [] });
    (root.querySelector('.hub-detail-tab-activity') as HTMLElement).click();
    const activity = () => root.querySelector('.hub-detail-tabpanel-activity') as HTMLElement;
    expect(activity().classList.contains('hidden')).toBe(false);

    renderTaskDetail(root, { ...t, status: 'in-progress' }, handlers(), {
      loading: false,
      threads: [],
    });
    // Control: this really was a repaint, not a no-op.
    expect(value('Status')).toBe('in-progress');
    expect(activity().classList.contains('hidden')).toBe(false);

    // A different task is a fresh read, and it starts on the conversation.
    renderTaskDetail(root, task(), handlers(), { loading: false, threads: [] });
    expect(activity().classList.contains('hidden')).toBe(true);
  });

  it('offers a share link only when the board wired one up', () => {
    renderTaskDetail(root, task(), handlers());
    expect(root.querySelector('.hub-detail-share')).toBeNull();

    root.replaceChildren();
    const onCopyLink = vi.fn();
    const t = task();
    renderTaskDetail(root, t, handlers({ onCopyLink }));
    const share = root.querySelector('.hub-detail-share') as HTMLElement;
    expect(share).toBeTruthy();
    share.click();
    expect(onCopyLink).toHaveBeenCalledWith(t);
  });

  /**
   * *"Copy link and Full screen should be icons instead of text buttons,
   * Asana-style."* An icon-only control that carries neither an `aria-label`
   * nor a `title` is a control nobody can identify — a screen reader announces
   * the glyph and a desktop hover says nothing — so the names are asserted here
   * rather than left to the glyphs.
   */
  it('names every head action, because each one is a glyph and nothing else', () => {
    renderTaskDetail(root, task(), handlers({ onCopyLink: vi.fn() }));
    const named = [...root.querySelectorAll<HTMLElement>('.hub-detail-head-actions .hub-btn')].map(
      (b) => [b.textContent ?? '', b.getAttribute('aria-label'), b.title],
    );
    expect(named).toEqual([
      ['🔗', 'Copy a link to this task', 'Copy a link to this task'],
      ['⤢', 'Full screen', 'Full screen'],
      ['✕', 'Close task detail', 'Close task detail'],
    ]);
    // Positive control on the assertion above: every one of them is an icon
    // button, so "the label is the only name" is a fact rather than an
    // assumption about which of these carry words.
    expect(named.every(([glyph]) => (glyph as string).length <= 2)).toBe(true);
  });

  /**
   * Full screen is a preference of the READER, so it lives on the container:
   * the panel is rebuilt on every repaint, and a class held there would be
   * dropped by the next comment that landed.
   */
  it('toggles full screen on the container, and keeps it across a repaint', () => {
    const t = task();
    renderTaskDetail(root, t, handlers());
    const btn = () => root.querySelector('.hub-detail-expand') as HTMLElement;
    expect(btn().getAttribute('aria-label')).toBe('Full screen');
    expect(btn().getAttribute('aria-pressed')).toBe('false');

    btn().click();
    expect(root.classList.contains('hub-detail--full')).toBe(true);
    expect(btn().getAttribute('aria-label')).toBe('Exit full screen');
    // The board stops reserving room once the panel covers it.
    expect(document.body.classList.contains('hub-detail-full')).toBe(true);

    renderTaskDetail(root, { ...t, status: 'done' }, handlers());
    expect(value('Status')).toBe('done'); // control
    expect(root.classList.contains('hub-detail--full')).toBe(true);
    expect(btn().getAttribute('aria-pressed')).toBe('true');

    btn().click();
    expect(root.classList.contains('hub-detail--full')).toBe(false);
  });
});

/**
 * The review region inside a ticket is a QUEUE.
 *
 * Bryan, 2026-08-18: *"For decisions, the ticket title is not the decision. A
 * decision is a part of a ticket, and there should be a decision blurb above
 * the options. And over time, there may be more than one decision associated
 * with a ticket. In fact, at any point in time there might be multiple open
 * decisions for a ticket. Please accommodate and have a similar review queue
 * within a ticket details interface."*
 *
 * What that replaced: two independent regions, a decision card and an "ask"
 * panel, each rendering one item and each blind to the other — so a task with
 * both showed two competing headers, and a task with three thread items showed
 * one and silently dropped two.
 */
describe('the panel’s review queue', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const handlers = (over: Record<string, unknown> = {}) => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
    onComment: vi.fn(),
    now: NOW,
    ...over,
  });

  const ask = (over: Partial<ReviewThreadItem> = {}): ReviewThreadItem => ({
    kind: 'task-thread',
    docId: 'task:t-1',
    threadId: 'th-1',
    taskId: 't-1',
    title: 'Some task',
    ask: 'Which way on the index?',
    askedBy: 'Index Rebuild',
    since: NOW - 3_600_000,
    ...over,
  });

  const cards = (): string[] =>
    [...root.querySelectorAll<HTMLElement>('.hub-decide-card')].map(
      (c) => c.dataset.reviewItemId ?? '',
    );
  const shown = (): HTMLElement | null =>
    root.querySelector<HTMLElement>('.hub-decide-card:not(.hidden)');

  describe('decisionBlurb', () => {
    it('takes the question as the headline and the rest as the stakes', () => {
      expect(
        decisionBlurb('## Ship it Thursday?\n\nThe rework is blocked either way.\n\n- Yes\n- No'),
      ).toEqual({
        headline: 'Ship it Thursday?',
        why: 'The rework is blocked either way.',
      });
    });

    it('drops the option list rather than repeating it as prose', () => {
      // The card renders the options as buttons; a copy of them in the blurb
      // is the "crammed" complaint one layer up.
      expect(decisionBlurb('Which one?\n1. Blue\n2. Green').why).toBe('');
    });

    it('drops the label that introduced the dropped list, and keeps other colons', () => {
      // Found in the browser, not in a fixture: with `Options:` kept, the
      // orphaned label welds onto the sentence AFTER the list. The positive
      // control is in the same assertion — a colon that introduces prose
      // rather than a list survives, so this is a narrowing and not a rule
      // against colons.
      const body = [
        'Where should it live?',
        '',
        'Both screens are built.',
        '',
        'Options:',
        '',
        '- Top of the screen',
        '- In the settings row',
        '',
        'Blocked until answered: the rework cannot merge.',
      ].join('\n');
      expect(decisionBlurb(body).why).toBe(
        'Both screens are built. Blocked until answered: the rework cannot merge.',
      );
    });

    it('says nothing rather than inventing a question from a body with none', () => {
      expect(decisionBlurb('Just a note about the index.')).toEqual({
        headline: '',
        why: 'Just a note about the index.',
      });
      expect(decisionBlurb(undefined)).toEqual({ headline: '', why: '' });
    });
  });

  describe('panelReviewQueue', () => {
    it('merges the task’s own decision with every thread item, decision first', () => {
      const t = task({ id: 't-1', needs: 'decision', body: 'Ship it Thursday?' });
      const q = panelReviewQueue(t, [ask({ threadId: 'th-a' }), ask({ threadId: 'th-b' })]);
      expect(q.map((i) => i.id)).toEqual(['task:t-1', 'thread:th-a', 'thread:th-b']);
      // The blurb, not the ticket title: *"the ticket title is not the
      // decision"*.
      expect(q[0]?.headline).toBe('Ship it Thursday?');
    });

    it('falls back to the title only when the body says nothing', () => {
      const t = task({ id: 't-1', title: 'Decide the index order', needs: 'decision', body: '' });
      expect(panelReviewQueue(t, [])[0]?.headline).toBe('Decide the index order');
    });

    /**
     * The keys DISAGREE here on purpose. `th-old` is the oldest and would win
     * on age alone; `th-declared` carries a declaration and `th-direct` names a
     * person, so a recency-only ranking — or a declaration-only one — produces
     * a different order. A fixture where the keys agree proves only that the
     * first key exists.
     */
    it('ranks declared over direct over merely old, when the three disagree', () => {
      const t = task({ id: 't-1' });
      const q = panelReviewQueue(t, [
        ask({ threadId: 'th-old', since: NOW - 90_000_000 }),
        ask({
          threadId: 'th-direct',
          direct: true,
          since: NOW - 60_000_000,
        }),
        ask({
          threadId: 'th-declared',
          since: NOW - 10_000,
          review: { shape: 'review', headline: 'Read the redline', why: 'It changes the API.' },
        }),
      ]);
      expect(q.map((i) => i.id)).toEqual([
        'thread:th-declared',
        'thread:th-direct',
        'thread:th-old',
      ]);
    });

    it('is empty on an answered decision, and on a task with nothing waiting', () => {
      expect(panelReviewQueue(task({ needs: 'decision' }), [])).toHaveLength(1); // control
      expect(
        panelReviewQueue(
          task({ needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
          [],
        ),
      ).toHaveLength(0);
      expect(panelReviewQueue(task(), undefined)).toHaveLength(0);
    });
  });

  it('walks several items one at a time, saying which one you are on', () => {
    const t = task({ id: 't-1', needs: 'decision', body: 'Ship it Thursday?' });
    renderTaskDetail(root, t, handlers({ asks: [ask({ threadId: 'th-a' })] }), {
      loading: false,
      threads: [],
    });
    expect(cards()).toEqual(['task:t-1', 'thread:th-a']);
    // Built, not unbuilt: stepping must not tear down an answer box somebody is
    // typing into, which is why the others are hidden rather than absent.
    expect(shown()?.dataset.reviewItemId).toBe('task:t-1');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('1 of 2');

    const [prev, next] = [...root.querySelectorAll<HTMLButtonElement>('.hub-decide-step')];
    expect(prev?.disabled).toBe(true);
    next?.click();
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('2 of 2');
    expect(next?.disabled).toBe(true);
    prev?.click();
    expect(shown()?.dataset.reviewItemId).toBe('task:t-1');
  });

  /** *"With exactly one item it must look like today's single card."* A "1 of
   *  1" counter and two dead arrows are furniture that says nothing. */
  it('shows no walkthrough chrome at all when there is only one item', () => {
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers(), {
      loading: false,
      threads: [],
    });
    expect(root.querySelector('.hub-decide-card')).toBeTruthy(); // control
    expect(root.querySelector('.hub-decide-walk')).toBeNull();
    expect(root.querySelector('.hub-decide-step')).toBeNull();
    expect(root.querySelector('.hub-decide-count')?.textContent ?? '').toBe('');
  });

  /** The panel repaints on every board change. A position that reset would
   *  walk the reader back to the first question while they answered the third
   *  — the same failure the tab and the description slot are guarded against. */
  it('keeps the walkthrough position across a repaint, and resets it on another task', () => {
    const t = task({ id: 't-1', needs: 'decision' });
    const paint = (x = t) =>
      renderTaskDetail(root, x, handlers({ asks: [ask({ threadId: 'th-a' })] }), {
        loading: false,
        threads: [],
      });
    paint();
    [...root.querySelectorAll<HTMLButtonElement>('.hub-decide-step')][1]?.click();
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');

    paint({ ...t, status: 'in-progress' });
    expect(
      (root.querySelector('.hub-detail-status') as HTMLSelectElement).value, // control
    ).toBe('in-progress');
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-a');

    renderTaskDetail(root, task({ id: 't-2', needs: 'decision' }), handlers({ asks: [] }), {
      loading: false,
      threads: [],
    });
    expect(shown()?.dataset.reviewItemId).toBe('task:t-2');
  });

  /** A deep link names a thread. Opening the queue at whatever happened to be
   *  first would answer a different question than the one that summoned them. */
  it('opens at the item a deep link named, not at the top of the queue', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision' }),
      handlers({
        asks: [ask({ threadId: 'th-a' }), ask({ threadId: 'th-b' })],
        focusThreadId: 'th-b',
      }),
      { loading: false, threads: [] },
    );
    expect(cards()).toEqual(['task:t-1', 'thread:th-a', 'thread:th-b']);
    expect(shown()?.dataset.reviewItemId).toBe('thread:th-b');
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('3 of 3');
  });

  /** Two destinations, one card: a thread item is answered by REPLYING there,
   *  so the agent watching hears it; the task's own decision goes through
   *  `answer_decision`. Both in one pass, because a card that sent everything
   *  one way would pass either half alone. */
  it('answers a thread item as a reply and the task’s decision as a decision', () => {
    const onAnswer = vi.fn();
    const onAnswerThread = vi.fn().mockResolvedValue(true);
    const t = task({ id: 't-1', needs: 'decision' });
    renderTaskDetail(
      root,
      t,
      handlers({ onAnswer, onAnswerThread, asks: [ask({ threadId: 'th-a' })] }),
      { loading: false, threads: [] },
    );
    const answerIn = (card: HTMLElement, text: string) => {
      const form = card.querySelector('.hub-decide-form') as HTMLFormElement;
      (form.querySelector('textarea') as HTMLTextAreaElement).value = text;
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    };
    const [taskCard, threadCard] = [...root.querySelectorAll<HTMLElement>('.hub-decide-card')];
    answerIn(taskCard!, 'Thursday.');
    expect(onAnswer).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      'Thursday.',
      undefined,
    );
    expect(onAnswerThread).not.toHaveBeenCalled();

    answerIn(threadCard!, 'Rebuild it nightly.');
    expect(onAnswerThread).toHaveBeenCalledWith(
      expect.objectContaining({ id: 't-1' }),
      expect.objectContaining({ threadId: 'th-a' }),
      'Rebuild it nightly.',
      undefined,
    );
  });

  /**
   * Critical, measured in the browser 2026-08-18: answering the task's own
   * decision retired the ENTIRE region, including two thread items the server
   * still reported as open. The reader was left with no queue and nothing
   * saying two questions were still waiting on them.
   */
  it('keeps the queue for the items still open after one is answered', () => {
    const answered = task({
      id: 't-1',
      needs: 'decision',
      answer: { by: 'Jordan', text: 'Thursday.', ts: NOW },
    });
    renderTaskDetail(
      root,
      answered,
      handlers({ asks: [ask({ threadId: 'th-a' }), ask({ threadId: 'th-b' })] }),
      { loading: false, threads: [] },
    );
    // What was decided is still said…
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Thursday.');
    // …and the two items that are still open are still reachable, with the
    // walkthrough chrome that says how many there are.
    expect(cards()).toEqual(['thread:th-a', 'thread:th-b']);
    expect(root.querySelector('.hub-decide-count')?.textContent).toBe('1 of 2');
  });

  it('renders the answer alone when nothing else is waiting', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
      handlers({ asks: [] }),
      { loading: false, threads: [] },
    );
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Thursday.');
    expect(cards()).toEqual([]);
  });

  /** A single unconfirmed click committed an answer with no way back. The
   *  recovery is a persistent undo rather than a confirm step or a timed
   *  toast: it costs the deliberate 99% nothing and is still there when the
   *  mistake is noticed a minute later. */
  it('offers an undo beside the recorded answer, and calls it once', () => {
    const onUndoAnswer = vi.fn().mockResolvedValue(true);
    const t = task({
      id: 't-1',
      needs: 'decision',
      answer: { by: 'Jordan', text: 'Thursday.', ts: NOW },
    });
    renderTaskDetail(root, t, handlers({ onUndoAnswer, asks: [] }), {
      loading: false,
      threads: [],
    });
    const undo = root.querySelector<HTMLButtonElement>('.hub-detail-undo-answer');
    expect(undo).toBeTruthy();
    undo?.click();
    expect(onUndoAnswer).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }));
    // Disabled for the round trip, so a double tap cannot withdraw twice.
    expect(undo?.disabled).toBe(true);
  });

  it('renders no undo when the app offers none, rather than a dead button', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision', answer: { by: 'Jordan', text: 'Thursday.', ts: NOW } }),
      // The helper's spread does not remove a key, so this is how "no handler"
      // is expressed — and the control above proves the button appears when
      // there IS one.
      { ...handlers({ asks: [] }), onUndoAnswer: undefined },
      { loading: false, threads: [] },
    );
    expect(root.querySelector('.hub-detail-undo-answer')).toBeNull();
    expect(root.querySelector('.hub-detail-answer')?.textContent).toContain('Thursday.');
  });

  it('says why an empty answer did nothing, instead of doing nothing silently', () => {
    const onAnswer = vi.fn();
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers({ onAnswer }), {
      loading: false,
      threads: [],
    });
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(onAnswer).not.toHaveBeenCalled();
    const note = form.querySelector('.hub-form-error');
    expect(note?.textContent).toContain('Write an answer');
    // …and it goes away the moment the reason does.
    (form.querySelector('textarea') as HTMLTextAreaElement).dispatchEvent(
      new Event('input', { bubbles: true }),
    );
    expect(form.querySelector('.hub-form-error')).toBeNull();
  });

  it('puts a refused answer back in the box', async () => {
    const onAnswerThread = vi.fn().mockResolvedValue(false);
    renderTaskDetail(
      root,
      task({ id: 't-1' }),
      handlers({ onAnswerThread, asks: [ask({ threadId: 'th-a' })] }),
      { loading: false, threads: [] },
    );
    const form = root.querySelector('.hub-decide-form') as HTMLFormElement;
    const ta = form.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'Rebuild it nightly.';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    expect(ta.value).toBe('');
    await Promise.resolve();
    await Promise.resolve();
    expect(ta.value).toBe('Rebuild it nightly.');
  });

  it('makes the panel title reachable from the keyboard, like the board row', () => {
    // The board's title carries `tabIndex 0` + a tooltip; the panel's carried
    // neither, so renaming there was pointer-only and nothing said the title
    // was editable at all.
    renderTaskDetail(root, task({ id: 't-1', title: 'Old title' }), handlers(), {
      loading: false,
      threads: [],
    });
    const title = root.querySelector('.hub-detail-title') as HTMLElement;
    expect(title.tabIndex).toBe(0);
    expect(title.title).toMatch(/rename/i);
    title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(title.querySelector('input')).not.toBeNull();
  });

  it('shows a rename, a rewrite and a reassignment in the ticket’s own history', () => {
    // Measured 2026-08-18: the Activity tab rendered `task.transitions` and
    // nothing else, so every one of these was in the workspace log and on no
    // surface of the ticket it changed.
    const t = task({ id: 't-1', title: 'Ship the index' });
    renderTaskDetail(
      root,
      t,
      handlers({
        activity: [
          {
            event: 'task.retitled',
            ts: NOW - 3000,
            taskId: 't-1',
            actor: { name: 'Jordan' },
            titleFrom: 'Index',
            titleTo: 'Ship the index',
          },
          {
            event: 'task.assigned',
            ts: NOW - 2000,
            taskId: 't-1',
            actor: { name: 'Jordan' },
            from: 'human',
            to: 'agent-index',
          },
          { event: 'task.body_edited', ts: NOW - 1000, taskId: 't-1', actor: { name: 'Jordan' } },
          // Another task's row, in the same feed the panel is handed.
          {
            event: 'task.retitled',
            ts: NOW,
            taskId: 't-2',
            actor: { name: 'Jordan' },
            titleFrom: 'A',
            titleTo: 'B',
          },
        ],
      }),
      { loading: false, threads: [] },
    );
    const rows = [...root.querySelectorAll('.hub-detail-transitions li')].map(
      (li) => li.textContent ?? '',
    );
    expect(rows.some((r) => r.includes('renamed'))).toBe(true);
    expect(rows.some((r) => r.includes('assigned'))).toBe(true);
    expect(rows.some((r) => r.includes('rewrote the description'))).toBe(true);
    // Only this ticket's rows: the feed is the whole workspace's.
    expect(rows.some((r) => r.includes('“B”'))).toBe(false);
    // Newest first, and the stored transitions are still in the same list.
    expect(rows[0]).toContain('rewrote the description');
    expect(rows.some((r) => r.includes('→'))).toBe(true);
  });

  it('names the description, and separates it from the fields and the queue', () => {
    // *"Add a Description heading with proper spacing separating it from the
    // fields/decision area above."* The spacing is CSS (asserted in
    // `hub-detail-css.test.ts`); what belongs here is that the heading exists,
    // says the word, and sits between the queue and the prose rather than
    // anywhere else in the panel.
    renderTaskDetail(root, task({ id: 't-1', needs: 'decision' }), handlers(), {
      loading: false,
      threads: [],
    });
    const head = root.querySelector('.hub-detail-body-head') as HTMLElement;
    expect(head.textContent).toBe('Description');
    const decide = root.querySelector('.hub-decide') as HTMLElement;
    const slot = root.querySelector(`.${BODY_LIVE_CLASS}, .hub-detail-body-slot`) as HTMLElement;
    const precedes = (a: Element, b: Element) =>
      Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(precedes(decide, head)).toBe(true);
    expect(precedes(head, slot)).toBe(true);
  });

  /** The board reflows out from under the split pane, and the marker is a body
   *  class rather than a `:has()` inference — the two live under different
   *  subtrees, and a class is what a stylesheet and a test can both read. */
  it('marks the body while the panel is open, and unmarks it on close', () => {
    renderTaskDetail(root, task({ id: 't-1' }), handlers());
    expect(document.body.classList.contains('hub-detail-open')).toBe(true);
    renderTaskDetail(root, null, handlers());
    expect(document.body.classList.contains('hub-detail-open')).toBe(false);
    expect(root.querySelector('.hub-detail-panel')).toBeNull(); // control
  });

  it('offers the board’s goals, keeps the task’s own, and commits a move', () => {
    const onGoalSet = vi.fn();
    // The task sits on a goal the list does NOT carry — a stale or deleted
    // band must not silently re-place the task on the next change event.
    renderTaskDetail(
      root,
      task({ id: 't-1', goal: 'g-gone' }),
      handlers({ goals: GOALS, onGoalSet, goalLabel: (id: string) => `Goal ${id}` }),
    );
    const sel = root.querySelector('.hub-detail-goal') as HTMLSelectElement;
    expect([...sel.options].map((o) => o.value)).toEqual(['g-pr', 'g-sub', 'g-gone']);
    expect(sel.value).toBe('g-gone');
    expect([...sel.options].map((o) => o.textContent)).toEqual([
      '1. Get the PR out',
      '— 1.1 Tickets',
      'Goal g-gone',
    ]);
    sel.value = 'g-sub';
    sel.dispatchEvent(new Event('change'));
    expect(onGoalSet).toHaveBeenCalledWith(expect.objectContaining({ id: 't-1' }), 'g-sub');
    // Re-picking the goal it is already on is not a move.
    onGoalSet.mockClear();
    sel.value = 'g-gone';
    sel.dispatchEvent(new Event('change'));
    expect(onGoalSet).not.toHaveBeenCalled();
  });

  /** Each card keeps its OWN draft, keyed by item — walking to the next
   *  question and back must not hand the reader words they wrote for another. */
  it('keeps a separate answer draft per item', () => {
    renderTaskDetail(
      root,
      task({ id: 't-1', needs: 'decision' }),
      handlers({ asks: [ask({ threadId: 'th-a' })] }),
      { loading: false, threads: [] },
    );
    const keys = [...root.querySelectorAll<HTMLTextAreaElement>('.hub-decide-form textarea')].map(
      (ta) => ta.dataset.keep,
    );
    expect(keys).toEqual(['answer:t-1:task:t-1', 'answer:t-1:thread:th-a']);
  });
});

/**
 * *"Multi-threaded comments are too complicated — just a single sequence of
 * comments with clearer separation, authorship and timing."*
 *
 * A change to the RENDERING and to nothing else: the threads this reads are
 * the threads `create_thread` writes, and every row keeps the `threadId` a
 * reply has to land in.
 */
describe('flattenComments', () => {
  const c = (author: string, ts: number) => ({ author, text: `${author} at ${ts}`, ts });

  /**
   * Two conversations that INTERLEAVE. A fixture where each thread's comments
   * are contiguous in time cannot tell "one sequence, oldest first" apart from
   * "the old per-thread grouping, concatenated" — the two produce an identical
   * order, so it would pass against the code being replaced.
   */
  it('reads every comment oldest first, across threads', () => {
    const rows = flattenComments([
      { id: 'th-a', status: 'open', comments: [c('Jordan', 10), c('Jordan', 40)] },
      { id: 'th-b', status: 'open', comments: [c('Sam', 20), c('Sam', 30)] },
    ]);
    expect(rows.map((r) => r.comment.ts)).toEqual([10, 20, 30, 40]);
    expect(rows.map((r) => r.threadId)).toEqual(['th-a', 'th-b', 'th-b', 'th-a']);
  });

  /** Which row carries the anchor, and which carries the badge and the Reply
   *  button — one of each per conversation, wherever the sort puts them. */
  it('marks the first and last comment of each thread, not of the stream', () => {
    const rows = flattenComments([
      { id: 'th-a', status: 'open', comments: [c('Jordan', 10), c('Jordan', 40)] },
      { id: 'th-b', status: 'resolved', comments: [c('Sam', 20), c('Sam', 30)] },
    ]);
    expect(rows.map((r) => r.opensThread)).toEqual([true, true, false, false]);
    expect(rows.map((r) => r.closesThread)).toEqual([false, false, true, true]);
    expect(rows.map((r) => r.status)).toEqual(['open', 'resolved', 'resolved', 'open']);
  });

  it('carries the anchor text through, and omits it when a thread has none', () => {
    const rows = flattenComments([
      { id: 'th-a', status: 'open', anchorText: 'the second paragraph', comments: [c('Jo', 1)] },
      { id: 'th-b', status: 'open', comments: [c('Sam', 2)] },
    ]);
    expect(rows[0]?.anchorText).toBe('the second paragraph');
    expect(rows[1]?.anchorText).toBeUndefined();
  });

  /** Two comments written in the same millisecond are a fixture, not a race —
   *  an unstable sort would repaint the panel into a different order for no
   *  reason a reader could see. */
  it('breaks a timestamp tie by declaration order, every time', () => {
    const threads: TaskThread[] = [
      { id: 'th-a', status: 'open', comments: [c('Jordan', 5)] },
      { id: 'th-b', status: 'open', comments: [c('Sam', 5), c('Sam', 5)] },
    ];
    for (let i = 0; i < 5; i += 1) {
      expect(flattenComments(threads).map((r) => r.comment.author)).toEqual([
        'Jordan',
        'Sam',
        'Sam',
      ]);
    }
  });

  it('has nothing to say about a task with no threads', () => {
    expect(flattenComments([])).toEqual([]);
    // Control: the same call over one thread is not empty, so the line above
    // is about the input rather than about a function that returns nothing.
    expect(flattenComments([{ id: 'th', status: 'open', comments: [c('Jo', 1)] }])).toHaveLength(1);
  });
});

/**
 * The description is edited where it is read, so the panel's repaint has to
 * leave one node alone.
 *
 * Every ydoc change repaints this panel — a peer's status flip, a comment
 * landing, and the reader's OWN typing, since the body snapshot lands in the
 * projection a few hundred ms after a pause. A repaint that rebuilt the
 * description would tear the editor out from under whoever is typing in it:
 * even MOVING the node removes it from the document first, which blurs it and
 * drops the caret. So the slot is kept, and only when it is live.
 */
describe('the description slot the editor mounts into', () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });

  const detailHandlers = () => ({
    onClose: vi.fn(),
    onStatusSet: vi.fn(),
    onTitleCommit: vi.fn(),
    onAnswer: vi.fn(),
    onAssign: vi.fn(),
  });

  const slot = () => root.querySelector('.hub-detail-body-slot') as HTMLElement | null;
  /** What the mount does to a slot, without dragging Tiptap into a DOM test:
   *  claim the node, then put something in it that is not the projection. */
  const goLive = (el: HTMLElement, text = 'the editor’s own content') => {
    el.classList.add(BODY_LIVE_CLASS);
    el.replaceChildren(document.createTextNode(text));
  };

  it('holds the description, and says which task it belongs to', () => {
    const t = task({ body: 'Agent can **read** it here so that it can start cold.' });
    renderTaskDetail(root, t, detailHandlers());
    const s = slot();
    expect(s?.dataset.taskId).toBe(t.id);
    // Still rendered markdown, not asterisks — the pre-mount fallback is the
    // description, not a placeholder for one.
    expect(s?.querySelector('.hub-detail-body strong')?.textContent).toBe('read');
  });

  it('keeps the very same node across a repaint once the editor owns it', () => {
    const t = task({ body: 'First.' });
    renderTaskDetail(root, t, detailHandlers());
    const s = slot() as HTMLElement;
    goLive(s);

    renderTaskDetail(root, { ...t, title: 'Renamed', body: 'Second.' }, detailHandlers());

    expect(slot()).toBe(s);
    // Untouched by the repaint — including by the newer projection body,
    // which the editor is ahead of rather than behind.
    expect(s.textContent).toBe('the editor’s own content');
    // …while everything around it followed the change.
    expect(root.querySelector('.hub-detail-title')?.textContent).toBe('Renamed');
  });

  // The other half, and the reason the class exists at all: before the mount
  // the slot is showing the PROJECTION, and a projection that stopped
  // updating would leave a description the store no longer has.
  it('rebuilds a slot no editor has claimed, so the text follows the store', () => {
    const t = task({ body: 'First.' });
    renderTaskDetail(root, t, detailHandlers());
    const s = slot();
    renderTaskDetail(root, { ...t, body: 'Second.' }, detailHandlers());

    expect(slot()).not.toBe(s);
    expect(slot()?.textContent).toContain('Second.');
  });

  // A live editor is bound to ONE room. Carrying its node onto another task
  // would show task A's description on task B and write B's typing into A.
  it('replaces the slot when the panel moves to another task', () => {
    const a = task({ body: 'A.' });
    renderTaskDetail(root, a, detailHandlers());
    const s = slot() as HTMLElement;
    goLive(s);

    renderTaskDetail(root, task({ body: 'B.' }), detailHandlers());

    expect(slot()).not.toBe(s);
    expect(slot()?.textContent).toContain('B.');
    expect(slot()?.classList.contains(BODY_LIVE_CLASS)).toBe(false);
  });

  it('drops the slot with the panel when the reader closes it', () => {
    const t = task({ body: 'A.' });
    renderTaskDetail(root, t, detailHandlers());
    goLive(slot() as HTMLElement);
    renderTaskDetail(root, null, detailHandlers());

    expect(slot()).toBeNull();
    // Reopening the same task builds a fresh one rather than resurrecting a
    // node whose editor and websocket the host has already torn down.
    renderTaskDetail(root, t, detailHandlers());
    expect(slot()?.classList.contains(BODY_LIVE_CLASS)).toBe(false);
  });

  // The description and the place to change it used to be on two pages. The
  // link stays, because the full surface has anchored comments and a wider
  // page — but it is no longer the way to edit, and the copy has to say so.
  it('the link out is a second way in, not the way to edit', () => {
    const t = task({ body: 'Something.' });
    renderTaskDetail(root, t, detailHandlers());
    const a = root.querySelector('.hub-detail-body-link a') as HTMLAnchorElement;
    expect(a.getAttribute('href')).toBe(`/review/${encodeURIComponent(t.bodyDocId)}`);
    expect(a.textContent).toBe('Open in the full editor');

    // Same copy with no description: the old wording branched on the body
    // ("Write the description in the task doc"), which sent the one reader
    // most likely to type something to another page to do it.
    renderTaskDetail(root, task(), detailHandlers());
    expect(root.querySelector('.hub-detail-body-link a')?.textContent).toBe(
      'Open in the full editor',
    );
  });

  it('the panel still closes on a tap outside it after a repaint that kept the slot', () => {
    const onClose = vi.fn();
    const t = task({ body: 'A.' });
    renderTaskDetail(root, t, { ...detailHandlers(), onClose });
    goLive(slot() as HTMLElement);
    renderTaskDetail(root, { ...t, title: 'Renamed' }, { ...detailHandlers(), onClose });

    root.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Exactly once: the backdrop handler is wired when the panel is built and
    // the kept path must not stack a second copy on the same container.
    expect(onClose).toHaveBeenCalledTimes(1);
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
 * phone media block that restyles the walkthrough must also reserve bottom
 * clearance in the card, or its last control ("Tell me more" on a decision
 * card) ends up under the bottom-docked mic/pencil launchers.
 *
 * The anchor for "the phone block" has moved twice, each time because the
 * surface changed shape: first a sticky .hub-walk-nav, then a panel taken to
 * max-height: 100vh. It is now the stacked reply form, because the
 * walkthrough is a PAGE in the Home column (approved mockup) and no longer
 * goes full-screen at all — which is also why this file asserts, below, that
 * nothing puts it back on `position: fixed`.
 */
describe('the walkthrough page reserves launcher clearance on a phone', () => {
  it('gives the card bottom clearance wherever the phone block restyles it', async () => {
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
    const phone = blocks.filter((b) => /\.hub-walk-answer[^{]*\{/.test(b));
    // Positive control: the block this asserts about exists and was matched.
    expect(phone.length).toBeGreaterThan(0);
    for (const b of phone) {
      expect(b).toMatch(/\.hub-walk-card\s*\{[^}]*padding-bottom:\s*calc\([\d.]+px/);
    }
    // The stepper lives in the head now — nothing may make it sticky again
    // without restoring the reserve that travelled with the old bar.
    expect(css).not.toMatch(/\.hub-walk-nav\s*\{[^}]*position:\s*sticky/);
    // And the page must stay a page: a fixed overlay over the board is the
    // layout that got rejected, and it takes the Back-to-Home link's meaning
    // with it.
    expect(css).not.toMatch(/\.hub-walk(through|-panel)[^{]*\{[^}]*position:\s*fixed/);
  });
});

/**
 * happy-dom does no layout, so what is checkable here is the rule that makes
 * the phone layout work. Measured in a real 430px frame: the kind badge takes
 * ~180px of the line, and a title free to shrink to zero comes out about
 * 110px wide — a one-line question stacked seven words tall. The floor is
 * what makes the head WRAP instead, which is what the mockup draws.
 */
describe('the walkthrough card head keeps a readable title on a phone', () => {
  it('gives the title a width floor rather than letting it shrink to nothing', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-walk-title\s*\{([^}]*)\}/)?.[1] ?? '';
    // Positive control: the rule this asserts about was found and is the one
    // that lays the title out.
    expect(rule).toMatch(/flex:\s*1/);
    const floor = rule.match(/min-width:\s*(\d+)px/)?.[1];
    expect(Number(floor ?? 0)).toBeGreaterThanOrEqual(120);
    // The floor only works because a long unbroken token has its own escape.
    expect(rule).toMatch(/overflow-wrap:\s*anywhere/);
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
      'command claude plugin update claude-workspaces@claude-workspaces',
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

describe('renderPresence — compact circle mode (the top-right cluster)', () => {
  const person = (name: string, key = `p-${name}`): PresenceChip => ({
    key,
    label: name,
    kind: 'person',
    where: 'hub',
    title: `${name} · in hub · just now`,
    docId: 'doc-1',
  });
  const agent = (id: string): PresenceChip => ({
    key: `a-${id}`,
    label: id,
    kind: 'agent',
    where: 'active',
    title: `${id} · active · last tool call just now`,
    state: 'active',
  });
  const noop = { onTap: () => {}, onLongPress: () => {} };

  it('renders circles with initials, keeping the full detail in title and aria-label', () => {
    const host = document.createElement('div');
    renderPresence(host, [person('Ana Reyes'), agent('task-list-ux')], null, noop, [], true);
    const circles = host.querySelectorAll('.hub-presence-circle');
    expect(circles.length).toBe(2);
    // No long-form chip anywhere in compact mode…
    expect(host.querySelector('.hub-presence-chip')).toBeNull();
    const [p, a] = [...circles];
    expect(p?.querySelector('.hub-presence-initials')?.textContent).toBe('AR');
    expect(p?.getAttribute('title')).toBe('Ana Reyes · in hub · just now');
    expect(p?.getAttribute('aria-label')).toBe('Ana Reyes · in hub · just now');
    // …and the agent circle keeps the kind class the styling keys off.
    expect(a?.classList.contains('hub-presence-agent')).toBe(true);
    expect(a?.querySelector('.hub-presence-initials')?.textContent).toBe('TL');
    // Positive control: the same chips long-form still render as chips.
    renderPresence(host, [person('Ana Reyes')], null, noop, []);
    expect(host.querySelector('.hub-presence-chip')?.textContent).toContain('Ana Reyes');
  });

  it('keeps tap, liveness state, and following on a circle', () => {
    const host = document.createElement('div');
    const tapped: PresenceChip[] = [];
    const chip: PresenceChip = { ...agent('quill'), state: 'unresponsive' };
    renderPresence(host, [chip], chip.key, { ...noop, onTap: (c) => tapped.push(c) }, [], true);
    const el = host.querySelector<HTMLButtonElement>('.hub-presence-circle');
    expect(el?.classList.contains('hub-presence-unresponsive')).toBe(true);
    expect(el?.classList.contains('hub-following')).toBe(true);
    el?.click();
    expect(tapped.map((c) => c.key)).toEqual([chip.key]);
  });

  it('clamps at four: five people render as three circles plus a "+2" that names the rest', () => {
    const host = document.createElement('div');
    const chips = ['Ana', 'Ben', 'Cam', 'Dee', 'Eli'].map((n) => person(n));
    const overflowed: PresenceChip[][] = [];
    renderPresence(host, chips, null, { ...noop, onOverflow: (h) => overflowed.push(h) }, [], true);
    const circles = host.querySelectorAll('.hub-presence-circle');
    expect(circles.length).toBe(4); // 3 people + the overflow slot
    const more = host.querySelector<HTMLButtonElement>('.hub-presence-more');
    expect(more?.textContent).toBe('+2');
    expect(more?.getAttribute('title')).toBe('Dee, Eli');
    more?.click();
    expect(overflowed).toEqual([[chips[3], chips[4]]]);
    // Positive control for the boundary: exactly four renders four circles
    // and NO overflow slot — the cap is a footprint, not a count.
    renderPresence(host, chips.slice(0, 4), null, noop, [], true);
    expect(host.querySelectorAll('.hub-presence-circle').length).toBe(4);
    expect(host.querySelector('.hub-presence-more')).toBeNull();
  });
});

/**
 * happy-dom does no layout, so the popover and the 430px fit are pinned at
 * the rule level, the same way the walkthrough title floor is above: assert
 * the declarations that make the behaviour, with a presence check first so
 * a renamed selector fails loudly rather than passing vacuously.
 */
describe('settings popover + presence visibility (CSS contract)', () => {
  const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');

  it('the settings panel floats instead of shifting the page', () => {
    const rule = css.match(/\.hub-settings-panel\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('background'); // positive control: found the rule
    expect(rule).toMatch(/position:\s*absolute/);
    // Anchored to the header, which must therefore be a positioned ancestor.
    const topbar = css.match(/\.hub-topbar\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(topbar).toMatch(/position:\s*relative/);
  });

  it('no width band hides the circle presence strip any more', () => {
    // The old ≤560px rule was `.hub-presence.hub-people { display: none }`.
    // The circles fit, so nothing may hide the strip at any width.
    const peopleRules = [...css.matchAll(/\.hub-presence\.hub-people\s*\{([^}]*)\}/g)];
    expect(peopleRules.length).toBeGreaterThan(0); // positive control
    for (const [, body] of peopleRules) {
      expect(body).not.toMatch(/display:\s*none/);
    }
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
    // Collect the strip's OWN rules rather than slicing to whatever selector
    // happens to follow it. The slice form read to `.hub-walkthrough {`, and
    // when that rule went away (the walkthrough stopped being a fixed overlay)
    // `indexOf` returned -1 and the "block" became the rest of the file — a
    // test that then fails on somebody else's colour.
    const rules = [...css.matchAll(/\.hub-unplaced[\w-]*(?:\.[\w-]+)?\s*\{([^}]*)\}/g)].map(
      (m) => m[1] ?? '',
    );
    // Positive control: the rules this asserts about really were found.
    expect(rules.length).toBeGreaterThan(1);
    expect(rules.some((r) => r.includes('--fg-muted'))).toBe(true);
    for (const r of rules) expect(r).not.toContain('--yellow');
    // The tap target still has to be reachable on a phone.
    expect(rules.some((r) => /min-height:\s*36px/.test(r))).toBe(true);
  });
});
