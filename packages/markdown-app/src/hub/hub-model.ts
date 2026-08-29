/**
 * Pure view-model logic for the workspace hub (plan §3.9). Everything here is
 * computed from the ws:<workspaceId> ydoc projection + REST payloads — no DOM,
 * no fetch — so the board's grouping/filter/ordering rules are unit-testable
 * without a browser.
 */
import type { ReviewPayload } from '@feedback/core';
import { tabTitle } from '../tab-title.ts';

/** `triage` is what a row is before `todo`: an agent filed it and nobody has
 *  vetted it. It keeps its band and its order — the only thing it changes is
 *  that no dispatch read returns it. Goals never carry it (see
 *  `GOAL_STATUS_ORDER`). */
export type TaskStatus = 'triage' | 'todo' | 'in-progress' | 'done';

export interface HubActor {
  name: string;
  kind: 'person' | 'agent';
}

/**
 * Who holds a task, as a KIND rather than a name.
 *
 * `unknown` is a third real state, not a placeholder: an owner nobody has
 * declared and no agent attachment vouches for genuinely is unknown, and the
 * board says so rather than picking the friendlier of the two answers. The
 * server owns the judgement (`resolveOwnerKind`) because half of what it
 * rests on — the workspace's agent roster — never enters the ydoc, so a
 * browser deriving it would give a share visitor a different answer from the
 * owner's.
 */
export type HubOwnerKind = 'person' | 'agent' | 'unknown';

export interface HubTransition {
  ts: number;
  from: string;
  to: string;
  by: HubActor;
  note?: string;
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
  /**
   * What the server resolved the owner to be. Absent on any row projected
   * before this field existed, and by a reader that could not know — both of
   * which read as `unknown` (see `ownerKind`), never as a person.
   */
  ownerKind?: HubOwnerKind;
  needs?: 'action' | 'decision';
  goal: string;
  order: number;
  after: string[];
  afterEnforce?: string[];
  dueAt?: number;
  /** Soft-deleted at this instant — off every lane, one tap from coming back.
   *  The row is still PROJECTED while archived (that is what lets the Undo
   *  toast and the restore list draw without a fetch); `taskVisible` is what
   *  keeps it out of the board. `isTaskArchived` is the one reader. */
  archivedAt?: number;
  /** Who archived it, as a display name. */
  archivedBy?: string;
  /** Why, in their words — the line the restore list shows. */
  archiveReason?: string;
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
  triagedAgainst?: { goalId: string; ts: number };
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
   *  from "is this row under Backlog", the proxy it replaced, which was wrong
   *  in both directions (an explicit `goal: 'chores'` IS a placement, and a
   *  task swept into Backlog by a band removal keeps its old
   *  `triagedAgainst`). */
  unplacedSince?: number;
  createdAt: number;
  updatedAt: number;
}

export interface HubSubgoal {
  id: string;
  title: string;
  dueAt?: number;
  /** The goal ROW's status, decorated onto the band by the server projection.
   *  Absent on a projection from an older server — a band that claims
   *  nothing, not one that claims to be open. */
  status?: TaskStatus;
  /** When the goal was declared done — the last transition to done. */
  doneAt?: number;
  /** Who declared it. Display name and kind only (§3.3 visitor contract). */
  doneBy?: HubActor;
  /** The goal ROW's owner, when the projection decorates one. Absent means
   *  the band is a vacancy (no verb sets a goal's owner yet, so today that is
   *  every band) — or an older server that decorates nothing. Either way the
   *  row draws no name it was not given. */
  assignee?: string;
  ownerKind?: HubOwnerKind;
  /**
   * The goal's live description room — `task:<goalId>`, the same prefix a
   * task's body uses (settled in the goals-as-a-task-type design: goal ids
   * are `g-…` and task ids are `t-…`, so one namespace holds both and every
   * piece of body machinery applies unchanged).
   *
   * The ADDRESS, not the text: it is projected even for a goal nobody has
   * described, because the panel mounts its editor on it and fetches the
   * discussion from it, both of which have to work on an empty goal. Absent
   * from an older server's projection, and the panel then draws the
   * description read-only with no link out rather than a link that 404s.
   */
  bodyDocId?: string;
  /** The description, capped by the projection the way a task's is. */
  body?: string;
  /** Whether that cap bit. Only the pre-mount fallback can be short — the
   *  room is not capped, and the editor reads the room. */
  bodyTruncated?: boolean;
  /** How many comments the goal's discussion holds. Absent means none; the
   *  band says nothing rather than saying zero. */
  commentCount?: number;
}

export interface HubGoal extends HubSubgoal {
  subgoals?: HubSubgoal[];
}

export interface HubWorkspaceInfo {
  id: string;
  name: string;
  goals: HubGoal[];
  /** The agent responsible for this board. Absent = the seat is empty, and
   *  the strip says so rather than showing a stale or guessed name. */
  leadAgentId?: string;
  /** When this board was retired — present iff it was. Absent = live; the
   *  board never infers a retirement, the same way it never guesses a lead. */
  retiredAt?: number;
  /** What the person who retired it said, shown on the badge's tooltip. */
  retiredReason?: string;
  createdAt: number;
}

/** Reserved out-of-band catch-all section (§3.2 edit contract): always
 *  rendered last, never in goals[], not reorderable or deletable. */
export const CHORES_ID = 'chores';

/**
 * The one spelling of the Backlog header, shared by the section and by
 * anything else that has to name the goal a task sits under.
 *
 * The constant is still `CHORES_*` because **the id is still `chores`** and
 * deliberately stays that way (Bryan, 2026-08-21, asked only for the label).
 * That id is written into every task's `goal` field and into every `.ydoc`,
 * and plugin bundles in the field send `goal: "chores"` on the shared REST
 * route from sessions nobody here can restart — so renaming it is a data
 * migration plus a compatibility break, in exchange for nothing anyone can
 * see. Label and id are allowed to disagree; that is what this pair is.
 */
export const CHORES_TITLE = 'Backlog';

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

/** The reserved owner meaning "a person, unnamed" — one spelling, so the two
 *  readers below cannot drift apart. Mirrors the server's HUMAN_ASSIGNEE. */
const HUMAN_OWNER = 'human';

/**
 * What kind of somebody holds this task.
 *
 * The one reader of the projected field, so "absent means unknown" is
 * decided once. Everything on the surface that distinguishes a person's work
 * from an agent's goes through here — a second reading of the same field
 * with a different default is the bug generator this codebase has already
 * been bitten by (two spellings of "not found" made a live branch
 * unreachable while reading as correct).
 */
export function ownerKind(task: HubTask): HubOwnerKind {
  if (task.ownerKind !== undefined) return task.ownerKind;
  // The reserved literal is not a display name — it has meant "a person, and
  // this board does not say which one" since before the kind existed. Reading
  // it here is not the name-matching this field exists to avoid, and it keeps
  // a row that reached the client without a resolved kind (an SSE payload,
  // state projected by an older release) saying what it has always said.
  return task.assignee.trim().toLowerCase() === HUMAN_OWNER ? 'person' : 'unknown';
}

/**
 * "This is in the unnamed-person bucket" — the reserved `human` owner.
 *
 * Deliberately NOT the same question as `ownedByPerson` below, though it was
 * until people could be named. `human` means "a person, and this board does
 * not say which one", which on a single-reader board is a fair proxy for the
 * viewer — so My Tasks keeps using it. Widening this one to every declared
 * person would file a task owned by SOMEBODY ELSE under the viewer's own tab,
 * which is a worse answer than the gap it would close.
 *
 * Case-folded to match `ownerKind` above. They disagreed for one release, and
 * the disagreement had a victim: a row stored `Human` drew the person mark
 * and was still missing from My Tasks — two spellings of one question, in one
 * file, which is the bug generator this module's own comments argue against.
 */
export function assignedToHuman(task: HubTask): boolean {
  return task.assignee.trim().toLowerCase() === HUMAN_OWNER;
}

/**
 * "A person is on the hook for this" — whoever they are, named or not.
 *
 * The question every surface phrased as "what a human owes" actually wants,
 * and the one that could not be asked while ownership was the literal
 * `human`. One spelling, so the blocked-note rows and anything built next to
 * them cannot drift apart.
 */
export function ownedByPerson(task: HubTask): boolean {
  return ownerKind(task) === 'person';
}

/**
 * Has this row been soft-deleted? The browser's copy of the server's
 * `isArchived`, and the ONE reader of `archivedAt` on this side.
 *
 * Note what it is NOT a question about: `now`. An archive is a decision that
 * stands until somebody undoes it, so no surface has to re-ask it as the
 * clock moves.
 */
export function isTaskArchived(task: HubTask): boolean {
  return task.archivedAt !== undefined;
}

/** The archived rows, newest removal first — what the restore list draws.
 *  Deliberately unfiltered by tab or done-window: a person looking for what
 *  they archived is looking for a specific row, and the board's viewing
 *  filters would hide it for reasons that have nothing to do with the search. */
export function archivedTasks(tasks: HubTask[]): HubTask[] {
  return tasks.filter(isTaskArchived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
}

export function taskVisible(task: HubTask, f: BoardFilters): boolean {
  // First and unconditionally: an archived row is off the board. It is still
  // projected — the Undo toast and the restore list read it from the same
  // board state — so this filter is the whole of what "off the board" means.
  if (isTaskArchived(task)) return false;
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

// ── Board sections (goals ARE the sections; Backlog last) ───────────────────

export interface BoardSection {
  id: string;
  title: string;
  /** 0 = goal, 1 = subgoal (one level max — §3.2). */
  depth: 0 | 1;
  dueAt?: number;
  /** The band's own status, carried from the goal row (see `HubSubgoal`).
   *  Absent on Backlog — a bucket, not a goal — and on undecorated bands. */
  status?: TaskStatus;
  doneAt?: number;
  doneBy?: HubActor;
  /** The goal row's owner, carried the same way (see `HubSubgoal`). */
  assignee?: string;
  ownerKind?: HubOwnerKind;
  /** The goal's description and its discussion, carried the same way again —
   *  see `HubSubgoal` for what each one is and why the address rides even
   *  when the text does not. Absent on Backlog: a bucket has no body. */
  bodyDocId?: string;
  body?: string;
  bodyTruncated?: boolean;
  commentCount?: number;
  isChores: boolean;
  tasks: HubTask[];
}

function byBoardOrder(a: HubTask, b: HubTask): number {
  return a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * Goal order IS priority order (§3.2): sections follow goals[], each goal's
 * subgoals nested directly after it, Backlog always last. A task whose goal id
 * matches no section (transient state while a goal-list edit lands) renders
 * under Backlog — dropping it would be the store-has-it/surface-can't-show-it
 * bug all over again.
 */
export function boardSections(goals: HubGoal[], tasks: HubTask[], f: BoardFilters): BoardSection[] {
  const sections: BoardSection[] = [];
  // The status trio and the owner ride from the decorated goal onto its
  // section verbatim — conditionally, so an undecorated band's section claims
  // nothing rather than carrying a fistful of undefined keys.
  const carriedOf = (g: HubSubgoal) => ({
    ...(g.status !== undefined ? { status: g.status } : {}),
    ...(g.doneAt !== undefined ? { doneAt: g.doneAt } : {}),
    ...(g.doneBy !== undefined ? { doneBy: g.doneBy } : {}),
    ...(g.assignee !== undefined ? { assignee: g.assignee } : {}),
    ...(g.ownerKind !== undefined ? { ownerKind: g.ownerKind } : {}),
    ...(g.bodyDocId !== undefined ? { bodyDocId: g.bodyDocId } : {}),
    ...(g.body !== undefined ? { body: g.body } : {}),
    ...(g.bodyTruncated !== undefined ? { bodyTruncated: g.bodyTruncated } : {}),
    ...(g.commentCount !== undefined ? { commentCount: g.commentCount } : {}),
  });
  for (const g of goals) {
    sections.push({
      id: g.id,
      title: g.title,
      depth: 0,
      dueAt: g.dueAt,
      ...carriedOf(g),
      isChores: false,
      tasks: [],
    });
    for (const sg of g.subgoals ?? []) {
      sections.push({
        id: sg.id,
        title: sg.title,
        depth: 1,
        dueAt: sg.dueAt,
        ...carriedOf(sg),
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
 * Where a goal sits in board priority order — the index of its section, with
 * Backlog and any unrecognised goal id last.
 *
 * Lives beside `boardSections` and repeats its traversal on purpose: both
 * answer "which band is this task in", and the Backlog fallback has to be the
 * same answer in both, or the review queue would order asks differently from
 * the board they are about. A test asserts the two agree, including the
 * fallback, since nothing else would catch the drift.
 */
export function goalRank(goals: HubGoal[]): (goalId: string) => number {
  const rank = new Map<string, number>();
  let next = 0;
  for (const g of goals) {
    rank.set(g.id, next);
    next += 1;
    for (const sg of g.subgoals ?? []) {
      rank.set(sg.id, next);
      next += 1;
    }
  }
  const last = next;
  return (goalId) => rank.get(goalId) ?? last;
}

/**
 * What the board calls `goalId` — the text on the section header the task's
 * row actually sits under.
 *
 * It lives next to `boardSections` and shares its fallback on purpose: every
 * goal id that has no section (the Backlog catch-all, a goal deleted out from
 * under a task) renders under Backlog, so anything naming a goal elsewhere has
 * to say Backlog too. Two places deciding that independently is how a row ends
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
   *  Backlog today, but "scroll to the Backlog header" would bake that proxy
   *  back into the surface through the back door. */
  oldestTaskId: string;
  /** "3 tasks have no goal yet" — how many. */
  label: string;
  /** "oldest waiting 6d" — how long. */
  detail: string;
}

/**
 * The bucket's whole risk is that it is QUIET. Unplaced work rests at the
 * bottom of Backlog, which is the band nobody scrolls to, so the failure mode
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
// A drop says WHICH ROW it lands behind, not what number to write.
//
// The first cut computed a fractional `position` between the two neighbours'
// orders, on the reading that `task.order` is fractional and therefore always
// has room between any two values. It does not: nothing forces `order` to be
// distinct within a goal — every caller of `set_task_goal` picks the number
// itself, and agents pick round ones — and between two rows that SHARE an
// order there is no number at all. Any value above the first is also above
// the second, so the board's `(order, createdAt, id)` tiebreak decides where
// the row really goes, and it lands past the row it was dropped in front of.
// Measured on a live board: 5 of the 12 visible rows in one goal shared an
// order with a neighbour, and 14% of that board's expressible drops landed
// somewhere other than where the pointer put them. Bryan reported it as
// "cannot reorder items in the task list", which is the honest description —
// two visibly different drop targets produced one identical result.
//
// The old code carried a tie GUARD (`mid > before.order ? mid : +0.5`) and it
// is worth being exact about why it did not help: it was aimed at the server
// answering `changed: false`, so it bought a request that registers as a move
// while still landing the row in the wrong place. A silent no-op became a
// visible wrong answer.
//
// So the target names a neighbour and the server resolves it against the rows
// it actually holds. An ID rather than an index, because the two ends count
// different rows — this list is filtered (done window, "mine" tab) and the
// server's is not. Everything here is still pure: the only browser-shaped
// input is a list of row rectangles, which `dropIndexFor` takes as plain
// numbers so the decision is testable without layout.

/** The `set_task_goal` call a drop resolves to. */
export interface ReorderTarget {
  goal: string;
  /** The row the dragged one lands directly behind; null for the top of the
   *  goal. */
  after: string | null;
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
  return { goal: section.id, after: rest[clamped - 1]?.id ?? null };
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

/** A task and the open work waiting on it. Same shape as a decision's row
 *  because it is the same computation — but it feeds the task PANEL's blocked
 *  note now, not a queue band. */
export type BlockerRow = DecisionRow;

/**
 * Open, human-owned tasks that other open work names in `after`.
 *
 * The board's six real dependency edges pointed at none of its decisions —
 * they pointed at a person's own tasks (turn on the tunnel, merge the PR), and
 * no surface said so. **Where this surfaces moved (approved design,
 * review-flow-mock-v1): a blocker is task STATE, not a review item.** There is
 * nothing to answer on it — the only move is to go and do the work — so it
 * renders as the amber note on its own task's detail panel, and `reviewQueue`
 * deliberately does not read these rows any more. Two rules are still
 * load-bearing:
 *
 * - **Nothing waiting means not here.** A task nobody is waiting on is just a
 *   task; a note on every human-owned ticket would mean nothing.
 * - **A decision is not a blocker.** A decision already surfaces as itself,
 *   with an answer path; stamping it blocked too would say one thing twice.
 *
 * Ownership is the server-resolved `ownerKind`, so a task handed to a person
 * by NAME is in this band and one held by a named agent is not. That closes a
 * limit this band shipped with — the literal `human` — without reaching for
 * either tempting name comparison. Matching the VIEWER's name was rejected
 * because the strip is one shared read of the workspace and keying it on the
 * reader would make the count at the top differ per reader; matching a list of
 * known people was rejected because a reader whose display name happens to be
 * an agent's would sweep every agent-owned blocker in, which is the inflation
 * this band's other rules exist to prevent. An owner nobody has declared
 * resolves to `unknown` and stays OUT — the direction that keeps the strip
 * short, and the one that a wrong guess costs least.
 */
export function humanBlockerRows(tasks: HubTask[]): BlockerRow[] {
  const candidates = tasks.filter(
    (t) => ownedByPerson(t) && t.status !== 'done' && t.needs !== 'decision',
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
  /**
   * `task-review` is a row hanging on a TICKET rather than on a comment — the
   * server ships it on the same route, in the same band, and `reviewQueue`
   * places it like any other declared ask. It carries `taskId` +
   * `reviewItemId` instead of `docId`/`threadId` (those are absent on the
   * wire despite the field types below — the shape predates the kind), and an
   * answer posts to the task review-item route rather than a thread. This
   * model SKIPPED the kind until 2026-08-24, which was the measured defect:
   * review items filed via `create_tasks` / `add_review_item` were shipped by
   * the route and rendered by nothing, so a decision addressed to a person
   * never reached their Home queue.
   */
  /**
   * `goal-thread` is a question asked on a GOAL's discussion. Its own kind
   * rather than a `task-thread` carrying a goal id, because the two open
   * different panels — and `taskId` on one of these holds the GOAL's id, which
   * resolves to no task at all.
   */
  kind: 'task-thread' | 'goal-thread' | 'doc-thread' | 'task-review';
  /** Which row on the ticket, on a `task-review` item — an answer is stamped
   *  back at this id. */
  reviewItemId?: string;
  /**
   * How this row earned its place. Since 2026-08-21 membership is the
   * SERVER's call and every shipped row is an ask: `declared` — an agent
   * said in so many words that it is asking for something, by putting a
   * `review` payload on its comment; `unreplied` — the inferred half, which
   * now fires only on a direct question to a named person that nobody has
   * answered (the old any-agent-comment rule accumulated one permanent row
   * per thing the agents got right, which is what this feature removed).
   *
   * Absent on a payload from a server older than the field. The row is still
   * placed — the server shipped it, so hiding it here would be the
   * vanishing-row bug — it just never renders as a declared card.
   */
  band?: 'declared' | 'unreplied';
  /** The declaration itself, on a `declared` item. */
  review?: ReviewPayload;
  /** Which comment carries the declaration — the answer is written against
   *  it, so a thread with several declarations answers the right one. */
  commentId?: string;
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
  /**
   * On a `task-review` row: `open`, or `revised` — the owner changed the
   * item's words after the reader asked on a phrase of it (2026-08-29). A
   * `waiting` item — asked on, not yet revised — is exactly what the route
   * omits, since it is the owner's turn. Absent from an older server.
   */
  state?: 'open' | 'revised';
  /** On a revised row: when, what the reader had asked (the anchored
   *  thread's first comment), and which span of the NEW detail changed.
   *  `threadId` above names the thread that asked. */
  revisedAt?: number;
  question?: string;
  revisedRange?: { start: number; end: number };
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

export type ReviewKind = 'decision' | 'task-thread' | 'goal-thread' | 'doc-thread' | 'task-review';

/**
 * The id the store gives the review item it DERIVES from a legacy
 * `needs: 'decision'` task — the same string on every legacy ticket, by
 * design (server: `LEGACY_REVIEW_ITEM_ID` in tasks.ts). The queue skips a
 * `task-review` row carrying it, because that decision already arrives as a
 * `decision` row read off the board projection; admitting the derived copy
 * would list one question twice.
 */
export const LEGACY_REVIEW_ITEM_ID = 'r-legacy';

export interface ReviewItem {
  /** Stable across re-fetches. The walkthrough steps by position and the list
   *  reorders underneath it, so identity cannot be the index. */
  key: string;
  kind: ReviewKind;
  /** What this is ABOUT — the decision, the task, the doc. */
  title: string;
  /** The ask itself, one line. Empty for a decision whose body is the ask. */
  ask: string;
  /**
   * Why it sits where it does; the row's DERIVED second line.
   *
   * Not the payload's — that field is gone (2026-08-25). This has always been
   * the queue's own sentence: a decision's blocking line, or the provenance
   * of the comment that raised it. A declared row used to substitute the
   * author's `why` here; it now takes the same provenance line every other
   * thread row gets, and the author's words are read where they were written,
   * in the card's one body.
   */
  why: string;
  since: number;
  /** Set on a decision — the row the answer form and the blocks line need. */
  decision?: DecisionRow;
  /** Set on either thread kind — where the reply gets written. */
  thread?: ReviewThreadItem;
  /** Set when an agent DECLARED this as a review item. Presence decides how
   *  the row RENDERS (the authored card vs the derived line) — never whether
   *  it is in the queue, which is the server's membership call. */
  review?: ReviewPayload;
  /**
   * The owner revised this item's words in answer to a question the reader
   * asked on a phrase of it. The row comes back marked Revised, quoting the
   * question, with the changed span highlighted and a way to the thread.
   * Read off the server row; never set client-side.
   */
  revision?: ReviewRevisionNote;
  /**
   * The reader just asked on this item and it is the owner's turn. Set ONLY
   * by the walkthrough's hold (`holdWaitingItem`): the server drops a waiting
   * item from the queue, and the card the reader asked from must not vanish
   * under them — so the item is kept on its card, with this note, until they
   * step off it. Nothing else reads it, and a re-fetch never carries it.
   */
  waiting?: { question: string; owner: string };
}

export interface ReviewRevisionNote {
  at: number;
  /** The reader's question, as the anchored thread's first comment. */
  question?: string;
  threadId?: string;
  /** The span of the CURRENT `review.detail` that changed, when known. */
  range?: { start: number; end: number };
}

/** A declared item's headline is authored to fit and validated at the API, so
 *  it is shown as written. Everything else is somebody's paragraph and gets
 *  the derived heading — which CLIPS, and clipping an authored headline is
 *  exactly the unreadable row this feature removes. */
export function reviewCardHeadline(item: ReviewItem): string {
  return item.review ? item.review.headline : reviewHeadline(reviewRowTitle(item));
}

/** The task-and-dependents row an item carries, when it carries one. Kept as
 *  the one reader for "which task is this row about" so a future band with a
 *  row lands here rather than in a second spelling of the same question. */
export function reviewRow(item: ReviewItem): DecisionRow | undefined {
  return item.decision;
}

export interface ReviewQueue {
  /**
   * Every row, in the one order. There used to be an `unreplied` shelf
   * beside this for rows the inferred rule produced — kept out of the count
   * and the walkthrough because that rule fired on every agent comment,
   * including exactly what a finished exchange looks like. The server stopped
   * shipping those on 2026-08-21 (a thread row is now a declared item or a
   * surviving direct ask, nothing else), which left the shelf holding real
   * questions that NOTHING rendered — a computed ask invisible on Home. So
   * the shelf is retired: a row the server ships is placed here or it does
   * not exist anywhere, and "every row names something waiting on a person"
   * is the server's promise, not one the client re-derives.
   */
  items: ReviewItem[];
  total: number;
  /** How many are holding other work up right now: decisions with dependents,
   *  and nothing else. Not threads — a comment blocks nothing structurally.
   *  Not human-owned blockers either — those are task state (the panel's
   *  blocked note), not items in this queue, so counting them would promise
   *  the reader something to clear from here that is not here. */
  blocking: number;
}

/**
 * Where one ask sits in the queue. Compared field by field, in this order.
 *
 * A record rather than a tuple so each key can be named at the point it is
 * built — a five-element array of numbers is unreadable at the call site and
 * silently wrong if anyone inserts a key in the middle.
 */
interface AskRank {
  /** 0 = this ask is about a task on the board, so it has a priority to rank
   *  by. 1 = it does not, and sorts after everything that does. */
  placed: 0 | 1;
  /** The task's goal band, then its position inside it — the board's own
   *  order, so the queue and the board agree about what is important. */
  goal: number;
  order: number;
  createdAt: number;
  taskId: string;
  /** Among asks about ONE task (or among the ones with no task at all): the
   *  decision row, then that task's discussion, then a doc
   *  comment. */
  band: number;
  /** 0 = a question addressed to a person by name. Only ever a tiebreak. */
  direct: 0 | 1;
  since: number;
  tie: string;
}

const BAND_TASK_ROW = 0;
const BAND_TASK_THREAD = 1;
const BAND_DOC_THREAD = 2;

function compareAsk(a: AskRank, b: AskRank): number {
  return (
    a.placed - b.placed ||
    a.goal - b.goal ||
    a.order - b.order ||
    a.createdAt - b.createdAt ||
    a.taskId.localeCompare(b.taskId) ||
    a.band - b.band ||
    a.direct - b.direct ||
    a.since - b.since ||
    a.tie.localeCompare(b.tie)
  );
}

/**
 * Everything waiting on a person, in ONE priority order.
 *
 * Bryan's question on coming back to the board is "what do I look at next",
 * and until this existed the board could only answer it for open decisions.
 * The other two kinds were in the store and unreachable from the surface —
 * the failure this codebase has been bitten by before, and the one that
 * presents as the worst possible bug because nothing is actually lost.
 *
 * **Task priority is the primary key** (Bryan, 2026-08-18, answering
 * on the ask-ordering ticket: *"Always order asks by task priority"*). That question was
 * filed precisely because two sort keys disagreed with no stated tiebreak —
 * a P1 asked five hours ago against a P3 that has waited two days — and the
 * standing lean was the opposite, waiting time first inside a priority band.
 * His answer settles it the other way, so priority is the band and the wait
 * is the tiebreak inside it.
 *
 * Priority means the BOARD's order and nothing invented here: goal band
 * first, then the task's own position in it (`goalRank` + `byBoardOrder`).
 * There is deliberately no priority FIELD to set — the board's order already
 * is the priority, so a second one would immediately disagree with the list
 * Bryan drags rows around in.
 *
 * Three consequences worth stating, because each replaces a rule this
 * function used to apply as a primary key:
 *
 *  - **Kind is no longer a band.** A decision and a comment about
 *    the same task now sit together, in that order; asks about a
 *    higher-priority task all come first. Previously every decision on the
 *    board outranked every comment regardless of what either was about.
 *  - **Oldest-first survives only as a tiebreak.** It still orders the
 *    comments on one task, which is where the starvation it protects against
 *    actually happens (an agent's follow-ups burying its own question — see
 *    `since` in review-queue.ts). Across tasks it would contradict the
 *    instruction, so it does not apply there.
 *  - **`direct` likewise.** A question still outranks a status note, but only
 *    among asks of equal task priority.
 *
 * An ask with no task priority — a doc comment, or a task discussion whose
 * task is not in `tasks` — sorts after every ask that has one, keeping the
 * question-first, then oldest-first rule among themselves. That is not a
 * shelf: a doc read still rides in the one queue and the one walkthrough
 * (Bryan, same answer: *"it's okay to mix in 15-30 minute doc reads with
 * quick decisions"*). It is simply the only defined place for an item the
 * primary key cannot speak about.
 *
 * `goals` is optional so a caller that has no goal list still gets a total
 * order — every task then lands in one band and ranks by board order alone,
 * which is a degraded ordering rather than a wrong one.
 */
/**
 * This task's rows, as the DETAIL PANEL is allowed to use them.
 *
 * Two filters, and the second is the one that had to be written down. Rows are
 * matched by `taskId` — a doc-thread row has none and correctly never matches.
 * And `task-review` rows are held back, because the panel answers an ask by
 * posting a comment on `item.threadId`, which a ticket-borne row does not
 * have: its option buttons would file a stray discussion comment and record no
 * answer, and since every ticket row is `direct` it would always win the lead
 * and always render on top — putting a dead copy of the option buttons above
 * the live ones on a legacy decision, and, on a ticket that is not a decision,
 * being the ONLY answer control on screen while answering nothing.
 *
 * A function rather than an inline filter in the app so the rule has one home
 * and a test can hold it. `reviewQueue` skips the same kind for its own
 * reasons; those two guards being separate is exactly how one of them was
 * added and the other forgotten.
 *
 * This comes back when the panel implements the ticket-borne answer path
 * (`POST /api/tasks/:id/review-items/:reviewItemId/answer`).
 */
export function panelAsks(items: ReviewThreadItem[], taskId: string): ReviewThreadItem[] {
  return items.filter((i) => i.kind !== 'task-review' && i.taskId === taskId);
}

export function reviewQueue(
  tasks: HubTask[],
  threadItems: ReviewThreadItem[],
  now: number,
  goals: HubGoal[] = [],
): ReviewQueue {
  const rankGoal = goalRank(goals);
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  /** The rank an ask inherits from the task it is about, or the tail. */
  const rankOf = (
    task: HubTask | undefined,
    band: number,
    direct: boolean,
    since: number,
    tie: string,
  ): AskRank =>
    task
      ? {
          placed: 0,
          goal: rankGoal(task.goal),
          order: task.order,
          createdAt: task.createdAt,
          taskId: task.id,
          band,
          direct: direct ? 0 : 1,
          since,
          tie,
        }
      : {
          placed: 1,
          goal: 0,
          order: 0,
          createdAt: 0,
          taskId: '',
          band,
          direct: direct ? 0 : 1,
          since,
          tie,
        };

  const ranked: Array<{ item: ReviewItem; rank: AskRank }> = [];

  // The decision band's own ordering (enforced edges, then how much is
  // waiting, then age) is no longer the queue's — `decisionQueue` still owns
  // it for the board's own strip, and this only borrows its ROWS.
  const decisions = decisionQueue(tasks);
  for (const row of decisions.rows) {
    ranked.push({
      item: {
        key: `decision:${row.task.id}`,
        kind: 'decision',
        title: row.task.title,
        ask: '',
        why: row.blocks.length === 0 ? 'Nothing is waiting on this yet' : blockingLine(row),
        since: row.task.createdAt,
        decision: row,
      },
      rank: rankOf(row.task, BAND_TASK_ROW, false, row.task.createdAt, row.task.id),
    });
  }

  // A person's own open task that other work waits on is deliberately NOT
  // enqueued (design point 5). It was never a question — there is nothing to
  // answer, only work to do — so it surfaces as state on its own task: the
  // detail panel's blocked note, built from the same `humanBlockerRows`.

  for (const t of threadItems) {
    // TICKET-borne review items place like any other declared ask — this loop
    // skipped the kind wholesale until 2026-08-24, which was the measured
    // defect: an ask filed with `create_tasks`/`add_review_item` was shipped
    // by the route and rendered by nothing, whatever the carrying task's
    // status. Two rows are still refused, each for its own reason: the
    // DERIVED legacy row (`r-legacy`) whose decision already arrives as a
    // `decision` row from the board above — admitting the copy lists one
    // question twice — and a row missing the ids its answer path posts to,
    // because a card whose Answer button writes nowhere is worse than none.
    if (t.kind === 'task-review') {
      if (
        !t.taskId ||
        !t.reviewItemId ||
        t.reviewItemId === LEGACY_REVIEW_ITEM_ID ||
        t.review === undefined
      )
        continue;
      ranked.push({
        item: {
          key: `task-review:${t.taskId}:${t.reviewItemId}`,
          kind: 'task-review',
          title: t.title,
          ask: t.ask,
          review: t.review,
          // Nothing derives a second line for a ticket-borne item: it has no
          // comment to quote the provenance of, and the row renders title +
          // askedMeta regardless. Empty rather than invented.
          why: '',
          since: t.since,
          thread: t,
          ...(t.state === 'revised'
            ? {
                revision: {
                  at: t.revisedAt ?? t.since,
                  ...(t.question !== undefined ? { question: t.question } : {}),
                  ...(t.threadId !== undefined ? { threadId: t.threadId } : {}),
                  ...(t.revisedRange ? { range: t.revisedRange } : {}),
                },
              }
            : {}),
        },
        // Ranks with the task-thread band: it is a question about the WORK,
        // and it inherits the task's own priority when the board read holds
        // the task. A triage row's item may not — it then takes the tail
        // rank rather than vanishing, because the ask is an ask whatever the
        // row's vetting status is.
        rank: rankOf(
          taskById.get(t.taskId),
          BAND_TASK_THREAD,
          true,
          t.since,
          `${t.taskId}:${t.reviewItemId}`,
        ),
      });
      continue;
    }
    // A row of a kind this queue does not place is SKIPPED, not half-built.
    if (t.kind !== 'task-thread' && t.kind !== 'goal-thread' && t.kind !== 'doc-thread') continue;
    const where =
      t.kind === 'task-thread'
        ? 'on this task'
        : t.kind === 'goal-thread'
          ? 'on this goal'
          : 'on this doc';
    const declared = t.band === 'declared' && t.review !== undefined;
    const entry = {
      item: {
        key: `${t.kind}:${t.docId}:${t.threadId}`,
        kind: t.kind,
        title: t.title,
        ask: t.ask,
        ...(declared ? { review: t.review } : {}),
        // "asked" is a claim about there being a question. Say it only when
        // there is one; otherwise the row promises an answerable thing and
        // delivers a status note, which is how a strip stops being believed.
        // The clock beside "asked" has to be the QUESTION's, not the run's.
        // The run can start days before the ask — status, status, then a
        // question — and quoting the run's start there tells the reader they
        // have been sitting on something they were handed minutes ago.
        // The derived provenance line, for declared and inferred rows alike.
        // A declared row used to substitute its author's `why` here; that
        // field is gone, and its words are in the card's one body, which is
        // where a reader opening the row reads them.
        why: t.direct
          ? `${t.askedBy} asked you ${timeAgo(t.askedAt ?? t.since, now)} · ${where}`
          : `${t.askedBy} posted ${timeAgo(t.since, now)} · ${where}`,
        since: t.since,
        thread: t,
      },
      rank: rankOf(
        t.kind === 'task-thread' && t.taskId ? taskById.get(t.taskId) : undefined,
        // A goal's question ranks with a task's rather than with a doc's: it
        // is a question about the WORK, asked by somebody who wants to act on
        // the answer, which is the distinction the two bands draw.
        t.kind === 'doc-thread' ? BAND_DOC_THREAD : BAND_TASK_THREAD,
        t.direct ?? false,
        t.since,
        t.threadId,
      ),
    };
    // Placed regardless of band. Declaring changes what the row LOOKS like
    // (the authored card above vs the derived line), never whether it exists:
    // membership was decided by the server when it shipped the row, and a
    // client-side second opinion is where the shelf full of invisible
    // questions came from.
    ranked.push(entry);
  }

  ranked.sort((a, b) => compareAsk(a.rank, b.rank));
  const items = ranked.map((r) => r.item);

  // Only decisions with dependents count as blocking. A thread blocks nothing
  // structurally, and a human-owned blocker is no longer IN this queue — a
  // count that included it would promise something to clear from here that
  // the list below does not hold.
  return {
    items,
    total: items.length,
    blocking: decisions.blocking,
  };
}

/**
 * Where an item's answer gets WRITTEN — path and body, minus the author the
 * caller adds. One spelling for all three doors, because the walkthrough's
 * reply handler used to build its two thread routes inline: a ticket-borne
 * row reaching it would have posted at `/api/docs/undefined/…` — an answer
 * that lands nowhere while the card advances, which is the one failure the
 * answer flow cannot afford.
 *
 * - `task-review` → the task review-item answer route. `answeredWith` is that
 *   entity's spelling of the tapped candidate's id.
 * - a declared thread item → the thread `/answer` route, which posts the same
 *   reply AND records which candidate it came from on the declaring comment.
 * - anything else → a plain thread comment.
 *
 * Null when the row holds no address to write to; the caller keeps the words
 * in the box rather than sending them nowhere.
 */
export function reviewReplyRequest(
  item: ReviewItem,
  text: string,
  optionId?: string,
): { path: string; body: Record<string, unknown> } | null {
  const t = item.thread;
  if (!t) return null;
  if (t.kind === 'task-review') {
    if (!t.taskId || !t.reviewItemId) return null;
    return {
      path: `/api/tasks/${encodeURIComponent(t.taskId)}/review-items/${encodeURIComponent(t.reviewItemId)}/answer`,
      body: { text, ...(optionId !== undefined ? { answeredWith: optionId } : {}) },
    };
  }
  if (!t.docId || !t.threadId) return null;
  const doc = encodeURIComponent(t.docId);
  const thread = encodeURIComponent(t.threadId);
  const declared = item.review !== undefined && t.commentId !== undefined;
  return declared
    ? {
        path: `/api/docs/${doc}/threads/${thread}/answer`,
        body: {
          text,
          commentId: t.commentId,
          ...(optionId !== undefined ? { optionId } : {}),
        },
      }
    : { path: `/api/docs/${doc}/threads/${thread}/comments`, body: { text } };
}

/**
 * What a question asked ON a review item anchors to: the item, on its task's
 * doc. Only a TICKET-borne item has one — a thread-borne declaration's words
 * live in a comment, and a legacy decision's words are the task body, which
 * the server refuses to anchor this way. Null means "no pill on this card".
 */
export function reviewItemAnchorTarget(
  item: ReviewItem,
): { docId: string; taskId: string; reviewItemId: string } | null {
  const t = item.thread;
  if (!t || t.kind !== 'task-review' || !t.taskId || !t.reviewItemId) return null;
  if (t.reviewItemId === LEGACY_REVIEW_ITEM_ID) return null;
  return { docId: `task:${t.taskId}`, taskId: t.taskId, reviewItemId: t.reviewItemId };
}

/**
 * Where a question on a phrase of an item gets WRITTEN: a thread on the
 * task's doc with a `review-item` anchor. Snippet only, no offsets — the
 * card renders the detail as HTML, and the server locates the phrase in the
 * markdown source itself (uniquely, or it stores the words alone). Mirrors
 * `reviewReplyRequest`: one spelling, minus the author the caller adds.
 */
export function reviewItemAskRequest(
  item: ReviewItem,
  phrase: string,
  question: string,
): { path: string; body: Record<string, unknown> } | null {
  const target = reviewItemAnchorTarget(item);
  if (!target) return null;
  return {
    path: `/api/docs/${encodeURIComponent(target.docId)}/threads`,
    body: {
      text: question,
      anchor: { kind: 'review-item', reviewItemId: target.reviewItemId, snippet: { text: phrase } },
    },
  };
}

/** The words of the current detail that a revision changed, when the range
 *  is known and still spells something. Undefined otherwise — the card then
 *  quotes the question without a mark rather than marking the wrong words. */
export function revisedPhrase(item: ReviewItem): string | undefined {
  const range = item.revision?.range;
  const detail = item.review?.detail;
  if (!range || detail === undefined) return undefined;
  const phrase = detail.slice(range.start, range.end);
  return phrase.trim() === '' ? undefined : phrase;
}

/** The walkthrough's hold on an item the reader just asked on. */
export interface WalkHold {
  key: string;
  /** Where the card stood when the ask was sent. */
  index: number;
  /** The item as it read then, carrying `waiting`. */
  item: ReviewItem;
}

/**
 * Keep an asked-on item on its card while the queue has dropped it.
 *
 * The server takes a waiting item off the queue at once (it is the owner's
 * turn), and the walkthrough re-derives its queue on every paint — so without
 * this the card the reader just typed a question into would be replaced by
 * the next item before they had read the "waiting" note, which reads as the
 * page losing the thing they were doing. The copy goes back at the position
 * it held; the total is left as the server's count, because the hold is a
 * display ledger and not a queue row. Returns the queue itself (same object)
 * when there is nothing to hold or the item is back on its own.
 */
export function holdWaitingItem(queue: ReviewQueue, hold: WalkHold | null): ReviewQueue {
  if (!hold) return queue;
  if (queue.items.some((i) => i.key === hold.key)) return queue;
  const items = queue.items.slice();
  items.splice(Math.min(Math.max(0, hold.index), items.length), 0, hold.item);
  return { ...queue, items };
}

/** "Blocking 2 tasks" / "Hard-blocking 1 task". One phrasing everywhere a
 *  dependent count is spoken. */
function blockingLine(row: DecisionRow): string {
  const n = row.blocks.length;
  return `${row.hard ? 'Hard-blocking' : 'Blocking'} ${n === 1 ? '1 task' : `${n} tasks`}`;
}

/**
 * The task panel's blocked note, in words: the count phrase the decision rows
 * already use, then the NAMES of the open work standing behind this task.
 * The note is read ON the task, where a bare "2 tasks" answers nothing — the
 * reader's next question is always "which ones".
 */
export function blockedNoteLine(row: BlockerRow): string {
  return `${blockingLine(row)}: ${row.blocks.map((t) => t.title).join(', ')}`;
}

// ── Where the walkthrough is standing ──────────────────────────────────────

/**
 * The walkthrough aimed at nothing — what "closed" is spelled as.
 *
 * `walkPosition` answers -1 for this pair whatever the queue holds, and -1 is
 * what puts the Home page back on screen. It is a named constant because two
 * places close the walkthrough for two different reasons — the card's own
 * close button, and arriving at Home from the nav — and a second hand-written
 * spelling is how one of them ends up leaving half the aim behind.
 */
export const CLOSED_WALK = { index: -1, key: null } as const;

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

// ── Landing-page walk handoff ──────────────────────────────────────────────

/**
 * What the landing page's review chip and "Review all" bar hand this app:
 * `?walk=1` means open the walkthrough as soon as the queue is loaded, and
 * `&then=<id,id>` names the workspaces still holding items, to visit after
 * this board's queue drains. Server side of the contract: the landing
 * renderer in `packages/server/src/server.ts`.
 */
export interface WalkHandoff {
  walk: boolean;
  /** The remaining workspaces to visit, in order. Rides in the URL as
   *  `then=` but is named `chain` here — an object with a `then` property
   *  is a thenable, and `await` would try to call it. */
  chain: string[];
}

export function walkHandoff(search: string): WalkHandoff {
  const params = new URLSearchParams(search);
  const walk = params.get('walk') === '1';
  const chain = (params.get('then') ?? '')
    .split(',')
    .map((id) => decodeURIComponent(id).trim())
    .filter(Boolean);
  return { walk, chain: walk ? chain : [] };
}

/** The next hop of the chain, or null when there is nowhere left to go. */
export function walkNextUrl(chain: string[]): string | null {
  const [next, ...rest] = chain;
  if (!next) return null;
  const tail = rest.length ? `&then=${rest.map(encodeURIComponent).join(',')}` : '';
  return `/workspaces/${encodeURIComponent(next)}/home?walk=1${tail}`;
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
export const TASK_STATUS_ORDER: readonly TaskStatus[] = ['triage', 'todo', 'in-progress', 'done'];

/**
 * The statuses a GOAL may be declared to hold — the same list minus `triage`.
 *
 * A goal is created by a person, from the goal list, and there is no path that
 * files one unvetted; the store never mints a goal row in triage. Offering it
 * in the goal's own picker would therefore be a control whose only reachable
 * use is putting a band into a state nothing else in the product produces.
 *
 * A goal's TASKS can of course be in triage, and the goal detail's task counts
 * still say so — that read is over `TASK_STATUS_ORDER`, which is the right
 * list for it.
 */
export const GOAL_STATUS_ORDER: readonly TaskStatus[] = ['todo', 'in-progress', 'done'];

const STATUS_LABEL: Record<TaskStatus, string> = {
  triage: 'Triage',
  todo: 'To do',
  'in-progress': 'In progress',
  done: 'Done',
};

/**
 * A status's label, falling back to the raw string.
 *
 * The board and the server are two artifacts that ship separately: a browser
 * tab open across a deploy is running a bundle whose status enum predates the
 * one the server is now sending. Indexing the record directly returned
 * `undefined` for such a value, which reached the reader as the words
 * "Status: undefined" and left the picker showing a blank option. The raw
 * string is not a nice label, but it is TRUE, and it is what tells whoever
 * reports it what their tab is actually holding.
 */
export function statusLabel(status: TaskStatus): string {
  return STATUS_LABEL[status] ?? String(status);
}

/**
 * The options a status picker offers: the known list, plus the row's CURRENT
 * status when that is not in it.
 *
 * Without the second half a `<select>` handed an unknown value silently
 * resolves to `''` — so the control shows blank, and the first interaction
 * with it writes some other status the reader never chose. Appending the
 * value keeps the picker honest about what the row holds, and keeps every
 * other option one tap away, which is the whole point of the control.
 */
export function statusOptions(current: TaskStatus, known: readonly TaskStatus[]): TaskStatus[] {
  return known.includes(current) ? [...known] : [...known, current];
}

/** The bare word the store used to default to. It names a category rather
 *  than somebody, so a task still carrying it is UNOWNED, not assigned —
 *  and the API refuses to hand a task to it. */
export const GENERIC_ASSIGNEE = 'agent';

/** The four states the owner mark can be in. `human` keeps its name because
 *  it is the class the person styling has always carried; it now covers every
 *  person, not only the reserved literal. */
export type OwnerMarkKind = 'none' | 'human' | 'agent' | 'unknown';

/**
 * Which mark to draw for this owner.
 *
 * `none` is "nobody has this" and is answered from the assignee alone — a
 * hole in the board, and a different question from person-or-agent. For
 * everyone else the answer is the server's `ownerKind`, never the name: a
 * rule that pattern-matched names would be wrong for somebody, silently, and
 * the board would keep drawing a plausible mark over it. An owner nobody has
 * declared gets its own mark rather than being folded into `agent`, which is
 * what the board did before and is why a person named Bryan was drawn
 * identically to an agent.
 */
export function ownerMarkKind(task: HubTask, owner: string): OwnerMarkKind {
  if (owner === '') return 'none';
  switch (ownerKind(task)) {
    case 'person':
      return 'human';
    case 'agent':
      return 'agent';
    default:
      return 'unknown';
  }
}

/**
 * The words that carry the distinction for anyone not reading the colour.
 *
 * The mark is a coloured circle of initials, and colour alone is not a
 * distinction — it is invisible to a screen reader and unreliable for a
 * colour-blind reader. So the kind rides the picker's accessible name and
 * its tooltip, which is where the owner's full name already lives.
 */
export function ownerKindSuffix(kind: OwnerMarkKind): string {
  switch (kind) {
    case 'human':
      return ' (person)';
    case 'agent':
      return ' (agent)';
    case 'unknown':
      return ' (person or agent not recorded)';
    default:
      return '';
  }
}

/**
 * One or two letters for the circle that stands in for an owner.
 *
 * A board row is read for its TITLE, and the two controls flanking it were
 * spending ~200px on the words "In progress" and a full agent id — on the
 * surface whose entire job is letting someone scan what the work is. The name
 * does not disappear: it stays on the picker's `title`/`aria-label` and in the
 * detail panel, where there is room for it.
 *
 * `agent-` / `agent_` leads are dropped before the initials are taken, because
 * every agent id starts with it and a column of "A"s distinguishes nobody.
 * A single word yields ONE letter rather than its first two — "HU" for `human`
 * reads as a name fragment, "H" reads as a mark.
 */
export function ownerInitials(owner: string): string {
  const trimmed = owner.trim();
  if (trimmed === '' || trimmed.toLowerCase() === GENERIC_ASSIGNEE) return '?';
  const words = trimmed
    .replace(/^agent[-_\s]+/i, '')
    .split(/[-_\s.]+/)
    .filter((w) => /[a-z0-9]/i.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0][0] ?? '?').toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

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

/**
 * One task's audit rows, newest first — what the panel's Activity tab shows
 * beside the stored transition list.
 *
 * `task.transitioned` is dropped because the panel renders those from
 * `task.transitions` — the stored trail, which is on the row itself rather
 * than in a log that has to be fetched. Everything else a task can have done
 * TO it —
 * renamed, rewritten, reassigned, re-dated, answered, taken back — reached
 * the workspace feed and no surface on the ticket. Measured 2026-08-18: the
 * tab logged status changes and nothing else, so a rename left no trace on
 * the ticket it renamed.
 */
export function taskActivity(events: ActivityEvent[] | undefined, taskId: string): ActivityEvent[] {
  return (events ?? [])
    .filter(
      (e) =>
        e.taskId === taskId &&
        e.event !== 'task.transitioned' &&
        e.event !== 'agent.heartbeat' &&
        e.event !== 'server.tick',
    )
    .sort((a, b) => b.ts - a.ts);
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

/**
 * How an assignee id reads to a person.
 *
 * `human` is a reserved id meaning "a person, unspecified" — every other value
 * is an agent's own name and reads fine as it is. Rendering the reserved word
 * raw put the literal `human` in the dropdown and in its accessible name,
 * which is an implementation detail presented as user-facing copy.
 *
 * "A person" rather than "Me" or a name: the id says a person owns this and
 * says nothing about WHICH, and inventing the reader is how a shared board
 * starts telling two people different things about the same row.
 *
 * It lives in the MODEL rather than beside the picker because the picker is
 * not the only surface that renders an assignee: `task.assigned` in
 * `describeEvent` renders the same id into the activity trail, and it read
 * `Panel Reviewer → human` while the dropdown two inches above it said "A
 * person". Two copies of "how does this id read" drift, and the drift lands in
 * the feature's own subject.
 */
export function assigneeLabel(id: string): string {
  return id === 'human' ? 'A person' : id;
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

/**
 * The store events whose arrival stales the REST-fed activity trail — the SSE
 * wiring in hub-app subscribes to exactly this list and calls `loadEvents` on
 * each. It lives here, next to `describeEvent`, because the two must move
 * together: an event the trail can RENDER but the list omits never refreshes
 * the trail, for the writer's own tab as much as for a peer's (the server
 * echoes local writes back over SSE, so this list is also how a due date you
 * just set gets its Activity row). That was the measured failure for
 * `task.due_set` and `decision.answer_withdrawn` — emitted, logged, rendered
 * on the next full load, and invisible on the tab the reader was looking at.
 *
 * Deliberately NOT every `describeEvent` case: `agent.*` refreshes the
 * presence strip through its own listeners, `server.started` and the retired
 * `task.gate_refused` / `task.evidence_amended` have no live emitter to hear,
 * and `task.body_edited` predates this list and is out of its scope.
 */
export const ACTIVITY_REFRESH_EVENTS = [
  'task.created',
  'task.transitioned',
  'task.assigned',
  'task.retitled',
  'task.due_set',
  'task.archived',
  'task.restored',
  'task.regrouped',
  'decision.answered',
  'decision.answer_withdrawn',
  'decision.info_requested',
  'workspace.goals_changed',
] as const;

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
      return `${actorName(ev)} assigned ${title()}: ${assigneeLabel(String(ev.from))} → ${assigneeLabel(String(ev.to))}`;
    case 'task.regrouped':
      return `${actorName(ev)} regrouped ${title()}: ${String(ev.fromGoal)} → ${String(ev.toGoal)}`;
    case 'task.due_set': {
      // Three sentences, because clearing a date and setting one read
      // differently to whoever is scanning the trail for what slipped.
      const when = (v: unknown): string =>
        typeof v === 'number' ? new Date(v).toLocaleDateString() : '';
      const to = when(ev.to);
      const from = when(ev.from);
      if (!to) return `${actorName(ev)} cleared the due date on ${title()}`;
      if (from) return `${actorName(ev)} moved ${title()} from ${from} to ${to}`;
      return `${actorName(ev)} set ${title()} due ${to}`;
    }
    // Retired 2026-08-27 — parking is a move to triage plus a comment now, so
    // nothing emits this any more. The line stays because the ACTIVITY LOG
    // does: months of real deferrals are in it, and a removed case renders
    // them as a raw event name.
    case 'task.parked': {
      const when = (v: unknown): string =>
        typeof v === 'number' ? new Date(v).toLocaleDateString() : '';
      const to = when(ev.to);
      const from = when(ev.from);
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      if (!to) return `${actorName(ev)} un-parked ${title()}`;
      if (from) return `${actorName(ev)} moved the park on ${title()} to ${to}${why}`;
      return `${actorName(ev)} parked ${title()} until ${to}${why}`;
    }
    case 'task.archived': {
      // The title comes off the EVENT, not from `titleOf`: an archived row is
      // one somebody may rename or restore later, and this line is the record
      // of what left the board on that day.
      const name = typeof ev.title === 'string' && ev.title ? `“${ev.title}”` : title();
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      return `${actorName(ev)} archived ${name}${why}`;
    }
    case 'task.restored': {
      const name = typeof ev.title === 'string' && ev.title ? `“${ev.title}”` : title();
      return `${actorName(ev)} restored ${name}`;
    }
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
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      if (from && to) return `${actorName(ev)} reshaped “${from}” into “${to}”${why}`;
      return `${actorName(ev)} rewrote the description of ${title()}${why}`;
    }
    case 'task.retitled': {
      // A title-only fix. Same rule as the reshape line above: the OLD name
      // is the only one the person who filed the row would recognise, so it
      // leads the sentence.
      const from = ev.titleFrom as string | undefined;
      const to = ev.titleTo as string | undefined;
      const why = typeof ev.reason === 'string' && ev.reason ? ` — ${ev.reason}` : '';
      if (from && to) return `${actorName(ev)} renamed “${from}” to “${to}”${why}`;
      return `${actorName(ev)} renamed ${title()}${why}`;
    }
    // Evidence support was removed on 2026-08-25, so nothing emits this
    // again. The case STAYS for the same reason `task.gate_refused` below
    // does: rows are already in `events.jsonl`, and a type this switch has no
    // case for renders as the bare slug in a feed written for people. What
    // was retired is the ability to WRITE evidence, not the history of when
    // somebody did.
    case 'task.evidence_amended': {
      const commit = shortCommit((ev.evidence as { commit?: string } | undefined)?.commit);
      const old = shortCommit((ev.supersedes as { commit?: string } | undefined)?.commit);
      const what = commit ? `commit ${commit}` : 'evidence';
      return old
        ? `${actorName(ev)} corrected the evidence on ${title()}: ${what} replaces ${old}`
        : `${actorName(ev)} attached ${what} to an earlier move on ${title()}`;
    }
    // The risk gate was removed on 2026-08-18, so nothing emits this again.
    // The case STAYS: rows are already in `events.jsonl`, and a type this
    // switch has no case for falls through to the bare slug
    // `task.gate_refused` — a log line in a feed written for people. Same trap
    // as "A new emitted event reaches the surface as a bare slug" in
    // learnings.md, running backwards. `ev.riskTier` is read off the stored
    // row, not off the task.
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
    case 'decision.answer_withdrawn': {
      // The withdrawn words are IN the line, not implied by it. Whoever reads
      // this trail is usually reading it because an agent acted on an answer
      // that has since been taken back, and "which answer" is the question.
      const answer = typeof ev.answer === 'string' ? ev.answer : '';
      return `${actorName(ev)} took back the answer on ${title()}${answer ? `: “${answer}”` : ''} — it is open again`;
    }
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
  /** WHO this is — `User.id`, which is stable per browser (localStorage) or
   *  is the known user's own id. Optional because a tab running a bundle that
   *  predates it sends no id; `presenceIdentity` falls back to the CONNECTION
   *  there, never to the name — see the reasoning on that function. */
  userId?: string;
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
  /** The PARTICIPANT: `p-<name>` or `a-<agentId>`. Stable across reconnects
   *  and across the several tabs one person may have open — it is the row key
   *  the presence island renders on, and what `followedKey` names. */
  key: string;
  label: string;
  kind: 'person' | 'agent';
  /** Short "where they are" line rendered inside the chip. */
  where: string;
  /** Full detail for the tooltip. */
  title: string;
  docId?: string;
  /** The connection this chip's reading came from — the most recently active
   *  of the person's tabs. Only ever a way to tell tabs apart, never the
   *  identity: it is minted fresh on every connect. */
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
  'Run: command claude plugin update claude-workspaces@claude-workspaces — then restart that session.';

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

/** Two letters a small circle can carry: first letters of the first two
 *  words. Splits on `-`/`_`/`.`/`/` as well as spaces so a multi-segment
 *  agent id ("task-list-ux") reads as "TL" rather than "T", and drops
 *  parenthesised tokens so "Ana (you)" is "A", not "A(". */
export function initialsOf(name: string): string {
  return (
    name
      .split(/[\s\-_./]+/)
      .filter((w) => w.length > 0 && !w.startsWith('('))
      .slice(0, 2)
      .map((w) => [...w][0] ?? '')
      .join('')
      .toUpperCase() || '?'
  );
}

/** Deterministic hue from a label, so the same person wears the same colour
 *  on every paint and every viewer's screen without a stored palette. The
 *  "(you)" suffix is stripped first — you and the person watching you must
 *  agree on your colour. */
export function presenceHue(label: string): number {
  const base = label.replace(/\s*\(you\)$/, '');
  let h = 0;
  for (const ch of base) h = (h * 31 + (ch.codePointAt(0) ?? 0)) % 360;
  return h;
}

/**
 * WHO a presence entry is, as opposed to which connection it arrived over.
 *
 * `userId` is `User.id` — stable per browser (localStorage) or the known
 * user's own — so it is the same across every tab that person has open and
 * different for anybody else. Those are the two things the strip's row key
 * has to get right, and a display name gets both wrong: two people called
 * Alex share one, and it tells tabs apart only by accident.
 *
 * With no id, the fallback is the CONNECTION, not the name. A hub tab running
 * a bundle that predates the id in awareness therefore behaves exactly as
 * every tab did before this change — its own row, rebuilt on reconnect — and
 * critically it does NOT fold with anyone. Falling back to the name instead
 * would merge two strangers who share one (codex review, and it is the right
 * call): the chip would show whichever of them moved last, and following one
 * could land on the other's document. An unstable key for an old tab is a
 * lost DOM node; a wrong identity is a wrong person.
 */
export function presenceIdentity(p: Pick<PresencePerson, 'userId' | 'clientId'>): string {
  return p.userId ?? `c${p.clientId}`;
}

/**
 * Fold every tab one person has open into the ONE person they are.
 *
 * Awareness is per-connection, so a second tab is a second entry with a
 * different Yjs `clientId` and the same human behind it. Left alone that
 * drew the same person twice in the strip and burned two of the four circle
 * slots on one body — and, because a `clientId` is minted fresh on every
 * connect, it also meant a reload rebuilt the row under a new identity.
 *
 * The surviving tab is the most recently active one, because that is where
 * the person actually IS; `self` is sticky across the merge (one of your own
 * tabs being idle must not stop the strip from marking you as you).
 */
function foldTabs(people: PresencePerson[]): PresencePerson[] {
  const byIdentity = new Map<string, PresencePerson>();
  for (const p of people) {
    const id = presenceIdentity(p);
    const prev = byIdentity.get(id);
    if (!prev) {
      byIdentity.set(id, p);
      continue;
    }
    const live = p.lastActive >= prev.lastActive ? p : prev;
    byIdentity.set(id, { ...live, self: Boolean(prev.self || p.self) });
  }
  return [...byIdentity.values()];
}

/** One chip per person and agent (§2.7), people first. Person chips carry the
 *  surface they're on; agent chips carry the derived liveness state — real
 *  signals (heartbeat, last tool call), never guesses.
 *
 *  `key` is the participant, not the connection: `p-<identity>` for a person
 *  (see `presenceIdentity`), `a-<agentId>` for an agent. It is what the
 *  presence island keys its rows on, so it has to survive a reconnect — a key
 *  that changed whenever a browser reconnected would rebuild the row (and
 *  drop an in-flight press) for a person who never moved. */
export function presenceChips(
  people: PresencePerson[],
  agents: PresenceAgent[],
  now: number,
): PresenceChip[] {
  const chips: PresenceChip[] = [];
  const sortedPeople = foldTabs(people).sort((a, b) => a.name.localeCompare(b.name));
  for (const p of sortedPeople) {
    const where = p.surface === 'hub' ? 'hub' : (p.docId ?? p.surface);
    chips.push({
      key: `p-${presenceIdentity(p)}`,
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

// ── The Home pane (per-workspace) ──────────────────────────────────────────

/** Which page of the workspace shell is showing. Two panes, one shell: the
 *  shell mounts once and the panes swap, so the board's live projection
 *  survives a visit to Home. */
export type HubPane = 'home' | 'board';

/**
 * `/workspaces/<id>` stays the BOARD — every link already in the field points
 * there, and a landing page that moved under those links would read as the
 * board having vanished. Home is the explicit `/home` suffix, deep-linkable.
 */
export function paneFromPath(pathname: string): HubPane {
  return /^\/workspaces\/[^/?#]+\/home\/?$/.test(pathname) ? 'home' : 'board';
}

export function panePath(workspaceId: string, pane: HubPane): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return pane === 'home' ? `${base}/home` : base;
}

/**
 * What the top-level nav offers. Four destinations, not two panes and a
 * filter: "My Tasks" and the activity feed were both reachable only from
 * controls INSIDE the board — a segmented tab and a button that swapped the
 * board out — so neither had a URL, neither survived a reload, and the one
 * that answers "what is mine" read as a filter on somebody else's list.
 *
 * `pane` and `tab` remain the state the render path is written against; this
 * is the single thing the URL and the nav agree on, and both of those are
 * derived from it. One source, so a deep link and a click cannot disagree.
 */
export type HubNav = 'home' | 'tasks' | 'mine' | 'activity';

/** `/workspaces/<id>` stays Tasks, for the reason `paneFromPath` gives: every
 *  link already in the field points there. The other three are suffixes. */
export function navFromPath(pathname: string): HubNav {
  const m = pathname.match(/^\/workspaces\/[^/?#]+\/([^/?#]+)\/?$/);
  const suffix = m?.[1];
  if (suffix === 'home') return 'home';
  if (suffix === 'mine') return 'mine';
  if (suffix === 'activity') return 'activity';
  return 'tasks';
}

export function navPath(workspaceId: string, nav: HubNav): string {
  const base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  return nav === 'tasks' ? base : `${base}/${nav}`;
}

export function paneForNav(nav: HubNav): HubPane {
  return nav === 'home' ? 'home' : 'board';
}

/** Activity keeps whichever task filter was showing; it renders no rows of
 *  its own, so answering `'all'` there would silently reset the filter on the
 *  way back. */
export function tabForNav(nav: HubNav): BoardTab | undefined {
  return nav === 'mine' ? 'mine' : nav === 'tasks' ? 'all' : undefined;
}

/** What each destination adds to the browser tab. Tasks adds nothing: it is
 *  the board itself, so its title is just the workspace's name. */
const NAV_TAB_LABEL: Record<HubNav, string> = {
  home: 'Home',
  tasks: '',
  mine: 'My Tasks',
  activity: 'Activity',
};

/**
 * The browser tab's title for a hub. The workspace name leads, because that
 * is what tells two open hubs apart; the pane follows, so that moving between
 * Home, Tasks and Activity is visible in the tab strip rather than only in
 * the URL.
 */
export function hubTabTitle(workspaceName: string, nav: HubNav): string {
  return tabTitle(workspaceName, NAV_TAB_LABEL[nav]);
}

/** The brief as `GET /api/workspaces/:id/home` ships it. */
export interface HomeBriefView {
  markdown: string;
  generatedAt: number;
  /**
   * Where THIS brief's content actually starts. Not the same as the
   * payload's `since`: a generated brief is written from a capped digest, so
   * when the board has been busy it covers less of the window than the
   * window is. The card states this rather than `since`, because the window
   * is what the reader was promised and this is what they got.
   */
  coversFrom?: number;
  source: 'generated' | 'deterministic';
}

export interface HomePayload {
  workspaceId: string;
  /** 0 = this person has never marked caught up here. */
  lastReadAt: number;
  /** Where the brief's coverage actually starts (bounded on a first visit). */
  since: number;
  instructions: string;
  brief: HomeBriefView;
  /** True only when the server actually queued a model call for this reader. */
  generating: boolean;
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "6:12 pm" — hand-rolled so the copy is locale-stable across browsers. */
function clockLabel(d: Date): string {
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m} ${h24 < 12 ? 'am' : 'pm'}`;
}

/** "Friday, 6:12 pm" — a point in time the way a person names one. Today and
 *  yesterday by name; within a week by weekday; beyond that a bare weekday
 *  would be ambiguous, so the date takes over. */
export function sincePointLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const day = (t: number) => {
    const x = new Date(t);
    return `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  };
  const clock = clockLabel(d);
  if (day(ts) === day(now)) return `today, ${clock}`;
  if (day(ts) === day(now - 86_400_000)) return `yesterday, ${clock}`;
  if (now - ts < 7 * 86_400_000) return `${WEEKDAYS[d.getDay()]}, ${clock}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clock}`;
}

/**
 * What the brief covers, as the mockup words it: "From Friday, 6:12 pm until
 * now".
 *
 * The point named is the BRIEF's own coverage start, not the window's. Those
 * differ whenever the board has been busy enough for the digest cap to bite:
 * on the live board 2026-08-18 the window held 553 changes over 7 days and
 * the generated brief was written from the newest 120 of them, 6.7 hours'
 * worth — and the card said "From Aug 11" over it. Reported as "claims to
 * include all work ... seems to be only summarizing the last few days", and
 * the reader was right. `since` remains the fallback for a payload that
 * predates the field.
 */
export function homeSinceLabel(payload: Pick<HomePayload, 'since' | 'brief'>, now: number): string {
  return `From ${sincePointLabel(payload.brief?.coversFrom ?? payload.since, now)} until now`;
}

/** "2 days" — how long something has waited, bare. The walkthrough card's
 *  wait chip (mockup: `2 days` beside the project chip). Same unit boundaries
 *  as timeAgo; under a minute says "moments" rather than a zero. */
export function waitShort(since: number, now: number): string {
  const m = Math.round(Math.max(0, now - since) / 60_000);
  if (m < 1) return 'moments';
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  if (m < 60) return unit(m, 'minute');
  const h = Math.round(m / 60);
  if (h < 24) return unit(h, 'hour');
  return unit(Math.round(h / 24), 'day');
}

/** "waiting 2 days" — the queue row's subline. One clock with `waitShort`,
 *  so the row and the card it opens can never disagree about the wait. */
export function waitingLabel(since: number, now: number): string {
  return `waiting ${waitShort(since, now)}`;
}

/** The mockup's row title is the QUESTION itself — the ask when the item
 *  carries one, the subject when the subject IS the question (a decision). */
export function reviewRowTitle(item: Pick<ReviewItem, 'title' | 'ask'>): string {
  return item.ask.trim() !== '' ? item.ask : item.title;
}

/** How long a card heading may run before it stops being a heading. */
const HEADLINE_MAX = 90;

/**
 * The heading form of a review item's question.
 *
 * The mockup's card carries a SHORT title and, below it, the ask in full. Our
 * threads have no short title — a thread's question is whatever somebody
 * typed, which is regularly a paragraph — so the heading is derived: the first
 * sentence, capped. A decision's title is already short and comes back
 * unchanged.
 *
 * The point is the pair. Print the paragraph as the heading AND again in the
 * quote below it and the card says everything twice, which is the "layout is
 * weird" half of what got the last build rejected.
 */
export function reviewHeadline(text: string): string {
  const flat = text.trim().replace(/\s+/g, ' ');
  // First sentence: a terminator followed by a space or the end. `\S` before
  // it keeps "e.g. " and a bare "?" from ending a sentence that hasn't begun.
  const end = flat.match(/\S[.?!](?=\s|$)/);
  const first = end?.index === undefined ? flat : flat.slice(0, end.index + 2);
  if (first.length <= HEADLINE_MAX) return first;
  const cut = first.slice(0, HEADLINE_MAX);
  const space = cut.lastIndexOf(' ');
  return `${(space > 40 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * The card's kind badge (mockup: the amber `Decision` and the blue
 * `Needs your reply`). A blocker has no entry because a blocker has no card —
 * it is task state, not a review item (design point 5).
 */
export function reviewBadge(kind: ReviewKind): { label: string; tone: string } {
  if (kind === 'decision') return { label: 'Decision', tone: 'decision' };
  return { label: 'Needs your reply', tone: 'reply' };
}

/**
 * The badge for a queue item, declaration included.
 *
 * A declared decision reads as one whether it arrived as a task row or as a
 * comment — which is the point of declaring — so it borrows the task
 * decision's own tone rather than inventing a third amber. A declared
 * `review` gets its own label because "needs your reply" understates a
 * fifteen-minute doc read.
 */
export function reviewItemBadge(item: ReviewItem): { label: string; tone: string } {
  if (item.review?.shape === 'decision') return { label: 'Decision', tone: 'decision' };
  if (item.review?.shape === 'review') return { label: 'Question', tone: 'review' };
  return reviewBadge(item.kind);
}

/**
 * "Asked by Harbor agent 2 days ago" — the head row's top-right meta, the ONE
 * provenance line the card carries (approved design, review-flow-mock-v1; it
 * replaced the left-bordered context block and the bare wait chip).
 *
 * Split from `askedMeta` so a surface with its own row shape (the task
 * panel's `PanelReviewItem`) spells the line identically without inventing a
 * `ReviewItem` to say it — two spellings of "who asked, when" is how the row
 * and the card come to disagree.
 *
 * Built only out of parts we actually hold: a decision whose transitions
 * carry no actor says when it was asked without claiming who asked it. The
 * clock uses `waitShort`, so the row subline and the card head can never
 * disagree about the wait — and the singular/plural comes with it.
 */
export function askedMetaLine(
  who: string | undefined,
  asked: boolean,
  at: number,
  now: number,
): string {
  // "Asked by" is a claim that there is a question — a status note says
  // "Posted by" instead. Saying "asked" over a deploy note is the card
  // promising something answerable and delivering something that is not.
  const verb = asked ? 'Asked' : 'Posted';
  const when = `${waitShort(at, now)} ago`;
  return who && who.trim() !== '' ? `${verb} by ${who} ${when}` : `${verb} ${when}`;
}

/**
 * The meta for a queue item. For a DECLARED item "Asked by" is always true —
 * a declaration IS an ask, in so many words, whatever the `direct` heuristic
 * measured. The inferred band keeps its measured Posted/Asked honesty, since
 * over-including is how a queue stops being believed.
 */
export function askedMeta(item: ReviewItem, now: number): string {
  const thread = item.thread;
  const row = reviewRow(item);
  // A thread carries its asker; a decision's is whoever first moved the task,
  // which is the only actor a projected task row records.
  const who = thread?.askedBy ?? row?.task.transitions[0]?.by.name;
  const asked = item.review !== undefined || (thread ? thread.direct === true : true);
  // The clock beside "asked" is the QUESTION's, not the run's: a run can start
  // days before the ask, and quoting its start tells the reader they have been
  // sitting on something they were handed minutes ago.
  const at = asked ? (thread?.askedAt ?? item.since) : item.since;
  return askedMetaLine(who, asked, at, now);
}

/**
 * The board's one line about the review queue. Null when nothing is waiting —
 * the banner only exists while items are open (approved design), so an empty
 * queue renders nothing rather than an all-clear box.
 *
 * No count, deliberately (Bryan, 2026-08-18, answering the review-queue ticket:
 * "Remove the count. Don't think I need it."). The decision that number was
 * built to make honest — which rows a needs-you COUNT may admit — dissolved
 * with the number itself: the banner says the queue is non-empty, and the
 * Home list is the queue.
 */
export function reviewBannerText(queue: ReviewQueue): string | null {
  if (queue.total === 0) return null;
  return 'Something is waiting for your review';
}

/** How long the Home pane keeps asking after a `generating: true` payload.
 *  The server's own pending window is the real bound; this cap only stops a
 *  client from polling a wedged server forever. */
export const HOME_POLL_CAP_MS = 30_000;

/**
 * Poll only while the server says a generation is actually queued — the
 * grounded flag, never an inference — and give up after the cap so a payload
 * that never settles cannot pin a phone's radio open.
 */
export function shouldPollHome(
  payload: Pick<HomePayload, 'generating'> | null,
  startedAt: number,
  now: number,
): boolean {
  if (!payload?.generating) return false;
  return now - startedAt < HOME_POLL_CAP_MS;
}

/** The anchor sent with each spoken utterance (§3.8). */
export interface VoiceHubContext {
  surface: 'hub' | 'task';
  taskId?: string;
  /** The thread the detail panel is aimed at — the review item the speaker
   *  is IN. Only with the panel open: a highlighted row has no open thread. */
  threadId?: string;
  /** The ticket-borne review item the open panel shows, when the ticket has
   *  exactly one. Same rule: never for a highlighted row. */
  reviewItemId?: string;
}

/** The little of a review-queue row `voiceHubContext` reads. */
export interface VoiceHubItem {
  kind: string;
  taskId?: string;
  reviewItemId?: string;
}

/**
 * Which resource the hub is showing the speaker.
 *
 * Two affordances mean "this ticket", not one: the open detail panel, and the
 * keyboard row cursor (`j`/`k` focus a `.hub-task-row`). Keying on the panel
 * alone made the ticket's own flow — highlight a row, hold the mic, "mark this
 * done" — send `{surface:'hub'}`, and with no resource in view the server's
 * guardrail correctly refused to act on anything.
 *
 * The panel wins when both are set, for the same reason the server prefers a
 * task over a doc: it is the narrower thing in view, and "this" means the
 * narrower one to whoever said it.
 */
export function voiceHubContext(
  detailTaskId: string | null | undefined,
  focusedRowTaskId: string | null | undefined,
  detailThreadId?: string | null,
  items: readonly VoiceHubItem[] = [],
): VoiceHubContext {
  const taskId = detailTaskId || focusedRowTaskId;
  if (!taskId) return { surface: 'hub' };
  // The thread rides only with the PANEL's task: `detailThreadId` is the
  // panel's state, and pairing it with a row cursor would pin a reply to a
  // thread on a different ticket.
  const threadId = detailTaskId && detailThreadId ? detailThreadId : undefined;
  if (threadId) return { surface: 'task', taskId, threadId };
  // A ticket-borne row, likewise only with the panel OPEN on that ticket, and
  // only when it is the one: the server answers a pick on the task surface
  // only against a pin, so a highlighted row — `taskId` alone — can take no
  // answer. "answer: yes" used to land on whatever the cursor rested on.
  if (!detailTaskId) return { surface: 'task', taskId };
  const ticketItems = items.filter(
    (i) => i.kind === 'task-review' && i.taskId === detailTaskId && i.reviewItemId,
  );
  const [only, ...rest] = ticketItems;
  return only?.reviewItemId && rest.length === 0
    ? { surface: 'task', taskId, reviewItemId: only.reviewItemId }
    : { surface: 'task', taskId };
}
