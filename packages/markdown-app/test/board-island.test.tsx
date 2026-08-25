/**
 * The board as a Preact island — the goal bands and the task rows that
 * `renderBoard` used to empty its container and rebuild on every paint.
 *
 * Three families of properties under test:
 *
 *  1. The island contract: an unchanged row survives a signal update as the
 *     IDENTICAL node object, disposal is render(null, el), and the island owns
 *     a wrapper rather than the host. The identity assertion carries its own
 *     positive control — the same comparison against a deliberately unkeyed
 *     list, which DOES rebuild — because a `toBe` that cannot fail proves
 *     nothing. (Measured against the vanilla `renderBoard` before it was
 *     deleted: it failed there, on every row, on every update.)
 *
 *  2. The defects the migration exists for, in the form they take HERE. A
 *     board repaint used to destroy an in-flight rename, drop the focus a
 *     keyboard reorder depends on, and close the "New goal" box over what had
 *     been typed into it — the last of which is the two-tap report: the first
 *     tap opened the box, a background event closed it again, and the reader
 *     tapped a second time.
 *
 *  3. Behaviour parity with the vanilla renderer: rows, bands, badges,
 *     pickers, the caret, inline renaming, drag and keyboard reordering. These
 *     are the renderBoard tests from hub-render.test.ts, re-aimed at the
 *     island and otherwise unchanged.
 *
 * All fixtures are synthetic — invented names, jordan@partner.example register.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardData } from '../src/hub/board-island.tsx';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  boardSections,
} from '../src/hub/hub-model.ts';
import { renderTaskDetail } from '../src/hub/hub-render.ts';
import { type ShimHandlers, disposeBoards, renderBoard } from './support/board.ts';

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
 *  on the title safe (see `finePointer`). Coarse-pointer cases opt in. */
function handlers(over: Partial<ShimHandlers> = {}): ShimHandlers {
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

/**
 * Run `body` with one of the browser's point-to-caret APIs installed, then
 * take it away again. `Object.defineProperty` rather than an assignment
 * because both names are declared as required members of `Document` and
 * happy-dom implements neither — TypeScript will not let a stub be assigned
 * to one and will not let `undefined` put it back.
 *
 * Removing it afterwards is load-bearing: the case that asserts the FALLBACK
 * (caret at the end) would pass for the wrong reason with a stub still
 * standing, and would keep passing if the fallback itself broke.
 */
function withCaretApi(
  name: 'caretPositionFromPoint' | 'caretRangeFromPoint',
  impl: () => unknown,
  body: () => void,
): void {
  const bag = document as unknown as Record<string, unknown>;
  const had = name in bag;
  const prev = bag[name];
  Object.defineProperty(document, name, { value: impl, configurable: true, writable: true });
  try {
    body();
  } finally {
    if (had)
      Object.defineProperty(document, name, { value: prev, configurable: true, writable: true });
    else delete bag[name];
  }
}

/** Component re-renders from a signal write are scheduled — settle them. */
const tick = () => new Promise((r) => setTimeout(r, 0));

let root: HTMLElement;
beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
  // A fold is a reading preference kept in localStorage, and it outlives a
  // test unless it is cleared — one collapsed band would silently hide the
  // rows every later case is asserting on.
  try {
    localStorage.clear();
  } catch {
    /* private mode; nothing to clear */
  }
});
afterEach(disposeBoards);

/** A repaint of the board with new state, the island left mounted — what a
 *  peer's edit, an SSE event or an attachment refresh causes. */
async function repaint(patch: Partial<typeof boardData.value>): Promise<void> {
  boardData.value = { ...boardData.value, ...patch };
  await tick();
}

// ── The island contract, and the defects it exists to fix ──────────────────
//
// Every assertion in this section was run against the vanilla `renderBoard`
// recovered from origin/main before it was deleted, and every one of them
// FAILED there: the row came back as a different object, focus fell to
// <body>, the open rename came back as plain text, and the "New goal" box
// came back closed and empty. That is the positive control for the section;
// the remount case below is the durable one, kept in the file so a future
// reader can still see the assertion discriminate without the deleted code.

const boardOf = (tasks: HubTask[], goals: HubGoal[] = GOALS) =>
  boardSections(goals, tasks, filters);
const rows = () => [...root.querySelectorAll<HTMLElement>('.hub-task-row')];
const rowFor = (id: string) => root.querySelector<HTMLElement>(`[data-task-id="${id}"]`);

describe('the board island contract', () => {
  it('keeps an unchanged row as the IDENTICAL node object when another row changes', async () => {
    const alpha = task({ id: 'k-a', title: 'Alpha', goal: 'g-pr', order: 1 });
    const beta = task({ id: 'k-b', title: 'Beta', goal: 'g-pr', order: 2 });
    renderBoard(root, boardOf([alpha, beta]), handlers());
    const alphaRow = rowFor('k-a');
    expect(alphaRow).not.toBeNull();

    // A peer moves Beta to in-progress — the commonest update this board sees.
    await repaint({ sections: boardOf([alpha, { ...beta, status: 'in-progress' }]) });

    expect(rowFor('k-b')?.classList.contains('hub-status-in-progress')).toBe(true);
    // The property the migration exists for: the same object, not a recreated
    // equal. Under the renderer this replaces, this line failed.
    expect(rowFor('k-a')).toBe(alphaRow);
  });

  it('positive control: a rebuild DOES change the node, so the assertion above can fail', () => {
    // Without this the `toBe` above could be passing because nothing on the
    // board ever moves. A remount is exactly what the vanilla renderer did on
    // every paint — tear the rows down, build them again — and the same
    // comparison sees it.
    const alpha = task({ id: 'k-a', title: 'Alpha', goal: 'g-pr', order: 1 });
    renderBoard(root, boardOf([alpha]), handlers());
    const before = rowFor('k-a');
    expect(before).not.toBeNull();
    renderBoard(root, boardOf([alpha]), handlers());
    const after = rowFor('k-a');
    expect(after).not.toBeNull();
    expect(after).not.toBe(before);
  });

  it('keeps the band’s node when only a row inside it changes', async () => {
    const alpha = task({ id: 'k-a', goal: 'g-pr', order: 1 });
    renderBoard(root, boardOf([alpha]), handlers());
    const band = root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band');
    await repaint({ sections: boardOf([{ ...alpha, title: 'Renamed by a peer' }]) });
    expect(root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band')).toBe(band);
  });

  it('a row that really leaves the board is gone — the key is not glue', async () => {
    // The control for keying itself: rows survive because their key is still
    // in the list, not because the island never removes anything.
    const alpha = task({ id: 'k-a', goal: 'g-pr', order: 1 });
    const beta = task({ id: 'k-b', goal: 'g-pr', order: 2 });
    renderBoard(root, boardOf([alpha, beta]), handlers());
    expect(rows()).toHaveLength(2);
    await repaint({ sections: boardOf([alpha]) });
    expect(rows()).toHaveLength(1);
    expect(rowFor('k-b')).toBeNull();
  });

  it('a focused row keeps focus across a repaint', async () => {
    const alpha = task({ id: 'k-a', goal: 'g-pr', order: 1 });
    const beta = task({ id: 'k-b', goal: 'g-pr', order: 2 });
    renderBoard(root, boardOf([alpha, beta]), handlers());
    const alphaRow = rowFor('k-a') as HTMLElement;
    alphaRow.focus();
    expect(document.activeElement).toBe(alphaRow);

    await repaint({ sections: boardOf([alpha, { ...beta, title: 'Beta, renamed' }]) });
    expect(document.activeElement).toBe(alphaRow);
  });

  it('keyboard reordering keeps working past the first press', async () => {
    // The failure the deleted focus workaround in hub-app existed for: the
    // move repaints the board, and if the focused row does not survive it the
    // SECOND Alt+Arrow has nothing to act on — the shortcut worked exactly
    // once and then silently stopped.
    const moves: string[] = [];
    const three = () => [
      task({ id: 'k-a', title: 'A', goal: 'g-pr', order: 1 }),
      task({ id: 'k-b', title: 'B', goal: 'g-pr', order: 2 }),
      task({ id: 'k-c', title: 'C', goal: 'g-pr', order: 3 }),
    ];
    const h = handlers({
      onReorder: (t) => {
        moves.push(t.id);
      },
    });
    renderBoard(root, boardOf(three()), h);
    const row = rowFor('k-a') as HTMLElement;
    row.focus();

    const altDown = () =>
      (document.activeElement as HTMLElement)?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
      );
    altDown();
    // …and the app repaints from the move, as it does for real.
    const moved = three();
    await repaint({ sections: boardOf([moved[1], moved[0], moved[2]]) });
    altDown();

    expect(moves).toEqual(['k-a', 'k-a']);
    expect(document.activeElement).toBe(row);
  });

  it('a rename in flight survives a repaint, text and caret state intact', async () => {
    // A board repaint used to be an editor close: the words were rebuilt as a
    // plain span and whatever had been typed went with them.
    const alpha = task({ id: 'k-a', title: 'Old title', goal: 'g-pr', order: 1 });
    const beta = task({ id: 'k-b', title: 'Beta', goal: 'g-pr', order: 2 });
    renderBoard(root, boardOf([alpha, beta]), handlers());
    const words = rowFor('k-a')?.querySelector('.hub-task-title-text') as HTMLElement;
    words.click();
    expect(words.hasAttribute('contenteditable')).toBe(true);
    words.textContent = 'Half typed';

    await repaint({ sections: boardOf([alpha, { ...beta, status: 'done' }]) });

    const after = rowFor('k-a')?.querySelector('.hub-task-title-text') as HTMLElement;
    expect(after).toBe(words);
    expect(after.hasAttribute('contenteditable')).toBe(true);
    // The repaint carries the task's own title, and it must NOT be written
    // over the draft — that write is what the `isEditing` gate exists for.
    expect(after.textContent).toBe('Half typed');
  });

  it('a repaint after the rename ends does put the new title back on the words', async () => {
    // Positive control for the gate above: outside an edit the words are the
    // island's to write, so a peer's rename still lands.
    const alpha = task({ id: 'k-a', title: 'Old title', goal: 'g-pr', order: 1 });
    renderBoard(root, boardOf([alpha]), handlers());
    const words = rowFor('k-a')?.querySelector('.hub-task-title-text') as HTMLElement;
    await repaint({ sections: boardOf([{ ...alpha, title: 'A peer renamed it' }]) });
    expect(words.textContent).toBe('A peer renamed it');
  });

  it('“+ New goal” takes ONE tap and keeps what was typed across a repaint', async () => {
    // The two-tap report, in the form it takes on the board. The box's open
    // state was a pair of `hidden` classes on nodes the next repaint
    // destroyed, so any background event — a peer's transition, an SSE
    // thread, the attachment poll — closed it again and threw away the title.
    // The reader saw a button that had to be pressed twice.
    const alpha = task({ id: 'k-a', goal: 'g-pr', order: 1 });
    renderBoard(root, boardOf([alpha]), handlers());
    const openBox = root.querySelector('.hub-goal-add-btn') as HTMLElement;
    openBox.click();
    await tick();
    const box = root.querySelector('.hub-goal-add-input') as HTMLInputElement;
    expect(box.classList.contains('hidden')).toBe(false);
    box.value = 'Half a goal';

    await repaint({ sections: boardOf([{ ...alpha, status: 'in-progress' }]) });

    const after = root.querySelector('.hub-goal-add-input') as HTMLInputElement;
    expect(after).toBe(box);
    expect(after.classList.contains('hidden')).toBe(false);
    expect(after.value).toBe('Half a goal');
    // …and the button behind it is still out of the way, so the reader is not
    // looking at both halves at once.
    expect(
      (root.querySelector('.hub-goal-add-btn') as HTMLElement).classList.contains('hidden'),
    ).toBe(true);
  });

  it('a fold the reader set survives a repaint without a round trip through storage', async () => {
    const alpha = task({ id: 'k-a', goal: 'g-pr', order: 1 });
    renderBoard(root, boardOf([alpha]), handlers());
    const band = root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band') as HTMLElement;
    (band.querySelector('.hub-twisty') as HTMLElement).click();
    await tick();
    expect(band.classList.contains('is-collapsed')).toBe(true);
    await repaint({ sections: boardOf([{ ...alpha, status: 'done' }]) });
    expect(band.classList.contains('is-collapsed')).toBe(true);
  });

  it('draws no rows while the restore list has the board’s place', async () => {
    // The restore list is a view OF the board and takes its place. Leaving the
    // rows behind it would not merely be waste: `hub-shortcuts` resolves
    // j/k/o/s/e against every `.hub-task-row` on the page, so a hidden row set
    // lets those keys act on rows the reader is not looking at.
    renderBoard(root, boardOf([task({ id: 'k-a', goal: 'g-pr', order: 1 })]), handlers());
    expect(rows()).toHaveLength(1); // control
    await repaint({ showArchived: true });
    expect(rows()).toHaveLength(0);
    expect(root.querySelectorAll('.hub-section')).toHaveLength(0);
    // …and back, because the swap is not one-way.
    await repaint({ showArchived: false });
    expect(rows()).toHaveLength(1);
  });

  it('owns a dedicated wrapper and leaves the host’s vanilla children alone', () => {
    const host = document.createElement('div');
    const vanillaChild = document.createElement('p');
    vanillaChild.textContent = 'vanilla-owned';
    host.appendChild(vanillaChild);
    document.body.appendChild(host);

    renderBoard(host, boardOf([task({ id: 'k-a', goal: 'g-pr', order: 1 })]), handlers());
    const wrapper = host.querySelector('[data-preact-island="board"]');
    expect(wrapper).not.toBeNull();
    expect(wrapper?.querySelector('.hub-task-row')).not.toBeNull();
    expect(host.firstChild).toBe(vanillaChild);

    disposeBoards();
    // render(null, el) ran before el.remove(): teardown, not bare removal.
    expect(wrapper?.childNodes.length).toBe(0);
    expect(host.querySelector('[data-preact-island="board"]')).toBeNull();
    expect(host.firstChild).toBe(vanillaChild);
    expect(host.childNodes.length).toBe(1);
  });

  it('the wrapper is out of layout, so sections stay direct children of the board', () => {
    // happy-dom does no layout, so this is pinned at the rule level. Without
    // `display: contents` the wrapper becomes a block between `.hub-board` and
    // its sections, which breaks the column's own spacing and — worse —
    // changes what `.closest('.hub-section')` walks past during a drag.
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const rule = css.match(/\.hub-board\s*>\s*\[data-preact-island\]\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toContain('display'); // positive control: found the rule
    expect(rule).toMatch(/display:\s*contents/);
  });
});

describe('renderBoard', () => {
  it('renders goal sections in order with Backlog last, done rows styled done in place', () => {
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
    expect([...select.options].map((o) => o.value).sort()).toEqual([
      'done',
      'in-progress',
      'todo',
      'triage',
    ]);
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
    const discussed = task({ goal: 'g-pr', commentCount: 3, dueAt: NOW + 86_400_000 });
    renderBoard(root, boardSections(GOALS, [discussed], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${discussed.id}"]`);
    expect(row).not.toBeNull();
    // Control: the strip is alive and this row's other badge is in it. (It
    // used to be the `decision` badge, then `after`; both are gone — see
    // below. `due` is what is left that a row can still carry.)
    expect(row?.querySelector('.hub-badge-due')).not.toBeNull();
    expect(row?.querySelector('.hub-badge-comments')).toBeNull();
    // …and no badge anywhere on the row spells the count either, which is what
    // a differently-classed replacement glyph would do.
    expect(row?.querySelector('.hub-task-badges')?.textContent ?? '').not.toContain('3');
  });

  // The one badge ADDED back to the row, against a strip that has lost three.
  // The others labelled the board's shape and so applied to nearly every row;
  // this one marks the handful somebody deliberately deferred, on a list whose
  // job is to answer what to work on next. Without it a parked row is
  // indistinguishable from work nobody got to, which is the confusion the
  // field exists to end.
  it('marks a parked row with its date, and says nothing on a park that has expired', () => {
    const h = handlers();
    // Real wall-clock offsets: the row badge asks `Date.now()`, the same way
    // the overdue tint next door does. `NOW` here is a fixed past constant, so
    // building the fixture from it would test the expired branch twice.
    const soon = Date.now() + 86_400_000;
    const parked = task({
      goal: 'g-pr',
      parkedUntil: soon,
      parkedReason: 'waiting on the index rebuild',
    });
    // No sweeper clears the field, so an expired park is a row that still
    // CARRIES `parkedUntil` and must draw as ordinary work.
    const expired = task({ goal: 'g-pr', parkedUntil: Date.now() - 1, dueAt: NOW + 86_400_000 });
    renderBoard(root, boardSections(GOALS, [parked, expired], filters), h);

    const row = root.querySelector(`.hub-task-row[data-task-id="${parked.id}"]`);
    const chip = row?.querySelector('.hub-badge-parked') as HTMLElement | null;
    expect(chip).not.toBeNull();
    expect(chip?.textContent ?? '').toContain('parked');
    expect(chip?.textContent ?? '').toContain(
      new Date(soon).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
    );
    // The reason is prose of any length and the row is one line, so it rides
    // the title. It still has to be REACHABLE from the row.
    expect(chip?.title).toBe('waiting on the index rebuild');

    const stale = root.querySelector(`.hub-task-row[data-task-id="${expired.id}"]`);
    expect(stale?.querySelector('.hub-badge-due')).not.toBeNull(); // control: badges render
    expect(stale?.querySelector('.hub-badge-parked')).toBeNull();
  });

  // Bryan, 2026-08-19, on being shown what it meant: *"That's not helpful.
  // Just don't show it any more."* The count was ambiguous by construction —
  // it counted all of `after`, while only the `afterEnforce` subset actually
  // hard-blocks — and what it was blocked ON was hover-only, so a touch screen
  // could never reach it. Pinned as an absence with a positive control, and
  // with the dependency itself asserted intact: this removes a row-level tell,
  // not the feature.
  it('puts no dependency count on a row, and still carries the dependency', () => {
    const h = handlers();
    const blocked = task({ goal: 'g-pr', after: ['t-a', 't-b'], dueAt: NOW + 86_400_000 });
    renderBoard(root, boardSections(GOALS, [blocked], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${blocked.id}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector('.hub-badge-due')).not.toBeNull(); // control: strip renders
    expect(row?.querySelector('.hub-badge-after')).toBeNull();
    // No differently-classed replacement spells the count or the blockers
    // either — that is what a quieter substitute would do.
    const badgeText = row?.querySelector('.hub-task-badges')?.textContent ?? '';
    expect(badgeText).not.toContain('after');
    expect(badgeText).not.toContain('2');
    expect(row?.textContent ?? '').not.toContain('t-a');
  });

  // Same request, same day, same reasoning ("not useful and a waste of
  // space"): `needs` labels the board's shape rather than the row, so on a
  // triaged board every row carried one. Pinned as an absence with a positive
  // control beside it — a row that WOULD have carried the badge still renders
  // its other badges, so this is not "the strip stopped rendering".
  it('puts no decision/action identifier on a row', () => {
    const h = handlers();
    const decide = task({ goal: 'g-pr', needs: 'decision', dueAt: NOW + 86_400_000 });
    const act = task({ goal: 'g-pr', needs: 'action' });
    renderBoard(root, boardSections(GOALS, [decide, act], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${decide.id}"]`);
    expect(row?.querySelector('.hub-badge-due')).not.toBeNull();
    expect(root.querySelector('.hub-badge-decision')).toBeNull();
    expect(root.querySelector('.hub-badge-action')).toBeNull();
    // And no differently-classed replacement spells the words either.
    const badgeText = [...root.querySelectorAll('.hub-task-badges')]
      .map((b) => b.textContent ?? '')
      .join(' ');
    expect(badgeText).not.toContain('decision');
    expect(badgeText).not.toContain('action');
  });

  // Design point 5's board half. The mock added an amber `blocked` row badge
  // and flagged it as its one invention; the directive keeps the board's
  // badge discipline, so the blocked state lives in the task PANEL's note and
  // the row gains nothing.
  it('adds no blocked badge to a human-owned task other work waits on', () => {
    const h = handlers();
    const gate = task({ goal: 'g-pr', assignee: 'human', dueAt: NOW + 86_400_000 });
    const waiting = task({ goal: 'g-pr', after: [gate.id] });
    renderBoard(root, boardSections(GOALS, [gate, waiting], filters), h);
    const row = root.querySelector(`.hub-task-row[data-task-id="${gate.id}"]`);
    expect(row).not.toBeNull();
    expect(row?.querySelector('.hub-badge-due')).not.toBeNull(); // control: badges render
    expect(row?.querySelector('.hub-badge-blocked')).toBeNull();
    expect(row?.querySelector('.hub-task-badges')?.textContent ?? '').not.toMatch(/blocked/i);
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
    // Trimmed, and placed after the last REAL band — never after Backlog,
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
    renderBoard(root, boardSections(GOALS, [], filters), noAdd as ShimHandlers);
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
    // the row anatomy itself: handle, status, title, badges, open caret,
    // assignee. The caret's place in this list is a REQUIREMENT, not an
    // implementation detail (Bryan, 2026-08-21: *"the hover caret sits right
    // BEFORE the profile bubble"*), which is why it is asserted rather than
    // left to the stylesheet — and the count must stay equal to the number of
    // grid tracks, since auto-placement fills them consecutively and a
    // mismatch would slide the title into a fixed track.
    expect([...row.children].map((c) => (c as HTMLElement).className.split(' ')[0])).toEqual([
      'hub-drag-handle',
      'hub-status-ctl',
      'hub-task-title',
      'hub-task-badges',
      'hub-task-open',
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
      // Scoped to the task row: the goal band above it draws its own owner
      // slot with the same avatar class.
      const avatar = root.querySelector('.hub-task-row .hub-owner-avatar') as HTMLElement;
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
    const avatar = root.querySelector('.hub-task-row .hub-owner-avatar') as HTMLElement;
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

  // Decision 4's desktop half, spelled the way the TASK rows spell it: the
  // words themselves become editable in place (`wireWordsInPlace`), never an
  // input swap. Backlog is a bucket, not a goal, and has no name to change.
  it('goal titles are editable in place too; Backlog is not', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [], filters), h);
    const goalTitle = root.querySelector(
      '.hub-section[data-goal-id="g-pr"] .hub-goal-title-text',
    ) as HTMLElement;
    goalTitle.click();
    expect(goalTitle.hasAttribute('contenteditable')).toBe(true);
    goalTitle.textContent = '1. Ship the PR';
    goalTitle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onGoalTitleCommit).toHaveBeenCalledWith('g-pr', '1. Ship the PR');
    const choresTitle = root.querySelector(
      `.hub-section[data-goal-id="${CHORES_ID}"] .hub-goal-title-text`,
    ) as HTMLElement;
    choresTitle.click();
    expect(choresTitle.hasAttribute('contenteditable')).toBe(false);
  });
});

// ── The goal band (Bryan's live mockup review, 2026-08-23) ──────────────────
// The band header IS the goal's row. What Bryan struck from the mock is
// pinned as absences below — counts, drag handle, status circle, chips —
// each beside a positive control on the task row underneath, which keeps all
// of that chrome.
describe('the goal band row', () => {
  const DAY = 86_400_000;
  const goalsWith = (over: Partial<HubGoal> = {}): HubGoal[] => [
    { id: 'g-pr', title: '1. Get the PR out', ...over },
  ];
  const goalRow = () =>
    root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-goal-row') as HTMLElement;

  it('renders the header as a row — title, plain due text, owner slot, and none of the struck chrome', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(goalsWith({ dueAt: Date.now() + DAY }), [task({ goal: 'g-pr' })], filters),
      h,
    );
    const row = goalRow();
    expect(row).not.toBeNull();
    expect(row.querySelector('.hub-goal-title-text')?.textContent).toBe('1. Get the PR out');
    // Decision 6: the due date is plain muted text right of the title — not a
    // chip — and only an OVERDUE open band goes red, which this one is not.
    const due = row.querySelector('.hub-due') as HTMLElement;
    expect(due).not.toBeNull();
    expect(due.textContent).toContain('due');
    expect(due.className).not.toContain('hub-badge');
    expect(due.className).not.toContain('hub-due-overdue');
    // Decisions 1, 2, 6: no counts, no drag handle, no status circle, no chips.
    expect(row.querySelector('.hub-drag-handle')).toBeNull();
    expect(row.querySelector('.hub-status-ctl')).toBeNull();
    expect(row.querySelector('.hub-status-mark')).toBeNull();
    expect(row.querySelector('.hub-badge')).toBeNull();
    expect(row.querySelector('.hub-goal-counts')).toBeNull();
    expect(row.textContent ?? '').not.toMatch(/\d+ (open|doing|done)/);
    // Positive control: the task row inside the same band still carries its
    // chrome, so the absences above are the goal row's own.
    const trow = root.querySelector('.hub-task-row') as HTMLElement;
    expect(trow.querySelector('.hub-drag-handle')).not.toBeNull();
    expect(trow.querySelector('.hub-status-ctl')).not.toBeNull();
    // Decision 8's slot: the owner cell is always there (it is what keeps the
    // avatar column aligned with the task rows'), drawn as a vacancy while
    // nothing owns the goal.
    expect(row.querySelector('.hub-owner-ctl .hub-owner-avatar')?.className).toContain(
      'hub-owner-none',
    );
  });

  // Same contract as the task row's track test: the stylesheet's declaration
  // is read rather than restated, and the child count must match it.
  it('emits one child per declared grid track, with the title on the flexible one', () => {
    renderBoard(
      root,
      boardSections(goalsWith({ dueAt: Date.now() + DAY }), [], filters),
      handlers(),
    );
    const shape = [...goalRow().children].map((c) => (c as HTMLElement).className.split(' ')[0]);
    expect(shape).toEqual([
      'hub-twisty',
      'hub-goal-title',
      'hub-goal-meta',
      'hub-goal-open',
      'hub-owner-ctl',
    ]);
    const css = readFileSync(resolve('packages/markdown-app/src/styles.css'), 'utf8');
    const decl = /\.hub-goal-row\s*\{[^}]*grid-template-columns:\s*([^;]+);/.exec(css)?.[1];
    expect(decl).toBeDefined();
    const tracks = (decl as string).trim().split(/\s+(?![^(]*\))/);
    expect(shape).toHaveLength(tracks.length);
    expect(tracks[shape.indexOf('hub-goal-title')]).toContain('1fr');
    expect(tracks.filter((t) => t.includes('fr'))).toHaveLength(1);
  });

  it('reads overdue in red on an open band; a done one draws no due date at all', () => {
    renderBoard(
      root,
      boardSections(goalsWith({ dueAt: Date.now() - DAY }), [], filters),
      handlers(),
    );
    expect(goalRow().querySelector('.hub-due')?.className).toContain('hub-due-overdue');
    root.replaceChildren();
    renderBoard(
      root,
      boardSections(goalsWith({ dueAt: Date.now() - DAY, status: 'done' }), [], filters),
      handlers(),
    );
    // Not merely un-reddened: a date the goal finished past is noise, and the
    // slot is spent on the word `done` instead (below).
    expect(goalRow().querySelector('.hub-due')).toBeNull();
  });

  // A done goal has to READ as done with no hover. The muted title is a
  // difference nobody can name, and the attribution tooltip beside it never
  // appears on the iPad this board is read from — so the word itself is
  // drawn, in the due date's slot and the due date's plain-text treatment.
  // Everything the mock review struck stays struck: no count, no status
  // circle, no chip or badge.
  it('says “done” in plain text where a done goal’s due date would go', () => {
    renderBoard(
      root,
      boardSections(
        goalsWith({ status: 'done', doneAt: NOW, dueAt: Date.now() - DAY }),
        [],
        filters,
      ),
      handlers(),
    );
    const meta = goalRow().querySelector('.hub-goal-meta') as HTMLElement;
    const note = meta.querySelector('.hub-done-note') as HTMLElement;
    expect(note).not.toBeNull();
    expect(note.textContent).toBe('done');
    expect(note.className).not.toContain('hub-badge');
    expect(meta.querySelector('.hub-due')).toBeNull();
    expect(goalRow().querySelector('.hub-status-mark')).toBeNull();
    expect(goalRow().querySelector('.hub-badge')).toBeNull();
    // Positive control: an open band with that same past due date still draws
    // the date, and claims nothing about being done.
    root.replaceChildren();
    renderBoard(
      root,
      boardSections(goalsWith({ dueAt: Date.now() - DAY }), [], filters),
      handlers(),
    );
    expect(goalRow().querySelector('.hub-due')?.textContent).toContain('due');
    expect(goalRow().querySelector('.hub-done-note')).toBeNull();
  });

  // The avatar draws from the projected owner the way a task row's does —
  // same class family, same initials scheme — so the two columns read as one.
  it('draws a projected owner as the same initials avatar a task row gets', () => {
    renderBoard(
      root,
      boardSections(goalsWith({ assignee: 'team-lead-fleet', ownerKind: 'agent' }), [], filters),
      handlers(),
    );
    const avatar = goalRow().querySelector('.hub-owner-avatar') as HTMLElement;
    expect(avatar.textContent).toBe('TL');
    expect(avatar.className).toContain('hub-owner-agent');
    expect(avatar.title).toContain('team-lead-fleet');
  });

  it('desktop: the words rename in place; anywhere else on the row opens the goal', () => {
    const onOpenGoal = vi.fn();
    const h = handlers({ onOpenGoal });
    renderBoard(root, boardSections(goalsWith(), [], filters), h);
    const words = goalRow().querySelector('.hub-goal-title-text') as HTMLElement;
    words.click();
    expect(words.hasAttribute('contenteditable')).toBe(true);
    expect(onOpenGoal).not.toHaveBeenCalled();
    words.textContent = '1. Ship the PR';
    words.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.onGoalTitleCommit).toHaveBeenCalledWith('g-pr', '1. Ship the PR');
    goalRow().click();
    expect(onOpenGoal).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-pr' }));
  });

  // Decision 4's mobile half: a tap — the title's words included — opens the
  // goal, and never starts an edit. Renaming lives in the detail panel there.
  it('mobile: a tap anywhere opens the goal and never edits the title', () => {
    const onOpenGoal = vi.fn();
    const h = handlers({ inlineTitleEdit: () => false, onOpenGoal });
    renderBoard(root, boardSections(goalsWith(), [], filters), h);
    const words = goalRow().querySelector('.hub-goal-title-text') as HTMLElement;
    words.click();
    expect(words.hasAttribute('contenteditable')).toBe(false);
    expect(onOpenGoal).toHaveBeenCalledWith(expect.objectContaining({ id: 'g-pr' }));
    expect(h.onGoalTitleCommit).not.toHaveBeenCalled();
  });

  // Decision 3: a collapsed band shows nothing extra — the goal row alone, no
  // "N hidden" line, no summary. The fold is the viewer's own (localStorage,
  // never the shared ydoc), so it survives the re-renders the live board
  // makes constantly.
  it('collapses to the goal row alone, per viewer, surviving a re-render', async () => {
    try {
      localStorage.removeItem('hub:collapsed-bands');
    } catch {
      /* private mode */
    }
    const h = handlers();
    const sections = boardSections(goalsWith(), [task({ goal: 'g-pr' })], filters);
    renderBoard(root, sections, h);
    const band = root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band') as HTMLElement;
    const twisty = band.querySelector('.hub-twisty') as HTMLButtonElement;
    expect(twisty.getAttribute('aria-expanded')).toBe('true');
    twisty.click();
    // The fold is component state now, so it lands on the next scheduled
    // render rather than as a synchronous class write — a microtask, well
    // inside the same frame.
    await tick();
    expect(band.classList.contains('is-collapsed')).toBe(true);
    expect(twisty.getAttribute('aria-expanded')).toBe('false');
    // Nothing extra rendered for the folded state — the CSS hides the tasks,
    // and no summary element takes their place.
    expect(band.querySelector('.hub-band-hidden')).toBeNull();
    expect(band.querySelector('.hub-section-more')).toBeNull();
    // Per viewer, across renders: the repaint keeps the fold.
    root.replaceChildren();
    renderBoard(root, sections, h);
    const again = root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band') as HTMLElement;
    expect(again.classList.contains('is-collapsed')).toBe(true);
    // Reopen and leave no state behind for the other tests.
    (again.querySelector('.hub-twisty') as HTMLButtonElement).click();
    await tick();
    expect(again.classList.contains('is-collapsed')).toBe(false);
    try {
      localStorage.removeItem('hub:collapsed-bands');
    } catch {
      /* private mode */
    }
  });

  // The tooltip has to name the gesture the NEXT click will do. It was set
  // once at build time and never followed the state, so a collapsed band's
  // twisty offered to collapse it again — the aria-label flipped underneath
  // and the visible text disagreed with it.
  it('the twisty’s tooltip flips with the fold, matching its aria-label', async () => {
    try {
      localStorage.removeItem('hub:collapsed-bands');
    } catch {
      /* private mode */
    }
    renderBoard(root, boardSections(goalsWith(), [], filters), handlers());
    const twisty = goalRow().querySelector('.hub-twisty') as HTMLButtonElement;
    expect(twisty.title).toMatch(/^Collapse/);
    expect(twisty.getAttribute('aria-label')).toMatch(/^Collapse/);
    twisty.click();
    await tick();
    expect(twisty.title).toMatch(/^Expand/);
    expect(twisty.getAttribute('aria-label')).toMatch(/^Expand/);
    // A repaint reads the persisted fold, so a fresh twisty must come up
    // saying the same thing rather than the build-time default.
    root.replaceChildren();
    renderBoard(root, boardSections(goalsWith(), [], filters), handlers());
    const again = goalRow().querySelector('.hub-twisty') as HTMLButtonElement;
    expect(again.title).toMatch(/^Expand/);
    // Unfold, so the persisted state nets to zero for the other tests.
    again.click();
    await tick();
    expect(again.title).toMatch(/^Collapse/);
  });

  it('the twisty folds without opening the goal', () => {
    const onOpenGoal = vi.fn();
    renderBoard(root, boardSections(goalsWith(), [], filters), handlers({ onOpenGoal }));
    (goalRow().querySelector('.hub-twisty') as HTMLButtonElement).click();
    expect(onOpenGoal).not.toHaveBeenCalled();
    // Fold it back so the persisted state nets to zero for the other tests.
    (goalRow().querySelector('.hub-twisty') as HTMLButtonElement).click();
  });

  it('Backlog is a bucket, not a goal: reserved styling, no rename, no open, an empty owner slot', () => {
    const onOpenGoal = vi.fn();
    const h = handlers({ onOpenGoal });
    renderBoard(root, boardSections(goalsWith(), [], filters), h);
    const band = root.querySelector(
      `.hub-section[data-goal-id="${CHORES_ID}"] .hub-band`,
    ) as HTMLElement;
    expect(band.className).toContain('hub-band-reserved');
    const row = band.querySelector('.hub-goal-row') as HTMLElement;
    const words = row.querySelector('.hub-goal-title-text') as HTMLElement;
    words.click();
    expect(words.hasAttribute('contenteditable')).toBe(false);
    row.click();
    expect(onOpenGoal).not.toHaveBeenCalled();
    // No vacancy mark either — Backlog cannot be owned, so drawing a hole
    // would invite filling it. The slot itself stays for column alignment.
    expect(row.querySelector('.hub-owner-ctl')).not.toBeNull();
    expect(row.querySelector('.hub-owner-avatar')).toBeNull();
    expect(row.querySelector('.hub-due')).toBeNull();
  });

  // A done band's treatment is a muted title by CLASS (the mock draws no
  // chrome of its own for done goals — the status lives in the detail panel),
  // plus the attribution commit A shipped, surfaced as the row's tooltip.
  it('marks a done band by class and names who declared it; an undecorated band claims nothing', () => {
    renderBoard(
      root,
      boardSections(
        goalsWith({ status: 'done', doneAt: NOW, doneBy: { name: 'Jordan', kind: 'person' } }),
        [],
        filters,
      ),
      handlers(),
    );
    const band = root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band') as HTMLElement;
    expect(band.className).toContain('hub-band-done');
    expect(goalRow().title).toContain('Jordan');
    root.replaceChildren();
    renderBoard(root, boardSections(goalsWith(), [], filters), handlers());
    const bare = root.querySelector('.hub-section[data-goal-id="g-pr"] .hub-band') as HTMLElement;
    expect(bare.className).not.toContain('hub-band-done');
    expect(goalRow().title).toBe('');
  });
});

// ── The Asana row anatomy: handle · status · title · badges · caret · owner ──

describe('the open caret', () => {
  // Bryan, 2026-08-21: *"New pencil is funny — can you instead do what Asana
  // does on desktop? Use a caret only on hover — that always opens the task."*
  // What replaced the pencil is the affordance for the gesture the whole row
  // already had; where it sits is asserted with the row anatomy, above.
  it('replaces the pencil, and opens the task when clicked', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Open me' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    // The pencil is gone from the row entirely — the regression this pins is
    // it coming back beside the caret and giving the row two rename gestures.
    expect(root.querySelector('.hub-title-edit')).toBeNull();
    const caret = root.querySelector('.hub-task-open') as HTMLButtonElement;
    expect(caret).not.toBeNull();
    caret.click();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
    // …and it did not start a rename on the way.
    const words = root.querySelector('.hub-task-title-text') as HTMLElement;
    expect(words.hasAttribute('contenteditable')).toBe(false);
  });

  // Placement is a requirement in its own right (Bryan, 2026-08-21: *"the
  // hover caret sits right BEFORE the profile bubble"*), and the anatomy list
  // above pins it against the whole row. This is the pair on its own, because
  // that list would still pass with the caret and the bubble both moved.
  it('sits immediately before the assignee bubble', () => {
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), handlers());
    const caret = root.querySelector('.hub-task-open') as HTMLElement;
    expect(caret.nextElementSibling?.className).toContain('hub-owner-ctl');
    // …and it is the LAST thing before it, so nothing may be slipped between.
    expect((caret.previousElementSibling as HTMLElement).className).toContain('hub-task-badges');
  });

  // It has no click handler of its own — the ROW's handler is what opens, and
  // the caret's click reaches it by bubbling. Worth its own case because the
  // two failure modes look identical from the test above: a caret that
  // swallows its click opens nothing, and one that stops propagation after
  // opening would break the drag-select guard the row owns.
  it('opens by bubbling into the row rather than handling its own click', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const caret = root.querySelector('.hub-task-open') as HTMLButtonElement;
    const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
    caret.dispatchEvent(ev);
    expect(h.onOpenTask).toHaveBeenCalledTimes(1);
  });

  // Not a tab stop, and invisible to assistive tech: Enter on the focused ROW
  // already opens the task, so a focusable twin would be a stop that says
  // nothing new and a second announcement of the same action. This is the one
  // place the caret is NOT a like-for-like swap for the pencil, which was
  // focusable precisely because it was the keyboard's only path to a rename.
  it('is a pointer affordance only — no tab stop, nothing announced', () => {
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), handlers());
    const caret = root.querySelector('.hub-task-open') as HTMLButtonElement;
    expect(caret.tagName).toBe('BUTTON');
    expect(caret.tabIndex).toBe(-1);
    expect(caret.getAttribute('aria-hidden')).toBe('true');
    // A hover-only affordance has to name itself for the pointer that CAN
    // hover, or it is a glyph with no meaning.
    expect(caret.title).toContain('Open');
  });

  // …and "not a tab stop" is not the same as "never focused". A <button> takes
  // focus when it is CLICKED, and keeps it after the panel it opened is shut —
  // seen at 430px as a blue focus ring standing on an aria-hidden glyph, on a
  // row the reader had already moved past. Cancelling the mousedown default is
  // the fix, so the assertion is that the default is cancelled.
  it('does not take focus when it is clicked', () => {
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), handlers());
    const caret = root.querySelector('.hub-task-open') as HTMLButtonElement;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    caret.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    // Control: the row's own mousedown — the drag-select guard's snapshot — is
    // untouched, so preventing focus did not stop the event getting there.
    const rowDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    (root.querySelector('.hub-task-row') as HTMLElement).dispatchEvent(rowDown);
    expect(rowDown.defaultPrevented).toBe(false);
  });

  // A coarse pointer can reveal nothing on hover, so the caret is simply
  // there — it is the only thing on a phone row that says the row opens. The
  // CSS half (14px indicator, not a 44px target — the ROW is the target) is
  // in the phone block; what TS owns is that the element is live rather than
  // disabled, which is what the pencil was here.
  it('stays live on a coarse pointer instead of going inert', () => {
    const h = handlers({ inlineTitleEdit: () => false });
    const t = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const caret = root.querySelector('.hub-task-open') as HTMLButtonElement;
    expect(caret.disabled).toBe(false);
    caret.click();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });
});

describe('inline title editing', () => {
  /** The inline element the WORDS live in, as against the cell holding it. */
  const words = () => root.querySelector('.hub-task-title-text') as HTMLElement;
  /** A click that carries a position, which a bare `.click()` does not. */
  const clickAt = (el: HTMLElement, x = 0, y = 0) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: x, clientY: y }));
  /**
   * Editing is one attribute on the words themselves. There is no input to
   * look for, and that absence IS the requirement — see the zero-shift case.
   */
  const editing = () => words().hasAttribute('contenteditable');
  const press = (key: string, el: HTMLElement = words()) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  /** Where the caret ended up inside the words, or null if it is not there. */
  const caret = (): number | null => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    if (!range.collapsed) return null; // a selection is not a caret
    if (range.startContainer !== words().firstChild) return null;
    return range.startOffset;
  };

  // Bryan's rule, and the reason the words sit in their own element: *"everything
  // in the task except the actual text also opens task (e.g. whitespace to the
  // right of the text) and clicking on text edits."* The title CELL is the
  // grid's flexible track, so on a wide row most of it is empty space beside a
  // short title — a click there has the cell as its target, never reaches the
  // words, and opens like the rest of the row.
  it('opens from the empty half of the title cell, and renames from the words', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    // Control first: the two really are different elements, or this whole
    // case is one element agreeing with itself.
    expect(words()).not.toBeNull();
    expect(words()).not.toBe(title);
    expect(words().textContent).toBe('Old title');

    clickAt(title);
    expect(editing()).toBe(false);
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));

    clickAt(words());
    expect(editing()).toBe(true);
    // Editing did not ALSO open the task behind the editor.
    expect(h.onOpenTask).toHaveBeenCalledTimes(1);
  });

  // THE requirement that decides how this is built (Bryan, 2026-08-21):
  // *"entering edit mode must NOT shift the text — zero layout jump."* An
  // input can only ever APPROXIMATE that: it is a different box that has to
  // be talked into matching a span's font, padding, border and baseline, and
  // the last attempt missed by the 4px padding and 1px border still on
  // `.hub-title-input`. Editing the words where they are makes zero shift
  // structural — same element, same text node, same box — so this case
  // asserts the structure rather than measuring pixels happy-dom cannot lay
  // out anyway.
  it('edits the words where they are — same element, same text node, no input', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    const before = words();
    const node = before.firstChild;
    clickAt(before);
    expect(editing()).toBe(true);
    expect(words()).toBe(before); // not replaced
    expect(words().firstChild).toBe(node); // not even re-created
    expect(title.querySelector('input')).toBeNull(); // nothing swapped in
    // Nor did edit mode reach for a box of its own by another route.
    expect(before.getAttribute('style')).toBeNull();
    // Enter's newline is intercepted, but keep the browser out of the
    // business of pasting markup into a title where it knows how.
    expect(['plaintext-only', 'true']).toContain(before.getAttribute('contenteditable'));
  });

  // The other half of Asana's tell (Bryan: *"on click the rectangle goes away
  // — you're left with just the text caret"*). The rectangle itself is a CSS
  // hover rule; what TS owns is the flag the cell needs so its ellipsis can
  // stop truncating text that is being typed into.
  it('marks the cell as editing, and unmarks it on the way out', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old' })], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    expect(title.classList.contains('hub-title-editing')).toBe(false);
    clickAt(words());
    expect(title.classList.contains('hub-title-editing')).toBe(true);
    press('Escape');
    expect(title.classList.contains('hub-title-editing')).toBe(false);
  });

  // The half Bryan asked for by name: *"clicking on text edits with the cursor
  // where the mouse clicked"* — not select-all, and not the end of the line.
  it('puts the caret on the character the pointer landed on', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    // happy-dom runs no layout engine, so no point maps to a character on its
    // own; the browser's answer is stubbed and what is under test is what the
    // row DOES with it — which text node offset it reads, and where that ends
    // up in the live selection.
    withCaretApi(
      'caretPositionFromPoint',
      () => ({ offsetNode: words().firstChild, offset: 4 }),
      () => {
        clickAt(words(), 40, 12);
        expect(caret()).toBe(4); // a caret, not a selection — see the helper
        expect(words().textContent).toBe('Old title');
      },
    );
  });

  // …and when the engine will not say — an old WebKit with neither spelling,
  // or a point that maps to no text — the rename still opens, at the end.
  // Silently doing nothing would make the title look dead.
  it('falls back to the end of the line when no position can be read', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    clickAt(words(), 40, 12);
    expect(editing()).toBe(true);
    expect(caret()).toBe('Old title'.length);
  });

  // Safari had `caretRangeFromPoint` for years and nothing else, and Safari is
  // what an iPad reviews on — so the fallback spelling is not decoration.
  it("reads WebKit's caretRangeFromPoint when the standard one is missing", () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    withCaretApi(
      'caretRangeFromPoint',
      () => ({ startContainer: words().firstChild, startOffset: 2 }),
      () => {
        clickAt(words(), 40, 12);
        expect(caret()).toBe(2);
      },
    );
  });

  // Once the rectangle is gone the reader is *"left with just the text caret …
  // and can select or type normally"* — so a second click inside the words is
  // theirs, not a fresh begin() that would yank the caret back to wherever the
  // stub says and re-read the title from the model.
  it('leaves a click inside an open edit to the reader', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    clickAt(words());
    words().textContent = 'Half typed';
    clickAt(words(), 12, 4);
    expect(editing()).toBe(true);
    expect(words().textContent).toBe('Half typed'); // not re-read from the task
    expect(h.onOpenTask).not.toHaveBeenCalled(); // nor did it open the task
  });

  // A click that ends a drag-select fires too — opening the panel then would
  // destroy the selection the reader just made to copy a title.
  it('does not open when the click ends with text selected in the row', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Select me' })], filters),
      h,
    );
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    const sel = (collapsed: boolean) =>
      ({ isCollapsed: collapsed, anchorNode: title.firstChild }) as unknown as Selection;
    const spy = vi.spyOn(document, 'getSelection').mockReturnValue(sel(false));
    row.click();
    expect(h.onOpenTask).not.toHaveBeenCalled();
    // Control: the same click with the selection collapsed opens.
    spy.mockReturnValue(sel(true));
    row.click();
    expect(h.onOpenTask).toHaveBeenCalled();
    spy.mockRestore();
  });

  // …and the guard must let go again. A finished selection stands until the
  // NEXT mousedown, so "is anything selected right now?" is still true on the
  // following click — the row swallowed that one too and read as dead. The
  // question is not whether a selection exists but whether THIS gesture made
  // it, which is a comparison across mousedown and click, not a single read.
  it('opens on the click AFTER a drag-select, not on the one that made it', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Select me' })], filters),
      h,
    );
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    const nothing = { isCollapsed: true, anchorNode: null } as unknown as Selection;
    const selected = {
      isCollapsed: false,
      anchorNode: title.firstChild,
      focusNode: title.firstChild,
      anchorOffset: 0,
      focusOffset: 6,
    } as unknown as Selection;
    const spy = vi.spyOn(document, 'getSelection').mockReturnValue(nothing);

    // Gesture one, the drag that makes the selection: nothing selected when
    // the button goes down, words selected by the time the click lands.
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    spy.mockReturnValue(selected);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.onOpenTask).not.toHaveBeenCalled();

    // Gesture two, a plain click with that selection still standing: both
    // reads see the same words, so this gesture selected nothing and the row
    // opens.
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.onOpenTask).toHaveBeenCalledTimes(1);

    // And a second drag still suppresses — the guard keys on the change, so
    // back-to-back selections are not mistaken for a stale one.
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    spy.mockReturnValue({ ...selected, focusOffset: 4 } as unknown as Selection);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(h.onOpenTask).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  // The guard the row already had, now owed by BOTH gestures. A reader who
  // drag-selects a title to copy it releases the button over the words, and
  // that release is a click: opening the panel would destroy the selection,
  // and so would dropping a caret into the middle of it.
  it('does not start a rename on the click that ended a drag-select', () => {
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Select me' })], filters),
      h,
    );
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    const none = { isCollapsed: true, anchorNode: null } as unknown as Selection;
    const some = {
      isCollapsed: false,
      anchorNode: words().firstChild,
      focusNode: words().firstChild,
      anchorOffset: 0,
      focusOffset: 6,
    } as unknown as Selection;
    const spy = vi.spyOn(document, 'getSelection').mockReturnValue(none);
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    spy.mockReturnValue(some);
    clickAt(words());
    expect(editing()).toBe(false);
    expect(h.onOpenTask).not.toHaveBeenCalled();

    // Control: the next click, with that selection standing rather than made,
    // renames as usual — the guard lets go instead of leaving the title dead.
    row.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    clickAt(words());
    expect(editing()).toBe(true);
    spy.mockRestore();
  });

  // Restored deliberately — and it re-opens the bug that removed it, so the
  // gate is the pointer, not the title.
  it('renames in place; Enter commits', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    clickAt(words());
    expect(editing()).toBe(true);
    // The click that entered edit mode must not also have opened the task.
    expect(h.onOpenTask).not.toHaveBeenCalled();
    words().textContent = 'New title';
    press('Enter');
    expect(h.onTitleCommit).toHaveBeenCalledWith(
      expect.objectContaining({ id: t.id }),
      'New title',
    );
  });

  it('Enter LEAVES edit mode, not just commits', () => {
    // *"title should save and switch back to not editable state"*. It
    // committed and left the editor open, relying on the caller's re-render —
    // and in the detail panel that re-render REOPENS the editor for any title
    // draft it finds, so Enter saved and put the reader straight back into
    // editing, every time.
    const h = handlers();
    renderBoard(
      root,
      boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old title' })], filters),
      h,
    );
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    clickAt(words());
    words().textContent = 'New title';
    press('Enter');
    expect(h.onTitleCommit).toHaveBeenCalled();
    expect(editing()).toBe(false);
    // Showing the committed words, not the old ones — the caller re-renders,
    // but the element must not flash the pre-edit title in between.
    expect(title.textContent).toBe('New title');
    // And the words are still in their OWN element, so the empty half of the
    // cell still opens the task rather than starting a rename.
    expect(words()).not.toBeNull();
    clickAt(title);
    expect(h.onOpenTask).toHaveBeenCalled();
  });

  it('Escape cancels without writing', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', title: 'Keep me' })], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    clickAt(words());
    words().textContent = 'Discard me';
    press('Escape');
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(editing()).toBe(false);
    expect(title.textContent).toBe('Keep me');
  });

  // Blur is the third ending and the easiest one to reach by accident — a
  // click anywhere else on the board. It must cancel, never save: an editor
  // that commits on blur rewrites a title the reader was in the middle of
  // rethinking. (An input got this for free by being removed; an element that
  // stays in the DOM has to say so.)
  it('blur cancels without writing', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', title: 'Keep me' })], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    clickAt(words());
    words().textContent = 'Discard me';
    words().dispatchEvent(new FocusEvent('blur'));
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(editing()).toBe(false);
    expect(title.textContent).toBe('Keep me');
  });

  // Keyboard parity: a rename reachable only by clicking is a rename a
  // keyboard user cannot perform. The pencil was that path and it is gone, so
  // `r` is — the letter joins the row's existing set (j/k, o, s, a) and works
  // on the Magic Keyboard Bryan reviews from, which has no function row for F2
  // to live on. Enter keeps meaning "open", so the two never race for a press,
  // and the title must NOT be its own tab stop or Enter on it would.
  it.each(['r', 'F2'])('renames from the keyboard with %s, leaving Enter as open', (key) => {
    const h = handlers();
    const t = task({ goal: 'g-pr', title: 'Old title' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    const title = root.querySelector('.hub-task-title') as HTMLElement;
    expect(title.hasAttribute('tabindex')).toBe(false);
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    press(key, row);
    expect(editing()).toBe(true);
    // Entered by a key, so there is no click position — the caret goes to the
    // end, which is where a rename you did not aim at should start.
    expect(caret()).toBe('Old title'.length);
    // …and starting an edit must not also open the task behind it.
    expect(h.onOpenTask).not.toHaveBeenCalled();
    // Control: Enter on the same row still opens, so the rename key took one
    // that was free rather than one that already meant something.
    press('Escape');
    press('Enter', row);
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });

  // `r` is a LETTER, and a letter belongs to whatever is being typed into —
  // including the title this very handler opened. The editable words are a
  // SPAN, which none of the usual "am I in a text field" selectors match, so
  // without the guard the first `r` of a retyped title would land on the row.
  it('leaves the letter alone once it is being typed into the title', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr', title: 'Old' })], filters), h);
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    press('r', row);
    const editor = words();
    editor.textContent = 'Old r';
    press('r');
    // Same open edit over the same element, not a fresh one over a re-read of
    // the old title — and the row did not open behind it either.
    expect(words()).toBe(editor);
    expect(editing()).toBe(true);
    expect(editor.textContent).toBe('Old r');
    expect(h.onOpenTask).not.toHaveBeenCalled();
  });

  // Renaming from the keyboard is a rename, and a coarse pointer has no rename
  // on the row at all — it lives in the detail panel there. A keyboard is a
  // fine pointer's companion, but the two are independent facts, so the guard
  // is asserted rather than assumed.
  it('has no keyboard rename where the title is not editable', () => {
    const h = handlers({ inlineTitleEdit: () => false });
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    const row = root.querySelector('.hub-task-row') as HTMLElement;
    for (const key of ['r', 'F2']) press(key, row);
    expect(editing()).toBe(false);
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
    // A tap on the WORDS, which is the half that behaves differently on a
    // fine pointer — tapping the empty part of the cell was never in doubt.
    clickAt(words());
    expect(editing()).toBe(false);
    expect(h.onTitleCommit).not.toHaveBeenCalled();
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
    // The anatomy does not change shape between pointers: the words still sit
    // in their own element, they just carry no rename.
    expect(words()).not.toBeNull();
  });
});

// The row is a tab stop and Enter on it opens the task — but so is every
// control inside it, and a keydown from any of them bubbles through the row
// on its way out. The row therefore has to say which Enters are its own.
describe('Enter on a task row', () => {
  const rowIn = () => root.querySelector('.hub-task-row') as HTMLElement;
  const enter = (from: HTMLElement) =>
    from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  it('opens the task when the row itself has the focus', () => {
    const h = handlers();
    const t = task({ goal: 'g-pr' });
    renderBoard(root, boardSections(GOALS, [t], filters), h);
    enter(rowIn());
    expect(h.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({ id: t.id }));
  });

  // The defect this pair exists for: Enter on the focused pencil opened the
  // detail panel instead of starting a rename. The pencil stopped propagation
  // on CLICK, and the browser synthesizes that click only after the keydown
  // has already bubbled — so the row won the race every time, and the
  // control's own guard never got to run. The pencil has gone, but the guard
  // it forced is what still protects the status and assignee pickers.
  it('leaves the task closed when a control inside the row has the focus', () => {
    const h = handlers();
    renderBoard(root, boardSections(GOALS, [task({ goal: 'g-pr' })], filters), h);
    enter(root.querySelector('.hub-status-select') as HTMLElement);
    enter(root.querySelector('.hub-row-assignee') as HTMLElement);
    enter(root.querySelector('.hub-drag-handle') as HTMLElement);
    expect(h.onOpenTask).not.toHaveBeenCalled();
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
