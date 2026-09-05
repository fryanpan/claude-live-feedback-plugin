/**
 * The goal bands a board ranks its work into: the list itself, renaming a
 * band, adding one, reordering them, and placing a task under one.
 *
 * Split out of `tasks.ts` — the third of the store's four responsibilities.
 * It reads and writes task rows, but only their `goal` and `position`, and
 * everything it needs from the store arrives through `GoalStorePersistence`.
 *
 * Placement IS triage here, which is why the file is a unit: `setTaskGoal`,
 * `setGoalList` and `reorderGoals` all have to agree about what a band
 * change does to the rows sitting in it, and they agree by being read
 * together.
 *
 * The reserved-id constants, `sequenceAfter` and `newGoalId` live here for
 * the reason `isRetired` lives in `workspace-store.ts`: this file may not
 * import a VALUE from the file that imports it. `tasks.ts` imports them back
 * and re-exports them.
 */
import type { GoalListEntry, Task, TaskActor, TaskStatus } from '@feedback/core/task-wire';
import { byBoardOrder } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import { bumpWordsRevision, cryptoId } from './task-fields.ts';
import type {
  AddGoalResult,
  BoardWorkspace,
  RenameGoalResult,
  ReorderGoalsResult,
  SetGoalListResult,
  SetTaskGoalResult,
  TaskRegroupedEvent,
  WorkspaceGoal,
  WorkspaceGoalsChangedEvent,
  WorkspaceState,
} from './tasks.ts';

/**
 * The two rows this file announces.
 *
 * Narrower than `TaskStoreEvent` on purpose, the same reasoning as
 * `ReviewItemStoreEvent`. Assignable INTO `TaskStoreEvent`.
 */
export type GoalStoreEvent = TaskRegroupedEvent | WorkspaceGoalsChangedEvent;

/** Reserved catch-all section id for no-goal work. Never in `goals[]`. */
export const CHORES_GOAL_ID = 'chores';

/**
 * Goal ids the SERVER owns. Every other goal id is generated (`newGoalId`)
 * and opaque; these are literals on purpose, and the distinction is stated
 * here rather than implied so that the next reserved bucket is added to a
 * list instead of to a chain of `=== CHORES_GOAL_ID` comparisons.
 *
 * A reserved id is one that code and agents must be able to SAY without a
 * lookup — `chores` is referenced across this store, named in the shipped
 * skills, and is the answer to "where does unplaced work go". A generated id
 * could not carry that meaning. Reserved ids are therefore exempt from the
 * generation rule, not an oversight in it, and they stay reachable by their
 * literal from every read and every `setTaskGoal`.
 *
 * They are still refused by every WRITE that would create, rename, remove or
 * reorder a goal — a reserved bucket exists, it is not authored.
 */
export const RESERVED_GOAL_IDS: ReadonlySet<string> = new Set([CHORES_GOAL_ID]);

/** Whether `id` is a server-owned bucket rather than an authored goal. */
export function isReservedGoalId(id: string): boolean {
  return RESERVED_GOAL_IDS.has(id);
}

/**
 * The sequence a goal should hold once `moving` is placed directly behind the
 * row `after` names — `null` meaning the top of the goal.
 *
 * `siblings` is the goal's other rows ALREADY in board order. Returns null
 * when `after` names none of them, which is the caller's cue to refuse rather
 * than to guess: a placement relative to a row that is not there is a request
 * whose meaning we do not know, and dropping the row at the bottom (the
 * tempting fallback) is indistinguishable to the person who dragged it from
 * the bug this whole path exists to fix.
 */
export function sequenceAfter<T extends { id: string }>(
  siblings: readonly T[],
  moving: T,
  after: string | null,
): T[] | null {
  let index: number;
  if (after === null) {
    index = 0;
  } else {
    const at = siblings.findIndex((t) => t.id === after);
    if (at === -1) return null;
    index = at + 1;
  }
  return [...siblings.slice(0, index), moving, ...siblings.slice(index)];
}

/**
 * The id of a NEWLY CREATED goal. Opaque and server-generated, exactly like a
 * task id, and for the same reason: an identifier is the one thing that must
 * never move, so nothing about it may encode something that does.
 *
 * The scheme this replaces was caller-supplied slugs (`g1-loop`, `g2-reach`),
 * which put PRIORITY — the fastest-moving property a board has — inside the
 * identity. Renaming a band then meant re-keying it, and re-keying it through
 * the full-replace `setGoalList` reads as one goal removed and a different one
 * added: the band's open tasks swept to Backlog, its done tasks orphaned. The
 * `would-strand-tasks` refusal defends against that; generated ids make it
 * unexpressible, which is the stronger move.
 *
 * Existing slug ids keep working forever — they are just ids. This generates
 * the ones created from here on; nothing renumbers what a board already has.
 */
export function newGoalId(): string {
  return cryptoId('g');
}

/** What a goal verb may reach in the store. Every row handed back is LIVE —
 *  mutated in place, then handed to `scheduleSave`. */
export interface GoalStorePersistence {
  state(workspaceId: string): WorkspaceState | undefined;
  states(): Iterable<WorkspaceState>;
  getTask(taskId: string): Task | undefined;
  goalIdExists(workspace: BoardWorkspace, goalId: string): boolean;
  /** Re-derive the workspace's goal rows after the band list changed. */
  syncGoalRows(state: WorkspaceState, mintStatus: TaskStatus): void;
  scheduleSave(workspaceId: string): void;
  emit(event: GoalStoreEvent): void;
}

/** The goal bands. One per `TaskStore`, holding no state of its own. */
export class GoalStore {
  constructor(private readonly p: GoalStorePersistence) {}

  /**
   * Place a task under a goal at an exact position — the write
   * half of triage (§3.4: the agent picks the exact spot, not just the
   * bucket) and the board's regroup/rerank gesture (§3.3: open to everyone,
   * Bryan AND agents; every move recorded).
   *
   * Placement IS triage, so every call — moved or confirmed in place —
   * stamps `triagedAgainst` with the band it was judged against and clears
   * the triage-pending marker. A goal or position change emits
   * `task.regrouped`; a pure confirm emits nothing — §3.6 has no
   * task.triaged row, and a no-move event would be noise in every feed.
   */
  setTaskGoal(
    taskId: string,
    goal: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** Fractional position within the goal. Omitted → bottom of the goal
       *  (an unchanged goal keeps the current position).
       *
       *  Cannot express a drop between two rows that SHARE an order, which is
       *  the ordinary state of a board nobody has renumbered: any number
       *  greater than the first is also greater than the second, and the
       *  createdAt tiebreak then decides where the row really goes. `after`
       *  below is the spelling that can. This one stays because every caller
       *  built before it — the MCP tools, and any browser tab that has not
       *  reloaded — still sends it, and `after` wins when both arrive. */
      position?: number;
      /** Place the task directly behind the row this names, or at the top of
       *  the goal when `null`. An ID rather than an index because the two
       *  ends count different rows: the board's list is filtered (done
       *  window, "mine" tab) and this one is not. Refused when it names a row
       *  outside the target goal. */
      after?: string | null;
      /** Accepted and IGNORED since 2026-08-18, along with the risk gate that
       *  read it. Older peers keep sending it on every placement until they
       *  restart; the field stays in the signature so those calls type and
       *  succeed rather than 400. */
      riskTier?: 'green' | 'yellow' | 'red';
      /** The `workspace.goals_changed` batch this placement fulfils, echoed from
       *  the triage request. Stamped on `task.regrouped` as `partOf` so the
       *  activity view reads N moves as one goal edit. */
      batchId?: string;
    },
  ): SetTaskGoalResult {
    const task = this.p.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const state = this.p.state(task.workspaceId);
    if (!state) return { ok: false, error: 'not-found' };
    if (!this.p.goalIdExists(state.workspace, goal)) {
      return { ok: false, error: 'unknown-goal' };
    }

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const fromGoal = task.goal;

    // Placement by neighbour renumbers the goal 1..N rather than searching for
    // a float between two rows, because between two rows that share an order
    // there is no such float — and a goal that keeps its ties needs the same
    // step-around on every future drag. So the drop that had to work around a
    // tie is also the drop that removes it. `updatedAt` is deliberately left
    // alone on the rows this shifts: their position relative to each other did
    // not change, and the staleness sweep and the activity feed both read that
    // field as "somebody touched this task".
    let renumbered: Task[] | null = null;
    let order: number;
    if (opts.after !== undefined) {
      const siblings = Array.from(state.tasks.values())
        .filter((t) => t.goal === goal && t.id !== taskId)
        .sort(byBoardOrder);
      const sequence = sequenceAfter(siblings, task, opts.after);
      if (!sequence) return { ok: false, error: 'unknown-after' };
      renumbered = sequence;
      order = sequence.indexOf(task) + 1;
    } else {
      order =
        opts.position ??
        (goal === fromGoal
          ? task.order
          : Math.max(
              0,
              ...Array.from(state.tasks.values())
                .filter((t) => t.goal === goal && t.id !== taskId)
                .map((t) => t.order),
            ) + 1);
    }
    const changed = goal !== fromGoal || order !== task.order;

    task.goal = goal;
    // Only a MOVE, never a reorder: the goal's title is part of what the
    // scorer weighs, the order is not — the same `fromGoal !== toGoal` line
    // the re-score trigger in server.ts draws.
    if (goal !== fromGoal) bumpWordsRevision(task);
    task.order = order;
    if (renumbered) for (const [i, t] of renumbered.entries()) t.order = i + 1;
    task.triagedAgainst = { goalId: goal, ts };
    // Somebody has now named this task's band — including a confirm-in-place
    // into Backlog, which is a judgement rather than a fallback. The owed
    // review is answered, so it must not be asked again.
    task.unplacedSince = undefined;
    task.updatedAt = ts;
    this.p.scheduleSave(task.workspaceId);

    if (changed) {
      this.p.emit({
        type: 'task.regrouped',
        workspaceId: task.workspaceId,
        taskId: task.id,
        fromGoal,
        toGoal: goal,
        order,
        actor,
        ...(opts.batchId !== undefined ? { partOf: opts.batchId } : {}),
        ts,
      });
    }
    return { ok: true, task, changed };
  }

  /**
   * Replace the workspace's ordered goal list (§3.2 goal-list edit contract).
   *
   * WHAT SUBMITTING A LIST MEANS, now that ids are generated: "these are my
   * bands, in this order". An entry that names an `id` is a band the board
   * already has — an id it does not have is REFUSED (`unknown-goal-id`),
   * never created under the caller's name. An entry with no `id` is new, and
   * the server mints an opaque one (`newGoalId`) and reports it in `created`.
   * A caller therefore cannot choose an id, and cannot change one: the two
   * gestures that used to strand a band's work are no longer expressible,
   * where before they were merely refused after the fact. Everything the call
   * always did — reorder, retitle, remove — is untouched, and none
   * of it moves an id.
   *
   * 'chores' is reserved and never present in goals[]; open tasks whose goal
   * id disappears are moved to Backlog, each emitting a
   * `task.regrouped` batched (via `partOf`) under the one
   * `workspace.goals_changed` event, and the result reports the moved ids so
   * the caller can re-place them. Deliberately NO re-triage request fires —
   * a reorder changes no placement's accuracy, and a removal already lands
   * every affected task where the caller is told to look.
   *
   * A DROP THAT WOULD STRAND WORK IS REFUSED unless `drop` names the id.
   * This is a full replace keyed by id, so the natural way to rename a band —
   * submit the list with a new id and the new title — reads here as one goal
   * removed and a different one added: the old band's open tasks swept to
   * Backlog, its done tasks left pointing at an id that is gone, and a
   * successful-looking result. The damage is proportional to how much the
   * band held, and it surfaces days later as "why is my top band empty".
   * `renameGoal` is the non-destructive way to change a title; this guard is
   * what makes the destructive path stop being the DEFAULT one. It fires
   * only for ids that actually hold tasks, so it can never refuse a call
   * that was about to lose nothing.
   */
  setGoalList(
    workspaceId: string,
    entries: GoalListEntry[],
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** Goal ids the caller INTENDS to remove even though they hold
       *  tasks. Consulted only as a lookup set: an entry for an id that is
       *  not being removed does nothing, so it can never widen the replace. */
      drop?: string[];
    },
  ): SetGoalListResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;

    // Resolve every entry to an id BEFORE anything is compared or written:
    // an id the caller named must already exist, and an id the caller omitted
    // is generated here and nowhere else. Both refusals are computed over the
    // whole list first, so a rejected call names every offending id at once
    // rather than making the caller fix them one round trip at a time.
    const existingIds = new Set(workspace.goals.map((g) => g.id));
    const submittedIds: string[] = [];
    const unknownIds: string[] = [];
    const reserved: string[] = [];
    const noteId = (id: string | undefined): void => {
      if (id === undefined) return;
      submittedIds.push(id);
      if (isReservedGoalId(id)) {
        if (!reserved.includes(id)) reserved.push(id);
        return;
      }
      if (!existingIds.has(id) && !unknownIds.includes(id)) unknownIds.push(id);
    };
    for (const g of entries) {
      noteId(g.id);
      for (const s of g.subgoals ?? []) noteId(s.id);
    }
    if (reserved.length > 0) return { ok: false, error: 'reserved-goal-id' };
    if (new Set(submittedIds).size !== submittedIds.length) {
      return { ok: false, error: 'duplicate-goal-id' };
    }
    if (unknownIds.length > 0) return { ok: false, error: 'unknown-goal-id', unknownIds };

    // Materialise the list the board will hold. An entry with no id becomes a
    // new band with a generated one; nothing else about an entry can change
    // an id, because an id is never read from the entry again after this.
    const created: Array<{ id: string; title: string; parent?: string }> = [];
    const goals: WorkspaceGoal[] = entries.flatMap((g) => {
      const id = g.id ?? newGoalId();
      if (g.id === undefined) created.push({ id, title: g.title });
      // A submitted `subgoals` array is still ACCEPTED — the REST route has
      // callers this server cannot restart — but it is never stored. Each
      // entry becomes a band of its own, directly after the one that carried
      // it, which is the position the board already drew it in.
      const nested = (g.subgoals ?? []).map((sub) => {
        const subId = sub.id ?? newGoalId();
        if (sub.id === undefined) created.push({ id: subId, title: sub.title });
        return {
          id: subId,
          title: sub.title,
          ...(sub.dueAt !== undefined ? { dueAt: sub.dueAt } : {}),
        };
      });
      return [
        {
          id,
          title: g.title,
          ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}),
        },
        ...nested,
      ];
    });
    const ids: string[] = goals.map((g) => g.id);

    const oldGoals = workspace.goals;
    if (JSON.stringify(oldGoals) === JSON.stringify(goals)) {
      return {
        ok: true,
        workspace,
        changed: false,
        created: [],
        movedToChores: [],
        strandedDone: [],
      };
    }

    // What this replace would REMOVE, and what each removal holds. Computed
    // before a single byte is written, because a refusal has to leave the
    // board exactly as the caller found it.
    const keptIds = new Set(ids);
    const acknowledged = new Set(opts.drop ?? []);
    const stranding: Array<{ id: string; title: string; openTasks: number; doneTasks: number }> =
      [];
    for (const removed of oldGoals) {
      if (keptIds.has(removed.id) || acknowledged.has(removed.id)) continue;
      let openTasks = 0;
      let doneTasks = 0;
      for (const task of state.tasks.values()) {
        if (task.goal !== removed.id) continue;
        if (task.status === 'done') doneTasks += 1;
        else openTasks += 1;
      }
      // Both halves count. The open one is swept to Backlog (loud-ish, it is
      // reported); the done one silently orphans, and is the half nothing
      // used to mention.
      if (openTasks + doneTasks > 0) {
        stranding.push({ id: removed.id, title: removed.title, openTasks, doneTasks });
      }
    }
    if (stranding.length > 0) return { ok: false, error: 'would-strand-tasks', stranding };

    // Same members in a different order = the priority gesture; anything
    // else (add / remove / retitle / dueAt) = an edit. Sorting by id makes
    // the comparison order-blind.
    const sortById = (gs: WorkspaceGoal[]) =>
      JSON.stringify([...gs].sort((a, b) => a.id.localeCompare(b.id)));
    const kind: 'reorder' | 'edit' = sortById(oldGoals) === sortById(goals) ? 'reorder' : 'edit';

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    workspace.goals = goals;
    // A goal the caller just ADDED is a proposal: it mints in triage, and
    // its band dispatches nothing until somebody agrees to it.
    this.p.syncGoalRows(state, 'triage');

    // Open tasks whose goal id disappeared land at the bottom of Backlog.
    // Done tasks stay put — same rule as re-triage (§3.4), their placement
    // is history, not a claim about current priorities.
    const newIds = new Set([...ids, CHORES_GOAL_ID]);
    const moved: Array<{ task: Task; fromGoal: string }> = [];
    const strandedDone: string[] = [];
    let choresMax = Math.max(
      0,
      ...Array.from(state.tasks.values())
        .filter((t) => t.goal === CHORES_GOAL_ID)
        .map((t) => t.order),
    );
    for (const task of state.tasks.values()) {
      if (newIds.has(task.goal)) continue;
      // Done tasks stay put, but they are now NAMED: this is the half that
      // used to leave a bare row in the read with nothing in the write's
      // answer pointing at it.
      if (task.status === 'done') {
        strandedDone.push(task.id);
        continue;
      }
      moved.push({ task, fromGoal: task.goal });
      choresMax += 1;
      task.goal = CHORES_GOAL_ID;
      bumpWordsRevision(task);
      task.order = choresMax;
      // The band this was placed under is gone, so its placement is no longer
      // named — the bucket's other entrance. `triagedAgainst` deliberately
      // stays: it records what the placement was judged against at the time,
      // which is history. It is not a claim that the task is placed NOW, and
      // reading it as one is what hid these tasks from the sweep.
      task.unplacedSince = ts;
      task.updatedAt = ts;
    }
    this.p.scheduleSave(workspaceId);

    const batchId = cryptoId('gc');
    // Ask the lead to re-look at the bucket. Computed HERE — after the sweep
    // but BEFORE the emits — and both halves are load-bearing.
    //
    // After the sweep, because a task THIS edit un-placed (its band was
    // removed) belongs to the bucket the new band is being offered to;
    // "replace band A with band B" is where that matters most.
    //
    this.p.emit({
      type: 'workspace.goals_changed',
      workspaceId,
      batchId,
      kind,
      oldGoals,
      newGoals: goals,
      actor,
      movedToChores: moved.map((m) => m.task.id),
      ts,
    });
    for (const { task, fromGoal } of moved) {
      this.p.emit({
        type: 'task.regrouped',
        workspaceId,
        taskId: task.id,
        fromGoal,
        toGoal: CHORES_GOAL_ID,
        order: task.order,
        actor,
        partOf: batchId,
        ts,
      });
    }
    return {
      ok: true,
      workspace,
      changed: true,
      created,
      movedToChores: moved.map((m) => m.task.id),
      strandedDone,
    };
  }

  /**
   * Change a goal's TITLE (and optionally its dueAt) in place, at either
   * scope, without touching its id — the common half of what `set_goal_list`
   * was being used for, separated from the destructive half.
   *
   * The whole contract is that nothing can move. A task's band is its goal
   * ID, and no reachable input here changes an id, so a rename cannot sweep
   * open work to Backlog and cannot orphan a done task. That is the point:
   * before this existed, the natural gesture for "rename this band" was to
   * submit the full list with a new id, which the store reads as a removal
   * plus an addition and which strands everything the band held.
   *
   * `chores` is refused as RESERVED rather than not-found — it is a real row
   * a caller genuinely saw in the read, and its label is fixed, so "no such
   * goal" would send them hunting for a typo. Same split `reorderGoals`
   * draws for the same reason.
   *
   * Deliberately asks for NO bucket re-look, even though a retitle can change
   * what a band means ("TBD" → "Payments" arguably makes a goal apparent).
   * The trigger is keyed on a band becoming a DESTINATION, and a rename adds
   * none: every place a task could go, it could already go. Keying it on
   * meaning instead would fire on every wording fix, and nothing in the call
   * distinguishes the two — which is how an ask that matters gets ignored
   * along with the twenty that did not. If this turns out to be worth having,
   * it wants an explicit signal from the caller, not a heuristic here.
   *
   * Emits the existing `workspace.goals_changed` with kind 'edit' (a retitle
   * IS an edit under that taxonomy), so nothing downstream needs a new case.
   *
   * DELIBERATELY NOT A RE-KEY. This verb changes the title and never the id,
   * and the obvious next proposal — "let it take a NEW id and carry the
   * band's tasks across" — is the one to resist. Read this before adding it:
   *
   *  - The demand for re-keying was never a demand for re-keying. It was
   *    people renaming, and reaching for the only verb that could restate a
   *    title. With a retitle that works, "give this band a different id" has
   *    no caller left that isn't already better served here.
   *  - It would be a SECOND bulk task-mover living beside `setTaskGoal`, on
   *    the path that has already produced this file's worst bug. Every band
   *    it moved would be moved implicitly, as a side effect of an edit that
   *    reads like a label change — which is precisely the shape of the
   *    silent stranding the `would-strand-tasks` refusal exists to end.
   *  - The honest way to genuinely retire an id is already reachable and is
   *    two explicit steps: `setGoalList` with the old id named in `drop`,
   *    then `setTaskGoal` per task. The refusal message names both, so the
   *    caller who really wanted a re-key is told where to go rather than
   *    handed a verb that moves work on their behalf.
   */
  renameGoal(
    workspaceId: string,
    goalId: string,
    patch: {
      title: string;
      /** A number sets it; `null` clears it; omitted leaves it alone. */
      dueAt?: number | null;
    },
    opts: { actor: { id: string; name: string; kind?: string } },
  ): RenameGoalResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    if (isReservedGoalId(goalId)) return { ok: false, error: 'reserved-goal-id' };

    const oldGoals = workspace.goals;
    const current = oldGoals.find((g) => g.id === goalId);
    if (!current) return { ok: false, error: 'goal-not-found' };

    const nextDueAt =
      patch.dueAt === undefined ? current.dueAt : patch.dueAt === null ? undefined : patch.dueAt;
    if (current.title === patch.title && current.dueAt === nextDueAt) {
      return {
        ok: true,
        workspace,
        changed: false,
        goal: {
          id: goalId,
          title: current.title,
          ...(current.dueAt !== undefined ? { dueAt: current.dueAt } : {}),
        },
      };
    }

    /** Rebuild the row with dueAt present only when it has a value — an
     *  explicit `dueAt: undefined` key would survive JSON.stringify
     *  comparisons differently from an absent one. */
    const retitled = <T extends { id: string; title: string; dueAt?: number }>(row: T): T => ({
      ...row,
      title: patch.title,
      ...(nextDueAt !== undefined ? { dueAt: nextDueAt } : { dueAt: undefined }),
    });
    const strip = <T extends object>(row: T): T =>
      Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as T;

    // A NEW array either way: `oldGoals` rides on the event, so mutating in
    // place would make both sides report the new title and the audit row
    // would say nothing (the same trap `reorderGoals` documents).
    const newGoals: WorkspaceGoal[] = oldGoals.map((g) =>
      g.id === goalId ? strip(retitled(g)) : g,
    );
    workspace.goals = newGoals;
    // A rename never adds an id, so nothing mints here — see `syncGoalRows`.
    this.p.syncGoalRows(state, 'todo');
    this.p.scheduleSave(workspaceId);

    this.p.emit({
      type: 'workspace.goals_changed',
      workspaceId,
      batchId: cryptoId('gc'),
      kind: 'edit',
      oldGoals,
      newGoals,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      movedToChores: [],
      ts: Date.now(),
    });
    return {
      ok: true,
      workspace,
      changed: true,
      goal: {
        id: goalId,
        title: patch.title,
        ...(nextDueAt !== undefined ? { dueAt: nextDueAt } : {}),
      },
    };
  }

  /**
   * Append ONE new top-level band, and nothing else. The other half of what
   * inline goal editing on the board needs, beside `renameGoal`.
   *
   * The reason this is a verb rather than a client-side `setGoalList` call is
   * the whole hazard `renameGoal`'s header describes, one gesture over. A
   * board that adds a band by submitting the full list submits the list IT
   * last read — and any band added by someone else in between is absent from
   * that list, which the store reads as a removal and which sweeps that
   * band's open tasks into Backlog. Here the list is rebuilt from the LIVE
   * `workspace.goals` at call time, so the only difference between what goes
   * in and what was already there is the one entry being added. A concurrent
   * writer can be raced on ORDER; it cannot be raced out of existence.
   *
   * The new entry carries no `id`, which is what tells `setGoalList` to mint
   * one — so id generation and the `workspace.goals_changed` emit are both
   * inherited rather than re-implemented.
   *
   */
  addGoal(
    workspaceId: string,
    patch: {
      title: string;
      dueAt?: number;
      /** Insert directly after this band; omitted appends at the end. */
      after?: string;
    },
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddGoalResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };

    // Rebuilt from the live list, not from anything a caller sent: every id
    // here necessarily exists, so the delegated replace can only add.
    const entries: GoalListEntry[] = state.workspace.goals.map((g) => ({
      id: g.id,
      title: g.title,
      ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}),
    }));
    const fresh: GoalListEntry = {
      title: patch.title,
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
    };
    if (patch.after === undefined) {
      entries.push(fresh);
    } else {
      const at = entries.findIndex((g) => g.id === patch.after);
      // A band that has since gone lands here. Refused
      // rather than silently appended: the caller asked for a POSITION, and
      // quietly ignoring it is how a board's order stops matching what the
      // person just did.
      if (at < 0) return { ok: false, error: 'after-not-found' };
      entries.splice(at + 1, 0, fresh);
    }

    const res = this.setGoalList(workspaceId, entries, { actor: opts.actor });
    if (!res.ok) return { ok: false, error: 'rejected', cause: res.error };
    const created = res.created[0];
    if (created === undefined) return { ok: false, error: 'rejected', cause: 'no-goal-created' };
    return {
      ok: true,
      workspace: res.workspace,
      goal: {
        id: created.id,
        title: patch.title,
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      },
    };
  }

  /**
   * Reorder the goal list — the priority gesture, separated from the edit.
   *
   * PERMUTATION ONLY, and that constraint is the entire point. `setGoalList`
   * is a full replace, so reordering through it means restating every id and
   * title, and any id a stale caller omits sends that goal's open tasks to
   * the bottom of Backlog — the most ordinary gesture on a board carrying the
   * most destructive edge in the API. Here an `order` that is not exactly
   * the current id set (same ids, same count) is REFUSED with the unknown /
   * missing / duplicated ids named, rather than merged best-effort. So a
   * caller working from a list another writer has since changed gets an
   * error it can re-read and retry — never a silent goal loss. Whether that
   * refusal is well-formed is checked over HTTP too, because the route layer
   * is where a param quietly disappears.
   *
   * Titles and dueAt ride along untouched, and no task can move: there is no
   * reachable input to this method that regroups anything.
   *
   * `parent` is still accepted, and now always refused. It scoped the reorder
   * to one band's subgoals; subgoals are gone, so no id can name a sublist to
   * order. Refusing beats ignoring it — a caller who meant "order these
   * children" must not silently reorder the whole board instead — and beats
   * dropping the field, because the REST route has callers this server cannot
   * restart.
   * Emits the existing `workspace.goals_changed` with kind 'reorder' — the
   * event the board projection and the activity feed already render — so
   * nothing downstream needs a new case.
   */
  reorderGoals(
    workspaceId: string,
    order: string[],
    opts: { parent?: string; actor: { id: string; name: string; kind?: string } },
  ): ReorderGoalsResult {
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;

    // There is one scope now. A `parent` names a sublist that no longer
    // exists, whether or not the id itself is a live goal, so it is refused
    // rather than quietly widened to the whole list.
    if (opts.parent !== undefined) return { ok: false, error: 'parent-not-found' };
    const current: WorkspaceGoal[] = workspace.goals;

    const currentIds = current.map((g) => g.id);
    const currentSet = new Set(currentIds);
    const seen = new Set<string>();
    const unknownIds: string[] = [];
    const reservedIds: string[] = [];
    const duplicateIds: string[] = [];
    for (const id of order) {
      // 'chores' is never in goals[], so it is refused — but it is refused as
      // RESERVED, not unknown. It is a row the caller genuinely saw in the
      // read, and it always renders last, so a caller who put it first cannot
      // be obeyed and a caller who put it last must not be silently trimmed:
      // accepting either would be a position nobody honours.
      if (!currentSet.has(id)) {
        const bucket = isReservedGoalId(id) ? reservedIds : unknownIds;
        if (!bucket.includes(id)) bucket.push(id);
      }
      if (seen.has(id) && !duplicateIds.includes(id)) duplicateIds.push(id);
      seen.add(id);
    }
    const missingIds = currentIds.filter((id) => !seen.has(id));
    if (
      unknownIds.length > 0 ||
      reservedIds.length > 0 ||
      duplicateIds.length > 0 ||
      missingIds.length > 0
    ) {
      return {
        ok: false,
        error: 'order-mismatch',
        unknownIds,
        reservedIds,
        missingIds,
        duplicateIds,
      };
    }

    if (currentIds.every((id, i) => order[i] === id)) {
      return { ok: true, workspace, changed: false, order: currentIds };
    }

    // Build a NEW top-level array either way. `oldGoals` on the event aliases
    // the array we are replacing, so mutating in place would make the event
    // report the new order on both sides and the audit row would say nothing.
    const oldGoals = workspace.goals;
    const byId = new Map(oldGoals.map((g) => [g.id, g]));
    const newGoals: WorkspaceGoal[] = order.map((id) => byId.get(id) as WorkspaceGoal);
    workspace.goals = newGoals;
    // A reorder never adds an id, so nothing mints here — see `syncGoalRows`.
    this.p.syncGoalRows(state, 'todo');
    this.p.scheduleSave(workspaceId);

    this.p.emit({
      type: 'workspace.goals_changed',
      workspaceId,
      batchId: cryptoId('gc'),
      kind: 'reorder',
      oldGoals,
      newGoals,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      movedToChores: [],
      ts: Date.now(),
    });
    return { ok: true, workspace, changed: true, order: [...order] };
  }
}
