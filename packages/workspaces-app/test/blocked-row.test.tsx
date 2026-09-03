/**
 * A blocked row on the board.
 *
 * Blocked is derived from the row's open `after` edges — it is not a status
 * and there is no control that sets it — so the properties worth asserting
 * are the ones that a stored fifth status would get wrong: the ring appears
 * because an edge is open, and it CLEARS on its own when the ticket it names
 * closes, with nobody writing anything to the blocked row.
 *
 * The gutter curve is asserted here as wiring — the edges the band builds and
 * where the arrowhead lands — over stubbed boxes, because happy-dom has no
 * layout. The geometry itself is `dep-curves.test.ts`, and how it looks is
 * the headless-Chromium pass.
 *
 * Fixtures are synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { boardData } from '../src/hub/board-island.tsx';
import {
  type BoardFilters,
  CHORES_ID,
  DEFAULT_DONE_WINDOW,
  type HubGoal,
  type HubTask,
  boardSections,
} from '../src/hub/hub-board-model.ts';
import { IPAD, installSheets, setViewport, styleOf } from './css-harness.ts';
import { type ShimHandlers, disposeBoards, renderBoard } from './support/board.ts';

const NOW = 1_700_000_000_000;
const GOALS: HubGoal[] = [{ id: 'g-board', title: 'The board reads clearly' }];
const filters: BoardFilters = {
  tab: 'all',
  userName: 'Wren',
  doneWindow: DEFAULT_DONE_WINDOW,
  now: NOW,
};

let seq = 0;
function task(over: Partial<HubTask> = {}): HubTask {
  seq += 1;
  return {
    id: `t-${seq}`,
    title: `Task ${seq}`,
    status: 'todo',
    assignee: 'agent',
    goal: 'g-board',
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

function handlers(over: Partial<ShimHandlers> = {}): ShimHandlers {
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

const tick = () => new Promise((r) => setTimeout(r, 0));

let root: HTMLElement;
let sheets = () => {};
beforeEach(() => {
  root = document.createElement('div');
  root.className = 'hub-board';
  document.body.replaceChildren(root);
  setViewport(IPAD);
  sheets = installSheets('hub.css', 'styles.css');
});
afterEach(() => {
  disposeBoards();
  sheets();
  document.body.replaceChildren();
});

function paint(tasks: HubTask[]): void {
  renderBoard(root, boardSections(GOALS, tasks, filters), handlers());
}

function rowOf(id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`[data-task-id="${id}"]`);
  if (!el) throw new Error(`no row for ${id}`);
  return el;
}

/** The ring's modifier, as one word. */
function ringOf(id: string): string {
  const mark = rowOf(id).querySelector('.hub-status-mark');
  return (
    [...(mark?.classList ?? [])].find((c) => c.startsWith('hub-status-mark-'))?.slice(16) ?? 'none'
  );
}

/** Whatever the right-hand slot says, as text. */
function noteOf(id: string): string {
  return rowOf(id).querySelector('.hub-state-note')?.textContent?.trim() ?? '';
}

describe('the ring and the word', () => {
  it('marks a row waiting on an open ticket, and leaves its neighbour alone', () => {
    const gate = task({ title: 'Ship the renderer' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id] });
    const free = task({ title: 'Rename a huddle' });
    paint([gate, waiting, free]);
    expect(ringOf(waiting.id)).toBe('blocked');
    expect(noteOf(waiting.id)).toBe('blocked');
    expect(rowOf(waiting.id).classList.contains('hub-blocked')).toBe(true);
    // The control: two rows on the same board, same status, no edge.
    expect(ringOf(free.id)).toBe('todo');
    expect(noteOf(free.id)).toBe('');
    expect(ringOf(gate.id)).toBe('todo');
  });

  it('clears the ring when the blocker closes, with nothing written to the blocked row', () => {
    const gate = task({ title: 'Ship the renderer' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id] });
    paint([gate, waiting]);
    expect(ringOf(waiting.id)).toBe('blocked');
    // The blocked row is IDENTICAL across the two paints — same object, same
    // `after`, same `todo`. Only the ticket it waits on moved.
    paint([{ ...gate, status: 'done' }, waiting]);
    expect(ringOf(waiting.id)).toBe('todo');
    expect(noteOf(waiting.id)).toBe('');
  });

  it('an archived blocker holds nothing — a row cannot be wedged by a ticket nobody can close', () => {
    const gate = task({ title: 'Ship the renderer' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id] });
    paint([{ ...gate, archivedAt: NOW }, waiting]);
    expect(ringOf(waiting.id)).toBe('todo');
    // Positive control: unarchived, the same edge does block.
    paint([gate, waiting]);
    expect(ringOf(waiting.id)).toBe('blocked');
  });

  it('marks an IN-PROGRESS row too — the queue drops it, so the board says why', () => {
    const gate = task({ title: 'Ship the renderer' });
    const running = task({ title: 'Wire the panel', status: 'in-progress', after: [gate.id] });
    paint([gate, running]);
    expect(ringOf(running.id)).toBe('blocked');
    expect(noteOf(running.id)).toBe('blocked');
    // Positive control: the same in-progress row with its blocker closed
    // keeps its own mark, so the ring above is the edge and not the status.
    paint([{ ...gate, status: 'done' }, running]);
    expect(ringOf(running.id)).toBe('in-progress');
    expect(noteOf(running.id)).toBe('');
  });

  it('a done or triage row keeps its own mark, whatever it waits on', () => {
    const gate = task({ title: 'Ship the renderer' });
    const finished = task({ title: 'Wire the panel', status: 'done', after: [gate.id] });
    const unvetted = task({ title: 'Token spend chip', status: 'triage', after: [gate.id] });
    paint([gate, finished, unvetted]);
    expect(ringOf(finished.id)).toBe('done');
    expect(noteOf(finished.id)).toBe('');
    expect(ringOf(unvetted.id)).toBe('triage');
    // Triage keeps the slot it already owned rather than being overwritten.
    expect(noteOf(unvetted.id)).toBe('triage');
  });

  it('shares the one slot with triage, and leaves the due date beside it', () => {
    const gate = task({ title: 'Ship the renderer' });
    const unvetted = task({ title: 'Token spend chip', status: 'triage' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id], dueAt: NOW + 86_400_000 });
    paint([gate, unvetted, waiting]);
    expect(noteOf(unvetted.id)).toBe('triage');
    expect(ringOf(unvetted.id)).toBe('triage');
    // Blocked and triage never co-occur, so one word is enough — and the due
    // date is still there, in the same slot, not displaced by it.
    expect(rowOf(waiting.id).querySelectorAll('.hub-state-note')).toHaveLength(1);
    expect(rowOf(waiting.id).querySelector('.hub-badge-due')?.textContent).toContain('due');
  });

  it('says blocked in the status control name, and does not offer it as a status', () => {
    const gate = task({ title: 'Ship the renderer' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id] });
    paint([gate, waiting]);
    const select = rowOf(waiting.id).querySelector<HTMLSelectElement>('.hub-status-select');
    expect(select?.getAttribute('aria-label')).toContain('blocked');
    // The way out of blocked is closing what it waits for, so the picker must
    // not pretend otherwise.
    expect([...(select?.options ?? [])].map((o) => o.value)).not.toContain('blocked');
    expect(select?.value).toBe('todo');
  });

  it('keeps the word out of the way of the title — muted, on the right, never beside it', () => {
    const gate = task({ title: 'Ship the renderer' });
    // Not overdue: the overdue badge is red, and this case is about the muted
    // ink the two share when neither is an alarm.
    const waiting = task({
      title: 'Wire the panel',
      after: [gate.id],
      dueAt: Date.now() + 86_400_000,
    });
    paint([gate, waiting]);
    const row = rowOf(waiting.id);
    const note = row.querySelector<HTMLElement>('.hub-state-note');
    const due = row.querySelector<HTMLElement>('.hub-badge-due');
    const title = row.querySelector<HTMLElement>('.hub-task-title-text');
    if (!note || !due || !title) throw new Error('row is missing a cell');
    // Muted, the same muted the due date already is, and NOT the title's ink.
    expect(styleOf(note).color).toBe(styleOf(due).color);
    expect(styleOf(note).color).not.toBe(styleOf(title).color);
    // It is in the badge slot, which sits after the title cell in the grid.
    expect(note.closest('.hub-task-badges')).toBeTruthy();
    expect(row.querySelector('.hub-task-title')?.textContent).toBe('Wire the panel');
  });
});

describe('the gutter curve', () => {
  /** happy-dom lays nothing out, so the boxes are supplied. Rows are 40 tall,
   *  stacked from the container's top, in DOM order. */
  function stubLayout(): void {
    const box = root.querySelector<HTMLElement>('.hub-band-tasks');
    if (!box) throw new Error('no band');
    box.getBoundingClientRect = () => ({ top: 0, left: 0, width: 600, height: 200 }) as DOMRect;
    const rows = [...root.querySelectorAll<HTMLElement>('.hub-task-row')];
    rows.forEach((el, i) => {
      el.getBoundingClientRect = () =>
        ({ top: i * 40, left: 0, width: 600, height: 40 }) as DOMRect;
      Object.defineProperty(el, 'offsetHeight', { value: 40, configurable: true });
    });
  }

  /**
   * A repaint, so the layout effect runs again now that the boxes answer.
   *
   * The sections are cloned rather than the signal merely rewritten: Preact
   * skips a child whose prop object is reference-identical, so a bare
   * `{ ...boardData.value }` re-renders the board and NOT the bands — the
   * curves would stay empty and every case here would pass for nothing. The
   * app rebuilds its sections on every paint (`boardSections` returns fresh
   * objects), so this is the shape the real repaint has.
   */
  async function repaint(): Promise<void> {
    const now = boardData.value;
    boardData.value = { ...now, sections: now.sections.map((s) => ({ ...s })) };
    await tick();
  }

  function layer(): SVGSVGElement {
    const el = root.querySelector<SVGSVGElement>('.hub-dep-layer');
    if (!el) throw new Error('no dep layer');
    return el;
  }

  it('draws one line and one arrowhead per edge, with the head on the waiting row', async () => {
    const gate = task({ title: 'Ship the renderer' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id] });
    paint([gate, waiting]);
    stubLayout();
    await repaint();
    const paths = [...layer().querySelectorAll('path')];
    expect(paths).toHaveLength(2);
    // The second path is the arrowhead; it starts at the waiting row's centre
    // — row index 1, so 40 + 20.
    expect(paths[1]?.getAttribute('d')?.startsWith('M 31 60 ')).toBe(true);
    // And the line runs from the blocker's centre to it.
    expect(paths[0]?.getAttribute('d')?.startsWith('M 31 20 ')).toBe(true);
  });

  it('points the head at the waiting row when the blocker sits BELOW it', async () => {
    const waiting = task({ title: 'Wire the panel' });
    const gate = task({ title: 'Ship the renderer' });
    // Filed first, waiting on a row that sorts below it.
    paint([{ ...waiting, after: [gate.id] }, gate]);
    stubLayout();
    await repaint();
    const paths = [...layer().querySelectorAll('path')];
    expect(paths).toHaveLength(2);
    expect(paths[1]?.getAttribute('d')?.startsWith('M 31 20 ')).toBe(true);
  });

  it('draws no curve for a blocker in another goal — the ring still says blocked', async () => {
    const elsewhere = task({ title: 'Ship the renderer', goal: CHORES_ID });
    const waiting = task({ title: 'Wire the panel', after: [elsewhere.id] });
    paint([elsewhere, waiting]);
    stubLayout();
    await repaint();
    expect(ringOf(waiting.id)).toBe('blocked');
    const bands = [...root.querySelectorAll<SVGSVGElement>('.hub-dep-layer')];
    expect(bands.flatMap((b) => [...b.querySelectorAll('path')])).toHaveLength(0);
    // Positive control: move the blocker into the same goal and the curve
    // appears, so the empty result above is the band boundary.
    paint([{ ...elsewhere, goal: 'g-board' }, waiting]);
    stubLayout();
    await repaint();
    expect([...layer().querySelectorAll('path')]).toHaveLength(2);
  });

  it('draws nothing at all when the band has no layout', async () => {
    const gate = task({ title: 'Ship the renderer' });
    const waiting = task({ title: 'Wire the panel', after: [gate.id] });
    paint([gate, waiting]);
    // No stubs: every box measures zero, as a folded band does.
    await repaint();
    expect([...layer().querySelectorAll('path')]).toHaveLength(0);
  });

  it('never intercepts a tap meant for a row', () => {
    paint([task(), task()]);
    expect(styleOf(layer() as unknown as HTMLElement).pointerEvents).toBe('none');
    expect(layer().getAttribute('aria-hidden')).toBe('true');
  });
});
