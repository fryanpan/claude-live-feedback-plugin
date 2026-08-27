/**
 * The work queue — "what do I pick up next" (§3.9, agent side).
 *
 * Priority is goal order then task order, which the board has always
 * rendered and no agent could READ: `list_tasks` returns goal IDS, and the
 * only goal-list tool was a destructive full replace. So ordering lived in
 * each agent's head, and "why are you working in the 1.2 band" had no
 * answer an agent could look up. This module is the lookup, kept pure so
 * the ordering rules are testable without a server.
 *
 * Two things it answers, in one pass:
 *
 *  - **Order.** Goal position (a subgoal inherits its parent's band and
 *    sorts after it), then the task's own fractional order. A goal id the
 *    list no longer has — and `chores` — ranks last rather than vanishing.
 *  - **Doable.** Open dependencies are reported; only an ENFORCED one holds
 *    a task back, matching the transition gate exactly rather than inventing
 *    a second notion of blocked.
 *
 * What it deliberately does NOT do is decide what can run in parallel. A
 * first cut modelled that as a `lane` label plus computed waves, and it
 * earned nothing: the row carries its full description, and reading two
 * descriptions is enough to tell whether they touch the same code. Worse,
 * a lane is set at CREATION time — the moment a task's author knows least
 * about what it will end up touching — so the schema would have frozen a
 * guess made at the worst possible moment and invited callers to trust it
 * at execution. `blockedBy` carries the dependency half, which is real data
 * someone stated on purpose; the judgment half stays with the reader.
 */
import { taskBodyDocId } from './task-projection.ts';
import {
  type PremiseDrift,
  type PremiseNote,
  bodyWrittenAtOf,
  decidePremiseDrift,
} from './task-staleness.ts';
import {
  type GoalRow,
  type GoalStatusMeta,
  type Task,
  type TaskStatus,
  type WorkspaceGoal,
  goalStatusMeta,
} from './tasks.ts';

export interface QueueBlocker {
  taskId: string;
  title: string;
  status: TaskStatus;
  needs?: 'action' | 'decision';
  /** True when this edge refuses the transition outright (`afterEnforce`). */
  enforce: boolean;
}

export interface QueueRow {
  id: string;
  title: string;
  /** The full description. A row has to be pickup-able as it stands — a
   *  truncated one sends the reader for a second call to find out what the
   *  task is, which is the navigation this queue exists to remove. */
  body: string;
  goal: string;
  /** The goal's own title, verbatim. The band numbering ("1.2 …") is typed
   *  into these titles by hand, so deriving a second numbering here would
   *  let the two disagree. Falls back to the raw id for an unknown goal. */
  goalTitle: string;
  /** False when `goal` matches no ranked goal or subgoal — the reserved
   *  `chores` id first of all. Such a row is formal backlog: listed, ranked
   *  last, and never auto-dispatched, which is what the ready gate reads
   *  this field for. */
  inGoalBand: boolean;
  status: TaskStatus;
  assignee: string;
  needs?: 'action' | 'decision';
  blockedBy: QueueBlocker[];
  /** No ENFORCED open blocker. Advisory (`after`-only) blockers leave this
   *  true, exactly as the transition gate treats them. */
  ready: boolean;
  /** When the description above was written. Present on every row, because
   *  "how old is this measurement" is something a reader needs whether or
   *  not it has drifted — the body is written in the present tense about a
   *  codebase that moves several times a day. */
  bodyWrittenAt: number;
  /**
   * Present only when the description has stood still while the task was
   * discussed (see `decidePremiseDrift`). Carries the notes posted since,
   * so the correction a previous reader already wrote arrives WITH the
   * description it corrects instead of one API call away.
   *
   * Omitted, never false: an absent field costs nothing on the rows that
   * are fine, which is what keeps the notes affordable on the rows that
   * are not.
   */
  premise?: PremiseDrift;
}

export interface QueueOpts {
  assignee?: string;
  limit?: number;
  /** Keep hard-blocked rows. Off by default — the queue is what you can DO. */
  includeBlocked?: boolean;
  /**
   * Comments on a task, by task id. Optional so `buildQueue` stays pure and
   * testable without a room store; a caller that omits it gets rows with no
   * `premise` at all rather than rows that claim to be fresh.
   */
  discussion?: (taskId: string) => readonly PremiseNote[];
  /** Overridable for tests. */
  staleAfterMs?: number;
}

/** Sort key for a goal id: `[band, sub]`. A goal is `[i, 0]`, its j-th
 *  subgoal `[i, j+1]`; anything unknown (including the reserved `chores`)
 *  sorts after every listed goal rather than disappearing. */
/** Whether a goal id names a ranked goal or subgoal on this board. A board
 *  that declares NO goals has no bands, so nothing on it is backlog — the
 *  never-dispatch rule ranks rows against the goal list, and with no list
 *  there is nothing to be outside of. */
export function inGoalBand(goals: WorkspaceGoal[], goalId: string): boolean {
  return goals.length === 0 || goalRank(goals, goalId)[0] < goals.length;
}

function goalRank(goals: WorkspaceGoal[], goalId: string): [number, number] {
  for (let i = 0; i < goals.length; i++) {
    const g = goals[i];
    if (!g) continue;
    if (g.id === goalId) return [i, 0];
    const subs = g.subgoals ?? [];
    for (let j = 0; j < subs.length; j++) {
      if (subs[j]?.id === goalId) return [i, j + 1];
    }
  }
  return [goals.length, 0];
}

function goalTitleOf(goals: WorkspaceGoal[], goalId: string): string {
  for (const g of goals) {
    if (g.id === goalId) return g.title;
    for (const s of g.subgoals ?? []) {
      if (s.id === goalId) return s.title;
    }
  }
  return goalId;
}

/**
 * Order, blockers and waves in one pass.
 *
 * `tasks` must be the workspace's WHOLE task list, not a pre-filtered one:
 * a dependency assigned to someone else still blocks, so the blocker lookup
 * has to see tasks the `assignee` filter removes from the output.
 */
export function buildQueue(
  tasks: Task[],
  goals: WorkspaceGoal[],
  opts: QueueOpts = {},
): QueueRow[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));

  // Finished work, and work nobody has vetted. `triage` is excluded HERE
  // rather than at the `includeBlocked` filter below, because those are two
  // different questions: `includeBlocked` widens the queue to rows a
  // dependency holds back, and a triage row is not blocked — it is not yet
  // agreed to be work at all. Answering both with one flag is how a triage
  // row reaches a dispatcher that only asked to see its blocked rows.
  //
  // Note this is the ONE selection `next_tasks` and the ready-work nudge
  // share, so excluding it here excludes it from both — which is the point.
  // Every other list (the board, `list_tasks`) reads the store directly and
  // still shows triage rows in their band.
  const open = tasks.filter((t) => t.status !== 'done' && t.status !== 'triage');
  const selected =
    opts.assignee === undefined ? open : open.filter((t) => t.assignee === opts.assignee);

  const ranked = selected
    .map((t) => ({ task: t, rank: goalRank(goals, t.goal) }))
    .sort(
      (a, b) =>
        a.rank[0] - b.rank[0] ||
        a.rank[1] - b.rank[1] ||
        a.task.order - b.task.order ||
        a.task.createdAt - b.task.createdAt ||
        a.task.id.localeCompare(b.task.id),
    );

  const rows: QueueRow[] = ranked.map(({ task }) => {
    const enforce = new Set(task.afterEnforce ?? []);
    const blockedBy: QueueBlocker[] = [];
    for (const depId of task.after) {
      const dep = byId.get(depId);
      // A dangling id (the dep was deleted) can't gate — the same rule the
      // transition gate uses. Otherwise deleting a task wedges its dependants
      // forever with a blocker nobody can clear.
      if (!dep || dep.status === 'done') continue;
      blockedBy.push({
        taskId: dep.id,
        title: dep.title,
        status: dep.status,
        ...(dep.needs !== undefined ? { needs: dep.needs } : {}),
        enforce: enforce.has(depId),
      });
    }
    const bodyWrittenAt = bodyWrittenAtOf(task);
    const premise = opts.discussion
      ? decidePremiseDrift({
          status: task.status,
          bodyWrittenAt,
          notes: opts.discussion(task.id),
          ...(opts.staleAfterMs !== undefined ? { staleAfterMs: opts.staleAfterMs } : {}),
        })
      : null;
    return {
      id: task.id,
      title: task.title,
      body: task.body?.trim() ?? '',
      goal: task.goal,
      goalTitle: goalTitleOf(goals, task.goal),
      inGoalBand: inGoalBand(goals, task.goal),
      status: task.status,
      assignee: task.assignee,
      ...(task.needs !== undefined ? { needs: task.needs } : {}),
      blockedBy,
      ready: !blockedBy.some((b) => b.enforce),
      bodyWrittenAt,
      ...(premise ? { premise } : {}),
    };
  });

  const kept = opts.includeBlocked ? rows : rows.filter((r) => r.ready);
  return opts.limit !== undefined ? kept.slice(0, Math.max(0, opts.limit)) : kept;
}

/** One goal, in priority order, with the counts that say where the open
 *  work is. `chores` is appended last, matching the board, and only when it
 *  actually holds something. */
export interface GoalSummaryRow {
  id: string;
  title: string;
  /** 0 for a top-level goal, 1 for a subgoal (one level max). */
  depth: number;
  /** The parent goal's id, on subgoal rows only. Depth alone leaves the
   *  parent to be inferred from row position, and `reorder_goals` needs it
   *  BY NAME to scope a subgoal reorder — so the read states it. */
  parent?: string;
  /** Whether `reorder_goals` accepts this id at this scope — i.e. whether the
   *  row is a member of the ordered goal list at all. False on the two rows
   *  that are appended rather than ordered: `chores`, and a goal id left
   *  behind on a done task by a removal. Both render at depth 0 and are
   *  otherwise shaped exactly like a band, so "every depth-0 row" — the only
   *  scoping rule the read used to offer — builds an order the write
   *  REFUSES. This field is what makes the read writable back into the
   *  write; filter on it, don't infer from depth. */
  reorderable: boolean;
  dueAt?: number;
  /**
   * The goal ROW's own status — a band somebody declared done reads as done
   * even while it still holds open tasks, which is exactly the case the
   * counts alone cannot express. Absent on the appended rows (Backlog, an
   * orphaned goal id): those are buckets, not goals, and have no row to ask.
   */
  status?: TaskStatus;
  /** When the goal was declared done — the last transition to done. */
  doneAt?: number;
  /** Who declared it, display name and kind only. */
  doneBy?: { name: string; kind: 'person' | 'agent' };
  /**
   * The goal's live description room — `task:<goalId>`, the same address a
   * task's `bodyDocId` names and reachable with the same `get_doc` /
   * `find_and_replace` / `create_thread` calls.
   *
   * Stated on the read because a body room nobody can NAME is a body room
   * nobody opens: the address is derivable, but an agent that has to derive
   * it has to first know that goals have bodies at all. Absent on the
   * appended rows (Backlog, an orphaned goal id) for the same reason `status`
   * is — those are buckets with no row to describe.
   */
  bodyDocId?: string;
  /** Rows an agent filed that nobody has vetted yet. Counted separately, and
   *  never folded into `todo`: these are the only rows in the band that no
   *  dispatch read will return, so a band whose whole count is triage looks
   *  full and is not being worked. */
  triage: number;
  todo: number;
  inProgress: number;
  done: number;
}

/** The reserved out-of-band bucket, never present in `goals`. */
const CHORES_ID = 'chores';

/** A band a task can be ranked into — id, title, and where it sits. */
export interface PlaceableGoal {
  id: string;
  title: string;
  /** 0 for a top-level goal, 1 for a subgoal (one level max). */
  depth: number;
  /** The parent goal's id, on subgoal rows only. */
  parent?: string;
}

/**
 * The bands a create could have named, in priority order — what a task
 * create hands back when the caller named no goal.
 *
 * Deliberately NOT `summarizeGoals`: no counts (this answers "where could
 * this go", not "where is the open work"), and no appended rows. `chores`
 * in particular is excluded, because it is where the unplaced task just
 * landed — offering it back as a choice would be the tool suggesting the
 * outcome it is reporting.
 */
export function placeableGoals(goals: WorkspaceGoal[]): PlaceableGoal[] {
  const out: PlaceableGoal[] = [];
  for (const g of goals) {
    out.push({ id: g.id, title: g.title, depth: 0 });
    for (const s of g.subgoals ?? []) {
      out.push({ id: s.id, title: s.title, depth: 1, parent: g.id });
    }
  }
  return out;
}

/**
 * The goal list as an agent needs to read it: ordered, flat (parent then its
 * subgoals), each with its task counts. Every field here was already in the
 * store — what was missing was any call that returned them together, which
 * is why "which goal is 1.1" had no answer an agent could look up.
 */
export function summarizeGoals(
  tasks: Task[],
  goals: WorkspaceGoal[],
  /**
   * The board's goal rows (`listGoalRows`), so each listed band carries its
   * own status alongside its task counts. Optional because several callers
   * summarize a bare goal LIST with no store at hand — their rows simply
   * claim no status, the same reading an appended row always gets.
   */
  goalRows: GoalRow[] = [],
): GoalSummaryRow[] {
  const counts = new Map<
    string,
    { triage: number; todo: number; inProgress: number; done: number }
  >();
  for (const t of tasks) {
    const c = counts.get(t.goal) ?? { triage: 0, todo: 0, inProgress: 0, done: 0 };
    // Every arm names its status, and the fallthrough is `todo` rather than
    // `done`. The chain used to end `else c.done++`, which counted anything
    // it did not recognize as FINISHED — so the first status added after it
    // was written would have inflated every band's done count silently. A
    // status this build has never heard of is at worst unstarted.
    if (t.status === 'triage') c.triage++;
    else if (t.status === 'in-progress') c.inProgress++;
    else if (t.status === 'done') c.done++;
    else c.todo++;
    counts.set(t.goal, c);
  }
  // Status, done attribution, and the address of the goal's description — the
  // whole of what a goal ROW contributes to a summary row, spread together so
  // the appended buckets (Backlog, an orphaned id) pick up none of it.
  const meta = new Map<string, GoalStatusMeta & { bodyDocId: string }>(
    goalRows.map((r) => [r.id, { ...goalStatusMeta(r), bodyDocId: taskBodyDocId(r.id) }]),
  );
  const row = (
    id: string,
    title: string,
    depth: number,
    reorderable: boolean,
    dueAt?: number,
    parent?: string,
  ): GoalSummaryRow => ({
    id,
    title,
    depth,
    ...(parent !== undefined ? { parent } : {}),
    reorderable,
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(meta.get(id) ?? {}),
    ...(counts.get(id) ?? { triage: 0, todo: 0, inProgress: 0, done: 0 }),
  });

  const out: GoalSummaryRow[] = [];
  const placed = new Set<string>();
  // Everything walked out of `goals` IS the ordered list, at either depth —
  // so these are exactly the ids `reorderGoals` will accept.
  for (const g of goals) {
    out.push(row(g.id, g.title, 0, true, g.dueAt));
    placed.add(g.id);
    for (const s of g.subgoals ?? []) {
      out.push(row(s.id, s.title, 1, true, s.dueAt, g.id));
      placed.add(s.id);
    }
  }
  // Backlog, then anything sitting under a goal id the list no longer has —
  // both would otherwise be invisible in a view whose whole job is "where is
  // the open work", and a task you can't see is a task nobody picks up.
  // Neither is IN the ordered list, so neither is reorderable: they are
  // appended by this function, and a caller that sends them back gets a 400.
  for (const id of counts.keys()) {
    if (placed.has(id) || id === CHORES_ID) continue;
    out.push(row(id, id, 0, false));
  }
  if (counts.has(CHORES_ID)) out.push(row(CHORES_ID, 'Backlog', 0, false));
  return out;
}
