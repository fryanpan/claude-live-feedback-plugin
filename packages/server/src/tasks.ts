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
import { classifyActor } from './activity.ts';

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
  | { kind: 'diff'; workspaceId: string };

/** Structural validity of a caller-supplied Ref: known kind, every field a
 *  non-empty string. Existence of the target is deliberately NOT checked
 *  (same stance as createTask's `links`): a dangling annotation is visible
 *  and harmless, where a dangling `after` edge would silently never block. */
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
  /** Ordered by priority — board sections ARE the goals. `chores` is a
   *  reserved out-of-band id, never present here (§3.2 edit contract). */
  goals: WorkspaceGoal[];
  /** Docs/reviews linked via attachDoc. Links, not membership — the docs'
   *  own metadata is untouched. */
  docIds: string[];
  createdAt: number;
}

export type TaskStatus = 'todo' | 'in-progress' | 'done';

const TASK_STATUSES: ReadonlySet<string> = new Set(['todo', 'in-progress', 'done']);

/** Reserved catch-all section id for no-goal work. Never in `goals[]`. */
export const CHORES_GOAL_ID = 'chores';

export interface TaskActor {
  id: string;
  name: string;
  kind: 'person' | 'agent';
}

export interface TaskEvidence {
  commit?: string;
  threadRef?: Ref;
}

export interface TaskTransition {
  ts: number;
  from: TaskStatus;
  to: TaskStatus;
  by: TaskActor;
  note?: string;
  evidence?: TaskEvidence;
  /** Agent-reported cost at done. */
  usage?: { inputTokens: number; outputTokens: number };
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
  /** 'human' | 'agent' | any named identity. Agent-decided by default. */
  assignee: string;
  /** Only meaningful when the assignee is a human. */
  needs?: 'action' | 'decision';
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
  /** Decisions keep the verbatim answer. */
  answer?: { text: string; by: string; ts: number };
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
  /** Stamped by triage at placement time; keyed to the ACTION's damage. */
  riskTier?: 'green' | 'yellow' | 'red';
  /** Append-only audit trail. */
  transitions: TaskTransition[];
  createdAt: number;
  updatedAt: number;
}

export interface CreateTaskOpts {
  title: string;
  body?: string;
  assignee?: string;
  needs?: 'action' | 'decision';
  goal?: string;
  order?: number;
  after?: string[];
  afterEnforce?: string[];
  dueAt?: number;
  links?: Ref[];
  origin?: Ref;
  quote?: string;
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
    };

export type CreateTaskResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'workspace-not-found' | 'unknown-goal' | 'unknown-after' };

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
 * doesn't emit an event. Two §3.6 rows have no store mutation yet and are
 * deliberately absent from this union until their mutation lands:
 * `task.assigned` (no assignment mutation until the MCP-tools commit) and
 * `workspace.retriaged` (emitted when the attached agent's re-triage
 * placements land, which needs set_task_goal).
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
  /** A forward move with no evidence attached — allowed, flagged (§7.1). */
  unproven: boolean;
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
  /** Set when this move is one member of a batched goal-list edit — it
   *  references the parent workspace.goals_changed event's batchId. */
  partOf?: string;
  ts: number;
}

export interface DecisionAnsweredEvent {
  type: 'decision.answered';
  workspaceId: string;
  taskId: string;
  /** The VERBATIM answer text (§3.6). */
  answer: string;
  actor: TaskActor;
  /** The decision task's links — a ready-made propagation checklist. */
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

export type TaskStoreEvent =
  | TaskCreatedEvent
  | TaskTransitionedEvent
  | TaskRegroupedEvent
  | DecisionAnsweredEvent
  | WorkspaceGoalUpdatedEvent
  | WorkspaceGoalsChangedEvent
  | AgentAttachedEvent
  | AgentDetachedEvent
  | AgentHeartbeatEvent;

export type SetWorkspaceGoalResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the new text equals the old — a no-op edit emits no
       *  event and requests no re-triage (it would churn timestamps for a
       *  change nobody made). */
      changed: boolean;
      /** `taskIds` = the open tasks a re-triage covers; `requested` = whether
       *  the request actually reached a live attachment. With none attached
       *  the re-triage honestly does not happen — placements stay as they
       *  were (§3.4). */
      retriage: { requested: boolean; taskIds: string[] };
    }
  | { ok: false; error: 'workspace-not-found' };

export type AnswerDecisionResult =
  | { ok: true; task: Task }
  | { ok: false; error: 'not-found' | 'not-a-decision' };

export type SetGoalListResult =
  | {
      ok: true;
      workspace: HubWorkspace;
      /** False when the new list deep-equals the old — no event, no moves. */
      changed: boolean;
      /** Open tasks whose goal or subgoal id disappeared, moved to Chores —
       *  reported so the caller can re-place them (§3.2 edit contract). */
      movedToChores: string[];
    }
  | { ok: false; error: 'workspace-not-found' | 'reserved-goal-id' | 'duplicate-goal-id' };

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

  createWorkspace(name: string, goal?: string): HubWorkspace {
    const now = Date.now();
    const workspace: HubWorkspace = {
      id: cryptoId('w'),
      name,
      goal: goal ?? '',
      goalUpdatedAt: now,
      goals: [],
      docIds: [],
      createdAt: now,
    };
    this.workspaces.set(workspace.id, { workspace, tasks: new Map(), attachments: new Map() });
    this.scheduleSave(workspace.id);
    return workspace;
  }

  getWorkspace(id: string): HubWorkspace | undefined {
    return this.workspaces.get(id)?.workspace;
  }

  listWorkspaces(): HubWorkspace[] {
    return Array.from(this.workspaces.values()).map((s) => s.workspace);
  }

  /**
   * Edit the workspace's north-star goal (§3.4: the input to every intake
   * decision). Emits `workspace.goal_updated` (old goal, new goal, actor)
   * and requests a re-triage of the OPEN tasks — done stays put. The
   * re-triage EXECUTES in the attached agent; this method only emits the
   * request, and with no live attachment it honestly does not happen.
   */
  setWorkspaceGoal(
    workspaceId: string,
    goal: string,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): SetWorkspaceGoalResult {
    const state = this.workspaces.get(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    const workspace = state.workspace;

    if (goal === workspace.goal) {
      // Nothing changed, so nothing to announce and nothing to re-triage —
      // every placement's triagedAgainst is still accurate.
      return { ok: true, workspace, changed: false, retriage: { requested: false, taskIds: [] } };
    }

    const ts = Date.now();
    const oldGoal = workspace.goal;
    workspace.goal = goal;
    workspace.goalUpdatedAt = ts;
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
    const requested =
      taskIds.length > 0 &&
      this.requestTriage({
        kind: 'goal-retriage',
        workspaceId,
        oldGoal,
        newGoal: goal,
        taskIds,
        actor,
        ts,
      });
    return { ok: true, workspace, changed: true, retriage: { requested, taskIds } };
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

    const now = Date.now();
    const inGoal = Array.from(state.tasks.values()).filter((t) => t.goal === goal);
    const order = opts.order ?? Math.max(0, ...inGoal.map((t) => t.order)) + 1;
    const task: Task = {
      id: cryptoId('t'),
      workspaceId,
      title: opts.title,
      ...(opts.body !== undefined ? { body: opts.body } : {}),
      assignee: opts.assignee ?? 'agent',
      ...(opts.needs !== undefined ? { needs: opts.needs } : {}),
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
    if (opts.goal === undefined) {
      const delivered = this.requestTriage({
        kind: 'task',
        workspaceId,
        taskId: task.id,
        goal: state.workspace.goal,
        ts: now,
      });
      if (delivered) task.triagePendingTs = Date.now();
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
      ts: now,
    });
    return { ok: true, task };
  }

  /**
   * Open Chores tasks no triage has placed (`triagedAgainst` unset) — what
   * an agent sweeps when it attaches to a workspace that had no attachment
   * when the tasks arrived (§3.4).
   */
  listUntriaged(workspaceId: string): Task[] {
    return this.listTasks(workspaceId, { goal: CHORES_GOAL_ID }).filter(
      (t) => t.status !== 'done' && t.triagedAgainst === undefined,
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
   */
  transition(
    taskId: string,
    to: TaskStatus,
    opts: {
      actor: { id: string; name: string; kind?: string };
      note?: string;
      evidence?: TaskEvidence;
      usage?: { inputTokens: number; outputTokens: number };
    },
  ): TransitionResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (!TASK_STATUSES.has(to)) return { ok: false, error: 'bad-status' };
    if (task.status === to) return { ok: false, error: 'same-status' };

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

    const unproven = forward && opts.evidence === undefined;
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
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AnswerDecisionResult {
    const task = this.getTask(taskId);
    if (!task) return { ok: false, error: 'not-found' };
    if (task.needs !== 'decision') return { ok: false, error: 'not-a-decision' };
    const ts = Date.now();
    const actor: TaskActor = {
      id: opts.actor.id,
      name: opts.actor.name,
      kind: classifyActor(opts.actor),
    };
    // `by` is the display name — the projection ships display names, not ids
    // (§3.3 visitor contract), and the event carries the full actor anyway.
    task.answer = { text, by: actor.name, ts };
    task.updatedAt = ts;
    this.scheduleSave(task.workspaceId);
    this.emit({
      type: 'decision.answered',
      workspaceId: task.workspaceId,
      taskId: task.id,
      answer: text,
      actor,
      links: task.links,
      ts,
    });
    return { ok: true, task };
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
   */
  setGoalList(
    workspaceId: string,
    goals: WorkspaceGoal[],
    opts: { actor: { id: string; name: string; kind?: string } },
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
      return { ok: true, workspace, changed: false, movedToChores: [] };
    }

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
    let choresMax = Math.max(
      0,
      ...Array.from(state.tasks.values())
        .filter((t) => t.goal === CHORES_GOAL_ID)
        .map((t) => t.order),
    );
    for (const task of state.tasks.values()) {
      if (task.status === 'done' || newIds.has(task.goal)) continue;
      moved.push({ task, fromGoal: task.goal });
      choresMax += 1;
      task.goal = CHORES_GOAL_ID;
      task.order = choresMax;
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
    return { ok: true, workspace, changed: true, movedToChores: moved.map((m) => m.task.id) };
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

  /** Tasks whose `links` or `origin` contain a ref matching `pred`. */
  private tasksMatching(pred: (ref: Ref) => boolean): Task[] {
    const out: Task[] = [];
    for (const state of this.workspaces.values()) {
      for (const task of state.tasks.values()) {
        if (task.links.some(pred) || (task.origin !== undefined && pred(task.origin))) {
          out.push(task);
        }
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
      lastHeartbeat: now,
      lastToolCallAt: now,
      capabilities: opts.capabilities ?? [],
    };
    state.attachments.set(opts.agentId, attachment);
    this.scheduleAttachmentsSave(workspaceId);
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
    };
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
          tasks.set(task.id, task);
          this.taskIndex.set(task.id, workspace.id);
        }
        this.workspaces.set(workspace.id, {
          workspace,
          tasks,
          attachments: this.loadAttachments(workspace.id),
        });
      } catch (err) {
        // A corrupt sidecar loses that one workspace, never the server.
        console.error(`[tasks] unreadable sidecar ${entry} — skipped:`, err);
      }
    }
  }
}
