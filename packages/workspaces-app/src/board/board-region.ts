/**
 * The board pane: the bands and rows, the lead strip, the restore list, and
 * the Activity feed that is a VIEW of this same pane rather than a page of
 * its own.
 *
 * One responsibility — everything the middle column can be showing — and the
 * reason the Activity feed belongs in it is `state.view`: the feed and the
 * task list are two states of one container, and the three chrome elements
 * that hide with the rows (`board-quick`, `board-decisions`, `board-archived`) are
 * hidden by the same function that swaps them. Split apart, "which of these is
 * on screen" would live in two files with nothing keeping them agreed.
 *
 * `boardHandlers` is here rather than in the entry for the same reason: it is
 * the stable callback set the board island is mounted with, and every one of
 * its entries is a board gesture. `openTaskDetail` travels with it because it
 * is the ONE opener behind every task tap — a board row, a queue row and the
 * Home activity pane all reach the panel through it, with only the landing tab
 * differing, which is what keeps them from drifting into three openers.
 *
 * `BoardDeps` is the whole list of what this pane may reach. The REST verbs
 * arrive as one `actions` object rather than as loose functions, because the
 * pane performs no writes of its own — it hands the island a gesture and the
 * verb decides.
 */
import type { User } from '@feedback/core';
import type { BoardActions, BoardState } from './board-actions.ts';
import { type BoardHandlers, boardData } from './board-island.tsx';
import {
  type BoardSection,
  type BoardTask,
  type ReorderTarget,
  archivedGoals,
  archivedTasks,
  boardSectionsWithEffort,
  goalSection,
} from './board-model.ts';
import type { BoardNav } from './board-presence-model.ts';
import {
  renderActivity,
  renderArchivedList,
  renderLeadStrip,
  renderReviewBanner,
} from './board-render.ts';
import type { ReviewQueue } from './board-review-model.ts';
import type { DetailTab } from './task-detail-island.tsx';

/** Everything the board pane needs from `bootBoard`, and nothing else. */
export interface BoardDeps {
  /** The board's one projection. LIVE — the pane reads `tasks`, `info`, the
   *  filters and the three panel-aim fields, and writes the aim fields when a
   *  row is opened. */
  state: BoardState;
  /** Whose "My tasks" the tab filter means. */
  user: Pick<User, 'name'>;
  /** `getElementById`, already narrowed — `bootBoard`'s own `el`. */
  el(id: string): HTMLElement;
  /** Every REST write a board gesture ends in. */
  actions: BoardActions;
  /** The projection's rows, in one array. */
  taskList(): BoardTask[];
  /** A task's title, or its id when this board has never seen it. */
  titleOf(taskId: string): string;
  /** The review queue as it stands right now, for the banner's one line. */
  currentQueue(): ReviewQueue;
  /** Repaint the detail panel — every row opener ends here. */
  renderDetail(): void;
  /** Repaint the walkthrough, which rides the board's own repaint. */
  renderWalkthrough(): void;
  /** Write the address for what is on screen. */
  syncBoardUrl(): void;
  /** Go to a nav destination — the review banner's way to Home. */
  setNav(nav: BoardNav): void;
}

/** What `bootBoard` keeps: the four renders and the openers around them. */
export interface BoardRegion {
  /** The one opener behind every task tap. */
  openTaskDetail(task: BoardTask, tab?: DetailTab): void;
  /** The board island's stable callback set. */
  boardHandlers: BoardHandlers;
  /** Everyone a task can be handed to besides a person. */
  knownAgentIds(): string[];
  renderLead(): void;
  setShowArchived(on: boolean): void;
  renderBoardRegion(): void;
  renderActivityRegion(): void;
}

export function createBoardRegion(deps: BoardDeps): BoardRegion {
  const {
    state,
    user,
    el,
    actions,
    taskList,
    titleOf,
    currentQueue,
    renderDetail,
    renderWalkthrough,
    syncBoardUrl,
    setNav,
  } = deps;
  // Destructured into the names the board's own lines already used, so a
  // handler here reads exactly as it did inside `main()`'s closure.
  const {
    transitionTask,
    retitleGoal,
    addGoal,
    placeTask,
    renameTask,
    assignTask,
    restoreTask,
    restoreGoal,
    saveLead,
  } = actions;

  /** The one opener behind every task tap — board row, queue row, Home
   *  activity pane — so the panel opens the same way from each, with only
   *  the landing tab differing. */
  function openTaskDetail(task: BoardTask, tab: DetailTab = 'comments'): void {
    state.detailTaskId = task.id;
    state.detailTab = tab;
    state.detailGoalId = null;
    // Opening the task any other way clears the queue's aim, so a mark left
    // over from the last walkthrough item can't point at the wrong thread.
    state.detailThreadId = null;
    renderDetail();
  }

  const boardHandlers: BoardHandlers = {
    onStatusSet: (task: BoardTask, to: BoardTask['status']) => void transitionTask(task, to),
    onGoalTitleCommit: (sectionId: string, title: string) => void retitleGoal(sectionId, title),
    onGoalAdd: (title: string, after?: string) => void addGoal(title, after),
    // The goal row's one gesture on a coarse pointer, and the desktop click
    // anywhere off the title's words (decision 4). The two panels share the
    // detail container, so opening a goal closes any task.
    onOpenGoal: (section: BoardSection) => {
      state.detailGoalId = section.id;
      state.detailTaskId = null;
      state.detailThreadId = null;
      renderDetail();
    },
    onOpenTask: (task: BoardTask) => openTaskDetail(task),
    onReorder: (task: BoardTask, target: ReorderTarget) => void placeTask(task, target),
    onTitleCommit: (task: BoardTask, title: string) => void renameTask(task, title),
    onAssign: (task: BoardTask, assignee: string) => void assignTask(task, assignee),
  };

  /** Everyone a task can be handed to besides a person: the agents attached
   *  to this workspace, plus the lead (who owns goal changes here and is
   *  therefore somebody, whether or not their session is currently up). */
  function knownAgentIds(): string[] {
    const lead = state.info?.leadAgentId;
    return [...new Set([...state.agents.map((a) => a.agentId), ...(lead ? [lead] : [])])];
  }

  function renderLead(): void {
    renderLeadStrip(
      el('board-lead'),
      state.info?.leadAgentId,
      state.agents.map((agent) => agent.agentId),
      { onLeadCommit: (leadAgentId) => void saveLead(leadAgentId) },
      state.seat ?? undefined,
    );
  }

  /**
   * Show or leave the restore list, and put it in the address bar.
   *
   * A filter on the board rather than a page: `historyStep` answers `replace`
   * for it, so Back still leaves the workspace rather than unwinding a list
   * somebody glanced at.
   */
  function setShowArchived(on: boolean): void {
    if (state.showArchived === on) return;
    state.showArchived = on;
    syncBoardUrl();
    renderBoardRegion();
  }

  function renderBoardRegion(): void {
    const filters = {
      tab: state.tab,
      userName: user.name,
      doneWindow: state.doneWindow,
      now: Date.now(),
    };
    // No focus save/restore here any more. It used to bracket this whole
    // function — snapshot the focused row's task id and whether the drag
    // handle held it, then find the row again afterwards by scanning every
    // `.board-task-row` — because the vanilla renderer replaced every row on
    // every paint and keyboard reordering died after one press. The rows are
    // keyed Preact now: an unchanged row is the identical node, so a repaint
    // leaves focus where it was without anyone asking. What the keyed diff
    // still does is MOVE a reordered row, and re-inserting a node blurs it in
    // WebKit and Blink — that one case is handled inside the island, on the
    // node itself (see `Board`'s focus effect), which is a re-focus of a
    // reference rather than a search for a replacement.
    const archived = archivedTasks(taskList());
    const archivedBands = archivedGoals(state.info?.goals ?? []);
    const showArchived = state.pane === 'board' && state.showArchived;
    // The restore list is still a vanilla renderer, so it gets its OWN
    // container: no vanilla code may `replaceChildren` a node holding a live
    // island, and `#board` is the island's host for the life of the page.
    el('board').classList.toggle('hidden', showArchived);
    el('board-archived').classList.toggle('hidden', !showArchived);
    if (showArchived) {
      renderArchivedList(
        el('board-archived'),
        archived,
        {
          onRestore: (task) => void restoreTask(task),
          onOpenTask: (task) => boardHandlers.onOpenTask(task),
          onBack: () => setShowArchived(false),
          // A band opens the goal panel, which is where its Archived note and
          // its own Restore live — the same "the title still opens the row"
          // rule the task rows follow, for the same reason: the discussion on
          // an archived row is often why somebody came looking.
          onRestoreGoal: (goal) => {
            const s = goalSection(state.info?.goals ?? [], goal.id);
            if (s) void restoreGoal(s);
          },
          onOpenGoal: (goal) => {
            state.detailGoalId = goal.id;
            state.detailTaskId = null;
            renderDetail();
          },
        },
        archivedBands,
      );
    }
    // The island's one input. `pane` rides along rather than gating the write:
    // Home hides the board column outright, and a row built into it is a node
    // with listeners nobody can see — but the signal is still the only place
    // the board's state lives, so the island is what decides to draw nothing.
    // The agent list is read HERE, at paint time, for the same reason it
    // always was: attachments arrive after the first paint and change while
    // the board is open, and a picker built from a stale list offers agents
    // who have left.
    boardData.value = {
      sections: boardSectionsWithEffort(state.info?.goals ?? [], taskList(), filters, filters.now),
      pane: state.pane,
      showArchived,
      knownAgentIds: knownAgentIds(),
      // Bands count too: the chip is the way back to the restore list, and a
      // board whose only archived thing is a goal must not read "0 archived"
      // and hide the door.
      archivedCount: archived.length + archivedBands.length,
    };
    // No "N tasks have no goal yet" strip above the board any more (Bryan,
    // 2026-08-29, by voice: it "is taking out space and all of it's not
    // useful"). Backlog already holds every unplaced row; `unplacedNotice`
    // stays in the model for the lead's tools, and nothing here draws it.
    // The board's read of the queue is one line now — the full list lives on
    // Home. Two surfaces both claiming to be the queue would drift the first
    // time only one of them learned something.
    renderReviewBanner(el('board-decisions'), currentQueue(), {
      onGoHome: () => setNav('home'),
    });
    renderWalkthrough();
  }

  function renderActivityRegion(): void {
    const board = el('board');
    const activity = el('board-activity');
    // Everything the task list is made of hides with it. Activity used to be
    // a button that swapped ONE div, so the capture box and the review strip
    // stayed on screen over a feed they have nothing to do with.
    for (const id of ['board-quick', 'board-decisions', 'board-archived']) {
      el(id).classList.toggle('board-hidden-by-view', state.view === 'activity');
    }
    if (state.view === 'activity') {
      board.classList.add('hidden');
      activity.classList.remove('hidden');
      renderActivity(
        activity,
        state.events,
        state.activityFilter,
        titleOf,
        (f) => {
          state.activityFilter = f;
          renderActivityRegion();
        },
        state.uptime,
      );
    } else {
      board.classList.remove('hidden');
      activity.classList.add('hidden');
    }
  }

  return {
    openTaskDetail,
    boardHandlers,
    knownAgentIds,
    renderLead,
    setShowArchived,
    renderBoardRegion,
    renderActivityRegion,
  };
}
