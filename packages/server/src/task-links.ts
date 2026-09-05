/**
 * Every edge out of a task: the `after` dependency edges the transition gate
 * reads, and the `links` / `origin` cross-references the board draws as
 * chips.
 *
 * Split out of `tasks.ts` with the other four verb families. Dependencies
 * and refs are one file because they are the same question asked twice —
 * "what else does this row point at" — and because the two doc-driven
 * sweeps at the end (`flagStaleFromDocEdit` and `releasePlanHolds`) read
 * `origin` and `planHold` while writing status,
 * so a split would put one walk over every workspace's rows in one file and
 * its twin in another.
 *
 * Neither family emits a store event: §3.6's table is exhaustive by contract
 * and has no row for a link change or a dependency edit, so the ROUTE layer
 * refreshes the ydoc projection by hand — the same pattern `renameTask` and
 * `attachDoc` follow. The one exception is `releasePlanHolds`, which releases
 * through the ordinary transition gate and therefore emits whatever that
 * gate emits.
 */
import type { Ref, Task } from '@feedback/core/task-wire';
import { isArchived } from './task-fields.ts';
import { isValidRef, refKey } from './task-helpers.ts';
import type {
  GoalRow,
  LinkRefResult,
  SetDependenciesResult,
  TransitionResult,
  UnlinkRefResult,
  WorkspaceState,
} from './tasks.ts';

/** What a link or dependency verb may reach in the store. Every row handed
 *  back is LIVE — mutated in place, then handed to `scheduleSave`. */
export interface TaskLinksPersistence {
  state(workspaceId: string): WorkspaceState | undefined;
  states(): Iterable<WorkspaceState>;
  getTask(taskId: string): Task | undefined;
  getGoalRow(goalId: string): GoalRow | undefined;
  scheduleSave(workspaceId: string): void;
  /** The status gate — `releasePlanHolds` moves a released draft through it
   *  rather than writing `status` itself, so the row's trail records who
   *  approved the plan. */
  transition(
    taskId: string,
    to: 'todo',
    opts: { actor: { id: string; name: string; kind?: string }; note?: string },
  ): TransitionResult;
}

/** Dependency edges and cross-references. One per `TaskStore`, holding no
 *  state of its own. */
export class TaskLinksStore {
  constructor(private readonly p: TaskLinksPersistence) {}

  /**
   * Replace a task's dependency edges after it was created.
   *
   * This did not exist, and its absence is what made urgency underivable:
   * "this decision is blocking work now" is the same fact as "something
   * depends on it", `after` already records that, and `after` could only ever
   * be set at creation — when the decision being waited on often doesn't
   * exist yet. Every decision on the real board therefore had an empty
   * `after`, and nothing could tell blocking from merely deferred.
   *
   * Replaces rather than appends, so an edge can be REMOVED — a dependency
   * that turned out not to exist is exactly as misleading as a missing one.
   * No store event fires (§3.6's table has no row for it), so the route
   * refreshes the projection by hand, the same contract as renameTask.
   */
  setDependencies(
    taskId: string,
    edges: { after: string[]; afterEnforce?: string[] },
    _opts: { actor: { id: string; name: string; kind?: string } },
  ): SetDependenciesResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const state = this.p.state(task.workspaceId);
    if (!state) return { ok: false, error: 'not-found' };

    const after = [...new Set(edges.after)];
    for (const dep of after) {
      // Self first: `state.tasks.has(task.id)` is true, so a self-edge would
      // pass the existence check and then block the task on itself forever.
      if (dep === taskId) return { ok: false, error: 'self-dependency' };
      // Same workspace only — a cross-workspace id resolves in `getTask` but
      // not in this board's `tasks` map, so the gate would skip it silently.
      if (!state.tasks.has(dep)) return { ok: false, error: 'unknown-after' };
    }
    const afterEnforce = [...new Set(edges.afterEnforce ?? [])];
    for (const dep of afterEnforce) {
      if (!after.includes(dep)) return { ok: false, error: 'unknown-after-enforce' };
    }

    // A ring of edges is a row waiting on itself the long way round: every
    // task in it is Blocked, none can ever clear, and `next_tasks` quietly
    // empties. The self-edge check above is the length-one case of this one;
    // this is every longer one. Walk each proposed blocker's own `after`
    // transitively and refuse if the walk arrives back at the row being
    // written.
    for (const dep of after) {
      const path = this.pathTo(dep, taskId, state);
      if (path) {
        // `path` runs from the proposed blocker back to this row, so the ring
        // opens and closes on the row being written: A wait on B wait on A.
        const ring = [taskId, ...path];
        const named = ring.map((id) => `'${this.p.getTask(id)?.title ?? id}'`).join(' waiting on ');
        return {
          ok: false,
          error: 'cycle',
          cycle: ring,
          message: `that edge would close a loop: ${named}`,
        };
      }
    }

    const same =
      task.after.length === after.length &&
      task.after.every((d) => after.includes(d)) &&
      (task.afterEnforce ?? []).length === afterEnforce.length &&
      (task.afterEnforce ?? []).every((d) => afterEnforce.includes(d));
    if (same) return { ok: true, task, changed: false };

    task.after = after;
    if (afterEnforce.length > 0) task.afterEnforce = afterEnforce;
    else task.afterEnforce = undefined;
    task.updatedAt = Date.now();
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * The chain of `after` edges from `fromId` to `targetId`, or null when
   * there is none — the cycle detector behind `setDependencies`.
   *
   * Depth-first with a seen set, so a ring that already exists in the store
   * (written before this check did) cannot spin here forever. Ids naming rows
   * this workspace does not hold are skipped, which is the same reading every
   * other consumer of `after` takes: a dangling edge gates nothing, so it can
   * close nothing either.
   */
  private pathTo(
    fromId: string,
    targetId: string,
    state: { tasks: Map<string, Task> },
  ): string[] | null {
    const seen = new Set<string>();
    const walk = (id: string): string[] | null => {
      if (seen.has(id)) return null;
      seen.add(id);
      const row = state.tasks.get(id);
      if (!row) return null;
      if (id === targetId) return [id];
      for (const next of row.after) {
        const rest = walk(next);
        if (rest) return [id, ...rest];
      }
      return null;
    };
    return walk(fromId);
  }

  // ── Cross-references (§3.2 Ref; §3.12 commit 4) ──────────────────────────
  //
  // Links are stored on the task; backlinks are COMPUTED on read, never
  // stored, so the two directions can't drift. NOTE: link changes emit no
  // store event — §3.6's exhaustive table has no row for them — so the route
  // layer refreshes the ydoc projection by hand, the same pattern as
  // createWorkspace/attachDoc.

  /**
   * Add a cross-reference to a task's `links`. Idempotent: linking a ref
   * that's already there reports `changed: false` and touches nothing.
   * A task may not link itself (`self-ref`).
   */
  linkRef(taskId: string, ref: Ref): LinkRefResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isValidRef(ref)) return { ok: false, error: 'bad-ref' };
    if (ref.kind === 'task' && ref.taskId === taskId) return { ok: false, error: 'self-ref' };
    const key = refKey(ref);
    if (task.links.some((r) => refKey(r) === key)) return { ok: true, task, changed: false };
    task.links.push(ref);
    task.updatedAt = Date.now();
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * The goal half of `linkRef`: add a cross-reference to a goal row's
   * `links`. Same idempotency contract; a goal cannot self-ref (its own id
   * is a task-kind ref, refused for symmetry with `linkRef`).
   */
  linkGoalRef(
    goalId: string,
    ref: Ref,
  ):
    | { ok: true; goal: GoalRow; changed: boolean }
    | { ok: false; error: 'not-found' | 'bad-ref' | 'self-ref' } {
    const goal = this.p.getGoalRow(goalId);
    if (!goal) return { ok: false, error: 'not-found' };
    if (!isValidRef(ref)) return { ok: false, error: 'bad-ref' };
    if (ref.kind === 'task' && ref.taskId === goalId) return { ok: false, error: 'self-ref' };
    const key = refKey(ref);
    if ((goal.links ?? []).some((r) => refKey(r) === key))
      return { ok: true, goal, changed: false };
    goal.links = [...(goal.links ?? []), ref];
    goal.updatedAt = Date.now();
    this.p.scheduleSave(goal.workspaceId);
    return { ok: true, goal, changed: true };
  }

  /** Remove a cross-reference. Removing one that isn't there is a no-op
   *  (`changed: false`), not an error — the end state is what was asked for. */
  unlinkRef(taskId: string, ref: Ref): UnlinkRefResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isValidRef(ref)) return { ok: false, error: 'bad-ref' };
    const key = refKey(ref);
    const next = task.links.filter((r) => refKey(r) !== key);
    if (next.length === task.links.length) return { ok: true, task, changed: false };
    task.links = next;
    task.updatedAt = Date.now();
    this.p.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * Every task that references `ref` — via `links` or via its promotion
   * `origin` (a task promoted from a thread references that thread without
   * anyone calling link_refs). Exact-ref matching; spans all workspaces,
   * because refs do (a task may cite a doc that lives outside its hub
   * workspace). Deterministic order: creation time, then id.
   */
  backlinksFor(ref: Ref): Task[] {
    const key = refKey(ref);
    return this.tasksMatching((r) => refKey(r) === key);
  }

  /**
   * Doc→task surfacing: tasks that reference the doc itself OR any thread
   * in it — a task promoted from one of a doc's threads is about that doc.
   */
  tasksReferencingDoc(docId: string): Task[] {
    return this.tasksMatching(
      (r) => (r.kind === 'doc' || r.kind === 'thread') && r.docId === docId,
    );
  }

  /** Thread→task surfacing: exact thread-ref matches only. */
  tasksReferencingThread(docId: string, threadId: string): Task[] {
    return this.backlinksFor({ kind: 'thread', docId, threadId });
  }

  /**
   * A plan doc's content moved past the revision some derived rows were
   * stamped at — flag them `possiblyStale`. Wired to the doc store's settled
   * revision bump (`docStore.onContentRevision`); `docIds` carries the canonical
   * id AND the alias because origin refs routinely hold the caller-chosen
   * name. Advisory only: nothing here gates a transition. Open rows only —
   * a done row's premise no longer matters, and an archived one has left the
   * board. Rows with no `originDocRevision` (predate the field, or the doc
   * was not in memory at create) are skipped rather than guessed at.
   *
   * Emits no store event — §3.6's table is exhaustive by contract — so the
   * CALLER refreshes the ydoc projection for the returned workspaces, the
   * same pattern as `linkRef`.
   */
  flagStaleFromDocEdit(docIds: string[], revision: number): Set<string> {
    const ids = new Set(docIds);
    const touched = new Set<string>();
    for (const state of this.p.states()) {
      for (const task of state.tasks.values()) {
        if (task.status === 'done' || isArchived(task)) continue;
        const o = task.origin;
        if (!isValidRef(o) || (o.kind !== 'doc' && o.kind !== 'thread')) continue;
        if (!ids.has(o.docId)) continue;
        if (task.originDocRevision === undefined) continue;
        if (task.originDocRevision >= revision) continue;
        if (task.possiblyStale?.docRevision === revision) continue;
        task.possiblyStale = { docRevision: revision, ts: Date.now() };
        touched.add(task.workspaceId);
        this.p.scheduleSave(task.workspaceId);
      }
    }
    return touched;
  }

  /**
   * The plan was approved: clear every hold pointing at it and release the
   * held rows to `todo` — approval IS the "start the work" gesture the
   * drafts were waiting for, so leaving them in triage would hand the
   * approver a second chore per row. The release goes through the ordinary
   * transition gate (hold cleared first), so each row's trail records who
   * approved and the projection refreshes off the emitted events. A held row
   * that is archived, or that somebody already moved before holds existed,
   * just loses the hold.
   *
   * Returns the released task ids plus every workspace whose rows changed —
   * the caller refreshes projections for holds cleared WITHOUT a transition
   * (clearing alone emits nothing).
   */
  releasePlanHolds(
    docIds: string[],
    actor: { id: string; name: string; kind?: string },
  ): { released: string[]; workspaceIds: Set<string> } {
    const ids = new Set(docIds);
    const released: string[] = [];
    const workspaceIds = new Set<string>();
    for (const state of this.p.states()) {
      for (const task of state.tasks.values()) {
        if (task.planHold === undefined || !ids.has(task.planHold.docId)) continue;
        task.planHold = undefined;
        task.updatedAt = Date.now();
        workspaceIds.add(task.workspaceId);
        this.p.scheduleSave(task.workspaceId);
        if (task.status === 'triage' && !isArchived(task)) {
          const moved = this.p.transition(task.id, 'todo', {
            actor,
            note: 'Plan approved — draft released to the queue.',
          });
          if (moved.ok) released.push(task.id);
        }
      }
    }
    return { released, workspaceIds };
  }

  /**
   * Tasks whose `links` or `origin` contain a ref matching `pred`.
   *
   * Every ref is re-validated on the way past. `pred` is usually built on
   * `refKey`, which reads `ref.kind` and throws on anything that isn't a
   * ref — and this loop spans EVERY workspace, so one malformed ref stored
   * anywhere took down every caller: `tasksReferencingDoc` sits on the
   * doc-open path and on thread listing. `origin` used to be written to
   * `<ws>.tasks.json` unvalidated (the route cast instead of checking), so
   * `origin: null` persisted, survived restart, and made doc-open 500 —
   * `task.origin !== undefined` is true for `null`. The route now validates;
   * this guard is what keeps already-persisted junk from being fatal.
   */
  private tasksMatching(pred: (ref: Ref) => boolean): Task[] {
    const out: Task[] = [];
    for (const state of this.p.states()) {
      for (const task of state.tasks.values()) {
        const matches =
          task.links.some((r) => isValidRef(r) && pred(r)) ||
          (isValidRef(task.origin) && pred(task.origin));
        if (matches) out.push(task);
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }
}
