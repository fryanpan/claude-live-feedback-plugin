/**
 * Pure view-model logic for the workspace hub (plan §3.9). Everything here is
 * computed from the ws:<workspaceId> ydoc projection + REST payloads — no DOM,
 * no fetch — so the board's grouping/filter/ordering rules are unit-testable
 * without a browser.
 */

export type TaskStatus = 'todo' | 'in-progress' | 'done';

export interface HubActor {
  name: string;
  kind: 'person' | 'agent';
}

export interface HubTransition {
  ts: number;
  from: string;
  to: string;
  by: HubActor;
  note?: string;
  evidence?: { commit?: string; threadRef?: unknown };
  usage?: { inputTokens: number; outputTokens: number };
}

export interface HubDecisionOption {
  id: string;
  label: string;
  detail?: string;
}

export interface HubInfoRequest {
  text: string;
  by: string;
  ts: number;
}

/** One task as projected into the `tasks` Y.Map (§3.3 visitor contract —
 *  display names only, no actor ids). */
export interface HubTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  needs?: 'action' | 'decision';
  goal: string;
  order: number;
  after: string[];
  afterEnforce?: string[];
  dueAt?: number;
  links: unknown[];
  origin?: unknown;
  quote?: string;
  /** Candidate answers the asker already had in mind. A shortcut, never a
   *  closed set — Bryan can always write his own answer instead. */
  options?: HubDecisionOption[];
  /** "I can't answer this yet, tell me more" — recorded rather than answered,
   *  so the decision stays open and the asker gets the question. */
  infoRequests?: HubInfoRequest[];
  answer?: { text: string; by: string; ts: number; optionId?: string };
  triagedAgainst?: { goalId: string; goal: string; ts: number };
  triagePendingTs?: number;
  riskTier?: 'green' | 'yellow' | 'red';
  transitions: HubTransition[];
  bodyDocId: string;
  /** The description, as markdown. Capped by the server projection — see
   *  `bodyTruncated` — with the full text always in the body doc. */
  body?: string;
  bodyTruncated?: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HubSubgoal {
  id: string;
  title: string;
  dueAt?: number;
}

export interface HubGoal extends HubSubgoal {
  subgoals?: HubSubgoal[];
}

/** The projected slice of a goal edit still waiting for its lead agent. */
export interface PendingRetriageView {
  batchId: string;
  taskIds: string[];
  ts: number;
  byName: string;
}

export interface HubWorkspaceInfo {
  id: string;
  name: string;
  goal: string;
  goalUpdatedAt: number;
  goals: HubGoal[];
  docIds: string[];
  /** The agent responsible for this board. Absent = the seat is empty, and
   *  the strip says so rather than showing a stale or guessed name. */
  leadAgentId?: string;
  /** A goal edit the lead agent has not picked up yet. Absent = none
   *  waiting; the board never infers one. */
  pendingRetriage?: PendingRetriageView;
  createdAt: number;
}

/** Reserved out-of-band catch-all section (§3.2 edit contract): always
 *  rendered last, never in goals[], not reorderable or deletable. */
export const CHORES_ID = 'chores';

// ── Done visibility ────────────────────────────────────────────────────────

export type DoneWindow = 'none' | 'hour' | '3h' | 'day' | 'all';

/** §3.9: "Done filter default: last 3h". */
export const DEFAULT_DONE_WINDOW: DoneWindow = '3h';

export const DONE_WINDOWS: ReadonlyArray<{ id: DoneWindow; label: string }> = [
  { id: 'none', label: 'Hide done' },
  { id: 'hour', label: 'Done: last hour' },
  { id: '3h', label: 'Done: last 3h' },
  { id: 'day', label: 'Done: last day' },
  { id: 'all', label: 'Done: all' },
];

export function doneWindowMs(w: DoneWindow): number {
  switch (w) {
    case 'none':
      return 0;
    case 'hour':
      return 3_600_000;
    case '3h':
      return 3 * 3_600_000;
    case 'day':
      return 24 * 3_600_000;
    case 'all':
      return Number.POSITIVE_INFINITY;
  }
}

/** When the task was finished: the LAST transition to done (the audit trail
 *  is append-only, so scan from the tail), falling back to updatedAt for a
 *  task whose projection carries no transitions. */
export function doneAt(task: HubTask): number {
  for (let i = task.transitions.length - 1; i >= 0; i--) {
    const t = task.transitions[i];
    if (t && t.to === 'done') return t.ts;
  }
  return task.updatedAt;
}

// ── Board filters ──────────────────────────────────────────────────────────

export type BoardTab = 'all' | 'mine';

export interface BoardFilters {
  tab: BoardTab;
  /** The viewer's display name — "My Tasks" matches assignee 'human' OR the
   *  viewer's own name (case-insensitive). */
  userName: string;
  doneWindow: DoneWindow;
  now: number;
}

export function taskVisible(task: HubTask, f: BoardFilters): boolean {
  if (f.tab === 'mine') {
    const mine =
      task.assignee === 'human' || task.assignee.toLowerCase() === f.userName.trim().toLowerCase();
    if (!mine) return false;
  }
  if (task.status === 'done') {
    const window = doneWindowMs(f.doneWindow);
    if (window === 0) return false;
    if (window !== Number.POSITIVE_INFINITY && f.now - doneAt(task) > window) return false;
  }
  return true;
}

// ── Board sections (goals ARE the sections; Chores last) ───────────────────

export interface BoardSection {
  id: string;
  title: string;
  /** 0 = goal, 1 = subgoal (one level max — §3.2). */
  depth: 0 | 1;
  dueAt?: number;
  isChores: boolean;
  tasks: HubTask[];
}

function byBoardOrder(a: HubTask, b: HubTask): number {
  return a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * Goal order IS priority order (§3.2): sections follow goals[], each goal's
 * subgoals nested directly after it, Chores always last. A task whose goal id
 * matches no section (transient state while a goal-list edit lands) renders
 * under Chores — dropping it would be the store-has-it/surface-can't-show-it
 * bug all over again.
 */
export function boardSections(goals: HubGoal[], tasks: HubTask[], f: BoardFilters): BoardSection[] {
  const sections: BoardSection[] = [];
  for (const g of goals) {
    sections.push({
      id: g.id,
      title: g.title,
      depth: 0,
      dueAt: g.dueAt,
      isChores: false,
      tasks: [],
    });
    for (const sg of g.subgoals ?? []) {
      sections.push({
        id: sg.id,
        title: sg.title,
        depth: 1,
        dueAt: sg.dueAt,
        isChores: false,
        tasks: [],
      });
    }
  }
  const chores: BoardSection = {
    id: CHORES_ID,
    title: 'Chores',
    depth: 0,
    isChores: true,
    tasks: [],
  };
  sections.push(chores);
  const byId = new Map(sections.map((s) => [s.id, s]));
  for (const task of tasks) {
    if (!taskVisible(task, f)) continue;
    (byId.get(task.goal) ?? chores).tasks.push(task);
  }
  for (const s of sections) s.tasks.sort(byBoardOrder);
  return sections;
}

// ── Reordering (the drag handle and its keyboard twin) ─────────────────────
//
// `task.order` is fractional and `set_task_goal` already takes a fractional
// `position`, so "drop between these two rows" is arithmetic over the orders
// either side — no new ordering API, no renumbering pass, and a cross-goal
// drop is the same call with a different `goal`. Everything here is pure: the
// only browser-shaped input is a list of row rectangles, which `dropIndexFor`
// takes as plain numbers so the decision is testable without layout.

/** The `set_task_goal` call a drop resolves to. */
export interface ReorderTarget {
  goal: string;
  position: number;
}

/**
 * The order a row takes when it lands between `before` and `after` (either
 * side may be missing at the ends of a section).
 *
 * The tie guard matters: orders are only guaranteed dense *within* a goal, so
 * two rows either side of a drop can carry the same number. A plain midpoint
 * would then equal both, the server would compute `changed: false`, and the
 * drop would look like it worked and do nothing.
 */
export function positionBetween(before?: HubTask, after?: HubTask): number {
  if (before && after) {
    const mid = (before.order + after.order) / 2;
    return mid > before.order ? mid : before.order + 0.5;
  }
  if (before) return before.order + 1;
  if (after) return after.order - 1;
  return 0;
}

/**
 * Where a pointer at `y` inserts, given the vertical extents of the rows it is
 * dragging over (the dragged row itself excluded). One past the last row means
 * "append", which is why the result ranges over 0..rects.length.
 */
export function dropIndexFor(
  rects: ReadonlyArray<{ top: number; height: number }>,
  y: number,
): number {
  let index = 0;
  for (const r of rects) {
    if (y > r.top + r.height / 2) index += 1;
    else break;
  }
  return index;
}

/**
 * Resolve a drop — section + insertion index — into the call that performs it,
 * or null when it would be a no-op or names something that isn't there.
 *
 * The no-op case is not an optimisation: `setTaskGoal` stamps `triagedAgainst`
 * and fires `task.regrouped` on every position change, so re-landing a row
 * where it already sits would write an audit row for a move nobody made.
 */
export function dropTarget(
  sections: BoardSection[],
  taskId: string,
  sectionId: string,
  index: number,
): ReorderTarget | null {
  const section = sections.find((s) => s.id === sectionId);
  if (!section) return null;
  const from = sections.find((s) => s.tasks.some((t) => t.id === taskId));
  if (!from) return null;
  const rest = section.tasks.filter((t) => t.id !== taskId);
  const clamped = Math.max(0, Math.min(index, rest.length));
  if (from.id === section.id) {
    const currentIndex = section.tasks.findIndex((t) => t.id === taskId);
    if (currentIndex === clamped) return null;
  }
  return { goal: section.id, position: positionBetween(rest[clamped - 1], rest[clamped]) };
}

/**
 * One slot in `dir` for the keyboard, crossing into the neighbouring section
 * at a section's ends — the pointer can drop anywhere, so the keyboard has to
 * be able to reach the boundary move too, which is the one that actually
 * re-prioritises. Null at the ends of the board: reordering wraps nowhere.
 */
export function stepTarget(
  sections: BoardSection[],
  taskId: string,
  dir: -1 | 1,
): ReorderTarget | null {
  const si = sections.findIndex((s) => s.tasks.some((t) => t.id === taskId));
  if (si < 0) return null;
  const section = sections[si];
  if (!section) return null;
  const rest = section.tasks.filter((t) => t.id !== taskId);
  const next = section.tasks.findIndex((t) => t.id === taskId) + dir;
  if (next >= 0 && next <= rest.length) return dropTarget(sections, taskId, section.id, next);
  const neighbour = sections[si + dir];
  if (!neighbour) return null;
  // Leaving downwards lands at the top of the next section; leaving upwards
  // lands at the bottom of the previous one — the row keeps moving the way
  // the key points.
  return dropTarget(
    sections,
    taskId,
    neighbour.id,
    dir === 1 ? 0 : neighbour.tasks.filter((t) => t.id !== taskId).length,
  );
}

// ── Decisions strip ────────────────────────────────────────────────────────

/** Open, unanswered decisions — the quick-decisions strip is a FILTER over
 *  tasks (§3.2: a decision is a task with needs:'decision'), not a second
 *  entity. */
export function decisionRows(tasks: HubTask[]): HubTask[] {
  return tasks
    .filter((t) => t.needs === 'decision' && t.status !== 'done' && !t.answer)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

/** One open decision plus the work that is actually waiting on it. */
export interface DecisionRow {
  task: HubTask;
  /** Open tasks that name this decision in `after`. */
  blocks: HubTask[];
  /** At least one dependent names it in `afterEnforce` — that work cannot
   *  proceed at all, rather than merely being ordered behind it. */
  hard: boolean;
}

export interface DecisionQueue {
  rows: DecisionRow[];
  total: number;
  /** Decisions with at least one open dependent: "blocking work now". */
  blocking: number;
  /** The rest: real questions, but nothing is stalled on them. */
  waiting: number;
}

/**
 * The queue behind the count at the top of the board.
 *
 * Urgency here is DERIVED, never declared. "This is blocking work now" is the
 * same fact as "something depends on it", and `after` / `afterEnforce` already
 * record that — so there is deliberately no urgency field to set. A hand-set
 * one would be written at creation, the moment its author knows least about
 * what will end up waiting on the answer (the same reasoning that kept a
 * `lane` field off tasks).
 *
 * Ordering is what it blocks, not which goal it sits under: enforced edges
 * first, then by how many tasks are waiting, then oldest.
 */
export function decisionQueue(tasks: HubTask[]): DecisionQueue {
  const open = decisionRows(tasks);
  if (open.length === 0) return { rows: [], total: 0, blocking: 0, waiting: 0 };

  const byId = new Map(open.map((d) => [d.id, { task: d, blocks: [] as HubTask[], hard: false }]));
  for (const t of tasks) {
    // Finished work waits on nothing, and a task can't block on itself.
    if (t.status === 'done') continue;
    const seen = new Set<string>();
    for (const id of t.after) {
      if (id === t.id || seen.has(id)) continue;
      seen.add(id);
      const row = byId.get(id);
      if (!row) continue;
      row.blocks.push(t);
      if (t.afterEnforce?.includes(id)) row.hard = true;
    }
  }

  const rows = [...byId.values()].sort(
    (a, b) =>
      Number(b.hard) - Number(a.hard) ||
      b.blocks.length - a.blocks.length ||
      a.task.createdAt - b.task.createdAt ||
      a.task.id.localeCompare(b.task.id),
  );
  const blocking = rows.filter((r) => r.blocks.length > 0).length;
  return { rows, total: rows.length, blocking, waiting: rows.length - blocking };
}

// ── Status control ─────────────────────────────────────────────────────────

/**
 * The order statuses are LISTED in, which is not a claim about the order they
 * are reached in. §3.9's `nextStatus` cycle (todo → in-progress → done → todo)
 * baked a linear workflow into the only control the board offered: reopening a
 * done task cost two transitions through in-progress, each one a real audit
 * event, and there was no way to say "this went straight back to todo". Real
 * work moves backwards and skips steps, so the control is a dropdown over all
 * statuses and this array only decides what sits above what.
 */
export const TASK_STATUS_ORDER: readonly TaskStatus[] = ['todo', 'in-progress', 'done'];

// ── Activity view (exactly two filters — §3.9) ─────────────────────────────

export interface ActivityEvent {
  event: string;
  ts: number;
  [k: string]: unknown;
}

export type ActivityFilter = 'all' | 'decisions';

/** The rows where an agent (or person) exercised placement judgment:
 *  placements, moves, re-triages, goal-list reprioritizations. Plain status
 *  transitions appear under All only (§3.9 — a five-way taxonomy was mocked
 *  and cut). */
const DECISION_EVENTS: ReadonlySet<string> = new Set([
  'task.created',
  'task.regrouped',
  'task.gate_refused',
  'workspace.retriaged',
  'workspace.goals_changed',
]);

export function activityRows(events: ActivityEvent[], filter: ActivityFilter): ActivityEvent[] {
  const kept = events.filter((e) =>
    filter === 'decisions'
      ? DECISION_EVENTS.has(e.event)
      : // agent.heartbeat is a liveness signal, one row per beat — pure noise
        // in a review view whose job is to make the 80/95 read effortless.
        // server.tick is the same class (the server strips it before it ever
        // reaches us; the guard here keeps that a server-side courtesy, not
        // a load-bearing assumption).
        e.event !== 'agent.heartbeat' && e.event !== 'server.tick',
  );
  return kept.sort((a, b) => b.ts - a.ts);
}

// ── Uptime (deploy readiness — §3.12 commit 11) ────────────────────────────

/** Mirror of the server's UptimeReport (packages/server/src/uptime.ts) —
 *  the client can't import server code, same as ActivityEvent. */
export interface UptimeReport {
  target: number;
  windowMs: number;
  measuredMs: number;
  downMs: number;
  uptimeRatio: number;
  meetsTarget: boolean;
  gaps: Array<{ from: number; to: number; downMs: number }>;
  tickMs: number;
}

export interface UptimeSummary {
  label: string;
  detail: string;
  ok: boolean;
}

function fmtDuration(ms: number): string {
  // Same unit boundaries as timeAgo above, minus the "ago".
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

/** One banner line for the activity view. The percentage is TRUNCATED to
 *  one decimal, never rounded — display must not overstate uptime (98.99%
 *  rounding up to "99.0%" would read as the target met while `ok` says
 *  otherwise). */
export function uptimeSummary(report: UptimeReport | null): UptimeSummary | null {
  if (!report) return null;
  const pct = Math.floor(report.uptimeRatio * 1000) / 10;
  const pctStr = Number.isInteger(pct) ? String(pct) : pct.toFixed(1);
  const down = report.downMs > 0 ? ` · down ${fmtDuration(report.downMs)}` : '';
  return {
    label: `Uptime ${pctStr}%`,
    detail: `target ${report.target * 100}% over ${fmtDuration(report.measuredMs)}${down}`,
    ok: report.meetsTarget,
  };
}

interface EventActor {
  name?: string;
}

function actorName(ev: ActivityEvent): string {
  const actor = ev.actor as EventActor | undefined;
  return actor?.name ?? 'someone';
}

function taskTitle(ev: ActivityEvent, titleOf: (taskId: string) => string): string {
  const task = ev.task as { id?: string; title?: string } | undefined;
  if (task?.title) return task.title;
  const id = (ev.taskId as string | undefined) ?? task?.id;
  return id ? titleOf(id) : 'a task';
}

/** One human-readable line per audit row. Unknown event kinds fall back to
 *  the raw name — an exhaustive-table miss should be visible, not blank. */
export function describeEvent(ev: ActivityEvent, titleOf: (taskId: string) => string): string {
  const title = () => `“${taskTitle(ev, titleOf)}”`;
  switch (ev.event) {
    case 'task.created': {
      const goal = (ev.goal as string | undefined) ?? '';
      const who = ev.actor !== undefined ? `${actorName(ev)} ` : '';
      return `${who}created ${title()}${goal ? ` in ${goal}` : ''}`;
    }
    case 'task.transitioned':
      return `${actorName(ev)} moved ${title()}: ${String(ev.from)} → ${String(ev.to)}`;
    case 'task.assigned':
      return `${actorName(ev)} assigned ${title()}: ${String(ev.from)} → ${String(ev.to)}`;
    case 'task.regrouped':
      return `${actorName(ev)} regrouped ${title()}: ${String(ev.fromGoal)} → ${String(ev.toGoal)}`;
    case 'task.gate_refused':
      return `the gate refused ${actorName(ev)} on ${title()}: ${String(ev.riskTier)}-tier, → ${String(ev.to)}`;
    case 'decision.answered': {
      // The emitted row carries the answer as a plain STRING (the store's
      // `answer: text`), not the `{text, by, ts}` object the task field
      // holds. Reading `.text` off the string silently dropped every
      // verbatim answer — the words are the whole point of the row.
      const answer =
        typeof ev.answer === 'string'
          ? ev.answer
          : (ev.answer as { text?: string } | undefined)?.text;
      return `${actorName(ev)} answered ${title()}${answer ? `: “${answer}”` : ''}`;
    }
    case 'workspace.retriaged': {
      const n = (ev.taskIds as string[] | undefined)?.length ?? 0;
      return `${actorName(ev)} changed the goal — re-triaging ${n} open task${n === 1 ? '' : 's'}`;
    }
    case 'workspace.goal_updated':
      return `${actorName(ev)} updated the workspace goal`;
    case 'workspace.goals_changed':
      return ev.kind === 'reorder'
        ? `${actorName(ev)} reordered the goals`
        : `${actorName(ev)} edited the goal list`;
    case 'agent.attached':
      return `${String(ev.agentId)} attached`;
    case 'agent.detached':
      return `${String(ev.agentId)} detached`;
    case 'server.started':
      // The marker the uptime monitor stamps at boot (§3.12 commit 11) — a
      // restart is honest activity, and it bounds the outage it just ended.
      return 'server restarted';
    default:
      return `${ev.event}`;
  }
}

// ── Presence strip (§2.7) ──────────────────────────────────────────────────

export function timeAgo(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export interface PresencePerson {
  clientId: number;
  name: string;
  surface: string;
  docId?: string;
  lastActive: number;
  self?: boolean;
}

export interface PresenceAgent {
  agentId: string;
  state: 'active' | 'unresponsive' | 'away';
  stateLabel: string;
  lastToolCallAt: number;
}

export interface PresenceChip {
  key: string;
  label: string;
  kind: 'person' | 'agent';
  /** Short "where they are" line rendered inside the chip. */
  where: string;
  /** Full detail for the tooltip. */
  title: string;
  docId?: string;
  clientId?: number;
  state?: PresenceAgent['state'];
}

/** One chip per person and agent (§2.7), people first. Person chips carry the
 *  surface they're on; agent chips carry the derived liveness state — real
 *  signals (heartbeat, last tool call), never guesses. */
export function presenceChips(
  people: PresencePerson[],
  agents: PresenceAgent[],
  now: number,
): PresenceChip[] {
  const chips: PresenceChip[] = [];
  const sortedPeople = [...people].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sortedPeople) {
    const where = p.surface === 'hub' ? 'hub' : (p.docId ?? p.surface);
    chips.push({
      key: `p-${p.clientId}`,
      label: p.self ? `${p.name} (you)` : p.name,
      kind: 'person',
      where,
      title: `${p.name} · in ${where} · ${timeAgo(p.lastActive, now)}`,
      docId: p.docId,
      clientId: p.clientId,
    });
  }
  const sortedAgents = [...agents].sort((a, b) => a.agentId.localeCompare(b.agentId));
  for (const a of sortedAgents) {
    chips.push({
      key: `a-${a.agentId}`,
      label: a.agentId,
      kind: 'agent',
      where: a.state,
      title: `${a.agentId} · ${a.stateLabel} · last tool call ${timeAgo(a.lastToolCallAt, now)}`,
      state: a.state,
    });
  }
  return chips;
}
