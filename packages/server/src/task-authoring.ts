/**
 * Authoring a task row: minting one, and every write of the words on it.
 *
 * Split out of `tasks.ts` — the first of the five verb families that
 * were still hanging off the `TaskStore` class. It holds `createTask` and
 * the three doors into a row's own text — `renameTask`, `noteBodyEdited`,
 * `updateBodySnapshot` — and they are one file rather than two because of
 * `applyTitle`: the title choke point is private to this module and all
 * three creation-or-rename paths converge on it. Splitting create from
 * rewrite would put that choke point behind an export and give the guarantee
 * it exists to make ("every door into a title passes through here") a second
 * place to be bypassed from.
 *
 * Everything it needs from the store arrives through
 * `TaskAuthoringPersistence`, the same seam `GoalStore` / `WorkspaceStore` /
 * `AgentStore` already use. Every row handed back is LIVE — mutated in place,
 * then handed to `scheduleSave`.
 */
import type { DecisionOption, Task } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import {
  type DecisionShapeGap,
  checkDecisionShape,
  decisionShapeMessage,
} from './decision-shape.ts';
import { bumpWordsRevision, cryptoId } from './task-fields.ts';
import { CHORES_GOAL_ID } from './task-goals.ts';
import { initialTaskStatus } from './task-helpers.ts';
import { declaredAssigneeKind } from './task-owner.ts';
import { bodyHead } from './task-title.ts';
import type {
  CreateTaskOpts,
  CreateTaskResult,
  HubWorkspace,
  RenameTaskResult,
  TaskBodyEditedEvent,
  TaskCreatedEvent,
  TaskRetitledEvent,
  WorkspaceState,
} from './tasks.ts';
import { isRetired, retiredRefusal } from './workspace-store.ts';

/**
 * The three rows this file announces.
 *
 * Narrower than `TaskStoreEvent` on purpose, the same reasoning as
 * `GoalStoreEvent`. Assignable INTO `TaskStoreEvent`.
 */
export type TaskAuthoringEvent = TaskCreatedEvent | TaskRetitledEvent | TaskBodyEditedEvent;

/** What an authoring verb may reach in the store. */
export interface TaskAuthoringPersistence {
  state(workspaceId: string): WorkspaceState | undefined;
  getTask(taskId: string): Task | undefined;
  goalIdExists(workspace: HubWorkspace, goalId: string): boolean;
  /** The roster id behind a display name, or undefined when nothing places
   *  it — see `TaskStore.rosterIdFor`. */
  rosterIdFor(assignee: string): string | undefined;
  /** The doc store's settled revision for `docId`, when one is known. */
  docRevisionFor(docId: string): number | undefined;
  /** Record the new row in the store's `taskId → workspaceId` index. */
  registerTask(taskId: string, workspaceId: string): void;
  scheduleSave(workspaceId: string): void;
  emit(event: TaskAuthoringEvent): void;
}

/** Creating a row and writing its words. One per `TaskStore`, holding no
 *  state of its own. */
export class TaskAuthoringStore {
  constructor(private readonly p: TaskAuthoringPersistence) {}

  createTask(workspaceId: string, opts: CreateTaskOpts): CreateTaskResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    // A retired board takes no new work. Checked before anything else is
    // validated so the caller gets the reason it can act on rather than a
    // goal-id complaint about a board it should not be filing to at all.
    if (isRetired(state.workspace)) {
      return { ok: false, error: 'workspace-retired', message: retiredRefusal(state.workspace) };
    }

    const goal = opts.goal ?? CHORES_GOAL_ID;
    if (!this.p.goalIdExists(state.workspace, goal)) {
      return { ok: false, error: 'unknown-goal' };
    }
    // Dangling `after` edges would silently never block (the gate skips ids
    // it can't resolve), so refuse them at creation where the caller can fix
    // the reference.
    // Deduped for the same reason `setTaskDependencies` dedupes: `openBlockers`
    // walks this array, so a repeated id is a second visit to one task and the
    // reader is told twice that the same thing blocks them. Batch-local refs
    // are what make that reachable by accident — `"#warm"` and the index of the
    // row that declared it are two spellings of ONE edge, so a caller can write
    // the duplicate without repeating themselves.
    const after = [...new Set(opts.after ?? [])];
    for (const dep of after) {
      if (!state.tasks.has(dep)) return { ok: false, error: 'unknown-after' };
    }
    // `afterEnforce` is a SUBSET of `after`: openBlockers walks `after` and
    // consults afterEnforce only as a lookup set, so an id in one array and
    // not the other is never visited and hard-blocks NOTHING. Refusing beats
    // quietly widening `after`, which would change the blocker list the
    // caller sees without saying so.
    const afterEnforce = [...new Set(opts.afterEnforce ?? [])];
    for (const dep of afterEnforce) {
      if (!after.includes(dep)) return { ok: false, error: 'unknown-after-enforce' };
    }

    // ── Decision shape ────────────────────────────────────────────────────
    // Options only mean something where an answer can be recorded from them,
    // so they belong to `needs: 'decision'` and nowhere else — accepting them
    // on an action task would store a control nothing can operate.
    const rawOptions = opts.options ?? [];
    if (rawOptions.length > 0 && opts.needs !== 'decision') {
      return { ok: false, error: 'options-need-decision' };
    }
    for (const o of rawOptions) {
      if (typeof o?.label !== 'string' || o.label.trim().length === 0) {
        return { ok: false, error: 'bad-option', message: 'every option needs a non-empty label' };
      }
    }
    const options: DecisionOption[] = rawOptions.map((o) => ({
      id: cryptoId('o'),
      label: o.label.trim(),
      ...(o.detail !== undefined ? { detail: o.detail } : {}),
    }));

    // The gate this whole feature rests on: a decision nobody can decide from
    // is worse than no decision task, because it LOOKS answerable. Refuse the
    // one thing that makes it unanswerable — no question — and report the
    // rest. Applied in the STORE so promote_to_task is held to it too; the
    // route is the layer that would otherwise quietly not check.
    let shapeGaps: DecisionShapeGap[] | undefined;
    if (opts.needs === 'decision') {
      const check = checkDecisionShape(opts.body, options);
      if (!check.ok) {
        return {
          ok: false,
          error: 'decision-body-required',
          message: decisionShapeMessage(check),
        };
      }
      shapeGaps = check.gaps;
    }

    const now = Date.now();
    // Where the row came from, as a revision it can later be measured
    // against. Asked of the injected reader HERE — the one place every
    // create path converges — and settled on the reader's side, so words
    // typed just before this create stamp the post-edit revision rather
    // than flagging the row they produced.
    const originDocId =
      opts.origin !== undefined && (opts.origin.kind === 'doc' || opts.origin.kind === 'thread')
        ? opts.origin.docId
        : undefined;
    const originDocRevision =
      originDocId !== undefined ? this.p.docRevisionFor(originDocId) : undefined;
    const assigneeKind = declaredAssigneeKind(opts.assignee ?? '', opts.assigneeKind, opts.actor);
    const assigneeId = this.p.rosterIdFor(opts.assignee ?? 'agent');
    const inGoal = Array.from(state.tasks.values()).filter((t) => t.goal === goal);
    const order = opts.order ?? Math.max(0, ...inGoal.map((t) => t.order)) + 1;
    const task: Task = {
      id: cryptoId('t'),
      workspaceId,
      title: opts.title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      // The last-resort default. Every creation ROUTE resolves a real owner
      // before it gets here (task-owner.ts), so this only covers a direct
      // in-process call that named nobody.
      assignee: opts.assignee ?? 'agent',
      ...(assigneeKind !== undefined ? { assigneeKind } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(opts.needs !== undefined ? { needs: opts.needs } : {}),
      ...(options.length > 0 ? { options } : {}),
      goal,
      order,
      // A plan draft is triage WHOEVER filed it: the batch declared its rows
      // drafts of an unapproved plan, and a person's rows are not exempt from
      // their own declaration. `fileToTriage` is the same shape of claim made
      // about the row's CONTENT rather than its provenance.
      status:
        opts.planHold !== undefined || opts.fileToTriage === true
          ? 'triage'
          : initialTaskStatus(opts.actor),
      after,
      ...(afterEnforce.length > 0 ? { afterEnforce } : {}),
      ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
      links: opts.links ?? [],
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.planHold !== undefined ? { planHold: opts.planHold } : {}),
      ...(originDocRevision !== undefined ? { originDocRevision } : {}),
      ...(opts.quote !== undefined ? { quote: opts.quote } : {}),
      transitions: [],
      createdAt: now,
      // The display name, like every other projected `by` (§3.3 visitor
      // contract). An author-less create (the routes predate the field)
      // stamps nothing rather than the bare word "agent".
      ...(opts.actor?.name ? { createdBy: opts.actor.name } : {}),
      updatedAt: now,
    };
    state.tasks.set(task.id, task);
    this.p.registerTask(task.id, workspaceId);
    // Through the choke point like every other write of a title, so a created
    // row carries the same marks a renamed one does. Without this a task
    // would be measured for staleness against a body-head nobody ever
    // recorded, and the head clause would be dead for the whole life of every
    // task that was never renamed — which is most of them.
    this.applyTitle(task, task.title);
    // The create is the ONE title write that is not a naming: it stamps the
    // placeholder. Flagged after the choke point, which clears the flag on
    // every write it sees, so the create is the only door that can set it.
    if (opts.untitled) task.untitled = true;

    // An OMITTED goal means "needs placing": the task lands at the bottom of
    // Backlog (the resting state; the human is never blocked on placement)
    // and records that it is waiting. An explicit goal — even an explicit
    // 'chores' — is a placement by the caller and stamps nothing.
    //
    // The record is DURABLE and nothing else is. The server used to also
    // emit a `triage.requested` ask at this moment and mark the row pending
    // against whether it was delivered; that flow is gone (2026-08-24). The
    // lead learns a row needs placing from the events it already receives —
    // `task.created` on the workspace channel while it is attached, and the
    // `untriaged` list in its next attach payload otherwise — so a marker
    // grounded in one in-flight send bought nothing a restart did not erase.
    if (opts.goal === undefined) task.unplacedSince = now;

    this.p.scheduleSave(workspaceId);
    this.p.emit({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      task,
      goal: task.goal,
      assignee: task.assignee,
      ...(task.triagedAgainst !== undefined ? { triagedAgainst: task.triagedAgainst } : {}),
      ...(opts.actor !== undefined
        ? {
            actor: {
              id: opts.actor.id,
              name: opts.actor.name,
              kind: classifyActor(opts.actor),
            },
          }
        : {}),
      ts: now,
    });
    return {
      ok: true,
      task,
      placement: { placed: opts.goal !== undefined },
      ...(shapeGaps !== undefined ? { shapeGaps } : {}),
    };
  }

  /**
   * THE CHOKE POINT for "this row got a name" — the ONLY assignment of
   * `task.title` in the store, and every door into a title converges on it.
   *
   * There were three assignment sites before this: the `createTask` object
   * literal, `renameTask`, and `noteBodyEdited`. Seven doors sit above them
   * (`create_tasks` single and batch, `promote_to_task`,
   * `import_tasks_markdown`, the board's inline rename, `rewrite_task`,
   * and `set_doc_content` on a `task:<id>` room), and no two of them share a
   * reading — `parseTaskCreate` fronts two, promote and import build their
   * own. So a title standard enforced at any one door would be a guarantee
   * for that door's callers only, which is exactly how the `quote`
   * preservation came to be skipped by the one caller that mattered.
   *
   * What it stamps is the pair of marks a reviewer reads a rename against:
   * WHEN the row was named, and WHAT the description said at the time. Both
   * reset here and nowhere else, so "the title has been re-authored" has one
   * writer and cannot disagree with itself. The marks are part of the
   * capture record — the soft-delete guarantee — not a format check.
   *
   * Deliberately NOT a validator. Nothing is refused, rewritten, or
   * normalized on the way through — the standard's judgment lives in the
   * lead's reviewing pass, which the row's own `task.created` /
   * `task.retitled` / `task.body_written` event is what summons — so a raw
   * capture still lands.
   */
  private applyTitle(task: Task, title: string): void {
    // A named row is no longer untitled — UNCONDITIONALLY. A person naming
    // the row is the signal, whatever text they gave; the placeholder
    // literal is never compared against. This used to clear only when the
    // text differed from the stored title, and an unnamed row's stored
    // title IS the placeholder, so naming it "Untitled task" kept the flag
    // — and a flagged row's rename box shows blank, so it could never be
    // named again. The create (the one write that is a stamp, not a naming)
    // flags the row after this returns.
    task.untitled = undefined;
    task.title = title;
    task.titleWrittenAt = Date.now();
    task.titleHead = bodyHead(task.body);
    bumpWordsRevision(task);
  }

  /**
   * Rename a task — the board's in-place title edit (§3.9: tap the title
   * text, Enter commits). No event fires: §3.6's exhaustive table has no
   * task.renamed row, so callers (the route) must refresh the projection by
   * hand, the same pattern as attachDoc and a triage confirm-in-place.
   */
  renameTask(
    taskId: string,
    title: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): RenameTaskResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    // A same-text rename is a no-op — UNLESS the row is unnamed, where the
    // stored title is only the placeholder and the write is the person
    // naming it. That write must reach the choke point to clear the flag.
    if (task.title === title && !task.untitled) return { ok: true, task, changed: false };
    const titleFrom = task.title;
    this.applyTitle(task, title);
    const ts = Date.now();
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);
    // Naming an unnamed row with its own placeholder text changed the flag,
    // not the title: nothing to retitle in the feed.
    if (titleFrom === task.title) return { ok: true, task, changed: true };
    // Attributed, with both ends: after a rename the old title — the only
    // name the person who filed the row would recognise — survives nowhere
    // else on the board. “changed: false” returns above emit nothing.
    this.p.emit({
      type: 'task.retitled',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      titleFrom,
      titleTo: task.title,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Record that somebody replaced a task's description — and, when the same
   * act gave the row a new title, retitle it here rather than in a second
   * call. The markdown itself lives in the `task:<id>` doc room and reaches
   * this store as a snapshot, so this does not take it; what this provides is
   * the half `set_doc_content` on the body room never could (a doc edit knows
   * nothing about tasks): an attributed audit row, the body clock, the
   * preserved original, and the title.
   *
   * The title rides along because SHAPING is one act. A capture arrives with a
   * machine-clipped fragment for a title and its whole utterance for a body,
   * and triage turns both into a task worth picking up; splitting that across
   * `/title` (which deliberately emits nothing — it is the board's inline
   * edit) and `/body` would leave the half a reader most notices invisible in
   * the activity feed. Passing no `title` leaves the title alone, so every
   * existing caller keeps its meaning.
   *
   * This does NOT preserve the row's prior words — `updateBodySnapshot` does,
   * at the choke point every writer of a body passes through. It used to
   * happen here, taking the pre-rewrite title and body as a required
   * parameter so a new call site could not quietly skip it. That guard worked
   * exactly as far as it could reach and no further: `set_doc_content` on the
   * `task:<id>` room never called this method at all, so it destroyed the
   * capture with nothing preserved and nothing recorded, and the caller and
   * the board both saw success. A parameter can only bind the callers who
   * call you. So `quote` now has ONE writer, sitting where the body actually
   * changes, and this method is left with the half only a route can do:
   * saying WHO, and when.
   *
   * The predicate over there is `quote` being empty and NOTHING else. The
   * obvious second clause — "and this row has never been rewritten", i.e.
   * `bodyWrittenAt === undefined` — is unusable and looks correct:
   * `updateBodySnapshot` stamps `bodyWrittenAt` on every real body change, so
   * the clause is false by the time anything downstream reads it. It silently
   * preserved nothing, ever. Emptiness of `quote` is the honest question
   * anyway — "does anything hold this row's own words yet".
   */
  noteBodyEdited(
    taskId: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** The title this act gives the row. Omit to leave it unchanged. */
      title?: string;
      /** Why the rewriter changed it — rides the audit row verbatim. */
      reason?: string;
    },
  ): boolean {
    const task = this.p.getTask(taskId);
    if (!task) return false;
    const ts = Date.now();
    const titleFrom = task.title;
    const nextTitle = opts.title?.trim();
    // An unnamed row's stored title is the placeholder; a shaping pass that
    // hands back the same text is still the row being named.
    if (nextTitle && (nextTitle !== titleFrom || task.untitled)) this.applyTitle(task, nextTitle);
    task.updatedAt = ts;
    task.bodyWrittenAt = ts;
    bumpWordsRevision(task);
    this.p.scheduleSave(task.workspaceId);
    this.p.emit({
      type: 'task.body_edited',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      // Both ends, only when the title actually moved. A reader of the trail
      // needs the old one to recognise the row they filed: "rewrote X" says
      // nothing when X is a title they have never seen.
      ...(task.title !== titleFrom ? { titleFrom, titleTo: task.title } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ts,
    });
    return true;
  }

  /**
   * Refresh a task's markdown body snapshot from its live `task:<taskId>`
   * doc room (the projection's debounced flush). The snapshot is for search
   * and export only — it never re-seeds a live fragment (§3.3) — so this
   * emits NO event and deliberately does not bump `updatedAt`: body typing
   * is content activity, and the live doc room already announces it.
   */
  updateBodySnapshot(taskId: string, body: string): boolean {
    const task = this.p.getTask(taskId);
    if (!task) return false;
    if (task.body === body) return true;
    // THE CHOKE POINT for "this row's description was replaced". Every door
    // into a task body converges here — `rewrite_task`, `set_doc_content`
    // on the `task:<id>` room, `find_and_replace` and the other prose edit
    // tools aimed at that docId, and a person typing on the board — because
    // they all mutate one Yjs fragment and this is what its observer flushes.
    // So the preservation hangs here rather than on any one route: a route
    // guard is only a guarantee for the callers who use that route, and the
    // reason this is being fixed is that one of them didn't.
    //
    // Write-once, predicate `quote` empty and NOTHING else — see the note on
    // `noteBodyEdited`, which used to hold this and could not see the doorways
    // that skipped it. Placed AFTER the equality guard above so a no-op flush
    // (the seed round-trip when a body room is first opened, measured stable)
    // preserves nothing: there is no rewrite there to preserve against.
    if (task.quote === undefined) {
      const original = task.body?.trim() || task.title.trim();
      if (original) task.quote = original;
    }
    task.body = body;
    // The one thing this path DOES record: when the description changed.
    // Stamped only on a real change (the equality guard above returns first),
    // so a no-op flush cannot make a stale body look freshly written — which
    // would silently clear the drift notice on exactly the rows that need it.
    task.bodyWrittenAt = Date.now();
    // A body rewrite reads as "somebody reconciled this row with the plan as
    // it now stands": the flag clears and the row re-stamps at the revision
    // it was flagged against, so a STILL-later plan edit flags it again.
    // Here at the choke point rather than on any one route, for the same
    // reason `quote` preservation is.
    if (task.possiblyStale !== undefined) {
      task.originDocRevision = task.possiblyStale.docRevision;
      task.possiblyStale = undefined;
    }
    bumpWordsRevision(task);
    this.p.scheduleSave(task.workspaceId);
    return true;
  }
}
