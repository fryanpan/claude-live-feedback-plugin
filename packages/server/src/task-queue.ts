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
import {
  type PremiseDrift,
  type PremiseNote,
  bodyWrittenAtOf,
  decidePremiseDrift,
} from './task-staleness.ts';
import { type Task, type TaskStatus, type WorkspaceGoal, isParked } from './tasks.ts';

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
  /**
   * Present only while this row is deferred — "not now, and here is when".
   *
   * The row is still LISTED, deliberately. A parked row is not blocked (no
   * open dependency) and not claimed (nobody is working it), so removing it
   * from the queue would trade one invisibility for another: the point of
   * parking is that a deliberate deferral becomes a thing a reader can see
   * and disagree with. What changes is that the reader is told, on the row,
   * instead of finding a row that looks exactly like work nobody got to.
   *
   * Omitted rather than falsey once the date passes — no sweeper clears the
   * task's field, so this is computed against `now` on every read.
   */
  parked?: { until: number; reason?: string };
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
  /** The instant the queue is being read AT — which is what decides whether a
   *  park is still in force. Overridable for tests; nothing else needs it. */
  now?: number;
}

/** Sort key for a goal id: `[band, sub]`. A goal is `[i, 0]`, its j-th
 *  subgoal `[i, j+1]`; anything unknown (including the reserved `chores`)
 *  sorts after every listed goal rather than disappearing. */
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
  const now = opts.now ?? Date.now();

  const open = tasks.filter((t) => t.status !== 'done');
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
      status: task.status,
      assignee: task.assignee,
      ...(task.needs !== undefined ? { needs: task.needs } : {}),
      blockedBy,
      ready: !blockedBy.some((b) => b.enforce),
      bodyWrittenAt,
      ...(premise ? { premise } : {}),
      ...(isParked(task, now)
        ? {
            parked: {
              until: task.parkedUntil as number,
              ...(task.parkedReason !== undefined ? { reason: task.parkedReason } : {}),
            },
          }
        : {}),
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
export function summarizeGoals(tasks: Task[], goals: WorkspaceGoal[]): GoalSummaryRow[] {
  const counts = new Map<string, { todo: number; inProgress: number; done: number }>();
  for (const t of tasks) {
    const c = counts.get(t.goal) ?? { todo: 0, inProgress: 0, done: 0 };
    if (t.status === 'todo') c.todo++;
    else if (t.status === 'in-progress') c.inProgress++;
    else c.done++;
    counts.set(t.goal, c);
  }
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
    ...(counts.get(id) ?? { todo: 0, inProgress: 0, done: 0 }),
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
