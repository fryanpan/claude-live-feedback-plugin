/**
 * The task description, edited in place.
 *
 * A task's body is not a field on the row — it is a live Yjs room
 * (`task:<taskId>`), the same one an agent rewrites through
 * `set_doc_content` / `find_and_replace` and the same one the full review
 * surface opens. This mounts the review surface's own editor over that room
 * inside the detail panel, so a person's typing and an agent's rewrite merge
 * as CRDT edits rather than one overwriting the other, and the description
 * is edited where it is read instead of on a second page.
 *
 * The editor is loaded lazily: the hub bundle is a board, and the whole
 * Tiptap/ProseMirror stack would triple it for a panel most page loads never
 * open. `loadEditor` is a dynamic import at the call site, so it becomes its
 * own chunk.
 *
 * Lifecycle is keyed on (task, slot). The panel repaints on every ydoc change
 * and keeps the slot element in place for a live description (the detail
 * islands render it childless, so Preact never reaches inside it and never
 * replaces it) — so a repaint with the same task and the
 * same slot is a no-op here, and only a different task, a rebuilt slot, or a
 * closed panel tears the editor down. That is what lets a reader keep typing
 * through their own snapshot landing in the projection.
 */
import type { FeedbackClient } from '@feedback/core';
import type { AnyExtension } from '@tiptap/core';
import type { CreateEditorOpts, EditorHandle } from '../editor.ts';
import { BODY_LIVE_CLASS } from './hub-render.ts';

export interface TaskBodyTarget {
  id: string;
  bodyDocId: string;
  /** What the empty box asks for. A GOAL is not a task, and the panel that
   *  the goal-parity work made worth opening was inviting people to
   *  "describe the task". Defaults to the task wording. */
  placeholder?: string;
}

/** What the lazily-loaded chunk hands back. Types only — the real module is
 *  `../editor.ts` plus Tiptap's Placeholder, and none of it is imported here
 *  so that none of it lands in the hub bundle. */
export interface EditorModule {
  createEditor: (opts: CreateEditorOpts) => EditorHandle;
  /** The empty description says what to write rather than showing a blank
   *  box. Optional so a test double need not carry Tiptap. */
  placeholder?: (text: string) => AnyExtension;
}

export interface TaskBodyEditorDeps {
  connect: (docId: string) => FeedbackClient;
  loadEditor: () => Promise<EditorModule>;
  user: { name: string; color: string };
  /**
   * Whether the server accepts writes from this browser. Absent means yes.
   *
   * A description is PROSE OVER THE YJS SOCKET, like a doc's body: when the
   * server refuses this browser it drops the update frames and answers
   * nothing, so an editable box here would take the typing, show it, and lose
   * every word on reload with no 401 anywhere to notice. So the editor is
   * built read-only rather than built and locked — see `CreateEditorOpts.editable`.
   */
  canWrite?: boolean;
  /** Reached the room, mounted the editor. Test seam; the app has no use for it. */
  onMounted?: (taskId: string) => void;
}

/** What the reader is told when the editor's chunk cannot be fetched. The
 *  link below the slot still reaches the same room in the full surface. */
export const LOAD_FAILED_TEXT =
  'The editor could not load here — open the full editor to change this.';

export interface TaskBodyEditorHost {
  /** Called after every panel repaint with the task on screen (or null) and
   *  the slot the panel is showing for it. Idempotent for the same pair. */
  sync(task: TaskBodyTarget | null, slot: HTMLElement | null): void;
  /** Whether an editor is currently mounted for this task. */
  isLive(taskId: string): boolean;
  destroy(): void;
}

interface Mount {
  taskId: string;
  slot: HTMLElement;
  client: FeedbackClient;
  handle: EditorHandle | null;
  /** Captured at claim time: the chunk lands a tick later, and by then the
   *  target that asked for this wording may be gone. */
  placeholder?: string;
}

export const PLACEHOLDER_TEXT = 'Describe the task — what someone can do once it is done, and why.';
/**
 * The goal's own invitation, and deliberately SHORTER than the task's.
 *
 * Tiptap floats the placeholder with `height: 0`, so it paints outside the
 * slot rather than growing it: at 430px the task wording wraps to a second
 * line and strikes straight through "Open in the full editor" beneath it
 * (measured: the slot clips at 41px while its content runs to 58px). One
 * line at the narrow tier is therefore a layout requirement here, not a
 * style preference — check it with a measurement, not by eye.
 */
export const GOAL_PLACEHOLDER_TEXT = 'Describe this goal — what changes when it is met.';

export function createTaskBodyEditorHost(deps: TaskBodyEditorDeps): TaskBodyEditorHost {
  let mount: Mount | null = null;
  // One failed chunk fetch retires the feature for this page load. Without it
  // every repaint would rebuild the slot, find it un-mounted, and try the
  // import again — a retry loop nobody asked for, one websocket per turn.
  let loadFailed = false;

  const teardown = () => {
    if (!mount) return;
    const m = mount;
    mount = null;
    m.handle?.destroy();
    m.client.close();
    m.slot.classList.remove(BODY_LIVE_CLASS);
  };

  const sync = (task: TaskBodyTarget | null, slot: HTMLElement | null) => {
    if (mount && (!task || !slot || mount.taskId !== task.id || mount.slot !== slot)) teardown();
    if (!task || !slot || mount || loadFailed) return;

    // Claimed SYNCHRONOUSLY, before the chunk is even asked for. The panel
    // repaints several times in the first moment a task is opened (the
    // discussion fetch alone is two), and a slot that only became live once
    // the editor mounted would be rebuilt under each of those — so the mount
    // in flight would be torn down and re-made, with a fresh websocket each
    // time, until the repaints happened to stop.
    //
    // The cost is that the fallback text stops following the projection for
    // as long as the load takes. That is the right way round: it is corrected
    // the moment the editor paints the room, which is the same text or newer.
    slot.classList.add(BODY_LIVE_CLASS);
    const client = deps.connect(task.bodyDocId);
    const m: Mount = { taskId: task.id, slot, client, handle: null, placeholder: task.placeholder };
    mount = m;
    void deps
      .loadEditor()
      .then((mod) => {
        // The reader may have closed the panel or moved to another task while
        // the chunk was in flight; a late mount would put an editor for the
        // wrong task into a slot that no longer shows it.
        if (mount !== m) return;
        slot.replaceChildren();
        const extra = mod.placeholder ? [mod.placeholder(m.placeholder ?? PLACEHOLDER_TEXT)] : [];
        m.handle = mod.createEditor({
          parent: slot,
          ydoc: client.ydoc,
          awareness: client.awareness,
          user: deps.user,
          extraExtensions: extra,
          editable: deps.canWrite !== false,
        });
        deps.onMounted?.(task.id);
      })
      .catch(() => {
        loadFailed = true;
        if (mount !== m) return;
        mount = null;
        client.close();
        // Hand the slot back to the repaint — the description it holds is the
        // projection's and must go on tracking it — but say once, here, why
        // it cannot be typed in. The note lives until the next repaint; the
        // link below the slot is the durable way through.
        slot.classList.remove(BODY_LIVE_CLASS);
        const note = document.createElement('p');
        note.className = 'hub-detail-body-more';
        note.textContent = LOAD_FAILED_TEXT;
        slot.append(note);
      });
  };

  return {
    sync,
    isLive: (taskId) => mount?.taskId === taskId && mount.handle !== null,
    destroy: teardown,
  };
}
