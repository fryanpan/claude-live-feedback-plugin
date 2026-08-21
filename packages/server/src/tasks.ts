import { randomBytes } from 'node:crypto';
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
  type ReviewPayload,
  type TaskReviewItem,
  agentIdCandidates,
  checkReviewPayload,
  readReviewPayload,
  readTaskReviewItem,
  reviewFromDecisionTask,
  reviewGapAdvice,
  reviewPayloadMessage,
  transitionUnproven,
} from '@feedback/core';
import { type StoredGoalSummary, goalTextHash } from '@feedback/core/goal-summary';
import { classifyActor } from './activity.ts';
import {
  type DecisionShapeGap,
  checkDecisionShape,
  decisionShapeMessage,
} from './decision-shape.ts';
import { type DeclaredOwnerKind, declaredAssigneeKind } from './task-owner.ts';
import { bodyHead } from './task-title.ts';

/**
 * The hub task store: server-owned state for Workspace Hub workspaces and
 * their tasks (plan §3.2/§3.3).
 *
 * Words people write together live in CRDTs; facts the system is accountable
 * for — status, placement, who owns it — go through THIS gate. Every status
 * change lands here (`transition`), gets an append-only audit entry with the
 * actor's identity and kind, and carries whatever evidence the caller
 * attached. An evidence-less move to done/in-progress is allowed but flagged
 * (`unproven`) — flagging is easier to live with than blocking (§7.1); the
 * only hard stop is an `after` edge explicitly marked enforce.
 *
 * Persistence is a per-workspace JSON sidecar at
 * `<dataDir>/workspaces/<id>.tasks.json`, written on a short debounce after
 * changes settle — the same pattern as doc metadata. The sidecar is
 * authoritative on hydrate; the ydoc projection (a later commit) is a
 * read-only mirror of it, never a source.
 *
 * A hub Workspace is a NEW first-class entity: today's `workspaceId` on
 * DocMeta is only a grouping tag minted by folder binds / diff reviews.
 * `attachDoc` LINKS existing docs and reviews to a hub workspace — nothing
 * is migrated, and docs keep working at their current URLs.
 */

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

/**
 * The evidence an object actually claims, or undefined if it claims nothing.
 *
 * Trims the commit and drops a malformed `threadRef` outright, so a caller
 * cannot satisfy "this amendment carries proof" with whitespace or with a
 * ref that points at no shape the rest of the system recognises. Returning
 * `undefined` — one spelling of "nothing here" — keeps every caller from
 * inventing its own second spelling.
 */
export function normalizeEvidence(evidence: unknown): TaskEvidence | undefined {
  if (typeof evidence !== 'object' || evidence === null) return undefined;
  const e = evidence as { commit?: unknown; threadRef?: unknown };
  const commit = typeof e.commit === 'string' ? e.commit.trim() : '';
  const threadRef = isValidRef(e.threadRef) ? e.threadRef : undefined;
  if (commit.length === 0 && threadRef === undefined) return undefined;
  return {
    ...(commit.length > 0 ? { commit } : {}),
    ...(threadRef !== undefined ? { threadRef } : {}),
  };
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

export interface WorkspaceSubgoal {
  id: string;
  title: string;
  dueAt?: number;
}

export interface WorkspaceGoal {
  id: string;
  title: string;
  dueAt?: number;
  /** ONE level max — deeper nesting kills the 5-second task (§3.2). */
  subgoals?: WorkspaceSubgoal[];
}

export interface HubWorkspace {
  /** Crypto-random and unguessable — URLs hang off it (§3.2). */
  id: string;
  name: string;
  /** The north-star statement triage judges against. Markdown. */
  goal: string;
  goalUpdatedAt: number;
  /**
   * A ≤20-word line to DISPLAY in place of the goal, so the board's goal
   * strip and every task's "Triaged against" row stay scannable on a phone.
   *
   * Optional, and its absence is not a gap: every surface falls back to a
   * deterministic clip of the goal's own opening words (`goalDisplay` in
   * `@feedback/core/goal-summary`). Nothing renders worse for want of one,
   * which is why writing it never blocks a goal edit and why no surface
   * waits on a model to produce it.
   *
   * Dropped whenever the goal changes without a replacement summary in the
   * same call — a line describing a goal that no longer exists is the one
   * failure a short display must not have.
   */
  goalSummary?: StoredGoalSummary;
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
  createdAt: number;
}

export type TaskStatus = 'todo' | 'in-progress' | 'done';

const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in-progress', 'done']);

/** Reserved catch-all section id for no-goal work. Never in `goals[]`. */
export const CHORES_GOAL_ID = 'chores';

/**
 * Goal ids the SERVER owns. Every other goal id is generated (`newGoalId`)
 * and opaque; these are literals on purpose, and the distinction is stated
 * here rather than implied so that the next reserved bucket is added to a
 * list instead of to a chain of `=== CHORES_GOAL_ID` comparisons.
 *
 * A reserved id is one that code and agents must be able to SAY without a
 * lookup — `chores` is referenced across this store, named in the shipped
 * skills, and is the answer to "where does unplaced work go". A generated id
 * could not carry that meaning. Reserved ids are therefore exempt from the
 * generation rule, not an oversight in it, and they stay reachable by their
 * literal from every read and every `setTaskGoal`.
 *
 * They are still refused by every WRITE that would create, rename, remove or
 * reorder a goal — a reserved bucket exists, it is not authored.
 */
export const RESERVED_GOAL_IDS: ReadonlySet<string> = new Set([CHORES_GOAL_ID]);

/** Whether `id` is a server-owned bucket rather than an authored goal. */
export function isReservedGoalId(id: string): boolean {
  return RESERVED_GOAL_IDS.has(id);
}

/** Every goal and subgoal as one flat list, parent before its children. The
 *  ordered list is two levels deep and three call sites had each walked it by
 *  hand; a fourth that forgot the inner loop would silently ignore subgoals,
 *  which is exactly the kind of half-coverage the goal-list edits keep
 *  producing. Ordering is the read order, so callers can report in it. */
export function flattenGoals(
  goals: WorkspaceGoal[],
): Array<{ id: string; title: string; dueAt?: number; parent?: string }> {
  const out: Array<{ id: string; title: string; dueAt?: number; parent?: string }> = [];
  for (const g of goals) {
    out.push({ id: g.id, title: g.title, ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}) });
    for (const s of g.subgoals ?? []) {
      out.push({
        id: s.id,
        title: s.title,
        ...(s.dueAt !== undefined ? { dueAt: s.dueAt } : {}),
        parent: g.id,
      });
    }
  }
  return out;
}

export interface TaskActor {
  id: string;
  name: string;
  kind: 'person' | 'agent';
}

export interface TaskEvidence {
  commit?: string;
  threadRef?: Ref;
}

/**
 * Evidence attached to a transition AFTER it was recorded.
 *
 * Append, never rewrite. The transition's own `evidence` field is left
 * exactly as it was — the row keeps saying it went in with no proof, or with
 * the wrong proof — and this is a new attributed, timestamped fact layered on
 * it, in the same shape as the rest of the audit trail. The two failures it
 * repairs both happened in the field: an `evidence` object dropped before it
 * reached the server (the move landed `unproven` and there was no way back),
 * and a commit sha written from memory that resolved to nothing (which reads
 * as proof, so nothing looked wrong until someone tried to follow it).
 */
export interface TaskEvidenceAmendment {
  ts: number;
  by: TaskActor;
  /** The evidence the transition should have carried. Never empty — an
   *  amendment that claims nothing is refused, because "the caller sent an
   *  evidence object" is a check satisfied by `{}`, and a correction must
   *  not be able to delete the thing it was sent to fix. */
  evidence: TaskEvidence;
  /** Why the correction was needed, in the amender's words. */
  note?: string;
  /**
   * What stood before this amendment — the row's own evidence for the first
   * correction, the previous amendment's for later ones. Absent when there
   * was nothing to supersede.
   *
   * This is the difference between filling a gap and marking a false claim,
   * and a reader of the trail has to be able to tell them apart: the second
   * one means the sha printed next to the row is one nobody should follow.
   */
  supersedes?: TaskEvidence;
}

export interface TaskTransition {
  ts: number;
  from: TaskStatus;
  to: TaskStatus;
  by: TaskActor;
  note?: string;
  evidence?: TaskEvidence;
  /** Corrections attached after the fact, oldest first. Absent — rather than
   *  an empty array — while there have been none, so a row that was right the
   *  first time carries nothing extra. */
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
}

export interface Task {
  /** `t-<crypto-random>`. */
  id: string;
  workspaceId: string;
  title: string;
  /** Markdown snapshot of the description. The live CRDT body room
   *  (`task:<taskId>`) arrives with the projection commit; this snapshot is
   *  for search/export and never re-seeds a live fragment (§3.3). */
  body?: string;
  /** 'human' for work only a person can do, otherwise a named identity —
   *  the agent or person who owns it. Every route that creates a task
   *  resolves this from the caller and REFUSES the generic word (see
   *  task-owner.ts), so a stored 'agent' is a pre-enforcement row. */
  assignee: string;
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
  reviews?: TaskReviewItem[];
  /** Goal or subgoal id; `chores` is the catch-all. */
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
  links: Ref[];
  /** The thread/doc this was promoted from. */
  origin?: Ref;
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
  triagedAgainst?: { goalId: string; goal: string; ts: number };
  /**
   * Triage-pending marker (§3.4). Stamped ONLY at the moment a triage
   * request is actually emitted to a live attachment — the grounded-pending
   * rule from the summaries incident: never promise work that isn't queued.
   * No attachment → no marker; the task simply sits in Backlog. Cleared on
   * hydrate (a restart kills the emitted request, so the promise must not
   * outlive it) and by the agent's eventual placement.
   */
  triagePendingTs?: number;
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
   * SURVIVES hydrate, unlike `triagePendingTs` directly above — and the
   * contrast is the point. That marker promises an in-flight request a restart
   * killed; this records a review still OWED, which a restart does not answer.
   * Before this field the distinction lived only in the create RESPONSE, so
   * after a restart an unplaced task and a deliberate chore were identical.
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
  createdAt: number;
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
}

export interface CreateTaskOpts {
  title: string;
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
  | { ok: true; task: Task; blockers: TransitionBlocker[]; unproven: boolean }
  | {
      ok: false;
      error: 'not-found' | 'bad-status' | 'same-status' | 'blocked';
      blockers?: TransitionBlocker[];
      /** Refusal text shaped to land verbatim in an agent's context. */
      message?: string;
    };

export type AmendEvidenceResult =
  | {
      ok: true;
      task: Task;
      /** The row the correction landed on, amendments included. */
      transition: TaskTransition;
      amendment: TaskEvidenceAmendment;
      /** The row's shading AFTER the amend — false whenever real evidence
       *  landed on a forward move. Returned so the caller can confirm the
       *  effect rather than infer it from a 200. */
      unproven: boolean;
    }
  | {
      ok: false;
      error:
        | 'not-found'
        /** The task exists but has never moved, so there is no row to amend. */
        | 'no-transitions'
        /** No transition at the `transitionTs` given. */
        | 'transition-not-found'
        /** The evidence claims nothing — see `TaskEvidenceAmendment.evidence`. */
        | 'empty-evidence';
      message?: string;
    };

/**
 * What actually happened to a new task's placement.
 *
 * Both fields are MEASURED, never inferred. `placed` is "the caller named a
 * goal", which is a different fact from "the task's goal is chores" — an
 * explicit `'chores'` is a placement and an omitted goal that landed there is
 * not, and only the create call can still tell them apart. `triageDelivered`
 * is the return value of the delivery bridge, i.e. "a live attachment
 * received this request", not "this workspace has an agent". The distinction
 * is the one the summary-pending marker had to learn the hard way: "this
 * server does X" is not "X is happening for this item".
 */
export interface TaskPlacement {
  /** The caller named a goal — even `'chores'`. False means it fell to the
   *  Backlog resting state without anyone judging it. */
  placed: boolean;
  /** A triage request for this task reached a live attachment. Always false
   *  for a placed task, which asks for no triage. */
  triageDelivered: boolean;
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

/**
 * A triage request the server EMITS — triage itself executes in the attached
 * agent, never here (§3.4: the server has no judgment about the goal; the
 * Haiku fast path gets lookups only, changes belong to the attachment).
 */
export type TriageRequest =
  | {
      /** A freshly created task with no explicit goal needs placing. */
      kind: 'task';
      workspaceId: string;
      taskId: string;
      /** The workspace's north-star goal text at emission time — what the
       *  agent triages against. */
      goal: string;
      ts: number;
    }
  | {
      /** The workspace goal changed — re-triage the OPEN tasks (§3.4:
       *  done stays put). */
      kind: 'goal-retriage';
      workspaceId: string;
      oldGoal: string;
      newGoal: string;
      taskIds: string[];
      /** Who this is ADDRESSED to — the workspace's lead agent. The request
       *  rides a per-workspace channel every attached agent can hear, so the
       *  addressee has to be in the payload; a non-lead listener is reading
       *  someone else's mail. Absent only when the seat is empty, which is
       *  also the one case where the request cannot be delivered at all. */
      leadAgentId?: string;
      /** The `workspace.retriaged` row this request belongs to. The agent
       *  passes it back on each placement so N moves read as one goal edit. */
      batchId: string;
      actor: TaskActor;
      ts: number;
    }
  | {
      /**
       * A band APPEARED in the goal list, so the unknown-goal bucket is worth
       * re-looking at: some of what nobody could place before may have a home
       * now. The ask is to LOOK — it never places anything, because
       * auto-assigning stamps a ranking decision no human made, invisibly.
       *
       * Deliberately NOT a `goal-retriage`. That request's `oldGoal`/`newGoal`
       * are the north-star TEXT, which a goal-list edit does not touch, and
       * the drain path renders them as "what your placements were last judged
       * against" — so reusing the slot would make both fields lie. This one
       * carries its own baseline: the goal LIST before and after.
       */
      kind: 'bucket-review';
      workspaceId: string;
      /** The bands that appeared in this edit (top-level or subgoal — both
       *  are placement destinations), in list order. */
      newBands: GoalBand[];
      /** The bucket at emission time: open tasks with `unplacedSince` set. */
      taskIds: string[];
      /** The baseline this ask is against — the goal LIST, not the goal TEXT. */
      oldGoals: WorkspaceGoal[];
      newGoals: WorkspaceGoal[];
      /** Addressed to the lead, same rule as `goal-retriage`: placing the
       *  bucket is a board-wide ranking judgment, not first-come work. */
      leadAgentId?: string;
      /** The `workspace.goals_changed` batch this ask belongs to, so a
       *  placement made in answer to it reads as part of that edit. */
      batchId: string;
      actor: TaskActor;
      ts: number;
    }
  | {
      /**
       * Somebody wrote to this row — created it placed, renamed it, or
       * rewrote its body — so the ask is a REVIEW by the lead: the one
       * party with project context. The JUDGMENT of the title/body standard
       * lives in the reviewing skill's prompt, not in this server (Bryan,
       * 2026-08-18: the code-written format check moved into an LLM
       * prompt), so every attributed non-lead write routes and the reviewer
       * decides fine as-is / rewrite / ask the filer. Never a refusal — the
       * write this request is about has already landed.
       *
       * PLACED creates only: an unplaced create is already owned by the
       * shape-and-place `kind: 'task'` ask (live) or the untriaged sweep
       * (attach), and a second request would say the same thing twice.
       * Renames and body edits route regardless of placement.
       */
      kind: 'task-review';
      workspaceId: string;
      taskId: string;
      /** The name the row has NOW — what the reviewer judges. */
      title: string;
      /** What just happened to the row. */
      trigger: TaskReviewTrigger;
      /** Addressed to the lead, same rule as `goal-retriage`: judging a
       *  title against the project is the lead's seat, not first-come work. */
      leadAgentId?: string;
      /** Who wrote the title/body this asks about — the addressee of any
       *  follow-up question, and whose own echo the MCP watch suppresses. */
      actor?: TaskActor;
      ts: number;
    };

/** A goal or subgoal named as a place a task could go. */
export interface GoalBand {
  id: string;
  title: string;
}

/**
 * Bridge to whatever can carry a triage request to a live attached agent —
 * server.ts installs the real one: `hasLiveAttachment` decides live, the
 * workspace SSE channel (the MCP watch transport) carries it. MUST return
 * true ONLY when the request was actually emitted to a live attachment —
 * the return value is what grounds the task's triage-pending marker, so an
 * optimistic true would promise work that isn't queued.
 */
export type TriageDelivery = (req: TriageRequest) => boolean;

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
}

/** How recent a heartbeat must be for the process to count as up. */
export const HEARTBEAT_FRESH_MS = 5 * 60_000;
/** §4: "no lastToolCallAt movement in 30+ minutes" is the outage signature. */
export const TOOL_CALL_STALE_MS = 30 * 60_000;

/**
 * How recently the server must have OBSERVED an agent for a delivery to count
 * as reaching it.
 *
 * Separate from `HEARTBEAT_FRESH_MS` because it answers a different question.
 * That one asks "how recently did this agent SAY it was alive" and feeds the
 * displayed state; this one asks "how recently did we SEE it do something",
 * and it decides whether a request is handed over or parked.
 *
 * The distinction is the whole bug. `lastHeartbeat` moves only when a session
 * calls the `heartbeat` tool, and nothing makes that happen — no timer, no
 * hook, one line of prose in one skill. Measured on the live board
 * 2026-08-19: 13 liveness events in 5.43 days against 215 task transitions,
 * so the old gate could read live for **0.77%** of the time an agent was
 * attached and plainly working. Voice paid for it directly — 6 of 10 recorded
 * utterances routed to `agent-queued`, one of them "voice is not working".
 *
 * 15 minutes is measured rather than picked. On the same board the median gap
 * between consecutive observable agent writes is 0.3 min and p90 is 11.2 min:
 * a window at the old 5-minute figure would still read away across ~18% of
 * ordinary working gaps, where 15 minutes sits just above p90. It is
 * deliberately not hours — a false "live" is broadcast to nobody and lost,
 * where a false "away" is merely deferred to the next attach.
 */
export const OBSERVED_LIVE_MS = 15 * 60_000;

/**
 * How long an emitted utterance is left alone before the queue offers it again.
 *
 * The floor is "how long can a busy agent reasonably take to acknowledge a
 * channel frame" — a frame lands at a turn boundary, so it waits out whatever
 * tool call is in progress. The ceiling is Bryan noticing nothing happened. 90
 * seconds sits between: past it, an unacked entry is far more likely lost than
 * pending, and re-offering costs at worst one duplicated instruction where NOT
 * re-offering costs the whole request.
 */
export const VOICE_ACK_GRACE_MS = 90_000;

export type AttachmentState = 'active' | 'unresponsive' | 'away';

export interface AttachmentThresholds {
  heartbeatFreshMs?: number;
  toolCallStaleMs?: number;
  observedWorkFreshMs?: number;
}

/**
 * Is anyone actually subscribed to the channel a request is about to ride?
 *
 * The half a time window cannot cover: a session that died since its last
 * write is still inside the window and still gone. Wired to the SSE hub in
 * `server.ts`; unwired it answers yes, so a store with no transport behaves
 * exactly as it did before.
 *
 * It takes a workspaceId and not an agentId on purpose, and that is its
 * honest limit: the channel is per-BOARD, so this can answer "is anyone
 * there" and never "is THAT agent there". Which agent is live stays a
 * question for the observed clock, and the gate is the AND of the two. So a
 * browser tab open on a board makes the probe true while contributing no
 * liveness of its own — which is why the probe may only ever narrow the
 * answer, never widen it. Reading it as sufficient would let an open tab
 * impersonate a working agent and lose the request it was handed.
 */
export type DeliveryProbe = (workspaceId: string) => boolean;

/**
 * Is THIS agent's own event stream open right now?
 *
 * The delivery channel is an SSE connection the agent's MCP child holds for
 * the life of the session. That socket is the strongest evidence this server
 * can have that a frame will arrive — better than any clock, because it is
 * the actual wire and it is observed rather than self-reported.
 *
 * It is a separate type from `DeliveryProbe` because it answers a stronger
 * question and therefore earns a stronger permission. `DeliveryProbe` counts
 * subscribers and cannot tell an agent from a browser tab, so it may only
 * narrow a delivery decision; this one is keyed by agentId and only the
 * agent's own child sends one, so it may widen it.
 *
 * What it deliberately does NOT do is move the DISPLAYED attachment state. An
 * open socket promises the frame lands in the process, not that the model is
 * working — `attachmentState` keeps deriving "process up, agent unresponsive"
 * from the heartbeat and tool-call clocks, which is the distinction
 * `attachment-keepalive.ts` refuses a timer in order to protect.
 */
export type AgentStreamProbe = (workspaceId: string, agentId: string) => boolean;

/**
 * Derive the hub's attachment state (§4). "Active 2m ago" is shown because a
 * heartbeat actually arrived — we never guess from the absence of activity —
 * and fresh-heartbeat-but-stale-tool-calls is rendered as "process up, agent
 * unresponsive", never as active.
 */
export function attachmentState(
  att: Pick<AgentAttachment, 'lastHeartbeat' | 'lastToolCallAt'>,
  now: number,
  thresholds?: AttachmentThresholds,
): AttachmentState {
  const freshMs = thresholds?.heartbeatFreshMs ?? HEARTBEAT_FRESH_MS;
  const staleMs = thresholds?.toolCallStaleMs ?? TOOL_CALL_STALE_MS;
  if (now - att.lastHeartbeat >= freshMs) return 'away';
  if (now - att.lastToolCallAt >= staleMs) return 'unresponsive';
  return 'active';
}

export function attachmentStateLabel(state: AttachmentState): string {
  switch (state) {
    case 'active':
      return 'active';
    case 'unresponsive':
      return 'process up, agent unresponsive';
    case 'away':
      return 'away — requests queue';
  }
}

/** An attachment plus its derived state, computed at read time. */
export type DescribedAttachment = AgentAttachment & {
  state: AttachmentState;
  stateLabel: string;
};

/** The §4 record WITHOUT `endpoint`, plus derived state — what agent.*
 *  events carry and what a share visitor's REST read gets. */
export type PublicAttachment = Omit<DescribedAttachment, 'endpoint'>;

export function publicAttachment(
  att: AgentAttachment,
  now: number,
  thresholds?: AttachmentThresholds,
): PublicAttachment {
  const state = attachmentState(att, now, thresholds);
  const { endpoint: _endpoint, ...rest } = att;
  return { ...rest, state, stateLabel: attachmentStateLabel(state) };
}

/** The one-line "a fresh context learns the gates exist" summary returned on
 *  attach (§3.3): open decision tasks that gate open tasks via `after`. */
export interface GatingSummary {
  openDecisions: number;
  gatedTasks: number;
  summary: string;
}

/** What happened to a row to earn it a review. */
export type TaskReviewTrigger = 'created' | 'renamed' | 'edited';

/**
 * One row of the lead's review queue: a task somebody wrote to while the
 * lead was away, or whose live request went undelivered. QUEUED rather than
 * derived: the judgment of the title/body standard lives in the reviewing
 * skill's prompt now, so the server cannot re-derive "which rows fall
 * short" — it can only remember which rows changed. Coalesced by taskId,
 * pruned of done rows on read, and persisted to its own sidecar for the
 * same reason the re-triage queue is: a promise that lives only in memory
 * dies with the process.
 */
export interface PendingTaskReview {
  taskId: string;
  /** The LATEST undelivered write's kind. */
  trigger: TaskReviewTrigger;
  /** Who wrote it — the addressee of any follow-up question. Latest wins. */
  actor?: TaskActor;
  /** When the FIRST undelivered write happened, so the queue ages honestly. */
  ts: number;
}

/** Where a workspace's undelivered task reviews wait. Exported so tests
 *  assert the real contract path rather than a re-implementation of it. */
export function pendingTaskReviewsPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.taskreviews.json`);
}

export type AttachAgentResult =
  | {
      ok: true;
      attachment: AgentAttachment;
      gating: GatingSummary;
      /** Open Backlog tasks no triage has placed — what the agent sweeps
       *  after attaching (§3.4). */
      untriaged: string[];
      /** Voice change-requests that arrived while no agent was live (§2.4
       *  "agent away — queued"). Delivered HERE — in the attach result, the
       *  one payload a fresh attachment is guaranteed to read — and drained:
       *  a second attach gets an empty list. Only ever handed to the LEAD,
       *  like `pendingRetriage`; a bystander attaching leaves the queue
       *  intact (and this field absent) for the lead's next attach. */
      queuedVoice?: QueuedVoiceRequest[];
      /** A goal edit that happened while the lead was away. Delivered HERE —
       *  the one payload a fresh attachment is guaranteed to read — and
       *  drained, so a re-attach never asks for the same walk twice. Only
       *  ever handed to the LEAD; a bystander attaching leaves it waiting. */
      pendingRetriage?: PendingRetriage;
      /** A band that appeared in the goal list while the lead was away, with
       *  the bucket it is worth re-looking at. Same delivery contract as
       *  `pendingRetriage` — lead only, drained here — and deliberately a
       *  SEPARATE field: the two asks have different baselines and answering
       *  one is not answering the other. */
      pendingBucketReview?: PendingBucketReview;
      /** The correction loop's pickup: rows written to while the lead was
       *  away (or whose live ask went undelivered), waiting for the
       *  reviewing skill's pass. Lead only, like `pendingRetriage`, and
       *  drained the same way — delivered here and cleared, so a re-attach
       *  never asks for the same look twice. Absent when nothing waits or
       *  the attacher is not the lead. */
      taskReviews?: PendingTaskReview[];
      /** Is THIS attachment the workspace's lead agent — either because it
       *  already held the seat, or because it just claimed an empty one? The
       *  lead is the addressee for goal-edit re-triage, so a fresh context
       *  needs to know which it is without a second call. */
      lead: boolean;
    }
  | { ok: false; error: 'workspace-not-found' };

export type HeartbeatResult =
  | { ok: true; attachment: AgentAttachment; queuedVoice?: QueuedVoiceRequest[] }
  | { ok: false; error: 'not-found' };

/** Where a workspace's attachment records persist — their own sidecar, so
 *  heartbeat churn never rewrites the task data (§4.1: "state sidecars —
 *  tasks, invites, attachments"). */
export function attachmentsSidecarPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.attachments.json`);
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
  triagedAgainst?: { goalId: string; goal: string; ts: number };
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
  from: TaskStatus;
  to: TaskStatus;
  actor: TaskActor;
  note?: string;
  evidence?: TaskEvidence;
  /** What the task cost in tokens (agent-reported at done). */
  usage?: { inputTokens: number; outputTokens: number };
  /** Was the human's live confirmation on a yellow-tier agent move (§3.4).
   *  Never emitted since the risk gate was removed 2026-08-18; kept so a
   *  reader of an older `events.jsonl` row still types. */
  confirmed?: boolean;
  /** A forward move with no evidence attached — allowed, flagged (§7.1). */
  unproven: boolean;
  ts: number;
}

/**
 * A correction attached to a transition that already happened.
 *
 * Carries no nested actor record: `actor` is the amender, and it is the one
 * field visitor redaction knows how to strip ids from, so a second copy
 * inside an amendment payload would ride the SSE feed unredacted.
 */
export interface TaskEvidenceAmendedEvent {
  type: 'task.evidence_amended';
  workspaceId: string;
  taskId: string;
  /** Which row was corrected — the transition's own timestamp. */
  transitionTs: number;
  /** What that row recorded, for a reader who has only the event. */
  to: TaskStatus;
  evidence: TaskEvidence;
  supersedes?: TaskEvidence;
  note?: string;
  actor: TaskActor;
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
   *  `workspace.retriaged` (goal edit, placed by the agent) batchId. */
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

export interface WorkspaceGoalUpdatedEvent {
  type: 'workspace.goal_updated';
  workspaceId: string;
  oldGoal: string;
  newGoal: string;
  actor: TaskActor;
  ts: number;
}

/**
 * §3.6's batched re-triage row. One per goal edit that has open tasks to
 * re-place, emitted at the same choke point as the triage REQUEST — the
 * request rides SSE only and is deliberately outside the audit log, so
 * without this a goal edit's N placements reached the activity view as N
 * unexplained individual regroupings with nothing tying them to the edit
 * that caused them (and §3.9's Decisions filter listed a row kind that could
 * never exist). Member `task.regrouped` events carry `batchId` as `partOf`.
 */
export interface WorkspaceRetriagedEvent {
  type: 'workspace.retriaged';
  workspaceId: string;
  batchId: string;
  oldGoal: string;
  newGoal: string;
  /** The OPEN tasks the edit asks the agent to re-place (done stays put). */
  taskIds: string[];
  /** Whether the request reached the live lead agent. */
  delivered: boolean;
  /** Whether an undelivered request was PERSISTED for the lead's next
   *  attach. `delivered:false, queued:true` is "waiting for them"; both
   *  false is the only case where the edit genuinely asks nobody for
   *  anything (no open tasks to re-place). */
  queued: boolean;
  actor: TaskActor;
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

export type TaskStoreEvent =
  | TaskCreatedEvent
  | TaskTransitionedEvent
  | TaskEvidenceAmendedEvent
  | TaskGateRefusedEvent
  | TaskAssignedEvent
  | TaskBodyEditedEvent
  | TaskRetitledEvent
  | TaskDueSetEvent
  | TaskRegroupedEvent
  | DecisionAnsweredEvent
  | DecisionAnswerWithdrawnEvent
  | DecisionInfoRequestedEvent
  | WorkspaceGoalUpdatedEvent
  | WorkspaceRetriagedEvent
  | WorkspaceLeadChangedEvent
  | WorkspaceGoalsChangedEvent
  | AgentAttachedEvent
  | AgentDetachedEvent
  | AgentHeartbeatEvent
  | VoiceRequestEvent;

/** One change-utterance waiting for an agent to attach (§2.4: "agent away —
 *  queued"). Persisted synchronously — "queued" is a promise, and a promise
 *  that lives only in memory dies with the process (grounded-pending). */
export interface QueuedVoiceRequest {
  /** Names this entry so a receipt can clear exactly one. Absent on rows
   *  written before the queue became the record rather than the fallback —
   *  those still drain, they just cannot be acked individually. */
  id?: string;
  /**
   * When the server last put this on the wire, or absent if it never has.
   *
   * An emitted-and-unacked entry and a lost one look identical from here, so
   * this is what the grace window is measured from: long enough that a working
   * agent has had its chance to acknowledge, short enough that a genuinely
   * lost utterance comes back quickly.
   */
  emittedAt?: number;
  transcript: string;
  context?: unknown;
  actor: TaskActor;
  /**
   * What the voice fast path ALREADY applied to the board for this utterance,
   * as the speaker was told it — present only when it applied something.
   *
   * An utterance can carry more than the one verb voice handles ("mark this
   * done and then draft the migration notes"), and with no agent live the
   * queue is the only durable channel for the rest of it. Delivering the
   * transcript alone would ask the agent to redo the half that already
   * happened; this field is how the same row says "that part is done".
   */
  applied?: string;
  ts: number;
}

/** Where a workspace's queued voice requests persist. Exported so tests
 *  assert the real contract path. */
export function voiceQueuePath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.voice-queue.json`);
}

/**
 * A goal edit whose re-triage request never reached the lead agent, waiting
 * for their next attach.
 *
 * At most ONE per workspace: successive edits in the same gap coalesce into
 * a single ask — `oldGoal` stays the baseline the placements were last
 * judged against (the FIRST undelivered edit's), `newGoal` and `batchId`
 * take the newest values, and `taskIds` unions. Two separate asks would make
 * the agent walk the same tasks twice against a goal that is already stale.
 */
export interface PendingRetriage {
  /** The newest `workspace.retriaged` row this stands for. The agent echoes
   *  it on each placement so N moves read as one goal edit. */
  batchId: string;
  oldGoal: string;
  newGoal: string;
  taskIds: string[];
  actor: TaskActor;
  /** When the first undelivered edit in this pending happened. */
  ts: number;
}

/** Where a workspace's undelivered re-triage waits. Its own sidecar, like
 *  the voice queue: a promise to the person who edited the goal, so it must
 *  not ride a debounce that a crash can drop. Exported so tests assert the
 *  real contract path rather than a re-implementation of it. */
export function pendingRetriagePath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.retriage.json`);
}

/**
 * The "a band appeared, re-look at the bucket" ask waiting for this
 * workspace's lead, mirrored from its own sidecar.
 *
 * At most ONE per workspace, coalescing exactly like `PendingRetriage`:
 * `oldGoals` and `ts` stay with the FIRST undelivered edit (that is the list
 * the bucket was last looked at against), `newGoals` and `batchId` take the
 * newest, `taskIds` and `newBands` union. Two separate asks would walk the
 * same bucket twice against a list that is already stale.
 *
 * Its own record rather than a field on `PendingRetriage`: that one's
 * baseline is the north-star TEXT and this one's is the goal LIST, and a
 * lead who answers one has not answered the other.
 */
export interface PendingBucketReview {
  /** The `workspace.goals_changed` batch this stands for — echoed on each
   *  placement so the moves read as part of that edit. */
  batchId: string;
  /** Bands that appeared across the undelivered edits, union. */
  newBands: GoalBand[];
  taskIds: string[];
  /** The goal list before the FIRST undelivered edit. */
  oldGoals: WorkspaceGoal[];
  /** The goal list as it stood after the NEWEST one. */
  newGoals: WorkspaceGoal[];
  actor: TaskActor;
  /** When the first undelivered edit in this pending happened. */
  ts: number;
}

/** Where a workspace's undelivered bucket re-look waits. Its own sidecar for
 *  the same reason the re-triage has one — a promise that lives only in
 *  memory dies with the process — and separate from it because the two asks
 *  are answered independently. */
export function pendingBucketReviewPath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.bucket.json`);
}

export type SetWorkspaceGoalResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the new text equals the old — a no-op edit emits no
       *  event and requests no re-triage (it would churn timestamps for a
       *  change nobody made). */
      changed: boolean;
      /** `taskIds` = the open tasks a re-triage covers; `requested` = whether
       *  the request reached the live lead agent; `queued` = whether an
       *  undelivered one was persisted for the lead's next attach. The edit
       *  survives the lead being busy or absent — it waits rather than
       *  expiring (§3.4). */
      retriage: { requested: boolean; queued: boolean; taskIds: string[]; batchId?: string };
    }
  | { ok: false; error: 'workspace-not-found' };

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
  | { ok: false; error: 'workspace-not-found' };

export type AnswerDecisionResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' | 'unknown-option' };

export type WithdrawAnswerResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' | 'no-answer' };

export type RequestMoreInfoResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' };

export type AddReviewItemResult =
  | {
      ok: true;
      task: Task;
      item: TaskReviewItem;
      /** The shared checker's GAPS, phrased as what to write. Advice on a
       *  successful create, never a refusal — see `reviewGapAdvice`. */
      advice?: string;
    }
  | {
      ok: false;
      error: 'not-found' | 'bad-review';
      /** The gate's verbatim refusal, written to land in a retrying model's
       *  context. Present exactly when `error` is 'bad-review'. */
      message?: string;
    };

export type AnswerTaskReviewResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | {
      ok: false;
      error: 'not-found' | 'unknown-review-item' | 'unknown-option' | 'not-a-decision';
    };

export type RequestInfoOnReviewResult =
  | { ok: true; task: Task; item: TaskReviewItem }
  | { ok: false; error: 'not-found' | 'unknown-review-item' | 'not-a-decision' };

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

export type SetTaskGoalResult =
  | {
      ok: true;
      task: Task;
      /** False when the goal and position both stayed put — a triage confirm.
       *  No task.regrouped fires for it, but the triage stamp still lands. */
      changed: boolean;
    }
  | { ok: false; error: 'not-found' | 'unknown-goal' | 'unknown-after' };

/** The board's sort, spelled once. `order` is a float a caller chose and
 *  nothing has ever forced it to be unique within a goal, so the two
 *  tiebreaks are reachable in ordinary data rather than theoretical. The
 *  browser's `byBoardOrder` (hub-model.ts) must stay identical to this — a
 *  placement computed at one end and applied at the other is only meaningful
 *  while both agree on what "after" means. */
export function byBoardOrder(
  a: { order: number; createdAt: number; id: string },
  b: { order: number; createdAt: number; id: string },
): number {
  return a.order - b.order || a.createdAt - b.createdAt || a.id.localeCompare(b.id);
}

/**
 * The sequence a goal should hold once `moving` is placed directly behind the
 * row `after` names — `null` meaning the top of the goal.
 *
 * `siblings` is the goal's other rows ALREADY in board order. Returns null
 * when `after` names none of them, which is the caller's cue to refuse rather
 * than to guess: a placement relative to a row that is not there is a request
 * whose meaning we do not know, and dropping the row at the bottom (the
 * tempting fallback) is indistinguishable to the person who dragged it from
 * the bug this whole path exists to fix.
 */
export function sequenceAfter<T extends { id: string }>(
  siblings: readonly T[],
  moving: T,
  after: string | null,
): T[] | null {
  let index: number;
  if (after === null) {
    index = 0;
  } else {
    const at = siblings.findIndex((t) => t.id === after);
    if (at === -1) return null;
    index = at + 1;
  }
  return [...siblings.slice(0, index), moving, ...siblings.slice(index)];
}

/**
 * One entry of a submitted goal list. The id is OPTIONAL, and which way it
 * goes is the whole contract (§3.2, restated once goal ids are generated):
 *
 *  - **`id` present** — "this is the band you already have". It must name a
 *    goal or subgoal this board holds right now; anything else is refused as
 *    `unknown-goal-id`. That is the refusal that makes a re-key
 *    unexpressible: there is no input here that can hand an existing band a
 *    different id, and no input that can hand a NEW band an id of the
 *    caller's choosing.
 *  - **`id` absent** — "create this band". The server generates an opaque id
 *    (`newGoalId`) and reports it in `created`, in submission order.
 *
 * So submitting a list now means: these are my bands, in this order, and the
 * ones I did not name an id for are new. Everything else the call could ever
 * do it still does — reorder, retitle, reparent, remove (gated) — none of
 * which touch an id.
 */
export interface GoalListEntry {
  /** Omit to CREATE. Present = must already exist on this board. */
  id?: string;
  title: string;
  dueAt?: number;
  subgoals?: Array<{ id?: string; title: string; dueAt?: number }>;
}

export type SetGoalListResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the new list deep-equals the old — no event, no moves. */
      changed: boolean;
      /** Goals and subgoals this call CREATED, in submission order (parents
       *  before their subgoals), with the id the server generated for each.
       *  The only way a caller learns a new band's id — which is the point:
       *  they never chose it. */
      created: Array<{ id: string; title: string; parent?: string }>;
      /** Open tasks whose goal or subgoal id disappeared, moved to Backlog —
       *  reported so the caller can re-place them (§3.2 edit contract). */
      movedToChores: string[];
      /** DONE tasks left pointing at a goal id the list no longer has. They
       *  deliberately stay put — a done placement is history, not a claim
       *  about current priorities — but they are what produces the bare
       *  `reorderable: false` row in `get_workspace`, and until this field
       *  existed nothing reported them at all. Re-place them with
       *  `set_task_goal` if you want the row gone. */
      strandedDone: string[];
      /** Whether this edit revealed a new band and therefore asked the lead
       *  to re-look at the unknown-goal bucket. `taskIds` is that bucket and
       *  `newBands` what appeared — both empty when nothing was revealed (a
       *  reorder, a retitle) or the bucket was empty. `requested` = it
       *  reached the live lead; `queued` = the lead was away and it is
       *  WAITING for their next attach. Never a placement: the ask is to
       *  look. */
      bucketReview: {
        requested: boolean;
        queued: boolean;
        taskIds: string[];
        newBands: GoalBand[];
        batchId?: string;
      };
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
      /** Every goal or subgoal id the submitted list drops that still holds
       *  tasks, with what it holds. Nothing was written — the caller either
       *  meant a RENAME (use `renameGoal`, which cannot move a task) or
       *  meant the removal, in which case naming these ids in `drop` says so
       *  explicitly. A caller working from a stale read cannot name a goal it
       *  never saw, which is the exact case this refuses. */
      stranding: Array<{ id: string; title: string; openTasks: number; doneTasks: number }>;
    };

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
}

interface WorkspaceState {
  workspace: HubWorkspace;
  tasks: Map<string, Task>;
  /** agentId → attachment (§4). Keyed per workspace, so the same agentId in
   *  two workspaces is two independent records. */
  attachments: Map<string, AgentAttachment>;
  /** The goal edit waiting for the lead agent, mirrored from its sidecar.
   *  Held in memory because the projection re-reads it on every refresh. */
  pendingRetriage?: PendingRetriage;
  /** The "a band appeared" bucket re-look waiting for the lead agent,
   *  mirrored from its own sidecar. */
  pendingBucketReview?: PendingBucketReview;
  /** Task writes waiting for the lead's review pass, mirrored from their
   *  own sidecar. */
  pendingTaskReviews?: PendingTaskReview[];
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

function cryptoId(prefix: string): string {
  // 9 random bytes → 12 base64url chars. URL-safe, filename-safe, and every
  // char is legal in a docId (the future `task:<id>` body rooms need that).
  return `${prefix}-${randomBytes(9).toString('base64url')}`;
}

/**
 * The id of the review item DERIVED from a task's legacy decision fields.
 *
 * Fixed rather than minted, and that is what makes the derivation safe to run
 * on every read: the same task always derives the same id, so an answer
 * addressed at it lands on the same row no matter how many times anything
 * re-derived it. A minted id would make a read a write.
 *
 * It cannot collide with a real one: `cryptoId('r')` emits `r-` plus twelve
 * base64url characters, and this is six.
 */
export const LEGACY_REVIEW_ITEM_ID = 'r-legacy';

/**
 * The id of a NEWLY CREATED goal. Opaque and server-generated, exactly like a
 * task id, and for the same reason: an identifier is the one thing that must
 * never move, so nothing about it may encode something that does.
 *
 * The scheme this replaces was caller-supplied slugs (`g1-loop`, `g2-reach`),
 * which put PRIORITY — the fastest-moving property a board has — inside the
 * identity. Renaming a band then meant re-keying it, and re-keying it through
 * the full-replace `setGoalList` reads as one goal removed and a different one
 * added: the band's open tasks swept to Backlog, its done tasks orphaned. The
 * `would-strand-tasks` refusal defends against that; generated ids make it
 * unexpressible, which is the stronger move.
 *
 * Existing slug ids keep working forever — they are just ids. This generates
 * the ones created from here on; nothing renumbers what a board already has.
 */
export function newGoalId(): string {
  return cryptoId('g');
}

export class TaskStore {
  private workspaces = new Map<string, WorkspaceState>();
  private taskIndex = new Map<string, string>(); // taskId → workspaceId
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private attachmentSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dataDir: string;
  private debounceMs: number;
  private attachmentThresholds: AttachmentThresholds;
  private triageDelivery: TriageDelivery | undefined;
  private deliveryProbe: DeliveryProbe | undefined;
  private readonly voiceAckGraceMs: number;
  private agentStreamProbe: AgentStreamProbe | undefined;
  private eventListeners = new Set<(event: TaskStoreEvent) => void>();

  constructor(opts: {
    dataDir: string;
    debounceMs?: number;
    /** Attachment liveness knobs — overridable so tests never burn real
     *  minutes (§6: delivery timings configurable). */
    heartbeatFreshMs?: number;
    toolCallStaleMs?: number;
    observedWorkFreshMs?: number;
    /** How long an emitted voice entry is left alone before it is offered
     *  again. Overridable so tests never burn real minutes. */
    voiceAckGraceMs?: number;
  }) {
    this.dataDir = opts.dataDir;
    this.debounceMs = opts.debounceMs ?? 200;
    this.voiceAckGraceMs = opts.voiceAckGraceMs ?? VOICE_ACK_GRACE_MS;
    this.attachmentThresholds = {
      ...(opts.heartbeatFreshMs !== undefined ? { heartbeatFreshMs: opts.heartbeatFreshMs } : {}),
      ...(opts.toolCallStaleMs !== undefined ? { toolCallStaleMs: opts.toolCallStaleMs } : {}),
      ...(opts.observedWorkFreshMs !== undefined
        ? { observedWorkFreshMs: opts.observedWorkFreshMs }
        : {}),
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

  /** Wire (or clear) the bridge that carries triage requests to a live
   *  attached agent. The attachment registry commit installs the real one. */
  setTriageDelivery(delivery: TriageDelivery | undefined): void {
    this.triageDelivery = delivery;
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

  /** Emit a triage request. True ONLY if it reached a live attachment — a
   *  throwing/absent delivery grounds to false, never to a broken caller. */
  private requestTriage(req: TriageRequest): boolean {
    if (!this.triageDelivery) return false;
    try {
      return this.triageDelivery(req) === true;
    } catch (err) {
      console.error('[tasks] triage delivery threw:', err);
      return false;
    }
  }

  // ── Workspaces ───────────────────────────────────────────────────────────

  createWorkspace(name: string, goal?: string, opts?: { leadAgentId?: string }): HubWorkspace {
    const now = Date.now();
    const lead = opts?.leadAgentId?.trim();
    const workspace: HubWorkspace = {
      id: cryptoId('w'),
      name,
      goal: goal ?? '',
      goalUpdatedAt: now,
      goals: [],
      docIds: [],
      // The creating agent is the lead by default. No event: nothing is
      // subscribed to a workspace that did not exist a line ago.
      ...(lead ? { leadAgentId: lead, leadAgentSince: now } : {}),
      createdAt: now,
    };
    this.workspaces.set(workspace.id, { workspace, tasks: new Map(), attachments: new Map() });
    this.scheduleSave(workspace.id);
    return workspace;
  }

  getWorkspace(id: string): HubWorkspace | undefined {
    return this.workspaces.get(id)?.workspace;
  }

  /**
   * How many of a board's tasks are still open — the guard `deleteWorkspace`
   * applies, exposed so a caller can check it BEFORE doing work the refusal
   * would waste (the route tears down rooms first). `null` when there is no
   * such board, which is a different answer from zero.
   */
  openTaskCount(workspaceId: string): number | null {
    const state = this.workspaces.get(workspaceId);
    if (!state) return null;
    return Array.from(state.tasks.values()).filter((t) => t.status !== 'done').length;
  }

  /**
   * Remove a hub workspace and everything this store holds for it.
   *
   * Guarded by open tasks the way `Rooms.deleteWorkspace` is guarded by open
   * threads: the mistake to make hard is discarding a board somebody is
   * working, and a bare id with no confirmation is exactly the call an agent
   * makes by accident. `force` is the deliberate override, and the refusal
   * carries the count so the caller does not have to go and look.
   *
   * Deletion has to reach DISK, not just the map: the sidecar is
   * authoritative on hydrate, so an in-memory-only delete looks completely
   * successful until the next restart brings the board back. The events log
   * goes with it — an audit trail for a board nobody can see is a file that
   * only grows.
   *
   * Returns the task ids so the caller can tear down each one's body room;
   * this store owns no rooms and deliberately does not reach into them.
   */
  deleteWorkspace(
    workspaceId: string,
    opts?: { force?: boolean },
  ):
    | { ok: true; deletedTasks: number; taskIds: string[] }
    | { ok: false; error: 'not-found' }
    | { ok: false; error: 'has-open-tasks'; openTasks: number }
    | { ok: false; error: 'persist-failed' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'not-found' };

    const taskIds = Array.from(state.tasks.keys());
    if (!opts?.force) {
      const openTasks = this.openTaskCount(workspaceId) ?? 0;
      if (openTasks > 0) return { ok: false, error: 'has-open-tasks', openTasks };
    }

    // Cancel pending writes BEFORE removing the files, or a debounced save
    // still in flight recreates the sidecar milliseconds after the delete
    // reports success.
    const pending = this.saveTimers.get(workspaceId);
    if (pending) clearTimeout(pending);
    this.saveTimers.delete(workspaceId);
    const pendingAttachments = this.attachmentSaveTimers.get(workspaceId);
    if (pendingAttachments) clearTimeout(pendingAttachments);
    this.attachmentSaveTimers.delete(workspaceId);
    // If the delete goes on to refuse, the workspace stays live and those
    // writes are still owed. Nothing else would re-arm them until the next
    // mutation, so the edits inside the debounce window would be lost at the
    // next restart — a cancelled save is only free when the delete succeeds.
    const restorePendingWrites = () => {
      if (pending) this.scheduleSave(workspaceId);
      if (pendingAttachments) this.scheduleAttachmentsSave(workspaceId);
    };

    // The tasks sidecar is the resurrection source, so it comes off FIRST and
    // its failure is the whole operation's failure. Reporting success with
    // that file intact would promise a deletion the next restart undoes —
    // silently, and hours later. Nothing in memory has changed yet at this
    // point, so refusing here leaves a coherent board rather than a half-
    // deleted one. (The cancelled save is the cost: at most one debounce
    // window of unwritten changes, which the next mutation reschedules.)
    try {
      rmSync(tasksSidecarPath(this.dataDir, workspaceId), { force: true });
    } catch (err) {
      console.error(`[tasks] failed to remove the tasks sidecar for ${workspaceId}:`, err);
      restorePendingWrites();
      return { ok: false, error: 'persist-failed' };
    }

    for (const taskId of taskIds) this.taskIndex.delete(taskId);
    this.workspaces.delete(workspaceId);

    // None of these can resurrect the board, so a failure here is litter
    // rather than a lie — log it and let the delete stand. The list is every
    // OTHER per-workspace path this file exports; a new sidecar belongs here
    // the day it is added, or it becomes a file nothing can reach.
    for (const path of [
      attachmentsSidecarPath(this.dataDir, workspaceId),
      eventsLogPath(this.dataDir, workspaceId),
      voiceQueuePath(this.dataDir, workspaceId),
      pendingRetriagePath(this.dataDir, workspaceId),
      pendingBucketReviewPath(this.dataDir, workspaceId),
      pendingTaskReviewsPath(this.dataDir, workspaceId),
    ]) {
      try {
        rmSync(path, { force: true });
      } catch (err) {
        console.error(`[tasks] failed to remove ${path}:`, err);
      }
    }
    return { ok: true, deletedTasks: taskIds.length, taskIds };
  }

  listWorkspaces(): HubWorkspace[] {
    return Array.from(this.workspaces.values()).map((s) => s.workspace);
  }

  /**
   * Write (or clear) the ≤20-word line the surfaces display in place of the
   * goal. Blank text clears it — an empty summary is not a compliant short
   * one, it is the absence of one, and the clip is what should show.
   *
   * Deliberately quiet: no event, no re-triage, no `goalUpdatedAt` bump. This
   * changes how the goal READS, never what it says, so nothing downstream of
   * the goal has anything to reconsider. The board sees it through the same
   * projection refresh as every other workspace field.
   */
  setGoalSummary(
    workspaceId: string,
    summary: string,
  ): { ok: true; workspace: HubWorkspace } | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    this.applyGoalSummary(workspaceId, summary);
    this.scheduleSave(workspaceId);
    return { ok: true, workspace: state.workspace };
  }

  /** The one place the field is written, so the hash can never be computed
   *  against a goal other than the one currently stored. */
  private applyGoalSummary(workspaceId: string, summary: string): void {
    const state = this.workspaces.get(workspaceId);
    if (!state) return;
    const text = summary.trim();
    state.workspace.goalSummary =
      text === ''
        ? undefined
        : { text, goalHash: goalTextHash(state.workspace.goal), ts: Date.now() };
  }

  /**
   * Edit the workspace's north-star goal (§3.4: the input to every intake
   * decision). Emits `workspace.goal_updated` (old goal, new goal, actor)
   * and requests a re-triage of the OPEN tasks — done stays put. The
   * re-triage EXECUTES in the lead agent; this method only emits the
   * request.
   *
   * The request is addressed to the LEAD agent, and it does not expire. With
   * the lead away it is persisted and handed over on their next attach — a
   * goal edit made while nobody was looking used to vanish with nothing but
   * a `delivered:false` row to show for it.
   *
   * `opts.summary` sets the ≤20-word display line in the same call. It is
   * applied whether or not the goal text moved, so re-wording the line is a
   * one-field edit rather than a re-statement of the whole north star.
   */
  setWorkspaceGoal(
    workspaceId: string,
    goal: string,
    opts: { actor: { id: string; name: string; kind?: string }; summary?: string },
  ): SetWorkspaceGoalResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;

    if (goal === workspace.goal) {
      // Nothing changed, so nothing to announce and nothing to re-triage —
      // every placement's triagedAgainst is still accurate. A summary sent
      // alongside it still lands: it describes the same goal. And it has to
      // be SAVED here — this branch returns before the write below, so a
      // summary-only edit was surviving in memory and in the projection
      // (which is what a reviewer sees) while disappearing at the next
      // restart. The two together are exactly how a lost write hides.
      if (opts.summary !== undefined) {
        this.applyGoalSummary(workspaceId, opts.summary);
        this.scheduleSave(workspaceId);
      }
      return {
        ok: true,
        workspace,
        changed: false,
        retriage: { requested: false, queued: false, taskIds: [] },
      };
    }

    const ts = Date.now();
    const oldGoal = workspace.goal;
    workspace.goal = goal;
    workspace.goalUpdatedAt = ts;
    // The old display line described the old goal. Keeping it would leave the
    // most-viewed text on the board saying something the workspace is no
    // longer aiming at, which is the one thing a shortened goal must not do.
    // A caller that has a better line supplies it in the same call; anyone
    // else sees the deterministic clip of the NEW goal until one arrives.
    workspace.goalSummary = undefined;
    if (opts.summary !== undefined) this.applyGoalSummary(workspaceId, opts.summary);
    this.scheduleSave(workspaceId);

    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    this.emit({ type: 'workspace.goal_updated', workspaceId, oldGoal, newGoal: goal, actor, ts });

    // Re-triage covers open tasks only (§3.4). One batched request, not one
    // per task — delivery collapses to a single item in the agent's context.
    const taskIds = Array.from(state.tasks.values())
      .filter((t) => t.status !== 'done')
      .map((t) => t.id);
    if (taskIds.length === 0) {
      // Nothing to re-place, so there is nothing to deliver OR to queue.
      // Both flags false also covers a queue write that FAILED (logged) —
      // in both cases nobody is durably waiting on this edit, which is the
      // question the flags answer.
      return {
        ok: true,
        workspace,
        changed: true,
        retriage: { requested: false, queued: false, taskIds },
      };
    }
    // The request rides SSE and is gone; the ROW is what the activity view
    // and the after-the-fact review read, so it is emitted whether or not
    // delivery found the lead — `delivered` and `queued` say which happened.
    const batchId = cryptoId('rt');
    const requested = this.requestTriage({
      kind: 'goal-retriage',
      workspaceId,
      oldGoal,
      newGoal: goal,
      taskIds,
      batchId,
      ...(workspace.leadAgentId !== undefined ? { leadAgentId: workspace.leadAgentId } : {}),
      actor,
      ts,
    });
    // Delivered or not, the workspace is now at the new goal — so a request
    // still waiting from an EARLIER gap describes a baseline that no longer
    // exists. Either it just went out live (superseded) or it merges into
    // the one being queued below; both paths go through here.
    let queued = false;
    if (requested) {
      this.clearPendingRetriage(state);
    } else {
      queued = this.queuePendingRetriage(state, {
        batchId,
        oldGoal,
        newGoal: goal,
        taskIds,
        actor,
        ts,
      });
    }
    this.emit({
      type: 'workspace.retriaged',
      workspaceId,
      batchId,
      oldGoal,
      newGoal: goal,
      taskIds,
      delivered: requested,
      queued,
      actor,
      ts,
    });
    return {
      ok: true,
      workspace,
      changed: true,
      retriage: { requested, queued, taskIds, batchId },
    };
  }

  // ── Pending re-triage (the goal edit that outlives the gap) ───────────────

  /**
   * The goal edit waiting for this workspace's lead agent, or undefined.
   *
   * Read-and-PRUNE: task ids that have since gone `done` (or been dropped)
   * are filtered out, and a request with nothing left to re-place retires
   * itself. Pruning here rather than at every mutation site is deliberate —
   * "which tasks still need re-placing" is a question about the CURRENT
   * board, and answering it from a snapshot taken minutes ago is how a
   * queued promise turns into a request for work that no longer exists.
   */
  getPendingRetriage(workspaceId: string): PendingRetriage | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state?.pendingRetriage) return undefined;
    const pending = state.pendingRetriage;
    const live = pending.taskIds.filter((id) => {
      const task = state.tasks.get(id);
      return task !== undefined && task.status !== 'done';
    });
    if (live.length === 0) {
      this.clearPendingRetriage(state);
      return undefined;
    }
    if (live.length !== pending.taskIds.length) {
      state.pendingRetriage = { ...pending, taskIds: live };
      this.writePendingRetriage(state);
    }
    return state.pendingRetriage;
  }

  /**
   * Persist an undelivered re-triage for the lead's next attach, coalescing
   * with anything already waiting: the baseline `oldGoal` and `ts` stay with
   * the FIRST undelivered edit (that is what the placements were last judged
   * against), while the newest goal and batch win and the task lists union.
   *
   * SYNCHRONOUS write, like the voice queue: the caller is about to tell the
   * person who edited the goal that a re-triage is waiting, and an ack
   * grounded in a debounce a crash can drop is the summaries-incident lie.
   */
  private queuePendingRetriage(state: WorkspaceState, next: PendingRetriage): boolean {
    const prev = state.pendingRetriage;
    state.pendingRetriage = prev
      ? {
          batchId: next.batchId,
          oldGoal: prev.oldGoal,
          newGoal: next.newGoal,
          taskIds: Array.from(new Set([...prev.taskIds, ...next.taskIds])),
          actor: next.actor,
          ts: prev.ts,
        }
      : next;
    return this.writePendingRetriage(state);
  }

  /**
   * @returns whether the request is actually on disk. The caller ACKS with
   * this: "queued" is a restart-proof promise, so a swallowed write turns the
   * ack into exactly the lie the synchronous write exists to prevent. The
   * in-memory copy is kept either way — it can still be handed over during
   * this process lifetime — so a false here under-promises rather than
   * over-promises.
   */
  private writePendingRetriage(state: WorkspaceState): boolean {
    const path = pendingRetriagePath(this.dataDir, state.workspace.id);
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ pending: state.pendingRetriage }, null, 2)}\n`);
      return true;
    } catch (err) {
      console.error(`[tasks] failed to queue re-triage for ${state.workspace.id}:`, err);
      return false;
    }
  }

  private clearPendingRetriage(state: WorkspaceState): void {
    if (state.pendingRetriage === undefined) return;
    state.pendingRetriage = undefined;
    try {
      rmSync(pendingRetriagePath(this.dataDir, state.workspace.id), { force: true });
    } catch {}
  }

  /** Load a workspace's waiting re-triage, if any. A corrupt sidecar loses
   *  the request, never the workspace. */
  private loadPendingRetriage(workspaceId: string): PendingRetriage | undefined {
    const path = pendingRetriagePath(this.dataDir, workspaceId);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pending?: PendingRetriage };
      const pending = parsed.pending;
      if (!pending || typeof pending.batchId !== 'string' || !Array.isArray(pending.taskIds)) {
        return undefined;
      }
      return pending;
    } catch (err) {
      console.error(`[tasks] unreadable re-triage sidecar for ${workspaceId} — skipped:`, err);
      return undefined;
    }
  }

  /**
   * Hand the board's lead-agent seat to `leadAgentId`. Reassignment is a
   * first-class operation rather than a side effect of attaching, because
   * "who is responsible" outlives any one session: the agent that holds it
   * may be away, and the next goal edit still has an addressee.
   */
  setLeadAgent(
    workspaceId: string,
    leadAgentId: string,
    opts: { actor: { id: string; name: string; kind?: string }; takeover?: boolean },
  ): SetLeadAgentResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    const next = leadAgentId.trim();
    if (next === workspace.leadAgentId) return { ok: true, workspace, changed: false };
    const previousLeadAgentId = workspace.leadAgentId;
    /**
     * DO NOT let an agent quietly take a seat somebody LIVE is sitting in.
     *
     * `attachAgent` refuses this on purpose — "an occupied seat is a standing
     * decision and a second agent attaching is not a reassignment" — and
     * `set_workspace_lead` had no such guard, which was survivable while it
     * meant "hand the board to a named peer" and became a hazard the moment
     * the skills started telling every session to declare itself at startup.
     * The displaced lead keeps its watch and its attachment, is told nothing
     * it acts on, and simply never receives the re-triage it was waiting for;
     * the declaring agent cannot tell a takeover from an empty seat, because
     * `changed: true` is the same answer for both.
     *
     * Narrow on purpose. It fires only when an agent is claiming the seat FOR
     * ITSELF (a declaration) — naming a third party is a deliberate handover
     * and keeps its old meaning exactly. And only against a LIVE incumbent: a
     * dead session's seat is exactly what a new lead should be able to
     * recover, which is most of why declaring works at all.
     */
    if (
      previousLeadAgentId !== undefined &&
      previousLeadAgentId !== next &&
      next === opts.actor.id &&
      opts.takeover !== true &&
      this.hasLiveLeadAttachment(workspaceId)
    ) {
      return { ok: true, workspace, changed: false, previousLeadAgentId, declined: 'lead-held' };
    }
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // Its own operation, so its own moment — nothing else in this call is
    // stamped, and there is no sibling clock for it to disagree with.
    this.assignLead(state, next, actor, Date.now());
    // A waiting request is addressed to the SEAT, not to the agent that was
    // sitting in it — so a handover has to re-ask the new occupant. Draining
    // happens on attach, and an agent that is ALREADY attached has no next
    // attach: without this the request waits on a reconnect that may never
    // come, with its addressee live the whole time. Away leads are unaffected
    // — `hasLiveLeadAttachment` is false for them and it keeps waiting.
    const pending = this.getPendingRetriage(workspaceId);
    if (pending && this.hasLiveLeadAttachment(workspaceId)) {
      const delivered = this.requestTriage({
        kind: 'goal-retriage',
        workspaceId,
        oldGoal: pending.oldGoal,
        newGoal: pending.newGoal,
        taskIds: pending.taskIds,
        batchId: pending.batchId,
        leadAgentId: next,
        actor: pending.actor,
        ts: pending.ts,
      });
      // Only on success — a request that did not go out must stay queued
      // rather than being dropped by the attempt to deliver it.
      if (delivered) this.clearPendingRetriage(state);
    }
    // The bucket re-look is addressed to the same seat, so a handover has to
    // re-ask the new occupant for it too.
    const bucket = this.getPendingBucketReview(workspaceId);
    if (bucket && this.hasLiveLeadAttachment(workspaceId)) {
      const delivered = this.requestTriage({
        kind: 'bucket-review',
        workspaceId,
        newBands: bucket.newBands,
        taskIds: bucket.taskIds,
        oldGoals: bucket.oldGoals,
        newGoals: bucket.newGoals,
        leadAgentId: next,
        batchId: bucket.batchId,
        actor: bucket.actor,
        ts: bucket.ts,
      });
      if (delivered) this.clearPendingBucketReview(state);
    }
    // Waiting task reviews are addressed to the same seat. Re-deliver each
    // to the new live occupant; whatever fails to go out stays queued.
    const reviews = this.getPendingTaskReviews(workspaceId);
    if (reviews && this.hasLiveLeadAttachment(workspaceId)) {
      const undelivered = reviews.filter((r) => {
        const reviewTask = state.tasks.get(r.taskId);
        if (!reviewTask) return false;
        return !this.requestTriage({
          kind: 'task-review',
          workspaceId,
          taskId: r.taskId,
          title: reviewTask.title,
          trigger: r.trigger,
          leadAgentId: next,
          ...(r.actor !== undefined ? { actor: r.actor } : {}),
          ts: r.ts,
        });
      });
      if (undelivered.length === 0) this.clearPendingTaskReviews(state);
      else {
        state.pendingTaskReviews = undelivered;
        this.writePendingTaskReviews(state);
      }
    }
    return {
      ok: true,
      workspace,
      changed: true,
      ...(previousLeadAgentId !== undefined ? { previousLeadAgentId } : {}),
    };
  }

  /** The seat change itself, shared by `setLeadAgent` and the attach-time
   *  claim so both persist and announce it identically.
   *
   *  `ts` is the CALLER's, and passing it is not a style choice. A seat claim
   *  emits `workspace.lead_changed`, which is a non-`agent.*` row, so
   *  `noteObservedWork` observes it and stamps the actor's work clock with
   *  this exact `ts`. When the caller is `attachAgent`, that work clock and
   *  the attachment's `lastHeartbeat` are the SAME fact — one operation, one
   *  moment — and a `Date.now()` taken here instead landed a millisecond
   *  later, pushing `lastToolCallAt` past `lastHeartbeat` and breaking the
   *  "a new attachment's two clocks are equal" contract on ~1 run in 37.
   *
   *  So the parameter is required rather than defaulted: a future third
   *  caller has to say which moment this seat change belongs to, and cannot
   *  re-read the wall clock by omission. */
  private assignLead(
    state: WorkspaceState,
    leadAgentId: string,
    actor: TaskActor,
    ts: number,
  ): void {
    const workspace = state.workspace;
    const oldLeadAgentId = workspace.leadAgentId;
    workspace.leadAgentId = leadAgentId;
    workspace.leadAgentSince = ts;
    this.scheduleSave(workspace.id);
    this.emit({
      type: 'workspace.lead_changed',
      workspaceId: workspace.id,
      ...(oldLeadAgentId !== undefined ? { oldLeadAgentId } : {}),
      leadAgentId,
      actor,
      ts,
    });
  }

  /** Link an existing doc or review to a hub workspace. A link only — the
   *  doc's own metadata and URLs are untouched (nothing is migrated). */
  attachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true } | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    if (!state.workspace.docIds.includes(docId)) {
      state.workspace.docIds.push(docId);
      this.scheduleSave(workspaceId);
    }
    return { ok: true };
  }

  /** Unlink a doc from a hub workspace. `removed` distinguishes "it was
   *  linked and now isn't" from "it was never linked" — the caller filing a
   *  doc out of the holding-pen workspace needs to know whether anything
   *  actually moved before it refreshes a projection. */
  detachDoc(
    workspaceId: string,
    docId: string,
  ): { ok: true; removed: boolean } | { ok: false; error: 'workspace-not-found' } {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const i = state.workspace.docIds.indexOf(docId);
    if (i === -1) return { ok: true, removed: false };
    state.workspace.docIds.splice(i, 1);
    this.scheduleSave(workspaceId);
    return { ok: true, removed: true };
  }

  /**
   * The hub workspace this docId belongs to for SHARE-SCOPE purposes, or
   * null (§3.12 commit 8): a doc linked via attachDoc, or a task's own body
   * room (`task:<taskId>`). Deliberately NOT the `ws:<id>` board room — its
   * share allowance is explicit in host-guard, so granting the board stays
   * a decision rather than a resolver side effect. Also deliberately not
   * transitive: attachDoc can link a whole legacy grouping (diff review) by
   * its grouping id, and this resolver does not widen to that grouping's
   * member docs.
   */
  workspaceOfDoc(docId: string): string | null {
    if (docId.startsWith('task:')) {
      return this.getTask(docId.slice('task:'.length))?.workspaceId ?? null;
    }
    for (const state of this.workspaces.values()) {
      if (state.workspace.docIds.includes(docId)) return state.workspace.id;
    }
    return null;
  }

  // ── Tasks ────────────────────────────────────────────────────────────────

  createTask(workspaceId: string, opts: CreateTaskOpts): CreateTaskResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };

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
    const assigneeKind = declaredAssigneeKind(opts.assignee ?? '', opts.assigneeKind, opts.actor);
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
      ...(opts.needs !== undefined ? { needs: opts.needs } : {}),
      ...(options.length > 0 ? { options } : {}),
      goal,
      order,
      status: 'todo',
      after,
      ...(afterEnforce.length > 0 ? { afterEnforce } : {}),
      ...(opts.dueAt !== undefined ? { dueAt: opts.dueAt } : {}),
      links: opts.links ?? [],
      ...(opts.origin !== undefined ? { origin: opts.origin } : {}),
      ...(opts.quote !== undefined ? { quote: opts.quote } : {}),
      transitions: [],
      createdAt: now,
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

    // Triage hook (§3.4): an OMITTED goal means "needs placing" — the task
    // has already landed at the bottom of Backlog (the resting state; the
    // human is never blocked on placement), and the server emits a triage
    // request for the attached agent to act on. The pending marker is
    // stamped ONLY when that request actually reached a live attachment.
    // An explicit goal — even an explicit 'chores' — is a placement by the
    // caller, not a triage candidate.
    let triageDelivered = false;
    if (opts.goal === undefined) {
      // The DURABLE half, written before the request is attempted and
      // deliberately not conditioned on it: delivery decides whether a
      // request went out, never whether a placement was named. An undelivered
      // request used to leave no trace of the review it owed.
      task.unplacedSince = now;
      triageDelivered = this.requestTriage({
        kind: 'task',
        workspaceId,
        taskId: task.id,
        goal: state.workspace.goal,
        ts: now,
      });
      if (triageDelivered) task.triagePendingTs = Date.now();
    }

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
    // The correction loop, PLACED rows only: an unplaced create's shaping is
    // already the placement request's ask (and the untriaged sweep's, when
    // nobody was home), so asking again here would say the same thing twice.
    if (opts.goal !== undefined) this.requestTaskReview(task, 'created', opts.actor);
    return {
      ok: true,
      task,
      placement: { placed: opts.goal !== undefined, triageDelivered },
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

  listTasks(workspaceId: string, filter?: ListTasksFilter): Task[] {
    const state = this.workspaces.get(workspaceId);
    if (!state) return [];
    let tasks = Array.from(state.tasks.values());
    if (filter?.goal !== undefined) tasks = tasks.filter((t) => t.goal === filter.goal);
    if (filter?.status !== undefined) tasks = tasks.filter((t) => t.status === filter.status);
    if (filter?.assignee !== undefined) tasks = tasks.filter((t) => t.assignee === filter.assignee);
    if (filter?.needs !== undefined) tasks = tasks.filter((t) => t.needs === filter.needs);
    return tasks.sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  }

  /**
   * The single gate for status changes (§3.10). Every change is attributed
   * (`classifyActor` decides person vs agent — the same line the reply-reopens
   * rule draws, reused rather than reinvented) and appended to the task's
   * audit trail with whatever evidence was supplied.
   *
   * Gate semantics, in order:
   *  - unknown task / unknown status / no-op same-status → validation errors.
   *  - moving FORWARD (to in-progress or done) consults `after`: open
   *    dependencies come back as `blockers` in the result; an edge marked
   *    enforce refuses outright. Moving back to todo never consults the gate
   *    (undoing work must not be blockable).
   *  - `unproven` marks a forward move that attached no evidence: allowed,
   *    flagged, never refused (§7.1 — the worst this can do is draw attention
   *    to something that turned out to be fine).
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
      evidence?: TaskEvidence;
      usage?: { inputTokens: number; outputTokens: number };
      /** Accepted and IGNORED since 2026-08-18. It carried the human's live
       *  confirmation for a yellow-tier forward move; the risk gate is gone,
       *  but peers on older bundles keep sending this until they restart and
       *  a payload that suddenly fails validation is how a removal breaks
       *  them. Do not turn this into a rejection. */
      confirmed?: boolean;
    },
  ): TransitionResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!TASK_STATUSES.has(to)) return { ok: false, error: 'bad-status' };
    if (task.status === to) {
      // Historically the whole answer, and for the commonest reason to
      // re-send a transition — "the move is right, the metadata was wrong" —
      // it was a dead end: the row kept whatever evidence it had (none, or a
      // sha that resolves to nothing) and no verb could change it. The
      // refusal now names the door instead of ending the conversation.
      return {
        ok: false,
        error: 'same-status',
        message: `${task.title} is already ${to}. If the move was right and the EVIDENCE was wrong or missing, amend it: POST /api/tasks/${task.id}/evidence (MCP: amend_evidence) appends a correction to the transition that already happened.`,
      };
    }

    const forward = to === 'in-progress' || to === 'done';
    const blockers = forward ? this.openBlockers(task) : [];
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
      ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
    };
    task.transitions.push(entry);
    task.status = to;
    task.updatedAt = entry.ts;
    this.scheduleSave(task.workspaceId);

    // One spelling of the shading predicate, shared with the board (`@feedback
    // /core/evidence`). Note it asks whether the evidence CLAIMS anything, so
    // a caller that sends `evidence: {}` is flagged the same as one that sent
    // nothing — which is what an empty object honestly means.
    const unproven = transitionUnproven(entry);
    this.emit({
      type: 'task.transitioned',
      workspaceId: task.workspaceId,
      taskId: task.id,
      from: entry.from,
      to,
      actor: by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
      unproven,
      ts: entry.ts,
    });
    return { ok: true, task, blockers, unproven };
  }

  /**
   * Attach evidence to a transition that has already been recorded.
   *
   * The gate above is the single door for STATUS, and it refuses a move that
   * would change nothing — correctly, because re-running a transition is not
   * how you fix its metadata. That left one real case with no answer at all:
   * the move was right and the proof was wrong. It happened twice in a week,
   * with different causes — an `evidence` object dropped before it reached
   * the server, and a commit sha written from memory that resolves to
   * nothing — and both left a finished task permanently mis-marked, the
   * second one in the worse direction, since a bad sha reads as proof.
   *
   * So this appends rather than rewrites. The transition keeps its own
   * `evidence` untouched, and the correction lands beside it carrying who,
   * when, and what it supersedes. Consequences worth stating:
   *
   *  - the `unproven` shading clears, because the row now HAS proof and a
   *    permanent alarm about a metadata slip is the harm being removed. The
   *    narrower fact — that the proof arrived late — stays visible in the
   *    row itself rather than on the board;
   *  - an amendment can only ever ADD a claim. Empty evidence is refused, so
   *    no correction can blank the proof it was sent to repair;
   *  - status is untouched. Amending is not a transition and never gates.
   *
   * Which row: `transitionTs` names one exactly, and the default is the most
   * recent — the move you just made, which is when this is nearly always
   * needed. Two transitions in the same millisecond would share a ts; the
   * later one wins, deterministically.
   *
   * NOT validated: whether a commit sha resolves. See the tool description —
   * `TaskEvidence` carries a bare sha with no repo coordinate, and a hub
   * workspace has no repo either, so this server genuinely cannot look one
   * up. A guess would refuse legitimate corrections (an unpushed commit is
   * unreachable to anyone but its author), and a check that blocks the fix
   * is worse than no check.
   */
  amendEvidence(
    taskId: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      evidence: TaskEvidence;
      note?: string;
      /** Which transition — defaults to the most recent. */
      transitionTs?: number;
    },
  ): AmendEvidenceResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.transitions.length === 0) {
      return {
        ok: false,
        error: 'no-transitions',
        message: `${task.title} has never moved, so there is no transition to attach evidence to.`,
      };
    }
    const evidence = normalizeEvidence(opts.evidence);
    if (!evidence) {
      return {
        ok: false,
        error: 'empty-evidence',
        message:
          'An amendment must carry a commit or a threadRef. An empty evidence object claims nothing, and accepting one would let a correction erase the proof it was sent to fix.',
      };
    }

    let target: TaskTransition | undefined;
    if (opts.transitionTs === undefined) {
      target = task.transitions[task.transitions.length - 1];
    } else {
      // Last match wins: the trail is append-only, so a shared ts means two
      // moves inside one millisecond and the later one is the live claim.
      for (let i = task.transitions.length - 1; i >= 0; i--) {
        const t = task.transitions[i];
        if (t && t.ts === opts.transitionTs) {
          target = t;
          break;
        }
      }
      if (!target) {
        return {
          ok: false,
          error: 'transition-not-found',
          message: `No transition at ts ${opts.transitionTs} on ${task.title}. Read the task's transitions and use one of their ts values, or omit transitionTs to amend the most recent move.`,
        };
      }
    }
    if (!target) return { ok: false, error: 'no-transitions' };

    // What this correction replaces: the newest claim standing on the row,
    // which is the previous amendment's if there is one. Saying it supersedes
    // the ORIGINAL evidence after a second correction would assert that the
    // first bad sha was still live, which it was not.
    const standing = target.amendments?.at(-1)?.evidence ?? target.evidence;
    const supersedes = normalizeEvidence(standing);

    const amendment: TaskEvidenceAmendment = {
      ts: Date.now(),
      by: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      evidence,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(supersedes !== undefined ? { supersedes } : {}),
    };
    target.amendments = [...(target.amendments ?? []), amendment];
    task.updatedAt = amendment.ts;
    this.scheduleSave(task.workspaceId);

    this.emit({
      type: 'task.evidence_amended',
      workspaceId: task.workspaceId,
      taskId: task.id,
      transitionTs: target.ts,
      to: target.to,
      evidence,
      ...(supersedes !== undefined ? { supersedes } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      actor: amendment.by,
      ts: amendment.ts,
    });
    return { ok: true, task, transition: target, amendment, unproven: transitionUnproven(target) };
  }

  /**
   * Record a decision's VERBATIM answer (§3.2: decisions keep the human's
   * exact words) and emit `decision.answered` carrying the text, the actor,
   * and the decision task's links — a ready-made propagation checklist for
   * the attached agent (§3.6). Recording the answer does NOT transition the
   * task: status changes stay with the single gate, and what the answer
   * unblocks is the agent's next move, not this method's side effect.
   */
  answerDecision(
    taskId: string,
    text: string,
    opts: { actor: { id: string; name: string; kind?: string }; optionId?: string },
  ): AnswerDecisionResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    // An optionId that resolves to nothing would record an answer whose
    // provenance is a lie — and the UI's whole point is that tapping a
    // candidate is the same act as writing its words.
    if (opts.optionId !== undefined && !task.options?.some((o) => o.id === opts.optionId)) {
      return { ok: false, error: 'unknown-option' };
    }
    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // A second answer landing over a standing one is a race, not a rewrite
    // request — two browsers both showing the unanswered card, the slower tap
    // arriving after the faster one recorded. Last write stands (the panel's
    // busy-disable is DOM-local, so the server is the only place this can be
    // handled), but the displaced words move to `answerHistory` exactly as an
    // undo would move them: overwriting IS a withdrawal, performed by the
    // overwriting actor, and a hard delete here is the loss that field was
    // added to prevent.
    if (task.answer) {
      task.answerHistory = [
        ...(task.answerHistory ?? []),
        { ...task.answer, withdrawnAt: ts, withdrawnBy: actor.name },
      ];
    }
    // `by` is the display name — the projection ships display names, not ids
    // (§3.3 visitor contract), and the event carries the full actor anyway.
    // `text` stays the answer whether it was typed or tapped: an option is a
    // shortcut to words, never a replacement for them.
    task.answer = {
      text,
      by: actor.name,
      ts,
      ...(opts.optionId !== undefined ? { optionId: opts.optionId } : {}),
    };
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'decision.answered',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: text,
      ...(opts.optionId !== undefined ? { optionId: opts.optionId } : {}),
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
  }

  /**
   * Take an answer back.
   *
   * Answering is one click with no confirmation step, and a stray one on a
   * phone used to be permanent — the surface offered no way back, and the
   * words were gone the moment a second answer overwrote them. This is the
   * way back, and it is a SOFT delete: the answer moves to `answerHistory`
   * with who withdrew it and when, so the record of what was decided (and
   * un-decided) survives, which is the project-wide rule for user content.
   *
   * Refuses when there is nothing to withdraw rather than succeeding
   * vacuously: two readers racing the same undo must not both be told they
   * took something back.
   */
  withdrawAnswer(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): WithdrawAnswerResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    const answer = task.answer;
    if (!answer) return { ok: false, error: 'no-answer' };
    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    task.answerHistory = [
      ...(task.answerHistory ?? []),
      { ...answer, withdrawnAt: ts, withdrawnBy: actor.name },
    ];
    task.answer = undefined;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'decision.answer_withdrawn',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: answer.text,
      answeredBy: answer.by,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
  }

  /**
   * Ask a decision for more context INSTEAD of answering it — the third
   * first-class response next to picking an option and writing your own
   * answer, and the one that keeps options from becoming a closed set.
   *
   * Nothing about the task's status or answer changes: it stays open, stays
   * counted at the top of the board, and stays in the walkthrough. What the
   * attached agent owes back is context, which is why this is its own event
   * rather than an answer carrying a flag.
   */
  requestMoreInfo(
    taskId: string,
    question: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): RequestMoreInfoResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    task.infoRequests = [...(task.infoRequests ?? []), { text: question, by: actor.name, ts }];
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'decision.info_requested',
      workspaceId: task.workspaceId,
      taskId: task.id,
      question,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
  }

  // ── Review items: 0..n per ticket ─────────────────────────────────────────

  /**
   * Attach a review item to a ticket.
   *
   * `review` arrives as `unknown` because every door into this is a route
   * carrying parsed JSON, and it is gated by `checkReviewPayload` — THE
   * checker, the same one comment-borne declarations pass through. Writing a
   * second gate here is precisely the "two spellings of one concept" this
   * whole change deletes: a second copy of a limit is how a card ends up
   * rendering something the API swore it had refused.
   *
   * The stored payload is the one `readReviewPayload` normalizes out of the
   * input, so caller-supplied junk keys never reach the sidecar. Option ids
   * are the CALLER'S — `checkReviewPayload` already demands they exist and be
   * unique within the item, and re-minting them would break an `answeredWith`
   * a client had already put on screen. Only the item id is minted here,
   * `r-<crypto>`, the way options mint `o-<crypto>`.
   *
   * `gaps` come back as `advice` on SUCCESS. They were computed and read by
   * nobody in the first cut of this feature: the call returned 200, the card
   * came out thinner than the author meant, and nothing connected the two.
   */
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    const check = checkReviewPayload(review);
    if (!check.ok) {
      return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
    }
    const payload = readReviewPayload(review);
    // Unreachable for anything the gate passed — kept because "the checker said
    // yes and the reader said no" must not become an undefined write.
    if (!payload) {
      return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
    }

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const item: TaskReviewItem = {
      id: cryptoId('r'),
      review: payload,
      createdAt: ts,
      // Display name, like every other projected `by` (§3.3 visitor contract).
      createdBy: actor.name,
    };
    task.reviews = [...(task.reviews ?? []), item];
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);

    const advice = reviewGapAdvice(check.gaps);
    return { ok: true, task, item, ...(advice !== undefined ? { advice } : {}) };
  }

  /**
   * Every review item on a ticket, in order.
   *
   * When the ticket IS a legacy decision, one derived row leads the list with
   * the fixed id `r-legacy`. The derivation happens at READ time and writes
   * nothing: it is idempotent by construction and cannot double-apply across a
   * restart, which is strictly safer than the lazy back-fill `hydrateFromDisk`
   * does for `unplacedSince`. Nothing is purged either — `needs`, `options`,
   * `answer` and `infoRequests` keep being read and written exactly as before.
   *
   * Real rows do NOT suppress the derived one, and that is a correction rather
   * than a preference. Suppressing on "a stored row exists" keys the decision
   * on the wrong fact: the legacy decision is a SEPARATE open question from
   * whatever somebody filed later, so the moment a ticket gained its second
   * question the first one silently left this list — and with it `GET
   * /review-items`, which is the one route that answers "what is waiting on
   * me". The derived row leaves for exactly one reason now: the decision was
   * answered, at which point it is still LISTED and merely closed.
   *
   * It leads rather than trails because it is the oldest question on the
   * ticket (`createdAt` is the task's own), and this queue is oldest-first.
   *
   * Rows are read through `readTaskReviewItem`, so a row corrupted on disk
   * drops out of the list instead of throwing inside a renderer that never
   * touched this ticket — and because the derived row no longer depends on how
   * many raw rows there are, an unreadable one can no longer take the legacy
   * decision down with it.
   */
  listReviewItems(taskId: string): TaskReviewItem[] {
    const task = this.getTask(taskId);
    if (!task) return [];
    const out: TaskReviewItem[] = [];
    const legacy = this.legacyReviewItem(task);
    if (legacy) out.push(legacy);
    for (const raw of task.reviews ?? []) {
      const item = readTaskReviewItem(raw);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * The one legacy decision as a review item, or undefined when there is none.
   *
   * ONE rule, in ONE place, because three callers ask it — the reader above
   * and both answer paths. If the answer paths resolved `r-legacy` under a
   * different condition than the reader lists it under, a row nothing shows
   * would still accept answers.
   *
   * The payload mapping is `reviewFromDecisionTask` in core (pure, mints
   * nothing). What is added here is the ROW around it: the task's own clock,
   * and — the part that matters — the legacy `answer` carried across, because
   * an answered decision read as open is a queue that never empties.
   *
   * `createdBy` is deliberately empty. No legacy decision recorded who RAISED
   * it; `assignee` is who has to answer it, which is a different person, and
   * writing it here would attribute the question to the wrong one.
   */
  private legacyReviewItem(task: Task): TaskReviewItem | undefined {
    // `needs === 'decision'` is the WHOLE condition. It used to also require
    // that no stored row existed, which made an unanswered decision disappear
    // from every reader as soon as somebody filed a second question on the
    // same ticket — see `listReviewItems` for why that is the wrong key.
    if (task.needs !== 'decision') return undefined;
    const review: ReviewPayload = reviewFromDecisionTask(task);
    const item: TaskReviewItem = {
      id: LEGACY_REVIEW_ITEM_ID,
      review,
      createdAt: task.createdAt,
      createdBy: '',
    };
    if (task.answer) {
      item.answer = {
        text: task.answer.text,
        by: task.answer.by,
        ts: task.answer.ts,
        ...(task.answer.optionId !== undefined ? { answeredWith: task.answer.optionId } : {}),
      };
    }
    if (task.infoRequests && task.infoRequests.length > 0) {
      item.infoRequests = task.infoRequests.map((r) => ({ text: r.text, by: r.by, ts: r.ts }));
    }
    return item;
  }

  /**
   * Answer ONE review item on a ticket, leaving its siblings open.
   *
   * `r-legacy` DELEGATES to `answerDecision`, untouched. That is the whole
   * back-compat story in one line: `task.answer`, the `optionId` validation
   * and the `decision.answered` payload stay byte-identical for every caller
   * that never heard of review items, and there is no second implementation of
   * "record a decision's answer" free to drift from the first.
   */
  answerTaskReview(
    taskId: string,
    reviewItemId: string,
    text: string,
    opts: { actor: { id: string; name: string; kind?: string }; answeredWith?: string },
  ): AnswerTaskReviewResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    if (reviewItemId === LEGACY_REVIEW_ITEM_ID && this.legacyReviewItem(task)) {
      const res = this.answerDecision(taskId, text, {
        actor: opts.actor,
        ...(opts.answeredWith !== undefined ? { optionId: opts.answeredWith } : {}),
      });
      if (!res.ok) return res;
      const item = this.legacyReviewItem(res.task);
      // The row exists — it resolved a line above — so this only guards the
      // type. An answer recorded is never reported as a failure.
      if (!item) return { ok: false, error: 'unknown-review-item' };
      return { ok: true, task: res.task, item };
    }

    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    // An `answeredWith` that resolves to no option ON THIS ROW would record an
    // answer whose provenance is a lie — and with several rows on one ticket,
    // a neighbour's option id is the easy way to write that lie by accident.
    if (
      opts.answeredWith !== undefined &&
      !item.review.options?.some((o) => o.id === opts.answeredWith)
    ) {
      return { ok: false, error: 'unknown-option' };
    }

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // Answering twice is legal — somebody changes their mind, a retry lands,
    // two people reach for the same row — but the words already recorded are
    // USER CONTENT and this project does not hard-delete user content. The
    // superseded answer moves aside instead of being written over; nothing
    // else anywhere would have reported that it was gone.
    if (item.answer) item.priorAnswers = [...(item.priorAnswers ?? []), item.answer];
    item.answer = {
      text,
      by: actor.name,
      ts,
      ...(opts.answeredWith !== undefined ? { answeredWith: opts.answeredWith } : {}),
    };
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'decision.answered',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: text,
      ...(opts.answeredWith !== undefined ? { optionId: opts.answeredWith } : {}),
      reviewItemId,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task, item };
  }

  /**
   * Ask ONE review item for more context instead of answering it.
   *
   * Carried over deliberately. "Tell me more" is a shipped first-class
   * response with no counterpart in `ReviewPayload`, so unifying the two
   * spellings without it would have quietly deleted a capability people use.
   * The item stays open and stays counted — that is the point of it being its
   * own thing rather than an answer carrying a flag.
   *
   * `r-legacy` delegates to the untouched `requestMoreInfo`, same as above.
   */
  requestMoreInfoOnReview(
    taskId: string,
    reviewItemId: string,
    question: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): RequestInfoOnReviewResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };

    if (reviewItemId === LEGACY_REVIEW_ITEM_ID && this.legacyReviewItem(task)) {
      const res = this.requestMoreInfo(taskId, question, { actor: opts.actor });
      if (!res.ok) return res;
      const item = this.legacyReviewItem(res.task);
      if (!item) return { ok: false, error: 'unknown-review-item' };
      return { ok: true, task: res.task, item };
    }

    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    item.infoRequests = [...(item.infoRequests ?? []), { text: question, by: actor.name, ts }];
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'decision.info_requested',
      workspaceId: task.workspaceId,
      taskId: task.id,
      question,
      reviewItemId,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task, item };
  }

  /**
   * Replace a task's dependency edges after it was created.
   *
   * This did not exist, and its absence is what made urgency underivable:
   * "this decision is blocking work now" is the same fact as "something
   * depends on it", `after` already records that, and `after` could only ever
   * be set at creation — when the decision being waited on often doesn't
   * exist yet. Every decision on the real board therefore had an empty
   * `after`, and nothing could tell blocking from parked.
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
   * reviewing skill's prompt, reached by `requestTaskReview` — so a raw
   * capture still lands.
   */
  private applyTitle(task: Task, title: string): void {
    task.title = title;
    task.titleWrittenAt = Date.now();
    task.titleHead = bodyHead(task.body);
  }

  /**
   * The correction loop's trigger. Called after an attributed write of a
   * title or body; the workspace's LEAD is asked to review the row over the
   * same delivery bridge every triage request rides. The JUDGMENT — does
   * the title read as `<persona> can <do x> so that <goal y>`, does the
   * body open with a problem statement — lives in the reviewing skill's prompt, not
   * here (Bryan, 2026-08-18: the code-written format check moved into an
   * LLM prompt), so EVERY write routes and the reviewer decides fine as-is
   * / rewrite / ask the filer. Decision rows route too: they are exempt
   * from the story shape, and the prompt knows that, but a muddy question
   * is exactly what a reviewer with context can sharpen.
   *
   * Fire-and-forget for the writer — the write has already landed and
   * nothing here can refuse it. An undelivered ask is not lost: it is
   * queued to the workspace's sidecar and drained on the lead's next
   * attach.
   *
   * The one exemption: the LEAD's own writes are never re-addressed to the
   * lead. Its rewrites ARE the review, and a lead sweeping a board must not
   * generate one request per pass of its own.
   */
  private requestTaskReview(
    task: Task,
    trigger: TaskReviewTrigger,
    actor?: { id: string; name: string; kind?: string },
  ): void {
    const state = this.workspaces.get(task.workspaceId);
    if (!state) return;
    if (actor !== undefined && actor.id === state.workspace.leadAgentId) return;
    const ts = Date.now();
    const taskActor: TaskActor | undefined =
      actor !== undefined
        ? { id: actor.id, name: actor.name, kind: classifyActor(actor) }
        : undefined;
    const delivered = this.requestTriage({
      kind: 'task-review',
      workspaceId: task.workspaceId,
      taskId: task.id,
      title: task.title,
      trigger,
      ...(state.workspace.leadAgentId !== undefined
        ? { leadAgentId: state.workspace.leadAgentId }
        : {}),
      ...(taskActor !== undefined ? { actor: taskActor } : {}),
      ts,
    });
    if (!delivered) {
      this.queuePendingTaskReview(state, {
        taskId: task.id,
        trigger,
        ...(taskActor !== undefined ? { actor: taskActor } : {}),
        ts,
      });
    }
  }

  /**
   * The task reviews waiting for this workspace's lead, pruned read-time:
   * rows that have since gone done (or vanished) drop out — same reasoning
   * as `getPendingRetriage`, "which rows still need a look" is a question
   * about the CURRENT board, not about a snapshot taken when they queued.
   */
  getPendingTaskReviews(workspaceId: string): PendingTaskReview[] | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state?.pendingTaskReviews) return undefined;
    const live = state.pendingTaskReviews.filter((r) => {
      const task = state.tasks.get(r.taskId);
      return task !== undefined && task.status !== 'done';
    });
    if (live.length === 0) {
      this.clearPendingTaskReviews(state);
      return undefined;
    }
    if (live.length !== state.pendingTaskReviews.length) {
      state.pendingTaskReviews = live;
      this.writePendingTaskReviews(state);
    }
    return state.pendingTaskReviews;
  }

  /** Coalesce by row: a second undelivered write to the same task updates
   *  the trigger and the addressee but keeps the FIRST `ts` — one review
   *  per row, aged from when it started waiting. Synchronous write, same
   *  contract as the re-triage queue: the queue is a promise, and a promise
   *  grounded in a debounce a crash can drop is a lie. */
  private queuePendingTaskReview(state: WorkspaceState, next: PendingTaskReview): void {
    const prev = state.pendingTaskReviews ?? [];
    const existing = prev.find((r) => r.taskId === next.taskId);
    state.pendingTaskReviews = existing
      ? prev.map((r) => (r.taskId === next.taskId ? { ...next, ts: existing.ts } : r))
      : [...prev, next];
    this.writePendingTaskReviews(state);
  }

  private writePendingTaskReviews(state: WorkspaceState): void {
    const path = pendingTaskReviewsPath(this.dataDir, state.workspace.id);
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ pending: state.pendingTaskReviews }, null, 2)}\n`);
    } catch (err) {
      console.error(`[tasks] failed to queue task review for ${state.workspace.id}:`, err);
    }
  }

  private clearPendingTaskReviews(state: WorkspaceState): void {
    if (state.pendingTaskReviews === undefined) return;
    state.pendingTaskReviews = undefined;
    try {
      rmSync(pendingTaskReviewsPath(this.dataDir, state.workspace.id), { force: true });
    } catch {}
  }

  /** Load a workspace's waiting task reviews, if any. A corrupt sidecar
   *  loses the queue, never the workspace. */
  private loadPendingTaskReviews(workspaceId: string): PendingTaskReview[] | undefined {
    const path = pendingTaskReviewsPath(this.dataDir, workspaceId);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pending?: PendingTaskReview[] };
      const pending = parsed.pending;
      if (!Array.isArray(pending)) return undefined;
      const rows = pending.filter((r) => typeof r?.taskId === 'string');
      return rows.length > 0 ? rows : undefined;
    } catch (err) {
      console.error(`[tasks] unreadable task-review sidecar for ${workspaceId} — skipped:`, err);
      return undefined;
    }
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
    if (task.title === title) return { ok: true, task, changed: false };
    const titleFrom = task.title;
    this.applyTitle(task, title);
    const ts = Date.now();
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
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
    this.requestTaskReview(task, 'renamed', opts.actor);
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
    if (nextTitle && nextTitle !== titleFrom) this.applyTitle(task, nextTitle);
    task.updatedAt = ts;
    task.bodyWrittenAt = ts;
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
    this.requestTaskReview(task, 'edited', opts.actor);
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
   * Place a task under a goal (or subgoal) at an exact position — the write
   * half of triage (§3.4: the agent picks the exact spot, not just the
   * bucket) and the board's regroup/rerank gesture (§3.3: open to everyone,
   * Bryan AND agents; every move recorded).
   *
   * Placement IS triage, so every call — moved or confirmed in place —
   * stamps `triagedAgainst` with the goal text it was judged against and
   * clears the triage-pending marker. A goal or position change emits
   * `task.regrouped`; a pure confirm emits nothing — §3.6 has no
   * task.triaged row, and a no-move event would be noise in every feed.
   */
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
      /** The `workspace.retriaged` batch this placement fulfils, echoed from
       *  the triage request. Stamped on `task.regrouped` as `partOf` so the
       *  activity view reads N moves as one goal edit. */
      batchId?: string;
    },
  ): SetTaskGoalResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const state = this.workspaces.get(task.workspaceId);
    if (!state) return { ok: false, error: 'not-found' };
    if (!this.goalIdExists(state.workspace, goal)) {
      return { ok: false, error: 'unknown-goal' };
    }

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const fromGoal = task.goal;

    // Placement by neighbour renumbers the goal 1..N rather than searching for
    // a float between two rows, because between two rows that share an order
    // there is no such float — and a goal that keeps its ties needs the same
    // step-around on every future drag. So the drop that had to work around a
    // tie is also the drop that removes it. `updatedAt` is deliberately left
    // alone on the rows this shifts: their position relative to each other did
    // not change, and the staleness sweep and the activity feed both read that
    // field as "somebody touched this task".
    let renumbered: Task[] | null = null;
    let order: number;
    if (opts.after !== undefined) {
      const siblings = Array.from(state.tasks.values())
        .filter((t) => t.goal === goal && t.id !== taskId)
        .sort(byBoardOrder);
      const sequence = sequenceAfter(siblings, task, opts.after);
      if (!sequence) return { ok: false, error: 'unknown-after' };
      renumbered = sequence;
      order = sequence.indexOf(task) + 1;
    } else {
      order =
        opts.position ??
        (goal === fromGoal
          ? task.order
          : Math.max(
              0,
              ...Array.from(state.tasks.values())
                .filter((t) => t.goal === goal && t.id !== taskId)
                .map((t) => t.order),
            ) + 1);
    }
    const changed = goal !== fromGoal || order !== task.order;

    task.goal = goal;
    task.order = order;
    if (renumbered) for (const [i, t] of renumbered.entries()) t.order = i + 1;
    task.triagedAgainst = { goalId: goal, goal: state.workspace.goal, ts };
    // The placement fulfils whatever triage request stamped the marker.
    // Assignment, not delete (biome noDelete); JSON.stringify drops it from
    // the sidecar either way, same as the hydrate-time clear.
    task.triagePendingTs = undefined;
    // Somebody has now named this task's band — including a confirm-in-place
    // into Backlog, which is a judgement rather than a fallback. The owed
    // review is answered, so it must not be asked again.
    task.unplacedSince = undefined;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);

    if (changed) {
      this.emit({
        type: 'task.regrouped',
        workspaceId: task.workspaceId,
        taskId: task.id,
        fromGoal,
        toGoal: goal,
        order,
        actor,
        ...(opts.batchId !== undefined ? { partOf: opts.batchId } : {}),
        ts,
      });
    }
    return { ok: true, task, changed };
  }

  /**
   * Replace the workspace's ordered goal list (§3.2 goal-list edit contract).
   *
   * WHAT SUBMITTING A LIST MEANS, now that ids are generated: "these are my
   * bands, in this order". An entry that names an `id` is a band the board
   * already has — an id it does not have is REFUSED (`unknown-goal-id`),
   * never created under the caller's name. An entry with no `id` is new, and
   * the server mints an opaque one (`newGoalId`) and reports it in `created`.
   * A caller therefore cannot choose an id, and cannot change one: the two
   * gestures that used to strand a band's work are no longer expressible,
   * where before they were merely refused after the fact. Everything the call
   * always did — reorder, retitle, reparent, remove — is untouched, and none
   * of it moves an id.
   *
   * 'chores' is reserved and never present in goals[]; open tasks whose goal
   * or subgoal id disappears are moved to Backlog, each emitting a
   * `task.regrouped` batched (via `partOf`) under the one
   * `workspace.goals_changed` event, and the result reports the moved ids so
   * the caller can re-place them. Deliberately NO re-triage request fires —
   * a reorder changes no placement's accuracy, and a removal already lands
   * every affected task where the caller is told to look.
   *
   * A DROP THAT WOULD STRAND WORK IS REFUSED unless `drop` names the id.
   * This is a full replace keyed by id, so the natural way to rename a band —
   * submit the list with a new id and the new title — reads here as one goal
   * removed and a different one added: the old band's open tasks swept to
   * Backlog, its done tasks left pointing at an id that is gone, and a
   * successful-looking result. The damage is proportional to how much the
   * band held, and it surfaces days later as "why is my top band empty".
   * `renameGoal` is the non-destructive way to change a title; this guard is
   * what makes the destructive path stop being the DEFAULT one. It fires
   * only for ids that actually hold tasks, so it can never refuse a call
   * that was about to lose nothing.
   */
  setGoalList(
    workspaceId: string,
    entries: GoalListEntry[],
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** Goal/subgoal ids the caller INTENDS to remove even though they hold
       *  tasks. Consulted only as a lookup set: an entry for an id that is
       *  not being removed does nothing, so it can never widen the replace. */
      drop?: string[];
    },
  ): SetGoalListResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;

    // Resolve every entry to an id BEFORE anything is compared or written:
    // an id the caller named must already exist, and an id the caller omitted
    // is generated here and nowhere else. Both refusals are computed over the
    // whole list first, so a rejected call names every offending id at once
    // rather than making the caller fix them one round trip at a time.
    const existingIds = new Set(flattenGoals(workspace.goals).map((g) => g.id));
    const submittedIds: string[] = [];
    const unknownIds: string[] = [];
    const reserved: string[] = [];
    const noteId = (id: string | undefined): void => {
      if (id === undefined) return;
      submittedIds.push(id);
      if (isReservedGoalId(id)) {
        if (!reserved.includes(id)) reserved.push(id);
        return;
      }
      if (!existingIds.has(id) && !unknownIds.includes(id)) unknownIds.push(id);
    };
    for (const g of entries) {
      noteId(g.id);
      for (const s of g.subgoals ?? []) noteId(s.id);
    }
    if (reserved.length > 0) return { ok: false, error: 'reserved-goal-id' };
    if (new Set(submittedIds).size !== submittedIds.length) {
      return { ok: false, error: 'duplicate-goal-id' };
    }
    if (unknownIds.length > 0) return { ok: false, error: 'unknown-goal-id', unknownIds };

    // Materialise the list the board will hold. An entry with no id becomes a
    // new band with a generated one; nothing else about an entry can change
    // an id, because an id is never read from the entry again after this.
    const created: Array<{ id: string; title: string; parent?: string }> = [];
    const goals: WorkspaceGoal[] = entries.map((g) => {
      const id = g.id ?? newGoalId();
      if (g.id === undefined) created.push({ id, title: g.title });
      const subgoals = g.subgoals?.map((s) => {
        const subId = s.id ?? newGoalId();
        if (s.id === undefined) created.push({ id: subId, title: s.title, parent: id });
        return {
          id: subId,
          title: s.title,
          ...(s.dueAt !== undefined ? { dueAt: s.dueAt } : {}),
        };
      });
      return {
        id,
        title: g.title,
        ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}),
        ...(subgoals !== undefined ? { subgoals } : {}),
      };
    });
    const ids: string[] = [];
    for (const g of goals) {
      ids.push(g.id);
      for (const s of g.subgoals ?? []) ids.push(s.id);
    }

    const oldGoals = workspace.goals;
    if (JSON.stringify(oldGoals) === JSON.stringify(goals)) {
      return {
        ok: true,
        workspace,
        changed: false,
        created: [],
        movedToChores: [],
        strandedDone: [],
        bucketReview: { requested: false, queued: false, taskIds: [], newBands: [] },
      };
    }

    // What this replace would REMOVE, and what each removal holds. Computed
    // before a single byte is written, because a refusal has to leave the
    // board exactly as the caller found it.
    const keptIds = new Set(ids);
    const acknowledged = new Set(opts.drop ?? []);
    const stranding: Array<{ id: string; title: string; openTasks: number; doneTasks: number }> =
      [];
    for (const removed of flattenGoals(oldGoals)) {
      if (keptIds.has(removed.id) || acknowledged.has(removed.id)) continue;
      let openTasks = 0;
      let doneTasks = 0;
      for (const task of state.tasks.values()) {
        if (task.goal !== removed.id) continue;
        if (task.status === 'done') doneTasks += 1;
        else openTasks += 1;
      }
      // Both halves count. The open one is swept to Backlog (loud-ish, it is
      // reported); the done one silently orphans, and is the half nothing
      // used to mention.
      if (openTasks + doneTasks > 0) {
        stranding.push({ id: removed.id, title: removed.title, openTasks, doneTasks });
      }
    }
    if (stranding.length > 0) return { ok: false, error: 'would-strand-tasks', stranding };

    // Bands that APPEARED — the reason to re-look at the bucket. Computed
    // from the ID sets at both scopes, not from `kind` below: `kind:'edit'`
    // also covers a retitle and a dueAt change, neither of which adds a place
    // a task could go. A band is "apparent" when it becomes a destination.
    const oldBandIds = new Set(flattenGoals(oldGoals).map((g) => g.id));
    const newBands: GoalBand[] = flattenGoals(goals)
      .filter((g) => !oldBandIds.has(g.id))
      .map((g) => ({ id: g.id, title: g.title }));

    // Same members in a different order = the priority gesture; anything
    // else (add / remove / retitle / dueAt) = an edit. Sorting by id makes
    // the comparison order-blind.
    const sortById = (gs: WorkspaceGoal[]) =>
      JSON.stringify([...gs].sort((a, b) => a.id.localeCompare(b.id)));
    const kind: 'reorder' | 'edit' = sortById(oldGoals) === sortById(goals) ? 'reorder' : 'edit';

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    workspace.goals = goals;

    // Open tasks whose goal id disappeared land at the bottom of Backlog.
    // Done tasks stay put — same rule as re-triage (§3.4), their placement
    // is history, not a claim about current priorities.
    const newIds = new Set([...ids, CHORES_GOAL_ID]);
    const moved: Array<{ task: Task; fromGoal: string }> = [];
    const strandedDone: string[] = [];
    let choresMax = Math.max(
      0,
      ...Array.from(state.tasks.values())
        .filter((t) => t.goal === CHORES_GOAL_ID)
        .map((t) => t.order),
    );
    for (const task of state.tasks.values()) {
      if (newIds.has(task.goal)) continue;
      // Done tasks stay put, but they are now NAMED: this is the half that
      // used to leave a bare row in the read with nothing in the write's
      // answer pointing at it.
      if (task.status === 'done') {
        strandedDone.push(task.id);
        continue;
      }
      moved.push({ task, fromGoal: task.goal });
      choresMax += 1;
      task.goal = CHORES_GOAL_ID;
      task.order = choresMax;
      // The band this was placed under is gone, so its placement is no longer
      // named — the bucket's other entrance. `triagedAgainst` deliberately
      // stays: it records what the placement was judged against at the time,
      // which is history. It is not a claim that the task is placed NOW, and
      // reading it as one is what hid these tasks from the sweep.
      task.unplacedSince = ts;
      task.updatedAt = ts;
    }
    this.scheduleSave(workspaceId);

    const batchId = cryptoId('gc');
    // Ask the lead to re-look at the bucket. Computed HERE — after the sweep
    // but BEFORE the emits — and both halves are load-bearing.
    //
    // After the sweep, because a task THIS edit un-placed (its band was
    // removed) belongs to the bucket the new band is being offered to;
    // "replace band A with band B" is where that matters most.
    //
    // Before the emits, because `workspace.goals_changed` is what refreshes
    // the board's projection, and a projection taken before the record exists
    // does not carry it — with no later event to correct it the chip simply
    // never appears, and the ask stays invisible until somebody attaches.
    // This path deliberately emits no store event of its own (a request is a
    // delivery, not a change, and the audit row for WHAT changed is
    // `workspace.goals_changed` itself, oldGoals and newGoals and all), so it
    // rides that one. Safe to depend on: a new band means the list changed,
    // and a changed list always emits.
    const bucketReview = this.requestBucketReview(state, {
      newBands,
      oldGoals,
      newGoals: goals,
      batchId,
      actor,
      ts,
    });
    this.emit({
      type: 'workspace.goals_changed',
      workspaceId,
      batchId,
      kind,
      oldGoals,
      newGoals: goals,
      actor,
      movedToChores: moved.map((m) => m.task.id),
      ts,
    });
    for (const { task, fromGoal } of moved) {
      this.emit({
        type: 'task.regrouped',
        workspaceId,
        taskId: task.id,
        fromGoal,
        toGoal: CHORES_GOAL_ID,
        order: task.order,
        actor,
        partOf: batchId,
        ts,
      });
    }
    return {
      ok: true,
      workspace,
      changed: true,
      created,
      movedToChores: moved.map((m) => m.task.id),
      strandedDone,
      bucketReview,
    };
  }

  /**
   * "A band appeared — re-look at the bucket." Emitted only when the edit
   * revealed a new destination AND there is something unplaced to offer it
   * to; a reorder, a retitle, or an empty bucket asks nobody anything.
   *
   * Live-or-queue, exactly like the north-star re-triage: delivered if the
   * lead is here, persisted for their next attach if not. It NEVER places —
   * an auto-assign would stamp a ranking decision no human made, invisibly,
   * and the bucket exists precisely because nobody has made that call yet.
   */
  private requestBucketReview(
    state: WorkspaceState,
    edit: {
      newBands: GoalBand[];
      oldGoals: WorkspaceGoal[];
      newGoals: WorkspaceGoal[];
      batchId: string;
      actor: TaskActor;
      ts: number;
    },
  ): {
    requested: boolean;
    queued: boolean;
    taskIds: string[];
    newBands: GoalBand[];
    batchId?: string;
  } {
    const workspaceId = state.workspace.id;
    const taskIds = this.listUntriaged(workspaceId).map((t) => t.id);
    if (edit.newBands.length === 0 || taskIds.length === 0) {
      return { requested: false, queued: false, taskIds, newBands: [] };
    }
    const requested = this.requestTriage({
      kind: 'bucket-review',
      workspaceId,
      newBands: edit.newBands,
      taskIds,
      oldGoals: edit.oldGoals,
      newGoals: edit.newGoals,
      ...(state.workspace.leadAgentId !== undefined
        ? { leadAgentId: state.workspace.leadAgentId }
        : {}),
      batchId: edit.batchId,
      actor: edit.actor,
      ts: edit.ts,
    });
    let queued = false;
    if (requested) {
      // It went out live, so anything still waiting from an earlier gap is
      // superseded — the lead is looking at the bucket against the CURRENT
      // list right now. Same rule the north-star path follows.
      this.clearPendingBucketReview(state);
    } else {
      queued = this.queuePendingBucketReview(state, {
        batchId: edit.batchId,
        newBands: edit.newBands,
        taskIds,
        oldGoals: edit.oldGoals,
        newGoals: edit.newGoals,
        actor: edit.actor,
        ts: edit.ts,
      });
    }
    // When it QUEUED, report the record that is actually waiting — a second
    // edit during the same gap merges into the first, so this edit's bands
    // alone would describe something narrower than what the lead is handed.
    // `queued: true` and `newBands` have to be about the same object.
    const waiting = queued ? state.pendingBucketReview : undefined;
    return {
      requested,
      queued,
      taskIds: waiting?.taskIds ?? taskIds,
      newBands: waiting?.newBands ?? edit.newBands,
      batchId: edit.batchId,
    };
  }

  /**
   * The bucket re-look waiting for this workspace's lead, or undefined.
   *
   * Read-and-REFRESH, for the same reason `getPendingRetriage` prunes: this
   * describes the board as it stands NOW, not as it stood when the band
   * appeared. Two things can go stale, and each retires the ask outright when
   * it empties:
   *
   *  - the BUCKET moves in both directions. A task placed or closed since the
   *    edit is gone from it, so re-asking about it is asking for work already
   *    done — and a task FILED since the edit is newly in it, unplaced, with
   *    the same new band available to it. Intersecting against the stored
   *    snapshot could only ever shrink, which quietly dropped that second
   *    task from the one ask it belongs in while the same attach response
   *    listed it under `untriaged`. So the bucket is re-read live rather
   *    than filtered; the stored ids are provenance, not the answer;
   *  - a band that has since been REMOVED is not apparent any more, and a
   *    request naming a band that no longer exists is the field-that-lies
   *    failure this record's own slot exists to avoid.
   *
   * A surviving band is REBUILT from the live list rather than replayed from
   * the record, so a rename between the capture and the attach reaches the
   * lead. Nothing else would deliver it: a retitle deliberately asks for
   * nothing (it reveals no new destination), which also means it never
   * refreshes a waiting ask — so the stored title would name a band the board
   * no longer calls that, in a request whose entire job is to say which band
   * appeared. The id is what the record is keyed on; the title is display.
   */
  getPendingBucketReview(workspaceId: string): PendingBucketReview | undefined {
    const state = this.workspaces.get(workspaceId);
    if (!state?.pendingBucketReview) return undefined;
    const pending = state.pendingBucketReview;
    const liveTasks = this.listUntriaged(workspaceId).map((t) => t.id);
    const current = new Map(flattenGoals(state.workspace.goals).map((g) => [g.id, g.title]));
    const liveBands: GoalBand[] = pending.newBands
      .filter((b) => current.has(b.id))
      .map((b) => ({ id: b.id, title: current.get(b.id) as string }));
    if (liveTasks.length === 0 || liveBands.length === 0) {
      this.clearPendingBucketReview(state);
      return undefined;
    }
    // Compare BOTH by value, not by length: a rename keeps the band count,
    // and one task placed while another is filed keeps the task count. A
    // length compare on either is a guard that passes on the exact edit it
    // exists to catch.
    if (
      JSON.stringify(liveTasks) !== JSON.stringify(pending.taskIds) ||
      JSON.stringify(liveBands) !== JSON.stringify(pending.newBands)
    ) {
      state.pendingBucketReview = { ...pending, taskIds: liveTasks, newBands: liveBands };
      this.writePendingBucketReview(state);
    }
    return state.pendingBucketReview;
  }

  /** Coalesce with anything already waiting: the FIRST undelivered edit keeps
   *  the baseline (`oldGoals`) and the provenance (`ts`, `actor`), the newest
   *  wins on list and batch, and bands and tasks union. Synchronous write,
   *  like the re-triage queue: the caller is about to be told the ask is
   *  waiting.
   *
   *  `ts` and `actor` move together on purpose. Taking the clock from the
   *  first edit and the person from the last produces a pair that reads as
   *  "this person did this then" and is true of nobody — the shape a strip
   *  renders as `Edited by <name>` beside a relative time. The ask began with
   *  the first edit, so both come from it. */
  private queuePendingBucketReview(state: WorkspaceState, next: PendingBucketReview): boolean {
    const prev = state.pendingBucketReview;
    if (prev) {
      const bands = new Map(prev.newBands.map((b) => [b.id, b]));
      // Newest title wins — a band added and then retitled in the same gap
      // should be named the way the board names it now.
      for (const b of next.newBands) bands.set(b.id, b);
      state.pendingBucketReview = {
        batchId: next.batchId,
        newBands: Array.from(bands.values()),
        taskIds: Array.from(new Set([...prev.taskIds, ...next.taskIds])),
        oldGoals: prev.oldGoals,
        newGoals: next.newGoals,
        actor: prev.actor,
        ts: prev.ts,
      };
    } else {
      state.pendingBucketReview = next;
    }
    return this.writePendingBucketReview(state);
  }

  /** @returns whether the ask is actually on disk — the caller ACKS with it,
   *  so a swallowed write must under-promise rather than over-promise. */
  private writePendingBucketReview(state: WorkspaceState): boolean {
    const path = pendingBucketReviewPath(this.dataDir, state.workspace.id);
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(path, `${JSON.stringify({ pending: state.pendingBucketReview }, null, 2)}\n`);
      return true;
    } catch (err) {
      console.error(`[tasks] failed to queue bucket review for ${state.workspace.id}:`, err);
      return false;
    }
  }

  private clearPendingBucketReview(state: WorkspaceState): void {
    if (state.pendingBucketReview === undefined) return;
    state.pendingBucketReview = undefined;
    try {
      rmSync(pendingBucketReviewPath(this.dataDir, state.workspace.id), { force: true });
    } catch {}
  }

  /** Load a workspace's waiting bucket re-look, if any. A corrupt sidecar
   *  loses the ask, never the workspace. */
  private loadPendingBucketReview(workspaceId: string): PendingBucketReview | undefined {
    const path = pendingBucketReviewPath(this.dataDir, workspaceId);
    if (!existsSync(path)) return undefined;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { pending?: PendingBucketReview };
      const pending = parsed.pending;
      // Every field the type declares non-optional, not just the ones a
      // reader happens to touch today: a truncated sidecar that loads with
      // `oldGoals` undefined puts that undefined straight back on the wire
      // inside a `TriageRequest` that declares it `WorkspaceGoal[]`, and the
      // next reader of that field is the one who finds out.
      if (
        !pending ||
        typeof pending.batchId !== 'string' ||
        typeof pending.ts !== 'number' ||
        !Array.isArray(pending.taskIds) ||
        !Array.isArray(pending.newBands) ||
        !Array.isArray(pending.oldGoals) ||
        !Array.isArray(pending.newGoals) ||
        typeof pending.actor?.id !== 'string'
      ) {
        return undefined;
      }
      return pending;
    } catch (err) {
      console.error(`[tasks] unreadable bucket-review sidecar for ${workspaceId} — skipped:`, err);
      return undefined;
    }
  }

  /**
   * Change a goal's TITLE (and optionally its dueAt) in place, at either
   * scope, without touching its id — the common half of what `set_goal_list`
   * was being used for, separated from the destructive half.
   *
   * The whole contract is that nothing can move. A task's band is its goal
   * ID, and no reachable input here changes an id, so a rename cannot sweep
   * open work to Backlog and cannot orphan a done task. That is the point:
   * before this existed, the natural gesture for "rename this band" was to
   * submit the full list with a new id, which the store reads as a removal
   * plus an addition and which strands everything the band held.
   *
   * `chores` is refused as RESERVED rather than not-found — it is a real row
   * a caller genuinely saw in the read, and its label is fixed, so "no such
   * goal" would send them hunting for a typo. Same split `reorderGoals`
   * draws for the same reason.
   *
   * Deliberately asks for NO bucket re-look, even though a retitle can change
   * what a band means ("TBD" → "Payments" arguably makes a goal apparent).
   * The trigger is keyed on a band becoming a DESTINATION, and a rename adds
   * none: every place a task could go, it could already go. Keying it on
   * meaning instead would fire on every wording fix, and nothing in the call
   * distinguishes the two — which is how an ask that matters gets ignored
   * along with the twenty that did not. If this turns out to be worth having,
   * it wants an explicit signal from the caller, not a heuristic here.
   *
   * Emits the existing `workspace.goals_changed` with kind 'edit' (a retitle
   * IS an edit under that taxonomy), so nothing downstream needs a new case.
   *
   * DELIBERATELY NOT A RE-KEY. This verb changes the title and never the id,
   * and the obvious next proposal — "let it take a NEW id and carry the
   * band's tasks across" — is the one to resist. Read this before adding it:
   *
   *  - The demand for re-keying was never a demand for re-keying. It was
   *    people renaming, and reaching for the only verb that could restate a
   *    title. With a retitle that works, "give this band a different id" has
   *    no caller left that isn't already better served here.
   *  - It would be a SECOND bulk task-mover living beside `setTaskGoal`, on
   *    the path that has already produced this file's worst bug. Every band
   *    it moved would be moved implicitly, as a side effect of an edit that
   *    reads like a label change — which is precisely the shape of the
   *    silent stranding the `would-strand-tasks` refusal exists to end.
   *  - The honest way to genuinely retire an id is already reachable and is
   *    two explicit steps: `setGoalList` with the old id named in `drop`,
   *    then `setTaskGoal` per task. The refusal message names both, so the
   *    caller who really wanted a re-key is told where to go rather than
   *    handed a verb that moves work on their behalf.
   */
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
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    if (isReservedGoalId(goalId)) return { ok: false, error: 'reserved-goal-id' };

    const oldGoals = workspace.goals;
    const current = flattenGoals(oldGoals).find((g) => g.id === goalId);
    if (!current) return { ok: false, error: 'goal-not-found' };

    const nextDueAt =
      patch.dueAt === undefined ? current.dueAt : patch.dueAt === null ? undefined : patch.dueAt;
    if (current.title === patch.title && current.dueAt === nextDueAt) {
      return {
        ok: true,
        workspace,
        changed: false,
        goal: {
          id: goalId,
          title: current.title,
          ...(current.dueAt !== undefined ? { dueAt: current.dueAt } : {}),
        },
      };
    }

    /** Rebuild the row with dueAt present only when it has a value — an
     *  explicit `dueAt: undefined` key would survive JSON.stringify
     *  comparisons differently from an absent one. */
    const retitled = <T extends { id: string; title: string; dueAt?: number }>(row: T): T => ({
      ...row,
      title: patch.title,
      ...(nextDueAt !== undefined ? { dueAt: nextDueAt } : { dueAt: undefined }),
    });
    const strip = <T extends object>(row: T): T =>
      Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined)) as T;

    // A NEW array either way: `oldGoals` rides on the event, so mutating in
    // place would make both sides report the new title and the audit row
    // would say nothing (the same trap `reorderGoals` documents).
    const newGoals: WorkspaceGoal[] = oldGoals.map((g) => {
      if (g.id === goalId) return strip(retitled(g));
      if (!g.subgoals?.some((s) => s.id === goalId)) return g;
      return {
        ...g,
        subgoals: g.subgoals.map((s) => (s.id === goalId ? strip(retitled(s)) : s)),
      };
    });
    workspace.goals = newGoals;
    this.scheduleSave(workspaceId);

    this.emit({
      type: 'workspace.goals_changed',
      workspaceId,
      batchId: cryptoId('gc'),
      kind: 'edit',
      oldGoals,
      newGoals,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      movedToChores: [],
      ts: Date.now(),
    });
    return {
      ok: true,
      workspace,
      changed: true,
      goal: {
        id: goalId,
        title: patch.title,
        ...(nextDueAt !== undefined ? { dueAt: nextDueAt } : {}),
      },
    };
  }

  /**
   * Append ONE new top-level band, and nothing else. The other half of what
   * inline goal editing on the board needs, beside `renameGoal`.
   *
   * The reason this is a verb rather than a client-side `setGoalList` call is
   * the whole hazard `renameGoal`'s header describes, one gesture over. A
   * board that adds a band by submitting the full list submits the list IT
   * last read — and any band added by someone else in between is absent from
   * that list, which the store reads as a removal and which sweeps that
   * band's open tasks into Backlog. Here the list is rebuilt from the LIVE
   * `workspace.goals` at call time, so the only difference between what goes
   * in and what was already there is the one entry being added. A concurrent
   * writer can be raced on ORDER; it cannot be raced out of existence.
   *
   * The new entry carries no `id`, which is what tells `setGoalList` to mint
   * one — so id generation, the bucket re-look (a new band IS a new
   * destination, which is exactly the case `requestBucketReview` is keyed on)
   * and the `workspace.goals_changed` emit are all inherited rather than
   * re-implemented.
   *
   * Top-level only, deliberately. Display flattens subgoals, so there is no
   * surface that could express "add under this parent", and adding one here
   * would be a data shape nothing renders.
   */
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
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };

    // Rebuilt from the live list, not from anything a caller sent: every id
    // here necessarily exists, so the delegated replace can only add.
    const entries: GoalListEntry[] = state.workspace.goals.map((g) => ({
      id: g.id,
      title: g.title,
      ...(g.dueAt !== undefined ? { dueAt: g.dueAt } : {}),
      ...(g.subgoals !== undefined ? { subgoals: g.subgoals.map((s) => ({ ...s })) } : {}),
    }));
    const fresh: GoalListEntry = {
      title: patch.title,
      ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
    };
    if (patch.after === undefined) {
      entries.push(fresh);
    } else {
      const at = entries.findIndex((g) => g.id === patch.after);
      // A subgoal id, or a band that has since gone, lands here. Refused
      // rather than silently appended: the caller asked for a POSITION, and
      // quietly ignoring it is how a board's order stops matching what the
      // person just did.
      if (at < 0) return { ok: false, error: 'after-not-found' };
      entries.splice(at + 1, 0, fresh);
    }

    const res = this.setGoalList(workspaceId, entries, { actor: opts.actor });
    if (!res.ok) return { ok: false, error: 'rejected', cause: res.error };
    const created = res.created[0];
    if (created === undefined) return { ok: false, error: 'rejected', cause: 'no-goal-created' };
    return {
      ok: true,
      workspace: res.workspace,
      goal: {
        id: created.id,
        title: patch.title,
        ...(patch.dueAt !== undefined ? { dueAt: patch.dueAt } : {}),
      },
    };
  }

  /**
   * Reorder goals at ONE scope — the top-level list, or the subgoals of
   * `parent` — and nothing else. The priority gesture, separated from the
   * edit.
   *
   * PERMUTATION ONLY, and that constraint is the entire point. `setGoalList`
   * is a full replace, so reordering through it means restating every id and
   * title, and any id a stale caller omits sends that goal's open tasks to
   * the bottom of Backlog — the most ordinary gesture on a board carrying the
   * most destructive edge in the API. Here an `order` that is not exactly
   * the current id set (same ids, same count) is REFUSED with the unknown /
   * missing / duplicated ids named, rather than merged best-effort. So a
   * caller working from a list another writer has since changed gets an
   * error it can re-read and retry — never a silent goal loss. Whether that
   * refusal is well-formed is checked over HTTP too, because the route layer
   * is where a param quietly disappears.
   *
   * Titles, dueAt and subgoal arrays ride along untouched, and no task can
   * move: there is no reachable input to this method that regroups anything.
   * Emits the existing `workspace.goals_changed` with kind 'reorder' — the
   * event the board projection and the activity feed already render — so
   * nothing downstream needs a new case.
   */
  reorderGoals(
    workspaceId: string,
    order: string[],
    opts: { parent?: string; actor: { id: string; name: string; kind?: string } },
  ): ReorderGoalsResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;

    // Scope: the top-level list, or one parent's subgoals. A SUBGOAL id as
    // `parent` finds nothing here, which is the right answer — nesting is
    // one level deep by design (§3.2), so it has no subgoals to order.
    const parentId = opts.parent;
    const parentGoal =
      parentId === undefined ? undefined : workspace.goals.find((g) => g.id === parentId);
    if (parentId !== undefined && !parentGoal) return { ok: false, error: 'parent-not-found' };
    const current: Array<WorkspaceGoal | WorkspaceSubgoal> = parentGoal
      ? (parentGoal.subgoals ?? [])
      : workspace.goals;

    const currentIds = current.map((g) => g.id);
    const currentSet = new Set(currentIds);
    const seen = new Set<string>();
    const unknownIds: string[] = [];
    const reservedIds: string[] = [];
    const duplicateIds: string[] = [];
    for (const id of order) {
      // 'chores' is never in goals[], so it is refused — but it is refused as
      // RESERVED, not unknown. It is a row the caller genuinely saw in the
      // read, and it always renders last, so a caller who put it first cannot
      // be obeyed and a caller who put it last must not be silently trimmed:
      // accepting either would be a position nobody honours.
      if (!currentSet.has(id)) {
        const bucket = isReservedGoalId(id) ? reservedIds : unknownIds;
        if (!bucket.includes(id)) bucket.push(id);
      }
      if (seen.has(id) && !duplicateIds.includes(id)) duplicateIds.push(id);
      seen.add(id);
    }
    const missingIds = currentIds.filter((id) => !seen.has(id));
    if (
      unknownIds.length > 0 ||
      reservedIds.length > 0 ||
      duplicateIds.length > 0 ||
      missingIds.length > 0
    ) {
      return {
        ok: false,
        error: 'order-mismatch',
        unknownIds,
        reservedIds,
        missingIds,
        duplicateIds,
      };
    }

    if (currentIds.every((id, i) => order[i] === id)) {
      return { ok: true, workspace, changed: false, order: currentIds };
    }

    // Build a NEW top-level array either way. `oldGoals` on the event aliases
    // the array we are replacing, so mutating in place would make the event
    // report the new order on both sides and the audit row would say nothing.
    const oldGoals = workspace.goals;
    let newGoals: WorkspaceGoal[];
    if (parentGoal) {
      const byId = new Map((parentGoal.subgoals ?? []).map((s) => [s.id, s]));
      const subgoals = order.map((id) => byId.get(id) as WorkspaceSubgoal);
      newGoals = oldGoals.map((g) => (g.id === parentGoal.id ? { ...g, subgoals } : g));
    } else {
      const byId = new Map(oldGoals.map((g) => [g.id, g]));
      newGoals = order.map((id) => byId.get(id) as WorkspaceGoal);
    }
    workspace.goals = newGoals;
    this.scheduleSave(workspaceId);

    this.emit({
      type: 'workspace.goals_changed',
      workspaceId,
      batchId: cryptoId('gc'),
      kind: 'reorder',
      oldGoals,
      newGoals,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      movedToChores: [],
      ts: Date.now(),
    });
    return { ok: true, workspace, changed: true, order: [...order] };
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
    this.scheduleSave(task.workspaceId);
    return true;
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
    return workspace.goals.some(
      (g) => g.id === goalId || (g.subgoals ?? []).some((s) => s.id === goalId),
    );
  }

  // ── Agent attachments (§4) ───────────────────────────────────────────────
  //
  // The registry behind the triage-delivery bridge and the hub's attachment
  // state. Records live in their own per-workspace sidecar; agent.* events
  // ride the SAME emit choke point as every other §3.6 row (SSE + audit),
  // carrying the PUBLIC shape — `endpoint` never leaves REST/sidecar.

  /**
   * Attach (or re-attach) an agent to a workspace — an upsert on
   * (workspaceId, agentId). Attach is itself a tool call, so both liveness
   * clocks start at now: a freshly attached agent reads as active, never as
   * unresponsive-from-birth. The result carries the §3.3 one-line summary of
   * open gating decisions and the untriaged Backlog tasks to sweep (§3.4) —
   * a fresh context learns the gates exist without thinking to read the
   * board.
   */
  attachAgent(
    workspaceId: string,
    opts: {
      agentId: string;
      runtime: AttachmentRuntime;
      capabilities?: string[];
      endpoint?: string;
      pluginVersion?: string;
    },
  ): AttachAgentResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const now = Date.now();
    const attachment: AgentAttachment = {
      workspaceId,
      agentId: opts.agentId,
      runtime: opts.runtime,
      ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
      ...(opts.pluginVersion !== undefined ? { pluginVersion: opts.pluginVersion } : {}),
      lastHeartbeat: now,
      lastToolCallAt: now,
      capabilities: opts.capabilities ?? [],
    };
    state.attachments.set(opts.agentId, attachment);
    this.scheduleAttachmentsSave(workspaceId);
    // Claim an EMPTY seat only. A board created before this field existed —
    // or by a person — would otherwise stay a dead letter forever, but an
    // occupied seat is a standing decision and a second agent attaching is
    // not a reassignment.
    if (state.workspace.leadAgentId === undefined) {
      // `now`, not a fresh read: the seat claim is part of THIS attach, and
      // the `workspace.lead_changed` it emits is observed as this agent's
      // work. Re-reading here would stamp the work clock a millisecond past
      // the `lastHeartbeat` set four lines up.
      this.assignLead(
        state,
        opts.agentId,
        { id: opts.agentId, name: opts.agentId, kind: 'agent' },
        now,
      );
    }
    const lead = state.workspace.leadAgentId === opts.agentId;
    // Only the lead carries the waiting goal edit off. A bystander attaching
    // must leave it where it is, or the request is "delivered" to whoever
    // showed up first — the failure this whole path exists to end.
    const pendingRetriage = lead ? this.getPendingRetriage(workspaceId) : undefined;
    if (pendingRetriage) this.clearPendingRetriage(state);
    // Same contract, separate ask: a lead can owe both a re-triage against a
    // new north star and a re-look at the bucket a new band opened, and
    // answering one is not answering the other.
    const pendingBucketReview = lead ? this.getPendingBucketReview(workspaceId) : undefined;
    if (pendingBucketReview) this.clearPendingBucketReview(state);
    // The correction loop's durable half: writes whose live request never
    // reached anyone (or that arrived while the lead was away), drained the
    // same way the re-triage is — delivered in the one payload a fresh
    // attachment is guaranteed to read, then cleared.
    const taskReviews = lead ? this.getPendingTaskReviews(workspaceId) : undefined;
    if (taskReviews) this.clearPendingTaskReviews(state);
    // The voice queue is the same ask with the same addressee: only the lead
    // drains it. A bystander attaching leaves the notes where they are for
    // the lead's next attach — otherwise they are "delivered" into a payload
    // that has no contract to act on them.
    const queuedVoice = lead
      ? this.drainVoiceQueue(workspaceId, { freshProcess: true })
      : undefined;
    // Emitted LAST, after every state change above: the projection refreshes
    // off this event, so an earlier emit would repaint the board with a
    // pending re-triage this very call just drained.
    this.emit({
      type: 'agent.attached',
      workspaceId,
      agentId: opts.agentId,
      attachment: publicAttachment(attachment, now, this.attachmentThresholds),
      ts: now,
    });
    return {
      ok: true,
      attachment,
      gating: this.gatingSummary(workspaceId),
      untriaged: this.listUntriaged(workspaceId).map((t) => t.id),
      ...(queuedVoice !== undefined ? { queuedVoice } : {}),
      ...(pendingRetriage ? { pendingRetriage } : {}),
      ...(pendingBucketReview ? { pendingBucketReview } : {}),
      ...(taskReviews !== undefined && taskReviews.length > 0 ? { taskReviews } : {}),
      lead,
    };
  }

  // ── Voice (§2.4 / §3.8) ──────────────────────────────────────────────────

  /**
   * Record a voice utterance + its routing outcome. This is the §3.6
   * `voice.request` row: it reaches the audit log and every subscriber via
   * the emit choke point, so "voice always answers" has a checkable
   * artifact. Returns false (and emits nothing) for an unknown workspace.
   */
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
    if (!this.workspaces.has(workspaceId)) return false;
    this.emit({
      type: 'voice.request',
      workspaceId,
      transcript: req.transcript,
      route: req.route,
      ack: req.ack,
      ...(req.queueId !== undefined ? { queueId: req.queueId } : {}),
      ...(req.context !== undefined ? { context: req.context } : {}),
      actor: {
        id: req.actor.id,
        name: req.actor.name,
        kind: classifyActor(req.actor),
      },
      ts: Date.now(),
    });
    return true;
  }

  /**
   * Queue a change-utterance for the next agent attach. SYNCHRONOUS write,
   * unlike every other sidecar: the caller is about to tell the speaker
   * "queued", and an ack grounded in a debounce that a crash can drop would
   * be the summaries-incident lie. Queue writes are rare (only while no
   * agent is live), so the sync cost is nothing.
   */
  queueVoiceRequest(
    workspaceId: string,
    item: {
      transcript: string;
      context?: unknown;
      actor: { id: string; name: string; kind?: string };
      applied?: string;
    },
  ): string | false {
    if (!this.workspaces.has(workspaceId)) return false;
    const id = cryptoId('vq');
    const queued: QueuedVoiceRequest = {
      id,
      transcript: item.transcript,
      ...(item.context !== undefined ? { context: item.context } : {}),
      actor: { id: item.actor.id, name: item.actor.name, kind: classifyActor(item.actor) },
      ...(item.applied !== undefined ? { applied: item.applied } : {}),
      ts: Date.now(),
    };
    const path = voiceQueuePath(this.dataDir, workspaceId);
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const existing = this.listQueuedVoice(workspaceId);
      writeFileSync(path, `${JSON.stringify({ queue: [...existing, queued] }, null, 2)}\n`);
      return id;
    } catch (err) {
      console.error(`[tasks] failed to queue voice request for ${workspaceId}:`, err);
      return false;
    }
  }

  /** Read the queue without draining it (the hub could render a badge). */
  listQueuedVoice(workspaceId: string): QueuedVoiceRequest[] {
    const path = voiceQueuePath(this.dataDir, workspaceId);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        queue?: QueuedVoiceRequest[];
      };
      return (parsed.queue ?? []).filter((q) => typeof q?.transcript === 'string');
    } catch (err) {
      console.error(`[tasks] unreadable voice queue for ${workspaceId} — skipped:`, err);
      return [];
    }
  }

  /** Replace the queue file, removing it when nothing is left — same
   *  synchronous write as `queueVoiceRequest`, and for the same reason. */
  private writeVoiceQueue(workspaceId: string, queue: QueuedVoiceRequest[]): void {
    const path = voiceQueuePath(this.dataDir, workspaceId);
    try {
      if (queue.length === 0) {
        rmSync(path, { force: true });
        return;
      }
      writeFileSync(path, `${JSON.stringify({ queue }, null, 2)}\n`);
    } catch (err) {
      console.error(`[tasks] failed to rewrite voice queue for ${workspaceId}:`, err);
    }
  }

  /**
   * Record that this entry has gone out on the wire.
   *
   * Not the same as delivered, and the difference is the whole point: the
   * server knows what it wrote to a socket and nothing more. Until an ack
   * comes back the entry stays on the books.
   */
  markVoiceEmitted(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedVoice(workspaceId);
    const entry = queue.find((q) => q.id === id);
    if (!entry) return false;
    entry.emittedAt = Date.now();
    this.writeVoiceQueue(workspaceId, queue);
    return true;
  }

  /**
   * The receiving process confirms it has the utterance. THIS is what makes a
   * live delivery durable — before it, the route's only record that a message
   * had been sent was a socket write that nothing checked.
   *
   * Returns false for an id that is not on the queue, rather than treating a
   * stale or replayed receipt as licence to clear anything.
   */
  ackVoiceRequest(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedVoice(workspaceId);
    const next = queue.filter((q) => q.id !== id);
    if (next.length === queue.length) return false;
    this.writeVoiceQueue(workspaceId, next);
    return true;
  }

  /**
   * Hand over what this agent should act on, and keep what might still be in
   * flight.
   *
   * `freshProcess` is the attach case. A session that just attached cannot be
   * holding anything: whatever was emitted went to the process that is gone,
   * so the grace window protects nobody and only delays the redelivery.
   */
  private drainVoiceQueue(
    workspaceId: string,
    opts?: { freshProcess?: boolean },
  ): QueuedVoiceRequest[] {
    const queue = this.listQueuedVoice(workspaceId);
    if (queue.length === 0) return [];
    const now = Date.now();
    const inFlight = (q: QueuedVoiceRequest): boolean =>
      !opts?.freshProcess && q.emittedAt !== undefined && now - q.emittedAt < this.voiceAckGraceMs;
    const handOver = queue.filter((q) => !inFlight(q));
    this.writeVoiceQueue(
      workspaceId,
      queue.filter((q) => inFlight(q)),
    );
    return handOver;
  }

  /**
   * Record a heartbeat. A plain heartbeat proves only that the process is
   * alive; `toolCallAt` lets the runtime report when it last did WORK — the
   * two clocks are deliberately separate (§4: a session at its usage limit
   * heartbeats normally for hours). `toolCallAt` is monotonic and clamped to
   * now: it can neither backdate nor forward-date activity.
   */
  heartbeat(workspaceId: string, agentId: string, opts?: { toolCallAt?: number }): HeartbeatResult {
    const attachment = this.workspaces.get(workspaceId)?.attachments.get(agentId);
    if (!attachment) return { ok: false, error: 'not-found' };
    const now = Date.now();
    attachment.lastHeartbeat = now;
    if (opts?.toolCallAt !== undefined) {
      const claimed = Math.min(opts.toolCallAt, now);
      if (claimed > attachment.lastToolCallAt) attachment.lastToolCallAt = claimed;
    }
    this.scheduleAttachmentsSave(workspaceId);
    this.emit({
      type: 'agent.heartbeat',
      workspaceId,
      agentId,
      attachment: publicAttachment(attachment, now, this.attachmentThresholds),
      ts: now,
    });
    // A heartbeat is an observation, and every observation is a chance to hand
    // back what was parked. Before this the queue drained ONLY from
    // `attachAgent`, which a long-running session calls once at startup — so a
    // request queued at 16:41 waited for a process restart, and the ack that
    // said "queued for its next attach" was describing a wait with no end in
    // sight rather than a short one.
    const queuedVoice = this.drainVoiceQueue(workspaceId);
    // The emit IS the delivery, exactly as it is on the live `agent` route:
    // the event rides `ws~<workspaceId>`, which this agent's MCP watch turns
    // into a channel frame. Returning it in the response would not do — the
    // heartbeat that carries most of these is sent by the keepalive, which
    // piggybacks a real tool call and discards the body, so a queued
    // utterance handed back only in the result would be handed to nobody.
    for (const q of queuedVoice) {
      this.recordVoiceRequest(workspaceId, {
        transcript: q.transcript,
        route: 'agent',
        ack: q.applied
          ? `Delivered from the queue. Already applied: ${q.applied}`
          : 'Delivered from the queue.',
        ...(q.context !== undefined ? { context: q.context } : {}),
        actor: q.actor,
      });
    }
    return { ok: true, attachment, ...(queuedVoice.length > 0 ? { queuedVoice } : {}) };
  }

  /**
   * Bump lastToolCallAt. No event — tool calls are not a §3.6 row; the next
   * heartbeat event carries the moved clock.
   *
   * `at` is when the work was observed, defaulting to now. Callers that are
   * recording a specific event should pass that event's `ts` rather than
   * re-reading the clock: attaching emits `workspace.lead_changed` when it
   * claims an empty seat, and a fresh `Date.now()` there lands a millisecond
   * past the attach's own timestamp, breaking the "a new attachment's two
   * clocks are equal" contract about 1 run in 3.
   *
   * Passing the event's `ts` is only half of that, and the half this comment
   * used to describe as the whole. It buys nothing unless the EVENT's `ts` is
   * the operation's own — `assignLead` went on taking a `Date.now()` of its
   * own for the row it emits, so the same millisecond still split the same
   * two clocks, just one call deeper. Measured at 8 failures in 300 runs
   * before `assignLead` was made to take its caller's `ts`. The rule the two
   * fixes add up to: one operation, one clock read, threaded all the way
   * down.
   *
   * Clamped to now and monotonic, the same guards `heartbeat` applies to a
   * claimed `toolCallAt`: a clock may not run ahead of the server's, and
   * observing older work than we already knew about is not news.
   */
  noteAgentToolCall(workspaceId: string, agentId: string, at?: number): boolean {
    const attachment = this.workspaces.get(workspaceId)?.attachments.get(agentId);
    if (!attachment) return false;
    const observed = Math.min(at ?? Date.now(), Date.now());
    if (observed <= attachment.lastToolCallAt) return true;
    attachment.lastToolCallAt = observed;
    this.scheduleAttachmentsSave(workspaceId);
    return true;
  }

  /** Remove an attachment. Emits agent.detached once; a second detach has
   *  nothing left to announce. */
  detachAgent(workspaceId: string, agentId: string): boolean {
    const state = this.workspaces.get(workspaceId);
    const attachment = state?.attachments.get(agentId);
    if (!state || !attachment) return false;
    const now = Date.now();
    state.attachments.delete(agentId);
    this.scheduleAttachmentsSave(workspaceId);
    this.emit({
      type: 'agent.detached',
      workspaceId,
      agentId,
      attachment: publicAttachment(attachment, now, this.attachmentThresholds),
      ts: now,
    });
    return true;
  }

  /** Full records + derived state — the OWNER surface (endpoint included).
   *  Visitors get `listPublicAttachments` instead. */
  listAttachments(workspaceId: string): DescribedAttachment[] {
    const state = this.workspaces.get(workspaceId);
    if (!state) return [];
    const now = Date.now();
    return Array.from(state.attachments.values())
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((att) => {
        const s = attachmentState(att, now, this.attachmentThresholds);
        return { ...att, state: s, stateLabel: attachmentStateLabel(s) };
      });
  }

  /** The visitor-redacted read: same list, endpoint stripped. */
  listPublicAttachments(workspaceId: string): PublicAttachment[] {
    const state = this.workspaces.get(workspaceId);
    if (!state) return [];
    const now = Date.now();
    return Array.from(state.attachments.values())
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((att) => publicAttachment(att, now, this.attachmentThresholds));
  }

  /**
   * The newest moment the server OBSERVED this agent: a heartbeat it sent, or
   * a write it made. Whichever is later — the two are independent evidence and
   * taking the max means adding the observed clock never makes an agent look
   * *less* alive than it did before.
   */
  private lastObserved(att: Pick<AgentAttachment, 'lastHeartbeat' | 'lastToolCallAt'>): number {
    return Math.max(att.lastHeartbeat, att.lastToolCallAt);
  }

  /** Recent enough to hand work to, AND with the channel open to carry it. */
  private isDeliverable(
    workspaceId: string,
    att: Pick<AgentAttachment, 'lastHeartbeat' | 'lastToolCallAt'> & { agentId?: string },
  ): boolean {
    // The socket outranks the clock. An agent doing local work — grep, file
    // reads, a test run — makes no call this server can see, so the observed
    // window expires under a session that never went anywhere. Measured
    // 2026-08-19: a 19.1-minute working gap against a 15-minute window, with
    // the agent's stream open for every second of it. Asked first because
    // when it says yes there is nothing the clock could add.
    if (att.agentId && this.agentStreamProbe?.(workspaceId, att.agentId)) return true;
    const freshMs = this.attachmentThresholds.observedWorkFreshMs ?? OBSERVED_LIVE_MS;
    if (Date.now() - this.lastObserved(att) >= freshMs) return false;
    // Asked last and separately: the clock says the agent was here recently,
    // this says somebody is on the wire to receive what we are about to send.
    return this.deliveryProbe?.(workspaceId) ?? true;
  }

  /**
   * Is any attached agent live enough to hand a request to? This is what
   * grounds the triage pending marker (§3.4): "emitted to a live attachment"
   * means someone is there to act — existence alone proves nothing, and
   * promising work to a runtime that died an hour ago would be the
   * summaries-incident lie again.
   *
   * Liveness is OBSERVED, never self-reported. It used to read `lastHeartbeat`
   * alone, which measured whether a model remembered to announce itself — see
   * `OBSERVED_LIVE_MS` for the measurement and what it cost.
   */
  hasLiveAttachment(workspaceId: string): boolean {
    const state = this.workspaces.get(workspaceId);
    if (!state) return false;
    for (const att of state.attachments.values()) {
      if (this.isDeliverable(workspaceId, att)) return true;
    }
    return false;
  }

  /**
   * Is the workspace's LEAD agent live right now?
   *
   * Stricter than `hasLiveAttachment` on purpose, and only goal-edit
   * re-triage uses it: that request asks someone to re-place the whole
   * board against a new north star, which is the lead's job. A bystander
   * agent being connected is not a reason to call it delivered — it is
   * exactly how a goal edit ended up "delivered" to nobody accountable.
   * False also covers the empty seat, where there is no addressee at all.
   */
  hasLiveLeadAttachment(workspaceId: string): boolean {
    const state = this.workspaces.get(workspaceId);
    const leadAgentId = state?.workspace.leadAgentId;
    if (!state || leadAgentId === undefined) return false;
    const att = state.attachments.get(leadAgentId);
    if (!att) return false;
    // Same observed clock as `hasLiveAttachment` — fixing one and not the
    // other would leave board-wide requests queueing while ordinary ones flow.
    return this.isDeliverable(workspaceId, att);
  }

  /**
   * Is THIS named agent live on this board — the per-agent form of
   * `hasLiveAttachment`.
   *
   * Exists because the coverage read ("which boards am I missing work on?")
   * asks about one specific agent, and answering it from `attachmentState`
   * measures the wrong thing. That state is heartbeat-only and feeds the
   * displayed active/away label; delivery rides the observed clock. Between
   * the two windows sits a real gap where an agent is shown `away` and is
   * nonetheless handed every request — so a coverage row built on the label
   * reports a problem the agent does not have, and prescribes a remedy
   * (claiming a seat) whose whole hazard is that it can evict a working peer.
   */
  hasLiveAttachmentFor(workspaceId: string, agentId: string): boolean {
    const state = this.workspaces.get(workspaceId);
    if (!state) return false;
    const att = state.attachments.get(agentId);
    if (!att) return false;
    return this.isDeliverable(workspaceId, att);
  }

  /** Open decision tasks that gate open tasks via `after` edges, rolled into
   *  the §3.3 one-liner: "2 open decisions gating 3 tasks". */
  private gatingSummary(workspaceId: string): GatingSummary {
    const state = this.workspaces.get(workspaceId);
    const decisions = new Set<string>();
    const gated = new Set<string>();
    if (state) {
      for (const task of state.tasks.values()) {
        if (task.status === 'done') continue;
        for (const depId of task.after) {
          const dep = state.tasks.get(depId);
          if (dep && dep.status !== 'done' && dep.needs === 'decision') {
            decisions.add(dep.id);
            gated.add(task.id);
          }
        }
      }
    }
    const d = decisions.size;
    const g = gated.size;
    return {
      openDecisions: d,
      gatedTasks: g,
      summary:
        d === 0
          ? 'no open gating decisions'
          : `${d} open decision${d === 1 ? '' : 's'} gating ${g} task${g === 1 ? '' : 's'}`,
    };
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
        };
        const workspace = parsed.workspace;
        if (!workspace || typeof workspace.id !== 'string') {
          console.error(`[tasks] sidecar ${entry} has no workspace — skipped`);
          continue;
        }
        const tasks = new Map<string, Task>();
        for (const task of parsed.tasks ?? []) {
          if (typeof task?.id !== 'string') continue;
          // A restart killed any in-flight triage request, so its marker
          // must not outlive it (grounded-pending, §3.4): the task goes back
          // to plainly sitting in Backlog until an agent attaches and sweeps.
          task.triagePendingTs = undefined;
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
          tasks.set(task.id, task);
          this.taskIndex.set(task.id, workspace.id);
        }
        const pendingRetriage = this.loadPendingRetriage(workspace.id);
        const pendingBucketReview = this.loadPendingBucketReview(workspace.id);
        const pendingTaskReviews = this.loadPendingTaskReviews(workspace.id);
        this.workspaces.set(workspace.id, {
          workspace,
          tasks,
          attachments: this.loadAttachments(workspace.id),
          // Unlike a task's triage marker above, a queued goal edit SURVIVES
          // the restart: the marker promised in-flight work that the restart
          // killed, this is a request nobody has answered yet.
          ...(pendingRetriage ? { pendingRetriage } : {}),
          // Same reasoning: a band appeared and nobody has looked at the
          // bucket yet — a restart does not answer that.
          ...(pendingBucketReview ? { pendingBucketReview } : {}),
          // And again: a row somebody wrote to is still waiting for its
          // review pass — a restart does not perform it.
          ...(pendingTaskReviews ? { pendingTaskReviews } : {}),
        });
      } catch (err) {
        // A corrupt sidecar loses that one workspace, never the server.
        console.error(`[tasks] unreadable sidecar ${entry} — skipped:`, err);
      }
    }
  }
}
