/**
 * Gmail-style shortcuts (§3.9): j/k walk rows, o/Enter opens, s opens the
 * status dropdown, e archives, ? shows help. Never while typing — including
 * while typing inside an embedded component's shadow root, which `ev.target`
 * cannot see (see hotkeysBlocked).
 *
 * A factory rather than an inline listener in hub-app's `main()` so the
 * handler is testable — hub-app runs `main()` on import, which needs a live
 * workspace URL, so nothing in it can be exercised from a test.
 */
import { eventPath, typingInPath } from '../keyboard-target.ts';

export interface HubShortcutDeps {
  /** Live board state, read at keydown time — pass the state object itself,
   *  never a snapshot of it. Structurally minimal so tests need no HubTask. */
  state: {
    detailTaskId: string | null;
    tasks: { get(id: string): { id: string } | undefined };
  };
  helpEl: () => HTMLElement;
  openDetail: (taskId: string) => void;
  closeDetail: () => void;
  /**
   * Archive the anchored task — Gmail's own `e`, on a board that already
   * borrowed j/k/o/s from it.
   *
   * It resolves its target through the SAME anchor as `o`, `s` and `a`: the
   * focused row, or the open panel's row when the panel holds focus. Hover is
   * deliberately not a target. Hover is not focus, it does not exist on the
   * iPad this board is mostly read on, and "whatever the pointer happens to
   * be over" is the one way this key could archive a row the person was not
   * looking at. With nothing anchored the key does nothing at all — a
   * destructive-looking action with an ambiguous target must miss rather than
   * guess, and the ten-second Undo is a safety net, not a licence.
   */
  archiveTask?: (taskId: string) => void;
}

export function hubShortcutKeydown(deps: HubShortcutDeps): (ev: KeyboardEvent) => void {
  const { state } = deps;
  return (ev) => {
    if (typingInPath(eventPath(ev))) return;
    if (ev.key === '?') {
      deps.helpEl().classList.toggle('hidden');
      return;
    }
    // Gmail's compose key. Before the row shortcuts, and before the
    // rows-are-empty bail below it — capture has to work on a board with
    // nothing on it, which is exactly when it is needed most.
    if (ev.key === 'c') {
      const box = document.querySelector<HTMLTextAreaElement>('.hub-quick-input');
      if (box) {
        box.focus();
        ev.preventDefault();
      }
      return;
    }
    if (ev.key === 'Escape') {
      deps.helpEl().classList.add('hidden');
      if (state.detailTaskId) deps.closeDetail();
      return;
    }
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.hub-task-row'));
    if (rows.length === 0) return;
    const focusedIdx = rows.findIndex((r) => r === document.activeElement);
    // Opening a task detail moves focus INTO the panel (deliberately — the
    // Space hold-to-talk needs a focus target there), which used to leave
    // every row shortcut anchored on nothing: j restarted from the top row
    // and o/s/a went dead in exactly the state a keyboard user is in right
    // after opening a task. When the panel holds focus, anchor on the open
    // task's row instead. Scoped to the panel so an unrelated focus (the
    // settings button, say) does not silently act on a row nobody is on.
    let anchor = focusedIdx;
    if (anchor < 0 && state.detailTaskId && document.activeElement?.closest('.hub-detail-panel')) {
      anchor = rows.findIndex((r) => r.dataset.taskId === state.detailTaskId);
    }
    if (ev.key === 'j' || ev.key === 'k') {
      const next = ev.key === 'j' ? Math.min(rows.length - 1, anchor + 1) : Math.max(0, anchor - 1);
      rows[next]?.focus();
      ev.preventDefault();
    } else if (
      (ev.key === 'o' || ev.key === 's' || ev.key === 'a' || ev.key === 'e') &&
      anchor >= 0
    ) {
      const taskId = rows[anchor]?.dataset.taskId;
      const task = taskId ? state.tasks.get(taskId) : undefined;
      if (!task) return;
      if (ev.key === 'o') {
        deps.openDetail(task.id);
      } else if (ev.key === 'e') {
        // No confirm. The row leaves and a ten-second toast offers Undo —
        // the same trade Gmail makes, and the one the design thread asked
        // for: a secondary action must not cost a dialog.
        if (!deps.archiveTask) return;
        deps.archiveTask(task.id);
      } else if (ev.key === 'a') {
        // Focus the picker rather than choosing for them — for the same
        // reason `s` does below, and because there is no longer an "other
        // end" to flip to: a workspace can hold any number of agents.
        rows[anchor]?.querySelector<HTMLSelectElement>('.hub-row-assignee')?.focus();
      } else {
        // Focus the row's dropdown rather than picking a status for them —
        // the keyboard path must not re-introduce the linear assumption the
        // dropdown exists to remove.
        rows[anchor]?.querySelector<HTMLSelectElement>('.hub-status-select')?.focus();
      }
      ev.preventDefault();
    }
  };
}
