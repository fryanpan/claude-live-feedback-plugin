/**
 * The board's pure view-model: what a row is, which section it lands in, and
 * how much work a goal has left (plan §3.9). Computed from the
 * ws:<workspaceId> ydoc projection + REST payloads — no DOM, no fetch — so the
 * grouping/filter/ordering rules are unit-testable without a browser.
 *
 * This is the base of the hub's model layer: `hub-review-model.ts` and
 * `hub-presence-model.ts` both import from here, and nothing here imports
 * either of them.
 */
import {
  EFFORT_MIN_CLOSES_FOR_PROJECTION,
  type EffortCalibration,
  type GoalEffortSummary,
  computeEffortCalibration,
  formatEffortDate,
  formatGoalEffortSeconds,
  summarizeGoalEffort,
} from '@feedback/core/goal-effort';
import { blockableStatus, blockerLookup, openBlockerIds } from '@feedback/core/task-blocked';
import {
  type DecisionOption,
  TASK_STATUSES,
  type TaskReadingTime,
  type TaskStatus,
  byBoardOrder,
} from '@feedback/core/task-wire';

/** The status vocabulary is the server's, spelled once in core; re-exported
 *  so the hub's own modules keep their one import. */
export type { TaskStatus };

/**
 * "3m" / "2h" / "5d" — a bare duration, same unit boundaries as `timeAgo`
 * minus the "ago". Exported rather than private because the unplaced-task
 * notice here and the uptime banner in `hub-presence-model.ts` are the two
 * callers, and two spellings of the boundary is how they would drift.
 */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

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
  from: TaskStatus;
  to: TaskStatus;
  by: HubActor;
  note?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

/**
 * What an agent posted about a task — its Stop hook's whole end-of-turn
 * message (`turn`), a status line it chose to post (`status`, the
 * `post_status` verb), or a permission denial reduced to the shape that was
 * refused (`denial`). The server projects the newest `TASK_NOTES_READ_CAP`
 * of them, NEWEST FIRST, with display fields only (the session id stays in
 * the store, like actor ids do on transitions). Denial text is the bare
 * shape — "blocked: " is the surface's prefix, not the store's.
 *
 * Notes are the task's Activity tab, in full; the Home pane shows each one's
 * first line. Comments are for asks, decisions and replies to a person —
 * status never goes there (Bryan, 2026-08-29).
 */
export interface HubNote {
  at: number;
  kind: 'turn' | 'denial' | 'status';
  text: string;
  /** The agent's display name, as its hook environment spelled it. */
  agent: string;
}

/** The same three fields the server stores (`DecisionOption`): an option is
 *  projected verbatim, so the projection's type IS the wire type. */
export type HubDecisionOption = DecisionOption;

export interface HubInfoRequest {
  text: string;
  by: string;
  ts: number;
  /** The thread the question was asked on, when it was asked the review-item
   *  way (the card's link, or a phrase of the body). A question with one is
   *  what makes the decision `waiting` — see `HubTask.decisionState`. */
  threadId?: string;
}

/** One task as projected into the `tasks` Y.Map (§3.3 visitor contract —
 *  display names only, no actor ids). */
export interface HubTask {
  id: string;
  title: string;
  /** Filed with no name yet (the Board's "New task"): `title` holds the
   *  server's placeholder, and this says so — the panel shows it muted and
   *  opens the rename on an EMPTY input. The server clears it the moment a
   *  real title lands through any door. */
  untitled?: boolean;
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
  /** A plan-doc draft: filed from a plan nobody has approved yet, so the row
   *  is visible here and in no dispatch read, and transitions refuse until
   *  the plan is approved on its doc page (which clears this). */
  planHold?: { docId: string };
  /** The source doc changed after this row was filed — the body may be out
   *  of date. Cleared by the next body rewrite. */
  possiblyStale?: { docRevision: number; ts: number };
  quote?: string;
  /** Candidate answers the asker already had in mind. A shortcut, never a
   *  closed set — Bryan can always write his own answer instead. */
  options?: HubDecisionOption[];
  /** "I can't answer this yet, tell me more" — recorded rather than answered,
   *  so the decision stays open and the asker gets the question. */
  infoRequests?: HubInfoRequest[];
  /**
   * Where the ticket's OWN decision stands with the reader, when that is not
   * plainly open: `waiting` — the reader asked on it and the owner has not
   * revised since, so it is OFF the queue (`decisionRows` drops it) — or
   * `revised`, back on the queue and marked. Derived by the SERVER
   * (`projectDecisionState`) from the same row `GET /review-items` reads, so
   * the Home card and that route cannot disagree; absent when open or
   * answered, and on a projection from a server older than the field.
   */
  decisionState?: 'waiting' | 'revised';
  /** On a `revised` decision: when, what the reader had asked, the thread
   *  that asked, and which span of the NEW body changed. */
  decisionRevision?: {
    at: number;
    question?: string;
    threadId?: string;
    range?: { start: number; end: number };
  };
  answer?: { text: string; by: string; ts: number; optionId?: string };
  triagedAgainst?: { goalId: string; ts: number };
  transitions: HubTransition[];
  /** The agent's own one-liners on the row, newest first (see `HubNote`).
   *  Absent when there are none, and on a projection from a server that
   *  predates them — both read as "nothing posted". */
  notes?: HubNote[];
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
  /** Who filed the ticket, as the server resolved it (`taskAskedBy`): the
   *  creator, or for a row older than that field its first mover. Absent
   *  when neither is known. The one source for "Asked by" on a task-borne
   *  decision — see `decisionAskedBy`. */
  createdBy?: string;
  updatedAt: number;
  /**
   * The ticket's review items as the server projects them (`projectReviews`
   * — display names only). The panel's QUEUE still comes from the
   * review-items route, which is where "waiting on the reader" is decided;
   * this array is read for the one thing that route deliberately omits: an
   * item the quality gate is HOLDING, which the ticket shows with its reason
   * so the reader can see a question is coming. Absent when there are none,
   * and on a projection from a server older than the field.
   */
  reviews?: HubReviewItem[];
  /**
   * The scoring model's last read on this ticket (`projectTask`). Three
   * states, and the board draws all three: `{ status: 'ok', … }` carries
   * numbers, `{ status: 'failed', reason }` means an attempt ran and came
   * back with nothing usable, and ABSENT means never scored. Absence is not
   * a zero and a failure is not a number — see `@feedback/core/goal-effort`,
   * which is the only reader that turns these into arithmetic.
   */
  effortEstimate?: {
    status: 'ok' | 'failed';
    handsOnSeconds?: number;
    wallClockSeconds?: number;
    reason?: string;
    model?: string;
    promptVersion?: number;
    estimatedAt?: number;
  };
  /** Folded-up human attention on this ticket's body room. Absent means not
   *  measured — never measured at zero. */
  readingTime?: TaskReadingTime;
}

/** A projected review item, as far as the hub reads it. */
export interface HubReviewItem {
  id: string;
  /** The declaration. `shape`, `options` and `withdrawnAt` are read by the
   *  comment stream's row for the item; an older fixture carrying only the
   *  headline still renders as a question. */
  review: {
    headline: string;
    detail?: string;
    shape?: 'review' | 'decision';
    options?: Array<{ id: string; label: string }>;
    withdrawnAt?: number;
  };
  createdBy?: string;
  /** When it was raised — its place in the task's comment history. */
  createdAt?: number;
  /** Present when it has been answered; the hold is moot then. `by`, `ts`
   *  and `answeredWith` are what the answered record in the stream shows —
   *  who, when, and which option the words came from. */
  answer?: { text: string; by?: string; ts?: number; answeredWith?: string };
  /** The quality gate's verdict on the current words. `held` is the one
   *  that shows on the ticket. */
  judge?: { at: number; verdict: 'ok' | 'held' | 'unavailable' | 'pending'; reason: string };
}

/**
 * Review items the quality gate is holding — on the ticket, off the queue.
 *
 * Two facts retire an item and BOTH have to be read here: an `answer`, and a
 * `withdrawnAt` stamp from its asker taking it back. A withdrawal deliberately
 * leaves the standing verdict in place (core's `withdrawReview` keeps it, so a
 * reinstated item is still held), so a filter on the verdict alone kept a
 * taken-back ask on the ticket card under a Held note with a release button —
 * an item the reader could act on that nobody was asking about any more. Same
 * omission, same cause, as the one core's `isReviewItemHeld` carried; the
 * predicate is spelled again here because the hub reads the PROJECTION, which
 * is a wire shape rather than a `TaskReviewItem`.
 */
export function heldReviewItems(task: HubTask): HubReviewItem[] {
  return (task.reviews ?? []).filter(
    (r) =>
      r.answer === undefined && r.review.withdrawnAt === undefined && r.judge?.verdict === 'held',
  );
}

export interface HubGoal {
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
  /**
   * The docs this goal ties to — the backfill and the settle-time doc scan,
   * projected the same way `HubTask.links` is (`task-projection.ts`). The
   * Related Links section reads this; absent or empty means the goal names
   * no doc.
   */
  links?: unknown[];
  /**
   * When this band was archived — the same three fields a task carries, read
   * through `isGoalArchived`, and hidden by `boardSections` rather than by
   * the projection: the restore list draws from the same board state, so a
   * band the projection dropped could never be put back.
   */
  archivedAt?: number;
  archivedBy?: string;
  archiveReason?: string;
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

/** The band's half of `isTaskArchived`, and the one reader of a goal's
 *  `archivedAt`. Separate from the task's only because the two carry
 *  different types, never different rules. */
export function isGoalArchived(goal: HubGoal): boolean {
  return goal.archivedAt !== undefined;
}

/**
 * "5 tasks" — the blast radius of a band's archive, as words.
 *
 * ONE builder, because the confirmation, the toast that follows it and the
 * Activity line are three statements about the SAME archive, and a reader who
 * is told one number before and a different one after has been told the
 * difference went somewhere. Returns '' when the band held nothing, so a
 * caller can ask "is there anything to name" without counting again.
 */
export function cascadePhrase(tasks: number): string {
  return tasks > 0 ? `${tasks} task${tasks === 1 ? '' : 's'}` : '';
}

/**
 * Archived BANDS, newest removal first — the goals half of the restore list,
 * and what the archived counts are of.
 */
export function archivedGoals(goals: HubGoal[]): HubGoal[] {
  return goals.filter(isGoalArchived).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0));
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
  dueAt?: number;
  /** The band's own status, carried from the goal row (see `HubGoal`).
   *  Absent on Backlog — a bucket, not a goal — and on undecorated bands. */
  status?: TaskStatus;
  doneAt?: number;
  doneBy?: HubActor;
  /** The goal row's owner, carried the same way (see `HubGoal`). */
  assignee?: string;
  ownerKind?: HubOwnerKind;
  /** The goal's description and its discussion, carried the same way again —
   *  see `HubGoal` for what each one is and why the address rides even
   *  when the text does not. Absent on Backlog: a bucket has no body. */
  bodyDocId?: string;
  body?: string;
  bodyTruncated?: boolean;
  commentCount?: number;
  /** The docs this goal ties to, carried the same way again — see `HubGoal`.
   *  Absent or empty means the goal names no doc. */
  links?: unknown[];
  /** The band's soft delete, carried the same way again. Present only on a
   *  section `goalSection` built — `boardSections` never returns one. */
  archivedAt?: number;
  archivedBy?: string;
  archiveReason?: string;
  isChores: boolean;
  tasks: HubTask[];
  /**
   * Which of this band's rows are Blocked, and by what: row id → the ids of
   * the tickets it is still waiting on. A row absent from this map is not
   * blocked. Empty on a section built before the map existed, which reads as
   * "nothing is blocked" rather than throwing.
   *
   * Computed from the UNFILTERED task list, for the reason `boardEffort`
   * gives at length: a blocker the reader's filter happens to hide is still
   * holding the row, and deriving this from `section.tasks` would clear the
   * ring the moment someone switched to the "Mine" tab.
   */
  blockedBy?: Map<string, string[]>;
  /**
   * The band's effort rollup — the header bar, what is left, the finish date.
   *
   * Filled by `boardSectionsWithEffort`, and absent when the caller built its
   * sections without one (the goal detail panel, which wants the grouping and
   * not the bar). Computed from the UNFILTERED task list even though `tasks`
   * above is filtered: see `boardEffort`.
   */
  effort?: GoalEffortSummary;
}

// The status trio and the owner ride from the decorated goal onto its section
// verbatim — conditionally, so an undecorated band's section claims nothing
// rather than carrying a fistful of undefined keys.
function carriedOf(g: HubGoal) {
  return {
    ...(g.status !== undefined ? { status: g.status } : {}),
    ...(g.doneAt !== undefined ? { doneAt: g.doneAt } : {}),
    ...(g.doneBy !== undefined ? { doneBy: g.doneBy } : {}),
    ...(g.assignee !== undefined ? { assignee: g.assignee } : {}),
    ...(g.ownerKind !== undefined ? { ownerKind: g.ownerKind } : {}),
    ...(g.bodyDocId !== undefined ? { bodyDocId: g.bodyDocId } : {}),
    ...(g.body !== undefined ? { body: g.body } : {}),
    ...(g.bodyTruncated !== undefined ? { bodyTruncated: g.bodyTruncated } : {}),
    ...(g.commentCount !== undefined ? { commentCount: g.commentCount } : {}),
    ...(g.links !== undefined && g.links.length > 0 ? { links: g.links } : {}),
    ...(g.archivedAt !== undefined ? { archivedAt: g.archivedAt } : {}),
    ...(g.archivedBy !== undefined ? { archivedBy: g.archivedBy } : {}),
    ...(g.archiveReason !== undefined ? { archiveReason: g.archiveReason } : {}),
  };
}

/**
 * ONE band, by id, archived or not — what the detail panel opens on.
 *
 * `boardSections` deliberately cannot answer this: it leaves archived bands
 * out, which is the whole of what "off the board" means for a goal, and the
 * panel is exactly the surface that has to keep working afterwards. A reader
 * arrives at an archived band from the restore list or from a link somebody
 * sent last week, and the panel is where Restore lives. Same split the task
 * side already has — `taskVisible` hides the row while `state.tasks` keeps
 * it — expressed here as a second lookup because sections are built rather
 * than stored.
 *
 * No tasks on the returned section: the panel shows none, and pretending to
 * carry a band's tasks without applying the board's filters would be a list
 * nobody could explain.
 */
export function goalSection(goals: HubGoal[], goalId: string): BoardSection | null {
  const g = goals.find((goal) => goal.id === goalId);
  if (!g) return null;
  return {
    id: g.id,
    title: g.title,
    dueAt: g.dueAt,
    ...carriedOf(g),
    isChores: false,
    tasks: [],
  };
}

/**
 * Goal order IS priority order (§3.2): sections follow goals[], Backlog
 * always last. A task whose goal id
 * matches no section (transient state while a goal-list edit lands) renders
 * under Backlog — dropping it would be the store-has-it/surface-can't-show-it
 * bug all over again.
 *
 * An ARCHIVED band gets no section, which is what takes it off the board —
 * the goal's analogue of `taskVisible`'s first line, and applied here rather
 * than in the projection so the restore list can still find it. Its tasks
 * went with it and are filtered by `taskVisible` anyway; a straggler
 * (restored by hand, or filed under the band after it was archived) falls
 * through to Backlog by the rule above rather than disappearing.
 */
export function boardSections(goals: HubGoal[], tasks: HubTask[], f: BoardFilters): BoardSection[] {
  const sections: BoardSection[] = [];
  for (const g of goals) {
    if (isGoalArchived(g)) continue;
    sections.push({
      id: g.id,
      title: g.title,
      dueAt: g.dueAt,
      ...carriedOf(g),
      isChores: false,
      tasks: [],
    });
  }
  const chores: BoardSection = {
    id: CHORES_ID,
    title: CHORES_TITLE,
    isChores: true,
    tasks: [],
  };
  sections.push(chores);
  const byId = new Map(sections.map((s) => [s.id, s]));
  for (const task of tasks) {
    if (!taskVisible(task, f)) continue;
    (byId.get(task.goal) ?? chores).tasks.push(task);
  }
  const blocked = boardBlockers(tasks);
  for (const s of sections) {
    s.tasks.sort(byBoardOrder);
    const mine = new Map<string, string[]>();
    for (const t of s.tasks) {
      const on = blocked.get(t.id);
      if (on) mine.set(t.id, on);
    }
    s.blockedBy = mine;
  }
  return sections;
}

/**
 * Which rows are Blocked, and by what.
 *
 * Blocked is derived, never stored — the same derivation the server dispatch
 * reads use, imported from core rather than written twice, because a board
 * that disagreed with `next_tasks` about which rows are waiting would be
 * worse than a board that said nothing. A row is Blocked when its status can
 * be (`todo` or `in-progress` — `blockableStatus` holds that rule) and at
 * least one ticket in its `after` list is neither done nor archived.
 *
 * Ids naming a task this board has never seen are skipped rather than
 * treated as open: a `done` row that has aged out of the reader's done-window
 * is gone from the projection, and reading its absence as "still open" would
 * leave a ring on a row nothing is holding.
 */
export function boardBlockers(tasks: readonly HubTask[]): Map<string, string[]> {
  const lookup = blockerLookup(tasks);
  const out = new Map<string, string[]>();
  for (const task of tasks) {
    if (!blockableStatus(task.status)) continue;
    if (isTaskArchived(task)) continue;
    const open = openBlockerIds(task, lookup);
    if (open.length > 0) out.set(task.id, open);
  }
  return out;
}

/**
 * `boardSections`, with each band's effort rollup attached.
 *
 * One function rather than two calls at the call site, because the two have
 * to be given the SAME unfiltered `tasks` array and it would be quietly
 * wrong to hand the rollup the filtered one. Callers that only want the
 * grouping — the goal detail panel — keep calling `boardSections`.
 */
export function boardSectionsWithEffort(
  goals: HubGoal[],
  tasks: HubTask[],
  f: BoardFilters,
  now: number,
): BoardSection[] {
  const sections = boardSections(goals, tasks, f);
  const effort = boardEffort(goals, tasks, now);
  for (const section of sections) {
    const summary = effort.byGoal.get(section.id);
    if (summary) section.effort = summary;
  }
  return sections;
}

// ── Per-goal effort: the header bar, what is left, and when it lands ───────

/**
 * Every goal's effort rollup for one render, plus the calibration behind it.
 *
 * **Computed from the UNFILTERED task list, deliberately, and this is the
 * whole reason the function exists instead of a loop over `section.tasks`.**
 * `taskVisible` hides done rows older than the reader's done-window and, on
 * the "Mine" tab, every row that is not theirs. A percentage computed off
 * what survives that would be a percentage of the reader's current filter:
 * switching to "Mine" would swing a goal from 80% to 0% without a ticket
 * moving, and narrowing the done-window would march every goal backwards.
 * How far along a goal is does not depend on who is looking at it.
 *
 * Archived rows are the one exclusion, and it is applied inside the rollup
 * (`countsTowardEffort`) rather than here, because it is a fact about the
 * ticket rather than about the viewer.
 */
export interface BoardEffort {
  calibration: EffortCalibration;
  /** Keyed by goal id, including `chores` — the caller decides whether to
   *  draw it, and the Backlog bucket deliberately gets no bar. */
  byGoal: Map<string, GoalEffortSummary>;
}

/**
 * Roll every goal's tickets up, once per render.
 *
 * Calibration is learned board-wide first and then per goal, so the two
 * passes share one sample set: a goal with two closed tickets is pulled
 * most of the way back to the board's own experience instead of claiming a
 * factor of its own.
 */
/** Every id a band can have on this board. */
export function goalBandIds(goals: HubGoal[]): Set<string> {
  return new Set(goals.map((g) => g.id));
}

/**
 * The band a goal id lands in — itself, or Backlog when no band answers to
 * it.
 *
 * Exported because the calibration is keyed by BAND and two callers need the
 * same key: the board, which groups rows into bands, and the ticket panel,
 * which looks one row's correction up. A panel that keyed on a stale goal id
 * would quote a factor the board never computed.
 */
export function bandOfGoal(known: Set<string>, goal: string): string {
  return known.has(goal) ? goal : CHORES_ID;
}

/**
 * The board-wide correction alone, without rolling every band up.
 *
 * The ticket panel needs the factor and not the summaries, and it recomputes
 * on every repaint of the panel — so it gets the cheap half. Built through
 * the SAME band mapping `boardEffort` uses, which is the whole point of it
 * living here rather than being a bare `computeEffortCalibration` call at the
 * call site.
 */
export function boardCalibration(goals: HubGoal[], tasks: HubTask[]): EffortCalibration {
  const known = goalBandIds(goals);
  return computeEffortCalibration(
    tasks.map((task) => ({ ...task, goal: bandOfGoal(known, task.goal) })),
  );
}

export function boardEffort(goals: HubGoal[], tasks: HubTask[], now: number): BoardEffort {
  const known = goalBandIds(goals);
  // A task whose goal id matches no band renders under Backlog, so it must
  // count there too — the same fallback `boardSections` applies, spelled the
  // same way, so a row cannot be in one band on screen and another in the
  // arithmetic.
  const bandOf = (task: HubTask): string => bandOfGoal(known, task.goal);
  const grouped = new Map<string, HubTask[]>();
  for (const id of known) grouped.set(id, []);
  grouped.set(CHORES_ID, grouped.get(CHORES_ID) ?? []);
  for (const task of tasks) {
    const band = bandOf(task);
    const list = grouped.get(band);
    if (list) list.push(task);
    else grouped.set(band, [task]);
  }
  const calibration = computeEffortCalibration(
    tasks.map((task) => ({ ...task, goal: bandOf(task) })),
  );
  const byGoal = new Map<string, GoalEffortSummary>();
  for (const [id, list] of grouped) {
    byGoal.set(id, summarizeGoalEffort(list, id, calibration, now));
  }
  return { calibration, byGoal };
}

/** What a goal header actually prints. Empty strings mean "say nothing
 *  here", never "say zero". */
export interface GoalEffortLabel {
  /** `62%`, or `''` when there is no percentage to claim. */
  percentText: string;
  /** Bar fill, 0–100. */
  percentFill: number;
  /** `2h 40m hands-on left`, or the not-scored sentence. */
  leftText: string;
  /** The same figure with no words at all, for the narrow tier — where the
   *  goal TITLE is the primary task and everything else spends its width
   *  (Bryan, 2026-08-30: *"Primary task is still to read the title so don't
   *  block that on mobile"*). Measured at 430px against a 103-character goal
   *  title: the labelled string left the title 152px of a 354px row, and
   *  this one leaves it 207px. The label is a real loss and it is the one
   *  his ordering says to take. */
  leftTextShort: string;
  /** `~Sep 12`, or `''` below the projection floor. */
  finishText: string;
  /** `4 not scored` / `4 not scored, 1 failed`, or `''` at full coverage. */
  coverageText: string;
  /** `estimate only` when the date rests on a factor no closed ticket has
   *  corrected, `''` otherwise — and `''` whenever there is no date, since a
   *  caveat about a projection nobody can see is noise. It rides the DATE's
   *  own column, never the title's: the title is the primary task at every
   *  width, and a caveat that pushes it is in the wrong place. */
  uncalibratedText: string;
  /** The long version, for the element's `title`. */
  title: string;
  /** Whether there is anything at all to draw. */
  show: boolean;
  /** Whether to draw the bar itself. An unscored goal gets the sentence and
   *  no bar: a grey empty track is how this board draws 0% done, and a goal
   *  nobody has scored is not a goal at zero. */
  showBar: boolean;
}

/** Below this the window is named in hours. Two days, not one: rounding to
 *  whole days misstates the denominator by `0.5 / n`, which is a third of it
 *  at 1.5 days and a fifth at 2.5 — so the hour wording has to reach past the
 *  first day to keep the error bounded where days are still few. Above this
 *  the error is under a quarter and shrinking, and "days" is how a reader
 *  says a span that long. */
const PACE_WINDOW_HOURS_BELOW_DAYS = 2;

/**
 * The pace window as a reader says it: "4 hours", "36 hours", "3 days".
 *
 * Two units, because the window spans two orders of magnitude — it floors at
 * one hour and caps at fourteen days — and this sentence is the reader's only
 * check that the date came from the stretch they think it did. Naming a
 * four-hour window "1 day" is not a rounding error there, it is a different
 * claim about how the number was made, and the same is true of a 35-hour one.
 *
 * Never below one of whatever unit it lands in: the window itself is clamped
 * to at least an hour, so "0 hours" would describe a span the arithmetic
 * cannot produce.
 */
function formatPaceWindow(days: number): string {
  if (!Number.isFinite(days) || days <= 0) return '1 hour';
  if (days < PACE_WINDOW_HOURS_BELOW_DAYS) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours} hour${hours === 1 ? '' : 's'}`;
  }
  const whole = Math.max(1, Math.round(days));
  return `${whole} day${whole === 1 ? '' : 's'}`;
}

/**
 * Turn one goal's rollup into the words the header prints.
 *
 * The board never says "hands on" or "wall clock" — Bryan struck both from
 * every board surface, the goal header included ("No need to show hands on
 * or wall clock hours in the board", 2026-08-30). What is left is a bar, a
 * figure with the word "left" after it, and a date. The full sentence,
 * including which quantity is which, lives in the `title` and on the ticket.
 */
export function goalEffortLabel(
  summary: GoalEffortSummary,
  now: number,
  locale?: string,
): GoalEffortLabel {
  const none = (leftText: string, title: string, show: boolean): GoalEffortLabel => ({
    percentText: '',
    percentFill: 0,
    leftText,
    leftTextShort: leftText,
    finishText: '',
    coverageText: '',
    uncalibratedText: '',
    title,
    show,
    showBar: false,
  });
  if (summary.kind === 'unestimated') {
    // An empty band has nothing to report and says nothing. A band with
    // tickets that carry no estimate says so out loud — that is the visible
    // half of the positive control: a scorer that produces nothing must be
    // legible as producing nothing, not as a goal that has not started.
    if (summary.reason === 'no-tasks') return none('', '', false);
    const failed = summary.failedCount;
    // The two silences are different events and must not read as synonyms.
    // They previously rendered "no estimate yet" and "not estimated", which
    // a reader cannot tell apart — and telling them apart is the acceptance
    // criterion this whole feature was built on. "Scoring failed" names an
    // attempt that happened; "not scored yet" names one that never ran.
    return none(
      failed > 0 ? `scoring failed on ${failed}` : 'not scored yet',
      failed > 0
        ? `Scoring ran on ${failed} of these tickets and produced nothing usable; the rest were never scored.`
        : 'None of these tickets has been scored yet.',
      true,
    );
  }
  const left = formatGoalEffortSeconds(summary.handsOnRemainingSeconds);
  const coverageText =
    summary.unestimatedCount === 0
      ? ''
      : summary.failedCount > 0
        ? `${summary.unestimatedCount} not scored, ${summary.failedCount} failed`
        : `${summary.unestimatedCount} not scored`;
  const date = (at: number): string => formatEffortDate(at, now, locale);
  // The pace window is the GOAL's, not a constant, so the sentence has to
  // read it off the summary: a three-day-old goal saying "the last 14 days'
  // pace" would be quoting a denominator its own arithmetic never used.
  //
  // And it has to be able to say HOURS. The window floors at one hour, not
  // one day, so a goal that closed most of itself in an afternoon carries a
  // window of 0.4 days — which the old whole-day rounding printed as "the
  // last 1 day's pace", quoting a denominator two and a half times the one
  // the date came from. Under a day the sentence counts hours.
  const paceDays = formatPaceWindow(summary.paceWindowDays);
  const paceWindow = `${paceDays}${paceDays.endsWith('s') ? "'" : "'s"}`;
  // The two visible numbers are in different currencies: the bar is CALENDAR
  // time and the figure beside it is Bryan's own attention. Read together
  // unlabelled they invite one reading — "67% done, 40 minutes to go" — and
  // that reading is wrong, because the calendar remainder on the same goal
  // was 2h. The sentence that disambiguated them lived only in the `title`,
  // and the device this board is mostly read from has no hover. So the
  // remainder now names whose time it is, on screen.
  const leftText = summary.complete ? 'done' : `${left} hands-on left`;
  const leftTextShort = summary.complete ? 'done' : left;
  // Why there is no date is as much of an answer as a date, and it was also
  // hover-only. Three different absences, three different sentences.
  // A range whose two ends land on the same day is not a range. Short
  // projections made that the common case rather than a curiosity — a goal
  // finishing this afternoon has its central date and its late end inside
  // one day — and "~Aug 31–Aug 31" spends the narrow tier's scarcest
  // resource saying a single day twice.
  const finishDay =
    summary.projectedFinishAt !== undefined ? date(summary.projectedFinishAt) : undefined;
  const latestDay =
    summary.projectedLatestAt !== undefined ? date(summary.projectedLatestAt) : undefined;
  const spansTwoDays = latestDay !== undefined && latestDay !== finishDay;
  const finishText = summary.complete
    ? ''
    : finishDay !== undefined
      ? spansTwoDays
        ? `~${finishDay}\u2013${latestDay}`
        : `~${finishDay}`
      : summary.projectionOverHorizonDays !== undefined
        ? 'over a year out'
        : `date after ${EFFORT_MIN_CLOSES_FOR_PROJECTION} closes`;
  const titleParts = [
    summary.complete
      ? 'Every scored ticket in this goal is closed.'
      : `${summary.percentComplete}% of this goal's estimated calendar time is done.`,
  ];
  if (!summary.complete) {
    titleParts.push(
      `About ${left} of your own attention left across ${summary.estimatedCount} scored ticket${
        summary.estimatedCount === 1 ? '' : 's'
      }.`,
    );
  }
  if (coverageText) titleParts.push(`${coverageText} — the bar covers only the scored ones.`);
  if (summary.complete) {
    // No pace sentence on a finished goal: there is nothing left for a pace
    // to be applied to.
  } else if (finishDay !== undefined) {
    titleParts.push(
      spansTwoDays
        ? `On the last ${paceWindow} pace, finishing around ${finishDay}, likely by ${latestDay}.`
        : `On the last ${paceWindow} pace, finishing around ${finishDay}.`,
    );
  } else if (summary.projectionOverHorizonDays !== undefined) {
    titleParts.push(
      `On the last ${paceWindow} pace this goal is about ${Math.round(summary.projectionOverHorizonDays)} days out — too far for a date to mean anything. Either the remaining tickets are much larger than what has closed, or too little has closed to set a pace.`,
    );
  } else {
    titleParts.push(
      // "worked on and closed", not "closed": a row swept straight to done
      // no longer counts toward the floor, so a reader looking at four
      // closed tickets and a sentence asking for three would otherwise think
      // the board could not count.
      `No finish date yet — that needs ${EFFORT_MIN_CLOSES_FOR_PROJECTION} tickets worked on and closed in the last ${paceDays}, and ${summary.closesInWindow} ${summary.closesInWindow === 1 ? 'has' : 'have'}.`,
    );
  }
  if (summary.wallClockRatio.samples > 0) {
    titleParts.push(
      `Estimates on this goal are scaled \u00d7${summary.wallClockRatio.ratio.toFixed(2)} from ${summary.wallClockRatio.samples} closed ticket${summary.wallClockRatio.samples === 1 ? '' : 's'} on this goal.`,
    );
  } else if (summary.wallClockRatio.calibrated) {
    // Scaled by a MEASURED factor this goal did not teach. The sentence used
    // to be the one above, printing the board's count after the words "on
    // this goal" \u2014 forty closes attributed to a goal that had none.
    titleParts.push(
      `Estimates on this goal are scaled \u00d7${summary.wallClockRatio.ratio.toFixed(2)}, learned from closed tickets elsewhere on the board.`,
    );
  }
  // The marker, and the sentence behind it. It is about the FACTOR, not the
  // pace: a date can rest on three observed closes and still be scaled by a
  // number no close has corrected, and that is the state worth naming.
  //
  // Only where there IS a date. A goal already saying "date after 3 closes"
  // does not also need telling that the estimate behind the date it has not
  // got is uncorrected.
  const hasDate =
    summary.projectedFinishAt !== undefined || summary.projectionOverHorizonDays !== undefined;
  //
  // One sentence, not two. On this surface the marker is only ever reachable
  // with NO usable samples behind the factor: a date needs
  // EFFORT_MIN_CLOSES_FOR_PROJECTION observed closes, and an observed close
  // scored under the current ask is exactly what the calibrator counts \u2014 so
  // three of them would have calibrated it. What is left is a goal whose
  // closes were scored under an OLDER ask, which is the shape a board wears
  // after a prompt bump. The one-or-two-closes wording belongs on the ticket
  // panel, where it is reachable, and lives there.
  const uncalibratedText = hasDate && !summary.wallClockRatio.calibrated ? 'estimate only' : '';
  if (uncalibratedText) {
    titleParts.push(
      `Estimate only \u2014 no closed ticket has corrected the scorer on this goal yet, so this date is the raw estimate at the board's starting assumption.`,
    );
  }
  return {
    percentText: `${summary.percentComplete}%`,
    percentFill: Math.min(100, Math.max(0, summary.percentComplete)),
    leftText,
    leftTextShort,
    finishText,
    coverageText,
    uncalibratedText,
    title: titleParts.join(' '),
    show: true,
    showBar: true,
  };
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
export const TASK_STATUS_ORDER: readonly TaskStatus[] = TASK_STATUSES;

/**
 * The statuses a GOAL may be declared to hold — every one a task may.
 *
 * This list used to leave `triage` out, on the reasoning that the store never
 * minted a goal row there. It does now: a goal somebody adds is a proposal and
 * starts in triage (Bryan, 2026-08-25), and a band in triage is "not ready to
 * work on" — nothing under it reaches a dispatch read, and the stall loop
 * does not judge its rows. The picker offers the state both ways, so a goal
 * that turns out not to be agreed can be put back as well as released.
 *
 * Kept as its own export rather than aliased, because the two pickers are
 * still two decisions and the test pins that they currently agree.
 */
export const GOAL_STATUS_ORDER: readonly TaskStatus[] = ['triage', 'todo', 'in-progress', 'done'];

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
