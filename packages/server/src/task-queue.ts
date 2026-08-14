/**
 * The work queue — "what do I pick up next, and what can run at the same
 * time" (§3.9, agent side).
 *
 * Priority is goal order then task order, which the board has always
 * rendered and no agent could READ: `list_tasks` returns goal IDS, and the
 * only goal-list tool was a destructive full replace. So ordering lived in
 * each agent's head, and "why are you working in the 1.2 band" had no
 * answer an agent could look up. This module is the lookup, kept pure so
 * the ordering rules are testable without a server.
 *
 * Three things it answers, in one pass:
 *
 *  - **Order.** Goal position (a subgoal inherits its parent's band and
 *    sorts after it), then the task's own fractional order. A goal id the
 *    list no longer has — and `chores` — ranks last rather than vanishing.
 *  - **Doable.** Open dependencies are reported; only an ENFORCED one holds
 *    a task back, matching the transition gate exactly rather than inventing
 *    a second notion of blocked.
 *  - **Parallel.** Rows are grouped into waves: everything in a wave has no
 *    declared conflict with anything else in it.
 *
 * On that last point, the honest reach matters. `after` models "don't start
 * yet"; nothing in the task model has ever modelled "these two rewrite the
 * same file", and long branches that both append to styles.css conflict
 * every time (docs/process/learnings.md). `lane` is where a caller declares
 * that, and `laneDeclared` is on every row so a fan-out can tell "no
 * conflict declared" from "proven independent". A queue that quietly
 * promised the second would send agents into merge conflicts and read as
 * confidence.
 */
import type { Task, TaskStatus, WorkspaceGoal } from './tasks.ts';

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
  /** First non-empty line of the description — enough to pick the task up
   *  without a second call. Empty when the task has no description. */
  story: string;
  goal: string;
  /** The goal's own title, verbatim. The band numbering ("1.2 …") is typed
   *  into these titles by hand, so deriving a second numbering here would
   *  let the two disagree. Falls back to the raw id for an unknown goal. */
  goalTitle: string;
  status: TaskStatus;
  assignee: string;
  needs?: 'action' | 'decision';
  riskTier?: 'green' | 'yellow' | 'red';
  lane?: string;
  /** Whether this row's lane was declared. False means the wave grouping had
   *  nothing to go on for it — see the module note. */
  laneDeclared: boolean;
  blockedBy: QueueBlocker[];
  /** No ENFORCED open blocker. Advisory (`after`-only) blockers leave this
   *  true, exactly as the transition gate treats them. */
  ready: boolean;
  /** Parallel batch. Everything sharing a wave has no declared conflict
   *  with the rest of that wave. */
  wave: number;
}

export interface QueueOpts {
  assignee?: string;
  limit?: number;
  /** Keep hard-blocked rows. Off by default — the queue is what you can DO. */
  includeBlocked?: boolean;
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

/** The one line that says what a task is for. */
function storyOf(body: string | undefined): string {
  for (const line of (body ?? '').split('\n')) {
    const trimmed = line.trim().replace(/^#+\s*/, '');
    if (trimmed.length > 0) return trimmed;
  }
  return '';
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
    return {
      id: task.id,
      title: task.title,
      story: storyOf(task.body),
      goal: task.goal,
      goalTitle: goalTitleOf(goals, task.goal),
      status: task.status,
      assignee: task.assignee,
      ...(task.needs !== undefined ? { needs: task.needs } : {}),
      ...(task.riskTier !== undefined ? { riskTier: task.riskTier } : {}),
      ...(task.lane !== undefined ? { lane: task.lane } : {}),
      laneDeclared: task.lane !== undefined,
      blockedBy,
      ready: !blockedBy.some((b) => b.enforce),
      wave: 0,
    };
  });

  const kept = opts.includeBlocked ? rows : rows.filter((r) => r.ready);
  assignWaves(kept);
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
  dueAt?: number;
  todo: number;
  inProgress: number;
  done: number;
}

/** The reserved out-of-band bucket, never present in `goals`. */
const CHORES_ID = 'chores';

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
  const row = (id: string, title: string, depth: number, dueAt?: number): GoalSummaryRow => ({
    id,
    title,
    depth,
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(counts.get(id) ?? { todo: 0, inProgress: 0, done: 0 }),
  });

  const out: GoalSummaryRow[] = [];
  const placed = new Set<string>();
  for (const g of goals) {
    out.push(row(g.id, g.title, 0, g.dueAt));
    placed.add(g.id);
    for (const s of g.subgoals ?? []) {
      out.push(row(s.id, s.title, 1, s.dueAt));
      placed.add(s.id);
    }
  }
  // Chores, then anything sitting under a goal id the list no longer has —
  // both would otherwise be invisible in a view whose whole job is "where is
  // the open work", and a task you can't see is a task nobody picks up.
  for (const id of counts.keys()) {
    if (placed.has(id) || id === CHORES_ID) continue;
    out.push(row(id, id, 0));
  }
  if (counts.has(CHORES_ID)) out.push(row(CHORES_ID, 'Chores', 0));
  return out;
}

/**
 * Layered grouping, in priority order, mutating `wave` in place.
 *
 * A row lands one wave after the latest dependency that is ALSO in the
 * queue; a dependency outside it (filtered away, or already hard-blocking)
 * is reported on `blockedBy` rather than silently deepening the wave, since
 * the caller can see it either way and a wave number nobody can explain is
 * worse than one that says less.
 *
 * The lane pass runs second and only ever pushes a row LATER — its failure
 * mode is a fan-out narrower than it had to be, never two agents in the
 * same file.
 */
function assignWaves(rows: QueueRow[]): void {
  const wave = new Map<string, number>();
  const claimed = new Map<number, Set<string>>();
  const laneFree = (w: number, lane: string): boolean => !claimed.get(w)?.has(lane);

  for (const row of rows) {
    let w = 0;
    for (const b of row.blockedBy) {
      const dw = wave.get(b.taskId);
      if (dw !== undefined) w = Math.max(w, dw + 1);
    }
    if (row.lane !== undefined) {
      while (!laneFree(w, row.lane)) w++;
      const set = claimed.get(w) ?? new Set<string>();
      set.add(row.lane);
      claimed.set(w, set);
    }
    wave.set(row.id, w);
    row.wave = w;
  }
}
