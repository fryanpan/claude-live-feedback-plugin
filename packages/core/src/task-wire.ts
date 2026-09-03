/**
 * The task wire contract — the shapes a board row has on disk (the per-
 * workspace sidecar), over REST, and in the MCP tool schemas — spelled once
 * so the server, the browser and the MCP bundle cannot drift apart.
 *
 * Everything here is data: types, the status vocabulary, and the one sort
 * the board is ordered by. Behaviour (the store, the projection, the routes)
 * stays with whichever side owns it. The browser's `HubTask` (hub-board-model.ts)
 * is deliberately NOT this type: it is the §3.3 visitor projection —
 * display names only, no actor ids — and reads the pieces it shares from
 * here rather than restating them.
 */
import type {
  ReviewItemJudgement,
  ReviewItemRange,
  ReviewItemRevision,
  TaskReviewItem,
} from './review-item.ts';

/** What a caller DECLARED the assignee to be. Two values on purpose: the
 *  third state the board can show (`unknown`) is something the server
 *  resolves, never something a caller states. */
export type DeclaredOwnerKind = 'person' | 'agent';

export type Ref =
  | { kind: 'doc'; docId: string }
  | { kind: 'thread'; docId: string; threadId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'diff'; workspaceId: string }
  | { kind: 'url'; url: string };

/** Every kind `isValidRef` accepts, for error messages. A caller who sends a
 *  bad ref should learn the vocabulary from the response, not from reading
 *  this file — which is what the first outside user of these routes had to
 *  do. Derived from nothing: keep it in step with the union above. */
export const REF_KINDS = ['doc', 'thread', 'task', 'diff', 'url'] as const;

/**
 * What the done-artifact check concluded about one link (artifact-check.ts).
 *
 * Four verdicts, and the split matters: `missing` is positive evidence the
 * promised artifact is not there (a 404 on the PR, no doc with that id) and
 * is the only one that makes noise; `unverified` is absence of evidence (rate
 * limit, network failure, timeout) and stays quiet, because an advisory check
 * that cried on every flaky lookup would train everyone to ignore it.
 * `not-checkable` records that a link was seen and is not a kind this check
 * knows how to verify — recorded rather than skipped, so a reader of the
 * result can tell "unchecked" from "unnoticed".
 */
export type ArtifactVerdict = 'verified' | 'missing' | 'unverified' | 'not-checkable';

export interface ArtifactLinkCheck {
  ref: Ref;
  verdict: ArtifactVerdict;
  /** The human-readable half: a verified PR's state (open/closed/merged),
   *  or why a verdict degraded ("GitHub answered 403"). */
  detail?: string;
}

/** The whole check as recorded on the task — one row per link, stamped when
 *  the check ran (which is after the done transition committed, not at it). */
export interface ArtifactCheck {
  ts: number;
  links: ArtifactLinkCheck[];
}

/**
 * One scoring run's fields common to both outcomes — what generation of
 * scoring made this, and against which words. `model` and `promptVersion`
 * are what lets a stored run be told from one made under an older scorer or
 * an older prompt frame; `forTitleWrittenAt`/`forBodyWrittenAt`/`forGoal` are
 * the `task.titleWrittenAt`/`task.bodyWrittenAt`/`task.goal` this run read at
 * the moment it asked — the provenance a reader compares against the task's
 * CURRENT values to tell a fresh estimate from a stale one, and the guard
 * `TaskStore.recordEffortEstimate` uses so a slow call that lands after a
 * newer edit (or a re-triage to a different goal, which changes the goal
 * title the scorer weighed) already re-scored the ticket cannot overwrite
 * the newer answer with a stale one.
 */
interface TaskEffortEstimateProvenance {
  model: string;
  promptVersion: number;
  estimatedAt: number;
  forTitleWrittenAt: number;
  forBodyWrittenAt?: number;
  forGoal: string;
  /**
   * `Task.wordsRevision` as this run read it — THE token
   * `TaskStore.recordEffortEstimate` compares, and the only one it compares.
   *
   * The three fields above are wall-clock milliseconds, and a millisecond is
   * coarser than the events they were being asked to separate. A create and
   * a rename that land inside the same tick stamp the SAME `titleWrittenAt`,
   * so the create run's captured token still matched the renamed row, the
   * guard read "not stale", and the create's late answer overwrote the
   * rename's own. Not a test artifact — two quick edits on the board do it —
   * but that is where it was caught: CI, 2026-08-30, a 999/999 create answer
   * landing on a row that had already accepted the rename's 111/222.
   *
   * A counter that only ever goes up cannot tie, however fast two edits are.
   * The timestamps stay because they answer a different question — "which
   * words was this scored against", asked by a reader in human time, where a
   * clock is the readable answer and a counter is not.
   */
  forWordsRevision: number;
}

/** A produced guess at how long a ticket will take, in seconds — never a
 *  promise, only what the scorer made of the words as they stood when this
 *  ran. See `Task.effortEstimate` for what absence means and why a
 *  `failed` run (below) is a distinct, visible state from either. */
export interface TaskEffortEstimateOk extends TaskEffortEstimateProvenance {
  status: 'ok';
  /** The owner's own attention: reading, reviewing, deciding, testing. */
  handsOnSeconds: number;
  /** Filed-to-done calendar time. */
  wallClockSeconds: number;
}

/** A scoring run that could not produce an estimate — a bad or unparseable
 *  reply, a timeout, a down endpoint. Stored so the row can say "no
 *  estimate, here's why" rather than reading identically to a ticket that
 *  was simply never scored (`Task.effortEstimate` absent altogether). */
export interface TaskEffortEstimateFailed extends TaskEffortEstimateProvenance {
  status: 'failed';
  /** Shown on the row. */
  reason: string;
}

export type TaskEffortEstimate = TaskEffortEstimateOk | TaskEffortEstimateFailed;

/** Cumulative reading-tracker attention on one task's body room. See
 *  `Task.readingTime` for what counts and why absence isn't zero. */
export interface TaskReadingTime {
  /** Sum of every folded-in `read_session`'s clamped durationMs, in
   *  seconds, across every visit and every reader — not per-person. */
  totalSeconds: number;
  /** How many `read_session` events have been folded in. NOT unique
   *  visitors or unique visits: a tab that idles out mid-read and is
   *  resumed later is two sessions, same as two different readers. */
  sessionCount: number;
  /** Wall-clock time (ms epoch) of the most recently folded-in session. */
  lastSessionAt: number;
}

/**
 * Every status a row may hold, in the order the board's pickers list them.
 * `TaskStatus` is derived from this tuple rather than restated beside it, so
 * the type, the server's transition gate, the browser's picker and the MCP
 * tool schemas are one list, not four that have to be kept in step.
 */
export const TASK_STATUSES = ['triage', 'todo', 'in-progress', 'done'] as const;

/**
 * The four statuses as a type — derived from the tuple above, so the two
 * can never disagree.
 *
 * `triage` is ordered first because it is what a row is BEFORE `todo`: an
 * agent filed it and nobody has vetted it yet. It is a status rather than a
 * bucket deliberately — the row keeps its goal, its order and its band
 * position, so a lead reads it where the work is instead of in a holding pen
 * that has to be remembered separately. What it changes is one thing: no
 * dispatch read returns it (`buildQueue`), so nothing picks it up until a
 * person or an agent moves it out through the ordinary gate.
 */
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Is `value` one of the four statuses? The server's transition gate. */
export function isTaskStatus(value: string): value is TaskStatus {
  return (TASK_STATUSES as readonly string[]).includes(value);
}

export interface TaskActor {
  id: string;
  name: string;
  kind: 'person' | 'agent';
}

/**
 * Proof a transition once carried. NOTHING WRITES OR READS THIS ANY MORE —
 * evidence support was removed 2026-08-25 — and the type stays for the same
 * reason `confirmed` below does: sidecars already on disk hold these objects,
 * the persist path rewrites the whole file from memory, and a field the type
 * has forgotten is a field the next save DESTROYS rather than merely hides.
 * The record is kept; only the product surface went away.
 */
export interface TaskEvidence {
  commit?: string;
  threadRef?: Ref;
}

/** A correction appended to a transition after the fact. Retired alongside
 *  `TaskEvidence`, and kept on the type for the same reason. */
export interface TaskEvidenceAmendment {
  ts: number;
  by: TaskActor;
  evidence: TaskEvidence;
  note?: string;
  supersedes?: TaskEvidence;
}

/**
 * What an agent's session posted about this row — the end-of-turn message
 * (`turn`), the shape of a tool call auto mode refused (`denial`), or a
 * status the agent chose to report (`status`). The first two come from the
 * plugin's Stop / PermissionDenied hooks through `POST /api/agent-notes`,
 * pinned to whichever row was the agent's current claim when they arrived;
 * a `status` names its row (`POST /api/tasks/:id/notes`, the MCP verb's
 * route). Never written by a person. Stored VERBATIM: the poster is what
 * keeps paths and tokens out of the text; the server does not filter.
 *
 * Notes are the row's Activity tab, not its comment thread: a comment is an
 * ask, a decision, or a reply to a person; a note is the agent's own record
 * of what it did. The newest note of any kind is movement to the stall
 * clock (keep-moving.ts) — and only there: `task.noted` stays off the
 * workspace event stream and out of the board-wide trail.
 */
export interface TaskNote {
  /** When the session reported it — the poster's clock, not the server's. */
  ts: number;
  kind: 'turn' | 'denial' | 'status';
  text: string;
  /** The agent's display name, as the hook's environment spelled it. */
  agent: string;
  /** The Claude Code session that posted it. Kept for the pane; never
   *  projected into the board room. */
  sessionId?: string;
}

/** How many notes a row keeps on disk. The read is capped separately
 *  (`TASK_NOTES_READ_CAP` in agent-notes.ts); this bounds the sidecar, which
 *  is rewritten whole on every save — a row worked for a week at a note per
 *  turn would otherwise grow without limit. Notes are session telemetry,
 *  not user content, so the oldest fall off rather than being archived. */
export const TASK_NOTES_STORE_CAP = 200;

export interface TaskTransition {
  ts: number;
  from: TaskStatus;
  to: TaskStatus;
  by: TaskActor;
  note?: string;
  /** No longer written or read (see `TaskEvidence`); persisted rows carry it. */
  evidence?: TaskEvidence;
  /** No longer written or read (see `TaskEvidence`); persisted rows carry it. */
  amendments?: TaskEvidenceAmendment[];
  /** Agent-reported cost at done. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Was the human's live confirmation on a yellow-tier agent move (§3.4).
   *  No longer WRITTEN — the risk gate was removed 2026-08-18 — but kept on
   *  the type because transitions already persisted carry it. */
  confirmed?: boolean;
}

/**
 * One candidate answer on a decision.
 *
 * The point is not to close the set — it is that a question usually ARRIVES
 * with candidates, the way an AskUserQuestion prompt does, and before this
 * there was nowhere to put them. So the person deciding had to compose prose
 * to say "the second one". `detail` is what that choice costs, which is the
 * half that makes a list of labels decidable.
 */

export interface DecisionOption {
  /** `o-<crypto-random>`, minted here — a caller-supplied label is not a
   *  stable identity, and `answer.optionId` has to survive a relabel. */
  id: string;
  /** The words recorded VERBATIM as the answer if this one is picked. */
  label: string;
  /** What picking it costs or implies. */
  detail?: string;
}

/** A question asked back at a decision instead of answering it. */
export interface InfoRequest {
  text: string;
  /** Display name (§3.3 visitor contract — no actor ids in projected state). */
  by: string;
  ts: number;
  /**
   * The thread the question was asked ON, when it was asked the way a
   * question on a review item is — the card's "I have a question", or a
   * phrase of the body selected and commented on. The same two fields
   * `ReviewInfoRequest` carries, for the same reason: `legacyReviewItem`
   * copies these onto the derived `r-legacy` row, and `reviewItemState`
   * reads a THREADED question as "waiting on the owner". A question typed
   * into the old "tell me more" box (the `/more-info` routes, the
   * `request_more_info` tool) carries neither and leaves the decision on
   * the queue — that is the agent-side ask, and it is meant to.
   */
  threadId?: string;
  range?: ReviewItemRange;
}

/**
 * A review item as the SIDECAR holds it: the projected row plus what the
 * store keeps to itself.
 *
 * `filedBy` is the filer as an actor — id included — because the quality
 * gate's wake has to be ADDRESSED (`sendToAgent` keys on the agent id) and
 * `createdBy` is a display name by the §3.3 visitor contract. It stays out
 * of every projection the way transition actor ids do: `readTaskReviewItem`
 * never reads it, so the board room never carries it.
 */
export interface StoredReviewItem extends TaskReviewItem {
  filedBy?: TaskActor;
}

export interface Task {
  /** `t-<crypto-random>`. */
  id: string;
  workspaceId: string;
  /**
   * Which kind of board row this is. OPTIONAL, and absent reads as `'task'` —
   * every task ever persisted predates the field, so requiring it would mean
   * rewriting every sidecar at the deploy to record something already true of
   * all of them.
   *
   * Ask it through `isGoalRow`, never with a bare comparison: the failure mode
   * of a discriminator whose absence is meaningful is a reader that treats an
   * unset kind as the interesting case, and every task reader on this board
   * must keep seeing exactly what it saw before.
   */
  kind?: 'task' | 'goal';
  title: string;
  /**
   * The row was filed with NO title — the Board's "New task" button, which
   * opens the detail panel for the person to type into — and carries
   * `UNTITLED_TASK_TITLE` as a placeholder so every reader that expects a
   * non-empty title keeps working. The hub draws a flagged row as empty.
   *
   * Cleared by `applyTitle` the moment the row is named, and nowhere else:
   * the flag means "nobody has said what this is yet", and only a title
   * write can change that. Absent means the title is real.
   */
  untitled?: boolean;
  /** Markdown snapshot of the description. The live CRDT body room
   *  (`task:<taskId>`) arrives with the projection commit; this snapshot is
   *  for search/export and never re-seeds a live fragment (§3.3). */
  body?: string;
  /** 'human' for work only a person can do, otherwise a named identity —
   *  the agent or person who owns it. Every route that creates a task
   *  resolves this from the caller and REFUSES the generic word (see
   *  task-owner.ts), so a stored 'agent' is a pre-enforcement row — or a
   *  row deliberately filed with NO owner: `assignToLead` on a board with
   *  no lead, held at triage until somebody is named. */
  assignee: string;
  /**
   * The roster's ONE id for `assignee`, when the roster can place it — an
   * agent row matched by id, display name, or a spelling folded into it by
   * a merge. Stored beside the name at every write, never instead of it:
   * `assignee` stays verbatim because old bundles keep sending it and the
   * board keeps drawing it. Absent when nobody the roster knows owns the
   * row, and absent on every row written before the field existed — those
   * resolve the same way at read time (`ownerIdOf`), so history is never
   * rewritten to catch up.
   */
  assigneeId?: string;
  /**
   * What KIND of somebody the assignee is, as DECLARED — never as guessed
   * from the name. Absent means nobody has said, which reads as `unknown`
   * (see `resolveOwnerKind`), not as a person. Cleared on a hand-over that
   * declares nothing, because inheriting the previous owner's kind would
   * label the new one by accident.
   */
  assigneeKind?: DeclaredOwnerKind;
  /** Only meaningful when the assignee is a human. */
  needs?: 'action' | 'decision';
  /**
   * Candidate answers on a decision — a SHORTCUT, never a closed set. Picking
   * one records its label as the verbatim answer (plus `answer.optionId`), and
   * free text and `requestMoreInfo` stay first-class next to it. Only ever
   * present when `needs === 'decision'`.
   */
  options?: DecisionOption[];
  /** "Tell me more" — questions asked back at the decision, in order. These
   *  deliberately do NOT answer it: the task stays open and stays counted. */
  infoRequests?: InfoRequest[];
  /**
   * The review items hanging on this ticket — 0..n, several possibly open at
   * once. THE cardinality change (Bryan, 2026-08-18: *"a decision is a part of
   * a ticket… at any point in time there might be multiple open decisions for
   * a ticket"*): the three fields directly above spell ONE decision that the
   * ticket IS, so its title had to double as the question and a second open
   * question had nowhere to go.
   *
   * Those three fields are NOT replaced and NOT migrated. They keep being read
   * and written exactly as before, and `listReviewItems` DERIVES a row from
   * them at read time when this array is empty — read-side only, idempotent by
   * construction, nothing rewritten on disk. Soft by default: a legacy
   * decision cannot be damaged by a migration that ran twice or half-way,
   * because no migration runs at all.
   *
   * Persisted with the rest of the task — the sidecar serializes the whole
   * row, so this needs no writer of its own.
   */
  reviews?: StoredReviewItem[];
  /** Goal id; `chores` is the catch-all. */
  goal: string;
  /** Fractional sort key — always room to insert between two tasks. */
  order: number;
  status: TaskStatus;
  /** Task ids this depends on — "don't start yet" is a dependency, not a
   *  status (§3.3, no held status). */
  after: string[];
  /** Subset of `after` whose edges hard-block transitions (opt-in per edge —
   *  a blanket refusal rule would block legitimate work). */
  afterEnforce?: string[];
  dueAt?: number;
  /**
   * When this row was archived — the board's ONLY removal, and a soft one.
   *
   * The project rule is that user content is never hard-deleted, and until
   * this field a task had no reversible removal at all: a row nobody was ever
   * going to do either sat on the board forever or was destroyed outright.
   * Archiving is the third answer, and it is deliberately the CHEAPEST one
   * available — three fields on the row. Nothing moves on disk, the id still
   * resolves, the task's body room and every comment thread hanging off it
   * keep working, and `after` edges pointing at it keep pointing at it. So a
   * restore is a field clear rather than a restore-from-anywhere, and there
   * is no window in which the record is half-moved.
   *
   * DELIBERATELY NOT A STATUS, for the same reason a park is not one: `done`
   * means the work happened, and a row archived as a duplicate did not
   * happen. Folding it into the status enum would have made the board's own
   * completion count lie in the flattering direction.
   *
   * Absent means not archived — `isArchived` is the one reader, so no surface
   * asks the question twice with two defaults.
   */
  archivedAt?: number;
  /** Who archived it, as a display name — the same register as a transition's
   *  `by`, and what the restore list shows beside the row. */
  archivedBy?: string;
  /** Why, in the archiver's words. The half a reader acts on: "archived" says
   *  a decision was made and not what it was. Cleared by a restore, since a
   *  reason about a removal that has been undone is a claim nobody makes. */
  archiveReason?: string;
  /**
   * The GOAL whose archive took this row with it — present iff this archive
   * was a cascade rather than somebody's decision about this task.
   *
   * It exists so that restoring the goal restores exactly the rows its
   * archive removed. Without it a restore would have to guess from
   * `task.goal`, and it would guess wrong in the one case that matters: a row
   * somebody archived on its own weeks earlier, which the goal's archive
   * never touched and which its restore must therefore not resurrect. Cleared
   * by `unarchiveTask`, alongside the other three, so a row restored by hand
   * stops belonging to the cascade.
   */
  archivedWithGoal?: string;
  links: Ref[];
  /**
   * What the done-artifact check found in this row's `links` the last time it
   * moved to done. Advisory bookkeeping, written AFTER the transition
   * committed (`recordArtifactCheck`) — its absence on a done row means the
   * row had no links or predates the check, never that the transition failed.
   */
  artifactCheck?: ArtifactCheck;
  /**
   * Cumulative HUMAN attention on this task's body room (`task:<id>`) —
   * the sum of interaction-bounded `read_session` durations the reading
   * tracker reports (idle time and agent traffic already excluded before
   * this ever sees them; see `packages/workspaces-app/src/reading-tracker.ts`
   * and `recordReadingTime` below). Seconds, not milliseconds — Bryan's
   * call (2026-08-30): this is a number a person looks at, not a wire
   * format that benefits from sub-second precision.
   *
   * Absent means "not measured yet", never "measured at zero" — a task
   * with nobody's read_session recorded against it (filed before the
   * tracker existed, or never opened) must not read the same as a task
   * someone opened and left instantly. No reader may default this to `0`.
   */
  readingTime?: TaskReadingTime;
  /**
   * The scoring model's last read on this ticket's effort — hands-on and
   * wall-clock, in seconds — or a recorded failure to produce one (chunk 2
   * of the effort model). Absent means "never
   * scored": no estimator wired, scoring switched off, or a row that
   * predates this field. DISTINCT from a `failed` run, which means an
   * attempt ran and came back with nothing usable. No reader may treat
   * absence as zero or a failure as a number.
   */
  effortEstimate?: TaskEffortEstimate;
  /** The thread/doc this was promoted from. */
  origin?: Ref;
  /**
   * This row is a DRAFT derived from a plan doc that has not been approved:
   * it exists and is visible, but the transition gate refuses to move it out
   * of triage until `POST /api/docs/:id/plan` approves the plan — which
   * clears the hold and releases the row to `todo`. Held rows are already
   * invisible to every dispatch read by their `triage` status; this field is
   * what makes the hold un-liftable by an ordinary transition. The docId is
   * the plan doc AS THE CREATE ROUTE SAW IT (canonical id), which is what
   * the release matches on.
   */
  planHold?: { docId: string };
  /**
   * The source doc's `contentRevision` at the moment this row was derived
   * from it (or last reconciled with it — a body edit re-stamps). The
   * ordering token `flagStaleFromDocEdit` compares, mirroring
   * `wordsRevision`'s counter-not-clock rule. Absent on rows that predate
   * the field or whose source doc was not in memory at create: those rows
   * never join the staleness comparison, which is the quiet direction to be
   * wrong in.
   */
  originDocRevision?: number;
  /**
   * The source plan doc changed AFTER this row was derived from it — an
   * advisory flag, never a gate. Set by `flagStaleFromDocEdit` when the
   * doc's settled `contentRevision` passes `originDocRevision`; cleared by
   * the body-edit choke point (`updateBodySnapshot`), which reads a rewrite
   * as "somebody reconciled the row with the plan as it now stands" and
   * re-stamps `originDocRevision` so a still-later plan edit re-flags.
   */
  possiblyStale?: { docRevision: number; ts: number };
  /**
   * The words this task CAME FROM, verbatim, and never rewritten.
   *
   * Originally "the human's verbatim words at promotion or creation", which
   * was the whole of it while a description could only ever be typed by the
   * person or agent who filed it. Triage now RESHAPES a row — a raw capture's
   * clipped title and unedited paragraph become a user story — so the words a
   * task started with are words a later pass can replace, and something has
   * to hold them. That something is this field: `updateBodySnapshot` fills it
   * from the pre-rewrite row the first time a body actually changes, so a
   * shaped task can always be read back to what was actually said.
   *
   * Write-once by construction. A dictated transcript, a promotion snippet and
   * a preserved original all answer the same question, and the earliest answer
   * is the closest to the source — so a filled quote is never overwritten.
   *
   * ONE writer for the rewrite case, deliberately, and it is the snapshot
   * rather than the named rewrite route: a body is a live Yjs room with
   * several doors into it, and the preservation belongs where the words are
   * lost, not where one caller announces it is about to lose them.
   *
   * ONE FIELD, ONE MEANING — deliberately, and the detail panel's "Original
   * words" label depends on it. Asked whether this needed to distinguish a
   * preserved capture from an author-chosen quotation: it does not, because
   * there is no author-quote writer. All four are provenance — the dictated
   * capture transcript, the human's words on a chat-born `create_tasks` row,
   * the latest HUMAN comment on a `promote_to_task` (agent replies are
   * excluded there by design), and this row's own pre-rewrite title-and-body
   * from `updateBodySnapshot`. A discriminator would be four writers to keep
   * honest and a migration for every existing row, to draw a line nothing
   * downstream reads. **If you ever add a writer that puts words here which
   * the task did NOT come from, that label starts lying** — add the
   * discriminator in the same change rather than widening this field's
   * meaning quietly.
   */
  quote?: string;
  /** Decisions keep the verbatim answer. `optionId` records WHICH candidate
   *  the words came from when one was tapped — the text stays the answer. */
  answer?: { text: string; by: string; ts: number; optionId?: string };
  /**
   * Answers that were WITHDRAWN, oldest first — the soft-delete half of
   * `answer`.
   *
   * Answering a decision is a single click, and a stray one used to be
   * unrecoverable: the words were overwritten by the next answer or, with no
   * undo at all, simply stood. The project rule is that a removal must be
   * reversible, so undo moves the answer HERE rather than dropping it. Nothing
   * reads this to decide anything — `answer` alone still says whether the
   * decision is answered — which is what keeps the record cheap to keep.
   */
  answerHistory?: Array<{
    text: string;
    by: string;
    ts: number;
    optionId?: string;
    withdrawnAt: number;
    withdrawnBy: string;
  }>;
  /** Which goal (id + its text at the time) produced this placement. */
  triagedAgainst?: { goalId: string; ts: number };
  /**
   * When this task's placement stopped being named by anybody — the durable
   * form of "it's in the bucket" (Bryan, 2026-08-17: "a bucket of tasks with
   * unknown goal that's the lowest priority… tasks from there should get
   * attached to a goal later if a goal becomes apparent").
   *
   * Two writers, one meaning:
   *  - a create that named no `goal` (an explicit `goal: 'chores'` is a
   *    PLACEMENT and stamps nothing — the same distinction `placement.placed`
   *    draws, and deliberately not `goal !== chores`);
   *  - a goal-list edit that removed the band an open task was placed under,
   *    which un-names a placement somebody DID make.
   * Cleared by `setTaskGoal`, the one write half of placement.
   *
   * SURVIVES hydrate: it records a placement still OWED, which a restart does
   * not answer. Before this field the distinction lived only in the create
   * RESPONSE, so after a restart an unplaced task and a deliberate chore were
   * identical.
   *
   * A timestamp rather than a boolean because "how long has this waited" is
   * the question a reading has to answer, and a flag cannot tell minutes from
   * a week.
   */
  unplacedSince?: number;
  /* `riskTier` was here, stamped by triage and keyed to the ACTION's damage.
     Removed from the type 2026-08-18 with the gate that read it. Tasks already
     persisted still carry the value in their sidecar; nothing reads it and no
     migration strips it, because rewriting every row is the larger risk. */
  /** Append-only audit trail. */
  transitions: TaskTransition[];
  /** The agent's own one-liners about this row (see `TaskNote`), append
   *  order, bounded by `TASK_NOTES_STORE_CAP`. Absent on every row written
   *  before the field existed, which reads as none. */
  notes?: TaskNote[];
  createdAt: number;
  /**
   * Display name of whoever FILED the ticket. Until this field existed the
   * creator was written to the `task.created` event and nowhere else, so
   * the one question a decision card has to answer — who is asking? — had
   * no row-level answer: the derived legacy review item shipped an empty
   * `createdBy` and the card read "Asked 11 minutes ago" beside a thread
   * card's "Asked by UX Bot 11 minutes ago". Absent on every row written
   * before the field, and on a create that named no author; `taskAskedBy`
   * is the one reader and carries the fallback.
   */
  createdBy?: string;
  updatedAt: number;
  /**
   * When the DESCRIPTION last changed — a body clock, not a row clock.
   *
   * `updatedAt` cannot answer this: twelve mutators bump it, including
   * `linkRef`, so "the row changed" says nothing about whether the
   * description still describes the world. And the live-room path
   * (`updateBodySnapshot`) deliberately bumps nothing at all, which is
   * correct for board activity and useless here — measured on the real
   * board, seven bodies had been rewritten and the system held no record of
   * a single one of those edits.
   *
   * Absent on a task filed before this field, and on a body that has never
   * been touched since it was written; `bodyWrittenAtOf` resolves both to
   * `createdAt`, which is when a never-edited body was in fact written.
   */
  bodyWrittenAt?: number;
  /**
   * When somebody last NAMED this row — stamped by `applyTitle`, the single
   * writer of `title`.
   *
   * Distinct from `bodyWrittenAt` and from `updatedAt` for the same reason
   * those two are distinct from each other: the question here is "has anybody
   * looked at the title since the task moved", and a row clock cannot answer
   * it.
   */
  titleWrittenAt?: number;
  /**
   * `bodyHead` of the description at the moment the title was last authored —
   * the user-story line the title compresses.
   *
   * Absent on a row filed before the standard existed, which suppresses the
   * head-change trigger for that row and nothing else.
   */
  titleHead?: string;
  /**
   * How many times the words a scoring run reads — title, body, goal — have
   * changed on this row. The create names the row, so a fresh task lands
   * here at 1; every later change to any of the three adds one.
   *
   * A COUNTER, not a clock, and that is the entire point of it: this is the
   * ordering token `recordEffortEstimate` compares, and two edits inside one
   * millisecond have to come out different. `titleWrittenAt` /
   * `bodyWrittenAt` cannot do that — see `forWordsRevision`, which carries
   * the incident.
   *
   * Absent on every row written before this field existed. `wordsRevisionOf`
   * reads that absence as 0, which is right in BOTH directions: a run
   * started after the load captures 0 and its answer lands, so a legacy row
   * is not "always stale"; and the first edit after the load moves the row
   * to 1, so a run that edit overtook is refused, and a legacy row is not
   * "never stale" either. Nothing ever compares it across a restart — an
   * in-flight scoring call does not survive one.
   */
  wordsRevision?: number;
  /**
   * The quality gate's verdict on the ticket's OWN decision — the derived
   * `r-legacy` row, whose words are this task's title, body and options.
   *
   * On the task rather than on a review row because there is no review row:
   * `legacyReviewItem` derives that item at read time and writes nothing, so
   * a verdict stamped onto it would vanish the moment it was read again.
   * `listReviewItems` hangs this on the derived item, which is what
   * `isReviewItemGated` reads — so a held decision leaves the reader's queue
   * through exactly the code path a held ticket item does.
   *
   * The version it is about is `wordsRevisionOf`, not a revision count: the
   * decision's words ARE the row's words, so every writer of them (the title
   * route, the body route, `revise_review_item`) already moves that counter
   * and thereby makes an older verdict stale.
   */
  decisionJudge?: ReviewItemJudgement;
  /**
   * Who filed the words the gate judged — the same record `filedBy` keeps on
   * a ticket item, and for the same one reason: an addressed wake needs the
   * filer's AGENT id, and `createdBy` is a display name. Written by
   * `recordDecisionJudgement`, so it names whoever last put these words
   * through the gate rather than whoever opened the row.
   */
  decisionFiledBy?: { id: string; name: string; kind?: TaskActor['kind'] };
  /**
   * Every superseded reading of the ticket's OWN decision — what the title,
   * body and options said before each `reviseTaskDecision`. The legacy twin
   * of `StoredReviewItem.revisions`, kept on the task for the reason
   * `decisionJudge` is: the derived `r-legacy` row is rebuilt on every read
   * and can hold nothing of its own. `legacyReviewItem` hangs this on that
   * row as `revisions`, which is what lets `reviewItemState` read the
   * ticket's decision as `revised` — back on the queue, marked — after the
   * reader asked on it. Written only by `reviseTaskDecision`; a
   * `rewrite_task` or a title edit through any other door is not a
   * revision in answer to anything and records nothing here.
   */
  decisionRevisions?: ReviewItemRevision[];
}

/** The board's sort, spelled once. `order` is a float a caller chose and
 *  nothing has ever forced it to be unique within a goal, so the two
 *  tiebreaks are reachable in ordinary data rather than theoretical. The
 *  server (`TaskStore`) and the browser (hub-board-model.ts) both sort with THIS
 *  function — a placement computed at one end and applied at the other is
 *  only meaningful while both agree on what "after" means. */
export function byBoardOrder(
  a: { order: number; createdAt: number; id: string },
  b: { order: number; createdAt: number; id: string },
): number {
  return a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * One entry of a submitted goal list. The id is OPTIONAL, and which way it
 * goes is the whole contract (§3.2, restated once goal ids are generated):
 *
 *  - **`id` present** — "this is the band you already have". It must name a
 *    goal this board holds right now; anything else is refused as
 *    `unknown-goal-id`. That is the refusal that makes a re-key
 *    unexpressible: there is no input here that can hand an existing band a
 *    different id, and no input that can hand a NEW band an id of the
 *    caller's choosing.
 *  - **`id` absent** — "create this band". The server generates an opaque id
 *    (`newGoalId`) and reports it in `created`, in submission order.
 *
 * So submitting a list now means: these are my bands, in this order, and the
 * ones I did not name an id for are new. Everything else the call could ever
 * do it still does — reorder, retitle, remove (gated) — none of which touch
 * an id.
 */
export interface GoalListEntry {
  /** Omit to CREATE. Present = must already exist on this board. */
  id?: string;
  title: string;
  dueAt?: number;
  /** Legacy nesting. Still accepted so a board written before subgoals were
   *  removed — and a caller this server cannot restart — still loads; the
   *  store FLATTENS it into bands of its own. Never written back. */
  subgoals?: Array<{ id?: string; title: string; dueAt?: number }>;
}
