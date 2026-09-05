/**
 * Every REST write the board performs, and the working state they mutate.
 *
 * `main()` in `hub-app.ts` used to hold these as declarations inside a
 * ~3,000-line closure, where what each one reached for was invisible: a verb
 * that repaints the lead strip and a verb that repaints everything looked
 * identical from the outside. `createHubActions` takes those captures as one
 * explicit object — `HubActionDeps` — and hands back the same verbs. Nothing
 * about a write changed; what changed is that the file says what a write can
 * touch.
 *
 * `HubState` lives here rather than in the entry because these verbs are its
 * writers: `hub-review-controller.ts` and `hub-live-wiring.ts` read the type
 * from here too, and the entry imports it back.
 *
 * `send`, `fetchJson` and `showToast` come along because every verb ends in
 * one of them — a write that lands, or a one-line report that it did not.
 */
import { type CaptureMode, type HuddleKind, type User, parseWorkspaceLink } from '@feedback/core';
import { HUDDLE_MODE_PARAM } from '../huddle-entry.ts';
import {
  type BoardSection,
  type BoardTab,
  type DoneWindow,
  type HubTask,
  type HubWorkspaceInfo,
  type ReorderTarget,
  cascadePhrase,
} from './hub-board-model.ts';
import type { RelatedEntry, TaskDiscussion } from './hub-detail-render.ts';
import type {
  ActivityEvent,
  ActivityFilter,
  ClientRelease,
  HomePayload,
  HubNav,
  HubPane,
  LeadSeatView,
  PluginRelease,
  PresenceAgent,
  UptimeReport,
} from './hub-presence-model.ts';
import type { ReviewItem, ReviewThreadItem } from './hub-review-model.ts';
import type { DetailTab } from './task-detail-island.tsx';
import type { WalkProgress } from './walkthrough-island.tsx';

export interface HubState {
  info: HubWorkspaceInfo | null;
  tasks: Map<string, HubTask>;
  /** Which of the four nav destinations is showing. THE source: `pane`,
   *  `tab` and `view` below are derived from it in `setNav` and never set
   *  anywhere else, so a deep link and a click cannot disagree. */
  nav: HubNav;
  /** Which page of the shell is showing — Home or the board. Derived. */
  pane: HubPane;
  /** The settings popover is open. App state rather than DOM state, so a
   *  repaint cannot close it under someone mid-change. */
  settingsOpen: boolean;
  /** The Home payload for THIS reader, or null before the first load. */
  home: HomePayload | null;
  /** The recipe editor is open. App state, not DOM state, so a repaint
   *  mid-edit cannot silently close the panel. */
  homeEditingRecipe: boolean;
  /** What this sitting has cleared, by key — answered items stay in the Home
   *  stack marked done instead of vanishing (approved design). Client-side
   *  and per-sitting on purpose: the server cannot un-answer a decision, so
   *  "done" here is a display fact about this visit, not a stored one. */
  homeSettled: Map<string, ReviewItem>;
  /** When the current generating-poll run started; 0 when not polling. */
  homePollStarted: number;
  tab: BoardTab;
  doneWindow: DoneWindow;
  view: 'board' | 'activity';
  /**
   * The board column is showing the restore list instead of the lanes.
   *
   * A flag on the board rather than a fifth `nav` destination, and it is the
   * shape the design asked for: the phone rail has four seats, and the way in
   * is one line above the first goal. It rides `?view=archived` so a reload
   * or a shared link lands back on it, and any nav tap clears it — leaving the
   * board is leaving this.
   */
  showArchived: boolean;
  activityFilter: ActivityFilter;
  events: ActivityEvent[];
  /** Deploy readiness (§3.12 commit 11) — null until the log has lines. */
  uptime: UptimeReport | null;
  agents: PresenceAgent[];
  /** Whether the lead seat has anybody in it — read off the attachments poll
   *  rather than the projected workspace info, because it changes with time
   *  alone and a value stamped into the doc would still say "fine" hours
   *  after the lead stopped answering. Null until the first read lands, and
   *  null on any server older than the field: no claim, not a clear seat. */
  seat: LeadSeatView | null;
  /** Plugin versions: what the deploy source would install, and which
   *  attached sessions are running something older. Null until the first
   *  attachments read lands. */
  pluginRelease: PluginRelease | null;
  /** What the browser itself is running, and whether this deployment could
   *  not replace it. Null on any server that publishes no client release
   *  (dev, staging) — those must not report the prod machine's deploy. */
  clientRelease: ClientRelease | null;
  detailTaskId: string | null;
  /** Which tab the task panel opens on. `comments` every way in but one: the
   *  Home activity pane's title tap opens on Activity (Bryan, 2026-08-29).
   *  Reset to `comments` when the panel closes, so nothing lingers into the
   *  paths (deep link, `o`) that set `detailTaskId` without going through
   *  `openTaskDetail`. */
  detailTab: DetailTab;
  /** The open GOAL, when the detail container is showing a goal band rather
   *  than a task. The two panels share the container, so at most one of this
   *  and `detailTaskId` is set — each opener clears the other, and
   *  `renderDetail` enforces task-wins for the paths (deep link, voice) that
   *  set a task id without knowing a goal was open. */
  detailGoalId: string | null;
  /** The thread the review queue aimed at, when the panel was opened from it.
   *  Null every other way in. */
  detailThreadId: string | null;
  /**
   * The open task's discussion, and the id it was fetched FOR. Keyed rather
   * than just held, because a load that lands after the reader has moved to
   * another task would otherwise show them someone else's argument.
   */
  discussion: TaskDiscussion;
  discussionTaskId: string | null;
  /**
   * The thread-shaped half of "what needs you" — task discussions and doc
   * comments whose newest word is an agent's. Server-computed, because
   * whether a comment is an agent's is `classifyActor`'s call and there must
   * not be a second one. Decisions are derived from `tasks` here.
   */
  reviewItems: ReviewThreadItem[];
  /** Position in the review walkthrough; -1 when it is closed. A CACHE of
   *  where `walkKey` resolved on the last render — see `walkPosition`. */
  walkIndex: number;
  /** What the walkthrough is aimed AT. The queue re-derives on every render
   *  and shrinks under the reader, so the index alone steps over an item
   *  whenever anything before it drops out. Null when nothing is aimed
   *  (closed, or run off the end into the done state). */
  walkKey: string | null;
  /** What this sitting has cleared, so the surface can say that answering
   *  moved you rather than leaving you to infer it from a shrinking total. */
  walkProgress: WalkProgress;
  followedKey: string | null;
}
export async function fetchJson<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(path);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function send(
  path: string,
  method: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> | null }> {
  try {
    const res = await fetch(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

let toastTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * The board's one-line report, optionally carrying a way to take it back.
 *
 * `action` is what makes an undoable act safe to perform without a dialog:
 * the row leaves, and the way back is in the same place the news arrived,
 * for as long as the toast stands. Ten seconds for an archive rather than
 * the default three and a half — a confirm dialog is what this replaces, and
 * three seconds is not long enough to read a sentence and decide against it.
 */
export function showToast(
  msg: string,
  action?: { label: string; run: () => void; ms?: number },
): void {
  const el = document.getElementById('hub-toast');
  if (!el) return;
  el.replaceChildren(document.createTextNode(msg));
  if (action) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hub-toast-action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      // Dismiss FIRST. The action re-renders the board, and a toast still
      // offering "Undo" over a row that is already back reads as an undo
      // that did not take.
      if (toastTimer) clearTimeout(toastTimer);
      el.classList.add('hidden');
      action.run();
    });
    el.append(btn);
  }
  el.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), action?.ms ?? 3500);
}

/** How long the Undo stands after an archive. Ten seconds, and it is the
 *  reason no confirm dialog is asked for. */
export const ARCHIVE_UNDO_MS = 10_000;

/**
 * What the verbs below reach outside themselves for — one object, named, so a
 * reader can see a write's whole blast radius without reading its body.
 */
export interface HubActionDeps {
  /** The board every workspace-scoped write is addressed to. */
  workspaceId: string;
  /** Who the write is attributed to. Every route stamps it. */
  author: Pick<User, 'id' | 'name' | 'kind' | 'color'>;
  /** The projection these verbs mutate when a write lands ahead of the ydoc. */
  state: HubState;
  /** Repaint every region — the refusal path's way back to server truth. */
  renderAll: () => void;
  /** Repaint the detail panel alone. */
  renderDetail: () => void;
  /** Repaint the lead-agent strip alone. */
  renderLead: () => void;
  /** Aim the next detail render's title at a row, so a task filed empty opens
   *  with the cursor in its name. */
  focusTitle: (taskId: string) => void;
}

/**
 * Bind the verbs to one set of dependencies. The entry passes the result down
 * to the region modules whole, so a region's dependency list says "the board's
 * writes" once rather than naming twenty verbs — see `HubActions`.
 */
export function createHubActions(deps: HubActionDeps) {
  const { workspaceId, author, state, renderAll, renderDetail, renderLead, focusTitle } = deps;

  /**
   * Put the controls back to what the SERVER says, after a write it refused.
   *
   * A select and a rename are the two places on this board where the reader's
   * gesture changes the DOM before the server has agreed. When the write is
   * refused they were left showing the rejected value — a select reading
   * "Done" over a task the server still has in triage, a row wearing a title
   * nobody saved — and only a reload put it right. A board that displays a
   * status nobody set is worse than the refusal it just reported.
   *
   * "+ New goal" never had the problem, because it changes nothing locally
   * and waits for the projection to paint the row. This is that same rule
   * applied to the controls that cannot wait: repaint from `state`, which is
   * the projection and nothing else. `useSelectValue` and the title's
   * every-render text write (board-island.tsx, task-detail-island.tsx) then
   * put each control back on their next pass.
   */
  function revertToServerTruth(): void {
    renderAll();
  }

  async function transitionTask(task: HubTask, to: HubTask['status']): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/transition`, 'POST', {
      to,
      author,
    });
    if (res.status === 409) {
      const blockers = (res.data?.blockers as Array<{ taskId: string; title?: string }>) ?? [];
      const names = blockers.map((b) => b.title ?? b.taskId).join(', ');
      showToast(`Blocked by open dependency: ${names || 'an enforced dependency'}`);
      revertToServerTruth();
    } else if (!res.ok) {
      showToast('Status change failed');
      revertToServerTruth();
    }
  }

  async function assignTask(task: HubTask, assignee: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/assignee`, 'POST', {
      assignee,
      author,
    });
    if (!res.ok) {
      showToast('Assignment failed');
      revertToServerTruth();
    }
  }

  /**
   * The panel's Goal field. Sends the same `set_task_goal` write a drag does
   * and an agent does — no `after`, because picking a band is not a placement
   * within it, and inventing one would move the task to the end of the new
   * band for no reason the reader gave.
   */
  async function setTaskGoal(task: HubTask, goal: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/goal`, 'POST', {
      goal,
      author,
    });
    if (!res.ok) showToast('Moving to that goal failed');
  }

  /** The panel's Due field. `null` clears — the route reads it as the explicit
   *  clear it is, rather than as a missing value. */
  async function setTaskDue(task: HubTask, dueAt: number | null): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/due`, 'POST', {
      dueAt,
      author,
    });
    if (!res.ok)
      showToast(dueAt === null ? 'Clearing the due date failed' : 'Setting the due date failed');
  }

  /**
   * What to say when a Related Links write is refused.
   *
   * Two refusals carry more than "it failed" and both were being thrown away:
   * a 401 is the SESSION, not the link (the row is fine, the reader is signed
   * out, and telling them the link was bad sends them to fix the wrong thing),
   * and a cycle refusal arrives with the ring already named, which no generic
   * sentence can reconstruct.
   */
  function addFailureText(
    res: { status: number; data: Record<string, unknown> | null },
    fallback: string,
  ): string {
    if (res.status === 401) return 'Sign in again to change this board';
    const said = typeof res.data?.message === 'string' ? res.data.message : '';
    return said !== '' ? said : fallback;
  }

  /**
   * Grow Related Links from a pasted address.
   *
   * What the URL NAMES decides the write, which is the whole reason there is
   * one control rather than three:
   *
   *  - a **ticket on this workspace** becomes an `after` edge, which is how a
   *    blocker gets set at all. Blocked is derived from those edges and no
   *    status control offers it, so this is the panel's only door to it. It
   *    goes through the same additive route `block_task` uses. A GOAL link is
   *    not a ticket — a ticket waits on tickets — so it falls to the last arm
   *    and is kept as a plain address.
   *  - a **doc or mockup** becomes a doc ref, and the entry resolves to the
   *    doc's title like every other Related Link.
   *  - **anything else** is kept verbatim as a `url` ref and shown as itself.
   *    The server refuses a scheme that is not http(s) — a `javascript:` link
   *    in this list would become an href — and the toast says so.
   */
  async function addRelatedLink(task: HubTask, url: string): Promise<void> {
    const parsed = parseWorkspaceLink(url);
    // A TICKET only. A goal link used to come here too and could never
    // succeed: goal rows are not in the workspace's task map, so the store
    // answered `unknown-after` and the reader got "Adding the blocking ticket
    // failed" for a link that was never going to be a blocker. A ticket waits
    // on tickets (the owner's rule, upheld by the store); a goal link is
    // "anything else" and falls through to the plain-URL arm below, which is
    // what the ticket asks for.
    if (parsed?.kind === 'task') {
      const blockedBy = parsed.taskId;
      // A row cannot wait on itself, and the server would refuse it — but the
      // toast for a self-link should say what happened rather than repeat a
      // validation message about ids.
      if (blockedBy === task.id) {
        showToast('A ticket cannot wait on itself');
        return;
      }
      const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/park`, 'POST', {
        blockedBy: [blockedBy],
        author,
      });
      if (!res.ok) showToast(addFailureText(res, 'Adding the blocking ticket failed'));
      return;
    }
    const ref =
      parsed?.kind === 'doc' || parsed?.kind === 'mockup'
        ? { kind: 'doc', docId: parsed.docId }
        : { kind: 'url', url };
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/links`, 'POST', {
      ref,
      author,
    });
    if (!res.ok) {
      showToast(
        res.status === 400
          ? 'That is not a link we can store'
          : addFailureText(res, 'Adding the link failed'),
      );
    }
  }

  /**
   * Take one Related Links entry back off.
   *
   * A blocker is an `after` edge and comes off by rewriting the list without
   * it — `afterEnforce` is rewritten alongside, because the route replaces
   * what it is given and omitting the second list would quietly drop every
   * enforced edge the row had.
   */
  async function removeRelatedLink(task: HubTask, entry: RelatedEntry): Promise<void> {
    if (entry.kind === 'blocker') {
      const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/after`, 'POST', {
        after: task.after.filter((id) => id !== entry.taskId),
        ...(task.afterEnforce !== undefined
          ? { afterEnforce: task.afterEnforce.filter((id) => id !== entry.taskId) }
          : {}),
        author,
      });
      if (!res.ok) showToast('Removing the blocking ticket failed');
      return;
    }
    const ref =
      entry.kind === 'doc' ? { kind: 'doc', docId: entry.docId } : { kind: 'url', url: entry.url };
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/links`, 'DELETE', {
      ref,
      author,
    });
    if (!res.ok) showToast('Removing the link failed');
  }

  /**
   * Take a task off the board, and offer the way back in the same breath.
   *
   * No confirm dialog, deliberately. Archiving is reversible by construction
   * — three fields on the row — and this is a SECONDARY action that must not
   * cost a modal (Bryan, on the design thread: *"It's a secondary action.
   * Should not take up space from primary flows."*). The ten-second Undo is
   * what pays for the missing dialog, and it is the only thing that does, so
   * it goes up on the success path only: a toast offering to undo a write
   * that never landed is worse than no toast.
   *
   * The open panel closes, because a panel left standing on a row that just
   * left the board is a surface with no way to explain itself.
   */
  async function archiveTask(task: HubTask): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/archive`, 'POST', { author });
    if (!res.ok) {
      showToast('Archiving failed — the task is still on the board');
      return;
    }
    if (state.detailTaskId === task.id) {
      state.detailTaskId = null;
      renderDetail();
    }
    showToast(`Archived “${task.title}”`, {
      label: 'Undo',
      run: () => void restoreTask(task),
      ms: ARCHIVE_UNDO_MS,
    });
  }

  /** Put an archived task back. The Undo button, the panel's Restore, and the
   *  restore list's rows are all this one call. */
  async function restoreTask(task: HubTask): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/restore`, 'POST', { author });
    if (!res.ok) {
      showToast('Restoring failed — the task is still archived');
      return;
    }
    showToast(`Restored “${task.title}”`);
  }

  /** How many rows the panel is about to say goodbye to. Straight from the
   *  server's own walk, so the sentence in the confirmation and the write that
   *  follows it cannot disagree. `null` = the question could not be asked, and
   *  the panel then refuses to offer Archive at all. */
  async function goalCascadeCount(goalId: string): Promise<{ tasks: number } | null> {
    const res = await fetchJson<{ taskIds?: string[] }>(
      `/api/goals/${encodeURIComponent(goalId)}/cascade`,
    );
    if (!res) return null;
    return { tasks: res.taskIds?.length ?? 0 };
  }

  /** How many rows a goal archive or restore actually moved, off the response.
   *  Read defensively: an older server answers without the lists, and the
   *  toast then names the band alone rather than inventing a zero. */
  function movedCount(data: Record<string, unknown> | null, key = 'taskIds'): number {
    const ids = data?.[key];
    return Array.isArray(ids) ? ids.length : 0;
  }

  /**
   * Take a BAND off the board, with everything under it.
   *
   * The panel has already asked and named the number — this is the commit, so
   * there is no second confirmation here. What there IS, exactly as on a task,
   * is Undo in the same breath: the archive is reversible by construction and
   * the toast is what makes that reachable without going and finding the
   * restore list.
   *
   * The toast counts what the SERVER moved, not what the confirmation
   * predicted. The two are the same in every ordinary case; when a peer files
   * a fifteenth ticket between the question and the answer, the honest number
   * is the one that happened.
   */
  async function archiveGoal(section: BoardSection): Promise<void> {
    const res = await send(`/api/goals/${encodeURIComponent(section.id)}/archive`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Archiving failed — the goal is still on the board');
      return;
    }
    if (state.detailGoalId === section.id) {
      state.detailGoalId = null;
      renderDetail();
    }
    // The same phrase the confirmation used, from the same builder: a reader
    // told "and its 5 tasks" and then "and 3 tasks" would have to conclude
    // two of them stayed.
    const rode = cascadePhrase(movedCount(res.data, 'taskIds'));
    showToast(`Archived “${section.title}”${rode ? ` and its ${rode}` : ''}`, {
      label: 'Undo',
      run: () => void restoreGoal(section),
      ms: ARCHIVE_UNDO_MS,
    });
  }

  /** Put an archived band back, with the rows its archive took. The Undo
   *  button, the panel's Restore and the restore list's rows are all this. */
  async function restoreGoal(section: BoardSection): Promise<void> {
    const res = await send(`/api/goals/${encodeURIComponent(section.id)}/restore`, 'POST', {
      author,
    });
    if (!res.ok) {
      showToast('Restoring failed — the goal is still archived');
      return;
    }
    const n = movedCount(res.data);
    showToast(
      `Restored “${section.title}”${n > 0 ? ` and ${n === 1 ? '1 task' : `${n} tasks`}` : ''}`,
    );
  }

  /**
   * A drag or an arrow-key move, sent as the placement it already is — the
   * same `set_task_goal` write an agent performs, so there is deliberately no
   * reordering API of its own, and a cross-goal drop is this call with a
   * different goal.
   *
   * It sends `after` and NOT `position`. The two are alternative spellings of
   * one placement and the server prefers `after`, so sending both would just
   * be a number nobody reads — and a number the drop cannot compute correctly
   * anyway, which is the bug this replaced (see the reordering section of
   * hub-board-model.ts).
   */
  async function placeTask(task: HubTask, target: ReorderTarget): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/goal`, 'POST', {
      goal: target.goal,
      after: target.after,
      author,
    });
    if (!res.ok) {
      showToast('Move failed');
      revertToServerTruth();
    }
  }

  async function renameTask(task: HubTask, title: string): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(task.id)}/title`, 'POST', {
      title,
      author,
    });
    if (!res.ok) {
      showToast('Rename failed');
      revertToServerTruth();
    }
  }

  /**
   * Retitle one band. This used to clone the client's copy of the goal list,
   * edit one title in it, and PUT the whole thing back — which is a full
   * REPLACE keyed by id built from a read that may be minutes old. A band
   * another writer added in between was simply absent from the clone, so the
   * replace removed it: its open tasks to Backlog, its done tasks orphaned.
   * The rename route touches one row by id and cannot move a task, so the
   * stale copy stops being able to do damage at all.
   */
  async function retitleGoal(sectionId: string, title: string): Promise<void> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/rename`,
      'POST',
      { goal: sectionId, title, author },
    );
    if (!res.ok) {
      showToast('Goal rename failed');
      revertToServerTruth();
    }
  }

  /**
   * The goal panel's Due field. There is no dedicated goal-due route — the
   * rename route already carries `dueAt` (it exists for the reason
   * `retitleGoal`'s own comment gives: one row, by id, cannot strand tasks),
   * so this resends the goal's own title alongside the new date. `null`
   * clears, the same contract `setTaskDue` uses.
   */
  async function setGoalDue(sectionId: string, title: string, dueAt: number | null): Promise<void> {
    const res = await send(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/goals/rename`,
      'POST',
      { goal: sectionId, title, dueAt, author },
    );
    if (!res.ok) {
      showToast(dueAt === null ? 'Clearing the due date failed' : 'Setting the due date failed');
      revertToServerTruth();
    }
  }

  /**
   * Declare a goal's status — the same one-gate transition route a task
   * uses (`tasks.ts` resolves goal rows through it too; that is the whole
   * point of a goal being a row). Open children are ADVISORY on the server
   * (enforce:false), so a done declaration over open tasks succeeds — the
   * panel says so before the reader picks it.
   */
  async function transitionGoal(goalId: string, to: HubTask['status']): Promise<void> {
    const res = await send(`/api/tasks/${encodeURIComponent(goalId)}/transition`, 'POST', {
      to,
      author,
    });
    if (!res.ok) {
      showToast('Goal status change failed');
      revertToServerTruth();
    }
  }

  /** Add one band, for the same reason the rename above is its own route: a
   *  client-built full list can only add by re-asserting everything it last
   *  read, and what it did not read is what gets removed. */
  async function addGoal(title: string, after?: string): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/goals/add`, 'POST', {
      title,
      ...(after !== undefined ? { after } : {}),
      author,
    });
    if (!res.ok) showToast('Could not add the goal');
  }

  async function saveLead(leadAgentId: string): Promise<void> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/lead`, 'PUT', {
      leadAgentId,
      author,
    });
    if (!res.ok) {
      showToast('Lead agent update failed');
      renderLead();
      return;
    }
    showToast(`${leadAgentId} now leads this workspace`);
    // The projection carries the new lead back through wsMap; render now so
    // the strip does not sit on the old value until that round-trips.
    if (state.info) state.info = { ...state.info, leadAgentId };
    renderLead();
  }
  /**
   * The Board's "New task": an EMPTY row, opened at once in the panel with the
   * title ready to type (Bryan, 2026-08-29: *"creates an empty item in the
   * usual task detail view"*). No prompt, no sheet — the panel IS the form.
   *
   * Filed as the person, to the person: the old capture box handed every idea
   * to the lead agent, but a row Bryan is about to type into is his, and the
   * route assigns it to the author when nobody else is named. `untitled` is
   * the one way past the blank-title refusal; the server stores its own
   * placeholder and clears the flag the moment a real title lands.
   *
   * The row itself arrives over the ydoc, not the response — so the panel is
   * pointed at the id and `renderDetail` paints it when the projection lands,
   * the way a boot deep link does.
   */
  async function newTask(): Promise<boolean> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/tasks`, 'POST', {
      untitled: true,
      author,
    });
    const created = res.data?.task as { id?: unknown } | undefined;
    const id = typeof created?.id === 'string' ? created.id : null;
    if (!res.ok || !id) {
      const why =
        typeof res.data?.message === 'string' ? res.data.message : 'Could not file a new task';
      showToast(why);
      return false;
    }
    focusTitle(id);
    state.detailTaskId = id;
    state.detailGoalId = null;
    state.detailThreadId = null;
    renderDetail();
    return true;
  }

  /**
   * The Board's two huddle buttons: ONE call makes the huddle doc on this
   * board, and the page leaves for it at once with the flag the editor reads
   * to start the meeting assistant without a press. The click here is the
   * person's gesture; `huddle-entry.ts` is the other half.
   *
   * "Make a plan" and "Have a meeting" are the same route and the same
   * file; `kind` tells the server which doc to seed (a plan opens under a
   * `# Goal` heading) and `mode` rides the address for the mic. Solo asks
   * for no speaker labels and pays for none.
   */
  async function startHuddle(kind: HuddleKind, mode: CaptureMode): Promise<boolean> {
    const res = await send(`/api/workspaces/${encodeURIComponent(workspaceId)}/huddles`, 'POST', {
      kind,
    });
    const url = typeof res.data?.url === 'string' ? res.data.url : null;
    if (!res.ok || !url) {
      const why =
        typeof res.data?.message === 'string' ? res.data.message : 'Could not start a meeting';
      showToast(why);
      return false;
    }
    // The mode rides the address beside the start flag: this press is the
    // only thing that knows whether anyone else is in the room, and the
    // editor that opens the mic is a different page.
    location.assign(`${url}?huddle=1&${HUDDLE_MODE_PARAM}=${mode}`);
    return true;
  }

  return {
    revertToServerTruth,
    transitionTask,
    assignTask,
    setTaskGoal,
    setTaskDue,
    addRelatedLink,
    removeRelatedLink,
    archiveTask,
    restoreTask,
    goalCascadeCount,
    archiveGoal,
    restoreGoal,
    placeTask,
    renameTask,
    retitleGoal,
    setGoalDue,
    transitionGoal,
    addGoal,
    saveLead,
    newTask,
    startHuddle,
  };
}

/**
 * Every verb `createHubActions` hands back, as one type.
 *
 * Derived from the factory rather than declared beside it: a verb added to the
 * return object is reachable from the regions without a second edit, and a
 * signature changed in one place cannot disagree with a hand-written copy.
 */
export type HubActions = ReturnType<typeof createHubActions>;
