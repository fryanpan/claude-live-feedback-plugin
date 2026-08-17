/**
 * Pure view-model logic for the workspace hub (plan §3.9). Everything here is
 * computed from the ws:<workspaceId> ydoc projection + REST payloads — no DOM,
 * no fetch — so the board's grouping/filter/ordering rules are unit-testable
 * without a browser.
 */
import type { StoredGoalSummary } from '@feedback/core/goal-summary';

export type TaskStatus = 'todo' | 'in-progress' | 'done';

export interface HubActor {
  name: string;
  kind: 'person' | 'agent';
}

export interface HubEvidence {
  commit?: string;
  threadRef?: unknown;
}

/** Evidence attached to a move AFTER it was recorded — see
 *  `@feedback/core/evidence` for why this appends instead of rewriting. */
export interface HubTransitionAmendment {
  ts: number;
  by: HubActor;
  evidence: HubEvidence;
  note?: string;
  /** The claim this replaced. Present only for a CORRECTION; absent when the
   *  amendment filled a gap. */
  supersedes?: HubEvidence;
}

export interface HubTransition {
  ts: number;
  from: string;
  to: string;
  by: HubActor;
  note?: string;
  evidence?: HubEvidence;
  amendments?: HubTransitionAmendment[];
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
  /** How many comments the task's discussion holds. Absent means none — the
   *  server omits the key rather than projecting a zero, so a row is marked
   *  only when there is something to read. */
  commentCount?: number;
  /** Since when nobody has named a goal for this task. A TIMESTAMP rather
   *  than a flag, so a reading can say how long the wait has been and not
   *  only that there is one. Cleared the moment a goal is named; absent on
   *  every placed task. The server is the only writer — never re-derive it
   *  from "is this row under Chores", the proxy it replaced, which was wrong
   *  in both directions (an explicit `goal: 'chores'` IS a placement, and a
   *  task swept into Chores by a band removal keeps its old
   *  `triagedAgainst`). */
  unplacedSince?: number;
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

/** A goal BAND that appeared while the lead was away, and the unplaced tasks
 *  worth re-looking at against it. Separate from PendingRetriageView because
 *  the two answer different questions — that one's baseline is the north-star
 *  TEXT, this one's is the goal LIST — and answering either does not answer
 *  the other, so a board that renders one and not the other is silent about
 *  half of what is waiting. */
export interface PendingBucketReviewView {
  batchId: string;
  taskIds: string[];
  /** Display only; the record is keyed on ids. Rebuilt from the live list on
   *  every read, so a band renamed since the edit reads the way the board
   *  names it now. */
  bandTitles: string[];
  ts: number;
  byName: string;
}

export interface HubWorkspaceInfo {
  id: string;
  name: string;
  goal: string;
  goalUpdatedAt: number;
  /** The ≤20-word line the strip displays instead of the goal. Absent = show
   *  the deterministic clip; the board never waits for one to arrive. */
  goalSummary?: StoredGoalSummary;
  goals: HubGoal[];
  docIds: string[];
  /** The agent responsible for this board. Absent = the seat is empty, and
   *  the strip says so rather than showing a stale or guessed name. */
  leadAgentId?: string;
  /** A goal edit the lead agent has not picked up yet. Absent = none
   *  waiting; the board never infers one. */
  pendingRetriage?: PendingRetriageView;
  /** A goal band the lead agent has not re-looked at the bucket against yet.
   *  Absent = none waiting. */
  pendingBucketReview?: PendingBucketReviewView;
  createdAt: number;
}

/** Reserved out-of-band catch-all section (§3.2 edit contract): always
 *  rendered last, never in goals[], not reorderable or deletable. */
export const CHORES_ID = 'chores';

/** The one spelling of the Chores header, shared by the section and by
 *  anything else that has to name the goal a task sits under. */
export const CHORES_TITLE = 'Chores';

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

/** "A person owns this." The one spelling of it — `taskVisible`'s My-Tasks
 *  branch and the review queue's blocker band both ask the same question, and
 *  a second spelling of it would drift the moment either moved. */
export function assignedToHuman(task: HubTask): boolean {
  return task.assignee === 'human';
}

export function taskVisible(task: HubTask, f: BoardFilters): boolean {
  if (f.tab === 'mine') {
    const mine =
      assignedToHuman(task) || task.assignee.toLowerCase() === f.userName.trim().toLowerCase();
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
    title: CHORES_TITLE,
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

/**
 * What the board calls `goalId` — the text on the section header the task's
 * row actually sits under.
 *
 * It lives next to `boardSections` and shares its fallback on purpose: every
 * goal id that has no section (the Chores catch-all, a goal deleted out from
 * under a task) renders under Chores, so anything naming a goal elsewhere has
 * to say Chores too. Two places deciding that independently is how a row ends
 * up under one header while its detail panel claims another.
 */
export function goalLabel(goals: HubGoal[], goalId: string): string {
  for (const g of goals) {
    if (g.id === goalId) return g.title;
    for (const sub of g.subgoals ?? []) if (sub.id === goalId) return sub.title;
  }
  return CHORES_TITLE;
}

/** How many tasks nobody has placed, and how long the oldest has waited. */
export interface UnplacedNotice {
  count: number;
  /** The `unplacedSince` of the longest-waiting task — kept alongside the
   *  rendered strings so a caller can sort or threshold on it without
   *  re-deriving the selection. */
  oldestSince: number;
  /** The longest-waiting task, so the strip can take a reader straight to it.
   *  Named rather than assumed: both writers of `unplacedSince` land a task in
   *  Chores today, but "scroll to the Chores header" would bake that proxy
   *  back into the surface through the back door. */
  oldestTaskId: string;
  /** "3 tasks have no goal yet" — how many. */
  label: string;
  /** "oldest waiting 6d" — how long. */
  detail: string;
}

/**
 * The bucket's whole risk is that it is QUIET. Unplaced work rests at the
 * bottom of Chores, which is the band nobody scrolls to, so the failure mode
 * is tasks accumulating there for weeks while every check comes back correct.
 *
 * So this is a reading rather than an obligation: it fires on every render,
 * for everybody, without anyone deciding to look — the same shape as the
 * description-staleness notice. Two rules follow from that:
 *
 *  - **Silent when the bucket is empty.** `null`, not a zero. A permanent
 *    "0 unplaced" is a line people learn to skim, and skimming is what the
 *    notice exists to prevent.
 *  - **Inform, don't shame.** How many and how old, and nothing else. A
 *    scolding strip gets ignored, which costs more than saying nothing.
 *
 * Selection mirrors the server's `listUntriaged` EXACTLY — open, and carrying
 * an `unplacedSince`. Deliberately no `goal === chores` clause: that proxy was
 * wrong in both directions, and re-introducing it here would make the board
 * disagree with the sweep an agent actually runs.
 */
export function unplacedNotice(tasks: HubTask[], now: number): UnplacedNotice | null {
  let count = 0;
  let oldest: HubTask | null = null;
  for (const t of tasks) {
    if (t.status === 'done' || t.unplacedSince === undefined) continue;
    count += 1;
    // Tie broken by id so the strip names the same task on every render —
    // task order in the projection is a Map iteration, not a promise.
    if (
      oldest === null ||
      t.unplacedSince < (oldest.unplacedSince as number) ||
      (t.unplacedSince === oldest.unplacedSince && t.id < oldest.id)
    ) {
      oldest = t;
    }
  }
  if (oldest === null) return null;
  const oldestSince = oldest.unplacedSince as number;
  const waited = fmtDuration(now - oldestSince);
  return {
    count,
    oldestSince,
    oldestTaskId: oldest.id,
    label: count === 1 ? '1 task has no goal yet' : `${count} tasks have no goal yet`,
    // With one task "oldest" would be a comparison against nothing.
    detail: count === 1 ? `waiting ${waited}` : `oldest waiting ${waited}`,
  };
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
  const rows = dependentsRows(tasks, decisionRows(tasks));
  const blocking = rows.filter((r) => r.blocks.length > 0).length;
  return { rows, total: rows.length, blocking, waiting: rows.length - blocking };
}

/**
 * "What open work is waiting on each of these?" — the engine behind both bands.
 *
 * The walk is generic on purpose: only the candidate set says which question is
 * being asked. Ordering is what it blocks, not which goal it sits under:
 * enforced edges first, then by how many tasks are waiting, then oldest.
 */
function dependentsRows(tasks: HubTask[], candidates: HubTask[]): DecisionRow[] {
  if (candidates.length === 0) return [];
  const byId = new Map(
    candidates.map((d) => [d.id, { task: d, blocks: [] as HubTask[], hard: false }]),
  );
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
  return [...byId.values()].sort(
    (a, b) =>
      Number(b.hard) - Number(a.hard) ||
      b.blocks.length - a.blocks.length ||
      a.task.createdAt - b.task.createdAt ||
      a.task.id.localeCompare(b.task.id),
  );
}

/** A task and the open work waiting on it. The decision band and the blocker
 *  band carry the same shape because it is the same computation. */
export type BlockerRow = DecisionRow;

/**
 * Open, human-owned tasks that other open work names in `after`.
 *
 * The board's six real dependency edges pointed at none of its decisions —
 * they pointed at a person's own tasks (turn on the tunnel, merge the PR), and
 * no surface said so. Two rules make this band different from the decision one
 * and both are load-bearing:
 *
 * - **Nothing waiting means not here.** The decision band deliberately shows a
 *   decision with no dependents ("Nothing is waiting on this yet") because an
 *   unanswered question is itself the ask. A task is not an ask, so a human
 *   task nobody is waiting on would put the whole personal backlog in the strip
 *   and make the count mean nothing.
 * - **A decision is not a blocker.** Every decision is also assigned to
 *   somebody, so without this the same task would appear in both bands and be
 *   counted twice in the number at the top of the board.
 *
 * Known limit, deliberately not closed: ownership here is the literal `human`,
 * so a task handed to a person by NAME is not in this band. `taskVisible`'s
 * My-Tasks branch does match the viewer's own name, and matching it here was
 * considered — but the strip is one shared read of the workspace, and keying
 * it on the viewer would make the count at the top differ per reader and would
 * put every agent-owned blocker in the band for anyone whose typed display
 * name happens to be an agent's, which is the inflation this band's other rule
 * exists to prevent. Closing it properly needs a way to say "this assignee is
 * a person", not a name comparison.
 */
export function humanBlockerRows(tasks: HubTask[]): BlockerRow[] {
  const candidates = tasks.filter(
    (t) => assignedToHuman(t) && t.status !== 'done' && t.needs !== 'decision',
  );
  return dependentsRows(tasks, candidates).filter((r) => r.blocks.length > 0);
}

// ── The review queue: everything waiting on a person, in one list ──────────

/**
 * One thread-shaped item, exactly as `GET /api/workspaces/:id/review-items`
 * ships it. The server owns this half because "is this comment an agent's" is
 * `classifyActor`'s judgement and must not be re-decided in the browser.
 */
export interface ReviewThreadItem {
  kind: 'task-thread' | 'doc-thread';
  docId: string;
  threadId: string;
  taskId?: string;
  title: string;
  ask: string;
  askedBy: string;
  since: number;
  /** The run contains a question addressed to a person by name. Ranks the item
   *  to the top of its band and changes the line the row reads. Absent on a
   *  payload from a server older than this field, which reads as false — the
   *  pre-existing ordering, which is the safe direction. */
  direct?: boolean;
  /** When the question was asked, when there is one. Absent from an older
   *  server's payload, in which case the row falls back to `since` — the
   *  pre-existing wording. */
  askedAt?: number;
}

/**
 * "The request did not complete" is not "there is nothing here."
 *
 * The board's REST-backed regions refresh on a timer and on SSE nudges, and
 * `fetchJson` answers null for every failure — a dead socket, a 502, a server
 * mid-restart. Reading that as an empty payload made the board blank its own
 * review strip during a deploy: everything waiting on the reader became
 * nothing, which is the falling-over reading the reconnect banner exists to
 * prevent, arriving through a different door.
 *
 * The guard keys strictly on whether the payload arrived. An empty LIST is a
 * real answer — a workspace whose last thread was resolved must still be
 * allowed to say so — so only `null` holds the previous value.
 */
export function applyRefresh<R, V>(current: V, res: R | null, read: (r: R) => V): V {
  if (res === null) return current;
  return read(res);
}

/**
 * The review strip's refresh, kept here rather than inline in hub-app so the
 * survives-an-outage behaviour is driven by a test instead of asserted about.
 */
export async function refreshReviewItems(
  state: { reviewItems: ReviewThreadItem[] },
  fetchItems: () => Promise<{ items?: ReviewThreadItem[] } | null>,
): Promise<void> {
  const res = await fetchItems();
  state.reviewItems = applyRefresh(state.reviewItems, res, (r) => r.items ?? []);
}

export type ReviewKind = 'decision' | 'blocker' | 'task-thread' | 'doc-thread';

export interface ReviewItem {
  /** Stable across re-fetches. The walkthrough steps by position and the list
   *  reorders underneath it, so identity cannot be the index. */
  key: string;
  kind: ReviewKind;
  /** What this is ABOUT — the decision, the task, the doc. */
  title: string;
  /** The ask itself, one line. Empty for a decision whose body is the ask. */
  ask: string;
  /** Why it sits where it does; the item's second line. */
  why: string;
  since: number;
  /** Set on a decision — the row the answer form and the blocks line need. */
  decision?: DecisionRow;
  /** Set on a human-owned blocker — the same row shape, but there is no
   *  question to answer here, only work to unblock. */
  blocker?: BlockerRow;
  /** Set on either thread kind — where the reply gets written. */
  thread?: ReviewThreadItem;
}

/** The task-and-dependents row an item carries, for the two bands that have
 *  one. One reader for both, so "open the thing this is about" cannot learn
 *  about a new band and forget the other. */
export function reviewRow(item: ReviewItem): DecisionRow | undefined {
  return item.decision ?? item.blocker;
}

export interface ReviewQueue {
  items: ReviewItem[];
  total: number;
  /** How many are holding other work up right now: decisions with dependents,
   *  plus every human-owned blocker (which has dependents by definition). Not
   *  threads — a comment blocks nothing structurally, and counting it would
   *  inflate the one number that is supposed to mean "act now". */
  blocking: number;
}

/**
 * Everything waiting on a person, banded and ordered.
 *
 * Bryan's question on coming back to the board is "what do I look at next",
 * and until this existed the board could only answer it for open decisions.
 * The other two kinds were in the store and unreachable from the surface —
 * the failure this codebase has been bitten by before, and the one that
 * presents as the worst possible bug because nothing is actually lost.
 *
 * Bands, in the order Bryan named them: decisions, then task discussions,
 * then doc comments. Within the decision band the existing `decisionQueue`
 * ordering is kept wholesale (enforced edges, then how much is waiting, then
 * age) rather than re-derived — it is already tuned and already tested.
 * Within each thread band, the LONGEST WAIT is first: ranking by recency
 * starves the tail, which is exactly what this list exists to prevent.
 */
export function reviewQueue(
  tasks: HubTask[],
  threadItems: ReviewThreadItem[],
  now: number,
): ReviewQueue {
  const decisions = decisionQueue(tasks);
  const items: ReviewItem[] = decisions.rows.map((row) => ({
    key: `decision:${row.task.id}`,
    kind: 'decision' as const,
    title: row.task.title,
    ask: '',
    why: row.blocks.length === 0 ? 'Nothing is waiting on this yet' : blockingLine(row),
    since: row.task.createdAt,
    decision: row,
  }));

  // Second band: a person's own open tasks that other work is waiting on. They
  // sit under decisions and above every comment because, like a decision with
  // dependents, they are structurally holding work up — and unlike a comment,
  // nobody else can move them.
  const blockers = humanBlockerRows(tasks);
  for (const row of blockers) {
    items.push({
      key: `blocker:${row.task.id}`,
      kind: 'blocker',
      title: row.task.title,
      ask: '',
      why: blockingLine(row),
      since: row.task.createdAt,
      blocker: row,
    });
  }

  // A question somebody asked you comes before a note somebody left you, and
  // only then oldest-first. Without the first key the two are interleaved by
  // age alone, so a status update posted this morning outranks a question that
  // has been waiting since Tuesday — and the top of the strip, which is the
  // part that actually gets read, fills with things there is nothing to answer.
  // This ranks rather than filters: every thread that appears today still
  // appears, which is what keeps a misjudged `direct` cheap.
  const byAsk = (a: ReviewThreadItem, b: ReviewThreadItem) =>
    Number(b.direct ?? false) - Number(a.direct ?? false) ||
    a.since - b.since ||
    a.threadId.localeCompare(b.threadId);
  for (const kind of ['task-thread', 'doc-thread'] as const) {
    for (const t of threadItems.filter((i) => i.kind === kind).sort(byAsk)) {
      const where = kind === 'task-thread' ? 'on this task' : 'on this doc';
      items.push({
        key: `${t.kind}:${t.docId}:${t.threadId}`,
        kind,
        title: t.title,
        ask: t.ask,
        // "asked" is a claim about there being a question. Say it only when
        // there is one; otherwise the row promises an answerable thing and
        // delivers a status note, which is how a strip stops being believed.
        // The clock beside "asked" has to be the QUESTION's, not the run's.
        // The run can start days before the ask — status, status, then a
        // question — and quoting the run's start there tells the reader they
        // have been sitting on something they were handed minutes ago.
        // Ranking still uses `since`; only the sentence changes.
        why: t.direct
          ? `${t.askedBy} asked you ${timeAgo(t.askedAt ?? t.since, now)} · ${where}`
          : `${t.askedBy} posted ${timeAgo(t.since, now)} · ${where}`,
        since: t.since,
        thread: t,
      });
    }
  }

  // Every blocker is blocking — that is the condition for being in the band —
  // so it belongs in the number that means "act now". A thread still does not:
  // it blocks nothing structurally, and counting it would inflate the one
  // number that is supposed to mean act now.
  return { items, total: items.length, blocking: decisions.blocking + blockers.length };
}

/** "Blocking 2 tasks" / "Hard-blocking 1 task". One phrasing, both bands. */
function blockingLine(row: DecisionRow): string {
  const n = row.blocks.length;
  return `${row.hard ? 'Hard-blocking' : 'Blocking'} ${n === 1 ? '1 task' : `${n} tasks`}`;
}

// ── Where the walkthrough is standing ──────────────────────────────────────

/**
 * The position the walkthrough should render, given where it was AIMED.
 *
 * The queue is re-derived on every render and shrinks underneath the reader —
 * their own answer removes an item, and so does a peer's. A bare index is
 * therefore not a position: when anything BEFORE it drops out, the same index
 * silently lands one item further on, and the reader never sees the one that
 * was skipped. So the aim is a `ReviewItem.key`, and the index is only the
 * fallback for the two cases a key cannot express — the aimed item is gone,
 * and the walk has run off the end into the done state.
 *
 * A negative index means closed, and stays closed: resolving it against the
 * queue would reopen the panel on every repaint.
 */
export function walkPosition(queue: ReviewQueue, index: number, key: string | null): number {
  if (index < 0) return -1;
  if (key) {
    const at = queue.items.findIndex((i) => i.key === key);
    if (at !== -1) return at;
  }
  return Math.min(Math.max(index, 0), queue.items.length);
}

/**
 * Where to stand after the item at `index` was answered or replied to.
 *
 * Answering usually takes the item OUT of the queue, so `index + 1` steps over
 * whatever slid into its place — the classic off-by-one of a list that edits
 * itself. Aim instead at the item that was NEXT when the answer was submitted,
 * by identity.
 *
 * Two fallbacks, both real: the answered item can still be in the queue when
 * the write lands (a decision's answer arrives back through the ydoc
 * projection, not in the POST's response), in which case stepping past it is
 * right; and the next item can be gone too, when a peer answered it while this
 * one was being written — then the gap left behind is as good a place as any.
 */
export function advanceWalk(
  queue: ReviewQueue,
  index: number,
  finishedKey: string,
  nextKey: string | null,
): number {
  if (nextKey) {
    const at = queue.items.findIndex((i) => i.key === nextKey);
    if (at !== -1) return at;
  }
  const still = queue.items.findIndex((i) => i.key === finishedKey);
  if (still !== -1) return still + 1;
  return Math.min(Math.max(index, 0), queue.items.length);
}

// ── Quick capture ──────────────────────────────────────────────────────────

/** Longer than this and the line stops being a title. Chosen to fit a phone
 *  row without wrapping twice, which is where the board is read. */
const QUICK_TITLE_MAX = 90;

export interface QuickAdd {
  title: string;
  /** The speaker's own words, whole, whenever the title had to lose any of
   *  them. Never a rewrite. */
  body?: string;
}

/**
 * One box of prose → a task.
 *
 * Bryan: "I also can't create new tasks easily in the workspace, which is why
 * I'm doing them here. I want a quick typing or voice option to create a
 * task, mostly by just discussing it with you." The thing that makes capture
 * expensive is being asked to compose a title — and the board's own contract
 * asks for a user story, which is more composition still. So capture takes
 * whatever he says and NEVER discards a word of it: the first line becomes
 * the title, and if anything at all was left over — more lines, or a first
 * line too long to be a title — the full text is kept verbatim as the body
 * for whoever refines it.
 *
 * Deliberately not an LLM call. Capture has to work with no network, no key,
 * and no attached agent, because the moment it can fail is the moment the
 * idea goes back into chat.
 */
export function parseQuickAdd(raw: string): QuickAdd | null {
  const text = raw.trim();
  if (text === '') return null;
  const lines = text.split('\n');
  const first = (lines[0] ?? '').trim();
  const multiline = lines.length > 1;
  if (first.length <= QUICK_TITLE_MAX) {
    return multiline ? { title: first, body: text } : { title: first };
  }
  // Clip on a word boundary when there is one nearby; the whole utterance
  // survives in the body either way.
  const cut = first.slice(0, QUICK_TITLE_MAX);
  const space = cut.lastIndexOf(' ');
  return {
    title: `${(space > QUICK_TITLE_MAX * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`,
    body: text,
  };
}

/**
 * A finished utterance joins whatever is already in the capture box.
 *
 * Dictation APPENDS rather than replaces, and the reason is the same one
 * `parseQuickAdd` exists for: someone types half an idea, then finishes it out
 * loud. Replacing would eat the typed half, which is the single failure this
 * box was built to make impossible.
 *
 * The transcript is also accumulated separately as `quote`, so the task can
 * carry the speaker's own words even after the box is edited. Only the SPOKEN
 * half is ever quoted — typed text is already the task, and was never a quote
 * of anyone.
 */
export function appendDictation(
  existing: string,
  transcript: string,
  priorQuote?: string,
): { text: string; quote: string } {
  const said = transcript.trim();
  const quote = [priorQuote?.trim(), said].filter(Boolean).join(' ');
  if (said === '') return { text: existing, quote };
  return { text: existing.trim() === '' ? said : `${existing.trimEnd()} ${said}`, quote };
}

/** The words of a phrase, lowercased, for comparing one utterance against
 *  what the box still holds. Punctuation is not evidence either way. */
function spokenWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
}

/** How much of the utterance the box must still hold for the quote to stay
 *  attached to it. Half is a deliberately blunt line: it is comfortably
 *  clear of a corrected word or two, and comfortably short of a sentence
 *  about different work. */
const QUOTE_RETAINED_MIN = 0.5;

/**
 * The quote that survives an edit to the capture box.
 *
 * The person who dictated can do two very different things to the text, and
 * only one of them should cost the quote. Fixing a misheard word ("mike" →
 * "mic") must KEEP it — the agent seeing both what was said and what was
 * meant is the entire reason to carry one. Selecting the whole box and typing
 * a different idea must DROP it, because filing that task with the previous
 * utterance attaches words to a person about work they never mentioned. That
 * second case is not distinguishable by "the box went empty": a select-all
 * retype fires ONE input event whose value is already the new text.
 *
 * So the test is how much of the utterance the box still holds, and the rule
 * is deliberately one-directional: when the overlap is unclear the quote is
 * DROPPED. Losing the record of what someone said costs the agent some
 * phrasing; misattributing words to them is a claim about a person that they
 * never made, and that is the worse failure of the two.
 */
export function quoteAfterEdit(text: string, spoken: string): string {
  const quote = spoken.trim();
  const said = spokenWords(quote);
  if (said.length === 0) return '';
  const inBox = new Set(spokenWords(text));
  const kept = said.filter((w) => inBox.has(w)).length;
  return kept / said.length >= QUOTE_RETAINED_MIN ? quote : '';
}

/**
 * The quote left over once a captured task has taken its own words away.
 *
 * The box stays live while the capture is in flight — deliberately, so an
 * idea can be dictated the moment it arrives rather than after a round trip —
 * and dictation APPENDS, so by the time the POST resolves the accumulated
 * quote can hold utterances the filed task never carried. Clearing it
 * wholesale files the next task with no record of what was said, which is
 * exactly the failure the quote exists to prevent, one task later.
 *
 * Mirrors the text reset beside it: remove what was sent, keep the rest. A
 * quote that no longer starts with what was filed had already been dropped
 * and re-accumulated, so there is nothing of that task's left to remove.
 */
export function quoteAfterCapture(spoken: string, filed: string | undefined): string {
  const rest = spoken.trim();
  const sent = filed?.trim() ?? '';
  if (sent === '') return rest;
  if (rest === sent) return '';
  return rest.startsWith(`${sent} `) ? rest.slice(sent.length + 1).trim() : rest;
}

/**
 * The verbatim quote to file with a captured task, if any.
 *
 * A misheard word fixed before filing must NOT drop the quote — the agent
 * seeing both what was typed and what was said is the point of keeping one.
 * But a quote whose utterance the person edited away — cleared, or replaced
 * with a different idea — would attribute words to them about work they never
 * mentioned, so the caller passes every edit through `quoteAfterEdit` and this
 * returns nothing once that has dropped it.
 */
export function quoteForCapture(spoken: string | undefined): string | undefined {
  const quote = spoken?.trim();
  return quote ? quote : undefined;
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

/** A commit as a human reads it. Undefined stays undefined — a blank sha is
 *  not a short sha, and printing `commit ` with nothing after it is worse
 *  than saying "evidence". */
export function shortCommit(commit: string | undefined): string | undefined {
  const trimmed = commit?.trim() ?? '';
  return trimmed.length > 0 ? trimmed.slice(0, 10) : undefined;
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
    case 'task.body_edited': {
      // Typing in a task body is deliberately NOT activity (the snapshot
      // fires no event at all). This row is the other thing: a wholesale
      // rewrite through the body route, which is how a thin task gets its
      // acceptance criteria — worth a line, because the reader who filed it
      // is looking at different words than the ones they wrote.
      //
      // When the same act retitled the row (triage shaping a raw capture),
      // the old title has to be in the line: it is the ONLY name the person
      // who filed it would recognise, and after the rewrite it survives
      // nowhere else on the board.
      const from = ev.titleFrom as string | undefined;
      const to = ev.titleTo as string | undefined;
      if (from && to) return `${actorName(ev)} reshaped “${from}” into “${to}”`;
      return `${actorName(ev)} rewrote the description of ${title()}`;
    }
    case 'task.evidence_amended': {
      // Two different sentences, because the two cases mean different things
      // to a reader of the trail. Filling a gap says the work was proven all
      // along and the metadata slipped. A correction says the sha printed
      // against that move is one nobody should follow — and someone may have
      // followed it already.
      const commit = shortCommit((ev.evidence as { commit?: string } | undefined)?.commit);
      const old = shortCommit((ev.supersedes as { commit?: string } | undefined)?.commit);
      const what = commit ? `commit ${commit}` : 'evidence';
      return old
        ? `${actorName(ev)} corrected the evidence on ${title()}: ${what} replaces ${old}`
        : `${actorName(ev)} attached ${what} to an earlier move on ${title()}`;
    }
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

/** What the attachments read says about plugin versions. */
export interface PluginRelease {
  /** The version this server's deploy source would install; null if its
   *  manifest could not be read. */
  version: string | null;
  behind: Array<{ agentId: string; pluginVersion?: string }>;
  /** How many sessions `behind` was computed over — the DOMAIN of the check.
   *  Optional because a client can outlive the server release that added it;
   *  when it is missing the notice states the domain without a count rather
   *  than guessing one. */
  checked?: number;
}

export interface DriftNotice {
  headline: string;
  detail: string;
  fix: string;
  /**
   * `alert` — something is wrong and there is a fix to run.
   * `coverage` — nothing is wrong *within what was checked*, and this says
   * what that was. Rendered quietly: a line that is always there must not
   * look like an alarm, or it trains people to stop reading the alarms.
   */
  kind?: 'alert' | 'coverage';
}

/**
 * What this reading can see. Said in the surface, every time, because the
 * alternative was measured: the strip rendered NOTHING over one attachment
 * while the wider fleet was several releases back, and nothing reads exactly
 * like all-clear.
 */
const PLUGIN_DOMAIN =
  'Only sessions that attach to this board are checked — a peer that never attached is absent here, not current.';

/** Two steps, and the ORDER is load-bearing.
 *
 * `command` — because `claude` is a shell FUNCTION on this machine that
 * injects flags ahead of the subcommand, so the bare form is parsed as a
 * prompt and dies with a message that reads like a permission refusal. An
 * agent already filed that as "deploying is not mine to run". Printing a
 * remediation known to fail is worse than printing none; `command` is inert
 * wherever no such wrapper exists.
 *
 * Restarting FIRST re-resolves the cache as it stands, which has moved a
 * session BACKWARDS a version in exactly this situation.
 */
const PLUGIN_FIX =
  'Run: command claude plugin update live-feedback@claude-live-feedback — then restart that session.';

/** `(2 checked)`, or nothing at all when the server did not send a count. */
function checkedClause(checked: number | undefined): string {
  return checked === undefined ? '' : ` (${checked} checked)`;
}

/**
 * "Some of your agents can't do what you just merged" — and, when none of
 * them are, what "none of them" was counted over.
 *
 * A merge does not deliver: the plugin resolves from a version-keyed cache,
 * so somebody has to run the update and the session then has to restart. That
 * went unnoticed for eleven releases because the only way to find out was to
 * go and look. This is the looking, done by the board.
 *
 * It used to return null whenever nobody was behind, which is the same defect
 * one level up. The strip's domain is "sessions that called `attach_agent` on
 * THIS board" and there is no server-wide session registry to widen it with —
 * so silence means "nothing I can see is behind", and it was read as "no
 * session is behind". Measured 2026-08-17: `behind: []` over a single
 * attachment, while sessions elsewhere in the fleet sat releases back. Fixing
 * that one session took the reading from naming one to naming nobody without
 * touching the drift. So a clear result now SAYS it is clear-within-a-domain
 * and how big that domain was; only the alarm is silent when there is nothing
 * to raise.
 *
 * Three things it still deliberately will not do: invent a claim when the
 * released version is unknown (it says it cannot check instead of saying
 * nothing), print a blank where a session is too old to report its version
 * ("too old to name" is the true statement there), and imply that an empty
 * `behind` list clears anything outside the count beside it.
 */
export function pluginDriftNotice(release: PluginRelease | null | undefined): DriftNotice | null {
  // No attachments read at all — not even the domain is known yet, so there
  // is genuinely nothing to say. This is the ONLY silent branch.
  if (!release) return null;
  const { version, checked } = release;
  const behind = release.behind ?? [];

  if (!version) {
    // The manifest was unreadable. Claiming drift would be inventing it —
    // but so would saying nothing, which reads as "checked, all fine".
    return {
      kind: 'coverage',
      headline: "Plugin versions can't be checked here",
      detail: `This server could not read its deploy source's plugin manifest, so no session's bundle has been compared${checkedClause(checked)}.`,
      fix: 'Nothing on this strip is a clearance until that manifest reads.',
    };
  }

  if (behind.length === 0) {
    return {
      kind: 'coverage',
      headline:
        checked === 0
          ? `Nothing has been checked against ${version} — no session has attached to this board`
          : `No attached session is behind ${version}${checkedClause(checked)}`,
      detail: PLUGIN_DOMAIN,
      fix: 'Not a fleet-wide clearance: a session that has not attached here is unchecked, not current.',
    };
  }

  return {
    kind: 'alert',
    headline: `${behind.length} ${behind.length === 1 ? 'agent is' : 'agents are'} running an older plugin than ${version}`,
    // The domain rides the alarm too. "1 agent is behind" is also a statement
    // about attached sessions only, and a count of 1-out-of-1 is a different
    // thing to act on than 1-out-of-9.
    detail: `${behind
      .map((b) => `${b.agentId} ${b.pluginVersion ?? '(too old to report)'}`.trim())
      .join(', ')}${checked === undefined ? '' : ` — of ${checked} checked`}. ${PLUGIN_DOMAIN}`,
    fix: PLUGIN_FIX,
  };
}

/** What the attachments read says about the client this server publishes.
 *  Owner-only, and absent entirely on a server that publishes nothing. */
export interface ClientRelease {
  releaseId: string | null;
  publishedAt: number | null;
  ageMs: number | null;
  sourceRef: string | null;
  consecutiveFailures: number;
  failingSince: number | null;
  lastError: string | null;
  /** The server's call, not this module's: the arming rule (and its "one
   *  transient failure is not news" silence) lives next to the ledger it
   *  reads, so there is exactly one place that decides. */
  stale: boolean;
}

/** A build error can be long; the strip is not a log viewer. */
const MAX_ERROR_CHARS = 200;

/**
 * "Every browser here is running an old client."
 *
 * A failed client build keeps the previous release live — the right call,
 * stale beats down — but it used to say so ONLY on stderr in a supervisor log,
 * which is not a surface. A build that keeps failing then means an ever-older
 * client against an ever-newer server: the exact server-new/client-old split
 * the release mechanism exists to prevent, reintroduced through the failure
 * path.
 *
 * So the age is the headline. "Stale" alone does not say whether the split is
 * minutes or a week, and the gap is the whole reason to care.
 */
export function clientDriftNotice(
  release: ClientRelease | null | undefined,
  now: number,
): DriftNotice | null {
  if (!release?.stale) return null;
  const headline =
    release.publishedAt === null
      ? 'No client has ever been published here — the build has never succeeded'
      : `Every browser here is running a client published ${timeAgo(release.publishedAt, now)}`;

  const parts: string[] = [];
  const n = release.consecutiveFailures;
  parts.push(
    n === 1
      ? 'The last build failed'
      : `${n} builds in a row have failed${
          release.failingSince === null ? '' : ` since ${timeAgo(release.failingSince, now)}`
        }`,
  );
  if (release.sourceRef) parts.push(`the live release was built from ${release.sourceRef}`);
  if (release.lastError) {
    const err =
      release.lastError.length > MAX_ERROR_CHARS
        ? `${release.lastError.slice(0, MAX_ERROR_CHARS)}…`
        : release.lastError;
    parts.push(err);
  }
  return {
    headline,
    detail: `${parts.join(' · ')}.`,
    // The restart is the deploy for the browser client: a fixed build changes
    // nothing for anybody until this server starts again and publishes it.
    fix: 'Fix the build in the deploy source, then restart the review server — the restart is the client deploy.',
  };
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
