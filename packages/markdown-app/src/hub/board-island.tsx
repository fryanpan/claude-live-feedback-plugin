/**
 * The board — the goal bands and their task rows — as a Preact island.
 *
 * This is the surface the migration was aimed at. The vanilla `renderBoard`
 * emptied its container and rebuilt every band and every row on every paint,
 * and the board repaints constantly: a peer's transition over the ydoc, an
 * SSE `thread.*`, an attachment refresh, the reader's own status pick. So
 * anything a row was holding died with it — an in-flight rename, a focused
 * row halfway through an Alt+Arrow sequence, an open native picker, the
 * half-typed title in "New goal".
 *
 * Rows are keyed on the TASK ID and bands on the goal id — the two ids that
 * survive a re-fetch, a reconnect and a reorder — so an unchanged row is the
 * IDENTICAL DOM node across a signal update. That single property is what
 * every fix below reduces to.
 *
 * The bridge is one-directional, as in the Home review and presence islands:
 * `renderBoardRegion` still owns the projection, the filters and the
 * attachment list, and writes them into `boardData`; the island only reads.
 * The stable callbacks are bound once at mount; the values that change per
 * paint (sections, the agent list, the archived count, which pane is showing)
 * ride the signal, because a handler object bound at mount would be answering
 * with the agent list as it stood at boot.
 *
 * What stays vanilla and why: `renderArchivedList` is a different list with a
 * different anatomy and it now renders into its own container, because no
 * vanilla code may `replaceChildren` a node holding a live island.
 */
import { signal } from '@preact/signals';
import { type ComponentChildren, Fragment, type RefObject, render } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import {
  type BoardSection,
  GENERIC_ASSIGNEE,
  type HubPane,
  type HubTask,
  type ReorderTarget,
  TASK_STATUS_ORDER,
  type TaskStatus,
  assigneeLabel,
  dropIndexFor,
  dropTarget,
  ownerInitials,
  ownerKindSuffix,
  ownerMarkKind,
  statusLabel,
  statusOptions,
  stepTarget,
} from './hub-model.ts';
import {
  type SelectionMark,
  caretOffsetIn,
  finePointer,
  sameSelection,
  selectionInside,
  wireWordsInPlace,
} from './inline-rename.ts';

// ── The contract with the vanilla loader ───────────────────────────────────

export interface BoardHandlers {
  /** The row's status dropdown picked `to` — an arbitrary status, not a step
   *  along a cycle. Same shape as the detail panel's, deliberately. */
  onStatusSet: (task: HubTask, to: TaskStatus) => void;
  onGoalTitleCommit: (sectionId: string, title: string) => void;
  /** A new band, typed into the row at the foot of the list. `after` is the
   *  band it should follow, omitted to append. Absent → no add affordance,
   *  which is what every existing caller (and every test) gets. */
  onGoalAdd?: (title: string, after?: string) => void;
  /** The goal row was opened: the only gesture the row has on a coarse
   *  pointer, and the desktop click anywhere off the title's words — the same
   *  interaction model as a task row (Bryan's mockup review, 2026-08-23).
   *  Absent → the tap does nothing yet; the goal detail panel it should open
   *  is the caller's surface, not this renderer's. */
  onOpenGoal?: (section: BoardSection) => void;
  onOpenTask: (task: HubTask) => void;
  /** A drag or an arrow-key move resolved to a `set_task_goal` call. */
  onReorder: (task: HubTask, target: ReorderTarget) => void;
  onTitleCommit: (task: HubTask, title: string) => void;
  onAssign: (task: HubTask, assignee: string) => void;
  /**
   * Whether the title renames on tap. See `finePointer` for why this is a
   * pointer question rather than a width one. Omitted → asked of the browser.
   */
  inlineTitleEdit?: () => boolean;
  /** The way to the restore list — a quiet line under the last band. Absent,
   *  or an `archivedCount` of zero, draws nothing at all: a board that has
   *  never archived anything should not carry a control saying so. */
  onShowArchived?: () => void;
}

export interface BoardData {
  sections: BoardSection[];
  /**
   * Which pane is showing. Home hides the whole board column, and rendering
   * rows into a hidden column is worse than waste — a zero-height row still
   * answers a selector, so anything reading the board by query gets a full
   * row set on a page showing none of it.
   */
  pane: HubPane;
  /**
   * Whether the reader has swapped the board for the restore list. The list is
   * a view OF the board and takes the board's place, so the rows must not just
   * be hidden behind it: a zero-height row still answers a selector, and
   * `hub-shortcuts` resolves j/k/o/s/e against every `.hub-task-row` on the
   * page — so a hidden row set would let those keys act on rows the reader is
   * not looking at. Same reasoning as `pane`, one surface down.
   */
  showArchived: boolean;
  /** The agents currently attached to this workspace — who a task can be
   *  handed to besides a person. Read from the signal rather than bound at
   *  mount: attachments arrive after the first paint and change while the
   *  board is open, and a picker built from a stale list offers agents who
   *  have left. */
  knownAgentIds: string[];
  /** How many rows this board has archived. A single line above the first
   *  goal, and deliberately NOT a fifth nav item: the phone rail has exactly
   *  four seats, and "what did I put down" is not a place people go, it is a
   *  thing they check after archiving the wrong row. */
  archivedCount: number;
}

/** The one write target the vanilla loader has for the board. */
export const boardData = signal<BoardData>({
  sections: [],
  pane: 'board',
  showArchived: false,
  knownAgentIds: [],
  archivedCount: 0,
});

// ── The drag-select guard ──────────────────────────────────────────────────

/**
 * A click that ends a drag-select fires like any other, and neither of a
 * row's two gestures may act on it: opening the panel would destroy the
 * selection the reader just made to copy a title, and swapping the words for
 * an editor would too.
 *
 * But the question is whether THIS gesture made the selection, not whether
 * one exists: a finished selection stands until the next mousedown, so a
 * single read at click time also swallows the click AFTER the drag and the
 * row reads as dead. Compare the two ends of the gesture instead — changed
 * during it means this click selected something, unchanged means it is
 * somebody else's selection and the row acts.
 */
function useSelectionGuard(node: RefObject<HTMLElement | null>) {
  const at = useRef<SelectionMark | null>(null);
  return {
    arm(): void {
      at.current = node.current ? selectionInside(node.current) : null;
    },
    selectedByThisClick(): boolean {
      const el = node.current;
      if (!el) return false;
      const now = selectionInside(el);
      return now !== null && !sameSelection(now, at.current);
    },
  };
}

// ── Renaming the words in place ────────────────────────────────────────────

/** Starts an edit, with the caret on the character that was clicked. Held in
 *  a ref so the ROW's `r` / F2 handler can reach the words' editor. */
export type BeginRename = { current: ((caret?: number) => void) | null };

/**
 * The title cell, and the words inside it that rename in place.
 *
 * The words live in an INLINE child rather than loose in the cell, and that
 * is what makes Bryan's rule expressible: everything on the row except the
 * actual text opens the task, *including the whitespace to the right of the
 * text*. The cell is the grid's `minmax(0, 1fr)` track, so on a 1282px row a
 * six-word title leaves most of it empty, and a handler on the cell could not
 * tell the empty half from the words. The browser's own hit-testing tells
 * them apart for free: a click on the empty part has the CELL as its target,
 * never reaches this child, and bubbles on to the row's open handler.
 *
 * The words' TEXT is written imperatively rather than as a Preact child, and
 * that is the island's half of the rename fix. A repaint that re-rendered
 * `{task.title}` into a node the reader is typing into would overwrite the
 * edit — which is exactly what the vanilla board did, more brutally, by
 * rebuilding the node. `wireWordsInPlace` owns the element while an edit is
 * open and says so through `isEditing`; outside an edit this component keeps
 * the text current.
 */
function TitleWords(props: {
  cellClass: string;
  wordsClass: string;
  text: string;
  editable: boolean;
  tip?: string;
  onCommit: (v: string) => void;
  guard: { selectedByThisClick(): boolean };
  begin: BeginRename;
}) {
  const cell = useRef<HTMLSpanElement | null>(null);
  const words = useRef<HTMLSpanElement | null>(null);
  const editing = useRef<(() => boolean) | null>(null);
  // Read through refs so the wiring below can be bound ONCE against a node
  // that outlives every repaint, without capturing a stale title or a stale
  // commit callback.
  const latest = useRef(props.text);
  latest.current = props.text;
  const commit = useRef(props.onCommit);
  commit.current = props.onCommit;

  useLayoutEffect(() => {
    const el = words.current;
    if (!el || !props.editable) return;
    const wired = wireWordsInPlace(
      el,
      () => latest.current,
      (v) => commit.current(v),
      (on) => cell.current?.classList.toggle('hub-title-editing', on),
    );
    editing.current = wired.isEditing;
    props.begin.current = wired.begin;
  }, [props.editable]);

  useLayoutEffect(() => {
    const el = words.current;
    // Hands off while a rename is open: the text belongs to the reader until
    // Enter, Escape or blur ends the edit.
    if (!el || editing.current?.()) return;
    if (el.textContent !== props.text) el.textContent = props.text;
  });

  return (
    <span ref={cell} class={props.cellClass} title={props.tip}>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard's path
          into a rename is `r` / F2 on the focused ROW, which is where the
          handler lives (see TaskRow / GoalBand). A duplicate key handler on
          the words would be a second way to start the same edit, and the
          words are not a tab stop for it to be reachable from anyway. */}
      <span
        ref={words}
        class={props.wordsClass}
        // No handler at all where renaming does not live: on a coarse pointer
        // a tap on the words has to reach the row and OPEN the thing, so a
        // listener that only ever stops the bubble would make the title the
        // one dead patch on the row.
        onClick={
          props.editable
            ? (ev) => {
                // The one click on this row that does not open it.
                ev.stopPropagation();
                if (props.guard.selectedByThisClick()) return;
                if (!words.current) return;
                // Already editing: this click is the reader moving their own
                // caret, and `begin` no-ops on it. Stopping the bubble is the
                // whole job.
                props.begin.current?.(caretOffsetIn(words.current, ev.clientX, ev.clientY));
              }
            : undefined
        }
      />
    </span>
  );
}

// ── The task row ───────────────────────────────────────────────────────────

/**
 * A `<select>` whose value has to be applied AFTER its options are in the
 * tree — a detached option's selected flag does not survive being appended,
 * and the same is true of a value set before Preact has diffed the children.
 */
function useSelectValue(ref: RefObject<HTMLSelectElement | null>, value: string): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && el.value !== value) el.value = value;
  });
}

/**
 * A dropdown over every status, not a tap-to-cycle mark. The cycle assumed
 * the workflow was linear (todo → in-progress → done → todo), so sending a
 * finished task back to todo cost two transitions and wrote two audit events
 * for a move that happened once. A native <select> also gets the mobile
 * picker and keyboard support for free, which a custom popup would owe.
 *
 * …drawn as a small round mark rather than as the word. The select is still
 * the control — laid over the mark at full size and made transparent, which
 * is the only way to keep the phone's native picker and the keyboard
 * behaviour while spending 22px instead of 96px of the row.
 */
function StatusControl(props: { task: HubTask; onSet: (to: TaskStatus) => void }) {
  const { task } = props;
  const sel = useRef<HTMLSelectElement | null>(null);
  useSelectValue(sel, task.status);
  const reads = `Status: ${statusLabel(task.status)}`;
  return (
    <span class="hub-status-ctl">
      <span class={`hub-status-mark hub-status-mark-${task.status}`} aria-hidden="true" />
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a <select> is already a
          keyboard control, and this onClick adds no action — it only stops the
          click reaching the row's open handler. There is nothing for a key
          handler to duplicate. */}
      <select
        ref={sel}
        class={`hub-status-select hub-chip-${task.status}`}
        aria-label={reads}
        title={reads}
        // A select swallows its own clicks in a real browser, but the row's
        // open handler must not fire from the picker either way.
        onClick={(ev) => ev.stopPropagation()}
        onChange={(ev) => {
          ev.stopPropagation();
          const to = (ev.currentTarget as HTMLSelectElement).value as TaskStatus;
          if (to !== task.status) props.onSet(to);
        }}
      >
        {statusOptions(task.status, TASK_STATUS_ORDER).map((s) => (
          <option key={s} value={s}>
            {statusLabel(s)}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * Who has this task, as a picker over everyone it could go to — and the
 * circle of initials it is laid over.
 *
 * The options are the workspace's live attachments plus 'human', plus the
 * current owner whoever they are: attachments describe who is here NOW, and
 * dropping a detached owner from the list would silently rename their work on
 * the next render.
 */
function OwnerControl(props: {
  task: HubTask;
  knownAgentIds: string[];
  onAssign: (to: string) => void;
}) {
  const { task, knownAgentIds } = props;
  const owner = task.assignee.trim().toLowerCase() === GENERIC_ASSIGNEE ? '' : task.assignee.trim();
  const kind = ownerMarkKind(task, owner);
  const sel = useRef<HTMLSelectElement | null>(null);
  useSelectValue(sel, owner);
  const agents = [...new Set([...knownAgentIds, ...(owner && owner !== 'human' ? [owner] : [])])]
    .filter((id) => id.trim().toLowerCase() !== GENERIC_ASSIGNEE)
    .sort((a, b) => a.localeCompare(b));
  const reads = owner === '' ? 'nobody' : `${assigneeLabel(owner)}${ownerKindSuffix(kind)}`;
  const label = `Assignee: ${reads} — pick who takes this`;
  return (
    <span class="hub-owner-ctl">
      <span class={`hub-owner-avatar hub-owner-${kind}`} aria-hidden="true">
        {ownerInitials(task.assignee)}
      </span>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: as above — a keyboard
          control whose onClick only stops the bubble to the row. */}
      <select
        ref={sel}
        class={`hub-row-assignee hub-owner-${kind}`}
        title={label}
        aria-label={label}
        onClick={(ev) => ev.stopPropagation()}
        onChange={(ev) => {
          ev.stopPropagation();
          const to = (ev.currentTarget as HTMLSelectElement).value;
          if (to && to !== owner) props.onAssign(to);
        }}
      >
        {/* Only ever offered while nobody owns it: an unowned task needs a
            landing place in the list, but "hand this back to nobody" is not
            a move. */}
        {owner === '' && <option value="">Unassigned</option>}
        {['human', ...agents].map((id) => (
          <option key={id} value={id}>
            {assigneeLabel(id)}
          </option>
        ))}
      </select>
    </span>
  );
}

/**
 * What the row says about the task besides its name.
 *
 * Deliberately short. `decision` / `action`, the comment count and the
 * dependency count all used to sit here and were struck by name — see the
 * removal notes kept in git history for each. What is left is true of almost
 * no rows, which is the test a badge has to pass on a list whose job is
 * answering what to work on next.
 */
function TaskBadges(props: { task: HubTask }) {
  const { task } = props;
  const badges: ComponentChildren[] = [];
  if (task.dueAt !== undefined) {
    const due = new Date(task.dueAt);
    const overdue = task.dueAt < Date.now() && task.status !== 'done';
    badges.push(
      <span
        key="due"
        class={overdue ? 'hub-badge hub-badge-due hub-badge-overdue' : 'hub-badge hub-badge-due'}
      >
        {`due ${due.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}
      </span>,
    );
  }
  return <span class="hub-task-badges">{badges}</span>;
}

/** A box whose contents are rewritten on every render and read from a
 *  listener bound once. Preact's own `RefObject` admits null, which these
 *  never are. */
interface Box<T> {
  current: T;
}

/** What a drag or an arrow-key move needs that a single row cannot hold: the
 *  whole board (a drop can cross into another goal's section) and the element
 *  the drop marks are painted on. Boxes, so the row's listeners can be bound
 *  once and still read the CURRENT sections. */
interface ReorderCtx {
  wrapper: Box<HTMLElement>;
  sections: Box<BoardSection[]>;
  onReorder: Box<(task: HubTask, target: ReorderTarget) => void>;
}

function clearDropMarks(container: HTMLElement): void {
  for (const el of container.querySelectorAll('.hub-drop-into')) {
    el.classList.remove('hub-drop-into');
  }
  for (const el of container.querySelectorAll('.hub-drop-before, .hub-drop-after')) {
    el.classList.remove('hub-drop-before', 'hub-drop-after');
  }
}

/**
 * Which section and slot the pointer is currently over, painted as it goes.
 * This is the only browser-shaped part of reordering — `elementFromPoint` and
 * layout rectangles have no meaning without a real engine — so it does no
 * arithmetic of its own: the index comes from `dropIndexFor` and the call it
 * turns into comes from `dropTarget`, both pure and both unit-tested.
 */
function previewDrop(
  container: HTMLElement,
  dragged: HTMLElement,
  x: number,
  y: number,
): { sectionId: string; index: number } | null {
  const at =
    typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
  const section = at?.closest?.('.hub-section') as HTMLElement | null;
  if (!section) return null;
  const rows = [...section.querySelectorAll<HTMLElement>('.hub-task-row')].filter(
    (r) => r !== dragged,
  );
  const index = dropIndexFor(
    rows.map((r) => {
      const box = r.getBoundingClientRect();
      return { top: box.top, height: box.height };
    }),
    y,
  );
  clearDropMarks(container);
  section.classList.add('hub-drop-into');
  const before = rows[index];
  if (before) before.classList.add('hub-drop-before');
  else rows[rows.length - 1]?.classList.add('hub-drop-after');
  return { sectionId: section.dataset.goalId ?? '', index };
}

/**
 * One task, keyed on its id.
 *
 * Every gesture the vanilla row had, in the same reading order —
 * handle · status · title · badges · caret · owner — because the grid tracks
 * are written against that order and a missing child slides every later cell
 * one track left.
 */
function TaskRow(props: {
  task: HubTask;
  handlers: BoardHandlers;
  knownAgentIds: string[];
  editable: boolean;
  reorder: ReorderCtx;
}) {
  const { task, handlers, reorder } = props;
  const row = useRef<HTMLDivElement | null>(null);
  const handle = useRef<HTMLButtonElement | null>(null);
  const guard = useSelectionGuard(row);
  const begin = useRef<((caret?: number) => void) | null>(null);
  const done = task.status === 'done';

  // Read through a ref so the drag's listeners, bound per press, always act on
  // the row the reader is dragging NOW rather than on a captured copy.
  const taskRef = useRef(task);
  taskRef.current = task;

  const step = (dir: -1 | 1): void => {
    const target = stepTarget(reorder.sections.current, taskRef.current.id, dir);
    if (target) reorder.onReorder.current(taskRef.current, target);
  };

  /**
   * Pointer Events rather than HTML5 drag-and-drop. Mockup v2 used
   * `draggable`, which is the right sketch and the wrong mechanism here:
   * `dragstart` never fires for a finger, so a `draggable` handle is dead on
   * the surface where this board is actually reviewed. A drag has two endings
   * and `pointercancel` is the common one on a phone, so both are wired; on
   * cancel the move is abandoned rather than committed.
   */
  const onHandleDown = (ev: PointerEvent): void => {
    if (ev.button > 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const el = handle.current;
    const rowEl = row.current;
    const container = reorder.wrapper.current;
    if (!el || !rowEl) return;
    let drop: { sectionId: string; index: number } | null = null;
    rowEl.classList.add('hub-dragging');
    try {
      el.setPointerCapture?.(ev.pointerId);
    } catch {
      /* capture is an optimisation; the listeners below work without it */
    }
    const onMove = (m: PointerEvent) => {
      const next = previewDrop(container, rowEl, m.clientX, m.clientY);
      if (next) drop = next;
    };
    const finish = (commit: boolean) => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      try {
        el.releasePointerCapture?.(ev.pointerId);
      } catch {
        /* nothing captured */
      }
      rowEl.classList.remove('hub-dragging');
      clearDropMarks(container);
      if (!commit || !drop) return;
      const target = dropTarget(
        reorder.sections.current,
        taskRef.current.id,
        drop.sectionId,
        drop.index,
      );
      if (target) reorder.onReorder.current(taskRef.current, target);
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
  };

  // The row IS the interactive element: it opens the task on click and on
  // Enter, and j/k walk the board by focusing rows (hub-shortcuts). Dropping
  // the tab stop would take the whole keyboard navigation with it, and giving
  // the div a `role` would rewrite what a screen reader announces for every
  // row on the board — a design change, not a lint fix.
  return (
    <div
      ref={row}
      class={`hub-task-row hub-status-${task.status}${done ? ' hub-done' : ''}`}
      data-task-id={task.id}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: see the note above — the row is the board's focusable unit.
      tabIndex={0}
      onMouseDown={guard.arm}
      onClick={() => {
        if (guard.selectedByThisClick()) return;
        handlers.onOpenTask(task);
      }}
      onKeyDown={(ev) => {
        const target = ev.target as HTMLElement;
        // Alt+Arrow from the ROW: j/k leaves the focus on the row, so a
        // reorder reachable only from the handle would mean tabbing out of the
        // navigation you are already in. Bare arrows stay the browser's.
        if (!done && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
          ev.preventDefault();
          step(ev.key === 'ArrowUp' ? -1 : 1);
          return;
        }
        if (props.editable && (ev.key === 'F2' || ev.key === 'r')) {
          // The pencil was the keyboard's rename and it is gone, so these two
          // spellings are. `r` joins the row's single-letter set (j/k move, o
          // opens, s status, a assignee) and is reachable on the Magic Keyboard
          // Bryan reviews from, which has no function row at all. A letter key
          // belongs to whatever is being typed into — `[contenteditable]` is in
          // the list because the title being renamed IS one.
          if (target.closest('input, textarea, select, [contenteditable]')) return;
          ev.preventDefault();
          ev.stopPropagation();
          begin.current?.();
          return;
        }
        if (ev.key !== 'Enter') return;
        // Every control in the row is its own tab stop, and Enter on a focused
        // control fires a keydown that bubbles through here BEFORE the browser
        // synthesizes the control's activation — so a row that takes every
        // Enter beats each of them to it. Space never showed this: a button
        // activates on keyUP. The row takes Enter only when focus is on it.
        if (target.closest('input, button, select, textarea')) return;
        handlers.onOpenTask(task);
      }}
    >
      {/* Far left: the drag handle. Hidden until the row is hovered or the
          handle itself is focused (CSS) — a permanent column of ⠿ is noise on
          a list you read by skimming. A done row keeps the ELEMENT and loses
          the control: finishing a task doesn't move it (mockup v2), and
          dropping the child would slide every later cell one track left. */}
      <button
        ref={handle}
        type="button"
        class="hub-drag-handle"
        disabled={done}
        tabIndex={done ? -1 : 0}
        aria-hidden={done ? 'true' : undefined}
        aria-label={done ? undefined : `Reorder “${task.title}” — drag, or arrow keys to move`}
        title={done ? undefined : 'Drag to reorder — or focus and use the arrow keys'}
        onClick={(ev) => ev.stopPropagation()}
        onKeyDown={(ev) => {
          if (done || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
          ev.preventDefault();
          ev.stopPropagation();
          step(ev.key === 'ArrowUp' ? -1 : 1);
        }}
        onPointerDown={done ? undefined : onHandleDown}
      >
        ⠿
      </button>
      <StatusControl task={task} onSet={(to) => handlers.onStatusSet(task, to)} />
      <TitleWords
        cellClass="hub-task-title"
        wordsClass="hub-task-title-text"
        text={task.title}
        editable={props.editable}
        tip={
          props.editable
            ? 'Click the words to rename · anywhere else opens the task'
            : 'Tap to open'
        }
        onCommit={(v) => handlers.onTitleCommit(task, v)}
        guard={guard}
        begin={begin}
      />
      <TaskBadges task={task} />
      {/* The open caret. Asana's desktop affordance, asked for by name: it
          appears on hover and always opens the task. It needs no click handler
          — the row's own opens and this click bubbles into it. It sits at the
          RIGHT end, immediately before the assignee bubble (Bryan, 2026-08-21,
          twice). Deliberately not a tab stop: Enter on the focused row already
          opens the task. `tabIndex={-1}` leaves it CLICK-focusable, and a
          button that keeps focus after the panel it opened closes is a blue
          ring standing on an `aria-hidden` glyph — so the mousedown default is
          cancelled, which is the standard "clickable, never focusable". */}
      <button
        type="button"
        class="hub-task-open"
        tabIndex={-1}
        aria-hidden="true"
        title="Open this task"
        onMouseDown={(ev) => ev.preventDefault()}
      >
        ›
      </button>
      <OwnerControl
        task={task}
        knownAgentIds={props.knownAgentIds}
        onAssign={(to) => handlers.onAssign(task, to)}
      />
    </div>
  );
}

// ── The goal band ──────────────────────────────────────────────────────────

/**
 * Which bands this viewer has folded — localStorage, never the shared ydoc,
 * because a fold is a reading preference: collapsing a band you have finished
 * scanning must not collapse it for everyone else on the board.
 *
 * Guarded reads/writes: private mode throws on both, and a board that cannot
 * remember a fold is still a board (the state keeps working for the life of
 * the page).
 */
const COLLAPSED_BANDS_KEY = 'hub:collapsed-bands';
function collapsedBands(): Record<string, 1> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_BANDS_KEY) ?? '{}');
    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, 1>) : {};
  } catch {
    return {};
  }
}
function setBandCollapsed(goalId: string, folded: boolean): void {
  try {
    const map = collapsedBands();
    if (folded) map[goalId] = 1;
    else delete map[goalId];
    localStorage.setItem(COLLAPSED_BANDS_KEY, JSON.stringify(map));
  } catch {
    /* private mode — the fold still applies for the life of the page */
  }
}

/**
 * One board band: the goal's own ROW on top, its tasks on a rail below it
 * (Bryan's approved mock, 2026-08-23). The row deliberately carries NONE of a
 * task row's working chrome — his review struck, by name: open/doing/done
 * counts, the drag handle, the status circle, decision chips, and any 'legacy
 * band' marker. Reordering, status and counts live in the goal's detail
 * panel. What the row keeps is what identifies the band at a glance: the
 * title, the due date as plain muted text (overdue = red), and the owner
 * avatar in the same column as the task rows' — that alignment is the CSS's
 * half of the contract (see `goal-band-css.test.ts`).
 *
 * Interaction model is the TASK row's, by decision: on a fine pointer the
 * words rename in place (zero layout shift) and anywhere else opens the goal;
 * on a coarse pointer any tap opens and never edits. The one control a goal
 * row has that a task row does not is the fold, so the twisty is ALWAYS
 * visible: a hover-only affordance is no affordance on the iPad this board is
 * read from.
 *
 * A done band is a muted title, the plain word `done` in the due date's slot,
 * and the attribution riding the row's tooltip.
 */
function GoalBand(props: {
  section: BoardSection;
  handlers: BoardHandlers;
  knownAgentIds: string[];
  editable: boolean;
  reorder: ReorderCtx;
}) {
  const { section, handlers } = props;
  // Seeded from the reading preference and owned by the component from there.
  // Under the vanilla renderer the fold could only live in localStorage,
  // because the band it belonged to was destroyed on every paint.
  const [folded, setFolded] = useState(() => collapsedBands()[section.id] === 1);
  const row = useRef<HTMLDivElement | null>(null);
  const guard = useSelectionGuard(row);
  const begin = useRef<((caret?: number) => void) | null>(null);
  const editable = props.editable && !section.isChores;
  const open = (): void => {
    if (guard.selectedByThisClick()) return;
    handlers.onOpenGoal?.(section);
  };

  // Done attribution, where a one-line row can carry it: the tooltip. The
  // band's visible treatment is the muted title class alone — the mock shows
  // no further chrome for a done goal, and none is invented here.
  let rowTitle: string | undefined;
  if (section.status === 'done') {
    const when =
      section.doneAt !== undefined
        ? `, ${new Date(section.doneAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
        : '';
    rowTitle = section.doneBy ? `Done — declared by ${section.doneBy.name}${when}` : 'Done';
  }

  return (
    <div
      class={[
        'hub-band',
        section.isChores ? 'hub-band-reserved' : '',
        section.status === 'done' ? 'hub-band-done' : '',
        folded ? 'is-collapsed' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        ref={row}
        class="hub-goal-row"
        title={rowTitle}
        tabIndex={section.isChores ? undefined : 0}
        onMouseDown={guard.arm}
        onClick={section.isChores ? undefined : open}
        onKeyDown={
          section.isChores
            ? undefined
            : (ev) => {
                if (
                  (ev.target as HTMLElement).closest(
                    'input, button, select, textarea, [contenteditable]',
                  )
                )
                  return;
                if (ev.key === 'Enter') {
                  handlers.onOpenGoal?.(section);
                } else if (editable && (ev.key === 'r' || ev.key === 'F2')) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  begin.current?.();
                }
              }
        }
      >
        {/* Everything the twisty says names the gesture the NEXT click will
            do, so all three live together. */}
        <button
          type="button"
          class="hub-twisty"
          aria-expanded={folded ? 'false' : 'true'}
          aria-label={`${folded ? 'Expand' : 'Collapse'} “${section.title}”`}
          title={`${folded ? 'Expand' : 'Collapse'} this goal — just for you`}
          onClick={(ev) => {
            ev.stopPropagation();
            setFolded((was) => {
              setBandCollapsed(section.id, !was);
              return !was;
            });
          }}
        >
          <span>▾</span>
        </button>
        <TitleWords
          cellClass="hub-goal-title"
          wordsClass="hub-goal-title-text"
          text={section.title}
          editable={editable}
          tip={
            section.isChores
              ? undefined
              : editable
                ? 'Click the words to rename · anywhere else opens the goal'
                : 'Tap to open'
          }
          onCommit={(v) => handlers.onGoalTitleCommit(section.id, v)}
          guard={guard}
          begin={begin}
        />
        {/* What sits right of the title, as plain muted text (decision 6 —
            explicitly not a chip, and no chip may return beside it). A done
            band takes the due date's SLOT rather than sitting beside it,
            because a date a finished goal ran past is noise. */}
        <span class="hub-goal-meta">
          {!section.isChores && section.status === 'done' ? (
            <span class="hub-done-note">done</span>
          ) : !section.isChores && section.dueAt !== undefined ? (
            <span
              class={section.dueAt < Date.now() ? 'hub-due hub-due-overdue' : 'hub-due'}
            >{`due ${new Date(section.dueAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`}</span>
          ) : null}
        </span>
        {/* The task row's caret, one size up the tree. Same contract: no
            behaviour of its own, not a tab stop, never keeps focus. */}
        <button
          type="button"
          class="hub-goal-open"
          tabIndex={-1}
          aria-hidden="true"
          title="Open this goal"
          onMouseDown={(ev) => ev.preventDefault()}
        >
          ›
        </button>
        {/* The owner slot is ALWAYS emitted — it is the grid track that keeps
            the avatar column aligned with the task rows' (decision 8) — but
            Backlog gets no avatar in it: a bucket cannot be owned, and drawing
            a vacancy would invite filling it. A goal without a projected owner
            IS a vacancy, drawn as one, exactly like an unowned task. */}
        <span class="hub-owner-ctl">
          {!section.isChores &&
            (section.assignee !== undefined ? (
              <span
                class={`hub-owner-avatar ${
                  section.ownerKind === 'person'
                    ? 'hub-owner-human'
                    : section.ownerKind === 'agent'
                      ? 'hub-owner-agent'
                      : 'hub-owner-unknown'
                }`}
                title={`Owner: ${assigneeLabel(section.assignee)}`}
              >
                {ownerInitials(section.assignee)}
              </span>
            ) : (
              <span class="hub-owner-avatar hub-owner-none" title="Nobody owns this goal yet">
                —
              </span>
            ))}
        </span>
      </div>
      {/* The band's tasks, on the rail that says "these belong to the row
          above". A folded band hides this container in CSS and renders NOTHING
          in its place — a collapsed band shows nothing extra, by decision. */}
      <div class="hub-band-tasks">
        {section.tasks.length === 0 ? (
          <p class="hub-section-empty">
            {section.isChores ? 'Nothing in the backlog.' : 'No tasks yet.'}
          </p>
        ) : (
          section.tasks.map((task) => (
            <TaskRow
              key={task.id}
              task={task}
              handlers={handlers}
              knownAgentIds={props.knownAgentIds}
              editable={props.editable}
              reorder={props.reorder}
            />
          ))
        )}
      </div>
    </div>
  );
}

// ── "New goal" ─────────────────────────────────────────────────────────────

/**
 * The other half of inline goal editing, beside the tap-to-rename the section
 * titles already have.
 *
 * It appends after the last REAL band rather than at the very end, because
 * Backlog is a fixed catch-all that always renders last: a band added after it
 * would be the only thing below the bucket for work that has no band.
 *
 * Enter files it, Escape abandons it, and blurring an EMPTY box closes it —
 * closing over typed-but-uncommitted text is how a half-written title
 * disappears when a repaint moves focus.
 *
 * Whether the box is open is component state, and that is the whole reason
 * this row is in the island. Under the vanilla renderer it was a pair of
 * `hidden` classes on nodes the next repaint destroyed: any background event
 * — a peer's transition, an SSE thread, the 30s attachment poll — closed the
 * box and threw away what had been typed into it, so "+ New goal" regularly
 * took two taps and sometimes ate a title.
 */
function GoalAddRow(props: {
  sections: BoardSection[];
  onGoalAdd: (title: string, after?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const close = (): void => {
    if (input.current) input.current.value = '';
    setOpen(false);
  };
  // Focus AFTER the class has landed, never beside `setOpen(true)`. `.hidden`
  // is `display: none !important`, and focusing a display:none element is a
  // no-op in a real browser — a focus() in the click handler would open the box
  // and leave the caret nowhere, which reads as the very "tap it twice" defect
  // this row is here to fix. happy-dom focuses a hidden node happily, so no
  // test can catch this: the layout effect is what makes it correct.
  useLayoutEffect(() => {
    if (open) input.current?.focus();
  }, [open]);
  return (
    <div class="hub-goal-add">
      <button
        type="button"
        class={open ? 'hub-goal-add-btn hidden' : 'hub-goal-add-btn'}
        onClick={() => setOpen(true)}
      >
        + New goal
      </button>
      <input
        ref={input}
        type="text"
        class={open ? 'hub-goal-add-input' : 'hub-goal-add-input hidden'}
        placeholder="Goal title"
        aria-label="New goal title"
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            const title = (ev.currentTarget as HTMLInputElement).value.trim();
            ev.preventDefault();
            if (title.length === 0) {
              close();
              return;
            }
            props.onGoalAdd(title, [...props.sections].reverse().find((s) => !s.isChores)?.id);
            close();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            close();
          }
        }}
        onBlur={(ev) => {
          if ((ev.currentTarget as HTMLInputElement).value.trim().length === 0) close();
        }}
      />
    </div>
  );
}

// ── The board ──────────────────────────────────────────────────────────────

function Board(props: { handlers: BoardHandlers; wrapper: Box<HTMLElement> }) {
  const { sections, pane, showArchived, knownAgentIds, archivedCount } = boardData.value;
  const { handlers } = props;
  const onBoard = pane === 'board' && !showArchived;

  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const onReorderRef = useRef(handlers.onReorder);
  onReorderRef.current = handlers.onReorder;
  const reorder = useRef<ReorderCtx>({
    wrapper: props.wrapper,
    sections: sectionsRef,
    onReorder: onReorderRef,
  }).current;

  // `finePointer()` is NOT a width breakpoint — see it. On a phone the title
  // tap has always meant "open" ("I can't open a task to see what's inside" is
  // the bug that removed tap-to-rename an hour before it first shipped), and
  // renaming lives in the detail panel one tap away.
  const editable = (handlers.inlineTitleEdit ?? finePointer)();

  /**
   * A keyed diff MOVES a reordered row rather than rebuilding it — but
   * re-inserting a node blurs it in WebKit and Blink, and keyboard reordering
   * is a run of moves on ONE focused row: without this the second Alt+Arrow
   * has nothing to act on and the shortcut silently stops after one press.
   *
   * This is all that is left of the focus machinery `renderBoardRegion` used
   * to carry. That version had to find the row again by scanning every
   * `.hub-task-row` for a matching `data-task-id` and then guess which of the
   * row's children had held focus, because the node it was restoring to was a
   * different object. Here the node IS the same object, so the whole question
   * is "did the move drop focus", and the answer is a re-focus of a reference
   * that is still valid. Every repaint that is not a reorder now leaves focus
   * untouched without anyone asking.
   */
  const focused = useRef<HTMLElement | null>(null);
  focused.current = document.activeElement as HTMLElement | null;
  useLayoutEffect(() => {
    const el = focused.current;
    const wrap = props.wrapper.current;
    if (!el || !wrap.contains(el)) return;
    if (document.activeElement !== el && el.isConnected) el.focus();
  });

  if (!onBoard) return null;
  return (
    <Fragment>
      {sections.map((section) => (
        <section
          key={section.id}
          class={`hub-section${section.isChores ? ' hub-chores' : ''}`}
          data-goal-id={section.id}
        >
          <GoalBand
            section={section}
            handlers={handlers}
            knownAgentIds={knownAgentIds}
            editable={editable}
            reorder={reorder}
          />
        </section>
      ))}
      {handlers.onGoalAdd && <GoalAddRow sections={sections} onGoalAdd={handlers.onGoalAdd} />}
      {/* The board's foot line: what is true of the LIST rather than of any
          row in it. One entry so far, and it earns its line only when there is
          something to point at. At the BOTTOM, after the last band and the
          goal-add row — it sat above the first goal until Bryan (2026-08-29,
          by voice) said the top slot "is taking out space": what you put down
          is a thing you go looking for, not the first thing the board says. */}
      {handlers.onShowArchived && archivedCount > 0 && (
        <p class="hub-board-foot">
          <button
            type="button"
            class="hub-linklike hub-board-foot-archived"
            title="Show archived tasks — each one can be restored"
            onClick={() => handlers.onShowArchived?.()}
          >
            {`${archivedCount} archived`}
          </button>
        </p>
      )}
    </Fragment>
  );
}

/**
 * Mounts the board into a wrapper it appends to `host`; returns the disposer.
 * The island contract, exactly as the probe proved it: the wrapper — not the
 * host — is Preact's container, disposal is `render(null, el)` (which runs
 * effect and ref teardown), and no vanilla code may `replaceChildren` or
 * `innerHTML` a container holding the live island. The wrapper is
 * `display: contents` so the sections stay direct children of `.hub-board`
 * for layout and for `previewDrop`'s `.closest('.hub-section')` walk.
 */
export function mountBoardIsland(host: HTMLElement, handlers: BoardHandlers): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'board');
  host.appendChild(el);
  render(<Board handlers={handlers} wrapper={{ current: el }} />, el);
  return () => {
    render(null, el);
    el.remove();
  };
}
