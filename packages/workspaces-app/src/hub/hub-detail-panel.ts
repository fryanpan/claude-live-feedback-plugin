/**
 * The detail panel: one overlay, two things it can be showing.
 *
 * One responsibility, and the reason a task panel and a goal panel are one
 * module is that they are one container. `renderDetail` is the function that
 * decides which of the two is up — task wins when both ids are somehow set —
 * and the handover between them is the part no separate pair of files could
 * keep true: opening a goal over a ticket closes the task panel with
 * `handOverEditor`, because ONE body editor is mounted at a time and the goal
 * mounts its slot synchronously while the task's close lands a microtask
 * later. Split apart, that hand-off would be a comment in two files.
 *
 * Everything else here exists to serve that one render:
 *
 * - `bodyEditor` is the single live-room editor host both panels drive, which
 *   is why it is built here rather than in the entry. "A body editor left
 *   mounted by the last open row" is impossible by construction rather than
 *   something a branch has to remember to tear down.
 * - `syncReadTracker` is the panel's whole reading-capture lifecycle. A ticket
 *   is a PANEL, not a page: there is no load to hang a tracker off and no
 *   unload to flush it, so it is keyed on the task id and called from every
 *   path that changes what is showing.
 * - the four `let`s below are how a repaint is told apart from an open and a
 *   close. `renderDetail` runs on every board event and clock tick, so
 *   "focus the opener on close" and "fetch the audit rows once per open" need
 *   a memory of what the panel was last showing.
 *
 * `HubDetailDeps` is long — longer than any other region's — and that is the
 * honest shape of this panel rather than a failure of the cut: the panel is
 * where a ticket's every verb is reachable, so its dependency list is the
 * board's verb list plus the projections the panel reads. What the list buys
 * is that the panel can no longer reach anything NOT on it.
 */
import type { FeedbackClient, User } from '@feedback/core';
import { startReadingTracker } from '../reading-tracker.ts';
import { goalDetailData } from './goal-detail-island.tsx';
import { type HubActions, type HubState, fetchJson, send, showToast } from './hub-actions.ts';
import {
  type BoardSection,
  type HubTask,
  bandOfGoal,
  boardBlockers,
  boardCalibration,
  boardSections,
  goalBandIds,
  goalLabel,
  goalSection,
} from './hub-board-model.ts';
import type { TaskDiscussion } from './hub-detail-render.ts';
import type { HubDiscussion } from './hub-discussion.ts';
import type { HubReviewController } from './hub-review-controller.ts';
import { humanBlockerRows, panelAsks } from './hub-review-model.ts';
import {
  type TaskAskKind,
  type TaskAskState,
  taskAskRequestPath,
  taskAskStatePath,
} from './task-asks.ts';
import { GOAL_PLACEHOLDER_TEXT, createTaskBodyEditorHost } from './task-body-editor.ts';
import { taskDetailData } from './task-detail-island.tsx';

/**
 * A claim the boot URL made that the projection has not confirmed yet.
 *
 * `renderDetail` must not clear an unconfirmed goal the way it clears one that
 * genuinely left the board, and `?thread=` gets exactly one look at a loaded
 * discussion before it is called stale. `bootHub` owns both — it is the
 * deadline at the bottom of boot that finally decides — so the panel reads
 * them through here rather than holding them.
 */
export interface BootClaims {
  /** The boot URL's goal id, until the projection confirms or denies it. */
  goal(): string | null;
  /** The boot URL aimed at a thread and has not been checked yet. */
  threadPending(): boolean;
  /** It has now been checked. One-shot, whatever the answer was. */
  clearThread(): void;
}

/** Everything the panel needs from `bootHub`, and nothing else. */
export interface HubDetailDeps {
  /** The board's one projection. LIVE — the panel reads the aim fields and
   *  the discussion, and writes them on close and on a stale aim. */
  state: HubState;
  /** Who is reading. Stamped on the panel's own writes and used for the
   *  "Answered by you" record. */
  user: User;
  /** The board a source-doc link is addressed within. */
  workspaceId: string;
  /** The page's document — the panel's host, and where focus came from. */
  document: Document;
  /** The shareable address of one task, and of one band. `bootHub` owns the
   *  shape — the canonical bare path, whatever nav page it is copied from. */
  taskUrl(taskId: string): string;
  goalUrl(goalId: string): string;
  /** Every REST write a panel control ends in. */
  actions: HubActions;
  /** Answering, asking back and undoing — the review queue's verbs, which the
   *  panel surfaces for the open ticket's own rows. */
  review: HubReviewController;
  /** A row's comments, and the goal-room derivation both panels share. */
  discussion: HubDiscussion;
  /** The projection's rows, for the blocker derivations. */
  taskList(): HubTask[];
  /** A task's title, for a blocker chip. */
  titleOf(taskId: string): string;
  /** Everyone a task can be handed to besides a person. */
  knownAgentIds(): string[];
  /** Fetch the workspace's audit rows — the Activity tab's, one per open. */
  loadEvents(): Promise<void>;
  /** Write the address for what the panel is showing. */
  syncBoardUrl(): void;
  /** Open the task's body room. `bootHub` owns the URL shape. */
  connectMarkdown(docId: string): FeedbackClient;
  /** Whether this reader may write at all — the description box is never live
   *  before the answer, and never live after a "no". */
  canWrite: boolean;
  /** The boot URL's unconfirmed claims. */
  boot: BootClaims;
}

/** What `bootHub` keeps: the render, and the one thing that aims it. */
export interface HubDetailPanel {
  renderDetail(): void;
  /** Aim the next render's title at a row, so a task filed empty opens with
   *  the cursor in its name — `createHubActions`'s `focusTitle`. */
  setFocusTitle(taskId: string): void;
}

export function createHubDetailPanel(deps: HubDetailDeps): HubDetailPanel {
  const {
    state,
    user,
    workspaceId,
    document,
    taskUrl,
    goalUrl,
    taskList,
    titleOf,
    knownAgentIds,
    loadEvents,
    syncBoardUrl,
    connectMarkdown,
    canWrite,
    boot,
  } = deps;
  const author = { id: user.id, name: user.name, kind: user.kind, color: user.color };
  // The three dependency bundles, destructured into the names the panel's own
  // lines already used: every handler below reads exactly as it did when these
  // were declarations in `main()`'s closure.
  const { goalBodyDocId, loadDiscussion, postRowComment } = deps.discussion;
  const {
    transitionTask,
    renameTask,
    assignTask,
    setTaskGoal,
    setTaskDue,
    archiveTask,
    restoreTask,
    addRelatedLink,
    removeRelatedLink,
    retitleGoal,
    transitionGoal,
    setGoalDue,
    goalCascadeCount,
    archiveGoal,
    restoreGoal,
  } = deps.actions;
  const {
    answerTaskDecision,
    answerPanelThreadItem,
    askOnPanelItem,
    undoTaskAnswer,
    releaseHeldReviewItem,
    undoThreadAnswer,
    commentOnActivity,
    replyOnActivity,
  } = deps.review;

  // ── The description, edited in place ────────────────────────────────────
  //
  // A second room, opened per task rather than per board: the task's body is
  // `task:<taskId>`, the same room an agent rewrites through `set_doc_content`
  // and the same one `/review/task:<id>` opens. Mounting the review surface's
  // editor over it is what makes the reader's typing and an agent's rewrite
  // merge as CRDT edits instead of one overwriting the other.
  //
  // The editor itself is behind a dynamic import so the board's bundle stays a
  // board — see task-body-editor-chunk.ts.
  const bodyEditor = createTaskBodyEditorHost({
    connect: (docId) => connectMarkdown(docId),
    loadEditor: () => import('./task-body-editor-chunk.ts'),
    user: { name: user.name, color: user.color },
    // Already awaited in boot — the description box is never live before the
    // answer, and never live after a "no".
    canWrite,
  });

  /** The tickets one task is waiting on, as Related Links entries. Reads the
   *  board's own derivation so a panel can never disagree with the ring on
   *  the row; an id naming a row this board has never seen is skipped by
   *  `boardBlockers` and so is absent here too. */
  const openBlockersOf = (task: HubTask): { taskId: string; title: string }[] =>
    (boardBlockers(taskList()).get(task.id) ?? []).map((id) => ({
      taskId: id,
      title: titleOf(id),
    }));

  /** The row "New task" just filed: the panel opens it with the title in
   *  rename. Cleared the moment any other task is on screen. */
  let focusTitleTaskId: string | null = null;
  function setFocusTitle(taskId: string): void {
    focusTitleTaskId = taskId;
  }

  /**
   * The element that opened the panel, so closing it puts the keyboard back
   * where it was.
   *
   * The panel takes focus when it opens (see `renderTaskDetail` — that is what
   * makes hold-Space work inside it), so without this, Escape would drop a
   * keyboard reader at the top of the document and the j/k walk they were in
   * the middle of would restart from row one.
   */
  let detailOpener: HTMLElement | null = null;
  /** Which task the panel is CURRENTLY showing, so open and close are
   *  distinguishable from a repaint. */
  let renderedDetailId: string | null = null;
  /** Which task the panel has already fetched audit rows for — one fetch per
   *  open, and the guard that keeps the fetch's own re-render from looping. */
  let detailEventsFor: string | null = null;
  /** Which task the panel has already read the two ask stamps for, and what
   *  they said. Same one-fetch-per-open shape as `detailEventsFor`: the read
   *  re-renders, and the id guard is what stops that re-render coming back
   *  round here. Undefined until the read lands, which the controls render as
   *  "not yet asked" — see `TaskAskState`. */
  let detailAsksFor: string | null = null;
  let detailAsks: TaskAskState | undefined;
  /** Which GOAL the shared container is currently showing, so open, repaint
   *  and close are distinguishable — the goal panel's `renderedDetailId`. */
  let renderedGoalId: string | null = null;

  /**
   * Close the task panel — the island's own "no task" state.
   *
   * `handOverEditor` is for the one case where something ELSE is taking the
   * body editor in the same turn: the goal panel mounts it synchronously,
   * while this write's effect lands a microtask later, so without the hand-off
   * the closing task panel would report a null slot and unmount the goal's
   * editor from under it.
   */
  function closeTaskPanel(handOverEditor = false): void {
    const handlers = { ...taskDetailData.value.handlers };
    // `undefined` rather than `delete`: the island reaches this through
    // `handlers.onBodySlot?.(…)`, so an absent key and an undefined one are
    // the same absence to every reader of it.
    if (handOverEditor) handlers.onBodySlot = undefined;
    taskDetailData.value = { task: null, handlers };
  }

  /**
   * Reading-time capture for the open ticket — the same tracker the markdown,
   * redline and code surfaces mount, pointed at the task's body room.
   *
   * A ticket is a PANEL rather than a page, so there is no load to hang a
   * tracker off and no unload to flush it: this is the lifecycle. It is keyed
   * on the task id and called from every path that changes what the panel
   * shows, so a repaint — and `renderDetail` runs on every board event and
   * clock tick — is a no-op, while an open, a close, and a tap straight from
   * one row to another each do the right thing. The disposer flushes any
   * in-flight session, so closing a ticket banks its read rather than losing
   * it.
   */
  let readTracker: { taskId: string; stop: () => void } | null = null;
  function syncReadTracker(taskId: string | null, bodyDocId?: string): void {
    if (readTracker?.taskId === taskId) return;
    readTracker?.stop();
    readTracker = null;
    if (!taskId || !bodyDocId) return;
    const host = document.getElementById('hub-detail');
    if (!host) return;
    readTracker = {
      taskId,
      stop: startReadingTracker({
        docId: bodyDocId,
        user,
        // `.hub-detail-panel` is the element with `overflow: auto`, so it is
        // what scroll depth means here. A getter, not the element: this runs
        // during the signal write that opens the panel, and the panel is not
        // painted until a microtask later.
        scrollEl: () => host.querySelector<HTMLElement>('.hub-detail-panel'),
        // Scoped to the panel: the board is still behind it, and scrolling
        // the rows is not reading the ticket.
        root: host,
      }),
    };
  }

  function renderDetail(): void {
    // Task wins when both ids are somehow set: the deep-link and voice paths
    // set a task id without knowing a goal panel was open, and what they mean
    // is "show me this task".
    if (state.detailTaskId) state.detailGoalId = null;
    if (state.detailGoalId) {
      // Unfiltered on purpose: the panel's counts and advisory are facts
      // about the GOAL ("what would a done declaration leave open"), not
      // about whatever tab or done-window the board happens to be on.
      const section =
        boardSections(state.info?.goals ?? [], taskList(), {
          tab: 'all',
          userName: user.name,
          doneWindow: 'all',
          now: Date.now(),
        }).find((s) => s.id === state.detailGoalId) ??
        // An ARCHIVED band is on no board and so in no section — and the panel
        // is exactly where its Restore lives, reached from the restore list or
        // from a link somebody sent last week. `goalSection` is the lookup that
        // does not apply "off the board", the way `state.tasks` is for a task.
        goalSection(state.info?.goals ?? [], state.detailGoalId);
      if (section && !section.isChores) {
        if (renderedGoalId === null && renderedDetailId === null) {
          const active = document.activeElement;
          detailOpener = active instanceof HTMLElement && active !== document.body ? active : null;
        }
        // The goal's comments, fetched the same lazy way a task's are and
        // guarded by the same id — one fetch per open, and the guard is what
        // stops the fetch's own re-render from looping back through here.
        if (state.discussionTaskId !== section.id) {
          void loadDiscussion({ id: section.id, bodyDocId: goalBodyDocId(section) });
        }
        // Only a discussion that belongs to the goal on screen: an in-flight
        // load for a row the reader has left must not paint under this one.
        const goalDiscussion =
          state.discussionTaskId === section.id ? state.discussion : { loading: true, threads: [] };
        // The task panel closes first: the two share the screen, never the
        // container, so nothing else empties the island's host any more.
        closeTaskPanel(true);
        // A goal opening over a ticket ends the read of that ticket — this is
        // the one close that does not run through the task path below.
        syncReadTracker(null);
        goalDetailData.value = {
          section,
          discussion: goalDiscussion,
          handlers: {
            onClose: () => {
              state.detailGoalId = null;
              renderDetail();
            },
            onTitleCommit: (goalId, title) => void retitleGoal(goalId, title),
            onStatusSet: (goalId, to) => void transitionGoal(goalId, to),
            onDueSet: (goalId, dueAt) => void setGoalDue(goalId, section.title, dueAt),
            onComment: (goalId, text, threadId) =>
              postRowComment({ id: goalId, bodyDocId: goalBodyDocId(section) }, text, threadId),
            // The goal's description is a live room like a task's, so the SAME
            // editor host drives it — one mount at a time, which is what makes
            // "a body editor left mounted by the last open row" impossible
            // rather than something this branch has to remember to tear down.
            // The panel reports its own slot: a signal write does not paint
            // synchronously, so nothing out here can know when the slot exists.
            onBodySlot: (row, slot) =>
              bodyEditor.sync(
                row === null
                  ? null
                  : {
                      id: row.id,
                      bodyDocId: goalBodyDocId(row),
                      placeholder: GOAL_PLACEHOLDER_TEXT,
                    },
                slot,
              ),
            onCopyLink: (s) => void copyGoalLink(s),
            onCascadeCount: (goalId) => goalCascadeCount(goalId),
            onArchive: (s) => void archiveGoal(s),
            onRestore: (s) => void restoreGoal(s),
            workspaceId,
            ...(state.detailThreadId ? { focusThreadId: state.detailThreadId } : {}),
            now: Date.now(),
          },
        };
        // A deep-linked thread aim that the loaded discussion does not hold
        // is gone, not loading — drop it gracefully, once.
        if (state.discussionTaskId === section.id && !goalDiscussion.loading) {
          noteStaleBootThread(goalDiscussion);
        }
        renderedGoalId = section.id;
        renderedDetailId = null;
        detailEventsFor = null;
        syncBoardUrl();
        return;
      }
      // The goal left the board under us (removed from the list, or the
      // projection has not caught up) — fall through to an empty panel. A
      // boot deep link is the second case by construction, so its claim
      // survives until the deadline in main() gives up on it.
      const pendingBootGoal = boot.goal();
      if (state.detailGoalId !== pendingBootGoal) state.detailGoalId = null;
    }
    // Past this point the goal panel is not what is showing, and its container
    // is its own — so it has to be told to close rather than being replaced.
    goalDetailData.value = {
      section: null,
      handlers: { onClose: () => {}, onTitleCommit: () => {}, onStatusSet: () => {} },
    };
    const task = state.detailTaskId ? (state.tasks.get(state.detailTaskId) ?? null) : null;
    // An open-time act for ONE row: a row tap on any other task, or the panel
    // closing, ends it — reopening the same row later must not start a rename.
    if (state.detailTaskId !== focusTitleTaskId) focusTitleTaskId = null;
    if (task && renderedDetailId === null) {
      const active = document.activeElement;
      detailOpener = active instanceof HTMLElement && active !== document.body ? active : null;
    }
    // Fetch here rather than at each of the four places that open the panel
    // (row tap, `o`, deep link, voice navigate) — one of them would be missed
    // otherwise, and the miss looks like a task with no discussion. Safe from
    // recursion: loadDiscussion claims the id before it re-renders.
    if (task && state.discussionTaskId !== task.id) {
      void loadDiscussion(task);
    }
    if (!task) state.discussionTaskId = null;
    // Every way the panel closes — the X, a goal opening over it, the task
    // being archived under it — lands here with no task; the next open
    // starts on Comments unless its opener says otherwise.
    if (!task) state.detailTab = 'comments';
    // The audit rows the Activity tab renders. Fetched on open rather than at
    // boot: a reader who never opens a ticket never needs them, and the
    // workspace Activity VIEW has always fetched them the same lazy way.
    // Guarded by task id, which is also what stops `loadEvents`'s own
    // re-render from coming back round here.
    if (task && detailEventsFor !== task.id) {
      detailEventsFor = task.id;
      void loadEvents();
    }
    if (!task) detailEventsFor = null;
    // Who has already asked this ticket for a plan or a review. Read on open
    // for the same reason the audit rows are — four ways in, and the miss
    // would look like a control offering an ask somebody already made.
    if (task && detailAsksFor !== task.id) {
      detailAsksFor = task.id;
      detailAsks = undefined;
      void loadTaskAsks(task.id);
    }
    if (!task) {
      detailAsksFor = null;
      detailAsks = undefined;
    }
    // Only pass a discussion that belongs to the task on screen. An in-flight
    // load for a task the reader has left must not paint under this one.
    const discussion =
      task && state.discussionTaskId === task.id
        ? state.discussion
        : { loading: true, threads: [] };
    // A deep-linked thread aim that the loaded discussion does not hold is
    // gone, not loading — drop it gracefully, once, leaving the panel open.
    if (task && state.discussionTaskId === task.id && !discussion.loading) {
      noteStaleBootThread(discussion);
    }
    taskDetailData.value = {
      task,
      discussion: task ? discussion : undefined,
      tab: state.detailTab,
      // Learned from the WHOLE board, not from this ticket's band: the panel
      // reports what the estimate was scaled by, and the scaling is a property
      // of everything that has closed. Unfiltered for the same reason the goal
      // rollup is — a correction that moved when the reader changed tabs would
      // be a correction about the reader.
      calibration: task ? boardCalibration(state.info?.goals ?? [], taskList()) : undefined,
      // The band the row renders under, which is the key its correction was
      // filed under. A ticket whose goal id matches no band shows Backlog's
      // arithmetic, exactly as it shows under Backlog on the board.
      calibrationGoal: task
        ? bandOfGoal(goalBandIds(state.info?.goals ?? []), task.goal)
        : undefined,
      handlers: {
        onClose: () => {
          state.detailTaskId = null;
          state.detailTab = 'comments';
          state.detailThreadId = null;
          renderDetail();
        },
        onCopyLink: (t) => void copyTaskLink(t),
        onStatusSet: (t, to) => void transitionTask(t, to),
        onTitleCommit: (t, title) => void renameTask(t, title),
        onAnswer: (t, text, optionId) => answerTaskDecision(t, text, optionId),
        onAnswerThread: (t, item, text, optionId) => answerPanelThreadItem(t, item, text, optionId),
        onAskOnPanelItem: (t, item, question) => askOnPanelItem(t, item, question),
        onUndoAnswer: (t) => undoTaskAnswer(t),
        onReleaseHeld: (t, item) => releaseHeldReviewItem(t, item),
        onUndoThreadAnswer: (t, item) => undoThreadAnswer(t, item),
        // So the answered record can say "Answered by you" for the reader's
        // own answer — the record compares display names, same as answer.by.
        selfName: author.name,
        ...(task ? { focusTitle: focusTitleTaskId === task.id } : {}),
        onAssign: (t, assignee) => void assignTask(t, assignee),
        knownAgentIds: knownAgentIds(),
        // So the Source-doc field links the origin doc at its canonical
        // workspace address rather than the legacy /review/ one.
        workspaceId,
        goalLabel: (id) => goalLabel(state.info?.goals ?? [], id),
        goals: state.info?.goals ?? [],
        onGoalSet: (t, goalId) => void setTaskGoal(t, goalId),
        onDueSet: (t, dueAt) => void setTaskDue(t, dueAt),
        onArchive: (t) => void archiveTask(t),
        onRestore: (t) => void restoreTask(t),
        onComment: (t, text, threadId) => postRowComment(t, text, threadId),
        // The Activity feed takes comments the way the Home pane does — the
        // same two writes, the same thread on the task's doc.
        onActivityComment: (t, phrase, text) => commentOnActivity(t.id, phrase, text),
        onActivityReply: (t, threadId, text) => replyOnActivity(t.id, threadId, text),
        user,
        ...(state.detailThreadId ? { focusThreadId: state.detailThreadId } : {}),
        // This task's rows from the review queue the strip already reads, so
        // the panel says the same thing the row that sent them here said.
        // `panelAsks` owns which rows qualify — by taskId, thread-borne and
        // ticket-borne alike, minus the derived legacy copy of the task's own
        // decision.
        asks: task ? panelAsks(state.reviewItems, task.id) : [],
        // A blocker is task state (design point 5): when the open task is a
        // person's own open work other tasks wait on, the panel — and only
        // the panel — says so, via the amber blocked note.
        blocked: task ? humanBlockerRows(taskList()).find((r) => r.task.id === task.id) : undefined,
        // The other direction: the tickets THIS task is waiting on, resolved
        // to titles here because the panel holds no board. Derived from the
        // same `boardBlockers` the board's rings come from, so the panel and
        // the row can never disagree about what is holding the work.
        blockers: task ? openBlockersOf(task) : [],
        onRelatedAdd: (t, url) => void addRelatedLink(t, url),
        onRelatedRemove: (t, entry) => void removeRelatedLink(t, entry),
        // The ticket's two one-tap asks. The write is a doc route, not a task
        // route, because a ticket's comments live in its body doc — which is
        // exactly what makes the ask reach the seated lead on the board
        // subscription it already holds.
        //
        // Gated on write access, which is what draws the controls at all: the
        // two floats hide themselves the same way. Offered to a reader who
        // cannot write, the press would come back 403 and the only thing they
        // would get is a toast — no sign-in path, no way to make the ask.
        ...(canWrite ? { onAsk: (t: HubTask, kind: TaskAskKind) => askOnTask(t, kind) } : {}),
        ...(detailAsks !== undefined ? { taskAsks: detailAsks } : {}),
        // The workspace's audit rows; the panel takes this task's out of them.
        // The same list the Activity view reads — one log, two surfaces.
        activity: state.events,
        now: Date.now(),
        // The panel reports its own slot, because a signal write does not
        // paint synchronously: reading `.hub-detail-body-slot` off the DOM on
        // the next line would find the slot as it stood BEFORE this write.
        // Idempotent for an unchanged pair, so the repaints that arrive while
        // somebody is typing cost nothing.
        onBodySlot: (t, slot) =>
          bodyEditor.sync(t ? { id: t.id, bodyDocId: t.bodyDocId } : null, slot),
      },
    };
    if (!task && (renderedDetailId !== null || renderedGoalId !== null)) {
      if (detailOpener?.isConnected) detailOpener.focus();
      detailOpener = null;
    }
    syncBoardUrl();
    // Open, close, and row-to-row all land here; keyed on the id, so the
    // repaints in between cost nothing.
    syncReadTracker(task?.id ?? null, task?.bodyDocId);
    renderedDetailId = task?.id ?? null;
    renderedGoalId = null;
  }

  /**
   * A boot deep link's `?thread=` aim, checked once against a discussion that
   * has actually loaded: absent then means gone (resolved away, or a stale
   * paste), and the graceful fallback is the panel without the aim — plus a
   * word about it, because a silent nothing reads as a broken link.
   */
  function noteStaleBootThread(discussion: TaskDiscussion): void {
    if (!boot.threadPending() || !state.detailThreadId) return;
    boot.clearThread();
    if (discussion.threads.some((t) => t.id === state.detailThreadId)) return;
    state.detailThreadId = null;
    showToast('That comment thread is gone — the link may be outdated.');
  }

  /**
   * What this ticket's two ask stamps say — who asked for a plan or a review,
   * and when. Read from the ticket's body doc, which is where the ask routes
   * write them, so a reload and another tab's press both show the receipt
   * without the panel tracking anything.
   *
   * A read that fails leaves the controls offering. That is the right way
   * round: an offer costs one extra press at worst, where a receipt invented
   * from a failed read hides the control for an ask nobody made.
   */
  async function loadTaskAsks(taskId: string): Promise<void> {
    const body = await fetchJson<{ meta?: TaskAskState }>(taskAskStatePath(taskId));
    // The reader may have moved on while this was in flight.
    if (detailAsksFor !== taskId) return;
    detailAsks = body?.meta ?? {};
    renderDetail();
  }

  /**
   * Ask the board's agent to plan this ticket, or to review it.
   *
   * The route is the doc one the meeting floats press (`taskAskRequestPath`),
   * aimed at the ticket's body doc: it files the ask as a subject thread from
   * this reader and stamps who asked. Resolves to whether it LANDED — the
   * control puts itself back on a refusal rather than showing a receipt for
   * an ask no agent received.
   */
  async function askOnTask(task: HubTask, kind: TaskAskKind): Promise<boolean> {
    const res = await send(taskAskRequestPath(task.id, kind), 'POST', { author });
    if (!res.ok) {
      showToast(kind === 'plan' ? 'Asking for a plan failed' : 'Asking for a review failed');
      return false;
    }
    // Both halves of what just changed: the stamp the receipt is built from,
    // and the comment the ask actually IS — it belongs in the discussion the
    // reader is looking at, not only in the agent's inbox.
    await loadTaskAsks(task.id);
    await loadDiscussion(task);
    return true;
  }

  /**
   * Clipboard write, with a fallback that is a real fallback: `writeText`
   * rejects on an insecure origin and in a few embedded webviews, and a "Copied"
   * toast over an empty clipboard is worse than no button. When it fails the
   * toast carries the URL itself, which is at least selectable.
   */
  async function copyTaskLink(task: HubTask): Promise<void> {
    const url = taskUrl(task.id);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(url);
    }
  }

  /** The same for a band. Separate only because the URL is — the clipboard
   *  refusal is handled identically, by showing the link so it can be copied
   *  by hand. */
  async function copyGoalLink(section: BoardSection): Promise<void> {
    const url = goalUrl(section.id);
    try {
      await navigator.clipboard.writeText(url);
      showToast('Link copied');
    } catch {
      showToast(url);
    }
  }

  return { renderDetail, setFocusTitle };
}
