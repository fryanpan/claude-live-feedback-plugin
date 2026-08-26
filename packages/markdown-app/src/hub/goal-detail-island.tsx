/**
 * The goal detail panel — the band a reader opens to see what the goal is for,
 * declare it done or argue about it — as a Preact island.
 *
 * `renderGoalDetail` rebuilt the whole panel with `replaceChildren()` on every
 * repaint, and the board repaints on every SSE event. Everything the panel was
 * HOLDING died with each rebuild, so each rescue had to be hand-built against
 * the one-line window either side of the swap:
 *
 *   - `keepFields` / `restoreFields` snapshotted a half-typed rename out of the
 *     doomed DOM and wrote it back into the fresh one, caret and all;
 *   - `keptBodySlot` found the live description editor's node, and the renderer
 *     then patched AROUND it — inserting `before` above it and appending
 *     `after` below — because even MOVING that node detaches a ProseMirror view
 *     from the document and drops the caret;
 *   - a `title.click()` at the very end reopened a rename the repaint had just
 *     closed, so `restoreFields` had somewhere to put the draft back.
 *
 * All three are gone. `GoalDetailPanel` is keyed on the goal's id, so a repaint
 * of the SAME goal reuses the instance and its DOM: the title survives because
 * it survives, and the slot is simply never rebuilt. Moving to another goal
 * changes the key, which unmounts the panel — so the next one opens with an
 * empty box and nothing of its predecessor, which is the other half of the
 * guarantee.
 *
 * The bridge is one-directional, as in the board, task-detail, Home-review,
 * presence and walkthrough islands: `renderDetail` in hub-app still owns the
 * fetches and the projection and writes them into `goalDetailData`; the island
 * only reads. The HANDLERS ride the signal rather than being bound at mount,
 * for the walkthrough's reason — they close over the section and the clock this
 * paint resolved.
 *
 * Two kinds of node are deliberately not Preact's children, for the same reason
 * they are not in the task panel: an element with no vnode children is diffed
 * against nothing, so Preact never reaches inside it.
 *
 *   - the title `<h2>` — `wireInPlaceTitle` swaps its text for an `<input>`
 *     mid-rename;
 *   - the description slot — the live Tiptap editor mounts INTO it.
 *
 * What this panel deliberately does NOT have, and the task panel does: tabs, a
 * review queue, a transition history, a share or full-screen control. A goal
 * has no transitions worth a second tab, so its conversation sits directly
 * under the description where a reader on a short screen reaches it by
 * scrolling rather than by finding a control.
 */
import { signal } from '@preact/signals';
import { type RefObject, render } from 'preact';
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Discussion, useFill } from './detail-parts.tsx';
import {
  type BoardSection,
  GOAL_STATUS_ORDER,
  type TaskStatus,
  statusLabel,
  statusOptions,
} from './hub-model.ts';
import {
  BODY_LIVE_CLASS,
  type GoalDetailHandlers,
  type TaskDiscussion,
  bodySlot,
  wireInPlaceTitle,
} from './hub-render.ts';

export interface GoalDetailView {
  /** The band on screen, or null for "nothing is open". */
  section: BoardSection | null;
  discussion?: TaskDiscussion;
  handlers: GoalDetailHandlers;
}

const IDLE_HANDLERS: GoalDetailHandlers = {
  onClose: () => {},
  onTitleCommit: () => {},
  onStatusSet: () => {},
};

export const goalDetailData = signal<GoalDetailView>({
  section: null,
  handlers: IDLE_HANDLERS,
});

/** One `<dt>/<dd>` pair. Built here rather than as JSX so the fields row can go
 *  through `useFill` — it holds no state, so it is cheapest rebuilt. */
function fieldCell(key: string, value: string): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'hub-detail-field';
  const dt = document.createElement('dt');
  dt.className = 'hub-detail-field-k';
  dt.textContent = key;
  const dd = document.createElement('dd');
  dd.className = 'hub-detail-field-v';
  dd.textContent = value;
  wrap.append(dt, dd);
  return wrap;
}

function GoalDetailPanel(props: {
  host: HTMLElement;
  section: BoardSection;
  discussion?: TaskDiscussion;
  handlers: GoalDetailHandlers;
}) {
  const { section, discussion, handlers } = props;
  const now = handlers.now ?? Date.now();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const fieldsRef = useRef<HTMLDListElement | null>(null);
  const slotRef = useRef<HTMLDivElement | null>(null);

  // What the title needs at the moment it FIRES, rather than at the moment it
  // was wired — the rename is wired once and outlives every paint.
  const latest = useRef({ section, handlers });
  latest.current = { section, handlers };

  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    wireInPlaceTitle(
      el,
      () => latest.current.section.title,
      (v) => latest.current.handlers.onTitleCommit(latest.current.section.id, v),
    );
  }, []);
  useLayoutEffect(() => {
    const el = titleRef.current;
    // Not while the reader is renaming: writing the stored title over the input
    // would delete what they are typing.
    if (el && !el.querySelector('input')) el.textContent = section.title;
  });

  // The fields row: status, owner, and a due date when there is one. No `Tasks`
  // breakdown — *"how many tasks are in triage/todo/in-progress/done is just
  // not useful information"* (Bryan, 2026-08-24, reviewing the live panel). The
  // band header carries the count where it answers "how big is this band" while
  // you are scanning; repeated inside the goal you already opened it answered
  // nothing and cost a row of a panel whose scarce axis is height.
  useFill(fieldsRef as RefObject<HTMLElement>, () => {
    const cells: HTMLElement[] = [];

    const statusCtl = document.createElement('span');
    statusCtl.className = 'hub-detail-statusctl';
    const status = document.createElement('select');
    status.className = 'hub-detail-select hub-detail-status hub-goal-detail-status';
    // GOAL_STATUS_ORDER, not TASK_STATUS_ORDER: a goal is never filed unvetted,
    // so triage is not one of the states this control may declare.
    for (const s of statusOptions(section.status ?? 'todo', GOAL_STATUS_ORDER)) {
      const opt = document.createElement('option');
      opt.value = s;
      opt.textContent = statusLabel(s);
      // An undecorated section (an older server's projection) claims nothing;
      // the select then shows "To do" — the value a fresh row starts on.
      opt.selected = s === (section.status ?? 'todo');
      status.append(opt);
    }
    status.setAttribute('aria-label', 'Goal status — pick to declare a new one');
    status.addEventListener('change', () => {
      handlers.onStatusSet(section.id, status.value as TaskStatus);
    });
    statusCtl.append(status);

    const statusWrap = document.createElement('div');
    statusWrap.className = 'hub-detail-field';
    const dt = document.createElement('dt');
    dt.className = 'hub-detail-field-k';
    dt.textContent = 'Status';
    const dd = document.createElement('dd');
    dd.className = 'hub-detail-field-v';
    dd.append(statusCtl);
    statusWrap.append(dt, dd);
    cells.push(statusWrap);

    // The vacancy is stated rather than hidden — an unowned goal is a fact a
    // reader acts on. No picker yet: no verb sets a goal's owner.
    cells.push(fieldCell('Owner', section.assignee ?? 'Nobody yet'));
    if (section.dueAt !== undefined) {
      cells.push(
        fieldCell(
          'Due',
          `due ${new Date(section.dueAt).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          })}`,
        ),
      );
    }
    return cells;
  });

  // The description slot is the one node a repaint must never rebuild. Preact
  // owns the element and none of its children, and the fallback below only runs
  // while no editor has claimed it — an un-mounted slot must follow the
  // projection like everything else in the panel.
  useLayoutEffect(() => {
    const el = slotRef.current;
    if (!el || el.classList.contains(BODY_LIVE_CLASS)) return;
    el.replaceChildren(...bodySlot(section).childNodes);
  });

  // Take the focus on OPEN only — this effect runs once per mount, and a mount
  // is a new goal. A repaint that focused the panel would pull the caret out of
  // the composer every time a peer's comment landed.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (panel && typeof panel.focus === 'function') panel.focus({ preventScroll: true });
  }, []);

  // The slot this render decided on, handed to whatever mounts the live editor.
  // Idempotent for an unchanged pair, so the repaints that arrive while
  // somebody is typing cost nothing. It lives here rather than after the
  // loader's call because a signal write does not paint synchronously: the
  // loader cannot know when the slot exists.
  useLayoutEffect(() => {
    handlers.onBodySlot?.(section, slotRef.current);
  });

  const doneNote =
    section.status === 'done'
      ? section.doneBy
        ? `Declared by ${section.doneBy.name}${
            section.doneAt !== undefined
              ? `, ${new Date(section.doneAt).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                })}`
              : ''
          }`
        : 'Declared done'
      : null;

  return (
    <div
      ref={panelRef}
      class="hub-detail-panel"
      // biome-ignore lint/a11y/useSemanticElements: a real <dialog> would own
      // its own top-layer, backdrop and dismissal, and this panel is painted
      // inside `.hub-detail`'s backdrop by an app that opens and closes it from
      // board state. The role is the accurate description of what it is.
      role="dialog"
      aria-modal="true"
      // Focusable as a container: the keyboard follows the dialog, and Escape
      // has somewhere to land without a global listener.
      tabIndex={-1}
      data-goal-id={section.id}
      onKeyDown={(ev) => {
        if (ev.key === 'Escape') handlers.onClose();
      }}
    >
      <div class="hub-detail-head">
        <div>
          <div class="hub-detail-kind-line">
            <span class="hub-detail-kind">Goal</span>
            <span class="hub-detail-id">{section.id}</span>
          </div>
          {/* biome-ignore lint/a11y/useHeadingContent: deliberately childless.
              `wireInPlaceTitle` swaps the text for an <input> and back, so the
              heading's content is imperative — a vnode child here would make
              every repaint an instruction to throw a half-typed rename away. */}
          <h2
            ref={titleRef}
            class="hub-detail-title"
            // It IS interactive — Enter opens the rename, exactly as the board
            // row's title does.
            // biome-ignore lint/a11y/noNoninteractiveTabindex: see above
            tabIndex={0}
            title="Click or press Enter to rename"
          />
        </div>
        <div class="hub-detail-head-actions">
          <button
            type="button"
            class="hub-btn hub-icon-btn hub-detail-close"
            title="Close goal detail"
            aria-label="Close goal detail"
            onClick={() => handlers.onClose()}
          >
            ✕
          </button>
        </div>
      </div>

      <div class="hub-detail-body">
        <dl ref={fieldsRef} class="hub-detail-fields" />
        {/* The attribution the row can only whisper (its tooltip), said plainly
            where there is room: a done goal is somebody's claim, and the claim
            names its author. No open-children advisory beside it — the server
            has always accepted a done declaration over open children, so it
            spent two lines restating a rule nothing enforced. */}
        {doneNote !== null && <p class="hub-goal-done-note">{doneNote}</p>}
      </div>

      {/* The prose the whole ticket is about: *"the most important object on
          the board is the only one you cannot explain"*. Drawn unconditionally,
          including for a goal nobody has described — the empty state is an
          invitation, and more to the point the slot has to EXIST for the editor
          to mount on. */}
      <h3 class="hub-detail-subhead hub-detail-body-head">Description</h3>
      <div ref={slotRef} class="hub-detail-body-slot" data-task-id={section.id} />
      {/* A secondary way in, not the way to edit. Only once the projection has
          told us the address: a link built from a guessed docId would 404 on
          exactly the older servers that omit it. */}
      {section.bodyDocId !== undefined && (
        <p class="hub-detail-body-link">
          <a href={`/review/${encodeURIComponent(section.bodyDocId)}`}>Open in the full editor</a>
        </p>
      )}

      {/* *"A single comment thread with review item support — so a decision
          about a goal has somewhere to live."* Never drawn without a handler to
          deliver from: the panel does not show a composer it cannot post. */}
      {discussion !== undefined && handlers.onComment !== undefined && (
        <>
          <h3 class="hub-detail-subhead">Comments</h3>
          <Discussion
            rowId={section.id}
            discussion={discussion}
            onComment={(text, threadId) => handlers.onComment?.(section.id, text, threadId)}
            {...(handlers.focusThreadId !== undefined
              ? { focusThreadId: handlers.focusThreadId }
              : {})}
            now={now}
          />
        </>
      )}
    </div>
  );
}

/**
 * The panel, or nothing at all.
 *
 * The container classes live on the HOST the shell built rather than on
 * anything the island renders — the host is what the CSS targets, and a class
 * is not a child, so this writes nothing Preact believes it owns.
 * `hub-detail-open` marks `<body>` rather than being inferred with `:has()`,
 * because the board and the panel are siblings under different subtrees.
 */
function GoalDetail(props: { host: HTMLElement }) {
  const { section, discussion, handlers } = goalDetailData.value;
  const { host } = props;
  // Backlog is a bucket, not a goal: nothing to declare and nothing to rename,
  // so there is deliberately no panel for it — the same refusal its row gives.
  const shown = section !== null && !section.isChores;
  useLayoutEffect(() => {
    host.classList.toggle('hidden', !shown);
    if (shown) {
      document.body.classList.add('hub-detail-open');
      return;
    }
    // The marker says "an overlay is open", and the TASK panel is the other
    // one. Dropping the class unconditionally would take it straight back off a
    // task panel that had just put it on.
    if (host.ownerDocument.querySelector('.hub-detail:not(.hidden)') === null) {
      document.body.classList.remove('hub-detail-open');
    }
  }, [host, shown]);
  // The editor host is told the slot is gone before the render that removes it
  // could leave it holding a detached node.
  useLayoutEffect(() => {
    if (!shown) handlers.onBodySlot?.(null, null);
  }, [shown, handlers]);
  if (!shown || section === null) return null;
  // Keyed on the goal id — the one id that survives a re-fetch and a reorder.
  return (
    <GoalDetailPanel
      key={section.id}
      host={host}
      section={section}
      discussion={discussion}
      handlers={handlers}
    />
  );
}

/**
 * Mounts the panel into a wrapper it appends to `host` (`#hub-goal-detail`);
 * returns the disposer. The island contract: the wrapper — not the host — is
 * Preact's container, disposal is `render(null, el)`, and no vanilla code may
 * `replaceChildren` a container holding the live island.
 *
 * The backdrop tap is wired here rather than per paint: it is a fact about the
 * container, and the old renderer added a fresh listener every time it built a
 * panel from scratch.
 */
export function mountGoalDetailIsland(host: HTMLElement): () => void {
  const el = document.createElement('div');
  el.setAttribute('data-preact-island', 'goal-detail');
  host.appendChild(el);
  const onBackdrop = (ev: Event): void => {
    if (ev.target === host) goalDetailData.value.handlers.onClose();
  };
  host.addEventListener('click', onBackdrop);
  render(<GoalDetail host={host} />, el);
  return () => {
    host.removeEventListener('click', onBackdrop);
    render(null, el);
    el.remove();
  };
}
