/**
 * Where a row IS, and who holds it: the one status gate, the two reader
 * functions it consults, and the three field verbs that hand a row over
 * (`setAssignee`, `setDueAt`, and the legacy-park clear).
 *
Split out of `tasks.ts` with the other four verb families. `transition`
 * and `setAssignee` are one file because they are the pair the gate's
 * contract is stated against — re-assigning is deliberately NOT progress,
 * and the two sitting apart is how that stops being obvious.
 *
 * `openBlockers` and `announceUnblocked` are module FUNCTIONS rather than
 * methods, because `task-archive.ts` needs both: an archive takes a row out
 * of the open set exactly as finally as a close does, and the dependants it
 * frees have to be told by the same derivation the gate uses. A second
 * implementation over there is precisely the drift this shape prevents.
 */
import type { Task, TaskActor, TaskStatus, TaskTransition } from '@feedback/core/task-wire';
import { isTaskStatus } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import { isArchived } from './task-fields.ts';
import { isGoalRow } from './task-helpers.ts';
import { declaredAssigneeKind } from './task-owner.ts';
import type {
  BoardRow,
  GoalRow,
  LegacyParkFields,
  SetAssigneeResult,
  TaskAssignedEvent,
  TaskDueSetEvent,
  TaskTransitionedEvent,
  TaskUnblockedEvent,
  TransitionBlocker,
  TransitionResult,
  WorkspaceState,
} from './tasks.ts';

/**
 * The four rows this file announces.
 *
 * Narrower than `TaskStoreEvent` on purpose, the same reasoning as
 * `GoalStoreEvent`. Assignable INTO `TaskStoreEvent`.
 */
export type TaskLifecycleEvent =
  | TaskTransitionedEvent
  | TaskUnblockedEvent
  | TaskAssignedEvent
  | TaskDueSetEvent;

/** The one row lookup `openBlockers` needs. Kept this narrow so a caller
 *  that only wants the blocker list does not have to satisfy the whole
 *  lifecycle contract. */
export interface BlockerReader {
  getTask(taskId: string): Task | undefined;
}

/** What `announceUnblocked` reaches: the rows of one workspace, the same
 *  `getTask` the blocker derivation uses, and the one event it emits. */
export interface UnblockReader extends BlockerReader {
  state(workspaceId: string): WorkspaceState | undefined;
  emit(event: TaskUnblockedEvent): void;
}

/** What a lifecycle verb may reach in the store. Every row handed back is
 *  LIVE — mutated in place, then handed to `scheduleSave`. */
export interface TaskLifecyclePersistence extends UnblockReader {
  getGoalRow(goalId: string): GoalRow | undefined;
  /** The roster id behind a display name — see `TaskStore.rosterIdFor`. */
  rosterIdFor(assignee: string): string | undefined;
  scheduleSave(workspaceId: string): void;
  emit(event: TaskLifecycleEvent): void;
}

/** Open (not-done) dependencies of a task, described so the message can
 *  land verbatim in an agent's context: "blocked by open decision t-x:
 *  'your go'". A dangling id (dep task deleted) can't gate — skipped. */
export function openBlockers(p: BlockerReader, task: Task): TransitionBlocker[] {
  const enforce = new Set(task.afterEnforce ?? []);
  const out: TransitionBlocker[] = [];
  for (const depId of task.after) {
    const dep = p.getTask(depId);
    // Deleted, finished, or archived — none of the three can gate. The
    // archived arm joined the other two when Blocked became a state the
    // board DRAWS: a row held by a ticket that is off the board is held by
    // something its reader cannot see, and nobody is going to finish it.
    // One reading, shared with `@feedback/core/task-blocked` and the queue.
    if (!dep || dep.status === 'done' || isArchived(dep)) continue;
    const noun = dep.needs === 'decision' ? 'decision' : 'task';
    out.push({
      taskId: dep.id,
      title: dep.title,
      status: dep.status,
      ...(dep.needs !== undefined ? { needs: dep.needs } : {}),
      enforce: enforce.has(depId),
      message: `blocked by open ${noun} ${dep.id}: '${dep.title}'`,
    });
  }
  return out;
}

/**
 * Emit `task.unblocked` for every row `closed` was the last open blocker of.
 *
 * Called after a row leaves the open set — a move to `done`, and an archive,
 * which takes it off the board and out of `openBlockers` just as finally.
 * The check is the whole derivation re-run per dependant, not a decrement of
 * a counter: a counter is exactly the stored state this feature was built
 * without, and it would go wrong on the paths that never touch it (a
 * restore, an edge removed by hand, a sidecar loaded from disk).
 *
 * The event is the TRANSITION from "waiting on something" to "waiting on
 * nothing", which needs both ends checked, not just the second. Three ways
 * it fired for a row that never came free, all found in review (2026-09-03)
 * and all closed by `wasOpen`:
 *
 *  - archiving a blocker that was already `done` — the dependant was freed
 *    when it closed, sometimes days earlier, and tidying it away said so
 *    again;
 *  - the same on the second of two finished blockers;
 *  - an `after` edge pointed at an already-closed ticket, so the dependant
 *    was never blocked at all, and the eventual archive announced its
 *    release.
 *
 * `wasOpen` is what the caller knows and this cannot see: whether `closed`
 * counted as an open blocker in the instant BEFORE the write. Both callers
 * read it off the row's pre-write state.
 *
 * Silent when the dependant still waits on something else — coming free is
 * the event, not one blocker of three closing — and silent for a dependant
 * that is itself done or archived, which has no work left to be released to.
 */
export function announceUnblocked(
  p: UnblockReader,
  closed: Task,
  actor: TaskActor,
  ts: number,
  wasOpen: boolean,
): void {
  if (!wasOpen) return;
  const state = p.state(closed.workspaceId);
  if (!state) return;
  for (const dependant of state.tasks.values()) {
    if (!dependant.after.includes(closed.id)) continue;
    if (isArchived(dependant)) continue;
    // A finished row is not released by anything: whatever it waited on, it
    // went ahead without it.
    if (dependant.status === 'done') continue;
    // Re-read through the gate's own reader, so "is it still blocked" has
    // exactly one implementation.
    if (openBlockers(p, dependant).length > 0) continue;
    p.emit({
      type: 'task.unblocked',
      workspaceId: dependant.workspaceId,
      taskId: dependant.id,
      clearedBy: closed.id,
      clearedByTitle: closed.title,
      actor,
      ts,
    });
  }
}

/** The status gate and the hand-over verbs. One per `TaskStore`,
 *  holding no state of its own. */
export class TaskLifecycleStore {
  constructor(private readonly p: TaskLifecyclePersistence) {}

  /**
   * The single gate for status changes (§3.10). Every change is attributed
   * (`classifyActor` decides person vs agent — the same line the reply-reopens
   * rule draws, reused rather than reinvented) and appended to the task's
   * audit trail.
   *
   * Gate semantics, in order:
   *  - unknown task / unknown status / no-op same-status → validation errors.
   *  - a GOAL row holds `triage` on the same terms a task does, and this gate
   *    is the only door into it. It used to be refused here
   *    (`goal-not-triageable`) on the reasoning that triage is a claim about a
   *    TASK and a goal is "neither filed by an agent nor dispatched". The
   *    second half was wrong: a band is dispatched transitively, because every
   *    task in it inherits its priority — so an un-agreed band hands its rows
   *    to a dispatcher on the strength of an agreement nobody made. Triage on
   *    a goal closes that one level up, and `buildQueue` is where it bites.
   *  - moving FORWARD (to in-progress or done) consults `after`: open
   *    dependencies come back as `blockers` in the result; an edge marked
   *    enforce refuses outright. Moving back to todo never consults the gate
   *    (undoing work must not be blockable).
   *  - moving OUT of triage is not a special case and gets no special verb:
   *    it is an ordinary move, attributed like any other, and the trail entry
   *    the gate already writes (`from: 'triage'`, plus who and when) IS the
   *    record that somebody vetted the row. `to: 'todo'` is a backward move
   *    and therefore unblockable; `to: 'in-progress'` is forward and consults
   *    `after` like any other forward move, which is correct — starting work
   *    a dependency holds back is the thing that gate exists to stop.
   *  - there is no longer a risk arm. `riskTier` gated an agent's forward
   *    move (red refused, yellow needed `confirmed: true`) until 2026-08-18;
   *    the reasoning for removing it, and what is deliberately still accepted
   *    on the wire, is in the note where `riskRefusal` used to be.
   */
  transition(
    taskId: string,
    to: TaskStatus,
    opts: {
      actor: { id: string; name: string; kind?: string };
      note?: string;
      usage?: { inputTokens: number; outputTokens: number };
      /** Accepted and IGNORED since 2026-08-18. It carried the human's live
       *  confirmation for a yellow-tier forward move; the risk gate is gone,
       *  but peers on older bundles keep sending this until they restart and
       *  a payload that suddenly fails validation is how a removal breaks
       *  them. Do not turn this into a rejection. */
      confirmed?: boolean;
      /** Accepted and IGNORED since 2026-08-25, on the same terms as
       *  `confirmed` and for the same reason — an older bundle attaches proof
       *  to every forward move and cannot be restarted from here. It is not
       *  recorded, and the transition it lands on carries nothing from it. */
      evidence?: unknown;
    },
  ): TransitionResult {
    // Resolves a goal row as readily as a task, which is the whole of what
    // this feature needed on the wire: a goal moves through THIS gate, so
    // `POST /api/tasks/:id/transition` already reaches one and no new
    // shared-server route had to be added for old bundles to miss.
    const task = this.findRow(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isTaskStatus(to)) return { ok: false, error: 'bad-status' };
    if (task.status === to) {
      return {
        ok: false,
        error: 'same-status',
        message: `${task.title} is already ${to}. Nothing to do — a status change is the only thing this gate records, and the row is already there.`,
      };
    }

    // A plan draft may not leave triage by ANY door — that is the whole of
    // what the hold means. The release is the plan's approval
    // (`POST /api/docs/:id/plan`), which clears the hold and moves the row
    // itself; archiving stays available (it is not a status). Goals never
    // carry the field, so `isGoalRow` rows pass untouched.
    if (!isGoalRow(task) && task.planHold !== undefined) {
      return {
        ok: false,
        error: 'plan-unapproved',
        message:
          `${task.title} is a draft derived from a plan doc (${task.planHold.docId}) that has not been approved. ` +
          'It stays in triage until the plan is approved — which releases it — or the row is archived.',
      };
    }

    const forward = to === 'in-progress' || to === 'done';
    // A task's open dependencies; a goal's open children. Different question,
    // same answer shape, and deliberately the same advisory/enforcing split
    // rather than a second notion of blocked.
    const blockers = forward
      ? isGoalRow(task)
        ? this.openChildren(task)
        : openBlockers(this.p, task)
      : [];
    const enforced = blockers.filter((b) => b.enforce);
    if (enforced.length > 0) {
      return { ok: false, error: 'blocked', blockers };
    }

    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // The risk arm of the gate used to sit here — see the note where
    // `riskRefusal` was, below `openBlockers`. `opts.confirmed` is still read
    // off the wire and deliberately goes nowhere: older peers keep sending it.
    // Whether this row was itself gating anything in the instant before the
    // write — read here, because one line down its status is the new one.
    const wasOpenBlocker = task.status !== 'done' && !isArchived(task);
    const entry: TaskTransition = {
      ts: Date.now(),
      from: task.status,
      to,
      by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    };
    task.transitions.push(entry);
    task.status = to;
    task.updatedAt = entry.ts;
    this.p.scheduleSave(task.workspaceId);

    this.p.emit({
      type: 'task.transitioned',
      workspaceId: task.workspaceId,
      taskId: task.id,
      ...(isGoalRow(task) ? { kind: 'goal' as const } : {}),
      from: entry.from,
      to,
      actor: by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
      ts: entry.ts,
    });
    // Whatever was waiting on this row and is now waiting on nothing. AFTER
    // the transition event, so the trail reads in the order it happened: the
    // blocker closed, and then its dependants came free.
    if (!isGoalRow(task) && to === 'done') {
      announceUnblocked(this.p, task, by, entry.ts, wasOpenBlocker);
    }
    return { ok: true, task, blockers };
  }

  /**
   * Hand a task to someone else — 'human', 'agent', or a named identity.
   * Emits `task.assigned` (§3.6) with BOTH ends, because the reviewable fact
   * is the direction of the hand-off. Deliberately does NOT touch status:
   * re-assigning is not progress, and conflating the two would let a hand-off
   * slip past the transition gate.
   */
  setAssignee(
    taskId: string,
    assignee: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** Declares what the new owner IS. Omitted, the kind is re-derived from
       *  the caller — which for a hand-over to somebody ELSE means it is
       *  CLEARED rather than inherited from the previous owner. Re-stating
       *  the same owner keeps whatever was already declared. */
      assigneeKind?: unknown;
    },
  ): SetAssigneeResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const from = task.assignee;
    const declared = declaredAssigneeKind(assignee, opts.assigneeKind, opts.actor);
    // Re-stating the SAME owner without saying what they are must not erase
    // what somebody already declared. Every caller that predates this field
    // sends no `assigneeKind`, so without this an ordinary re-assign would
    // silently downgrade a declared person to "not recorded" — a write that
    // changes nothing a caller asked to change. A hand-over to a DIFFERENT
    // name still clears it: the new owner's kind is genuinely unknown, and
    // inheriting the old one would assert something nobody said.
    const kind = declared ?? (from === assignee ? task.assigneeKind : undefined);
    // A kind-only change is a real change. Without the second clause,
    // declaring that the person who already holds this task IS a person
    // would be swallowed as a no-op, and the one call that closes the gap
    // for an existing row would do nothing while answering ok:true.
    if (from === assignee && task.assigneeKind === kind) return { ok: true, task, changed: false };
    const ts = Date.now();
    task.assignee = assignee;
    // Re-resolved from the NEW name, never carried over: the previous
    // owner's id on a row handed to somebody the roster cannot place would
    // keep routing their queue reads to the old owner.
    const assigneeId = this.p.rosterIdFor(assignee);
    if (assigneeId === undefined) task.assigneeId = undefined;
    else task.assigneeId = assigneeId;
    if (kind === undefined) task.assigneeKind = undefined;
    else task.assigneeKind = kind;
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);
    this.p.emit({
      type: 'task.assigned',
      workspaceId: task.workspaceId,
      taskId: task.id,
      from,
      to: assignee,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Set, move, or clear a task's due date.
   *
   * Bryan, 2026-08-18: *"All fields must be human editable. But I expect
   * they'll be mostly set by agents going forward. Trust but verify… sometimes
   * having me edit a thing is the fastest way to fix."* `dueAt` was writable
   * only at creation, so the detail panel rendered a field nobody could
   * correct — the same gap `setAssignee` closed for the owner.
   *
   * `null` clears. An unchanged value returns `changed: false` and emits
   * nothing: a repaint that re-sends the date already on the row is not an
   * edit, and an audit row saying so is noise in every feed.
   */
  setDueAt(
    taskId: string,
    dueAt: number | null,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const from = task.dueAt ?? null;
    if (from === dueAt) return { ok: true, task, changed: false };
    const ts = Date.now();
    if (dueAt === null) task.dueAt = undefined;
    else task.dueAt = dueAt;
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);
    this.p.emit({
      type: 'task.due_set',
      workspaceId: task.workspaceId,
      taskId: task.id,
      from,
      to: dueAt,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Drop the two fields a row carried while `parked` was a state, once the
   * startup migration has lifted them into a comment.
   *
   * The ONLY writer of `LegacyParkFields`, and it only ever unsets them. The
   * park metadata is not destroyed by this call — the comment the migration
   * wrote is where it now lives, which is what makes the clear safe to run
   * and what keeps the project's never-hard-delete rule true for it.
   *
   * Returns what it cleared, so the caller can report a migration honestly
   * rather than counting rows it hoped it touched.
   */
  clearLegacyPark(taskId: string): LegacyParkFields | null {
    const task = this.p.getTask(taskId) as (Task & LegacyParkFields) | undefined;
    if (!task) return null;
    const had: LegacyParkFields = {
      ...(task.parkedUntil !== undefined ? { parkedUntil: task.parkedUntil } : {}),
      ...(task.parkedReason !== undefined ? { parkedReason: task.parkedReason } : {}),
    };
    if (had.parkedUntil === undefined && had.parkedReason === undefined) return null;
    // Assignment rather than `delete` (biome noDelete); JSON.stringify drops
    // an undefined-valued key entirely, so the sidecar comes back without it.
    task.parkedUntil = undefined;
    task.parkedReason = undefined;
    this.p.scheduleSave(task.workspaceId);
    return had;
  }

  /**
   * A row by id, task or goal — the lookup the transition gate uses.
   *
   * Deliberately NOT `getTask`, which stays tasks-only. `getTask` has dozens
   * of callers and every one of them is a task verb; widening it would put
   * goal rows in reach of `assign_task`, `set_task_goal` and the rest by id
   * alone. Only the gate needs to see both, so only the gate gets a lookup
   * that does.
   */
  private findRow(id: string): BoardRow | undefined {
    return this.p.getTask(id) ?? this.p.getGoalRow(id);
  }

  /**
   * A goal's open children, reported so a declaration can be made with them
   * in view — never to refuse it.
   *
   * `enforce: false` on every row, unconditionally, and that is the feature
   * rather than a default: a goal is done because somebody says so, and the
   * children are reported, not enforced. There is deliberately no opt-in to
   * make one of these enforcing, because an enforcing child edge would make
   * `done` derived again through the back door — the goal could only be
   * closed once its children were, which is exactly the roll-up rule Bryan
   * ruled out.
   */
  private openChildren(goal: GoalRow): TransitionBlocker[] {
    const state = this.p.state(goal.workspaceId);
    if (!state) return [];
    const out: TransitionBlocker[] = [];
    for (const task of state.tasks.values()) {
      if (task.goal !== goal.id || task.status === 'done') continue;
      if (isArchived(task)) continue;
      const noun = task.needs === 'decision' ? 'decision' : 'task';
      out.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        ...(task.needs !== undefined ? { needs: task.needs } : {}),
        enforce: false,
        message: `still open in this goal — ${noun} ${task.id}: '${task.title}'`,
      });
    }
    return out;
  }
}
