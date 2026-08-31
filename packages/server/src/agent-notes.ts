/**
 * Agent notes — the one-liners the plugin's Stop and PermissionDenied hooks
 * post so a per-agent activity pane can say what each agent did lately.
 *
 * Three pieces, all small:
 *  - `parseAgentNote`: the wire shape `POST /api/agent-notes` accepts, and
 *    the 400s it refuses. The server stores the text VERBATIM — reducing a
 *    closing message to one safe line is the hook's job, and a server that
 *    quietly filtered would hide from the hook's author that it had to.
 *  - `resolveNoteTarget`: which row an agent is working RIGHT NOW. There is
 *    no register of that: the dispatch registry keys on task, heartbeats key
 *    on agent, and neither names the other. The answer the board already
 *    gives (`claimSessionReader`) is the row's latest `in-progress` claim,
 *    so this reads the same evidence — an in-progress row the agent owns or
 *    last claimed — across every workspace. It answers with a row only when
 *    the agent holds exactly ONE: a 2-week replay of prod notes (2026-08-31)
 *    found 93% of automatic notes faced 2+ held rows, and a judged sample
 *    put the old newest-claim guess wrong ~3 times in 4 — a lead session
 *    claims rows for the builders it dispatches, so its end-of-turn digest
 *    was landing on whichever row happened to be claimed last. Ambiguity now
 *    goes to the ring marked `needsFiling` instead of onto a coin-flip row.
 *  - `AgentNoteRing`: the per-agent memory, in-process and bounded. A note
 *    with no current task has nowhere durable to go, but the pane still
 *    wants to show it; a bound note is recorded here too, tagged with its
 *    task, so the pane has ONE read per agent instead of a join. Lost on
 *    restart by design — the task-bound copy is the record.
 */
import { agentIdForName } from '@feedback/core';
import { isSharedAgentName, normalizeAgent } from './chat-audit.ts';
import type { Task, TaskNote, TaskStore } from './tasks.ts';

/** How many notes one agent's ring remembers. */
export const AGENT_NOTE_RING_CAP = 20;
/** How many agents the ring map holds before the least recently written
 *  one is evicted. Every POST is a 202 whether or not the name is known, so
 *  without this the map grows one ring per invented name until restart. */
export const AGENT_NOTE_AGENTS_CAP = 200;
/** The window a hook's own `at` is trusted inside; outside it the server
 *  clock stands in. A pane sorts by `at`, and one bogus clock — an epoch
 *  zero, a year ahead — would pin a note to the top or bury it forever. */
export const AT_PAST_MS = 24 * 60 * 60_000;
export const AT_FUTURE_MS = 5 * 60_000;
/** How many of a row's notes the board projection carries (newest first). */
export const TASK_NOTES_READ_CAP = 50;
export { TASK_NOTES_STORE_CAP } from './tasks.ts';

/** The ceiling on what one note makes the sidecar hold. A turn note is the
 *  FULL end-of-turn message (the hook reduces locators, not length, and cuts
 *  at this many chars with an ellipsis), so the ceiling is sized for a real
 *  report rather than a one-liner; a caller past it is refused, not clipped. */
export const NOTE_TEXT_MAX = 4000;
const AGENT_NAME_MAX = 200;
const SESSION_ID_MAX = 200;
const TASK_ID_MAX = 200;

export type AgentNoteKind = TaskNote['kind'];
const KINDS: ReadonlySet<string> = new Set<AgentNoteKind>(['turn', 'denial', 'status']);

/** A validated note body — `POST /api/agent-notes` and `POST /api/tasks/:id/notes`
 *  share it, so an explicit-task status is held to the same rules as a hook's
 *  note (a shared agent name is refused either way). `cwd` is accepted off the wire
 *  and deliberately not here: a host filesystem path is not workspace
 *  content, and nothing downstream stores it. */
export interface AgentNoteInput {
  agent: string;
  kind: AgentNoteKind;
  text: string;
  /** The hook's clock when it is within `AT_PAST_MS` / `AT_FUTURE_MS` of
   *  the server's; the server's otherwise, and when absent. */
  at: number;
  sessionId?: string;
  /** An explicit address from a caller that knows its row. The hook route
   *  appends there directly instead of resolving a current claim; the named
   *  route (`/api/tasks/:id/notes`) takes the row from its URL and ignores
   *  this field. */
  taskId?: string;
}

export type ParseAgentNoteResult =
  | { ok: true; note: AgentNoteInput }
  | { ok: false; error: string; message: string };

export function parseAgentNote(body: unknown, now: number = Date.now()): ParseAgentNoteResult {
  if (body === null || typeof body !== 'object') {
    return { ok: false, error: 'bad-body', message: 'expected a JSON object' };
  }
  const b = body as Record<string, unknown>;
  const agent = typeof b.agent === 'string' ? b.agent.trim() : '';
  if (agent.length === 0 || agent.length > AGENT_NAME_MAX) {
    return { ok: false, error: 'bad-agent', message: '`agent` must be a non-empty name' };
  }
  if (isSharedAgentName(agent)) {
    return {
      ok: false,
      error: 'shared-identity',
      message: `"${agent}" names a category, not a session — set CW_AGENT_NAME so notes file under a name`,
    };
  }
  if (typeof b.kind !== 'string' || !KINDS.has(b.kind)) {
    return {
      ok: false,
      error: 'bad-kind',
      message: '`kind` must be "turn", "denial", or "status"',
    };
  }
  if (typeof b.text !== 'string' || b.text.trim().length === 0) {
    return { ok: false, error: 'bad-text', message: '`text` must be a non-empty string' };
  }
  if (b.text.length > NOTE_TEXT_MAX) {
    return { ok: false, error: 'bad-text', message: `\`text\` is over ${NOTE_TEXT_MAX} chars` };
  }
  let at = now;
  if (b.at !== undefined && b.at !== null) {
    if (typeof b.at !== 'number' || !Number.isFinite(b.at)) {
      return { ok: false, error: 'bad-at', message: '`at` must be a millisecond timestamp' };
    }
    if (b.at >= now - AT_PAST_MS && b.at <= now + AT_FUTURE_MS) at = b.at;
  }
  let sessionId: string | undefined;
  if (b.sessionId !== undefined && b.sessionId !== null) {
    if (typeof b.sessionId !== 'string' || b.sessionId.length > SESSION_ID_MAX) {
      return { ok: false, error: 'bad-session', message: '`sessionId` must be a short string' };
    }
    sessionId = b.sessionId;
  }
  let taskId: string | undefined;
  if (b.taskId !== undefined && b.taskId !== null) {
    if (
      typeof b.taskId !== 'string' ||
      b.taskId.trim().length === 0 ||
      b.taskId.length > TASK_ID_MAX
    ) {
      return { ok: false, error: 'bad-task', message: '`taskId` must be a task id' };
    }
    taskId = b.taskId;
  }
  return {
    ok: true,
    note: {
      agent,
      kind: b.kind as AgentNoteKind,
      text: b.text,
      at,
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
    },
  };
}

/** The latest `in-progress` claim on a row, or undefined when it has none. */
function latestClaim(task: Task): Task['transitions'][number] | undefined {
  let claim: Task['transitions'][number] | undefined;
  for (const t of task.transitions) if (t.to === 'in-progress') claim = t;
  return claim;
}

/** Where a note with no explicit address should land, if anywhere. */
export type NoteTarget = { task: Task; ambiguous: false } | { task: undefined; ambiguous: boolean };

/**
 * The row `agentName` is working now: the in-progress row, across every
 * workspace, that is the agent's — when it holds exactly one. An agent
 * holding several rows gets NO answer (`ambiguous: true`): the old rule
 * took the newest claim, and the 2026-08-31 replay showed that guess wrong
 * far more often than right (see the module header). A note that cannot be
 * placed is worth more unfiled than filed wrongly.
 *
 * Whose a row is: when its latest in-progress claim was made by an AGENT,
 * that claimant — the stored assignee is stale the moment another agent takes
 * the row over, and a note from the old owner must not land on the new
 * worker's row. When a person moved it (or nothing records who did), the
 * assignee, by any spelling the roster folds.
 */
export function resolveNoteTarget(store: TaskStore, agentName: string): NoteTarget {
  const owned = store.ownerMatcher(agentName);
  const wantedIds = new Set([agentIdForName(agentName), normalizeAgent(agentName)]);
  const claimedBy = (task: Task): boolean => {
    const claim = latestClaim(task);
    if (!claim) return false;
    return (
      wantedIds.has(claim.by.id) ||
      wantedIds.has(normalizeAgent(claim.by.id)) ||
      normalizeAgent(claim.by.name) === normalizeAgent(agentName)
    );
  };
  let only: Task | undefined;
  for (const ws of store.listWorkspaces()) {
    for (const task of store.listTasks(ws.id, { status: 'in-progress' })) {
      const claim = latestClaim(task);
      const mine = claim?.by.kind === 'agent' ? claimedBy(task) : owned(task);
      if (!mine) continue;
      if (only !== undefined) return { task: undefined, ambiguous: true };
      only = task;
    }
  }
  return only !== undefined
    ? { task: only, ambiguous: false }
    : { task: undefined, ambiguous: false };
}

/** One ring entry: the note as posted, plus the row it was pinned to. */
export interface AgentRingNote extends AgentNoteInput {
  taskId?: string;
  workspaceId?: string;
  /** The note faced 2+ candidate rows and was deliberately left unfiled —
   *  the pane shows it as needing a home rather than hiding the miss. */
  needsFiling?: boolean;
}

export class AgentNoteRing {
  /** Insertion order is recency of the last write: a record deletes and
   *  re-sets its key, so the first entry is always the eviction candidate. */
  private readonly rings = new Map<string, AgentRingNote[]>();

  record(note: AgentRingNote): void {
    const key = normalizeAgent(note.agent);
    const ring = this.rings.get(key) ?? [];
    ring.push(note);
    if (ring.length > AGENT_NOTE_RING_CAP) ring.splice(0, ring.length - AGENT_NOTE_RING_CAP);
    this.rings.delete(key);
    this.rings.set(key, ring);
    while (this.rings.size > AGENT_NOTE_AGENTS_CAP) {
      const oldest = this.rings.keys().next().value;
      if (oldest === undefined) break;
      this.rings.delete(oldest);
    }
  }

  /** How many agents currently hold a ring. */
  get size(): number {
    return this.rings.size;
  }

  /** Newest first. Unknown agent → empty, not an error. */
  list(agent: string): AgentRingNote[] {
    return [...(this.rings.get(normalizeAgent(agent)) ?? [])].reverse();
  }
}
