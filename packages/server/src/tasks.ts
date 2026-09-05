import type {
  ReviewItemJudgement,
  ReviewItemRange,
  ReviewPayload,
  TaskReviewItem,
} from '@feedback/core';
import { DEFAULT_EFFORT_ESTIMATE_PROMPT } from '@feedback/core/effort-estimate-prompt';
import type {
  ArtifactCheck,
  GoalListEntry,
  Ref,
  Task,
  TaskActor,
  TaskEffortEstimate,
  TaskNote,
  TaskReadingTime,
  TaskStatus,
  TaskTransition,
} from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import type { DecisionShapeGap } from './decision-shape.ts';
import { TaskDecisionStore } from './review-items/decisions.ts';
import { ReviewJudgementStore } from './review-items/judgements.ts';
import { ReviewItemQueries } from './review-items/queries.ts';
import { ReviewItemStore } from './review-items/store.ts';
import type {
  AddReviewItemResult,
  AnswerDecisionResult,
  AnswerTaskReviewResult,
  HeldReviewItem,
  RecordDecisionJudgementResult,
  RecordReviewJudgementResult,
  RequestInfoOnReviewResult,
  RequestMoreInfoResult,
  ReviewItemCriteriaRead,
  ReviewStateCounts,
  ReviseReviewItemResult,
  ReviseTaskDecisionResult,
  SetReviewItemCriteriaResult,
  WithdrawAnswerResult,
  WithdrawReviewItemResult,
} from './review-items/types.ts';
import { TaskArchiveStore } from './task-archive.ts';
import { TaskAuthoringStore } from './task-authoring.ts';
import { TaskEventBus } from './task-event-bus.ts';
import { isArchived } from './task-fields.ts';
import type { AttachmentRuntime } from './task-helpers.ts';
import { isValidRef } from './task-helpers.ts';
import { TaskLifecycleStore } from './task-lifecycle.ts';
import { TaskLinksStore } from './task-links.ts';
import { TaskNotesStore } from './task-notes.ts';
import { type DeclaredOwnerKind, GENERIC_ASSIGNEE, HUMAN_ASSIGNEE } from './task-owner.ts';
import {
  agentPersistenceFor,
  goalPersistenceFor,
  hydrateTasksFromDisk,
  persistAttachmentsSidecar,
  persistWorkspaceTasks,
  reviewItemPersistenceFor,
  workspacePersistenceFor,
} from './task-persistence.ts';

/**
 * The hub task store: server-owned state for Workspace Hub workspaces and
 * their tasks (plan §3.2/§3.3).
 *
 * Words people write together live in CRDTs; facts the system is accountable
 * for — status, placement, who owns it — go through THIS gate. Every status
 * change lands here (`transition`) and gets an append-only audit entry with
 * the actor's identity and kind. The only hard stop is an `after` edge
 * explicitly marked enforce.
 *
 * Persistence is a per-workspace JSON sidecar at
 * `<dataDir>/workspaces/<id>.tasks.json`, written on a short debounce after
 * changes settle — the same pattern as doc metadata. The sidecar is
 * authoritative on hydrate; the ydoc projection (a later commit) is a
 * read-only mirror of it, never a source.
 *
 * A hub Workspace is a NEW first-class entity: today's `workspaceId` on
 * DocMeta is only a review tag minted by folder binds / diff reviews.
 * `attachDoc` LINKS existing docs and reviews to a hub workspace — nothing
 * is migrated, and docs keep working at their current URLs.
 *
 * WHAT IS STILL HERE. The row verbs themselves are not: they moved to five
 * modules, one per family, each taking a named slice of this store rather
 * than a `this` that reaches all of it —
 *
 *   - `task-authoring.ts`  create, rename, body edits
 *   - `task-lifecycle.ts`  the status gate, assignee, due date
 *   - `task-archive.ts`    archive / unarchive, task and band
 *   - `task-links.ts`      `after` edges and cross-references
 *   - `task-notes.ts`      notes, estimates, artifact checks, reading time
 *
 * — beside the four seams that were already out (`ReviewItemStore`,
 * `GoalStore`, `AgentStore`, `WorkspaceStore`) and the disk layer in
 * `task-persistence.ts`. What is left in this file is the state those verbs
 * write (the four `Map`s), the wire contract they are stated in (every
 * `…Result` and `…Event` type below), the wiring that hands each family its
 * slice, and one thin forwarder per verb so no caller had to change.
 */

/* The wire contract lives in @feedback/core/task-wire; re-exported here so
   the server-side call sites keep their one import. */
export type {
  ArtifactCheck,
  ArtifactLinkCheck,
  ArtifactVerdict,
  DecisionOption,
  DeclaredOwnerKind,
  GoalListEntry,
  InfoRequest,
  Ref,
  StoredReviewItem,
  Task,
  TaskActor,
  TaskEffortEstimate,
  TaskEffortEstimateFailed,
  TaskEffortEstimateOk,
  TaskEvidence,
  TaskEvidenceAmendment,
  TaskNote,
  TaskReadingTime,
  TaskStatus,
  TaskTransition,
} from '@feedback/core/task-wire';
export {
  REF_KINDS,
  TASK_NOTES_STORE_CAP,
  TASK_STATUSES,
  byBoardOrder,
} from '@feedback/core/task-wire';

/* The review-item store owns these now. Re-exported so every call site that
   already imports them from here — routes, server.ts, the projection, the
   suites — is untouched by the move. */
export {
  LEGACY_REVIEW_ITEM_ID,
  legacyDecisionItem,
  reviewItemVersion,
} from './review-items/derive.ts';
export { TaskDecisionStore } from './review-items/decisions.ts';
export { ReviewJudgementStore } from './review-items/judgements.ts';
export { ReviewItemQueries } from './review-items/queries.ts';
export { ReviewItemStore } from './review-items/store.ts';
export type { ReviewItemPersistence, ReviewItemStoreEvent } from './review-items/persistence.ts';
export type {
  AddReviewItemResult,
  AnswerDecisionResult,
  AnswerTaskReviewResult,
  HeldReviewItem,
  RecordDecisionJudgementResult,
  RecordReviewJudgementResult,
  RequestInfoOnReviewResult,
  RequestMoreInfoResult,
  ReviewItemCriteriaRead,
  ReviewStateCounts,
  ReviseReviewItemResult,
  ReviseTaskDecisionResult,
  SetReviewItemCriteriaResult,
  WithdrawAnswerResult,
  WithdrawReviewItemResult,
} from './review-items/types.ts';

import { CHORES_GOAL_ID, GoalStore, isReservedGoalId } from './task-goals.ts';

export {
  CHORES_GOAL_ID,
  RESERVED_GOAL_IDS,
  isReservedGoalId,
  newGoalId,
  sequenceAfter,
} from './task-goals.ts';

import {
  AgentStore,
  type AgentStreamProbe,
  type AttachAgentResult,
  type AttachmentThresholds,
  COMMENT_ACK_GRACE_MS,
  type DeliveryProbe,
  type DescribedAttachment,
  type HeartbeatResult,
  type LeadSeatHealth,
  type PublicAttachment,
  type QueuedComment,
  type QueuedVoiceRequest,
  VOICE_ACK_GRACE_MS,
} from './task-agents.ts';

export type {
  AgentStreamProbe,
  AttachAgentResult,
  AttachmentState,
  AttachmentThresholds,
  DeliveryProbe,
  DescribedAttachment,
  GatingSummary,
  HeartbeatResult,
  LeadNameConflicts,
  LeadSeatHealth,
  PublicAttachment,
  QueuedComment,
  QueuedVoiceRequest,
} from './task-agents.ts';
export {
  COMMENT_ACK_GRACE_MS,
  HEARTBEAT_FRESH_MS,
  LEAD_SEAT_STALE_MS,
  MAX_QUEUED_COMMENTS,
  OBSERVED_LIVE_MS,
  TOOL_CALL_STALE_MS,
  VOICE_ACK_GRACE_MS,
  attachmentState,
  attachmentStateLabel,
  attachmentsSidecarPath,
  commentQueuePath,
  publicAttachment,
  voiceQueuePath,
} from './task-agents.ts';

import {
  WorkspaceStore,
  isRetired,
  normalizeWorkspaceName,
  retiredNotice,
  retiredRefusal,
} from './workspace-store.ts';

export { isRetired, normalizeWorkspaceName, retiredNotice, retiredRefusal };

/* Pure per-row facts, lifted to a leaf module so the review-item store can
   share them without importing this file. */
export { isArchived, taskAskedBy, wordsRevisionOf } from './task-fields.ts';

/* `isValidRef`, `refKey` and the `isSafeHttpUrl` scheme check behind them
   live in `task-helpers.ts` now — `task-links.ts` is the only verb family
   that reads them, and a leaf module lets it do that without importing the
   file that imports it. Re-exported here because every caller outside this
   package addresses them at this path. */
export { isValidRef, refKey } from './task-helpers.ts';

/** How many builders a board may run at once when nobody has set a number
 *  for it — four (Bryan, 2026-08-31: *"Let's make it default 4, but Team
 *  Lead can adjust down (and so can Bryan)"*). The same "keep the board
 *  moving without starving higher-priority work" tension every lead already
 *  reads about in `workspace-board.md`'s "Respect capacity" bullet, made a
 *  number an owner can change instead of a judgment call every lead makes
 *  alone. */
export const DEFAULT_PARALLELISM_CAP = 4;
/** Below one, "limiting parallelism" has stopped meaning anything — a cap of
 *  zero would refuse every dispatch forever with no way back short of a
 *  second write, which is a worse failure than the validation that prevents
 *  it. */
export const PARALLELISM_CAP_MIN = 1;
/** Generous on purpose: this is a guard against the board never noticing it
 *  is starving other work, not a guess at anyone's real ceiling. */
export const PARALLELISM_CAP_MAX = 50;

/** What `parallelismCap()` answers: the effective number, whether it is the
 *  shipped default, and — once somebody has moved it — who did, when, and
 *  from what. */
export interface ParallelismCapRead {
  value: number;
  isDefault: boolean;
  lastChange?: ParallelismCapChange;
}

export interface WorkspaceGoal {
  id: string;
  title: string;
  dueAt?: number;
}

/** One move of a board's parallelism cap. `from` and `to` are the EFFECTIVE
 *  numbers — a clear back to the default records the default as `to`, so a
 *  reader never has to know what "unset" meant on the day. */
export interface ParallelismCapChange {
  actor: TaskActor;
  ts: number;
  from: number;
  to: number;
}

/* `NestedGoalInput` and `flattenNestedGoals` live in `task-helpers.ts` now —
   `task-persistence.ts` needs them and may not import a VALUE from this
   file. Re-exported so no caller of either symbol changes. */
export type { NestedGoalInput } from './task-helpers.ts';
export { flattenNestedGoals } from './task-helpers.ts';

export interface HubWorkspace {
  /** Crypto-random and unguessable — URLs hang off it (§3.2). */
  id: string;
  name: string;
  /** Ordered by priority — board sections ARE the goals. `chores` is a
   *  reserved out-of-band id, never present here (§3.2 edit contract). */
  goals: WorkspaceGoal[];
  /** Docs/reviews linked via attachDoc. Links, not membership — the docs'
   *  own metadata is untouched. */
  docIds: string[];
  /**
   * The agent RESPONSIBLE for this board — the addressee for anything that
   * needs one, a goal edit's re-triage first of all. Set at creation (the
   * creating agent), claimed by the first agent to attach when the seat is
   * empty, and reassignable via `setLeadAgent`.
   *
   * Optional because the absence has to be REPRESENTABLE: a board created by
   * a person, or hydrated from before this field existed, genuinely has
   * nobody responsible, and the surfaces say so. Inventing a lead from
   * whoever happens to be connected is the same lie as an inferred pending
   * state — it promises an addressee that was never asked.
   */
  leadAgentId?: string;
  /** When the current lead took the seat. */
  leadAgentSince?: number;
  /**
   * When this board was RETIRED — present iff it is. A retired board stops
   * ranking on the workspace list, refuses new tasks, and says so to any
   * agent that reads or attaches to it. Everything it holds survives
   * untouched: no file is moved, renamed or removed, and un-retiring is a
   * second write of this one field rather than a restore.
   *
   * That is deliberate and it is the constraint the feature was asked for
   * under. `deleteWorkspace` is the hard path — it `rmSync`s the tasks
   * sidecar and the events log — and CLAUDE.md's project-wide rule is that a
   * removal must be reversible. Retiring is the reversible middle that did
   * not exist: before it, the only way to stand a stale board down was to
   * rewrite its north star to a banner, which stops nothing.
   *
   * A TIMESTAMP rather than a boolean because "when" is the question anyone
   * asks next, and because an absent field and `false` would otherwise be two
   * spellings of live. `isRetired` is the one reader.
   */
  retiredAt?: number;
  /** Who retired it — the audit answer to "who stood this down". */
  retiredBy?: TaskActor;
  /** Free text the operator left, replayed verbatim in every refusal and
   *  notice: an agent told only "this board is retired" has nowhere to go,
   *  and the reason is usually the name of the board that replaced it. */
  retiredReason?: string;
  /**
   * What this board judges a review item against before it reaches the
   * reader's queue — a natural-language prompt the owner edits (Bryan,
   * 2026-08-29: *"Something we can change in the settings"*). Absent means
   * `DEFAULT_REVIEW_ITEM_CRITERIA`; `reviewItemCriteria()` is the one reader,
   * so the default lives in exactly one place.
   */
  reviewItemCriteria?: string;
  /**
   * What this board's ticket-effort scorer weighs — a natural-language
   * prompt the owner edits, the same shape and the same reasoning as
   * `reviewItemCriteria` (chunk 2 of the effort model). Absent means
   * `DEFAULT_EFFORT_ESTIMATE_PROMPT`; `effortEstimatePrompt()` is the one
   * reader, so the default lives in exactly one place.
   */
  effortEstimatePrompt?: string;
  /**
   * How many builders this board's lead may have dispatched at once — a
   * ceiling on `register_dispatch`, not a scheduler (Bryan, 2026-08-31: "add
   * support for limiting parallelism in the workspace"). Absent means
   * `DEFAULT_PARALLELISM_CAP`; `parallelismCap()` is the one reader, the same
   * shape and reasoning as `reviewItemCriteria` above — a board on the
   * default and a board that has never been asked read identically, and both
   * are the ordinary case.
   */
  parallelismCap?: number;
  /**
   * The LAST time the cap moved: who, when, from what, to what. The full
   * history is the `workspace.parallelism_cap_changed` rows in the board's
   * events log; this is the one row `get_workspace`, the settings panel and
   * the two nudges read without scanning it. Absent on a board nobody has
   * ever asked — a moved cap is never a mystery, an unmoved one needs no
   * story.
   */
  parallelismCapLastChange?: ParallelismCapChange;
  /**
   * Where this board's planning/discussion notes get checked in: a repo +
   * branch + directory, from which `POST /api/docs` derives a file (and a
   * pinned doc home) for a markdown doc created without an explicit path.
   * Absent means docs must name their own file — the fleet's
   * `<repo>/.claude/reviews/` scratch convention is untouched either way.
   * Host paths: served on the owner settings route only, never projected
   * into the `ws:` room a share visitor can sync (the settings route is not
   * on the visitor allowlist).
   */
  notesHome?: WorkspaceNotesHome;
  createdAt: number;
}

/** A workspace's default location for planning notes — see
 *  `HubWorkspace.notesHome`. `dir` is relative to the repo root, same
 *  traversal rules as a doc home's relPath. */
export interface WorkspaceNotesHome {
  repoRoot: string;
  branch: string;
  dir: string;
}

/**
 * The two fields a row carried while `parked` was a state of its own.
 *
 * Nothing writes them any more: parking a task moves it to `triage` and posts
 * a comment recording why and when to come back to it (board ticket,
 * 2026-08-27 — the state duplicated triage, which already means "nobody is
 * working this and nobody has agreed it is work"). They survive on disk
 * because the sidecar round-trips whole objects, and the startup migration is
 * their one reader: it lifts the pair into a comment, then clears them. Kept
 * off `Task` so no new writer can reach for them by autocomplete.
 */
export interface LegacyParkFields {
  parkedUntil?: number;
  parkedReason?: string;
}

/* `REASON_MAX` and `normalizeReason` moved with the archive verbs to
   `task-archive.ts`, their only readers. */

/* `initialTaskStatus` lives in `task-helpers.ts` now — `task-authoring.ts`
   is its only caller. Re-exported for the routes and suites that read it
   here. */
export { initialTaskStatus } from './task-helpers.ts';

/**
 * The title an UNNAMED row carries. A placeholder, not a name: the board
 * refuses a blank title at every door, and a row a person is about to type
 * into still has to be a row. `Task.untitled` is what says the placeholder is
 * in place; the literal itself is never compared against to decide that.
 */
export const UNTITLED_TASK_TITLE = 'Untitled task';

/* `flattenGoals` lived here. It existed to walk a two-level list as one, and
   the list has one level now — `workspace.goals` IS the flat list, so its
   callers read it directly. */

/**
 * A goal as a board ROW — the thing whose `done` somebody declares.
 *
 * Deliberately NOT a `Task`, and the two fields it drops are the reason.
 *
 *  - No `goal`. Only tasks carry containment (settled by Bryan, 2026-08-21:
 *    *"Goals don't have parent goals. For now. Let's say only tasks have
 *    goals."*), so goals are a flat set and a goal row is contained by
 *    nothing. That needs no representation at all — a field holding a
 *    reserved id or an empty string would be a containment claim nobody
 *    made.
 *  - `assignee` is OPTIONAL, because an owner cannot be invented. Every task
 *    create resolves a real one and refuses the bare word "agent"
 *    (`task-owner.ts`), but seeding goals with the lead agent would promise
 *    an owner nobody asked for. The precedent is `leadAgentId`, optional for
 *    exactly this reason — the absence has to be representable so the
 *    surfaces can render a vacancy.
 *
 * Everything it KEEPS is what makes the ticket's audit trail free: the same
 * `status`, and the same append-only `transitions` carrying the actor. A goal
 * moves through the one gate every other status change goes through
 * (`TaskStore.transition`), so there is no second status machine to keep
 * honest.
 */
/** `placeSpinoff`'s answer: the band, which rule chose it, and the lead to
 *  address the row to when the seat is held. */
export interface SpinoffPlacement {
  goal: string;
  rule: 'originating-task' | 'top-active-goal' | 'chores';
  /** The task the doc belongs to, when its goal is what decided the band. */
  taskId?: string;
  leadAgentId?: string;
}

export interface GoalRow {
  /** The goal's own id, never re-minted — `task.goal`, done-task history and
   *  `triagedAgainst.goalId` all join on it. */
  id: string;
  workspaceId: string;
  kind: 'goal';
  title: string;
  /** Markdown snapshot of the goal's prose, mirroring `Task.body`. */
  body?: string;
  /** Absent means nobody owns it — a vacancy, not a person. */
  assignee?: string;
  dueAt?: number;
  /**
   * Cross-references, mirroring `Task.links` — in practice the docs this
   * goal came out of or is discussed in, written by the ref backfill and the
   * settle-time doc scan (a doc whose prose links this goal). Row-owned, so
   * `syncGoalRows` never touches it and it survives every goal-list edit.
   */
  links?: Ref[];
  /** Fractional sort key among the board's goal rows: priority order. */
  order: number;
  status: TaskStatus;
  /** Append-only audit trail — who declared the goal done, and when. */
  transitions: TaskTransition[];
  /**
   * When this BAND was archived — the same three soft-delete fields a task
   * carries, read through the same `isArchived`, and for the same reason: a
   * band the board has moved past had no reversible removal at all. Dropping
   * it from `workspace.goals[]` was the only way out, and that is the one
   * edit `setGoalList` refuses while the band still holds tasks.
   *
   * The goal stays in `workspace.goals[]` while archived. That is deliberate:
   * the list is what `syncGoalRows` reconciles against and what `reorderGoals`
   * permutes, so taking the entry out would make a restore an insertion into
   * somebody else's priority order rather than a field clear. The BOARD hides
   * it — `boardSections` skips an archived band — which is the whole of what
   * "off the board" means here, exactly as it is for a task.
   */
  archivedAt?: number;
  /** Who archived the band, as a display name. */
  archivedBy?: string;
  /** Why, in the archiver's words. Cleared by a restore. */
  archiveReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** A row the transition gate can move: a task, or a goal. */
export type BoardRow = Task | GoalRow;

/**
 * The slice of a goal row that every band-describing READ carries: the
 * status, and — on a declared done — who said so and when. One derivation,
 * shared by the ydoc projection and `summarizeGoals`, so the two payloads
 * cannot disagree about what "this band is done" means.
 *
 * Attribution is a display name and kind, never an actor id — the projection
 * ships to share visitors under the §3.3 contract, and a REST reader needs
 * nothing more either. Sourced from the LAST transition to done (the trail is
 * append-only, so scan from the tail): a goal reopened and re-declared done
 * is attributed to the person who declared it the time that stuck.
 */
export interface GoalStatusMeta {
  status: TaskStatus;
  doneAt?: number;
  doneBy?: { name: string; kind: 'person' | 'agent' };
}

export function goalStatusMeta(row: GoalRow): GoalStatusMeta {
  if (row.status !== 'done') return { status: row.status };
  for (let i = row.transitions.length - 1; i >= 0; i--) {
    const t = row.transitions[i];
    if (t && t.to === 'done') {
      return { status: 'done', doneAt: t.ts, doneBy: { name: t.by.name, kind: t.by.kind } };
    }
  }
  // A done row with no done transition should not exist — the one status
  // gate always appends — but a hydrated file is not a promise, so say
  // "done, attribution unknown" rather than inventing an actor.
  return { status: 'done' };
}

/* `isGoalRow` lives in `task-helpers.ts` now, beside the other pure row
   predicates. Imported back below and re-exported, because it is read by the
   routes, the projections and half the suites at this path. */
export { isGoalRow } from './task-helpers.ts';

export interface CreateTaskOpts {
  title: string;
  /** File the row as UNNAMED: `title` is the placeholder and the row is
   *  flagged `untitled` until somebody names it. See `Task.untitled`. */
  untitled?: boolean;
  body?: string;
  assignee?: string;
  /** Declares whether `assignee` is a person or an agent. Omitted, the store
   *  falls back to the author's own classification when the caller is
   *  assigning to itself. */
  assigneeKind?: DeclaredOwnerKind;
  needs?: 'action' | 'decision';
  /** Candidate answers. Decision tasks only; ids are minted here. */
  options?: Array<{ label: string; detail?: string }>;
  goal?: string;
  order?: number;
  after?: string[];
  afterEnforce?: string[];
  dueAt?: number;
  links?: Ref[];
  origin?: Ref;
  quote?: string;
  /**
   * File the row as a plan DRAFT: forced to `triage` whatever the actor, and
   * held there until the named plan doc is approved. Set by the create
   * routes when the source doc's plan gate is pending — see `Task.planHold`.
   */
  planHold?: { docId: string };
  /**
   * File this row in `triage` whoever filed it, because the row itself does
   * not carry enough to act on.
   *
   * A person's create normally lands in `todo`, and that is right when the
   * person wrote the row. A spin-off is different: the row's words are a
   * fragment of a conversation that the tapper selected rather than composed,
   * and "Cloudflare" is a two-word row nobody can pick up. Triage is where a
   * row goes to be given enough to act on — so this says "not ready", which
   * is a claim about the CONTENT, where `planHold` is a claim about its
   * provenance. Neither implies the other and both force the same status.
   *
   * Unlike `planHold` nothing later releases it: a person editing the row
   * out of triage is the release, because the thing that was missing was
   * words only a person can add.
   */
  fileToTriage?: boolean;
  /** Who is creating it, when the caller knows — attributed on the event
   *  and in the audit log. Optional: the create routes predate it and a
   *  missing author must not become an anonymous 400. */
  actor?: { id: string; name: string; kind?: string };
}

/** An open dependency reported by the transition gate. `enforce: true` means
 *  the edge refused the transition; otherwise it's a warning that lands in
 *  the caller's context at exactly the moment it matters (§3.3). */
export interface TransitionBlocker {
  taskId: string;
  title: string;
  status: TaskStatus;
  needs?: 'action' | 'decision';
  enforce: boolean;
  message: string;
}

export type TransitionResult =
  | { ok: true; task: BoardRow; blockers: TransitionBlocker[] }
  | {
      ok: false;
      error: 'not-found' | 'bad-status' | 'same-status' | 'blocked' | 'plan-unapproved';
      blockers?: TransitionBlocker[];
      /** Refusal text shaped to land verbatim in an agent's context. */
      message?: string;
    };

/**
 * What actually happened to a new task's placement.
 *
 * `placed` is MEASURED, never inferred: it is "the caller named a goal",
 * which is a different fact from "the task's goal is chores" — an explicit
 * `'chores'` is a placement and an omitted goal that landed there is not, and
 * only the create call can still tell them apart. An unplaced create records
 * that in `unplacedSince`, which outlives the response and every restart.
 */
export interface TaskPlacement {
  /** The caller named a goal — even `'chores'`. False means it fell to the
   *  Backlog resting state without anyone judging it. */
  placed: boolean;
}

export type CreateTaskResult =
  | {
      ok: true;
      task: Task;
      /** Where this task ended up, and whether anyone was told to place it. */
      placement: TaskPlacement;
      /**
       * Advisory: the parts of the decision shape this body doesn't visibly
       * have (`stakes`, `options`, `blocked`). Only ever set for
       * `needs: 'decision'`, and never a refusal — a gate demanding all four
       * would make filing a quick decision a chore, and the response to a
       * chore is to file it as an action instead.
       */
      shapeGaps?: DecisionShapeGap[];
    }
  | {
      ok: false;
      error:
        | 'workspace-not-found'
        // The board has been stood down. Refused at the ONE choke point every
        // filing path runs through — the batch route, the markdown import,
        // promote-to-task and the voice fast path all land here — because
        // "stops accepting new work" enforced per-route is a rule that holds
        // until somebody adds the next route.
        | 'workspace-retired'
        | 'unknown-goal'
        | 'unknown-after'
        | 'unknown-after-enforce'
        // §"a decision body must be decision-shaped": the body has to ASK
        // something. A progress report filed as a decision leaves the person
        // who opens it with nothing to decide from.
        | 'decision-body-required'
        | 'options-need-decision'
        | 'bad-option';
      /** Refusal text shaped to land verbatim in an agent's context. */
      message?: string;
    };

/**
 * The §3.3 visitor-contract chip (rule 2): how a task renders inside a doc —
 * id, title, status, assignee, and deliberately NOTHING else. This shape
 * reaches share visitors, so adding a field here is a sharing decision, not
 * a convenience.
 */
export interface TaskChip {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
}

export function taskChip(task: Task): TaskChip {
  return { id: task.id, title: task.title, status: task.status, assignee: task.assignee };
}

export type LinkRefResult =
  | { ok: true; task: Task; changed: boolean }
  | { ok: false; error: 'not-found' | 'bad-ref' | 'self-ref' };

export type UnlinkRefResult =
  | { ok: true; task: Task; changed: boolean }
  | { ok: false; error: 'not-found' | 'bad-ref' };

// ── Agent attachments (plan §4) ─────────────────────────────────────────────

/* `AttachmentRuntime` and `isAttachmentRuntime` live in `task-helpers.ts`
   now — `task-persistence.ts` needs them and may not import a VALUE from
   this file. Re-exported so no caller of either symbol changes. */
export type { AttachmentRuntime } from './task-helpers.ts';
export { isAttachmentRuntime } from './task-helpers.ts';

/**
 * The workspace↔agent link, stored as DATA from day one (§4) — keyed
 * (workspaceId, agentId), no uniqueness on agentId, so one agent can hold
 * attachments to N workspaces at once. v1's only real runtime is the local
 * Claude Code session; a cloud agent or webhook later is a new record shape,
 * not a new architecture.
 *
 * PRIVACY (§3.3 projection visitor contract, rule 1): these records NEVER
 * enter any ydoc, and `endpoint` — the one host-machine-describing field —
 * additionally never rides an event. Both surfaces reach share visitors
 * (Yjs sync is all-or-nothing; the SSE feed opens to visitors in the
 * minimal-share commit), so the endpoint's only exits are the attachments
 * sidecar and owner REST, with visitor redaction — the private-meta pattern.
 */
/**
 * The slice of the fleet address book the store needs (identities.ts
 * implements it). An interface rather than the class so tasks.ts stays free
 * of identities.ts and the dependency runs one way.
 */
export interface AgentRoster {
  upsertAgent(id: string, displayName?: string): unknown;
  resolveAgentId(idOrName: string): string | null;
  displayNameFor(id: string): string | null;
  /** The survivor an id was merged into, or null when the id is live. */
  mergedAwayInto(id: string): string | null;
}

export interface AgentAttachment {
  workspaceId: string;
  agentId: string;
  runtime: AttachmentRuntime;
  /** Where to reach a non-local runtime. Host-machine-describing: REST-only
   *  with visitor redaction; absent for the local session. */
  endpoint?: string;
  lastHeartbeat: number;
  /** A heartbeat proves the child process is ALIVE; this proves it can
   *  WORK. A session at its usage limit heartbeats normally for hours — the
   *  outage signature is these two fields disagreeing (§4). */
  lastToolCallAt: number;
  /** e.g. ['tasks.write', 'docs.edit', 'voice.mutations']. */
  capabilities: string[];
  /** The plugin bundle version this session is RUNNING — not the one its
   *  machine's cache holds. A session resolves the plugin at launch, so
   *  those two disagree from the moment an update runs until the session
   *  restarts, and this is the one that decides whether a tool exists for
   *  this agent. Absent on any peer older than the release that added it,
   *  which is exactly what makes silence readable as "behind". */
  pluginVersion?: string;
  /** A nonce the MCP child mints once per PROCESS and sends on every attach.
   *  It answers the one question the ack grace window depends on: is this
   *  re-attach the SAME live process (whose in-flight deliveries may still
   *  be acked — respect the grace) or a fresh one (whatever was in flight
   *  went to a process that is gone — bypass it)? Absent on older bundles,
   *  which keep the bypass-always behavior they were built against. */
  processId?: string;
}

/** What an agent is told when it reads a board that has been stood down. */
export interface RetiredNotice {
  /** When it was retired. */
  since: number;
  reason?: string;
  /** Prose, because the reader is a language model with no schema for this
   *  and one sentence it can act on beats a flag it has to interpret. */
  notice: string;
}

/**
 * Store-level events (plan §3.6). The SSE transport subscribes via `onEvent`;
 * every emitted event is ALSO appended to the per-workspace events.jsonl
 * audit log at the emit choke point, so the audit log can never disagree
 * with what subscribers saw.
 *
 * The §3.6 list is exhaustive by contract — anything that subscribes to this
 * feed (mirrors, cloud agent runtimes) sees nothing at all for a change that
 * doesn't emit an event, so every row in the table has a mutation here.
 */
export interface TaskCreatedEvent {
  type: 'task.created';
  workspaceId: string;
  taskId: string;
  /** The full task at creation time (per §3.6: task, goal, assignee,
   *  triagedAgainst — the latter three lifted out for cheap filtering). */
  task: Task;
  goal: string;
  assignee: string;
  triagedAgainst?: { goalId: string; ts: number };
  /**
   * Who created it. Absent when the caller supplied no author (the browser
   * board has no create affordance; imports attribute themselves).
   * Load-bearing beyond the audit trail: the MCP child suppresses an
   * author's own events by comparing `actor.id`, and with no actor on the
   * event agents most emit, a session that creates six tasks received all
   * six back as inbound channel messages.
   */
  actor?: TaskActor;
  ts: number;
}

export interface TaskTransitionedEvent {
  type: 'task.transitioned';
  workspaceId: string;
  taskId: string;
  /**
   * `'goal'` when the row that moved was a goal. Absent reads as a task, the
   * same default the row's own `kind` carries, so every event already written
   * keeps its meaning.
   *
   * On the wire rather than in the consumers deliberately: a goal moves
   * through the one status gate, so it must appear in the audit log like any
   * other status change — suppressing the event would make the activity feed
   * silently miss goal closures, which is worse than labelling one. The
   * browser surfaces do not read this yet, so a goal closure currently renders
   * with a task's deep link; that is cosmetic, and fixing it belongs with the
   * board work that gives a goal row somewhere to link TO.
   */
  kind?: 'task' | 'goal';
  from: TaskStatus;
  to: TaskStatus;
  actor: TaskActor;
  note?: string;
  /** What the task cost in tokens (agent-reported at done). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Was the human's live confirmation on a yellow-tier agent move (§3.4).
   *  Never emitted since the risk gate was removed 2026-08-18; kept so a
   *  reader of an older `events.jsonl` row still types. */
  confirmed?: boolean;
  ts: number;
}

/**
 * A gate refusal (§3.4 risk tiers). NOTHING EMITS THIS since the risk gate was
 * removed on 2026-08-18 — it is retained, along with the client's
 * `describeEvent` case for it, because rows are already in `events.jsonl` and
 * a type the feed no longer knows renders as the bare slug `task.gate_refused`
 * in a view built for people. Deleting an event type is not free once it has
 * been written down. It carries no task, because nothing about the task
 * changed.
 */
export interface TaskGateRefusedEvent {
  type: 'task.gate_refused';
  workspaceId: string;
  taskId: string;
  /** The status the actor was refused. */
  to: TaskStatus;
  riskTier: 'green' | 'yellow' | 'red';
  reason: 'risk-refused' | 'needs-confirmation';
  actor: TaskActor;
  ts: number;
}

/**
 * §3.6's hand-off row. `assignee` was writable only at task creation, so the
 * most ordinary move on a board whose premise is that a human and an agent
 * both work it — "you take this one" — had no mutation, and this row could
 * never be emitted. Carries both ends because the interesting fact is the
 * hand-off direction, not the destination.
 */
export interface TaskAssignedEvent {
  type: 'task.assigned';
  workspaceId: string;
  taskId: string;
  from: string;
  to: string;
  actor: TaskActor;
  ts: number;
}

/**
 * A description rewritten after creation. Not in §3.6's table for the same
 * reason `task.gate_refused` isn't: the table predates the body being
 * writable at all, and a mutation that emits nothing is invisible to every
 * subscriber and to the audit log.
 *
 * Deliberately NOT emitted by `updateBodySnapshot`, which fires on every
 * keystroke's debounce as somebody types in the body room — that is content
 * activity, and the doc room already announces it. This row is for the
 * discrete, attributable act of replacing a description wholesale.
 */
export interface TaskBodyEditedEvent {
  type: 'task.body_edited';
  workspaceId: string;
  taskId: string;
  actor: TaskActor;
  /** Present ONLY when the rewrite also retitled the row — the shaping case.
   *  Both ends, because the trail's reader knows the row by the title they
   *  filed it under, and after a shaping that title is gone from every other
   *  surface. */
  titleFrom?: string;
  titleTo?: string;
  /** Why the rewriter changed it, in the rewriter's words — carried when the
   *  caller gave one, so the trail can say more than “rewrote”. */
  reason?: string;
  ts: number;
}

/**
 * A title changed on its own — the board's inline edit, or a reviewer fixing
 * a name whose body was already right. Renames used to emit nothing (§3.6's
 * table predates a reviewable title standard), which made a title-only fix
 * the one shaping act with no audit row: the old name — the only name the
 * filer would recognise — survived nowhere. Both ends always travel, for the
 * same reason `task.body_edited` carries them when it retitles.
 */
export interface TaskRetitledEvent {
  type: 'task.retitled';
  workspaceId: string;
  taskId: string;
  actor: TaskActor;
  titleFrom: string;
  titleTo: string;
  /** Why, in the renamer's words — when the caller gave one. */
  reason?: string;
  ts: number;
}

/**
 * A due date set, moved, or cleared after creation.
 *
 * `dueAt` was accepted at CREATE and by nothing afterwards, so the detail
 * panel rendered a fact with no way to correct it. Both ends ride the row
 * because "moved to Friday" and "set to Friday" are different things to
 * whoever is reading the trail, and `to: null` is a clear rather than an
 * omission — a missing key would be indistinguishable from a row written by
 * an older writer.
 */
export interface TaskDueSetEvent {
  type: 'task.due_set';
  workspaceId: string;
  taskId: string;
  from: number | null;
  to: number | null;
  actor: TaskActor;
  ts: number;
}

/**
 * A row soft-deleted, and the row that came back.
 *
 * Two event types rather than one with a boolean, because the trail is read as
 * sentences and "restored" is the half somebody goes looking for: a row that
 * disappeared and reappeared is a story, and an `archived: false` would spell
 * it as a repeated field write.
 *
 * `reason` rides the event as well as the row for the same reason the park's
 * does — the trail is where a removal gets argued with weeks later, and the
 * row's own copy is cleared the moment it is restored.
 */
export interface TaskArchivedEvent {
  type: 'task.archived';
  workspaceId: string;
  taskId: string;
  /** The row's title at the moment it left the board. Kept on the event
   *  because the trail is read long after, and the restore surfaces name it —
   *  a later rewrite must not change what this line says happened. */
  title: string;
  /** Set when the archived row is a GOAL. Absent for a task, exactly as on
   *  `task.transitioned` — goal rows ride the task events with this one
   *  discriminator rather than growing a parallel event family nothing else
   *  on the wire knows how to read. */
  kind?: 'goal';
  reason?: string;
  /** Batch key, on the GOAL's own event: every task the cascade took carries
   *  it as `partOf`. The same shape `workspace.goals_changed`
   *  uses for the moves it fans out. */
  batchId?: string;
  /** Set on a MEMBER of a cascade — the batchId of the goal archive that
   *  removed this row. A reader that only knows about single archives sees an
   *  ordinary `task.archived`, which is what it is. */
  partOf?: string;
  /** How many tasks went with the band, on the goal's own event. The number
   *  the confirmation promised, recorded as what actually happened. */
  cascadeTasks?: number;
  actor: TaskActor;
  ts: number;
}

export interface TaskRestoredEvent {
  type: 'task.restored';
  workspaceId: string;
  taskId: string;
  title: string;
  /** Set when the restored row is a GOAL — see `TaskArchivedEvent.kind`. */
  kind?: 'goal';
  /** The reason the archive carried, echoed here so the pair reads as one
   *  story without a lookup. Absent when it was archived without one. */
  reason?: string;
  /** Batch key on the goal's own event; members carry it as `partOf`. */
  batchId?: string;
  partOf?: string;
  /** How many tasks came back with the band. */
  cascadeTasks?: number;
  actor: TaskActor;
  ts: number;
}

export interface TaskRegroupedEvent {
  type: 'task.regrouped';
  workspaceId: string;
  taskId: string;
  fromGoal: string;
  toGoal: string;
  /** The task's position in its new goal. */
  order: number;
  actor: TaskActor;
  /** Set when this move is one member of a batch — it references the parent
   *  `workspace.goals_changed` (goal-list edit, server-side) or
   *  `workspace.goals_changed` (goal-list edit, placed by the agent) batchId. */
  partOf?: string;
  ts: number;
}

/**
 * A row came free: the last ticket it was waiting on closed.
 *
 * Blocked is DERIVED (`@feedback/core/task-blocked`), so nothing about the row
 * changes here — it was `todo` while it was blocked and it is `todo` now, and
 * the board simply stops drawing the barred ring. What is NOT free is the
 * record that it happened: without this event, a ticket that spent four days
 * waiting rejoins the queue with nothing on its Activity tab to say why, and
 * the reader who wants to know what cleared it has to reconstruct it from the
 * blocker's own trail. One row per dependant that came free, naming the ticket
 * whose closure did it.
 *
 * Emitted per DEPENDANT rather than once per closure, because that is the
 * grain the Activity tab reads: the tab filters by `taskId`, and a single
 * event on the blocker would leave every row it freed silent.
 */
export interface TaskUnblockedEvent {
  type: 'task.unblocked';
  workspaceId: string;
  /** The row that came free. */
  taskId: string;
  /** The ticket whose closure cleared the last edge. */
  clearedBy: string;
  /** …and its title, so the line survives that ticket being renamed. */
  clearedByTitle: string;
  /** Whoever closed the blocker — the actor on that transition. */
  actor: TaskActor;
  ts: number;
}

export interface DecisionAnsweredEvent {
  type: 'decision.answered';
  workspaceId: string;
  taskId: string;
  /** The VERBATIM answer text (§3.6). */
  answer: string;
  /** Which candidate the words came from, when one was tapped. Absent for
   *  free text — the answer is the text either way. */
  optionId?: string;
  /**
   * WHICH review item on the task was answered, when the answer came in
   * through `answerTaskReview` on a real row.
   *
   * Absent for the legacy path, and that absence is load-bearing rather than
   * incidental: `answerDecision` is untouched, so every existing listener sees
   * byte-identical events, and a listener that wants the row can read this
   * without having to guess when a ticket holds several.
   */
  reviewItemId?: string;
  actor: TaskActor;
  /** The decision task's links — a ready-made propagation checklist. */
  links: Ref[];
  ts: number;
}

/**
 * An answer taken back.
 *
 * Its own event rather than a second `decision.answered` carrying a flag: an
 * agent watching the feed has to be able to tell "the decision moved" from
 * "the decision is open again, and what I propagated was withdrawn". The
 * withdrawn words ride the event because the agent that acted on them may
 * need to say which answer it had already acted on.
 */
export interface DecisionAnswerWithdrawnEvent {
  type: 'decision.answer_withdrawn';
  workspaceId: string;
  taskId: string;
  /** The answer that was taken back, verbatim. */
  answer: string;
  /** Who had answered — not necessarily who withdrew it. */
  answeredBy: string;
  actor: TaskActor;
  links: Ref[];
  ts: number;
}

/**
 * "Tell me more" — the third first-class response to a decision, next to
 * picking an option and writing your own answer.
 *
 * Deliberately its own event rather than an answer with a flag: the decision
 * is still OPEN afterwards, it still counts at the top of the board, and what
 * the attached agent owes is context, not propagation. Collapsing the two
 * would make "I can't decide from this yet" indistinguishable from a decision
 * that has been made.
 */
export interface DecisionInfoRequestedEvent {
  type: 'decision.info_requested';
  workspaceId: string;
  taskId: string;
  /** The VERBATIM question. */
  question: string;
  /** WHICH review item was asked about, when it came in through
   *  `requestMoreInfoOnReview` on a real row. Absent on the legacy path, for
   *  the same reason as on `decision.answered`. */
  reviewItemId?: string;
  actor: TaskActor;
  links: Ref[];
  ts: number;
}

/**
 * The board's responsible agent changed — claimed on a first attach into an
 * empty seat, or reassigned outright. `oldLeadAgentId` is absent for a claim,
 * which is what distinguishes "a leaderless board found one" from "the lead
 * was handed over" in the activity view.
 */
export interface WorkspaceLeadChangedEvent {
  type: 'workspace.lead_changed';
  workspaceId: string;
  oldLeadAgentId?: string;
  leadAgentId: string;
  actor: TaskActor;
  ts: number;
}

/**
 * A board was stood down, or brought back. Its own event type rather than a
 * flavour of `goals_changed`: the activity view's reader wants "this board
 * stopped being worked" as a row, and the projection repaints the badge off
 * it. `retired: false` is the un-retire — one event, both directions, so a
 * subscriber cannot handle the standing-down and miss the return.
 */
export interface WorkspaceRetiredChangedEvent {
  type: 'workspace.retired_changed';
  workspaceId: string;
  retired: boolean;
  /** Only ever present on the retiring half. */
  reason?: string;
  actor: TaskActor;
  ts: number;
}

/**
 * The board's name changed. `oldName` rides along because the name is how
 * people and agents refer to a board in every surface OUTSIDE it — a chat
 * message, a skill, another board's task body — so an audit row that only
 * carries the new one cannot answer "which board is this".
 */
export interface WorkspaceRenamedEvent {
  type: 'workspace.renamed';
  workspaceId: string;
  oldName: string;
  name: string;
  actor: TaskActor;
  ts: number;
}

/**
 * The board's parallelism cap moved. Emitted from the one store method both
 * REST routes (the cap's own address and the settings panel's) call, so the
 * events log carries every change whichever door it came through — and
 * carries it forever: the log is append-only, which is what makes "who moved
 * it last week" answerable after the record on the workspace has moved on.
 */
export interface WorkspaceParallelismCapChangedEvent extends ParallelismCapChange {
  type: 'workspace.parallelism_cap_changed';
  workspaceId: string;
}

export interface WorkspaceGoalsChangedEvent {
  type: 'workspace.goals_changed';
  workspaceId: string;
  /** Batch key: member task.regrouped events carry it as `partOf`. */
  batchId: string;
  /** 'reorder' = same goals, new order (the largest single-gesture priority
   *  change the board offers); 'edit' = add/remove/retitle/dueAt changes.
   *  Deliberately NO re-triage fires either way (§3.2). */
  kind: 'reorder' | 'edit';
  oldGoals: WorkspaceGoal[];
  newGoals: WorkspaceGoal[];
  actor: TaskActor;
  /** Open tasks whose goal id disappeared, moved to Backlog. */
  movedToChores: string[];
  ts: number;
}

/** §3.6: agent.attached / agent.detached / agent.heartbeat carry the
 *  attachment record — in its PUBLIC shape, because the SSE feed and the
 *  audit log both outlive the local trust boundary (endpoint never rides). */
export interface AgentAttachedEvent {
  type: 'agent.attached';
  workspaceId: string;
  agentId: string;
  attachment: PublicAttachment;
  ts: number;
}

export interface AgentDetachedEvent {
  type: 'agent.detached';
  workspaceId: string;
  agentId: string;
  attachment: PublicAttachment;
  ts: number;
}

export interface AgentHeartbeatEvent {
  type: 'agent.heartbeat';
  workspaceId: string;
  agentId: string;
  attachment: PublicAttachment;
  ts: number;
}

/** Where an utterance ended up. Named rather than inlined because it is
 *  written in three places (the event, the record call, the router's own
 *  result) and a fourth value added to only two of them is a type hole. */
export type VoiceRoute = 'fast-path' | 'fast-path-action' | 'agent' | 'agent-queued';

/** §3.6: every voice utterance emits `voice.request` — transcript, chosen
 *  route, ack text — which is what makes "voice always answers" a checkable
 *  artifact rather than a promise (§2.4). */
/**
 * An agent's session posted a one-line note onto its current row (see
 * `TaskNote`). Carries the note's text so the audit log is the trail; carries
 * `actor` so the emit choke point reads it as observed work — a turn ending
 * is the agent alive, and the work clock should say so.
 */
export interface TaskNotedEvent {
  type: 'task.noted';
  workspaceId: string;
  taskId: string;
  actor: TaskActor;
  kind: TaskNote['kind'];
  text: string;
  ts: number;
}

export interface VoiceRequestEvent {
  type: 'voice.request';
  workspaceId: string;
  /** The utterance VERBATIM. */
  transcript: string;
  /** Which route handled it. 'agent-queued' = no live attachment; the
   *  request waits in the voice queue for the next attach.
   *
   *  'fast-path-action' is deliberately NOT 'fast-path': the latter means "a
   *  lookup the server already answered", which readers downstream drop on
   *  exactly that reading. An action CHANGED something on this board without
   *  the agent doing it, so it is the one voice row an agent most needs to
   *  see — folding it into the lookup value would make a board move silently. */
  route: VoiceRoute;
  /** The explicit reply the speaker saw — names what was heard and which
   *  route handles it. */
  ack: string;
  /** The per-surface anchor the utterance carried (§3.8). */
  context?: unknown;
  /**
   * The queue row this utterance was written to, present on every row routed
   * to an agent.
   *
   * The receiving agent POSTs it back to acknowledge, and that receipt — not
   * the socket write — is what takes the row off the queue. Absent on rows a
   * server older than the durable queue emitted, and absent on `fast-path`
   * rows, which were answered rather than handed to anyone.
   */
  queueId?: string;
  actor: TaskActor;
  ts: number;
}

/**
 * A review item was RAISED on a ticket. Emitted at the store, before the
 * quality gate has judged it, because "filed" is a fact whether or not the
 * item reaches the reader's queue — and the task's Activity tab is where a
 * reader goes to see a question was asked and later answered. Without this
 * row the trail showed `decision.answered` with no ask before it, so an
 * answered item read as an answer to nothing.
 */
export interface ReviewItemAddedEvent {
  type: 'review_item.added';
  workspaceId: string;
  taskId: string;
  reviewItemId: string;
  shape: ReviewPayload['shape'];
  /** The ask, verbatim — the trail names the question, not just its id. */
  headline: string;
  actor: TaskActor;
  links: Ref[];
  ts: number;
}

/**
 * A review item's words changed in place — the owner's half of the
 * doc-style exchange: a person asks on a phrase, the owner revises. The
 * item is back on the queue after this, marked, which is what a lead
 * watching the feed needs to know.
 */
export interface ReviewItemRevisedEvent {
  type: 'review_item.revised';
  workspaceId: string;
  taskId: string;
  reviewItemId: string;
  /** The anchored thread this revision answers, when there was one. */
  threadId?: string;
  actor: TaskActor;
  links: Ref[];
  ts: number;
}

/**
 * A review item's ASKER took it back — or put it back (`reinstated`). The
 * words stay on the ticket verbatim; only the item's standing changed, so the
 * reader's queue drops (or re-offers) it. The ticket-borne twin of the stamp
 * the doc-thread withdraw route writes, emitted so the feed and the
 * projection hear about a queue change no task row records.
 */
export interface ReviewItemWithdrawnEvent {
  type: 'review_item.withdrawn';
  workspaceId: string;
  taskId: string;
  reviewItemId: string;
  /** True on the undo — the ask is back in front of the reader. */
  reinstated?: boolean;
  /** The asker's one line on why, when they wrote one. */
  reason?: string;
  actor: TaskActor;
  links: Ref[];
  ts: number;
}

export type TaskStoreEvent =
  | ReviewItemAddedEvent
  | ReviewItemRevisedEvent
  | ReviewItemWithdrawnEvent
  | TaskCreatedEvent
  | TaskTransitionedEvent
  | TaskGateRefusedEvent
  | TaskAssignedEvent
  | TaskBodyEditedEvent
  | TaskRetitledEvent
  | TaskDueSetEvent
  | TaskArchivedEvent
  | TaskRestoredEvent
  | TaskRegroupedEvent
  | TaskUnblockedEvent
  | TaskNotedEvent
  | DecisionAnsweredEvent
  | DecisionAnswerWithdrawnEvent
  | DecisionInfoRequestedEvent
  | WorkspaceLeadChangedEvent
  | WorkspaceRetiredChangedEvent
  | WorkspaceRenamedEvent
  | WorkspaceGoalsChangedEvent
  | WorkspaceParallelismCapChangedEvent
  | AgentAttachedEvent
  | AgentDetachedEvent
  | AgentHeartbeatEvent
  | VoiceRequestEvent;

/* `legacyTriageSidecarPaths` lives in `task-persistence.ts` now, next to
   `tasksSidecarPath` and every other per-workspace path this store owns.
   Re-exported so no caller changes. */
export { legacyTriageSidecarPaths } from './task-persistence.ts';

export type SetLeadAgentResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the named agent already held the seat, and false when the
       *  seat was left alone because a live agent is in it (`declined`). */
      changed: boolean;
      /** Who was in the seat before this call moved it. Absent when nothing
       *  moved or the seat was empty. Reported so a takeover is something the
       *  caller can SEE — `changed: true` alone is the identical answer for
       *  claiming an empty seat and for displacing somebody. */
      previousLeadAgentId?: string;
      /** `lead-held` — a DIFFERENT agent holds the seat and its heartbeat is
       *  fresh, and the caller was claiming the seat for itself without
       *  `takeover`. The request succeeded; the seat did not move. */
      declined?: 'lead-held';
    }
  | { ok: false; error: 'workspace-not-found' }
  | {
      ok: false;
      /** `unknown-lead-agent` — a handover named an id this workspace has no
       *  attachment record of, so every lead-addressed delivery would route
       *  to nobody. `empty-lead-agent-id` — the id trimmed to nothing, which
       *  used to take the seat as ''. */
      error: 'unknown-lead-agent' | 'empty-lead-agent-id' | 'author-required';
      /** The verbatim refusal, naming the id — written to land in a retrying
       *  caller's context, the same contract as `bad-review`. */
      message: string;
    };

export type SetDependenciesResult =
  | {
      ok: true;
      task: Task;
      /** False when the edge set is already exactly this — no write. */
      changed: boolean;
    }
  | {
      ok: false;
      error: 'not-found' | 'unknown-after' | 'unknown-after-enforce' | 'self-dependency';
    }
  | {
      ok: false;
      error: 'cycle';
      /** The ring this edge would close, from the row being written round to
       *  itself, so the refusal can NAME what it refused rather than say the
       *  word "cycle" at somebody. */
      cycle: string[];
      message: string;
    };

export type RenameTaskResult =
  | {
      ok: true;
      task: Task;
      /** False when the new title equals the old one — nothing was written. */
      changed: boolean;
    }
  | { ok: false; error: 'not-found' };

export type SetAssigneeResult =
  | {
      ok: true;
      task: Task;
      /** False when the new assignee equals the old one — no write, no event.
       *  A hand-off to whoever already holds it is not a hand-off. */
      changed: boolean;
    }
  | { ok: false; error: 'not-found' };

/**
 * What a band's archive or restore actually moved.
 *
 * The id list is the point: the caller shows "Archived “Ship W3” and 14
 * tasks", and the number in that sentence is what happened rather than what
 * the confirmation guessed a moment earlier. `changed: false` means the band
 * was already in the state asked for — nothing written, nothing emitted, and
 * the list empty, which is honest rather than a re-listing of rows this call
 * did not touch.
 */
export type ArchiveGoalResult =
  | {
      ok: true;
      goal: GoalRow;
      changed: boolean;
      /** Tasks this call archived (or restored), in board order. */
      taskIds: string[];
    }
  | { ok: false; error: 'not-found' };

export type SetTaskGoalResult =
  | {
      ok: true;
      task: Task;
      /** False when the goal and position both stayed put — a triage confirm.
       *  No task.regrouped fires for it, but the triage stamp still lands. */
      changed: boolean;
    }
  | { ok: false; error: 'not-found' | 'unknown-goal' | 'unknown-after' };

export type SetGoalListResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the new list deep-equals the old — no event, no moves. */
      changed: boolean;
      /** Goals this call CREATED, in submission order, with the id the
       *  server generated for each. The only way a caller learns a new
       *  band's id — which is the point: they never chose it. */
      created: Array<{ id: string; title: string }>;
      /** Open tasks whose goal id disappeared, moved to Backlog —
       *  reported so the caller can re-place them (§3.2 edit contract). */
      movedToChores: string[];
      /** DONE tasks left pointing at a goal id the list no longer has. They
       *  deliberately stay put — a done placement is history, not a claim
       *  about current priorities — but they are what produces the bare
       *  `reorderable: false` row in `get_workspace`, and until this field
       *  existed nothing reported them at all. Re-place them with
       *  `set_task_goal` if you want the row gone. */
      strandedDone: string[];
    }
  | { ok: false; error: 'workspace-not-found' | 'reserved-goal-id' | 'duplicate-goal-id' }
  | {
      ok: false;
      error: 'unknown-goal-id';
      /** Ids the submitted list names that this board does not hold. Either
       *  the caller meant to CREATE (omit the id) or is working from a list
       *  whose bands have since been removed — and inventing the id would be
       *  the re-key this whole scheme exists to make unexpressible. */
      unknownIds: string[];
    }
  | {
      ok: false;
      error: 'would-strand-tasks';
      /** Every goal id the submitted list drops that still holds
       *  tasks, with what it holds. Nothing was written — the caller either
       *  meant a RENAME (use `renameGoal`, which cannot move a task) or
       *  meant the removal, in which case naming these ids in `drop` says so
       *  explicitly. A caller working from a stale read cannot name a goal it
       *  never saw, which is the exact case this refuses. */
      stranding: Array<{ id: string; title: string; openTasks: number; doneTasks: number }>;
    };

/** One live board that shares a name with another — the pair a duplicate
 *  warning is about, trimmed to what identifies it. */
export interface SameNamedWorkspace {
  workspaceId: string;
  name: string;
}

export type SetWorkspaceRetiredResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the board was already in the requested state — no event,
       *  and the original `retiredAt` is left alone rather than restamped. */
      changed: boolean;
    }
  | { ok: false; error: 'workspace-not-found' };

export type RenameWorkspaceResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the trimmed name already matched — no event. */
      changed: boolean;
      /**
       * OTHER live boards that now carry this name. Renaming into a collision
       * is allowed — the operator may be halfway through a cleanup — but it
       * is never silent, because two boards with one name is the whole
       * incident this feature exists for. Absent when there are none;
       * retired boards do not count, since standing one down is the fix.
       */
      sameName?: SameNamedWorkspace[];
    }
  | { ok: false; error: 'workspace-not-found' | 'empty-name' };

export type RenameGoalResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the title (and dueAt) already matched — no event. */
      changed: boolean;
      /** The row as it now stands. */
      goal: { id: string; title: string; dueAt?: number };
    }
  | { ok: false; error: 'workspace-not-found' | 'goal-not-found' | 'reserved-goal-id' };

export type AddGoalResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** The band that now exists, with the id the server minted for it. */
      goal: { id: string; title: string; dueAt?: number };
    }
  | { ok: false; error: 'workspace-not-found' | 'after-not-found' }
  /** The delegated replace refused. Structurally unreachable — the entries are
   *  rebuilt from the live list, so every id named exists, none is reserved or
   *  duplicated, and nothing is dropped — but reported rather than asserted
   *  away, because a silent cast here would turn a future change in
   *  `setGoalList`'s refusal set into a lie about what happened. */
  | { ok: false; error: 'rejected'; cause: string };

export type ReorderGoalsResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when `order` already matched — no event, nothing written. */
      changed: boolean;
      /** The order now in effect at the requested scope. */
      order: string[];
    }
  | { ok: false; error: 'workspace-not-found' | 'parent-not-found' }
  | {
      ok: false;
      error: 'order-mismatch';
      /** Ids in `order` that are not goals at this scope — a goal removed or
       *  renamed since the caller read the list, or simply invented. */
      unknownIds: string[];
      /** Reserved ids the caller tried to position: `chores` today. Split out
       *  of `unknownIds` because they are not mistakes of the same kind —
       *  `chores` is a real, visible row that simply is not part of the
       *  order, so calling it "unknown" sends the caller hunting for a typo
       *  when the answer is "drop it from the list". `get_workspace` marks it
       *  `reorderable: false` for the same reason. */
      reservedIds: string[];
      /** Ids at this scope that `order` left out. These are precisely the
       *  goals `setGoalList` would have emptied into Backlog. */
      missingIds: string[];
      /** Ids repeated within `order`. */
      duplicateIds: string[];
    };

export interface ListTasksFilter {
  goal?: string;
  status?: TaskStatus;
  assignee?: string;
  needs?: 'action' | 'decision';
  /**
   * Include soft-deleted rows. Absent means NO, which is the narrowing every
   * existing caller wanted the day archiving arrived: an archived row leaves
   * the lanes, the queue and the wake without any of those surfaces having to
   * learn a new question.
   *
   * The opt-in exists because a handful of callers legitimately need every
   * row and would be BROKEN by the default — the projection (an archived row
   * still has to reach the browser, or nothing can draw the restore list),
   * the room-file enumerations behind a workspace delete, and the two API
   * verbs a person uses to find what they archived. Each of those passes it
   * explicitly, so the list of readers that can see an archived task is a
   * list you can grep for rather than an absence you have to prove.
   */
  includeArchived?: boolean;
}

export interface WorkspaceState {
  workspace: HubWorkspace;
  tasks: Map<string, Task>;
  /**
   * Goal rows, keyed by goal id — SEPARATE from `tasks`, and that separation
   * is the safety property rather than a filing preference.
   *
   * Goals must not appear in `list_tasks`, `next_tasks` or My Tasks (Bryan,
   * 2026-08-23, reversing the earlier try-it-and-see: *"No don't do this. The
   * tasks need more room to focus on the most important part — the title."*).
   * Enforcing that with a `kind` filter on each reader would be one forgotten
   * call site away from handing an agent a band to implement — and the
   * readers that iterate this store's tasks number in the dozens. A separate
   * map cannot leak, because those readers walk a collection the goal rows
   * are not in.
   */
  goalRows: Map<string, GoalRow>;
  /** agentId → attachment (§4). Keyed per workspace, so the same agentId in
   *  two workspaces is two independent records. */
  attachments: Map<string, AgentAttachment>;
}

/* `tasksSidecarPath` lives in `task-persistence.ts` now, and `eventsLogPath`
   in `task-event-bus.ts`. Re-exported so no caller of either changes. */
export { tasksSidecarPath } from './task-persistence.ts';
export { eventsLogPath } from './task-event-bus.ts';

export class TaskStore {
  // Not `private`: `task-persistence.ts` reads and writes these directly,
  // through the exact same `Map` instances — see `TaskPersistenceHost`.
  workspaces = new Map<string, WorkspaceState>();
  taskIndex = new Map<string, string>(); // taskId → workspaceId
  /** goalId → workspaceId. Deliberately NOT merged into `taskIndex`: that one
   *  is what `getTask` resolves through, and a goal id resolving there would
   *  put goal rows within reach of every task verb by id. */
  goalIndex = new Map<string, string>();
  saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  attachmentSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // Not `private`, for the same reason as the maps above.
  dataDir: string;
  private debounceMs: number;
  attachmentThresholds: AttachmentThresholds;
  deliveryProbe: DeliveryProbe | undefined;
  roster: AgentRoster | undefined;
  readonly voiceAckGraceMs: number;
  readonly commentAckGraceMs: number;
  agentStreamProbe: AgentStreamProbe | undefined;
  /**
   * The doc store's settled `contentRevision` for a docId, wired by server.ts
   * (`rooms.settledContentRevision`). At the STORE rather than per route so
   * every create path — batch, promote, import, the meeting capture — stamps
   * `originDocRevision` without remembering to; a route guard here would be
   * a guarantee for that route's callers only. Left unwired (store-only
   * tests), no stamp happens and no row ever flags, which changes nothing.
   */
  private docRevisionFor: ((docId: string) => number | undefined) | undefined;

  /**
   * The review-item verbs, over this store's own state.
   *
   * It holds no `TaskStore` — only the nine-member `ReviewItemPersistence`
   * built below, which is the whole list of what a review verb may reach.
   * Anything it needs that is not on that list is a deliberate decision to
   * widen the contract, not an autocomplete away.
   */
  private readonly reviewItems = new ReviewItemStore(reviewItemPersistenceFor(this));
  /** The ticket's OWN decision (the derived `r-legacy` row). */
  private readonly decisions = new TaskDecisionStore(reviewItemPersistenceFor(this));
  /** The quality gate's verdicts, on both shapes. */
  private readonly judgements = new ReviewJudgementStore(reviewItemPersistenceFor(this));
  /** Reads across a ticket and a board, plus the judging criteria. */
  private readonly reviewQueries = new ReviewItemQueries(reviewItemPersistenceFor(this));

  /** The goal bands, and this store seen through the contract they need. */
  private readonly goals = new GoalStore(goalPersistenceFor(this));

  /** Attachments and delivery queues, and this store seen through the
   *  contract they need. The probes' defaults are folded in here so
   *  `task-agents.ts` never restates them. */
  private readonly agents = new AgentStore(agentPersistenceFor(this));

  /**
   * The five verb families, each over the narrow slice of this store it may
   * reach — the same seam `ReviewItemStore` / `GoalStore` / `AgentStore` /
   * `WorkspaceStore` already use, applied to the row verbs that used to be
   * methods here. The adapters are written out rather than built by a
   * `…PersistenceFor(this)` helper because each is five or six lines and
   * reading them here is how you see, in one place, exactly what a verb
   * family is allowed to touch.
   */
  private readonly authoring = new TaskAuthoringStore({
    state: (workspaceId) => this.workspaces.get(workspaceId),
    getTask: (taskId) => this.getTask(taskId),
    goalIdExists: (workspace, goalId) => this.goalIdExists(workspace, goalId),
    rosterIdFor: (assignee) => this.rosterIdFor(assignee),
    docRevisionFor: (docId) => this.docRevisionFor?.(docId),
    registerTask: (taskId, workspaceId) => {
      this.taskIndex.set(taskId, workspaceId);
    },
    scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
    emit: (event) => this.emit(event),
  });

  /** Where a row is, and who holds it. */
  private readonly lifecycle = new TaskLifecycleStore({
    state: (workspaceId) => this.workspaces.get(workspaceId),
    getTask: (taskId) => this.getTask(taskId),
    getGoalRow: (goalId) => this.getGoalRow(goalId),
    rosterIdFor: (assignee) => this.rosterIdFor(assignee),
    scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
    emit: (event) => this.emit(event),
  });

  /** Reversible removal, for a row and for a band. */
  private readonly archive = new TaskArchiveStore({
    state: (workspaceId) => this.workspaces.get(workspaceId),
    getTask: (taskId) => this.getTask(taskId),
    getGoalRow: (goalId) => this.getGoalRow(goalId),
    scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
    emit: (event) => this.emit(event),
  });

  /** Dependency edges and cross-references. */
  private readonly links = new TaskLinksStore({
    state: (workspaceId) => this.workspaces.get(workspaceId),
    states: () => this.workspaces.values(),
    getTask: (taskId) => this.getTask(taskId),
    getGoalRow: (goalId) => this.getGoalRow(goalId),
    scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
    transition: (taskId, to, opts) => this.transition(taskId, to, opts),
  });

  /** The quiet records — notes, estimates, artifact checks, reading time. */
  private readonly notes = new TaskNotesStore({
    getTask: (taskId) => this.getTask(taskId),
    scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
    emit: (event) => this.emit(event),
  });

  /** The board registry, and this store seen through the contract it needs.
   *  Same shape as the review-item seam above: a named list of rows and
   *  writers, not a `this` that reaches the whole store. */
  readonly workspaceStore: WorkspaceStore = new WorkspaceStore(workspacePersistenceFor(this));

  /** This store's event bus and audit trail — see `task-event-bus.ts`. */
  private readonly eventBus = new TaskEventBus({
    dataDir: () => this.dataDir,
    attachmentsFor: (workspaceId) => this.workspaces.get(workspaceId)?.attachments,
    noteAgentToolCall: (workspaceId, agentId, at) =>
      this.noteAgentToolCall(workspaceId, agentId, at),
  });

  setDocRevisionReader(reader: ((docId: string) => number | undefined) | undefined): void {
    this.docRevisionFor = reader;
  }

  constructor(opts: {
    dataDir: string;
    debounceMs?: number;
    /** Attachment liveness knobs — overridable so tests never burn real
     *  minutes (§6: delivery timings configurable). */
    heartbeatFreshMs?: number;
    toolCallStaleMs?: number;
    observedWorkFreshMs?: number;
    leadSeatStaleMs?: number;
    /** How long an emitted voice entry is left alone before it is offered
     *  again. Overridable so tests never burn real minutes. */
    voiceAckGraceMs?: number;
    /** Same knob for the comment queue — its own, because the two queues'
     *  semantics must be free to diverge without a shared constant coupling
     *  them. */
    commentAckGraceMs?: number;
  }) {
    this.dataDir = opts.dataDir;
    this.debounceMs = opts.debounceMs ?? 200;
    this.voiceAckGraceMs = opts.voiceAckGraceMs ?? VOICE_ACK_GRACE_MS;
    this.commentAckGraceMs = opts.commentAckGraceMs ?? COMMENT_ACK_GRACE_MS;
    this.attachmentThresholds = {
      ...(opts.heartbeatFreshMs !== undefined ? { heartbeatFreshMs: opts.heartbeatFreshMs } : {}),
      ...(opts.toolCallStaleMs !== undefined ? { toolCallStaleMs: opts.toolCallStaleMs } : {}),
      ...(opts.observedWorkFreshMs !== undefined
        ? { observedWorkFreshMs: opts.observedWorkFreshMs }
        : {}),
      ...(opts.leadSeatStaleMs !== undefined ? { leadSeatStaleMs: opts.leadSeatStaleMs } : {}),
    };
    hydrateTasksFromDisk(this);
  }

  // ── Events + triage delivery ─────────────────────────────────────────────
  //
  // The bus itself lives in `task-event-bus.ts`; what follows forwards onto
  // it. `onEvent` and `emit` keep their signatures because every verb below
  // — and every external subscriber — calls them without knowing emit now
  // crosses a file boundary.

  /** Subscribe to store events; returns the unsubscribe. The SSE transport
   *  and audit log (a later commit) hang off this. */
  onEvent(listener: (event: TaskStoreEvent) => void): () => void {
    return this.eventBus.onEvent(listener);
  }

  /**
   * Wire (or clear) the check for "is anyone on the channel". `server.ts`
   * installs the SSE-hub-backed one; left unwired the store answers yes and
   * behaves exactly as it did before, which is what keeps every store-only
   * test honest without teaching it about a transport.
   */
  setAgentStreamProbe(probe: AgentStreamProbe | undefined): void {
    this.agentStreamProbe = probe;
  }

  setDeliveryProbe(probe: DeliveryProbe | undefined): void {
    this.deliveryProbe = probe;
  }

  /**
   * Wire the fleet's address book (identities.ts). Optional for the same
   * reason the probes are: a store-only test needs no roster, and left
   * unwired every attach and seat claim behaves exactly as it did. With it
   * wired, an attach writes the agent's roster row and a seat claim names
   * the lead by its roster display name rather than by its id.
   */
  setAgentRoster(roster: AgentRoster | undefined): void {
    this.roster = roster;
  }

  /** The roster's id for an owner name, or undefined. The reserved words
   *  are not names: `human` means "a person, unnamed" and `agent` means
   *  nobody, and neither may resolve to a row that happens to be called
   *  that. */
  private rosterIdFor(assignee: string): string | undefined {
    const name = assignee.trim();
    const lower = name.toLowerCase();
    if (name === '' || lower === GENERIC_ASSIGNEE || lower === HUMAN_ASSIGNEE) return undefined;
    return this.roster?.resolveAgentId(name) ?? undefined;
  }

  /** `resolveAgentId` through whatever roster is wired, for readers that
   *  hold an attachment id and need the id a merge folded it into. */
  resolveAgentId(idOrName: string): string | null {
    return this.roster?.resolveAgentId(idOrName) ?? null;
  }

  /**
   * The canonical owner id of a row, resolved NOW.
   *
   * A stored `assigneeId` is re-resolved through the roster so a row written
   * under an id that was later merged away answers with the surviving id;
   * a row with none (written before the field, or under a name the roster
   * did not know at the time) resolves from its name. Undefined for a
   * person, a reserved owner, or a name the roster still cannot place.
   */
  ownerIdOf(task: Pick<Task, 'assignee' | 'assigneeId'>): string | undefined {
    if (task.assigneeId !== undefined) {
      return this.roster?.resolveAgentId(task.assigneeId) ?? task.assigneeId;
    }
    return this.rosterIdFor(task.assignee);
  }

  /**
   * "Does this row belong to `assignee`?" — by the verbatim name, as every
   * filter always matched, OR by resolved id, which is what makes
   * `next_tasks?assignee=<me>` find the rows filed under the other seven
   * spellings of me. The filter's own spelling is resolved once.
   */
  ownerMatcher(assignee: string): (task: Task) => boolean {
    const wantedId = this.rosterIdFor(assignee);
    return (task) =>
      task.assignee === assignee || (wantedId !== undefined && this.ownerIdOf(task) === wantedId);
  }

  /** Every store mutation's event passes through here — audit append, the
   *  observed-work note, then listener fan-out, in that order (§3.6). See
   *  `TaskEventBus.emit` for the order's own reasoning. Not `private`: every
   *  persistence adapter in `task-persistence.ts` emits through this. */
  emit(event: TaskStoreEvent): void {
    this.eventBus.emit(event);
  }

  // ── Workspaces ───────────────────────────────────────────────────────────
  //
  // The board registry itself lives in `workspace-store.ts`; what follows is
  // the store's public surface forwarding onto it. The methods keep their
  // signatures because 35 files import this class and none of them should
  // have to learn that a delete now crosses a file boundary.

  createWorkspace(name: string, opts?: { leadAgentId?: string }): HubWorkspace {
    return this.workspaceStore.createWorkspace(name, opts);
  }

  getWorkspace(id: string): HubWorkspace | undefined {
    return this.workspaceStore.getWorkspace(id);
  }

  openTaskCount(workspaceId: string): number | null {
    return this.workspaceStore.openTaskCount(workspaceId);
  }

  deleteWorkspace(
    workspaceId: string,
    opts?: { force?: boolean },
  ):
    | { ok: true; deletedTasks: number; taskIds: string[] }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'has-open-tasks'; openTasks: number }
    | { ok: false; error: 'persist-failed' } {
    return this.workspaceStore.deleteWorkspace(workspaceId, opts);
  }

  listWorkspaces(): HubWorkspace[] {
    return this.workspaceStore.listWorkspaces();
  }

  setWorkspaceRetired(
    workspaceId: string,
    retired: boolean,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): SetWorkspaceRetiredResult {
    return this.workspaceStore.setWorkspaceRetired(workspaceId, retired, opts);
  }

  renameWorkspace(
    workspaceId: string,
    name: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): RenameWorkspaceResult {
    return this.workspaceStore.renameWorkspace(workspaceId, name, opts);
  }

  setLeadAgent(
    workspaceId: string,
    leadAgentId: string,
    opts: { actor: { id: string; name: string; kind?: string }; takeover?: boolean },
  ): SetLeadAgentResult {
    return this.workspaceStore.setLeadAgent(workspaceId, leadAgentId, opts);
  }

  attachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true } | { ok: false; error: 'workspace-not-found' } {
    return this.workspaceStore.attachDoc(workspaceId, docId);
  }

  detachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true; removed: boolean } | { ok: false; error: 'workspace-not-found' } {
    return this.workspaceStore.detachDoc(workspaceId, docId);
  }

  workspaceOfDoc(docId: string): string | null {
    return this.workspaceStore.workspaceOfDoc(docId);
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(workspaceId: string, opts: CreateTaskOpts): CreateTaskResult {
    return this.authoring.createTask(workspaceId, opts);
  }

  /**
   * Open tasks nobody has named a goal for — what an agent sweeps when it
   * attaches to a workspace that had no attachment when the tasks arrived
   * (§3.4), and the bucket a later "a goal became apparent" re-look reads.
   *
   * Keyed on `unplacedSince`, which replaced the proxy this used to select on
   * ("in Backlog and `triagedAgainst` unset"). That proxy was wrong in BOTH
   * directions, and each was reproduced before the field existed:
   *
   *  - it re-asked forever about a task whose caller explicitly said
   *    `goal: 'chores'` — a placement, per `placement.placed`;
   *  - it never surfaced a task swept into Backlog by a band removal, because
   *    that task KEEPS the `triagedAgainst` of its old placement, pointing at
   *    a goal id that no longer exists.
   *
   * No `goal === chores` clause: the two writers of `unplacedSince` both land
   * the task in Backlog, so the clause would be a second spelling of the same
   * fact — and a future writer that got it wrong would be hidden by it rather
   * than surfaced.
   */
  listUntriaged(workspaceId: string): Task[] {
    return this.listTasks(workspaceId).filter(
      (t) => t.status !== 'done' && t.unplacedSince !== undefined,
    );
  }

  getTask(taskId: string): Task | undefined {
    const wsId = this.taskIndex.get(taskId);
    if (!wsId) return undefined;
    return this.workspaces.get(wsId)?.tasks.get(taskId);
  }

  /** A goal's row. Separate from `getTask` on purpose — see `goalIndex`. */
  getGoalRow(goalId: string): GoalRow | undefined {
    const wsId = this.goalIndex.get(goalId);
    if (!wsId) return undefined;
    return this.workspaces.get(wsId)?.goalRows.get(goalId);
  }

  /**
   * Flush a goal's live body room back into its row — the goal half of
   * `updateBodySnapshot`, and separate from it for the reason `getGoalRow` is
   * separate from `getTask`: a goal row is not a `Task` and the two fields the
   * task path also writes are fields it does not have.
   *
   * No `quote` preservation, because there is nothing to preserve against: the
   * pre-rewrite-words rule exists for tasks born from a dictated capture, a
   * chat message or a promoted comment, and a goal has none of those origins —
   * its prose is written in the room and nowhere else. No `bodyWrittenAt`
   * either; the drift notice it feeds is a TASK staleness signal and inventing
   * a goal-shaped one here would be a field nothing reads.
   *
   * What it keeps is the equality guard, which is load-bearing rather than an
   * optimization: the room seeds from this snapshot on first open, so the seed
   * round-trip flushes back the identical text, and without the guard every
   * board open would stamp `updatedAt` on every goal it had ever described.
   */
  updateGoalBodySnapshot(goalId: string, body: string): boolean {
    const row = this.getGoalRow(goalId);
    if (!row) return false;
    if (row.body === body) return true;
    row.body = body;
    row.updatedAt = Date.now();
    this.scheduleSave(row.workspaceId);
    return true;
  }

  /**
   * The board's CURRENT goal rows, in the goal list's priority order.
   *
   * Filtered against `workspace.goals[]` rather than returning the whole map,
   * because retaining a removed goal's row (see `syncGoalRows`) is a promise
   * about history and not about the board. A retained row keeps whatever
   * `order` it had when it left, so an unfiltered list would interleave bands
   * nobody is working with bands they are — and a caller has no way to tell
   * the two apart from a row alone. Reach a retained row by id with
   * `getGoalRow`, which is deliberately not filtered.
   */
  listGoalRows(workspaceId: string): GoalRow[] {
    const state = this.workspaces.get(workspaceId);
    if (!state) return [];
    const live = new Set(state.workspace.goals.map((g) => g.id));
    return Array.from(state.goalRows.values())
      .filter((row) => live.has(row.id))
      .sort((a, b) => a.order - b.order);
  }

  /**
   * Where a row SPUN OFF A DOC lands — the pointer pill's Create Task and
   * the meeting assistant's captured request — so it is never an unplaced
   * row nobody dispatches.
   *
   * Bryan's report (2026-09-01): "Tasks were created in Backlog and not
   * automatically started — does the lead agent have a chance to
   * automatically assign tickets into the proper goal?" The rows landed in
   * chores, owned by whoever tapped, and the lead's dispatch never saw
   * them. The rule, in order:
   *
   *  1. The goal of the task the doc BELONGS TO (`docId`): a huddle started
   *     for a task links the doc onto that task (`POST /huddles` with
   *     `taskId`, or `link_refs` by hand), and its rows join the task's
   *     band. See `taskHoldingDoc` for what counts as belonging.
   *  2. The board's top ACTIVE goal: the first band in priority order that
   *     is being worked (`todo` / `in-progress` — a `triage` band is a
   *     proposal, a `done` band is history), chores excluded.
   *  3. Chores, when the board has no active band. Placed, still — a row in
   *     chores is on the board and dispatchable; a row in triage is not.
   *
   * The assignee is the board's lead when the seat is held (`leadAgentId`,
   * so the caller sends `assignToLead`); with no lead the row keeps the
   * author, because "unowned at triage" is exactly the unplaced row this
   * exists to prevent. Callers move the row to `todo` after the create.
   */
  placeSpinoff(workspaceId: string, opts: { docId?: string } = {}): SpinoffPlacement | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state) return undefined;
    const lead = state.workspace.leadAgentId;
    const leadPart = lead !== undefined ? { leadAgentId: lead } : {};
    const owner =
      opts.docId !== undefined ? this.taskHoldingDoc(workspaceId, opts.docId) : undefined;
    if (owner?.goal !== undefined) {
      return { goal: owner.goal, rule: 'originating-task', taskId: owner.id, ...leadPart };
    }
    const top = this.listGoalRows(workspaceId).find(
      (row) =>
        row.id !== CHORES_GOAL_ID &&
        !isArchived(row) &&
        (row.status === 'todo' || row.status === 'in-progress'),
    );
    return {
      goal: top?.id ?? CHORES_GOAL_ID,
      rule: top ? 'top-active-goal' : 'chores',
      ...leadPart,
    };
  }

  /**
   * The task a doc BELONGS TO, for placement: the first row on this board
   * (creation order) being worked (`todo` / `in-progress`) whose `links`
   * cite the doc or a thread in it, holding a goal the board still lists.
   * The huddle route writes that link when it is started for a task;
   * `link_refs` writes it by hand.
   *
   * `links` only, not `origin` — a row spun off a line of the doc is the
   * doc's child, not its owner, and reading it as the owner would let the
   * first tap's placement decide every later one. A done or archived row
   * has stopped holding anything; a row at triage is a proposal; a row in
   * chores has no band to lend — Backlog is where the rule ends, never
   * where it starts (Bryan, 2026-09-01).
   */
  private taskHoldingDoc(workspaceId: string, docId: string): Task | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state) return undefined;
    const cites = (r: Ref): boolean =>
      (r.kind === 'doc' || r.kind === 'thread') && r.docId === docId;
    const rows = [...state.tasks.values()]
      .filter(
        (t) =>
          !isArchived(t) &&
          (t.status === 'todo' || t.status === 'in-progress') &&
          t.goal !== undefined &&
          t.goal !== CHORES_GOAL_ID &&
          t.links.some((r) => isValidRef(r) && cites(r)),
      )
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return rows.find((t) => {
      const goal = this.getGoalRow(t.goal ?? '');
      return goal !== undefined && !isArchived(goal) && goal.workspaceId === workspaceId;
    });
  }

  /**
   * Bring `goalRows` into agreement with `workspace.goals[]`.
   *
   * Reconciliation, not a one-shot migration, and it runs on hydrate and after
   * every goal-list write. That shape is what makes it safe to re-run: it
   * mints what is missing and refreshes the fields the LIST owns (title,
   * dueAt, priority order), and it never touches the fields the ROW owns —
   * `status` and `transitions`. A reconcile that rebuilt rows wholesale would
   * clear a declared `done` every time somebody renamed a band, destroying
   * exactly the claim goal status exists to record.
   *
   * It also never REMOVES a row for a goal that left the list. The goal list
   * is an ordinary edit surface and a removal there is not a decision to
   * destroy the record of what somebody declared about that goal; per the
   * project's soft-delete rule the row stays, unreferenced, reachable by id
   * through `getGoalRow` and absent from `listGoalRows`.
   *
   * What retention does NOT give you, stated because the obvious guess is
   * wrong: an undelete. `setGoalList` refuses an id that is not in the current
   * list, so a removed band cannot be re-submitted by id — retyping it mints a
   * fresh id and a fresh open row, and the retained one stays where it is.
   * Measured in `goal-rows.test.ts`. A real restore verb would go through
   * `setGoalList`'s id check and does not exist yet.
   *
   * `mintStatus` is required rather than defaulted, because the two callers
   * that mint want OPPOSITE answers and a default would silently give one of
   * them the other's:
   *
   *  - `setGoalList` mints `triage`. A goal somebody just added is a proposal,
   *    and its band is not dispatched until somebody agrees to it (Bryan,
   *    2026-08-25: "new goals start in triage").
   *  - the hydrate migration mints `todo`. Every board on disk that predates
   *    goal rows re-mints its whole list on the next read, and minting those
   *    `triage` would stop dispatch on every existing board at once — the
   *    bands were agreed to long ago, and a schema migration is not the event
   *    that un-agrees them.
   *
   * `renameGoal` and `reorderGoals` cannot add an id, so they never reach the
   * mint at all; they pass `todo` as the answer that would be right if they
   * somehow did, since a goal already on the list is one somebody placed.
   */
  syncGoalRows(state: WorkspaceState, mintStatus: TaskStatus): void {
    const now = Date.now();
    state.workspace.goals.forEach((g, index) => {
      const existing = state.goalRows.get(g.id);
      if (existing) {
        // The list owns these three; the row owns status and transitions.
        const changed =
          existing.title !== g.title || existing.order !== index || existing.dueAt !== g.dueAt;
        if (changed) {
          existing.title = g.title;
          existing.order = index;
          // Assigned rather than deleted: `JSON.stringify` drops an undefined
          // value, so a cleared due date leaves no key on disk either way.
          existing.dueAt = g.dueAt;
          existing.updatedAt = now;
        }
      } else {
        state.goalRows.set(g.id, {
          id: g.id,
          workspaceId: state.workspace.id,
          kind: 'goal',
          title: g.title,
          ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}),
          order: index,
          // The caller's call, and the one thing about a minted row that is
          // NOT derivable from the goal list — see the `mintStatus` note on
          // this method. Empty trail either way: the record starts here rather
          // than fabricating a history nobody wrote.
          status: mintStatus,
          transitions: [],
          createdAt: now,
          updatedAt: now,
        });
      }
      this.goalIndex.set(g.id, state.workspace.id);
    });
  }

  listTasks(workspaceId: string, filter?: ListTasksFilter): Task[] {
    const state = this.workspaces.get(workspaceId);
    if (!state) return [];
    let tasks = Array.from(state.tasks.values());
    // First, and unconditionally unless asked otherwise: a soft-deleted row is
    // not a row this board is working. See `includeArchived`.
    if (filter?.includeArchived !== true) tasks = tasks.filter((t) => !isArchived(t));
    if (filter?.goal !== undefined) tasks = tasks.filter((t) => t.goal === filter.goal);
    if (filter?.status !== undefined) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter?.assignee !== undefined) tasks = tasks.filter(this.ownerMatcher(filter.assignee));
    if (filter?.needs !== undefined) tasks = tasks.filter((t) => t.needs === filter.needs);
    return tasks.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  transition(
    taskId: string,
    to: TaskStatus,
    opts: {
      actor: { id: string; name: string; kind?: string };
      note?: string;
      usage?: { inputTokens: number; outputTokens: number };
      /** Accepted and IGNORED since 2026-08-18. It carried the human's live
       *  confirmation for a yellow-tier forward move; the risk gate is gone,
       *  but peers on older bundles keep sending this until they restart and
       *  a payload that suddenly fails validation is how a removal breaks
       *  them. Do not turn this into a rejection. */
      confirmed?: boolean;
      /** Accepted and IGNORED since 2026-08-25, on the same terms as
       *  `confirmed` and for the same reason — an older bundle attaches proof
       *  to every forward move and cannot be restarted from here. It is not
       *  recorded, and the transition it lands on carries nothing from it. */
      evidence?: unknown;
    },
  ): TransitionResult {
    return this.lifecycle.transition(taskId, to, opts);
  }

  appendNote(
    taskId: string,
    input: { kind: TaskNote['kind']; text: string; agent: string; ts: number; sessionId?: string },
  ): { ok: true; task: Task; note: TaskNote } | { ok: false; error: 'not-found' } {
    return this.notes.appendNote(taskId, input);
  }

  // ── Review items ─────────────────────────────────────────────────────────

  /**
   * The review-item verbs — the 0..n questions a ticket carries and the one a
   * legacy decision derives — live in `ReviewItemStore` (src/review-items/),
   * over the narrow `ReviewItemPersistence` this store satisfies. What
   * follows is one thin delegate each, so every caller that already addresses
   * them here — the routes, MCP, server.ts, the suites — keeps working while
   * the behaviour has exactly one home.
   */
  answerDecision(
    taskId: string,
    text: string,
    opts: { actor: { id: string; name: string; kind?: string }; optionId?: string },
  ): AnswerDecisionResult {
    return this.decisions.answerDecision(taskId, text, opts);
  }

  withdrawAnswer(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): WithdrawAnswerResult {
    return this.decisions.withdrawAnswer(taskId, opts);
  }

  requestMoreInfo(
    taskId: string,
    question: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** The thread the question was asked on, and the phrase — see
       *  `InfoRequest.threadId`. Present only when the question came in the
       *  review-item way; the typed "tell me more" carries neither. */
      threadId?: string;
      range?: ReviewItemRange;
    },
  ): RequestMoreInfoResult {
    return this.decisions.requestMoreInfo(taskId, question, opts);
  }

  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult {
    return this.reviewItems.addReviewItem(taskId, review, opts);
  }

  listReviewItems(taskId: string): TaskReviewItem[] {
    return this.reviewQueries.listReviewItems(taskId);
  }

  reviewState(taskId: string): ReviewStateCounts | undefined {
    return this.reviewQueries.reviewState(taskId);
  }

  recordReviewJudgement(
    taskId: string,
    reviewItemId: string,
    judgement: ReviewItemJudgement,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /**
       * The words the verdict is ABOUT, as `reviewItemVersion` read them
       * before the judge was asked. A revision that landed while the judge
       * was out makes this verdict stale — it is refused, and the revision's
       * own judgement is the one that stands. Omitted: the caller accepts
       * whatever words are there now.
       */
      forVersion?: number;
      /**
       * The `at` of the `pending` stamp this caller placed before it asked
       * the judge. The verdict is refused unless that exact stamp is still
       * on the row — somebody else has written a verdict since, and theirs
       * is the newer fact.
       *
       * `forVersion` alone does not cover this: a reader overruling the gate
       * releases the item WITHOUT changing its words, so a judge that came
       * back afterwards still matched the version and could re-hold an item
       * the reader had just been told was released (codex review).
       */
      forPendingAt?: number;
    },
  ): RecordReviewJudgementResult {
    return this.judgements.recordReviewJudgement(taskId, reviewItemId, judgement, opts);
  }

  recordDecisionJudgement(
    taskId: string,
    judgement: ReviewItemJudgement,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** `wordsRevisionOf` as this run read it before asking the judge. */
      forVersion?: number;
      /** The `pending` stamp this caller placed — see `recordReviewJudgement`. */
      forPendingAt?: number;
    },
  ): RecordDecisionJudgementResult {
    return this.judgements.recordDecisionJudgement(taskId, judgement, opts);
  }

  reviseTaskDecision(
    taskId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): ReviseTaskDecisionResult {
    return this.decisions.reviseTaskDecision(taskId, patch, opts);
  }

  heldReviewItems(workspaceId: string): HeldReviewItem[] {
    return this.reviewQueries.heldReviewItems(workspaceId);
  }

  reviewItemCriteria(workspaceId: string): ReviewItemCriteriaRead | undefined {
    return this.reviewQueries.reviewItemCriteria(workspaceId);
  }

  setReviewItemCriteria(
    workspaceId: string,
    criteria: string | undefined,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetReviewItemCriteriaResult {
    return this.reviewQueries.setReviewItemCriteria(workspaceId, criteria, opts);
  }

  answerTaskReview(
    taskId: string,
    reviewItemId: string,
    text: string,
    opts: { actor: { id: string; name: string; kind?: string }; answeredWith?: string },
  ): AnswerTaskReviewResult {
    return this.reviewItems.answerTaskReview(taskId, reviewItemId, text, opts);
  }

  requestMoreInfoOnReview(
    taskId: string,
    reviewItemId: string,
    question: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /**
       * The thread the question was asked on, with the phrase it is about,
       * when it was asked doc-style — by selecting words of the item and
       * commenting. Same storage as the typed question, one field richer:
       * that is what makes the item's state derivable from one list rather
       * than reconciled across two.
       */
      threadId?: string;
      range?: ReviewItemRange;
    },
  ): RequestInfoOnReviewResult {
    return this.reviewItems.requestMoreInfoOnReview(taskId, reviewItemId, question, opts);
  }

  reviseReviewItem(
    taskId: string,
    reviewItemId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: {
      actor: { id: string; name: string; kind?: string };
      revisedRange?: { start: number; end: number };
    },
  ): ReviseReviewItemResult {
    return this.reviewItems.reviseReviewItem(taskId, reviewItemId, patch, opts);
  }

  withdrawReviewItem(
    taskId: string,
    reviewItemId: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      reason?: string;
      undo?: boolean;
    },
  ): WithdrawReviewItemResult {
    return this.reviewItems.withdrawReviewItem(taskId, reviewItemId, opts);
  }

  findReviewItem(reviewItemId: string): { taskId: string; workspaceId: string } | undefined {
    return this.reviewQueries.findReviewItem(reviewItemId);
  }

  /** This board's notes home, or undefined (board missing, or none set —
   *  there is deliberately no default: checking notes into a repo is an
   *  opt-in). */
  notesHome(workspaceId: string): WorkspaceNotesHome | undefined {
    return this.workspaces.get(workspaceId)?.workspace.notesHome;
  }

  /**
   * Set — or, with `undefined`, clear — where this board's planning notes
   * get checked in. A settings write, not a board event, the same contract
   * as `setReviewItemCriteria`: the next doc creation reads it. The caller
   * (the settings route) validates the shape; this stores it.
   */
  setNotesHome(
    workspaceId: string,
    home: WorkspaceNotesHome | undefined,
    _opts: { actor: { id: string; name: string; kind?: string } },
  ):
    | { ok: true; workspace: HubWorkspace; notesHome?: WorkspaceNotesHome }
    | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    state.workspace.notesHome = home;
    this.scheduleSave(workspaceId);
    return { ok: true, workspace: state.workspace, ...(home ? { notesHome: home } : {}) };
  }

  /**
   * What this board's ticket-effort scorer weighs: the owner's own text, or
   * the default when nobody has written any. The ONE reader of
   * `HubWorkspace.effortEstimatePrompt`, the same shape and the same
   * reasoning as `reviewItemCriteria` above. `undefined` for a board that
   * does not exist — distinct from a board on the default.
   */
  effortEstimatePrompt(workspaceId: string): { value: string; isDefault: boolean } | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state) return undefined;
    const own = state.workspace.effortEstimatePrompt;
    return own !== undefined && own.trim() !== ''
      ? { value: own, isDefault: false }
      : { value: DEFAULT_EFFORT_ESTIMATE_PROMPT, isDefault: true };
  }

  /**
   * Set — or, with `undefined`/blank, clear back to the default — what this
   * board's effort scorer weighs. A settings write, not a board event, the
   * same contract as `setReviewItemCriteria`: the next scoring run reads it.
   */
  setEffortEstimatePrompt(
    workspaceId: string,
    prompt: string | undefined,
    _opts: { actor: { id: string; name: string; kind?: string } },
  ):
    | { ok: true; workspace: HubWorkspace; prompt: { value: string; isDefault: boolean } }
    | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const next = prompt?.trim();
    if (next === undefined || next === '') state.workspace.effortEstimatePrompt = undefined;
    else state.workspace.effortEstimatePrompt = next;
    this.scheduleSave(workspaceId);
    const read = this.effortEstimatePrompt(workspaceId);
    return {
      ok: true,
      workspace: state.workspace,
      prompt: read ?? { value: DEFAULT_EFFORT_ESTIMATE_PROMPT, isDefault: true },
    };
  }

  /**
   * How many builders this board's lead may dispatch at once: the owner's own
   * number, or `DEFAULT_PARALLELISM_CAP` when nobody has set one. The ONE
   * reader of `HubWorkspace.parallelismCap`, the same shape and reasoning as
   * `reviewItemCriteria` above. `undefined` for a board that does not exist —
   * distinct from a board on the default.
   */
  parallelismCap(workspaceId: string): ParallelismCapRead | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state) return undefined;
    const own = state.workspace.parallelismCap;
    const lastChange = state.workspace.parallelismCapLastChange;
    return {
      ...(own !== undefined
        ? { value: own, isDefault: false }
        : { value: DEFAULT_PARALLELISM_CAP, isDefault: true }),
      ...(lastChange !== undefined ? { lastChange } : {}),
    };
  }

  /**
   * Set — or, with `undefined`, clear back to the default — how many
   * builders this board's lead may dispatch at once. A settings write, not a
   * board event, the same contract as `setReviewItemCriteria`: the next
   * `register_dispatch` call reads it. The caller (the settings route)
   * validates the range; this stores it.
   *
   * Unlike the prompt settings it IS audited: when the effective number
   * moves, the change is stamped on the workspace (`parallelismCapLastChange`)
   * and emitted as `workspace.parallelism_cap_changed`, so the events log
   * keeps every move. A write that leaves the effective cap where it was —
   * setting the default's own number, clearing an unset cap — records
   * nothing: `changed: false` says so, and no phantom "moved" row appears.
   */
  setParallelismCap(
    workspaceId: string,
    cap: number | undefined,
    opts: { actor: { id: string; name: string; kind?: string } },
  ):
    | { ok: true; changed: boolean; workspace: HubWorkspace; parallelismCap: ParallelismCapRead }
    | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const from = state.workspace.parallelismCap ?? DEFAULT_PARALLELISM_CAP;
    const to = cap ?? DEFAULT_PARALLELISM_CAP;
    state.workspace.parallelismCap = cap;
    const changed = from !== to;
    if (changed) {
      const change: ParallelismCapChange = {
        actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
        ts: Date.now(),
        from,
        to,
      };
      state.workspace.parallelismCapLastChange = change;
      this.emit({ type: 'workspace.parallelism_cap_changed', workspaceId, ...change });
    }
    this.scheduleSave(workspaceId);
    const read = this.parallelismCap(workspaceId);
    return {
      ok: true,
      changed,
      workspace: state.workspace,
      parallelismCap: read ?? { value: DEFAULT_PARALLELISM_CAP, isDefault: true },
    };
  }

  recordEffortEstimate(
    taskId: string,
    estimate: TaskEffortEstimate,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' | 'stale' } {
    return this.notes.recordEffortEstimate(taskId, estimate);
  }

  setDependencies(
    taskId: string,
    edges: { after: string[]; afterEnforce?: string[] },
    _opts: { actor: { id: string; name: string; kind?: string } },
  ): SetDependenciesResult {
    return this.links.setDependencies(taskId, edges, _opts);
  }

  renameTask(
    taskId: string,
    title: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): RenameTaskResult {
    return this.authoring.renameTask(taskId, title, opts);
  }

  noteBodyEdited(
    taskId: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** The title this act gives the row. Omit to leave it unchanged. */
      title?: string;
      /** Why the rewriter changed it — rides the audit row verbatim. */
      reason?: string;
    },
  ): boolean {
    return this.authoring.noteBodyEdited(taskId, opts);
  }

  setAssignee(
    taskId: string,
    assignee: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** Declares what the new owner IS. Omitted, the kind is re-derived from
       *  the caller — which for a hand-over to somebody ELSE means it is
       *  CLEARED rather than inherited from the previous owner. Re-stating
       *  the same owner keeps whatever was already declared. */
      assigneeKind?: unknown;
    },
  ): SetAssigneeResult {
    return this.lifecycle.setAssignee(taskId, assignee, opts);
  }

  setDueAt(
    taskId: string,
    dueAt: number | null,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    return this.lifecycle.setDueAt(taskId, dueAt, opts);
  }

  clearLegacyPark(taskId: string): LegacyParkFields | null {
    return this.lifecycle.clearLegacyPark(taskId);
  }

  archiveTask(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): SetAssigneeResult {
    return this.archive.archiveTask(taskId, opts);
  }

  unarchiveTask(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    return this.archive.unarchiveTask(taskId, opts);
  }

  goalCascade(goalId: string): { taskIds: string[] } {
    return this.archive.goalCascade(goalId);
  }

  archiveGoal(
    goalId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): ArchiveGoalResult {
    return this.archive.archiveGoal(goalId, opts);
  }

  unarchiveGoal(
    goalId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): ArchiveGoalResult {
    return this.archive.unarchiveGoal(goalId, opts);
  }

  // ── Goal bands ───────────────────────────────────────────────────────────
  //
  // The bands themselves live in `task-goals.ts`; what follows is the store's
  // public surface forwarding onto them, signatures unchanged.

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
    return this.goals.setTaskGoal(taskId, goal, opts);
  }

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
    return this.goals.setGoalList(workspaceId, entries, opts);
  }

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
    return this.goals.renameGoal(workspaceId, goalId, patch, opts);
  }

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
    return this.goals.addGoal(workspaceId, patch, opts);
  }

  reorderGoals(
    workspaceId: string,
    order: string[],
    opts: { parent?: string; actor: { id: string; name: string; kind?: string } },
  ): ReorderGoalsResult {
    return this.goals.reorderGoals(workspaceId, order, opts);
  }
  updateBodySnapshot(taskId: string, body: string): boolean {
    return this.authoring.updateBodySnapshot(taskId, body);
  }

  recordArtifactCheck(
    taskId: string,
    result: ArtifactCheck,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    return this.notes.recordArtifactCheck(taskId, result);
  }

  recordReadingTime(
    taskId: string,
    deltaSeconds: number,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    return this.notes.recordReadingTime(taskId, deltaSeconds);
  }

  setReadingTime(
    taskId: string,
    readingTime: TaskReadingTime,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    return this.notes.setReadingTime(taskId, readingTime);
  }

  // ── Cross-references (§3.2 Ref; §3.12 commit 4) ──────────────────────────
  //
  // Links are stored on the task; backlinks are COMPUTED on read, never
  // stored, so the two directions can't drift. NOTE: link changes emit no
  // store event — §3.6's exhaustive table has no row for them — so the route
  // layer refreshes the ydoc projection by hand, the same pattern as
  // createWorkspace/attachDoc.

  linkRef(taskId: string, ref: Ref): LinkRefResult {
    return this.links.linkRef(taskId, ref);
  }

  linkGoalRef(
    goalId: string,
    ref: Ref,
  ):
    | { ok: true; goal: GoalRow; changed: boolean }
    | { ok: false; error: 'not-found' | 'bad-ref' | 'self-ref' } {
    return this.links.linkGoalRef(goalId, ref);
  }

  unlinkRef(taskId: string, ref: Ref): UnlinkRefResult {
    return this.links.unlinkRef(taskId, ref);
  }

  backlinksFor(ref: Ref): Task[] {
    return this.links.backlinksFor(ref);
  }

  tasksReferencingDoc(docId: string): Task[] {
    return this.links.tasksReferencingDoc(docId);
  }

  tasksReferencingThread(docId: string, threadId: string): Task[] {
    return this.links.tasksReferencingThread(docId, threadId);
  }

  flagStaleFromDocEdit(docIds: string[], revision: number): Set<string> {
    return this.links.flagStaleFromDocEdit(docIds, revision);
  }

  releasePlanHolds(
    docIds: string[],
    actor: { id: string; name: string; kind?: string },
  ): { released: string[]; workspaceIds: Set<string> } {
    return this.links.releasePlanHolds(docIds, actor);
  }

  /* REMOVED 2026-08-18 (Bryan): `riskRefusal`, the §3.4 risk arm of the gate.
     A red task refused an agent's forward move outright and a yellow one
     required `confirmed: true` on the request. His call, and his reasoning:
     "when to ask a human" already lives in the fleet's own skills, so this was
     a second mechanism for one judgement — and the gate had fired exactly
     twice on his board, both yellow, both on `→ done`.

     Three things deliberately NOT done with it, each with a reason:
      - `confirmed` and `riskTier` are still ACCEPTED on the wire and ignored.
        Peers keep sending them from older bundles until each one restarts, and
        narrowing what old callers send is where a removal actually bites (see
        "Removing an MCP tool cannot break a peer" in learnings.md).
      - `task.gate_refused` keeps its event type below and its `describeEvent`
        case in the client. Nothing emits it again, but rows already in
        `events.jsonl` still have to render as sentences rather than as a bare
        slug.
      - Persisted `riskTier` values are left alone. Nothing reads them; a
        migration that rewrote everyone's rows would be the riskier change. */

  goalIdExists(workspace: HubWorkspace, goalId: string): boolean {
    if (isReservedGoalId(goalId)) return true;
    return workspace.goals.some((g) => g.id === goalId);
  }

  // ── Agent attachments (§4) ───────────────────────────────────────────────
  //
  // Attachments, the lead seat and the two delivery queues live in
  // `task-agents.ts`; what follows is the store's public surface forwarding
  // onto it, signatures unchanged.

  mergeAgent(
    from: string,
    into: string,
    opts: { actor: { id: string; name: string; kind?: string }; dryRun?: boolean },
  ): { seats: string[]; seatsSkipped: string[]; attachments: string[]; comments: string[] } {
    return this.agents.mergeAgent(from, into, opts);
  }

  attachAgent(
    workspaceId: string,
    opts: {
      agentId: string;
      /** The display name the session runs under (`CW_AGENT_NAME`). Written
       *  to the roster so every surface names this agent the same way; an
       *  older bundle sends none and attaches under its id. */
      agentName?: string;
      runtime: AttachmentRuntime;
      capabilities?: string[];
      endpoint?: string;
      pluginVersion?: string;
      processId?: string;
    },
  ): AttachAgentResult {
    return this.agents.attachAgent(workspaceId, opts);
  }

  recordVoiceRequest(
    workspaceId: string,
    req: {
      transcript: string;
      route: VoiceRoute;
      ack: string;
      context?: unknown;
      /** The queue row this utterance was written to. The receiving agent
       *  acknowledges it, which is what takes the row off the queue. */
      queueId?: string;
      actor: { id: string; name: string; kind?: string };
    },
  ): boolean {
    return this.agents.recordVoiceRequest(workspaceId, req);
  }

  queueVoiceRequest(
    workspaceId: string,
    item: {
      transcript: string;
      context?: unknown;
      actor: { id: string; name: string; kind?: string };
      applied?: string;
    },
  ): string | false {
    return this.agents.queueVoiceRequest(workspaceId, item);
  }

  listQueuedVoice(workspaceId: string): QueuedVoiceRequest[] {
    return this.agents.listQueuedVoice(workspaceId);
  }

  markVoiceEmitted(workspaceId: string, id: string): boolean {
    return this.agents.markVoiceEmitted(workspaceId, id);
  }

  ackVoiceRequest(workspaceId: string, id: string): boolean {
    return this.agents.ackVoiceRequest(workspaceId, id);
  }

  queueComment(
    workspaceId: string,
    item: {
      agentId: string;
      docId: string;
      threadId?: string;
      event: string;
      author: { id: string; name: string };
      text: string;
      payload?: unknown;
    },
  ): string | false {
    return this.agents.queueComment(workspaceId, item);
  }

  listQueuedComments(workspaceId: string): QueuedComment[] {
    return this.agents.listQueuedComments(workspaceId);
  }

  markCommentEmitted(workspaceId: string, id: string): boolean {
    return this.agents.markCommentEmitted(workspaceId, id);
  }

  clearCommentEmitted(workspaceId: string, id: string): boolean {
    return this.agents.clearCommentEmitted(workspaceId, id);
  }

  ackComment(workspaceId: string, id: string): boolean {
    return this.agents.ackComment(workspaceId, id);
  }

  heartbeat(workspaceId: string, agentId: string, opts?: { toolCallAt?: number }): HeartbeatResult {
    return this.agents.heartbeat(workspaceId, agentId, opts);
  }

  noteAgentToolCall(workspaceId: string, agentId: string, at?: number): boolean {
    return this.agents.noteAgentToolCall(workspaceId, agentId, at);
  }

  detachAgent(workspaceId: string, agentId: string): boolean {
    return this.agents.detachAgent(workspaceId, agentId);
  }

  listAttachments(workspaceId: string): DescribedAttachment[] {
    return this.agents.listAttachments(workspaceId);
  }

  listPublicAttachments(workspaceId: string): PublicAttachment[] {
    return this.agents.listPublicAttachments(workspaceId);
  }

  hasLiveAttachment(workspaceId: string): boolean {
    return this.agents.hasLiveAttachment(workspaceId);
  }

  hasLiveLeadAttachment(workspaceId: string): boolean {
    return this.agents.hasLiveLeadAttachment(workspaceId);
  }

  leadSeatHealth(workspaceId: string, now = Date.now()): LeadSeatHealth {
    return this.agents.leadSeatHealth(workspaceId, now);
  }

  hasLiveAttachmentFor(workspaceId: string, agentId: string): boolean {
    return this.agents.hasLiveAttachmentFor(workspaceId, agentId);
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Flush every pending debounced write synchronously (tests, shutdown). */
  flush(): void {
    for (const [workspaceId, timer] of this.saveTimers) {
      clearTimeout(timer);
      this.persist(workspaceId);
    }
    this.saveTimers.clear();
    for (const [workspaceId, timer] of this.attachmentSaveTimers) {
      clearTimeout(timer);
      this.persistAttachments(workspaceId);
    }
    this.attachmentSaveTimers.clear();
  }

  /** Flush and stop — after this the store schedules nothing. */
  stop(): void {
    this.flush();
  }

  scheduleSave(workspaceId: string): void {
    const prev = this.saveTimers.get(workspaceId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.saveTimers.delete(workspaceId);
      this.persist(workspaceId);
    }, this.debounceMs);
    // Never hold the process (or a test runner) open.
    timer.unref?.();
    this.saveTimers.set(workspaceId, timer);
  }

  scheduleAttachmentsSave(workspaceId: string): void {
    const prev = this.attachmentSaveTimers.get(workspaceId);
    if (prev) clearTimeout(prev);
    const timer = setTimeout(() => {
      this.attachmentSaveTimers.delete(workspaceId);
      this.persistAttachments(workspaceId);
    }, this.debounceMs);
    timer.unref?.();
    this.attachmentSaveTimers.set(workspaceId, timer);
  }

  /** Attachments get their own sidecar so heartbeat churn never rewrites the
   *  task data. Empty registry → the file is removed (private-meta pattern:
   *  nothing sensitive left on disk when nothing is attached). See
   *  `task-persistence.ts`. */
  private persistAttachments(workspaceId: string): void {
    persistAttachmentsSidecar(this, workspaceId);
  }

  /** Write this workspace's task-row sidecar. See `task-persistence.ts`. */
  private persist(workspaceId: string): void {
    persistWorkspaceTasks(this, workspaceId);
  }
}
