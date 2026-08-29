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
  type ReviewItemRange,
  type ReviewItemRevision,
  type ReviewPayload,
  type TaskReviewItem,
  agentIdCandidates,
  changedRange,
  checkReviewPayload,
  isReviewItemOpen,
  latestThreadedQuestion,
  readReviewPayload,
  readTaskReviewItem,
  reviewFromDecisionTask,
  reviewGapAdvice,
  reviewPayloadMessage,
} from '@feedback/core';
import { classifyActor } from './activity.ts';
import {
  type DecisionShapeGap,
  checkDecisionShape,
  decisionShapeMessage,
} from './decision-shape.ts';
import {
  AUTHOR_REQUIRED_MESSAGE,
  type DeclaredOwnerKind,
  GENERIC_ASSIGNEE,
  HUMAN_ASSIGNEE,
  declaredAssigneeKind,
  isCategoryAuthor,
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
  createdAt: number;
}

/**
 * Is this board stood down? The single reader of `retiredAt`, so the
 * absent/false/0 question is answered in one place rather than at each of the
 * dozen enumeration sites that now ask it.
 */
export function isRetired(workspace: HubWorkspace): boolean {
  return workspace.retiredAt !== undefined;
}

/** The reason clause, or empty — factored out so the refusal and the notice
 *  can never disagree about whether there was one. */
function retiredBecause(workspace: HubWorkspace): string {
  return workspace.retiredReason ? ` Reason given: ${workspace.retiredReason}.` : '';
}

/**
 * Why a write to a retired board was refused, written to land verbatim in an
 * agent's context. It names the board, replays the operator's reason, and
 * states the two ways forward — because a refusal an agent cannot act on
 * produces a retry loop or a giving-up, and both look like the tool is broken.
 */
export function retiredRefusal(workspace: HubWorkspace): string {
  return (
    `"${workspace.name}" (${workspace.id}) is RETIRED and is not taking new work.` +
    `${retiredBecause(workspace)} Nothing on it was deleted — every task, doc and thread ` +
    'is still there to read. File this on the board that replaced it, or un-retire this ' +
    'one first if it is the live board after all.'
  );
}

/** What an agent reading or attaching to a retired board is told. */
export function retiredNotice(workspace: HubWorkspace): RetiredNotice {
  return {
    since: workspace.retiredAt ?? 0,
    ...(workspace.retiredReason ? { reason: workspace.retiredReason } : {}),
    notice:
      `This board is RETIRED — it is not ranked and takes no new work.${retiredBecause(workspace)} ` +
      'Everything on it survives and is readable; if this is the board you meant to work, ' +
      'un-retire it before filing anything.',
  };
}

/**
 * The key two board names are THE SAME under.
 *
 * Case and surrounding whitespace are not how a person tells two boards
 * apart, so a warning that only fired on an exact byte match would miss
 * `Harbor-Relay` beside `harbor-relay` — which is the same lost night with a
 * shift key involved.
 */
export function normalizeWorkspaceName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * `triage` is ordered first because it is what a row is BEFORE `todo`: an
 * agent filed it and nobody has vetted it yet. It is a status rather than a
 * bucket deliberately — the row keeps its goal, its order and its band
 * position, so a lead reads it where the work is instead of in a holding pen
 * that has to be remembered separately. What it changes is one thing: no
 * dispatch read returns it (`buildQueue`), so nothing picks it up until a
 * person or an agent moves it out through the ordinary gate.
 */
export type TaskStatus = 'triage' | 'todo' | 'in-progress' | 'done';

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

/**
 * Is this row archived — soft-deleted, off every lane and every queue, and one
 * call from coming back?
 *
 * The ONE reader of `archivedAt`, deliberately: "archived" has to mean the
 * same thing to the board, the queue and the nudger, and a second comparison
 * of the field with a different default is how two surfaces come to disagree
 * about the same row.
 */
export function isArchived(task: { archivedAt?: number }): boolean {
  return task.archivedAt !== undefined;
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

const TASK_STATUSES: ReadonlySet<string> = new Set(['triage', 'todo', 'in-progress', 'done']);

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
  links: Ref[];
  /**
   * What the done-artifact check found in this row's `links` the last time it
   * moved to done. Advisory bookkeeping, written AFTER the transition
   * committed (`recordArtifactCheck`) — its absence on a done row means the
   * row had no links or predates the check, never that the transition failed.
   */
  artifactCheck?: ArtifactCheck;
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
  /** Fractional sort key among the board's goal rows: priority order. */
  order: number;
  status: TaskStatus;
  /** Append-only audit trail — who declared the goal done, and when. */
  transitions: TaskTransition[];
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
  | { ok: true; task: BoardRow; blockers: TransitionBlocker[] }
  | {
      ok: false;
      error: 'not-found' | 'bad-status' | 'same-status' | 'blocked';
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

export type AttachAgentResult =
  | {
      ok: true;
      attachment: AgentAttachment;
      gating: GatingSummary;
      /** Open Backlog tasks nobody has placed under a goal — what the lead
       *  looks over after attaching. */
      untriaged: string[];
      /** Voice change-requests that arrived while no agent was live (§2.4
       *  "agent away — queued"). Delivered HERE — in the attach result, the
       *  one payload a fresh attachment is guaranteed to read — and drained:
       *  a second attach gets an empty list. Only ever handed to the LEAD;
       *  a bystander attaching leaves the queue intact (and this field
       *  absent) for the lead's next attach. */
      queuedVoice?: QueuedVoiceRequest[];
      /** Comments addressed to THIS agent that it has not yet receipted.
       *  Handed over here (a fresh process holds nothing in flight) but NOT
       *  drained: unlike `queuedVoice`, a row leaves the queue only on the
       *  receiving process's ack, so a handover the session never read is
       *  re-offered after the grace window rather than lost. Addressed by
       *  agentId rather than gated on the lead seat, so a bystander is
       *  handed its OWN rows and nobody else's. */
      queuedComments: QueuedComment[];
      /** Is THIS attachment the workspace's lead agent — either because it
       *  already held the seat, or because it just claimed an empty one? The
       *  lead is the addressee for anything that needs one, so a fresh
       *  context needs to know which it is without a second call. */
      lead: boolean;
      /** This board has been stood down. Present iff retired, and carried in
       *  the attach result for the same reason the queues are: it is the one
       *  payload a fresh session is guaranteed to read. `notice` is written
       *  to land verbatim in an agent's context. */
      retired?: RetiredNotice;
      /**
       * This agent leads ANOTHER live board with the same name.
       *
       * The whole of the 2026-08-19 incident in one field: two boards, one
       * name, one lead agent, different goal lists, and nothing anywhere that
       * said so. Lead-only — a bystander attaching is not the one who will
       * pick the wrong board — and computed over live boards only, so
       * retiring one of the pair clears it.
       */
      leadNameConflicts?: LeadNameConflicts;
    }
  | { ok: false; error: 'workspace-not-found' }
  /** The id was folded into another by a merge; `into` is the one to use.
   *  Attaching under the old id would recreate the duplicate the merge
   *  removed and route this session's deliveries to a key nothing reads. */
  | { ok: false; error: 'merged-away'; into: string; message: string }
  | {
      ok: false;
      /** The shared "agent" identity tried to attach. A category cannot hold
       *  a seat or be owed a delivery — see `isCategoryAuthor`. */
      error: 'author-required';
      message: string;
    };

/** What an agent is told when it reads a board that has been stood down. */
export interface RetiredNotice {
  /** When it was retired. */
  since: number;
  reason?: string;
  /** Prose, because the reader is a language model with no schema for this
   *  and one sentence it can act on beats a flag it has to interpret. */
  notice: string;
}

export interface LeadNameConflicts {
  /** The other live boards this agent leads under the same name. */
  boards: SameNamedWorkspace[];
  /** Prose naming the boards, for the same reason as `RetiredNotice`. */
  notice: string;
}

export type HeartbeatResult =
  | {
      ok: true;
      attachment: AgentAttachment;
      queuedVoice?: QueuedVoiceRequest[];
      /** Comments addressed to this agent whose grace has lapsed (or that
       *  were never emitted). Marked emitted by this handover; the caller
       *  (server route) re-sends each as an addressed frame carrying the row
       *  id, and the row clears on the ack. */
      queuedComments?: QueuedComment[];
    }
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
  reason?: string;
  actor: TaskActor;
  ts: number;
}

export interface TaskRestoredEvent {
  type: 'task.restored';
  workspaceId: string;
  taskId: string;
  title: string;
  /** The reason the archive carried, echoed here so the pair reads as one
   *  story without a lookup. Absent when it was archived without one. */
  reason?: string;
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

export type TaskStoreEvent =
  | ReviewItemRevisedEvent
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
  | DecisionAnsweredEvent
  | DecisionAnswerWithdrawnEvent
  | DecisionInfoRequestedEvent
  | WorkspaceLeadChangedEvent
  | WorkspaceRetiredChangedEvent
  | WorkspaceRenamedEvent
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
 * One comment waiting for the agent it is addressed to.
 *
 * Same durable-queue contract as `QueuedVoiceRequest` — the queue is the
 * record, live delivery is the fast path, and the row clears on a receipt
 * from the receiving process — with the one divergence voice got wrong and
 * this queue must not copy: the row is ADDRESSED. `agentId` names who it is
 * for at queue time, and every drain filters on it, so a bystander attaching
 * first cannot walk off with the lead's comments.
 */
export interface QueuedComment {
  /** Names this row so a receipt can clear exactly one. */
  id: string;
  /** The agent this row is FOR. It drains only to this agent. */
  agentId: string;
  docId: string;
  threadId?: string;
  /** The broadcast this row stands in for: thread.created | thread.replied. */
  event: string;
  /** Who wrote the comment — never the addressee; the queue site excludes
   *  an agent's own comments before a row is written. */
  author: { id: string; name: string };
  text: string;
  /**
   * The broadcast payload verbatim, replayed on redelivery so the frame an
   * agent gets late is the same frame it would have gotten live — plus the
   * `commentQueueId` the redelivery stamps on top.
   */
  payload?: unknown;
  /** When the server last put this row on the wire (see QueuedVoiceRequest —
   *  emitted is not delivered; the grace window is measured from here). */
  emittedAt?: number;
  ts: number;
}

/** Where a workspace's queued comments persist. Exported so tests assert the
 *  real contract path. */
export function commentQueuePath(dataDir: string, workspaceId: string): string {
  return join(dataDir, 'workspaces', `${workspaceId}.comment-queue.json`);
}

/**
 * The queue is DELIVERY state, not the record — the comment itself lives in
 * its thread's ydoc. An addressee that never sends receipts (a session on an
 * old bundle) must not grow the file without bound, so past this many rows
 * the oldest are dropped. Capping delivery bookkeeping is not a soft-delete
 * concern (CLAUDE.md: "the rule is about user content and history").
 */
export const MAX_QUEUED_COMMENTS = 200;

/** Same reasoning as VOICE_ACK_GRACE_MS, same number: past it an unacked row
 *  is far more likely lost than pending, and re-offering costs at worst one
 *  duplicate frame (which the MCP's eid dedup collapses) where NOT
 *  re-offering costs the comment. */
export const COMMENT_ACK_GRACE_MS = VOICE_ACK_GRACE_MS;

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

export type ReviseReviewItemResult =
  | {
      ok: true;
      task: Task;
      item: TaskReviewItem;
      /** The anchored thread the revision answers, when a question was asked
       *  doc-style — where a reply belongs. */
      threadId?: string;
      advice?: string;
    }
  | {
      ok: false;
      error:
        | 'not-found'
        | 'unknown-review-item'
        | 'not-revisable'
        | 'answered'
        | 'empty-patch'
        | 'bad-review'
        | 'bad-range';
      /** The verbatim refusal, present for 'bad-review', 'answered' and 'bad-range'. */
      message?: string;
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

interface WorkspaceState {
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

  createWorkspace(name: string, opts?: { leadAgentId?: string }): HubWorkspace {
    const now = Date.now();
    const lead = opts?.leadAgentId?.trim();
    const workspace: HubWorkspace = {
      id: cryptoId('w'),
      name,
      goals: [],
      docIds: [],
      // The creating agent is the lead by default. No event: nothing is
      // subscribed to a workspace that did not exist a line ago.
      ...(lead ? { leadAgentId: lead, leadAgentSince: now } : {}),
      createdAt: now,
    };
    this.workspaces.set(workspace.id, {
      workspace,
      tasks: new Map(),
      goalRows: new Map(),
      attachments: new Map(),
    });
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
    // Leak hygiene, and deliberately NOT load-bearing: `getGoalRow` re-reads
    // the workspace map, so a stale entry here already resolves to undefined
    // and no caller can observe the difference. What it prevents is the index
    // growing without bound across a server's lifetime of board deletes. Said
    // plainly because a test cannot tell this line from its absence — the one
    // below pins the lookup CONTRACT, not this sweep.
    for (const goalId of state.goalRows.keys()) this.goalIndex.delete(goalId);
    this.workspaces.delete(workspaceId);

    // None of these can resurrect the board, so a failure here is litter
    // rather than a lie — log it and let the delete stand. The list is every
    // OTHER per-workspace path this file exports; a new sidecar belongs here
    // the day it is added, or it becomes a file nothing can reach.
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
    return { ok: true, deletedTasks: taskIds.length, taskIds };
  }

  listWorkspaces(): HubWorkspace[] {
    return Array.from(this.workspaces.values()).map((s) => s.workspace);
  }

  /**
   * Stand a board down, or bring it back. The REVERSIBLE middle between a
   * live board and `deleteWorkspace`.
   *
   * Nothing is written but this one field, and that is the design rather than
   * an economy: the tasks sidecar is serialized wholesale, so the retirement
   * rides along with everything it holds and un-retiring is a second write of
   * the same field. There is no staging directory, no rename, no file to
   * restore from — which means there is nothing that can half-fail and leave
   * a board neither retired nor live.
   *
   * What retirement CHANGES is small and enumerable: the board stops ranking
   * on the workspace list (it folds into a labelled, counted `Retired`
   * section rather than vanishing — a cut list states what it cut), it
   * refuses new tasks, and it says so on read and on attach. Everything
   * already on it stays readable and its in-flight tasks stay transitionable,
   * because freezing those would strand whatever was running when somebody
   * retired the board and the only exit would be un-retiring it — which is
   * the ambiguity the feature exists to remove.
   */
  setWorkspaceRetired(
    workspaceId: string,
    retired: boolean,
    opts: { actor: { id: string; name: string; kind?: string }; reason?: string },
  ): SetWorkspaceRetiredResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    // Already in the requested state: report it and stamp nothing. Restamping
    // `retiredAt` would move the "since" every surface reports, so a second
    // retire — which an agent re-running a cleanup makes by accident — would
    // rewrite the board's history to say it was stood down just now.
    if (isRetired(workspace) === retired) return { ok: true, workspace, changed: false };

    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    const ts = Date.now();
    // Cleared to `undefined` rather than deleted, which is the same thing to
    // every reader here: `isRetired` and the projection both test `!==
    // undefined`, and `JSON.stringify` drops an undefined-valued key entirely,
    // so the sidecar holds no `retiredAt` at all and hydrate reads it as live.
    // What must NOT happen is writing `null` — that is a present value and
    // would read as retired forever.
    const reason = retired ? opts.reason?.trim() : undefined;
    workspace.retiredAt = retired ? ts : undefined;
    workspace.retiredBy = retired ? actor : undefined;
    workspace.retiredReason = reason ? reason : undefined;
    this.scheduleSave(workspaceId);
    this.emit({
      type: 'workspace.retired_changed',
      workspaceId,
      retired,
      ...(retired && workspace.retiredReason ? { reason: workspace.retiredReason } : {}),
      actor,
      ts,
    });
    return { ok: true, workspace, changed: true };
  }

  /**
   * Rename a board.
   *
   * `createWorkspace` set the name once and nothing changed it, so two boards
   * could carry one name forever — and a name is how an agent picks. This is
   * the other half of the fix: retiring stands the stale one down, renaming
   * tells the two apart while both are live.
   *
   * The rename is not gated on uniqueness. Refusing a duplicate would block
   * the legitimate middle of a cleanup (rename A, then rename B) and would
   * not undo the duplicates already on disk. Instead the result NAMES the
   * boards that now share the name, so a caller that collided finds out from
   * the call rather than from a lost night.
   */
  renameWorkspace(
    workspaceId: string,
    name: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): RenameWorkspaceResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;
    const next = name.trim();
    if (next.length === 0) return { ok: false, error: 'empty-name' };

    const sameName = this.liveWorkspacesNamed(next, { exclude: workspaceId });
    if (next === workspace.name) {
      return { ok: true, workspace, changed: false, ...(sameName.length > 0 ? { sameName } : {}) };
    }
    const oldName = workspace.name;
    workspace.name = next;
    this.scheduleSave(workspaceId);
    this.emit({
      type: 'workspace.renamed',
      workspaceId,
      oldName,
      name: next,
      actor: {
        id: opts.actor.id,
        name: opts.actor.name,
        kind: classifyActor(opts.actor),
      },
      ts: Date.now(),
    });
    return { ok: true, workspace, changed: true, ...(sameName.length > 0 ? { sameName } : {}) };
  }

  /**
   * Every LIVE board carrying this name, minus one. Retired boards are
   * deliberately not counted: standing a duplicate down is exactly the fix,
   * so counting it would leave the operator doing the right thing and being
   * told nothing changed.
   */
  private liveWorkspacesNamed(name: string, opts: { exclude: string }): SameNamedWorkspace[] {
    const key = normalizeWorkspaceName(name);
    const out: SameNamedWorkspace[] = [];
    for (const state of this.workspaces.values()) {
      const ws = state.workspace;
      if (ws.id === opts.exclude || isRetired(ws)) continue;
      if (normalizeWorkspaceName(ws.name) === key) out.push({ workspaceId: ws.id, name: ws.name });
    }
    return out;
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
    // The seat must route somewhere REAL — this method is the addressing
    // authority for every lead-addressed delivery (queued voice notes, goal
    // re-triage, bucket and task reviews), and it used to accept ANY trimmed
    // string. A typo'd or fabricated id took the seat and the queue silently
    // stopped draining: nothing anywhere reported that the addressee did not
    // exist. Checked FIRST, before the same-id no-op, so '' can never equal
    // anything — it used to trim to '' and be assigned.
    if (next.length === 0) {
      return {
        ok: false,
        error: 'empty-lead-agent-id',
        message: 'leadAgentId is empty — the lead seat needs a real agent id.',
      };
    }
    // The seat routes deliveries to SOMEBODY. The shared category — as the
    // proposed holder or as the caller — is nobody in particular, and a seat
    // held by it is exactly the state this refusal was written against
    // (one live board, lead seat "known-agent", 1,031 unattributed rows).
    if (isCategoryAuthor({ id: next }) || isCategoryAuthor(opts.actor)) {
      return { ok: false, error: 'author-required', message: AUTHOR_REQUIRED_MESSAGE };
    }
    if (next === workspace.leadAgentId) return { ok: true, workspace, changed: false };
    // Naming a THIRD PARTY is a deliberate handover, and a handover needs an
    // addressee this workspace has a record of. The record is the attachments
    // map: an agent that attached and went AWAY is still in it (recovering a
    // dead session's seat is a supported flow — dead sessions do not detach),
    // while an id nobody ever attached is not. SELF-declaration is exempt by
    // definition — `next === actor.id` is a real, live caller, and the
    // bootstrap order must not matter (older bundles declare before they
    // attach; the store cannot assume attach came first).
    if (next !== opts.actor.id && !state.attachments.has(next)) {
      return {
        ok: false,
        error: 'unknown-lead-agent',
        message:
          `no agent "${next}" has ever attached to this workspace — a lead the board has ` +
          'no record of would receive none of the deliveries addressed to the seat. ' +
          'Name an agent that has attached here, or have that agent declare itself lead.',
      };
    }
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
    return {
      ok: true,
      workspace,
      changed: true,
      ...(previousLeadAgentId !== undefined ? { previousLeadAgentId } : {}),
    };
  }

  /**
   * Fold agent id `from` into `into` on EVERY board: the seat moves where
   * `from` held it, and `from`'s attachment record is re-keyed (the fresher
   * clocks win where `into` already had one). This is the board half of a
   * rename — the roster half is `Identities.mergeAgent`, the durable-watch
   * half `AgentWatches.rekey` — and the three are composed by the merge
   * route so one verb does all of it.
   *
   * Nothing here bypasses `assignLead`: the seat change persists and
   * announces exactly like a handover, so the board repaints and the audit
   * log carries who did it. `dryRun` computes the same answer and touches
   * nothing, which is what an operator runs first against prod's data.
   */
  mergeAgent(
    from: string,
    into: string,
    opts: { actor: { id: string; name: string; kind?: string }; dryRun?: boolean },
  ): { seats: string[]; seatsSkipped: string[]; attachments: string[]; comments: string[] } {
    const seats: string[] = [];
    const seatsSkipped: string[] = [];
    const attachments: string[] = [];
    const comments: string[] = [];
    const result = () => ({
      seats: seats.sort(),
      seatsSkipped: seatsSkipped.sort(),
      attachments: attachments.sort(),
      comments: comments.sort(),
    });
    if (from.trim() === '' || into.trim() === '' || from === into) return result();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    for (const state of this.workspaces.values()) {
      const workspaceId = state.workspace.id;
      const old = state.attachments.get(from);
      if (old) {
        attachments.push(workspaceId);
        if (!opts.dryRun) {
          const existing = state.attachments.get(into);
          const fresher = existing && existing.lastHeartbeat >= old.lastHeartbeat ? existing : old;
          state.attachments.delete(from);
          state.attachments.set(into, { ...fresher, agentId: into });
          this.scheduleAttachmentsSave(workspaceId);
        }
      }
      if (state.workspace.leadAgentId === from) {
        // The same rule as a hand-over (`setLeadAgent`): the seat routes
        // deliveries to somebody this board has a record of. After the
        // re-key above that is the target itself whenever the old id was
        // attached; when it was NOT — a seat held by an id nothing ever
        // attached under, `known-agent` included — moving it would hand the
        // seat to an id the queue cannot reach, which is exactly the state
        // the unknown-lead check exists to refuse. Reported, not silent.
        // On a dry run nothing was re-keyed yet, so "the old id was
        // attached" is what "the target will be attached" looks like.
        const targetAttached =
          state.attachments.has(into) || (opts.dryRun === true && old !== undefined);
        if (targetAttached) {
          seats.push(workspaceId);
          if (!opts.dryRun) this.assignLead(state, into, actor, Date.now());
        } else {
          seatsSkipped.push(workspaceId);
        }
      }
      // The un-acked backlog is delivery bookkeeping keyed by addressee, and
      // an addressee that no longer exists never acks: without this re-key
      // every comment queued for the old id sat under it until the per-agent
      // cap dropped it, while the new id attached to an empty list.
      const backlog = this.listQueuedComments(workspaceId);
      if (backlog.some((q) => q.agentId === from)) {
        comments.push(workspaceId);
        if (!opts.dryRun) {
          this.writeCommentQueue(
            workspaceId,
            backlog.map((q) => (q.agentId === from ? { ...q, agentId: into } : q)),
          );
        }
      }
      // A re-key is an attachment change, and the board projects off store
      // events: without this the rows owned under the old id keep drawing
      // it until something unrelated touches a task. Emitted for the
      // SURVIVING id, after every change above, like `attachAgent` does.
      const survivor = !opts.dryRun && old ? state.attachments.get(into) : undefined;
      if (survivor) {
        const now = Date.now();
        this.emit({
          type: 'agent.attached',
          workspaceId,
          agentId: into,
          attachment: publicAttachment(survivor, now, this.attachmentThresholds),
          ts: now,
        });
      }
    }
    return result();
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
   * transitive: attachDoc can link a whole review (diff review) by
   * its review id, and this resolver does not widen to that review's
   * member docs.
   */
  workspaceOfDoc(docId: string): string | null {
    if (docId.startsWith('task:')) {
      // A `task:` room is a TASK's body or a GOAL's — one prefix, two kinds of
      // row (see `ensureGoalBody` in task-projection.ts). Asking only
      // `getTask` answered null for every goal, and null here is not a
      // harmless miss: it is what the back-link, the review URL and SHARE
      // SCOPING resolve against, so a goal's description opened with no way
      // back to its board and a share visitor was refused it outright.
      const rowId = docId.slice('task:'.length);
      return (this.getTask(rowId) ?? this.getGoalRow(rowId))?.workspaceId ?? null;
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
      status: initialTaskStatus(opts.actor),
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
    const live = new Set(flattenGoals(state.workspace.goals).map((g) => g.id));
    return Array.from(state.goalRows.values())
      .filter((row) => live.has(row.id))
      .sort((a, b) => a.order - b.order);
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
   * Subgoals flatten into rows of their own, in the position the board already
   * draws them — it has rendered one flat level all along.
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
    flattenGoals(state.workspace.goals).forEach((g, index) => {
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
    if (!TASK_STATUSES.has(to)) return { ok: false, error: 'bad-status' };
    if (task.status === to) {
      return {
        ok: false,
        error: 'same-status',
        message: `${task.title} is already ${to}. Nothing to do — a status change is the only thing this gate records, and the row is already there.`,
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
   * How much of this ticket is still waiting on a person — and, separately,
   * how much of it could not be READ.
   *
   * The second number is the whole reason this exists next to
   * `listReviewItems`. That reader deliberately drops a row that does not
   * parse, so a ticket whose questions are corrupt answers "no open
   * questions", byte-identical to a ticket that genuinely has none. That is
   * fine for a renderer — better a short list than a thrown exception inside a
   * card — and wrong for anything that ACTS on the answer, which the ready-work
   * gate does: it would read an unreadable ticket as free work and wake
   * somebody about a row that may well be blocked on Bryan.
   *
   * `open` counts the legacy `needs: 'decision'` row too, because
   * `listReviewItems` derives one — so both spellings of "a question is
   * outstanding" arrive here as one number and cannot drift apart.
   *
   * `undefined` for a task that does not exist. Not `{ open: 0, unreadable: 0 }`:
   * "this ticket is clear" and "there is no such ticket" are the two answers
   * this method exists to keep apart, so it must not merge them itself.
   */
  reviewState(taskId: string): { open: number; unreadable: number } | undefined {
    const task = this.getTask(taskId);
    if (!task) return undefined;
    const open = this.listReviewItems(taskId).filter(isReviewItemOpen).length;
    let unreadable = 0;
    for (const raw of task.reviews ?? []) {
      if (!readTaskReviewItem(raw)) unreadable++;
    }
    return { open, unreadable };
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
    item.infoRequests = [
      ...(item.infoRequests ?? []),
      {
        text: question,
        by: actor.name,
        ts,
        ...(opts.threadId !== undefined ? { threadId: opts.threadId } : {}),
        ...(opts.range !== undefined ? { range: opts.range } : {}),
      },
    ];
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
   * Rewrite ONE review item's words in place, keeping what they were.
   *
   * The owner's answer to a question asked on the item: not a reply that
   * leaves the ask as confusing as it was, but the ask itself made clearer.
   * `patch` names only the fields that change; the merged payload passes the
   * SAME gate a new item does (`checkReviewPayload`), so a revision cannot
   * smuggle in what a filing would have been refused.
   *
   * The previous text goes onto `revisions` — user content is never
   * overwritten in place — stamped with the anchored thread it answers (the
   * newest doc-style question) and with where the change landed in the new
   * text: the caller's `revisedRange` if given, else the prefix/suffix diff
   * of the detail. `reviewItemState` reads the item as `revised` from here,
   * which is what puts it back on the queue.
   *
   * The derived legacy row (`r-legacy`) is refused: its words are the task's
   * title and body, and rewriting those is `rewrite_task`'s job. So is an
   * ANSWERED item: the answer was given to the words on it, and rewriting
   * them under it would leave a decision on record about text nobody can see
   * — and `reviewItemState` reads `answer` first, so the mismatch would never
   * surface as a re-queue either. File a fresh item instead.
   */
  reviseReviewItem(
    taskId: string,
    reviewItemId: string,
    patch: { headline?: unknown; detail?: unknown; options?: unknown },
    opts: {
      actor: { id: string; name: string; kind?: string };
      revisedRange?: { start: number; end: number };
    },
  ): ReviseReviewItemResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (reviewItemId === LEGACY_REVIEW_ITEM_ID) return { ok: false, error: 'not-revisable' };
    const item = task.reviews?.find((r) => r.id === reviewItemId);
    if (!item) return { ok: false, error: 'unknown-review-item' };
    if (item.answer) {
      return {
        ok: false,
        error: 'answered',
        message: `review item ${reviewItemId} is already answered — the answer is to the words it has; add a new item instead of rewriting these`,
      };
    }

    const touches = (['headline', 'detail', 'options'] as const).filter(
      (k) => patch[k] !== undefined,
    );
    if (touches.length === 0) return { ok: false, error: 'empty-patch' };

    // Merge onto the stored payload, then run the one gate. `answeredWith` /
    // `answeredAt` are not on an open item, and a closed item is not revised
    // here — its answer would be an answer to words nobody can see anymore.
    const merged: Record<string, unknown> = { ...item.review };
    for (const k of touches) merged[k] = patch[k];
    const check = checkReviewPayload(merged);
    if (!check.ok) {
      return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };
    }
    const next = readReviewPayload(merged);
    if (!next) return { ok: false, error: 'bad-review', message: reviewPayloadMessage(check) };

    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // An explicit range is offsets into the NEW detail; one that runs past it
    // would be served to the queue as-is and highlight to the end of whatever
    // text is there. The derived range is bounded by construction.
    const detailLength = (next.detail ?? '').length;
    if (opts.revisedRange && opts.revisedRange.end > detailLength) {
      return {
        ok: false,
        error: 'bad-range',
        message: `revisedRange ${opts.revisedRange.start}–${opts.revisedRange.end} runs past the new detail (${detailLength} characters)`,
      };
    }
    const question = latestThreadedQuestion(item);
    const range =
      opts.revisedRange ??
      (next.detail !== item.review.detail
        ? changedRange(item.review.detail ?? '', next.detail ?? '')
        : undefined);
    const previous: ReviewItemRevision = {
      at: ts,
      by: actor.name,
      headline: item.review.headline,
      ...(item.review.detail !== undefined ? { detail: item.review.detail } : {}),
      ...(item.review.options !== undefined ? { options: item.review.options } : {}),
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
      ...(range !== undefined ? { revisedRange: range } : {}),
    };
    item.revisions = [...(item.revisions ?? []), previous];
    item.review = next;
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'review_item.revised',
      workspaceId: task.workspaceId,
      taskId: task.id,
      reviewItemId,
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
      actor,
      links: task.links,
      ts,
    });
    const advice = reviewGapAdvice(check.gaps);
    return {
      ok: true,
      task,
      item,
      ...(question?.threadId !== undefined ? { threadId: question.threadId } : {}),
      ...(advice !== undefined ? { advice } : {}),
    };
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
    task.title = title;
    task.titleWrittenAt = Date.now();
    task.titleHead = bodyHead(task.body);
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
   * Place a task under a goal (or subgoal) at an exact position — the write
   * half of triage (§3.4: the agent picks the exact spot, not just the
   * bucket) and the board's regroup/rerank gesture (§3.3: open to everyone,
   * Bryan AND agents; every move recorded).
   *
   * Placement IS triage, so every call — moved or confirmed in place —
   * stamps `triagedAgainst` with the band it was judged against and clears
   * the triage-pending marker. A goal or position change emits
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
      /** The `workspace.goals_changed` batch this placement fulfils, echoed from
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
    task.triagedAgainst = { goalId: goal, ts };
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
    // A goal the caller just ADDED is a proposal: it mints in triage, and
    // its band dispatches nothing until somebody agrees to it.
    this.syncGoalRows(state, 'triage');

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
    };
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
    // A rename never adds an id, so nothing mints here — see `syncGoalRows`.
    this.syncGoalRows(state, 'todo');
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
   * one — so id generation and the `workspace.goals_changed` emit are both
   * inherited rather than re-implemented.
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
    // A reorder never adds an id, so nothing mints here — see `syncGoalRows`.
    this.syncGoalRows(state, 'todo');
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
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    // Same rule as the seat: a category cannot attach, because an attachment
    // is what makes an id an addressee (and would claim an empty seat).
    if (isCategoryAuthor({ id: opts.agentId })) {
      return { ok: false, error: 'author-required', message: AUTHOR_REQUIRED_MESSAGE };
    }
    const survivor = this.roster?.mergedAwayInto(opts.agentId) ?? null;
    if (survivor !== null) {
      return {
        ok: false,
        error: 'merged-away',
        into: survivor,
        message:
          `${opts.agentId} was merged into ${survivor}. Relaunch with CW_AGENT_NAME set to ` +
          `that agent's name (or merge back first); attaching under the old id would ` +
          'recreate the duplicate the merge removed.',
      };
    }
    const now = Date.now();
    // Is this attach a NEW process, or the same live one re-attaching (a
    // lead declaration, a retry after `subscribed: false`, a defensive
    // re-call)? The distinction decides whether the drains below may bypass
    // the ack grace window. A caller that sends no nonce — an older bundle —
    // is treated as fresh, which is exactly the behavior it was built
    // against; a same-nonce re-attach must NOT re-hand rows whose frames are
    // still in flight to this very process, or the agent reads the same
    // comment twice (once off the wire, once off this response).
    const priorProcessId = state.attachments.get(opts.agentId)?.processId;
    const freshProcess = opts.processId === undefined || opts.processId !== priorProcessId;
    const attachment: AgentAttachment = {
      workspaceId,
      agentId: opts.agentId,
      runtime: opts.runtime,
      ...(opts.endpoint !== undefined ? { endpoint: opts.endpoint } : {}),
      ...(opts.pluginVersion !== undefined ? { pluginVersion: opts.pluginVersion } : {}),
      ...(opts.processId !== undefined ? { processId: opts.processId } : {}),
      lastHeartbeat: now,
      lastToolCallAt: now,
      capabilities: opts.capabilities ?? [],
    };
    state.attachments.set(opts.agentId, attachment);
    this.scheduleAttachmentsSave(workspaceId);
    // The attach is where an agent first says who it is, so the roster row
    // is written here — one address book, not a per-board one.
    this.roster?.upsertAgent(opts.agentId, opts.agentName);
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
        {
          id: opts.agentId,
          name: this.roster?.displayNameFor(opts.agentId) ?? opts.agentName ?? opts.agentId,
          kind: 'agent',
        },
        now,
      );
    }
    const lead = state.workspace.leadAgentId === opts.agentId;
    // Only the lead drains the voice queue. A bystander attaching leaves the notes where they are for
    // the lead's next attach — otherwise they are "delivered" into a payload
    // that has no contract to act on them.
    const queuedVoice = lead ? this.drainVoiceQueue(workspaceId, { freshProcess }) : undefined;
    // Computed after the seat claim above: an agent that just took an empty
    // seat holds it now, and the conflict is exactly as real for it.
    const leadNameConflicts = lead
      ? this.leadNameConflictsFor(workspaceId, opts.agentId)
      : undefined;
    // Emitted LAST, after every state change above: the projection refreshes
    // off this event, so an earlier emit would repaint the board with a
    // queued note this very call just drained.
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
      // Addressed, unlike queuedVoice: only rows FOR this agent, and they
      // stay queued until its receipt — see takeDeliverableComments.
      queuedComments: this.takeDeliverableComments(workspaceId, opts.agentId, {
        freshProcess,
      }),
      lead,
      ...(isRetired(state.workspace) ? { retired: retiredNotice(state.workspace) } : {}),
      ...(leadNameConflicts ? { leadNameConflicts } : {}),
    };
  }

  /**
   * Other LIVE boards this agent leads under the same name as this one.
   *
   * The 2026-08-19 incident is detectable here and was reported nowhere: two
   * boards named the same, led by the same agent, with different goal lists.
   * The session read whichever it asked for and lost a night.
   *
   * Lead-gated on purpose. A bystander attaching to one of a pair is not the
   * one who will pick wrong — the lead is, because the lead is the addressee
   * for everything that says what to work on next. And computed over live
   * boards only, so retiring one of the pair clears the warning: the fix has
   * to visibly fix it, or the operator does the right thing and is told
   * nothing changed.
   */
  private leadNameConflictsFor(
    workspaceId: string,
    agentId: string,
  ): LeadNameConflicts | undefined {
    const ws = this.workspaces.get(workspaceId)?.workspace;
    if (!ws || ws.leadAgentId !== agentId || isRetired(ws)) return undefined;
    const key = normalizeWorkspaceName(ws.name);
    const boards: SameNamedWorkspace[] = [];
    for (const state of this.workspaces.values()) {
      const other = state.workspace;
      if (other.id === workspaceId || isRetired(other)) continue;
      if (other.leadAgentId !== agentId) continue;
      if (normalizeWorkspaceName(other.name) !== key) continue;
      boards.push({ workspaceId: other.id, name: other.name });
    }
    if (boards.length === 0) return undefined;
    const ids = boards.map((b) => b.workspaceId).join(', ');
    return {
      boards,
      notice:
        `You lead ${boards.length + 1} live boards named "${ws.name}". You are attached to ` +
        `${workspaceId}; the other${boards.length === 1 ? '' : 's'}: ${ids}. Two boards with ` +
        'one name is how a session works the stale one for a night — read the goal lists, ' +
        'then rename or retire whichever is not the live board.',
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

  // ── Comment queue ────────────────────────────────────────────────────────
  // The voice queue's shape (the queue is the record; live delivery is the
  // fast path; the row clears on a receipt) with two deliberate differences:
  // rows are ADDRESSED to one agent and drain only for it, and a drain never
  // removes anything — only `ackComment` does, so a handover the session
  // never read comes back after the grace window instead of dying with the
  // response body that carried it.

  /**
   * Queue one comment for one agent. SYNCHRONOUS write, like
   * `queueVoiceRequest` and for the same reason: "queued" is a promise, and
   * a promise living in a debounce dies with the process.
   */
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
    if (!this.workspaces.has(workspaceId)) return false;
    const id = cryptoId('cq');
    const queued: QueuedComment = {
      id,
      agentId: item.agentId,
      docId: item.docId,
      ...(item.threadId !== undefined ? { threadId: item.threadId } : {}),
      event: item.event,
      author: { id: item.author.id, name: item.author.name },
      text: item.text,
      ...(item.payload !== undefined ? { payload: item.payload } : {}),
      ts: Date.now(),
    };
    try {
      const dir = join(this.dataDir, 'workspaces');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      // Oldest dropped past the cap — PER ADDRESSEE, not across the file.
      // This file is delivery bookkeeping and the comment itself lives in
      // its thread, so an addressee that never acks (an old bundle, an
      // orphaned durable watch) must not grow it forever. But the cap it
      // hits must be its own: a shared cap would let one dead addressee's
      // backlog silently evict a LIVE agent's still-pending row, with no
      // signal anywhere that it happened.
      const existing = this.listQueuedComments(workspaceId);
      const mine = existing.filter((q) => q.agentId === item.agentId);
      const overflow = mine.length + 1 - MAX_QUEUED_COMMENTS;
      let next = [...existing, queued];
      if (overflow > 0) {
        const drop = new Set(mine.slice(0, overflow).map((q) => q.id));
        next = next.filter((q) => !drop.has(q.id));
      }
      writeFileSync(
        commentQueuePath(this.dataDir, workspaceId),
        `${JSON.stringify({ queue: next }, null, 2)}\n`,
      );
      return id;
    } catch (err) {
      console.error(`[tasks] failed to queue comment for ${workspaceId}:`, err);
      return false;
    }
  }

  /** Read the whole queue without touching it (badges, tests, coverage). */
  listQueuedComments(workspaceId: string): QueuedComment[] {
    const path = commentQueuePath(this.dataDir, workspaceId);
    if (!existsSync(path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { queue?: QueuedComment[] };
      return (parsed.queue ?? []).filter(
        (q) => typeof q?.id === 'string' && typeof q?.agentId === 'string',
      );
    } catch (err) {
      console.error(`[tasks] unreadable comment queue for ${workspaceId} — skipped:`, err);
      return [];
    }
  }

  /** Replace the queue file, removing it when nothing is left — same
   *  synchronous write as `queueComment`, and for the same reason. */
  private writeCommentQueue(workspaceId: string, queue: QueuedComment[]): void {
    const path = commentQueuePath(this.dataDir, workspaceId);
    try {
      if (queue.length === 0) {
        rmSync(path, { force: true });
        return;
      }
      writeFileSync(path, `${JSON.stringify({ queue }, null, 2)}\n`);
    } catch (err) {
      console.error(`[tasks] failed to rewrite comment queue for ${workspaceId}:`, err);
    }
  }

  /** Record that this row went out on the wire. Not the same as delivered —
   *  the row stays on the books until the ack. */
  markCommentEmitted(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedComments(workspaceId);
    const entry = queue.find((q) => q.id === id);
    if (!entry) return false;
    entry.emittedAt = Date.now();
    this.writeCommentQueue(workspaceId, queue);
    return true;
  }

  /**
   * Roll back an emitted mark for a row whose send reached NO socket. The
   * heartbeat route marks a row emitted when it hands it over, then attempts
   * the addressed frame — but `sse.sendToAgent` returning 0 is a real answer
   * ("the agent holds no stream"), and a row left marked against a send that
   * never happened waits out a full grace window before anything re-offers
   * it. Worse, if the agent's stream stays down while its heartbeats keep
   * landing, the cycle repeats forever: mark → silent 0-sink send → grace →
   * mark again. Clearing the mark makes the very next heartbeat a fresh
   * delivery attempt instead. No-op (false) for unknown or un-emitted rows.
   */
  clearCommentEmitted(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedComments(workspaceId);
    const entry = queue.find((q) => q.id === id);
    if (!entry || entry.emittedAt === undefined) return false;
    // JSON.stringify drops an undefined property, so the persisted row
    // comes back with no emittedAt at all — indistinguishable from never
    // having been sent, which is the point.
    entry.emittedAt = undefined;
    this.writeCommentQueue(workspaceId, queue);
    return true;
  }

  /**
   * The receiving process confirms it has the comment — the ONLY thing that
   * removes a row. False for an unknown id, so a stale or replayed receipt
   * is never licence to clear anything else.
   */
  ackComment(workspaceId: string, id: string): boolean {
    const queue = this.listQueuedComments(workspaceId);
    const next = queue.filter((q) => q.id !== id);
    if (next.length === queue.length) return false;
    this.writeCommentQueue(workspaceId, next);
    return true;
  }

  /**
   * Hand over what THIS agent should hear now, marking each row emitted but
   * removing nothing. `freshProcess` is the attach case, exactly as for
   * voice: whatever was in flight went to a process that is gone, so the
   * grace window protects nobody there.
   */
  private takeDeliverableComments(
    workspaceId: string,
    agentId: string,
    opts?: { freshProcess?: boolean },
  ): QueuedComment[] {
    const queue = this.listQueuedComments(workspaceId);
    if (queue.length === 0) return [];
    const now = Date.now();
    const inFlight = (q: QueuedComment): boolean =>
      !opts?.freshProcess &&
      q.emittedAt !== undefined &&
      now - q.emittedAt < this.commentAckGraceMs;
    const handOver = queue.filter((q) => q.agentId === agentId && !inFlight(q));
    if (handOver.length === 0) return [];
    for (const q of handOver) q.emittedAt = now;
    this.writeCommentQueue(workspaceId, queue);
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
    // The comment queue rides the same observation, addressed to exactly this
    // agent. Handed over (and marked emitted) but never removed here — the
    // caller re-sends each row as an addressed frame carrying its id, and the
    // row clears on the receiving process's ack.
    const queuedComments = this.takeDeliverableComments(workspaceId, agentId);
    return {
      ok: true,
      attachment,
      ...(queuedVoice.length > 0 ? { queuedVoice } : {}),
      ...(queuedComments.length > 0 ? { queuedComments } : {}),
    };
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
          tasks.set(task.id, task);
          this.taskIndex.set(task.id, workspace.id);
        }
        const goalRows = new Map<string, GoalRow>();
        for (const row of parsed.goalRows ?? []) {
          if (typeof row?.id !== 'string') continue;
          goalRows.set(row.id, row);
          this.goalIndex.set(row.id, workspace.id);
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
