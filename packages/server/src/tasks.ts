import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  type ReviewItemJudgement,
  type ReviewItemRange,
  type ReviewPayload,
  type TaskReviewItem,
  agentIdCandidates,
  agentIdForName,
} from '@feedback/core';
import { DEFAULT_EFFORT_ESTIMATE_PROMPT } from '@feedback/core/effort-estimate-prompt';
import {
  type ArtifactCheck,
  type DecisionOption,
  type GoalListEntry,
  type Ref,
  TASK_NOTES_STORE_CAP,
  type Task,
  type TaskActor,
  type TaskEffortEstimate,
  type TaskNote,
  type TaskReadingTime,
  type TaskStatus,
  type TaskTransition,
  isTaskStatus,
} from '@feedback/core/task-wire';
import { classifyActor } from './activity.ts';
import {
  type DecisionShapeGap,
  checkDecisionShape,
  decisionShapeMessage,
} from './decision-shape.ts';
import { TaskDecisionStore } from './review-items/decisions.ts';
import { ReviewJudgementStore } from './review-items/judgements.ts';
import type { ReviewItemPersistence } from './review-items/persistence.ts';
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
import { bumpWordsRevision, cryptoId, isArchived, wordsRevisionOf } from './task-fields.ts';
import {
  type DeclaredOwnerKind,
  GENERIC_ASSIGNEE,
  HUMAN_ASSIGNEE,
  declaredAssigneeKind,
} from './task-owner.ts';
import { bodyHead } from './task-title.ts';

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

import {
  CHORES_GOAL_ID,
  GoalStore,
  type GoalStorePersistence,
  isReservedGoalId,
} from './task-goals.ts';

export {
  CHORES_GOAL_ID,
  RESERVED_GOAL_IDS,
  isReservedGoalId,
  newGoalId,
  sequenceAfter,
} from './task-goals.ts';

import {
  AgentStore,
  type AgentStorePersistence,
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
  attachmentsSidecarPath,
  commentQueuePath,
  voiceQueuePath,
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
  type WorkspaceStorePersistence,
  isRetired,
  normalizeWorkspaceName,
  retiredNotice,
  retiredRefusal,
} from './workspace-store.ts';

export { isRetired, normalizeWorkspaceName, retiredNotice, retiredRefusal };

/* Pure per-row facts, lifted to a leaf module so the review-item store can
   share them without importing this file. */
export { isArchived, taskAskedBy, wordsRevisionOf } from './task-fields.ts';

/** Schemes a `url` ref may carry. A ref is rendered as a clickable chip, so
 *  the value becomes an href — `javascript:` and `data:` are script injection
 *  and `file:` reads the host. Every other kind is an internal id and cannot
 *  express a scheme at all, which is why this check has no analogue there. */
function isSafeHttpUrl(value: string): boolean {
  // No trimming first, deliberately: a leading space would make `new URL`
  // parse `  javascript:…` fine in some runtimes, and a caller sending
  // padded input is not a caller whose padding we should silently fix.
  if (value !== value.trim()) return false;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  // `URL.protocol` is already lowercased by the parser, so a mixed-case
  // scheme can't slip past this comparison.
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/** Structural validity of a caller-supplied Ref: known kind, every field a
 *  non-empty string. Existence of the target is deliberately NOT checked
 *  (same stance as createTask's `links`): a dangling annotation is visible
 *  and harmless, where a dangling `after` edge would silently never block.
 *  `url` is the one kind with a value constraint beyond non-emptiness — not
 *  because we check that it resolves (we don't, same stance) but because it
 *  is the only kind that reaches the DOM as an href. */
export function isValidRef(ref: unknown): ref is Ref {
  if (typeof ref !== 'object' || ref === null) return false;
  const r = ref as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  switch (r.kind) {
    case 'doc':
      return str(r.docId);
    case 'thread':
      return str(r.docId) && str(r.threadId);
    case 'task':
      return str(r.taskId);
    case 'diff':
      return str(r.workspaceId);
    case 'url':
      return str(r.url) && isSafeHttpUrl(r.url);
    default:
      return false;
  }
}

/** Canonical identity of a Ref — two refs are the same link iff their keys
 *  match. Field order can't leak in (each kind lists its fields explicitly). */
export function refKey(ref: Ref): string {
  switch (ref.kind) {
    case 'doc':
      return `doc|${ref.docId}`;
    case 'thread':
      return `thread|${ref.docId}|${ref.threadId}`;
    case 'task':
      return `task|${ref.taskId}`;
    case 'diff':
      return `diff|${ref.workspaceId}`;
    case 'url':
      // Identity IS the URL string — that is what makes "which tasks point at
      // this pull request" answerable. No normalisation (no case folding, no
      // trailing-slash trimming): two spellings of the same page staying
      // distinct is a missed grouping, whereas collapsing two genuinely
      // different URLs would merge unrelated work.
      return `url|${ref.url}`;
  }
}

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

/**
 * A goal list as it may arrive from OUTSIDE — a payload written before
 * subgoals were removed, or a workspace on disk that still holds them.
 *
 * Subgoals are gone from the product (Bryan, 2026-08-30: *"We no longer
 * support subgoals. If there's any code left for subgoals remove it"*), but
 * a stored board is not rewritten by that decision. `flattenNestedGoals` is
 * the one door such a payload comes through, and every one of them arrives
 * flat on the other side.
 */
export interface NestedGoalInput {
  id: string;
  title: string;
  dueAt?: number;
  subgoals?: NestedGoalInput[];
}

/**
 * Splice any nested goals into the top level, each one landing directly after
 * the parent that held it.
 *
 * That position is not a choice: the board has drawn subgoals as flat rows in
 * exactly this order all along, so a flattened list looks like the board the
 * reader already had. Depth beyond one level was never written, but the walk
 * is recursive anyway — a payload that has it should still load rather than
 * lose rows.
 */
export function flattenNestedGoals(goals: readonly NestedGoalInput[]): WorkspaceGoal[] {
  const out: WorkspaceGoal[] = [];
  const walk = (list: readonly NestedGoalInput[]) => {
    for (const g of list) {
      out.push({ id: g.id, title: g.title, ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}) });
      if (g.subgoals?.length) walk(g.subgoals);
    }
  };
  walk(goals);
  return out;
}

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

/** How long a park or archive reason may run. A reason is a line on a chip and
 *  a line in the audit trail, not a place to restate the ticket. */
const REASON_MAX = 200;

/** Trimmed, capped, and `undefined` when there is nothing left — so an empty
 *  string never becomes a reason the board renders as a blank chip title. */
function normalizeReason(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().slice(0, REASON_MAX).trim();
  return text === '' ? undefined : text;
}

/**
 * The status a create lands on: `triage` when an AGENT filed it, `todo` when
 * a person did.
 *
 * `classifyActor` is the same line the transition trail and `assigneeKind`
 * already draw, reused rather than reinvented — a second predicate for
 * person-or-agent is a second thing that can disagree with the first.
 *
 * The one place this deliberately departs from it is the ABSENT actor.
 * `classifyActor` resolves "declares nothing" to `agent`, and that direction
 * is right where it lives (it keeps a person out of a strip built to stay
 * short). Here the same direction would take a row OUT of every dispatch read
 * on the strength of an absence — work silently missing, with nothing
 * anywhere saying so. Every creation ROUTE resolves an author before it gets
 * here (task-owner.ts), so the only caller this covers is a direct in-process
 * create that named nobody, and leaving that visible is the safe half.
 *
 * A GOAL row never comes through here — `syncGoalRows` mints those, and it
 * decides their status on a different rule (who is adding versus migrating,
 * not person versus agent). A new goal does start in `triage`, but that is
 * that method's answer, not this one's.
 */
export function initialTaskStatus(
  actor: { id: string; name: string; kind?: string } | undefined,
): TaskStatus {
  return actor !== undefined && classifyActor(actor) === 'agent' ? 'triage' : 'todo';
}

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

/**
 * Whether a row is a goal. The ONE place the discriminator is read, so an
 * absent `kind` resolves to "task" in exactly one spot rather than at every
 * call site — see the field's note on Task.
 */
export function isGoalRow(row: { kind?: 'task' | 'goal' }): row is GoalRow & { kind: 'goal' } {
  return row.kind === 'goal';
}

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

export type AttachmentRuntime = 'claude-code-local' | 'managed-agent' | 'webhook';

const ATTACHMENT_RUNTIMES: ReadonlySet<string> = new Set([
  'claude-code-local',
  'managed-agent',
  'webhook',
]);

export function isAttachmentRuntime(v: unknown): v is AttachmentRuntime {
  return typeof v === 'string' && ATTACHMENT_RUNTIMES.has(v);
}

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

/**
 * Sidecars the REMOVED triage-request flow used to queue undelivered asks in:
 * the workspace-level north-star re-triage (`.retriage.json`), the "a band
 * appeared, re-look at the bucket" ask (`.bucket.json`), and the lead's
 * task-review queue (`.taskreviews.json`).
 *
 * Nothing reads or writes any of them any more — the lead is woken by the
 * events that already reach it, so there is no bespoke ask to park. They
 * survive as names only so `deleteWorkspace` keeps sweeping the files up: a
 * board deleted after this change would otherwise leave sidecars behind that
 * nothing on the box can reach or explain. Deleting queue bookkeeping is not
 * a soft-delete concern (CLAUDE.md: "the rule is about user content and
 * history"); these files hold neither.
 */
export function legacyTriageSidecarPaths(dataDir: string, workspaceId: string): string[] {
  const dir = join(dataDir, 'workspaces');
  return [
    join(dir, `${workspaceId}.retriage.json`),
    join(dir, `${workspaceId}.bucket.json`),
    join(dir, `${workspaceId}.taskreviews.json`),
  ];
}

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

/** Where a workspace's sidecar lives. Exported so tests assert the real
 *  contract path rather than a re-implementation of it. */
export function tasksSidecarPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.tasks.json`);
}

/** Where a workspace's append-only event audit log lives (plan §3.6: "the
 *  event log is the audit trail"). Exported so tests assert the real path. */
export function eventsLogPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.events.jsonl`);
}

export class TaskStore {
  private workspaces = new Map<string, WorkspaceState>();
  private taskIndex = new Map<string, string>(); // taskId → workspaceId
  /** goalId → workspaceId. Deliberately NOT merged into `taskIndex`: that one
   *  is what `getTask` resolves through, and a goal id resolving there would
   *  put goal rows within reach of every task verb by id. */
  private goalIndex = new Map<string, string>();
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private attachmentSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dataDir: string;
  private debounceMs: number;
  private attachmentThresholds: AttachmentThresholds;
  private deliveryProbe: DeliveryProbe | undefined;
  private roster: AgentRoster | undefined;
  private readonly voiceAckGraceMs: number;
  private readonly commentAckGraceMs: number;
  private agentStreamProbe: AgentStreamProbe | undefined;
  private eventListeners = new Set<(event: TaskStoreEvent) => void>();
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
  private readonly reviewItems = new ReviewItemStore(this.reviewItemPersistence());
  /** The ticket's OWN decision (the derived `r-legacy` row). */
  private readonly decisions = new TaskDecisionStore(this.reviewItemPersistence());
  /** The quality gate's verdicts, on both shapes. */
  private readonly judgements = new ReviewJudgementStore(this.reviewItemPersistence());
  /** Reads across a ticket and a board, plus the judging criteria. */
  private readonly reviewQueries = new ReviewItemQueries(this.reviewItemPersistence());

  /** This store, seen through the review-item contract and nothing more. */
  private reviewItemPersistence(): ReviewItemPersistence {
    return {
      getTask: (taskId) => this.getTask(taskId),
      listTasksIn: (workspaceId) => this.workspaces.get(workspaceId)?.tasks.values() ?? [],
      listWorkspaceIds: () => this.workspaces.keys(),
      getWorkspaceRecord: (workspaceId) => this.workspaces.get(workspaceId)?.workspace,
      save: (workspaceId) => this.scheduleSave(workspaceId),
      emit: (event) => this.emit(event),
      now: () => Date.now(),
      noteBodyEdited: (taskId, opts) => this.noteBodyEdited(taskId, opts),
      renameTask: (taskId, title, opts) => this.renameTask(taskId, title, opts),
    };
  }

  /** The goal bands, and this store seen through the contract they need. */
  private readonly goals = new GoalStore(this.goalPersistence());

  private goalPersistence(): GoalStorePersistence {
    return {
      state: (workspaceId) => this.workspaces.get(workspaceId),
      states: () => this.workspaces.values(),
      getTask: (taskId) => this.getTask(taskId),
      goalIdExists: (workspace, goalId) => this.goalIdExists(workspace, goalId),
      syncGoalRows: (state, mintStatus) => this.syncGoalRows(state, mintStatus),
      scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
      emit: (event) => this.emit(event),
    };
  }

  /** Attachments and delivery queues, and this store seen through the
   *  contract they need. The probes' defaults are folded in here so
   *  `task-agents.ts` never restates them. */
  private readonly agents = new AgentStore(this.agentPersistence());

  private agentPersistence(): AgentStorePersistence {
    const store = this;
    return {
      dataDir: () => this.dataDir,
      state: (workspaceId) => this.workspaces.get(workspaceId),
      states: () => this.workspaces.values(),
      hasWorkspace: (workspaceId) => this.workspaces.has(workspaceId),
      get thresholds() {
        return store.attachmentThresholds;
      },
      get voiceAckGraceMs() {
        return store.voiceAckGraceMs;
      },
      get commentAckGraceMs() {
        return store.commentAckGraceMs;
      },
      roster: () => this.roster,
      agentStreamProbe: (workspaceId, agentId) =>
        this.agentStreamProbe?.(workspaceId, agentId) ?? false,
      deliveryProbe: (workspaceId) => this.deliveryProbe?.(workspaceId) ?? true,
      saveAttachments: (workspaceId) => this.scheduleAttachmentsSave(workspaceId),
      listUntriaged: (workspaceId) => this.listUntriaged(workspaceId),
      assignLead: (state, leadAgentId, actor, ts) =>
        this.workspaceStore.assignLead(state, leadAgentId, actor, ts),
      emit: (event) => this.emit(event),
    };
  }

  /** The board registry, and this store seen through the contract it needs.
   *  Same shape as the review-item seam above: a named list of rows and
   *  writers, not a `this` that reaches the whole store. */
  private readonly workspaceStore = new WorkspaceStore(this.workspacePersistence());

  private workspacePersistence(): WorkspaceStorePersistence {
    return {
      state: (workspaceId) => this.workspaces.get(workspaceId),
      states: () => this.workspaces.values(),
      register: (workspaceId, state) => {
        this.workspaces.set(workspaceId, state);
      },
      forget: (workspaceId) => {
        this.workspaces.delete(workspaceId);
      },
      forgetRows: (taskIds, goalIds) => {
        for (const taskId of taskIds) this.taskIndex.delete(taskId);
        for (const goalId of goalIds) this.goalIndex.delete(goalId);
      },
      scheduleSave: (workspaceId) => this.scheduleSave(workspaceId),
      scheduleAttachmentsSave: (workspaceId) => this.scheduleAttachmentsSave(workspaceId),
      cancelPendingSaves: (workspaceId) => {
        const pending = this.saveTimers.get(workspaceId);
        if (pending) clearTimeout(pending);
        this.saveTimers.delete(workspaceId);
        const pendingAttachments = this.attachmentSaveTimers.get(workspaceId);
        if (pendingAttachments) clearTimeout(pendingAttachments);
        this.attachmentSaveTimers.delete(workspaceId);
        return { tasks: pending !== undefined, attachments: pendingAttachments !== undefined };
      },
      removeTasksSidecar: (workspaceId) => {
        try {
          rmSync(tasksSidecarPath(this.dataDir, workspaceId), { force: true });
          return true;
        } catch (err) {
          console.error(`[tasks] failed to remove the tasks sidecar for ${workspaceId}:`, err);
          return false;
        }
      },
      removeSidecars: (workspaceId) => {
        // The list is every OTHER per-workspace path this file exports; a new
        // sidecar belongs here the day it is added, or it becomes a file
        // nothing can reach.
        for (const path of [
          attachmentsSidecarPath(this.dataDir, workspaceId),
          eventsLogPath(this.dataDir, workspaceId),
          voiceQueuePath(this.dataDir, workspaceId),
          commentQueuePath(this.dataDir, workspaceId),
          ...legacyTriageSidecarPaths(this.dataDir, workspaceId),
        ]) {
          try {
            rmSync(path, { force: true });
          } catch (err) {
            console.error(`[tasks] failed to remove ${path}:`, err);
          }
        }
      },
      getTask: (taskId) => this.getTask(taskId),
      getGoalRow: (goalId) => this.getGoalRow(goalId),
      hasLiveLeadAttachment: (workspaceId) => this.hasLiveLeadAttachment(workspaceId),
      emit: (event) => this.emit(event),
    };
  }

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
    this.hydrateFromDisk();
  }

  // ── Events + triage delivery ─────────────────────────────────────────────

  /** Subscribe to store events; returns the unsubscribe. The SSE transport
   *  and audit log (a later commit) hang off this. */
  onEvent(listener: (event: TaskStoreEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
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

  /**
   * Every emitted board change is also EVIDENCE that its author was alive at
   * that moment, so the work clock moves here rather than at ~20 call sites.
   *
   * The call-site version of this is what failed: `noteAgentToolCall` shipped
   * with no caller at all and sat unused, because "remember to also record
   * liveness" is exactly the kind of step that gets forgotten. At the choke
   * point it cannot be — a new route that emits is observed for free.
   *
   * Two things it deliberately does NOT do:
   *  - `agent.*` events never count. A heartbeat asserting work is what
   *    collapsed the two clocks into one and made `unresponsive` unreachable;
   *    `attachAgent` sets both clocks itself and needs no help here.
   *  - A person's edit never moves an agent's clock. The actor is resolved
   *    against the attachment roster, and a name that matches nothing is a
   *    no-op.
   */
  private noteObservedWork(event: TaskStoreEvent): void {
    if (event.type.startsWith('agent.')) return;
    const { workspaceId } = event;
    const attachments = this.workspaces.get(workspaceId)?.attachments;
    if (!attachments || attachments.size === 0) return;
    const actor = (event as { actor?: { id?: unknown; name?: unknown } }).actor;
    if (!actor) return;
    // Match on every spelling a roster could hold. The event's actor id and
    // the attachment key demonstrably disagree in the field — `live-feedback`
    // against `agent-live-feedback` on the same session — so matching one
    // spelling matches roughly none of the fleet.
    const candidates = new Set<string>();
    for (const raw of [actor.id, actor.name]) {
      if (typeof raw !== 'string') continue;
      candidates.add(raw.trim().toLowerCase());
      for (const c of agentIdCandidates(raw)) candidates.add(c);
    }
    if (candidates.size === 0) return;
    for (const agentId of attachments.keys()) {
      if (!candidates.has(agentId.trim().toLowerCase())) continue;
      // Through the public method rather than touching the field, so there
      // is exactly one definition of "the agent was observed working" — and
      // so that method finally has the production caller whose absence is
      // the whole reason the clock never moved.
      this.noteAgentToolCall(workspaceId, agentId, event.ts);
      return;
    }
  }

  private emit(event: TaskStoreEvent): void {
    // Audit FIRST, at the emit choke point: "an event was emitted" and "the
    // audit log has it" are the same fact by construction (§3.6), so the log
    // can never disagree with what subscribers saw.
    this.appendAudit(event);
    this.noteObservedWork(event);
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[tasks] event listener threw:', err);
      }
    }
  }

  /** Append one JSON line to the per-workspace events.jsonl. Shaped exactly
   *  like the SSE payload (`event` key, not `type`) so the two records are
   *  the same bytes-modulo-transport. Synchronous append — an event either
   *  reaches both the log and the listeners, or (I/O failure, logged loudly)
   *  the listeners still fire: delivery beats bookkeeping. */
  private appendAudit(event: TaskStoreEvent): void {
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const { type, ...rest } = event;
      appendFileSync(
        eventsLogPath(this.dataDir, event.workspaceId),
        `${JSON.stringify({ event: type, ...rest })}\n`,
      );
    } catch (err) {
      console.error('[tasks] failed to append audit event:', err);
    }
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
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    // A retired board takes no new work. Checked before anything else is
    // validated so the caller gets the reason it can act on rather than a
    // goal-id complaint about a board it should not be filing to at all.
    if (isRetired(state.workspace)) {
      return { ok: false, error: 'workspace-retired', message: retiredRefusal(state.workspace) };
    }

    const goal = opts.goal ?? CHORES_GOAL_ID;
    if (!this.goalIdExists(state.workspace, goal)) {
      return { ok: false, error: 'unknown-goal' };
    }
    // Dangling `after` edges would silently never block (the gate skips ids
    // it can't resolve), so refuse them at creation where the caller can fix
    // the reference.
    // Deduped for the same reason `setTaskDependencies` dedupes: `openBlockers`
    // walks this array, so a repeated id is a second visit to one task and the
    // reader is told twice that the same thing blocks them. Batch-local refs
    // are what make that reachable by accident — `"#warm"` and the index of the
    // row that declared it are two spellings of ONE edge, so a caller can write
    // the duplicate without repeating themselves.
    const after = [...new Set(opts.after ?? [])];
    for (const dep of after) {
      if (!state.tasks.has(dep)) return { ok: false, error: 'unknown-after' };
    }
    // `afterEnforce` is a SUBSET of `after`: openBlockers walks `after` and
    // consults afterEnforce only as a lookup set, so an id in one array and
    // not the other is never visited and hard-blocks NOTHING. Refusing beats
    // quietly widening `after`, which would change the blocker list the
    // caller sees without saying so.
    const afterEnforce = [...new Set(opts.afterEnforce ?? [])];
    for (const dep of afterEnforce) {
      if (!after.includes(dep)) return { ok: false, error: 'unknown-after-enforce' };
    }

    // ── Decision shape ────────────────────────────────────────────────────
    // Options only mean something where an answer can be recorded from them,
    // so they belong to `needs: 'decision'` and nowhere else — accepting them
    // on an action task would store a control nothing can operate.
    const rawOptions = opts.options ?? [];
    if (rawOptions.length > 0 && opts.needs !== 'decision') {
      return { ok: false, error: 'options-need-decision' };
    }
    for (const o of rawOptions) {
      if (typeof o?.label !== 'string' || o.label.trim().length === 0) {
        return { ok: false, error: 'bad-option', message: 'every option needs a non-empty label' };
      }
    }
    const options: DecisionOption[] = rawOptions.map((o) => ({
      id: cryptoId('o'),
      label: o.label.trim(),
      ...(o.detail !== undefined ? { detail: o.detail } : {}),
    }));

    // The gate this whole feature rests on: a decision nobody can decide from
    // is worse than no decision task, because it LOOKS answerable. Refuse the
    // one thing that makes it unanswerable — no question — and report the
    // rest. Applied in the STORE so promote_to_task is held to it too; the
    // route is the layer that would otherwise quietly not check.
    let shapeGaps: DecisionShapeGap[] | undefined;
    if (opts.needs === 'decision') {
      const check = checkDecisionShape(opts.body, options);
      if (!check.ok) {
        return {
          ok: false,
          error: 'decision-body-required',
          message: decisionShapeMessage(check),
        };
      }
      shapeGaps = check.gaps;
    }

    const now = Date.now();
    // Where the row came from, as a revision it can later be measured
    // against. Asked of the injected reader HERE — the one place every
    // create path converges — and settled on the reader's side, so words
    // typed just before this create stamp the post-edit revision rather
    // than flagging the row they produced.
    const originDocId =
      opts.origin !== undefined && (opts.origin.kind === 'doc' || opts.origin.kind === 'thread')
        ? opts.origin.docId
        : undefined;
    const originDocRevision =
      originDocId !== undefined ? this.docRevisionFor?.(originDocId) : undefined;
    const assigneeKind = declaredAssigneeKind(opts.assignee ?? '', opts.assigneeKind, opts.actor);
    const assigneeId = this.rosterIdFor(opts.assignee ?? 'agent');
    const inGoal = Array.from(state.tasks.values()).filter((t) => t.goal === goal);
    const order = opts.order ?? Math.max(0, ...inGoal.map((t) => t.order)) + 1;
    const task: Task = {
      id: cryptoId('t'),
      workspaceId,
      title: opts.title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      // The last-resort default. Every creation ROUTE resolves a real owner
      // before it gets here (task-owner.ts), so this only covers a direct
      // in-process call that named nobody.
      assignee: opts.assignee ?? 'agent',
      ...(assigneeKind !== undefined ? { assigneeKind } : {}),
      ...(assigneeId !== undefined ? { assigneeId } : {}),
      ...(opts.needs !== undefined ? { needs: opts.needs } : {}),
      ...(options.length > 0 ? { options } : {}),
      goal,
      order,
      // A plan draft is triage WHOEVER filed it: the batch declared its rows
      // drafts of an unapproved plan, and a person's rows are not exempt from
      // their own declaration. `fileToTriage` is the same shape of claim made
      // about the row's CONTENT rather than its provenance.
      status:
        opts.planHold !== undefined || opts.fileToTriage === true
          ? 'triage'
          : initialTaskStatus(opts.actor),
      after,
      ...(afterEnforce.length > 0 ? { afterEnforce } : {}),
      ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
      links: opts.links ?? [],
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.planHold !== undefined ? { planHold: opts.planHold } : {}),
      ...(originDocRevision !== undefined ? { originDocRevision } : {}),
      ...(opts.quote !== undefined ? { quote: opts.quote } : {}),
      transitions: [],
      createdAt: now,
      // The display name, like every other projected `by` (§3.3 visitor
      // contract). An author-less create (the routes predate the field)
      // stamps nothing rather than the bare word "agent".
      ...(opts.actor?.name ? { createdBy: opts.actor.name } : {}),
      updatedAt: now,
    };
    state.tasks.set(task.id, task);
    this.taskIndex.set(task.id, workspaceId);
    // Through the choke point like every other write of a title, so a created
    // row carries the same marks a renamed one does. Without this a task
    // would be measured for staleness against a body-head nobody ever
    // recorded, and the head clause would be dead for the whole life of every
    // task that was never renamed — which is most of them.
    this.applyTitle(task, task.title);
    // The create is the ONE title write that is not a naming: it stamps the
    // placeholder. Flagged after the choke point, which clears the flag on
    // every write it sees, so the create is the only door that can set it.
    if (opts.untitled) task.untitled = true;

    // An OMITTED goal means "needs placing": the task lands at the bottom of
    // Backlog (the resting state; the human is never blocked on placement)
    // and records that it is waiting. An explicit goal — even an explicit
    // 'chores' — is a placement by the caller and stamps nothing.
    //
    // The record is DURABLE and nothing else is. The server used to also
    // emit a `triage.requested` ask at this moment and mark the row pending
    // against whether it was delivered; that flow is gone (2026-08-24). The
    // lead learns a row needs placing from the events it already receives —
    // `task.created` on the workspace channel while it is attached, and the
    // `untriaged` list in its next attach payload otherwise — so a marker
    // grounded in one in-flight send bought nothing a restart did not erase.
    if (opts.goal === undefined) task.unplacedSince = now;

    this.scheduleSave(workspaceId);
    this.emit({
      type: 'task.created',
      workspaceId,
      taskId: task.id,
      task,
      goal: task.goal,
      assignee: task.assignee,
      ...(task.triagedAgainst !== undefined ? { triagedAgainst: task.triagedAgainst } : {}),
      ...(opts.actor !== undefined
        ? {
            actor: {
              id: opts.actor.id,
              name: opts.actor.name,
              kind: classifyActor(opts.actor),
            },
          }
        : {}),
      ts: now,
    });
    return {
      ok: true,
      task,
      placement: { placed: opts.goal !== undefined },
      ...(shapeGaps !== undefined ? { shapeGaps } : {}),
    };
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
  private syncGoalRows(state: WorkspaceState, mintStatus: TaskStatus): void {
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

  /**
   * The single gate for status changes (§3.10). Every change is attributed
   * (`classifyActor` decides person vs agent — the same line the reply-reopens
   * rule draws, reused rather than reinvented) and appended to the task's
   * audit trail.
   *
   * Gate semantics, in order:
   *  - unknown task / unknown status / no-op same-status → validation errors.
   *  - a GOAL row holds `triage` on the same terms a task does, and this gate
   *    is the only door into it. It used to be refused here
   *    (`goal-not-triageable`) on the reasoning that triage is a claim about a
   *    TASK and a goal is "neither filed by an agent nor dispatched". The
   *    second half was wrong: a band is dispatched transitively, because every
   *    task in it inherits its priority — so an un-agreed band hands its rows
   *    to a dispatcher on the strength of an agreement nobody made. Triage on
   *    a goal closes that one level up, and `buildQueue` is where it bites.
   *  - moving FORWARD (to in-progress or done) consults `after`: open
   *    dependencies come back as `blockers` in the result; an edge marked
   *    enforce refuses outright. Moving back to todo never consults the gate
   *    (undoing work must not be blockable).
   *  - moving OUT of triage is not a special case and gets no special verb:
   *    it is an ordinary move, attributed like any other, and the trail entry
   *    the gate already writes (`from: 'triage'`, plus who and when) IS the
   *    record that somebody vetted the row. `to: 'todo'` is a backward move
   *    and therefore unblockable; `to: 'in-progress'` is forward and consults
   *    `after` like any other forward move, which is correct — starting work
   *    a dependency holds back is the thing that gate exists to stop.
   *  - there is no longer a risk arm. `riskTier` gated an agent's forward
   *    move (red refused, yellow needed `confirmed: true`) until 2026-08-18;
   *    the reasoning for removing it, and what is deliberately still accepted
   *    on the wire, is in the note where `riskRefusal` used to be.
   */
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
    // Resolves a goal row as readily as a task, which is the whole of what
    // this feature needed on the wire: a goal moves through THIS gate, so
    // `POST /api/tasks/:id/transition` already reaches one and no new
    // shared-server route had to be added for old bundles to miss.
    const task = this.findRow(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isTaskStatus(to)) return { ok: false, error: 'bad-status' };
    if (task.status === to) {
      return {
        ok: false,
        error: 'same-status',
        message: `${task.title} is already ${to}. Nothing to do — a status change is the only thing this gate records, and the row is already there.`,
      };
    }

    // A plan draft may not leave triage by ANY door — that is the whole of
    // what the hold means. The release is the plan's approval
    // (`POST /api/docs/:id/plan`), which clears the hold and moves the row
    // itself; archiving stays available (it is not a status). Goals never
    // carry the field, so `isGoalRow` rows pass untouched.
    if (!isGoalRow(task) && task.planHold !== undefined) {
      return {
        ok: false,
        error: 'plan-unapproved',
        message:
          `${task.title} is a draft derived from a plan doc (${task.planHold.docId}) that has not been approved. ` +
          'It stays in triage until the plan is approved — which releases it — or the row is archived.',
      };
    }

    const forward = to === 'in-progress' || to === 'done';
    // A task's open dependencies; a goal's open children. Different question,
    // same answer shape, and deliberately the same advisory/enforcing split
    // rather than a second notion of blocked.
    const blockers = forward
      ? isGoalRow(task)
        ? this.openChildren(task)
        : this.openBlockers(task)
      : [];
    const enforced = blockers.filter((b) => b.enforce);
    if (enforced.length > 0) {
      return { ok: false, error: 'blocked', blockers };
    }

    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // The risk arm of the gate used to sit here — see the note where
    // `riskRefusal` was, below `openBlockers`. `opts.confirmed` is still read
    // off the wire and deliberately goes nowhere: older peers keep sending it.
    const entry: TaskTransition = {
      ts: Date.now(),
      from: task.status,
      to,
      by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    };
    task.transitions.push(entry);
    task.status = to;
    task.updatedAt = entry.ts;
    this.scheduleSave(task.workspaceId);

    this.emit({
      type: 'task.transitioned',
      workspaceId: task.workspaceId,
      taskId: task.id,
      ...(isGoalRow(task) ? { kind: 'goal' as const } : {}),
      from: entry.from,
      to,
      actor: by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
      ts: entry.ts,
    });
    return { ok: true, task, blockers };
  }

  /**
   * Pin an agent's one-liner to a row. No status change and no gate: the
   * note records what the session said or was refused, not where the row
   * is. Bounded at `TASK_NOTES_STORE_CAP` from the old end, emitted as
   * `task.noted` so the board re-projects, the audit log has it, and the
   * actor's work clock moves — but NOT broadcast on the workspace stream
   * (server.ts keeps it off), because one frame per turn would wake every
   * other attached agent.
   */
  appendNote(
    taskId: string,
    input: { kind: TaskNote['kind']; text: string; agent: string; ts: number; sessionId?: string },
  ): { ok: true; task: Task; note: TaskNote } | { ok: false; error: 'not-found' } {
    // Tasks only: `resolveNoteTarget` never hands this a goal row, and a
    // goal's trail is its children's, not a session's one-liners.
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const note: TaskNote = {
      ts: input.ts,
      kind: input.kind,
      text: input.text,
      agent: input.agent,
      ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    };
    const notes = task.notes ?? [];
    notes.push(note);
    if (notes.length > TASK_NOTES_STORE_CAP) notes.splice(0, notes.length - TASK_NOTES_STORE_CAP);
    task.notes = notes;
    const now = Date.now();
    task.updatedAt = now;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.noted',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: agentIdForName(input.agent), name: input.agent, kind: 'agent' },
      kind: note.kind,
      text: note.text,
      ts: now,
    });
    return { ok: true, task, note };
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

  /**
   * Record one scoring run's read on a ticket — a produced estimate or a
   * recorded failure. Quiet like `recordReadingTime`: no store event, no
   * `updatedAt` bump, and for the same class of reason — a score is
   * metadata ABOUT the ticket, not an edit OF it — plus one that reading
   * time does not have: scoring itself is triggered off `task.created` /
   * `task.retitled` / `task.body_edited` (server.ts), so a write here that
   * emitted one of those would re-trigger its own scorer forever.
   *
   * Refused as `stale` when the words (or the goal) this run read are no
   * longer the ticket's current words: `estimate.forWordsRevision` must
   * still equal the row's `wordsRevision`. Guards against a slow call
   * landing after a NEWER edit — or a re-triage to a different goal, which
   * changes the goal title the scorer weighed — already started (or
   * finished) its own re-score: that newer run's answer must stand, not be
   * overwritten by a late answer to older words or an old goal.
   *
   * ONE token, and a monotonic one. This used to compare the three
   * timestamps the estimate still carries — `forTitleWrittenAt` /
   * `forBodyWrittenAt` / `forGoal` against `titleWrittenAt` /
   * `bodyWrittenAt` / `goal` — and a millisecond is not fine enough to
   * separate a create from the rename that follows it: land both in one
   * tick and the older run's captured token still equals the row's current
   * one, the guard reads "not stale", and the stale answer wins. See
   * `forWordsRevision`. The timestamps are kept on the record as
   * provenance a person reads; they are no longer asked a question they
   * cannot answer.
   *
   * A record that somehow carries no revision at all compares `undefined`
   * against a number and is REFUSED, which is the safe direction: an
   * estimate whose provenance cannot be established must not overwrite one
   * whose provenance can.
   */
  recordEffortEstimate(
    taskId: string,
    estimate: TaskEffortEstimate,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' | 'stale' } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (estimate.forWordsRevision !== wordsRevisionOf(task)) {
      return { ok: false, error: 'stale' };
    }
    task.effortEstimate = estimate;
    this.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  /**
   * Replace a task's dependency edges after it was created.
   *
   * This did not exist, and its absence is what made urgency underivable:
   * "this decision is blocking work now" is the same fact as "something
   * depends on it", `after` already records that, and `after` could only ever
   * be set at creation — when the decision being waited on often doesn't
   * exist yet. Every decision on the real board therefore had an empty
   * `after`, and nothing could tell blocking from merely deferred.
   *
   * Replaces rather than appends, so an edge can be REMOVED — a dependency
   * that turned out not to exist is exactly as misleading as a missing one.
   * No store event fires (§3.6's table has no row for it), so the route
   * refreshes the projection by hand, the same contract as renameTask.
   */
  setDependencies(
    taskId: string,
    edges: { after: string[]; afterEnforce?: string[] },
    _opts: { actor: { id: string; name: string; kind?: string } },
  ): SetDependenciesResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const state = this.workspaces.get(task.workspaceId);
    if (!state) return { ok: false, error: 'not-found' };

    const after = [...new Set(edges.after)];
    for (const dep of after) {
      // Self first: `state.tasks.has(task.id)` is true, so a self-edge would
      // pass the existence check and then block the task on itself forever.
      if (dep === taskId) return { ok: false, error: 'self-dependency' };
      // Same workspace only — a cross-workspace id resolves in `getTask` but
      // not in this board's `tasks` map, so the gate would skip it silently.
      if (!state.tasks.has(dep)) return { ok: false, error: 'unknown-after' };
    }
    const afterEnforce = [...new Set(edges.afterEnforce ?? [])];
    for (const dep of afterEnforce) {
      if (!after.includes(dep)) return { ok: false, error: 'unknown-after-enforce' };
    }

    const same =
      task.after.length === after.length &&
      task.after.every((d) => after.includes(d)) &&
      (task.afterEnforce ?? []).length === afterEnforce.length &&
      (task.afterEnforce ?? []).every((d) => afterEnforce.includes(d));
    if (same) return { ok: true, task, changed: false };

    task.after = after;
    if (afterEnforce.length > 0) task.afterEnforce = afterEnforce;
    else task.afterEnforce = undefined;
    task.updatedAt = Date.now();
    this.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * THE CHOKE POINT for "this row got a name" — the ONLY assignment of
   * `task.title` in the store, and every door into a title converges on it.
   *
   * There were three assignment sites before this: the `createTask` object
   * literal, `renameTask`, and `noteBodyEdited`. Seven doors sit above them
   * (`create_tasks` single and batch, `promote_to_task`,
   * `import_tasks_markdown`, the board's inline rename, `rewrite_task`,
   * and `set_doc_content` on a `task:<id>` room), and no two of them share a
   * reading — `parseTaskCreate` fronts two, promote and import build their
   * own. So a title standard enforced at any one door would be a guarantee
   * for that door's callers only, which is exactly how the `quote`
   * preservation came to be skipped by the one caller that mattered.
   *
   * What it stamps is the pair of marks a reviewer reads a rename against:
   * WHEN the row was named, and WHAT the description said at the time. Both
   * reset here and nowhere else, so "the title has been re-authored" has one
   * writer and cannot disagree with itself. The marks are part of the
   * capture record — the soft-delete guarantee — not a format check.
   *
   * Deliberately NOT a validator. Nothing is refused, rewritten, or
   * normalized on the way through — the standard's judgment lives in the
   * lead's reviewing pass, which the row's own `task.created` /
   * `task.retitled` / `task.body_written` event is what summons — so a raw
   * capture still lands.
   */
  private applyTitle(task: Task, title: string): void {
    // A named row is no longer untitled — UNCONDITIONALLY. A person naming
    // the row is the signal, whatever text they gave; the placeholder
    // literal is never compared against. This used to clear only when the
    // text differed from the stored title, and an unnamed row's stored
    // title IS the placeholder, so naming it "Untitled task" kept the flag
    // — and a flagged row's rename box shows blank, so it could never be
    // named again. The create (the one write that is a stamp, not a naming)
    // flags the row after this returns.
    task.untitled = undefined;
    task.title = title;
    task.titleWrittenAt = Date.now();
    task.titleHead = bodyHead(task.body);
    bumpWordsRevision(task);
  }

  /**
   * Rename a task — the board's in-place title edit (§3.9: tap the title
   * text, Enter commits). No event fires: §3.6's exhaustive table has no
   * task.renamed row, so callers (the route) must refresh the projection by
   * hand, the same pattern as attachDoc and a triage confirm-in-place.
   */
  renameTask(
    taskId: string,
    title: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): RenameTaskResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    // A same-text rename is a no-op — UNLESS the row is unnamed, where the
    // stored title is only the placeholder and the write is the person
    // naming it. That write must reach the choke point to clear the flag.
    if (task.title === title && !task.untitled) return { ok: true, task, changed: false };
    const titleFrom = task.title;
    this.applyTitle(task, title);
    const ts = Date.now();
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    // Naming an unnamed row with its own placeholder text changed the flag,
    // not the title: nothing to retitle in the feed.
    if (titleFrom === task.title) return { ok: true, task, changed: true };
    // Attributed, with both ends: after a rename the old title — the only
    // name the person who filed the row would recognise — survives nowhere
    // else on the board. “changed: false” returns above emit nothing.
    this.emit({
      type: 'task.retitled',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      titleFrom,
      titleTo: task.title,
      ...(opts.reason ? { reason: opts.reason } : {}),
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Record that somebody replaced a task's description — and, when the same
   * act gave the row a new title, retitle it here rather than in a second
   * call. The markdown itself lives in the `task:<id>` doc room and reaches
   * this store as a snapshot, so this does not take it; what this provides is
   * the half `set_doc_content` on the body room never could (a doc edit knows
   * nothing about tasks): an attributed audit row, the body clock, the
   * preserved original, and the title.
   *
   * The title rides along because SHAPING is one act. A capture arrives with a
   * machine-clipped fragment for a title and its whole utterance for a body,
   * and triage turns both into a task worth picking up; splitting that across
   * `/title` (which deliberately emits nothing — it is the board's inline
   * edit) and `/body` would leave the half a reader most notices invisible in
   * the activity feed. Passing no `title` leaves the title alone, so every
   * existing caller keeps its meaning.
   *
   * This does NOT preserve the row's prior words — `updateBodySnapshot` does,
   * at the choke point every writer of a body passes through. It used to
   * happen here, taking the pre-rewrite title and body as a required
   * parameter so a new call site could not quietly skip it. That guard worked
   * exactly as far as it could reach and no further: `set_doc_content` on the
   * `task:<id>` room never called this method at all, so it destroyed the
   * capture with nothing preserved and nothing recorded, and the caller and
   * the board both saw success. A parameter can only bind the callers who
   * call you. So `quote` now has ONE writer, sitting where the body actually
   * changes, and this method is left with the half only a route can do:
   * saying WHO, and when.
   *
   * The predicate over there is `quote` being empty and NOTHING else. The
   * obvious second clause — "and this row has never been rewritten", i.e.
   * `bodyWrittenAt === undefined` — is unusable and looks correct:
   * `updateBodySnapshot` stamps `bodyWrittenAt` on every real body change, so
   * the clause is false by the time anything downstream reads it. It silently
   * preserved nothing, ever. Emptiness of `quote` is the honest question
   * anyway — "does anything hold this row's own words yet".
   */
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
    const task = this.getTask(taskId);
    if (!task) return false;
    const ts = Date.now();
    const titleFrom = task.title;
    const nextTitle = opts.title?.trim();
    // An unnamed row's stored title is the placeholder; a shaping pass that
    // hands back the same text is still the row being named.
    if (nextTitle && (nextTitle !== titleFrom || task.untitled)) this.applyTitle(task, nextTitle);
    task.updatedAt = ts;
    task.bodyWrittenAt = ts;
    bumpWordsRevision(task);
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.body_edited',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      // Both ends, only when the title actually moved. A reader of the trail
      // needs the old one to recognise the row they filed: "rewrote X" says
      // nothing when X is a title they have never seen.
      ...(task.title !== titleFrom ? { titleFrom, titleTo: task.title } : {}),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ts,
    });
    return true;
  }

  /**
   * Hand a task to someone else — 'human', 'agent', or a named identity.
   * Emits `task.assigned` (§3.6) with BOTH ends, because the reviewable fact
   * is the direction of the hand-off. Deliberately does NOT touch status:
   * re-assigning is not progress, and conflating the two would let a hand-off
   * slip past the transition gate.
   */
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
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const from = task.assignee;
    const declared = declaredAssigneeKind(assignee, opts.assigneeKind, opts.actor);
    // Re-stating the SAME owner without saying what they are must not erase
    // what somebody already declared. Every caller that predates this field
    // sends no `assigneeKind`, so without this an ordinary re-assign would
    // silently downgrade a declared person to "not recorded" — a write that
    // changes nothing a caller asked to change. A hand-over to a DIFFERENT
    // name still clears it: the new owner's kind is genuinely unknown, and
    // inheriting the old one would assert something nobody said.
    const kind = declared ?? (from === assignee ? task.assigneeKind : undefined);
    // A kind-only change is a real change. Without the second clause,
    // declaring that the person who already holds this task IS a person
    // would be swallowed as a no-op, and the one call that closes the gap
    // for an existing row would do nothing while answering ok:true.
    if (from === assignee && task.assigneeKind === kind) return { ok: true, task, changed: false };
    const ts = Date.now();
    task.assignee = assignee;
    // Re-resolved from the NEW name, never carried over: the previous
    // owner's id on a row handed to somebody the roster cannot place would
    // keep routing their queue reads to the old owner.
    const assigneeId = this.rosterIdFor(assignee);
    if (assigneeId === undefined) task.assigneeId = undefined;
    else task.assigneeId = assigneeId;
    if (kind === undefined) task.assigneeKind = undefined;
    else task.assigneeKind = kind;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.assigned',
      workspaceId: task.workspaceId,
      taskId: task.id,
      from,
      to: assignee,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Set, move, or clear a task's due date.
   *
   * Bryan, 2026-08-18: *"All fields must be human editable. But I expect
   * they'll be mostly set by agents going forward. Trust but verify… sometimes
   * having me edit a thing is the fastest way to fix."* `dueAt` was writable
   * only at creation, so the detail panel rendered a field nobody could
   * correct — the same gap `setAssignee` closed for the owner.
   *
   * `null` clears. An unchanged value returns `changed: false` and emits
   * nothing: a repaint that re-sends the date already on the row is not an
   * edit, and an audit row saying so is noise in every feed.
   */
  setDueAt(
    taskId: string,
    dueAt: number | null,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const from = task.dueAt ?? null;
    if (from === dueAt) return { ok: true, task, changed: false };
    const ts = Date.now();
    if (dueAt === null) task.dueAt = undefined;
    else task.dueAt = dueAt;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.due_set',
      workspaceId: task.workspaceId,
      taskId: task.id,
      from,
      to: dueAt,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Drop the two fields a row carried while `parked` was a state, once the
   * startup migration has lifted them into a comment.
   *
   * The ONLY writer of `LegacyParkFields`, and it only ever unsets them. The
   * park metadata is not destroyed by this call — the comment the migration
   * wrote is where it now lives, which is what makes the clear safe to run
   * and what keeps the project's never-hard-delete rule true for it.
   *
   * Returns what it cleared, so the caller can report a migration honestly
   * rather than counting rows it hoped it touched.
   */
  clearLegacyPark(taskId: string): LegacyParkFields | null {
    const task = this.getTask(taskId) as (Task & LegacyParkFields) | undefined;
    if (!task) return null;
    const had: LegacyParkFields = {
      ...(task.parkedUntil !== undefined ? { parkedUntil: task.parkedUntil } : {}),
      ...(task.parkedReason !== undefined ? { parkedReason: task.parkedReason } : {}),
    };
    if (had.parkedUntil === undefined && had.parkedReason === undefined) return null;
    // Assignment rather than `delete` (biome noDelete); JSON.stringify drops
    // an undefined-valued key entirely, so the sidecar comes back without it.
    task.parkedUntil = undefined;
    task.parkedReason = undefined;
    this.scheduleSave(task.workspaceId);
    return had;
  }

  /**
   * Take a row off the board, reversibly — the SOFT delete, and the only
   * removal this store offers a task.
   *
   * Three fields and one event. Nothing moves, nothing is rewritten, and the
   * id keeps resolving through `getTask`, which is what lets the task's body
   * room, its comment threads and every `after` edge pointing at it go on
   * working while it is gone from the lanes. `unarchiveTask` clears the same
   * three fields, so a restore has nothing to reconstruct and no half-state to
   * crash in.
   *
   * Idempotent by construction: archiving an archived row reports
   * `changed: false` and emits nothing, the same rule `setDueAt` and
   * `parkTask` follow. A re-send that produced an audit row would put a line
   * in the trail for a decision nobody made twice. Note what this costs — a
   * reason cannot be EDITED by re-archiving; restore and archive again, which
   * is honest, because the second reason is a second decision.
   */
  archiveTask(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): SetAssigneeResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (isArchived(task)) return { ok: true, task, changed: false };
    const ts = Date.now();
    const reason = normalizeReason(opts.reason);
    task.archivedAt = ts;
    task.archivedBy = opts.actor.name;
    task.archiveReason = reason;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.archived',
      workspaceId: task.workspaceId,
      taskId: task.id,
      title: task.title,
      ...(reason !== undefined ? { reason } : {}),
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /** Put an archived row back. The undo half, and the reason the archive is
   *  safe to reach for: everything it did was three field writes. */
  unarchiveTask(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isArchived(task)) return { ok: true, task, changed: false };
    const ts = Date.now();
    // The reason is read BEFORE it is cleared — the restored event carries it
    // so the pair reads as one story in the trail.
    const reason = task.archiveReason;
    // Assignment rather than `delete` (biome noDelete); JSON.stringify drops
    // an undefined from the sidecar, which is what keeps a row that was never
    // archived free of the keys entirely.
    task.archivedAt = undefined;
    task.archivedBy = undefined;
    task.archiveReason = undefined;
    // The cascade marker goes with them. A row put back by hand is no longer
    // part of the band's archive, so restoring that band later must not claim
    // it a second time — and archiving the band again re-stamps it anyway.
    task.archivedWithGoal = undefined;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.restored',
      workspaceId: task.workspaceId,
      taskId: task.id,
      title: task.title,
      ...(reason !== undefined ? { reason } : {}),
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
      ts,
    });
    return { ok: true, task, changed: true };
  }

  /**
   * Every row a goal's archive would take with it: the band itself, and every
   * task standing under it that is not already archived.
   *
   * Public because the CONFIRMATION needs it before the write. "Archive this
   * goal and its 14 tasks?" is the whole point of the dialog — the blast
   * radius is the part a reader cannot see from a band header — and a count
   * the client derived for itself would be a second implementation of this
   * walk, free to disagree with the one that actually runs.
   *
   * Already-archived rows are deliberately absent: the cascade does not touch
   * them, so counting them would promise a removal that does not happen, and
   * — worse — the restore would then bring back a row somebody had put away
   * on its own.
   *
   * What the board shows under the band is what goes — nothing off it.
   */
  goalCascade(goalId: string): { taskIds: string[] } {
    const empty = { taskIds: [] };
    const row = this.getGoalRow(goalId);
    if (!row) return empty;
    const state = this.workspaces.get(row.workspaceId);
    if (!state) return empty;
    const taskIds = Array.from(state.tasks.values())
      .filter((t) => t.goal === goalId && !isArchived(t))
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map((t) => t.id);
    return { taskIds };
  }

  /**
   * Take a BAND off the board, reversibly, with everything standing under it.
   *
   * The cascade is the decision (Bryan, 2026-08-30: archiving a goal archives
   * its tasks too). The alternative — archive the band and leave its tasks
   * behind — either strands them under a header nobody can see or silently
   * dumps them into Backlog, and both are a bigger surprise than the one the
   * reader asked for. Soft on every row it touches, so the whole gesture is
   * still nothing but field writes, and `unarchiveGoal` is still a field
   * clear.
   *
   * Each cascaded row is stamped with `archivedWithGoal`, which is what makes
   * the restore exact rather than a guess from `task.goal` — see the field.
   *
   * Events: the band's own `task.archived` carries `kind: 'goal'`, the
   * `batchId` and the task count; every member carries `partOf: batchId`. The
   * trail therefore reads as one decision with its consequences attached
   * rather than as fifteen unexplained removals, and a per-row feed still
   * gets the line it needs. Same shape `workspace.goals_changed` already uses
   * for the moves a goal-list edit fans out.
   *
   * Idempotent, like `archiveTask`: re-archiving an archived band reports
   * `changed: false`, writes nothing and emits nothing.
   */
  archiveGoal(
    goalId: string,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): ArchiveGoalResult {
    const goal = this.getGoalRow(goalId);
    if (!goal) return { ok: false, error: 'not-found' };
    if (isArchived(goal)) return { ok: true, goal, changed: false, taskIds: [] };
    const { taskIds } = this.goalCascade(goalId);
    const ts = Date.now();
    const reason = normalizeReason(opts.reason);
    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const batchId = cryptoId('ga');

    const stamp = (row: { archivedAt?: number; archivedBy?: string; updatedAt: number }): void => {
      row.archivedAt = ts;
      row.archivedBy = by.name;
      row.updatedAt = ts;
    };
    stamp(goal);
    goal.archiveReason = reason;

    for (const id of taskIds) {
      const task = this.getTask(id);
      if (!task) continue;
      stamp(task);
      task.archiveReason = reason;
      task.archivedWithGoal = goalId;
    }
    this.scheduleSave(goal.workspaceId);

    this.emit({
      type: 'task.archived',
      workspaceId: goal.workspaceId,
      taskId: goal.id,
      kind: 'goal',
      title: goal.title,
      ...(reason !== undefined ? { reason } : {}),
      batchId,
      cascadeTasks: taskIds.length,
      actor: by,
      ts,
    });
    for (const id of taskIds) {
      const row = this.getTask(id);
      if (!row) continue;
      this.emit({
        type: 'task.archived',
        workspaceId: goal.workspaceId,
        taskId: id,
        title: row.title,
        ...(reason !== undefined ? { reason } : {}),
        partOf: batchId,
        actor: by,
        ts,
      });
    }
    return { ok: true, goal, changed: true, taskIds };
  }

  /**
   * Put an archived band back, with exactly the rows its archive removed.
   *
   * "Exactly" is `archivedWithGoal`: a row somebody archived on its own before
   * the band went is not part of this restore and stays where they put it.
   * That asymmetry is the reason the marker exists at all — see the field.
   */
  unarchiveGoal(
    goalId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): ArchiveGoalResult {
    const goal = this.getGoalRow(goalId);
    if (!goal) return { ok: false, error: 'not-found' };
    if (!isArchived(goal)) return { ok: true, goal, changed: false, taskIds: [] };
    const state = this.workspaces.get(goal.workspaceId);
    if (!state) return { ok: false, error: 'not-found' };
    const ts = Date.now();
    // Read before it is cleared, so the pair reads as one story in the trail.
    const reason = goal.archiveReason;
    const by: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const batchId = cryptoId('ga');

    const clear = (row: {
      archivedAt?: number;
      archivedBy?: string;
      archiveReason?: string;
      archivedWithGoal?: string;
      updatedAt: number;
    }): void => {
      // Assignment rather than `delete` (biome noDelete); JSON.stringify drops
      // an undefined-valued key, so the sidecar comes back without it.
      row.archivedAt = undefined;
      row.archivedBy = undefined;
      row.archiveReason = undefined;
      // Only a TASK carries this; a goal row has no `archivedWithGoal` of its
      // own, so the clear is a no-op on the band itself.
      row.archivedWithGoal = undefined;
      row.updatedAt = ts;
    };
    clear(goal);

    const taskIds: string[] = [];
    for (const task of state.tasks.values()) {
      if (task.archivedWithGoal !== goalId) continue;
      taskIds.push(task.id);
      clear(task);
    }
    this.scheduleSave(goal.workspaceId);

    this.emit({
      type: 'task.restored',
      workspaceId: goal.workspaceId,
      taskId: goal.id,
      kind: 'goal',
      title: goal.title,
      ...(reason !== undefined ? { reason } : {}),
      batchId,
      cascadeTasks: taskIds.length,
      actor: by,
      ts,
    });
    for (const id of taskIds) {
      const row = this.getTask(id);
      if (!row) continue;
      this.emit({
        type: 'task.restored',
        workspaceId: goal.workspaceId,
        taskId: id,
        title: row.title,
        ...(reason !== undefined ? { reason } : {}),
        partOf: batchId,
        actor: by,
        ts,
      });
    }
    return { ok: true, goal, changed: true, taskIds };
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
  /**
   * Refresh a task's markdown body snapshot from its live `task:<taskId>`
   * doc room (the projection's debounced flush). The snapshot is for search
   * and export only — it never re-seeds a live fragment (§3.3) — so this
   * emits NO event and deliberately does not bump `updatedAt`: body typing
   * is content activity, and the live doc room already announces it.
   */
  updateBodySnapshot(taskId: string, body: string): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    if (task.body === body) return true;
    // THE CHOKE POINT for "this row's description was replaced". Every door
    // into a task body converges here — `rewrite_task`, `set_doc_content`
    // on the `task:<id>` room, `find_and_replace` and the other prose edit
    // tools aimed at that docId, and a person typing on the board — because
    // they all mutate one Yjs fragment and this is what its observer flushes.
    // So the preservation hangs here rather than on any one route: a route
    // guard is only a guarantee for the callers who use that route, and the
    // reason this is being fixed is that one of them didn't.
    //
    // Write-once, predicate `quote` empty and NOTHING else — see the note on
    // `noteBodyEdited`, which used to hold this and could not see the doorways
    // that skipped it. Placed AFTER the equality guard above so a no-op flush
    // (the seed round-trip when a body room is first opened, measured stable)
    // preserves nothing: there is no rewrite there to preserve against.
    if (task.quote === undefined) {
      const original = task.body?.trim() || task.title.trim();
      if (original) task.quote = original;
    }
    task.body = body;
    // The one thing this path DOES record: when the description changed.
    // Stamped only on a real change (the equality guard above returns first),
    // so a no-op flush cannot make a stale body look freshly written — which
    // would silently clear the drift notice on exactly the rows that need it.
    task.bodyWrittenAt = Date.now();
    // A body rewrite reads as "somebody reconciled this row with the plan as
    // it now stands": the flag clears and the row re-stamps at the revision
    // it was flagged against, so a STILL-later plan edit flags it again.
    // Here at the choke point rather than on any one route, for the same
    // reason `quote` preservation is.
    if (task.possiblyStale !== undefined) {
      task.originDocRevision = task.possiblyStale.docRevision;
      task.possiblyStale = undefined;
    }
    bumpWordsRevision(task);
    this.scheduleSave(task.workspaceId);
    return true;
  }

  /**
   * Record what the done-artifact check concluded about this row's links.
   *
   * Deliberately quiet on both clocks: no store event (§3.6's table is
   * exhaustive by contract, and a subscriber-visible event here would restart
   * the ready-nudger's idle clock on machine bookkeeping) and no `updatedAt`
   * bump (the row did not change in any sense a person acts on). The visible
   * half of a bad verdict is the system comment the checker posts on the
   * task's discussion, which rides the ordinary thread pipeline. Last write
   * wins: a row done twice keeps the latest check, which is the one that
   * matches its current claim.
   */
  recordArtifactCheck(
    taskId: string,
    result: ArtifactCheck,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    task.artifactCheck = result;
    this.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  /**
   * Fold one interaction-bounded `read_session` into a task's cumulative
   * reading time. The LIVE path — called once per session flush, right
   * where the server already accepts the browser's `read_session` POST
   * (see `rooms.recordReadEvent` and its caller in server.ts).
   *
   * Quiet like `recordArtifactCheck` and for the identical reason: no store
   * event, no `updatedAt` bump. A person reading a ticket must not reset
   * its own staleness clock — that would let attention masquerade as
   * progress on the row.
   *
   * `deltaSeconds` is expected already server-clamped (`clampReadPayload`)
   * before it reaches here; a non-finite or non-positive value is a no-op
   * rather than an error, since it typically means the payload had nothing
   * to record instead of nothing found.
   */
  recordReadingTime(
    taskId: string,
    deltaSeconds: number,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return { ok: true, task };
    const prev = task.readingTime;
    task.readingTime = {
      totalSeconds: (prev?.totalSeconds ?? 0) + deltaSeconds,
      sessionCount: (prev?.sessionCount ?? 0) + 1,
      lastSessionAt: Date.now(),
    };
    this.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  /**
   * Overwrite a task's `readingTime` with an already-computed total — the
   * RECONCILIATION path, used by `reading-time-backfill.ts` to fold in
   * `read_session` events that were live-captured (since #468) but never
   * rolled up onto the task record before this field existed. A full
   * replace, not an add: the caller recomputes each task's total from the
   * complete activity log every run, so calling this twice with the same
   * inputs is a no-op and calling it after `recordReadingTime` has already
   * added some of the same events cannot double-count — the recompute
   * already includes them. Quiet for the same reason as `recordArtifactCheck`.
   */
  setReadingTime(
    taskId: string,
    readingTime: TaskReadingTime,
  ): { ok: true; task: Task } | { ok: false; error: 'not-found' } {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    task.readingTime = readingTime;
    this.scheduleSave(task.workspaceId);
    return { ok: true, task };
  }

  // ── Cross-references (§3.2 Ref; §3.12 commit 4) ──────────────────────────
  //
  // Links are stored on the task; backlinks are COMPUTED on read, never
  // stored, so the two directions can't drift. NOTE: link changes emit no
  // store event — §3.6's exhaustive table has no row for them — so the route
  // layer refreshes the ydoc projection by hand, the same pattern as
  // createWorkspace/attachDoc.

  /**
   * Add a cross-reference to a task's `links`. Idempotent: linking a ref
   * that's already there reports `changed: false` and touches nothing.
   * A task may not link itself (`self-ref`).
   */
  linkRef(taskId: string, ref: Ref): LinkRefResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isValidRef(ref)) return { ok: false, error: 'bad-ref' };
    if (ref.kind === 'task' && ref.taskId === taskId) return { ok: false, error: 'self-ref' };
    const key = refKey(ref);
    if (task.links.some((r) => refKey(r) === key)) return { ok: true, task, changed: false };
    task.links.push(ref);
    task.updatedAt = Date.now();
    this.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * The goal half of `linkRef`: add a cross-reference to a goal row's
   * `links`. Same idempotency contract; a goal cannot self-ref (its own id
   * is a task-kind ref, refused for symmetry with `linkRef`).
   */
  linkGoalRef(
    goalId: string,
    ref: Ref,
  ):
    | { ok: true; goal: GoalRow; changed: boolean }
    | { ok: false; error: 'not-found' | 'bad-ref' | 'self-ref' } {
    const goal = this.getGoalRow(goalId);
    if (!goal) return { ok: false, error: 'not-found' };
    if (!isValidRef(ref)) return { ok: false, error: 'bad-ref' };
    if (ref.kind === 'task' && ref.taskId === goalId) return { ok: false, error: 'self-ref' };
    const key = refKey(ref);
    if ((goal.links ?? []).some((r) => refKey(r) === key))
      return { ok: true, goal, changed: false };
    goal.links = [...(goal.links ?? []), ref];
    goal.updatedAt = Date.now();
    this.scheduleSave(goal.workspaceId);
    return { ok: true, goal, changed: true };
  }

  /** Remove a cross-reference. Removing one that isn't there is a no-op
   *  (`changed: false`), not an error — the end state is what was asked for. */
  unlinkRef(taskId: string, ref: Ref): UnlinkRefResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!isValidRef(ref)) return { ok: false, error: 'bad-ref' };
    const key = refKey(ref);
    const next = task.links.filter((r) => refKey(r) !== key);
    if (next.length === task.links.length) return { ok: true, task, changed: false };
    task.links = next;
    task.updatedAt = Date.now();
    this.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * Every task that references `ref` — via `links` or via its promotion
   * `origin` (a task promoted from a thread references that thread without
   * anyone calling link_refs). Exact-ref matching; spans all workspaces,
   * because refs do (a task may cite a doc that lives outside its hub
   * workspace). Deterministic order: creation time, then id.
   */
  backlinksFor(ref: Ref): Task[] {
    const key = refKey(ref);
    return this.tasksMatching((r) => refKey(r) === key);
  }

  /**
   * Doc→task surfacing: tasks that reference the doc itself OR any thread
   * in it — a task promoted from one of a doc's threads is about that doc.
   */
  tasksReferencingDoc(docId: string): Task[] {
    return this.tasksMatching(
      (r) => (r.kind === 'doc' || r.kind === 'thread') && r.docId === docId,
    );
  }

  /** Thread→task surfacing: exact thread-ref matches only. */
  tasksReferencingThread(docId: string, threadId: string): Task[] {
    return this.backlinksFor({ kind: 'thread', docId, threadId });
  }

  /**
   * A plan doc's content moved past the revision some derived rows were
   * stamped at — flag them `possiblyStale`. Wired to the doc store's settled
   * revision bump (`rooms.onContentRevision`); `docIds` carries the canonical
   * id AND the alias because origin refs routinely hold the caller-chosen
   * name. Advisory only: nothing here gates a transition. Open rows only —
   * a done row's premise no longer matters, and an archived one has left the
   * board. Rows with no `originDocRevision` (predate the field, or the doc
   * was not in memory at create) are skipped rather than guessed at.
   *
   * Emits no store event — §3.6's table is exhaustive by contract — so the
   * CALLER refreshes the ydoc projection for the returned workspaces, the
   * same pattern as `linkRef`.
   */
  flagStaleFromDocEdit(docIds: string[], revision: number): Set<string> {
    const ids = new Set(docIds);
    const touched = new Set<string>();
    for (const state of this.workspaces.values()) {
      for (const task of state.tasks.values()) {
        if (task.status === 'done' || isArchived(task)) continue;
        const o = task.origin;
        if (!isValidRef(o) || (o.kind !== 'doc' && o.kind !== 'thread')) continue;
        if (!ids.has(o.docId)) continue;
        if (task.originDocRevision === undefined) continue;
        if (task.originDocRevision >= revision) continue;
        if (task.possiblyStale?.docRevision === revision) continue;
        task.possiblyStale = { docRevision: revision, ts: Date.now() };
        touched.add(task.workspaceId);
        this.scheduleSave(task.workspaceId);
      }
    }
    return touched;
  }

  /**
   * The plan was approved: clear every hold pointing at it and release the
   * held rows to `todo` — approval IS the "start the work" gesture the
   * drafts were waiting for, so leaving them in triage would hand the
   * approver a second chore per row. The release goes through the ordinary
   * transition gate (hold cleared first), so each row's trail records who
   * approved and the projection refreshes off the emitted events. A held row
   * that is archived, or that somebody already moved before holds existed,
   * just loses the hold.
   *
   * Returns the released task ids plus every workspace whose rows changed —
   * the caller refreshes projections for holds cleared WITHOUT a transition
   * (clearing alone emits nothing).
   */
  releasePlanHolds(
    docIds: string[],
    actor: { id: string; name: string; kind?: string },
  ): { released: string[]; workspaceIds: Set<string> } {
    const ids = new Set(docIds);
    const released: string[] = [];
    const workspaceIds = new Set<string>();
    for (const state of this.workspaces.values()) {
      for (const task of state.tasks.values()) {
        if (task.planHold === undefined || !ids.has(task.planHold.docId)) continue;
        task.planHold = undefined;
        task.updatedAt = Date.now();
        workspaceIds.add(task.workspaceId);
        this.scheduleSave(task.workspaceId);
        if (task.status === 'triage' && !isArchived(task)) {
          const moved = this.transition(task.id, 'todo', {
            actor,
            note: 'Plan approved — draft released to the queue.',
          });
          if (moved.ok) released.push(task.id);
        }
      }
    }
    return { released, workspaceIds };
  }

  /**
   * Tasks whose `links` or `origin` contain a ref matching `pred`.
   *
   * Every ref is re-validated on the way past. `pred` is usually built on
   * `refKey`, which reads `ref.kind` and throws on anything that isn't a
   * ref — and this loop spans EVERY workspace, so one malformed ref stored
   * anywhere took down every caller: `tasksReferencingDoc` sits on the
   * doc-open path and on thread listing. `origin` used to be written to
   * `<ws>.tasks.json` unvalidated (the route cast instead of checking), so
   * `origin: null` persisted, survived restart, and made doc-open 500 —
   * `task.origin !== undefined` is true for `null`. The route now validates;
   * this guard is what keeps already-persisted junk from being fatal.
   */
  private tasksMatching(pred: (ref: Ref) => boolean): Task[] {
    const out: Task[] = [];
    for (const state of this.workspaces.values()) {
      for (const task of state.tasks.values()) {
        const matches =
          task.links.some((r) => isValidRef(r) && pred(r)) ||
          (isValidRef(task.origin) && pred(task.origin));
        if (matches) out.push(task);
      }
    }
    return out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Open (not-done) dependencies of a task, described so the message can
   *  land verbatim in an agent's context: "blocked by open decision t-x:
   *  'your go'". A dangling id (dep task deleted) can't gate — skipped. */
  /**
   * A row by id, task or goal — the lookup the transition gate uses.
   *
   * Deliberately NOT `getTask`, which stays tasks-only. `getTask` has dozens
   * of callers and every one of them is a task verb; widening it would put
   * goal rows in reach of `assign_task`, `set_task_goal` and the rest by id
   * alone. Only the gate needs to see both, so only the gate gets a lookup
   * that does.
   */
  private findRow(id: string): BoardRow | undefined {
    return this.getTask(id) ?? this.getGoalRow(id);
  }

  /**
   * A goal's open children, reported so a declaration can be made with them
   * in view — never to refuse it.
   *
   * `enforce: false` on every row, unconditionally, and that is the feature
   * rather than a default: a goal is done because somebody says so, and the
   * children are reported, not enforced. There is deliberately no opt-in to
   * make one of these enforcing, because an enforcing child edge would make
   * `done` derived again through the back door — the goal could only be
   * closed once its children were, which is exactly the roll-up rule Bryan
   * ruled out.
   */
  private openChildren(goal: GoalRow): TransitionBlocker[] {
    const state = this.workspaces.get(goal.workspaceId);
    if (!state) return [];
    const out: TransitionBlocker[] = [];
    for (const task of state.tasks.values()) {
      if (task.goal !== goal.id || task.status === 'done') continue;
      if (isArchived(task)) continue;
      const noun = task.needs === 'decision' ? 'decision' : 'task';
      out.push({
        taskId: task.id,
        title: task.title,
        status: task.status,
        ...(task.needs !== undefined ? { needs: task.needs } : {}),
        enforce: false,
        message: `still open in this goal — ${noun} ${task.id}: '${task.title}'`,
      });
    }
    return out;
  }

  private openBlockers(task: Task): TransitionBlocker[] {
    const enforce = new Set(task.afterEnforce ?? []);
    const out: TransitionBlocker[] = [];
    for (const depId of task.after) {
      const dep = this.getTask(depId);
      if (!dep || dep.status === 'done') continue;
      const noun = dep.needs === 'decision' ? 'decision' : 'task';
      out.push({
        taskId: dep.id,
        title: dep.title,
        status: dep.status,
        ...(dep.needs !== undefined ? { needs: dep.needs } : {}),
        enforce: enforce.has(depId),
        message: `blocked by open ${noun} ${dep.id}: '${dep.title}'`,
      });
    }
    return out;
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

  private goalIdExists(workspace: HubWorkspace, goalId: string): boolean {
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

  private scheduleSave(workspaceId: string): void {
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

  private scheduleAttachmentsSave(workspaceId: string): void {
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
   *  nothing sensitive left on disk when nothing is attached). */
  private persistAttachments(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    const dir = join(this.dataDir, 'workspaces');
    const path = attachmentsSidecarPath(this.dataDir, workspaceId);
    const tmp = `${path}.tmp`;
    try {
      if (state.attachments.size === 0) {
        rmSync(path, { force: true });
        return;
      }
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = { attachments: Array.from(state.attachments.values()) };
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[tasks] failed to persist attachments for ${workspaceId}:`, err);
      try {
        rmSync(tmp, { force: true });
      } catch {}
    }
  }

  /** Load a workspace's attachments sidecar. Records hydrate with their old
   *  clocks — a stale lastHeartbeat honestly reads as `away` until the agent
   *  heartbeats again; we never reset it to look alive. */
  private loadAttachments(workspaceId: string): Map<string, AgentAttachment> {
    const out = new Map<string, AgentAttachment>();
    const path = attachmentsSidecarPath(this.dataDir, workspaceId);
    if (!existsSync(path)) return out;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        attachments?: AgentAttachment[];
      };
      for (const att of parsed.attachments ?? []) {
        if (typeof att?.agentId !== 'string' || !isAttachmentRuntime(att.runtime)) continue;
        out.set(att.agentId, { ...att, workspaceId });
      }
    } catch (err) {
      // A corrupt sidecar loses the attachments, never the workspace.
      console.error(`[tasks] unreadable attachments sidecar for ${workspaceId} — skipped:`, err);
    }
    return out;
  }

  private persist(workspaceId: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    const dir = join(this.dataDir, 'workspaces');
    const path = tasksSidecarPath(this.dataDir, workspaceId);
    const tmp = `${path}.tmp`;
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const payload = {
        workspace: state.workspace,
        tasks: Array.from(state.tasks.values()),
        // A key of its own rather than rows mixed into `tasks`: a reader that
        // has not heard of goal rows gets exactly the task list it expects,
        // and `workspace.goals[]` above stays on disk as the rollback path.
        goalRows: Array.from(state.goalRows.values()),
      };
      // Write-then-rename so a crash mid-write can't leave a torn sidecar —
      // the sidecar is authoritative on hydrate, so a torn one loses the
      // whole board.
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
      renameSync(tmp, path);
    } catch (err) {
      console.error(`[tasks] failed to persist workspace ${workspaceId}:`, err);
      try {
        rmSync(tmp, { force: true });
      } catch {}
    }
  }

  private hydrateFromDisk(): void {
    const dir = join(this.dataDir, 'workspaces');
    if (!existsSync(dir)) return;
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch (err) {
      console.error('[tasks] failed to read workspaces dir:', err);
      return;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.tasks.json')) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(dir, entry), 'utf8')) as {
          workspace?: HubWorkspace;
          tasks?: Task[];
          goalRows?: GoalRow[];
        };
        const workspace = parsed.workspace;
        if (!workspace || typeof workspace.id !== 'string') {
          console.error(`[tasks] sidecar ${entry} has no workspace — skipped`);
          continue;
        }
        // Boards written before subgoals were removed still hold them, and
        // every reader below this line looks at `goals` alone. Without this
        // the nested bands would simply not exist after the deploy — their
        // tasks reading as unknown-goal work, and the next goal-list edit
        // stranding them for real. Flattened HERE, at the one door a stored
        // list comes through, rather than in each reader.
        workspace.goals = flattenNestedGoals((workspace.goals ?? []) as readonly NestedGoalInput[]);
        const tasks = new Map<string, Task>();
        for (const task of parsed.tasks ?? []) {
          if (typeof task?.id !== 'string') continue;
          // `unplacedSince` is deliberately NOT cleared here — see the field.
          // But every task written before it existed lacks it, and the sweep
          // now keys on it, so a writer-only fix would empty the bucket for
          // the entire existing board at the deploy. Reproduce the membership
          // rule the old predicate used (Backlog + open + never placed) and
          // date it from `createdAt`, the only honest timestamp available.
          //
          // It over-includes a legacy explicit `goal: 'chores'` create, and
          // it has to: that distinction was never recorded, so there is
          // nothing on disk to read it from. Over-including asks about one
          // extra task; under-including silently drops real ones.
          if (
            task.unplacedSince === undefined &&
            task.goal === CHORES_GOAL_ID &&
            task.status !== 'done' &&
            task.triagedAgainst === undefined
          ) {
            task.unplacedSince = task.createdAt;
          }
          // A judge call that was out when the last process died never
          // came back. The item must not stay off the queue for it: a
          // verdict nobody will deliver is a judge failure, and those pass.
          for (const item of task.reviews ?? []) {
            if (item?.judge?.verdict === 'pending') {
              item.judge = {
                at: item.judge.at,
                verdict: 'unavailable',
                reason: 'the server restarted before the judge answered',
              };
            }
          }
          tasks.set(task.id, task);
          this.taskIndex.set(task.id, workspace.id);
        }
        const goalRows = new Map<string, GoalRow>();
        // Goals archived as somebody ELSE's cascade member — the shape a
        // subgoal's archive left behind, and the second half of the same
        // migration. A goal row no longer carries `archivedWithGoal` at all,
        // so the stored key is read once here and cleared.
        const cascadedGoals = new Set<string>();
        for (const row of parsed.goalRows ?? []) {
          if (typeof row?.id !== 'string') continue;
          const legacy = row as { archivedWithGoal?: string };
          if (legacy.archivedWithGoal !== undefined) {
            cascadedGoals.add(row.id);
            legacy.archivedWithGoal = undefined;
          }
          goalRows.set(row.id, row);
          this.goalIndex.set(row.id, workspace.id);
        }
        // Its tasks were stamped with the PARENT's id, which is what made the
        // pair restore together. Flattened, that band restores on its own —
        // and would come back empty, its work still archived, while restoring
        // the old parent revived those tasks under a band that is still off
        // the board. Re-point them at the band they actually sit in, so
        // either restore is the whole of one decision again.
        if (cascadedGoals.size > 0) {
          for (const task of parsed.tasks ?? []) {
            if (task?.archivedWithGoal === undefined) continue;
            if (cascadedGoals.has(task.goal)) task.archivedWithGoal = task.goal;
          }
        }
        this.workspaces.set(workspace.id, {
          workspace,
          tasks,
          goalRows,
          attachments: this.loadAttachments(workspace.id),
        });
        // The migration, and it is lazy on purpose: every board on disk today
        // has `goals` and no `goalRows`, so the rows are minted the first time
        // that board is read back. Re-running it is safe by construction — the
        // reconcile refreshes only what the goal LIST owns.
        const state = this.workspaces.get(workspace.id);
        // `todo`, NOT the create default: this is the migration, and every
        // band on an existing board was agreed to long before goal rows
        // existed. Minting these `triage` would halt dispatch fleet-wide on
        // the first read after deploy.
        if (state) this.syncGoalRows(state, 'todo');
      } catch (err) {
        // A corrupt sidecar loses that one workspace, never the server.
        console.error(`[tasks] unreadable sidecar ${entry} — skipped:`, err);
      }
    }
  }
}
