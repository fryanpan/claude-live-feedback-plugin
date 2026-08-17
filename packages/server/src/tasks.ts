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
import { transitionUnproven } from '@feedback/core';
import { type StoredGoalSummary, goalTextHash } from '@feedback/core/goal-summary';
import { classifyActor } from './activity.ts';
import {
  type DecisionShapeGap,
  checkDecisionShape,
  decisionShapeMessage,
} from './decision-shape.ts';

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
  /** The human's live confirmation, required for an agent to move a
   *  yellow-tier task forward (§3.4). Recorded so the after-the-fact review
   *  can see the confirmation was asked for and given. */
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
  /** The human's verbatim words at promotion or creation. */
  quote?: string;
  /** Decisions keep the verbatim answer. `optionId` records WHICH candidate
   *  the words came from when one was tapped — the text stays the answer. */
  answer?: { text: string; by: string; ts: number; optionId?: string };
  /** Which goal (id + its text at the time) produced this placement. */
  triagedAgainst?: { goalId: string; goal: string; ts: number };
  /**
   * Triage-pending marker (§3.4). Stamped ONLY at the moment a triage
   * request is actually emitted to a live attachment — the grounded-pending
   * rule from the summaries incident: never promise work that isn't queued.
   * No attachment → no marker; the task simply sits in Chores. Cleared on
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
  /** Stamped by triage at placement time; keyed to the ACTION's damage. */
  riskTier?: 'green' | 'yellow' | 'red';
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
}

export interface CreateTaskOpts {
  title: string;
  body?: string;
  assignee?: string;
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
      error:
        | 'not-found'
        | 'bad-status'
        | 'same-status'
        | 'blocked'
        // §3.4 risk tiers, agent actors only, forward moves only:
        // red is refused outright; yellow needs the human's live
        // confirmation on the request.
        | 'risk-refused'
        | 'needs-confirmation';
      blockers?: TransitionBlocker[];
      riskTier?: 'green' | 'yellow' | 'red';
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
   *  Chores resting state without anyone judging it. */
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
    };

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

export type AttachmentState = 'active' | 'unresponsive' | 'away';

export interface AttachmentThresholds {
  heartbeatFreshMs?: number;
  toolCallStaleMs?: number;
}

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

export type AttachAgentResult =
  | {
      ok: true;
      attachment: AgentAttachment;
      gating: GatingSummary;
      /** Open Chores tasks no triage has placed — what the agent sweeps
       *  after attaching (§3.4). */
      untriaged: string[];
      /** Voice change-requests that arrived while no agent was live (§2.4
       *  "agent away — queued"). Delivered HERE — in the attach result, the
       *  one payload a fresh attachment is guaranteed to read — and drained:
       *  a second attach gets an empty list. */
      queuedVoice: QueuedVoiceRequest[];
      /** A goal edit that happened while the lead was away. Delivered HERE —
       *  the one payload a fresh attachment is guaranteed to read — and
       *  drained, so a re-attach never asks for the same walk twice. Only
       *  ever handed to the LEAD; a bystander attaching leaves it waiting. */
      pendingRetriage?: PendingRetriage;
      /** Is THIS attachment the workspace's lead agent — either because it
       *  already held the seat, or because it just claimed an empty one? The
       *  lead is the addressee for goal-edit re-triage, so a fresh context
       *  needs to know which it is without a second call. */
      lead: boolean;
    }
  | { ok: false; error: 'workspace-not-found' };

export type HeartbeatResult =
  | { ok: true; attachment: AgentAttachment }
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
  /** The human's live confirmation on a yellow-tier agent move (§3.4) —
   *  in the audit log, so the after-the-fact review can see the gate was
   *  answered rather than absent. */
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
 * A gate refusal (§3.4 risk tiers). Not in §3.6's table, which predates the
 * tier arm having any consumer — §3.9's Decisions filter promises "gate
 * refusals" as rows, and a refusal that emits nothing can never appear
 * there. It carries no task, because nothing about the task changed.
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
  actor: TaskActor;
  /** The decision task's links — a ready-made propagation checklist. */
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
  /** Open tasks whose goal id disappeared, moved to Chores. */
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

/** §3.6: every voice utterance emits `voice.request` — transcript, chosen
 *  route, ack text — which is what makes "voice always answers" a checkable
 *  artifact rather than a promise (§2.4). */
export interface VoiceRequestEvent {
  type: 'voice.request';
  workspaceId: string;
  /** The utterance VERBATIM. */
  transcript: string;
  /** Which route handled it. 'agent-queued' = no live attachment; the
   *  request waits in the voice queue for the next attach. */
  route: 'fast-path' | 'agent' | 'agent-queued';
  /** The explicit reply the speaker saw — names what was heard and which
   *  route handles it. */
  ack: string;
  /** The per-surface anchor the utterance carried (§3.8). */
  context?: unknown;
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
  | TaskRegroupedEvent
  | DecisionAnsweredEvent
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
  transcript: string;
  context?: unknown;
  actor: TaskActor;
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
      /** False when the named agent already held the seat. */
      changed: boolean;
    }
  | { ok: false; error: 'workspace-not-found' };

export type AnswerDecisionResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' | 'unknown-option' };

export type RequestMoreInfoResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' };

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
  | { ok: false; error: 'not-found' | 'unknown-goal' };

export type SetGoalListResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the new list deep-equals the old — no event, no moves. */
      changed: boolean;
      /** Open tasks whose goal or subgoal id disappeared, moved to Chores —
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
       *  goals `setGoalList` would have emptied into Chores. */
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

export class TaskStore {
  private workspaces = new Map<string, WorkspaceState>();
  private taskIndex = new Map<string, string>(); // taskId → workspaceId
  private saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private attachmentSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private dataDir: string;
  private debounceMs: number;
  private attachmentThresholds: AttachmentThresholds;
  private triageDelivery: TriageDelivery | undefined;
  private eventListeners = new Set<(event: TaskStoreEvent) => void>();

  constructor(opts: {
    dataDir: string;
    debounceMs?: number;
    /** Attachment liveness knobs — overridable so tests never burn real
     *  minutes (§6: delivery timings configurable). */
    heartbeatFreshMs?: number;
    toolCallStaleMs?: number;
  }) {
    this.dataDir = opts.dataDir;
    this.debounceMs = opts.debounceMs ?? 200;
    this.attachmentThresholds = {
      ...(opts.heartbeatFreshMs !== undefined ? { heartbeatFreshMs: opts.heartbeatFreshMs } : {}),
      ...(opts.toolCallStaleMs !== undefined ? { toolCallStaleMs: opts.toolCallStaleMs } : {}),
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

  /** Wire (or clear) the bridge that carries triage requests to a live
   *  attached agent. The attachment registry commit installs the real one. */
  setTriageDelivery(delivery: TriageDelivery | undefined): void {
    this.triageDelivery = delivery;
  }

  private emit(event: TaskStoreEvent): void {
    // Audit FIRST, at the emit choke point: "an event was emitted" and "the
    // audit log has it" are the same fact by construction (§3.6), so the log
    // can never disagree with what subscribers saw.
    this.appendAudit(event);
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
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetLeadAgentResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    const next = leadAgentId.trim();
    if (next === workspace.leadAgentId) return { ok: true, workspace, changed: false };
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    this.assignLead(state, next, actor);
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
    return { ok: true, workspace, changed: true };
  }

  /** The seat change itself, shared by `setLeadAgent` and the attach-time
   *  claim so both persist and announce it identically. */
  private assignLead(state: WorkspaceState, leadAgentId: string, actor: TaskActor): void {
    const workspace = state.workspace;
    const oldLeadAgentId = workspace.leadAgentId;
    const ts = Date.now();
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
    const after = opts.after ?? [];
    for (const dep of after) {
      if (!state.tasks.has(dep)) return { ok: false, error: 'unknown-after' };
    }
    // `afterEnforce` is a SUBSET of `after`: openBlockers walks `after` and
    // consults afterEnforce only as a lookup set, so an id in one array and
    // not the other is never visited and hard-blocks NOTHING. Refusing beats
    // quietly widening `after`, which would change the blocker list the
    // caller sees without saying so.
    for (const dep of opts.afterEnforce ?? []) {
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
      ...(opts.needs !== undefined ? { needs: opts.needs } : {}),
      ...(options.length > 0 ? { options } : {}),
      goal,
      order,
      status: 'todo',
      after,
      ...(opts.afterEnforce?.length ? { afterEnforce: opts.afterEnforce } : {}),
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

    // Triage hook (§3.4): an OMITTED goal means "needs placing" — the task
    // has already landed at the bottom of Chores (the resting state; the
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
   * ("in Chores and `triagedAgainst` unset"). That proxy was wrong in BOTH
   * directions, and each was reproduced before the field existed:
   *
   *  - it re-asked forever about a task whose caller explicitly said
   *    `goal: 'chores'` — a placement, per `placement.placed`;
   *  - it never surfaced a task swept into Chores by a band removal, because
   *    that task KEEPS the `triagedAgainst` of its old placement, pointing at
   *    a goal id that no longer exists.
   *
   * No `goal === chores` clause: the two writers of `unplacedSince` both land
   * the task in Chores, so the clause would be a second spelling of the same
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
   *  - `riskTier` (§3.4) gates the ACTOR, not the task's importance: an
   *    AGENT moving a `red` task forward is refused outright, and a `yellow`
   *    one needs the human's live confirmation on the request. A person is
   *    never gated (the override is one tap) and neither is moving back to
   *    todo. Honest reach: this binds LF-MEDIATED mutations only — actions
   *    an agent runs in its own runtime never touch this server, where the
   *    tier stays advisory and the fleet's permission rules enforce.
   */
  transition(
    taskId: string,
    to: TaskStatus,
    opts: {
      actor: { id: string; name: string; kind?: string };
      note?: string;
      evidence?: TaskEvidence;
      usage?: { inputTokens: number; outputTokens: number };
      /** The human's live confirmation for a yellow-tier forward move. */
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
    const refusal = forward && by.kind === 'agent' ? this.riskRefusal(task, opts.confirmed) : null;
    if (refusal) {
      // A refusal is a decision the after-the-fact review has to be able to
      // see (§3.9's Decisions filter promises gate refusals), so it emits —
      // the task itself is unchanged.
      this.emit({
        type: 'task.gate_refused',
        workspaceId: task.workspaceId,
        taskId: task.id,
        to,
        riskTier: task.riskTier ?? 'green',
        reason: refusal.error,
        actor: by,
        ts: Date.now(),
      });
      return { ok: false, ...refusal, blockers };
    }
    const entry: TaskTransition = {
      ts: Date.now(),
      from: task.status,
      to,
      by,
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      ...(opts.evidence !== undefined ? { evidence: opts.evidence } : {}),
      ...(opts.usage !== undefined ? { usage: opts.usage } : {}),
      ...(opts.confirmed === true ? { confirmed: true } : {}),
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
      ...(opts.confirmed === true ? { confirmed: true } : {}),
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
   * Rename a task — the board's in-place title edit (§3.9: tap the title
   * text, Enter commits). No event fires: §3.6's exhaustive table has no
   * task.renamed row, so callers (the route) must refresh the projection by
   * hand, the same pattern as attachDoc and a triage confirm-in-place.
   */
  renameTask(
    taskId: string,
    title: string,
    _opts: { actor: { id: string; name: string } },
  ): RenameTaskResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.title === title) return { ok: true, task, changed: false };
    task.title = title;
    task.updatedAt = Date.now();
    this.scheduleSave(task.workspaceId);
    return { ok: true, task, changed: true };
  }

  /**
   * Record that somebody replaced a task's description. The text itself
   * lives in the `task:<id>` doc room and reaches this store as a snapshot,
   * so this does not take the markdown — it exists so the rewrite has an
   * attributed row in the audit log, which is the half `set_doc_content` on
   * the body room could never provide (a doc edit knows nothing about
   * tasks).
   */
  noteBodyEdited(
    taskId: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): boolean {
    const task = this.getTask(taskId);
    if (!task) return false;
    const ts = Date.now();
    task.updatedAt = ts;
    task.bodyWrittenAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'task.body_edited',
      workspaceId: task.workspaceId,
      taskId: task.id,
      actor: { id: opts.actor.id, name: opts.actor.name, kind: classifyActor(opts.actor) },
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
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetAssigneeResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    const from = task.assignee;
    if (from === assignee) return { ok: true, task, changed: false };
    const ts = Date.now();
    task.assignee = assignee;
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
   * Place a task under a goal (or subgoal) at an exact position — the write
   * half of triage (§3.4: the agent picks the exact spot, not just the
   * bucket) and the board's regroup/rerank gesture (§3.3: open to everyone,
   * Bryan AND agents; every move recorded).
   *
   * Placement IS triage, so every call — moved or confirmed in place —
   * stamps `triagedAgainst` with the goal text it was judged against and
   * clears the triage-pending marker; `riskTier` is stamped when supplied
   * (§3.4: stored at decision time, so the after-the-fact review grades the
   * agent against what it knew). A goal or position change emits
   * `task.regrouped`; a pure confirm emits nothing — §3.6 has no
   * task.triaged row, and a no-move event would be noise in every feed.
   */
  setTaskGoal(
    taskId: string,
    goal: string,
    opts: {
      actor: { id: string; name: string; kind?: string };
      /** Fractional position within the goal. Omitted → bottom of the goal
       *  (an unchanged goal keeps the current position). */
      position?: number;
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
    const order =
      opts.position ??
      (goal === fromGoal
        ? task.order
        : Math.max(
            0,
            ...Array.from(state.tasks.values())
              .filter((t) => t.goal === goal && t.id !== taskId)
              .map((t) => t.order),
          ) + 1);
    const changed = goal !== fromGoal || order !== task.order;

    task.goal = goal;
    task.order = order;
    task.triagedAgainst = { goalId: goal, goal: state.workspace.goal, ts };
    // The placement fulfils whatever triage request stamped the marker.
    // Assignment, not delete (biome noDelete); JSON.stringify drops it from
    // the sidecar either way, same as the hydrate-time clear.
    task.triagePendingTs = undefined;
    // Somebody has now named this task's band — including a confirm-in-place
    // into Chores, which is a judgement rather than a fallback. The owed
    // review is answered, so it must not be asked again.
    task.unplacedSince = undefined;
    if (opts.riskTier !== undefined) task.riskTier = opts.riskTier;
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
   * 'chores' is reserved and never present in goals[]; open tasks whose goal
   * or subgoal id disappears are moved to Chores, each emitting a
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
   * Chores, its done tasks left pointing at an id that is gone, and a
   * successful-looking result. The damage is proportional to how much the
   * band held, and it surfaces days later as "why is my top band empty".
   * `renameGoal` is the non-destructive way to change a title; this guard is
   * what makes the destructive path stop being the DEFAULT one. It fires
   * only for ids that actually hold tasks, so it can never refuse a call
   * that was about to lose nothing.
   */
  setGoalList(
    workspaceId: string,
    goals: WorkspaceGoal[],
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

    const ids: string[] = [];
    for (const g of goals) {
      ids.push(g.id);
      for (const s of g.subgoals ?? []) ids.push(s.id);
    }
    if (ids.includes(CHORES_GOAL_ID)) return { ok: false, error: 'reserved-goal-id' };
    if (new Set(ids).size !== ids.length) return { ok: false, error: 'duplicate-goal-id' };

    const oldGoals = workspace.goals;
    if (JSON.stringify(oldGoals) === JSON.stringify(goals)) {
      return { ok: true, workspace, changed: false, movedToChores: [], strandedDone: [] };
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
      // Both halves count. The open one is swept to Chores (loud-ish, it is
      // reported); the done one silently orphans, and is the half nothing
      // used to mention.
      if (openTasks + doneTasks > 0) {
        stranding.push({ id: removed.id, title: removed.title, openTasks, doneTasks });
      }
    }
    if (stranding.length > 0) return { ok: false, error: 'would-strand-tasks', stranding };

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

    // Open tasks whose goal id disappeared land at the bottom of Chores.
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
      movedToChores: moved.map((m) => m.task.id),
      strandedDone,
    };
  }

  /**
   * Change a goal's TITLE (and optionally its dueAt) in place, at either
   * scope, without touching its id — the common half of what `set_goal_list`
   * was being used for, separated from the destructive half.
   *
   * The whole contract is that nothing can move. A task's band is its goal
   * ID, and no reachable input here changes an id, so a rename cannot sweep
   * open work to Chores and cannot orphan a done task. That is the point:
   * before this existed, the natural gesture for "rename this band" was to
   * submit the full list with a new id, which the store reads as a removal
   * plus an addition and which strands everything the band held.
   *
   * `chores` is refused as RESERVED rather than not-found — it is a real row
   * a caller genuinely saw in the read, and its label is fixed, so "no such
   * goal" would send them hunting for a typo. Same split `reorderGoals`
   * draws for the same reason.
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
    if (goalId === CHORES_GOAL_ID) return { ok: false, error: 'reserved-goal-id' };

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
   * Reorder goals at ONE scope — the top-level list, or the subgoals of
   * `parent` — and nothing else. The priority gesture, separated from the
   * edit.
   *
   * PERMUTATION ONLY, and that constraint is the entire point. `setGoalList`
   * is a full replace, so reordering through it means restating every id and
   * title, and any id a stale caller omits sends that goal's open tasks to
   * the bottom of Chores — the most ordinary gesture on a board carrying the
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
        const bucket = id === CHORES_GOAL_ID ? reservedIds : unknownIds;
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

  /**
   * The §3.4 risk arm of the gate, for an AGENT actor moving forward.
   *
   * Red = the D-class stops made general (irreversible deletes, force
   * pushes, breaking default-branch merges, credentials, one-way doors):
   * refused outright. Yellow = outward-facing or hard to reverse: allowed
   * only with the human's confirmation carried on the request. Green (and
   * an untriaged task with no tier yet) passes untouched — a tier that
   * blocks by DEFAULT would stop ordinary work on every task triage hasn't
   * reached, which is the opposite of what §3.4 asks for.
   *
   * The message is written to land verbatim in the agent's context, the
   * same way an enforce blocker's does.
   */
  private riskRefusal(
    task: Task,
    confirmed: boolean | undefined,
  ): {
    error: 'risk-refused' | 'needs-confirmation';
    riskTier: 'yellow' | 'red';
    message: string;
  } | null {
    if (task.riskTier === 'red') {
      return {
        error: 'risk-refused',
        riskTier: 'red',
        message: `refused: ${task.id} is red-tier ('${task.title}') — a person has to make this move`,
      };
    }
    if (task.riskTier === 'yellow' && confirmed !== true) {
      return {
        error: 'needs-confirmation',
        riskTier: 'yellow',
        message: `blocked: ${task.id} is yellow-tier ('${task.title}') — ask the human, show them the concrete effect, then retry with confirmed:true`,
      };
    }
    return null;
  }

  private goalIdExists(workspace: HubWorkspace, goalId: string): boolean {
    if (goalId === CHORES_GOAL_ID) return true;
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
   * open gating decisions and the untriaged Chores tasks to sweep (§3.4) —
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
      this.assignLead(state, opts.agentId, {
        id: opts.agentId,
        name: opts.agentId,
        kind: 'agent',
      });
    }
    const lead = state.workspace.leadAgentId === opts.agentId;
    // Only the lead carries the waiting goal edit off. A bystander attaching
    // must leave it where it is, or the request is "delivered" to whoever
    // showed up first — the failure this whole path exists to end.
    const pendingRetriage = lead ? this.getPendingRetriage(workspaceId) : undefined;
    if (pendingRetriage) this.clearPendingRetriage(state);
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
      queuedVoice: this.drainVoiceQueue(workspaceId),
      ...(pendingRetriage ? { pendingRetriage } : {}),
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
      route: 'fast-path' | 'agent' | 'agent-queued';
      ack: string;
      context?: unknown;
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
    },
  ): boolean {
    if (!this.workspaces.has(workspaceId)) return false;
    const queued: QueuedVoiceRequest = {
      transcript: item.transcript,
      ...(item.context !== undefined ? { context: item.context } : {}),
      actor: { id: item.actor.id, name: item.actor.name, kind: classifyActor(item.actor) },
      ts: Date.now(),
    };
    const path = voiceQueuePath(this.dataDir, workspaceId);
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const existing = this.listQueuedVoice(workspaceId);
      writeFileSync(path, `${JSON.stringify({ queue: [...existing, queued] }, null, 2)}\n`);
      return true;
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

  /** Hand the queue over and clear it — called by attachAgent, whose result
   *  is the delivery. */
  private drainVoiceQueue(workspaceId: string): QueuedVoiceRequest[] {
    const queued = this.listQueuedVoice(workspaceId);
    try {
      rmSync(voiceQueuePath(this.dataDir, workspaceId), { force: true });
    } catch {}
    return queued;
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
    return { ok: true, attachment };
  }

  /** Bump lastToolCallAt to now. No event — tool calls are not a §3.6 row;
   *  the next heartbeat event carries the moved clock. */
  noteAgentToolCall(workspaceId: string, agentId: string): boolean {
    const attachment = this.workspaces.get(workspaceId)?.attachments.get(agentId);
    if (!attachment) return false;
    attachment.lastToolCallAt = Date.now();
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
   * Is any attachment's heartbeat fresh? This is what grounds the triage
   * pending marker (§3.4): "emitted to a live attachment" means someone with
   * a live process is subscribed to act — existence alone proves nothing
   * (a record whose runtime died an hour ago is `away`, and promising it
   * work would be the summaries-incident lie again).
   */
  hasLiveAttachment(workspaceId: string): boolean {
    const state = this.workspaces.get(workspaceId);
    if (!state) return false;
    const now = Date.now();
    const freshMs = this.attachmentThresholds.heartbeatFreshMs ?? HEARTBEAT_FRESH_MS;
    for (const att of state.attachments.values()) {
      if (now - att.lastHeartbeat < freshMs) return true;
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
    const freshMs = this.attachmentThresholds.heartbeatFreshMs ?? HEARTBEAT_FRESH_MS;
    return Date.now() - att.lastHeartbeat < freshMs;
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
          // to plainly sitting in Chores until an agent attaches and sweeps.
          task.triagePendingTs = undefined;
          // `unplacedSince` is deliberately NOT cleared here — see the field.
          // But every task written before it existed lacks it, and the sweep
          // now keys on it, so a writer-only fix would empty the bucket for
          // the entire existing board at the deploy. Reproduce the membership
          // rule the old predicate used (Chores + open + never placed) and
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
        this.workspaces.set(workspace.id, {
          workspace,
          tasks,
          attachments: this.loadAttachments(workspace.id),
          // Unlike a task's triage marker above, a queued goal edit SURVIVES
          // the restart: the marker promised in-flight work that the restart
          // killed, this is a request nobody has answered yet.
          ...(pendingRetriage ? { pendingRetriage } : {}),
        });
      } catch (err) {
        // A corrupt sidecar loses that one workspace, never the server.
        console.error(`[tasks] unreadable sidecar ${entry} — skipped:`, err);
      }
    }
  }
}
