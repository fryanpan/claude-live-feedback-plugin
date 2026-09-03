/**
 * Agents on a board: who is attached, how recently the server saw them, and
 * the lead seat's health.
 *
 * Split out of `tasks.ts` — the second of the store's four responsibilities.
 * Nothing here reads or writes a task row: attachments live in their own
 * sidecar, and what this file needs from the store arrives through
 * `AgentStorePersistence` rather than a `this` that reaches all of it.
 *
 * The two delivery queues that hold work for an agent that is not live right
 * now — voice change-requests and comments — were split further, into
 * `agent-voice-queue.ts` and `agent-comment-queue.ts`: each was already a
 * banner in this file (`// ── Voice`, `// ── Comment queue`), one store each,
 * reachable only through this same `AgentStorePersistence` seam. `AgentStore`
 * composes one instance of each and its own methods delegate to them, so its
 * public API is unchanged.
 *
 * The attachment constants and the derived-state helpers live here rather
 * than in `tasks.ts` for the same reason `isRetired` lives in
 * `workspace-store.ts`: this file may not import a VALUE from the file that
 * imports it. `tasks.ts` imports them back and re-exports them, so no caller
 * outside either file changes.
 */

import { join } from 'node:path';
import type { Task, TaskActor } from '@feedback/core/task-wire';
import { classifyActor } from './actor-identity.ts';
import { AgentCommentQueue, type QueuedComment } from './agent-comment-queue.ts';
import { AgentVoiceQueue, type QueuedVoiceRequest } from './agent-voice-queue.ts';
import { AUTHOR_REQUIRED_MESSAGE, isCategoryAuthor } from './task-owner.ts';
import type {
  AgentAttachedEvent,
  AgentAttachment,
  AgentDetachedEvent,
  AgentHeartbeatEvent,
  AgentRoster,
  AttachmentRuntime,
  RetiredNotice,
  SameNamedWorkspace,
  VoiceRequestEvent,
  VoiceRoute,
  WorkspaceState,
} from './tasks.ts';
import { isRetired, normalizeWorkspaceName, retiredNotice } from './workspace-store.ts';

export {
  AgentCommentQueue,
  COMMENT_ACK_GRACE_MS,
  MAX_QUEUED_COMMENTS,
  type QueuedComment,
  commentQueuePath,
} from './agent-comment-queue.ts';
export {
  AgentVoiceQueue,
  VOICE_ACK_GRACE_MS,
  type QueuedVoiceRequest,
  voiceQueuePath,
} from './agent-voice-queue.ts';

/**
 * The four rows this file announces.
 *
 * Narrower than `TaskStoreEvent` on purpose — the same reasoning as
 * `ReviewItemStoreEvent`. Assignable INTO `TaskStoreEvent`, so the store
 * forwards it without a cast.
 */
export type AgentStoreEvent =
  | AgentAttachedEvent
  | AgentDetachedEvent
  | AgentHeartbeatEvent
  | VoiceRequestEvent;

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
 * How long a seat's holder must be BOTH off the wire and unobserved before
 * the board calls the seat stale.
 *
 * Deliberately three times `OBSERVED_LIVE_MS`, and the reason is the cost
 * asymmetry rather than a second measurement. Reading stale drives two
 * consequential acts — handing the seat to whoever attaches next, and telling
 * a person the board's owner is gone — where reading live merely defers both
 * to the next attach. So this window sits far enough past the delivery gate
 * that a lead cannot lose its seat to an ordinary quiet stretch.
 *
 * It is NOT elapsed silence on its own, and must never be used as such: a
 * measured 40% of provably-active minutes read as silent, and the incident
 * this exists for (2026-08-29/30, 4.5 hours) was a session that had exited,
 * not one that was quiet. The clock only gets a vote once the socket is
 * already gone — see `leadSeatHealth`.
 */
export const LEAD_SEAT_STALE_MS = 3 * OBSERVED_LIVE_MS;

/** "4h", "35m" — coarse on purpose. This lands in a sentence a person reads
 *  while deciding whether a board has an owner, and minutes of precision
 *  there would suggest the reading is finer than the window behind it. */
function describeGap(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export type AttachmentState = 'active' | 'unresponsive' | 'away';

export interface AttachmentThresholds {
  heartbeatFreshMs?: number;
  toolCallStaleMs?: number;
  observedWorkFreshMs?: number;
  /** How long a seat's holder must be off the wire AND unobserved before the
   *  seat reads stale. Its own knob rather than a multiple of the window
   *  above, because a test that wants a takeable seat must not have to make
   *  the delivery gate unrealistically tight to get one. */
  leadSeatStaleMs?: number;
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
 *  events carry and what a share visitor's REST read gets.
 *
 *  ALLOWLIST, NOT DENYLIST, and named field by field on purpose. This
 *  projection used to be `Omit<…, 'endpoint'>` over a spread, so a field
 *  added to `AgentAttachment` later shipped to share and collab visitors
 *  by default and stayed there until somebody noticed. `endpoint` is a
 *  host-machine fact and was the one that had to go; the next one nobody
 *  has written yet is the one this shape is for. Every neighbouring visitor
 *  projection — `redactMetaForVisitor`, `redactHubWorkspaceForVisitor` —
 *  was rewritten this way after a leak, and this was the last one that
 *  had not been. */
export type PublicAttachment = Pick<
  DescribedAttachment,
  | 'workspaceId'
  | 'agentId'
  | 'runtime'
  | 'lastHeartbeat'
  | 'lastToolCallAt'
  | 'capabilities'
  | 'pluginVersion'
  | 'processId'
  | 'state'
  | 'stateLabel'
>;

export function publicAttachment(
  att: AgentAttachment,
  now: number,
  thresholds?: AttachmentThresholds,
): PublicAttachment {
  const state = attachmentState(att, now, thresholds);
  return {
    workspaceId: att.workspaceId,
    agentId: att.agentId,
    runtime: att.runtime,
    lastHeartbeat: att.lastHeartbeat,
    lastToolCallAt: att.lastToolCallAt,
    capabilities: att.capabilities,
    // Absent stays absent rather than becoming an explicit null: silence on
    // `pluginVersion` is what a reader takes as "older than the release that
    // added it", and the wire shape is what says so.
    ...(att.pluginVersion !== undefined ? { pluginVersion: att.pluginVersion } : {}),
    ...(att.processId !== undefined ? { processId: att.processId } : {}),
    state,
    stateLabel: attachmentStateLabel(state),
  };
}

/** The one-line "a fresh context learns the gates exist" summary returned on
 *  attach (§3.3): open decision tasks that gate open tasks via `after`. */
export interface GatingSummary {
  openDecisions: number;
  gatedTasks: number;
  summary: string;
}

/**
 * The state of a board's lead seat, as something a surface can render and a
 * session can read about itself.
 *
 * Exists because "who leads this board" was answerable and "is that lead
 * still there" was not. A seat held by a session that exited renders
 * identically to a healthy one, so a rename could take the board's only
 * addressee offline and every surface kept reporting business as usual.
 */
export interface LeadSeatHealth {
  /** Who holds the seat. Absent means the seat is empty. */
  leadAgentId?: string;
  /** Is the holder reachable right now? Always false for an empty seat —
   *  there is nobody to reach. */
  live: boolean;
  /** The seat is HELD, and there is EVIDENCE its holder is not coming back:
   *  it attached once, and has since been off the wire past the window. This
   *  is the fault the board could not see — an empty seat is loud already and
   *  a live lead is fine; this is the third state that looked like the second.
   *
   *  Evidence is required because this drives a seat handover. A seat whose
   *  holder has never been observed is `unattached`, not stale — see below. */
  stale: boolean;
  /** The seat names an id this board has no attachment record for: a lead set
   *  when the workspace was created and not yet arrived, or one whose record
   *  was detached. Worth REPORTING — nothing is draining that queue — but
   *  never a reason to take the seat, because "has not arrived yet" and "is
   *  never coming" are the same absence, and guessing wrong hands one agent's
   *  seat to another before it has finished starting up. */
  unattached?: boolean;
  /** The newest moment the server observed the holder — a heartbeat it sent
   *  or a write it made. Absent when the seat is held by an id that never
   *  attached at all. */
  lastObservedAt?: number;
  /** How long the holder has been unobserved, for saying so in words. */
  staleForMs?: number;
  /** The sentence a person or a session reads. Present only when stale. */
  notice?: string;
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
      /** The lead seat as this attach left it. `lead` says whether the seat is
       *  MINE; this says whether it is anybody's — an occupied seat whose
       *  holder has gone is the state that used to be indistinguishable from a
       *  healthy one. */
      seat: LeadSeatHealth;
      /** This attach took the seat from a holder that was gone. Present only
       *  then, and never silent: the handover persists and announces like any
       *  other, so the board repaints and the audit log carries it. */
      seatTakenFrom?: string;
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
 * What an agent verb may reach in the store, and nothing else.
 *
 * Every row handed back is LIVE — mutated in place, then handed to
 * `saveAttachments`. The two probes are methods rather than optional fields
 * so the store's own defaults ("no stream probe means not streaming", "no
 * delivery probe means deliverable") are decided once, in the adapter, and
 * this file never restates them.
 */
export interface AgentStorePersistence {
  /** Read at call time: the store assigns it in its constructor, after the
   *  field initialiser that builds this seam has already run. */
  dataDir(): string;
  state(workspaceId: string): WorkspaceState | undefined;
  states(): Iterable<WorkspaceState>;
  hasWorkspace(workspaceId: string): boolean;
  readonly thresholds: AttachmentThresholds;
  readonly voiceAckGraceMs: number;
  readonly commentAckGraceMs: number;
  roster(): AgentRoster | undefined;
  agentStreamProbe(workspaceId: string, agentId: string): boolean;
  deliveryProbe(workspaceId: string): boolean;
  saveAttachments(workspaceId: string): void;
  listUntriaged(workspaceId: string): Task[];
  assignLead(state: WorkspaceState, leadAgentId: string, actor: TaskActor, ts: number): void;
  emit(event: AgentStoreEvent): void;
}

/** Attachments and delivery queues. One per `TaskStore`, holding no state of
 *  its own — the records live in the workspace rows and the sidecars. */
export class AgentStore {
  private readonly voice: AgentVoiceQueue;
  private readonly comments: AgentCommentQueue;

  constructor(private readonly p: AgentStorePersistence) {
    this.voice = new AgentVoiceQueue(p);
    this.comments = new AgentCommentQueue(p);
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
    for (const state of this.p.states()) {
      const workspaceId = state.workspace.id;
      const old = state.attachments.get(from);
      if (old) {
        attachments.push(workspaceId);
        if (!opts.dryRun) {
          const existing = state.attachments.get(into);
          const fresher = existing && existing.lastHeartbeat >= old.lastHeartbeat ? existing : old;
          state.attachments.delete(from);
          state.attachments.set(into, { ...fresher, agentId: into });
          this.p.saveAttachments(workspaceId);
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
          if (!opts.dryRun) this.p.assignLead(state, into, actor, Date.now());
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
        this.p.emit({
          type: 'agent.attached',
          workspaceId,
          agentId: into,
          attachment: publicAttachment(survivor, now, this.p.thresholds),
          ts: now,
        });
      }
    }
    return result();
  }

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
    const state = this.p.state(workspaceId);
    if (!state) return { ok: false, error: 'workspace-not-found' };
    // Same rule as the seat: a category cannot attach, because an attachment
    // is what makes an id an addressee (and would claim an empty seat).
    if (isCategoryAuthor({ id: opts.agentId })) {
      return { ok: false, error: 'author-required', message: AUTHOR_REQUIRED_MESSAGE };
    }
    const survivor = this.p.roster()?.mergedAwayInto(opts.agentId) ?? null;
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
    this.p.saveAttachments(workspaceId);
    // The attach is where an agent first says who it is, so the roster row
    // is written here — one address book, not a per-board one.
    this.p.roster()?.upsertAgent(opts.agentId, opts.agentName);
    // Claim an empty seat, or one whose holder is gone.
    //
    // The rule used to be EMPTY ONLY, and the reason it gave is still right:
    // an occupied seat is a standing decision, and a second agent attaching
    // is not a reassignment. What it could not see is that "occupied" and
    // "occupied by somebody who is coming back" are different states. A
    // session that respawned under a new name left the seat pointing at an id
    // that had exited, and this branch — correctly, by its own rule — refused
    // to touch it, so the board kept every lead-addressed delivery for a
    // holder that no longer existed.
    //
    // So the guard is narrowed by exactly one case, and no further: a seat is
    // takeable when its holder is STALE, which asks the socket before it asks
    // any clock (see `leadSeatHealth`). A lead that is merely quiet still owns
    // its seat. This is the carry-over the rename ticket asked us to pick one
    // of: refuse to leave the seat with a dead holder, rather than guess which
    // dead identity a new name used to be. Guessing is the option not taken —
    // nothing in an attach identifies a session's previous id, and a wrong
    // guess hands one agent's seat to another.
    const seatBefore = this.leadSeatHealth(workspaceId, now);
    const seatTakenFrom = seatBefore.stale ? seatBefore.leadAgentId : undefined;
    if (state.workspace.leadAgentId === undefined || seatBefore.stale) {
      // `now`, not a fresh read: the seat claim is part of THIS attach, and
      // the `workspace.lead_changed` it emits is observed as this agent's
      // work. Re-reading here would stamp the work clock a millisecond past
      // the `lastHeartbeat` set four lines up.
      this.p.assignLead(
        state,
        opts.agentId,
        {
          id: opts.agentId,
          name: this.p.roster()?.displayNameFor(opts.agentId) ?? opts.agentName ?? opts.agentId,
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
    this.p.emit({
      type: 'agent.attached',
      workspaceId,
      agentId: opts.agentId,
      attachment: publicAttachment(attachment, now, this.p.thresholds),
      ts: now,
    });
    return {
      ok: true,
      attachment,
      gating: this.gatingSummary(workspaceId),
      untriaged: this.p.listUntriaged(workspaceId).map((t) => t.id),
      ...(queuedVoice !== undefined ? { queuedVoice } : {}),
      // Addressed, unlike queuedVoice: only rows FOR this agent, and they
      // stay queued until its receipt — see takeDeliverableComments.
      queuedComments: this.takeDeliverableComments(workspaceId, opts.agentId, {
        freshProcess,
      }),
      lead,
      // The seat as this attach LEFT it, so a session that reads its own
      // response can tell which of the three states it is in without a second
      // call. `lead: false` used to be the only signal here, and it reads the
      // same whether a working peer holds the seat or a dead id does.
      seat: this.leadSeatHealth(workspaceId, now),
      ...(seatTakenFrom !== undefined ? { seatTakenFrom } : {}),
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
    const ws = this.p.state(workspaceId)?.workspace;
    if (!ws || ws.leadAgentId !== agentId || isRetired(ws)) return undefined;
    const key = normalizeWorkspaceName(ws.name);
    const boards: SameNamedWorkspace[] = [];
    for (const state of this.p.states()) {
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

  // ── Voice — delegates to AgentVoiceQueue (agent-voice-queue.ts) ───────────

  /** @see AgentVoiceQueue.recordVoiceRequest */
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
    return this.voice.recordVoiceRequest(workspaceId, req);
  }

  /** @see AgentVoiceQueue.queueVoiceRequest */
  queueVoiceRequest(
    workspaceId: string,
    item: {
      transcript: string;
      context?: unknown;
      actor: { id: string; name: string; kind?: string };
      applied?: string;
    },
  ): string | false {
    return this.voice.queueVoiceRequest(workspaceId, item);
  }

  /** @see AgentVoiceQueue.listQueuedVoice */
  listQueuedVoice(workspaceId: string): QueuedVoiceRequest[] {
    return this.voice.listQueuedVoice(workspaceId);
  }

  /** @see AgentVoiceQueue.markVoiceEmitted */
  markVoiceEmitted(workspaceId: string, id: string): boolean {
    return this.voice.markVoiceEmitted(workspaceId, id);
  }

  /** @see AgentVoiceQueue.ackVoiceRequest */
  ackVoiceRequest(workspaceId: string, id: string): boolean {
    return this.voice.ackVoiceRequest(workspaceId, id);
  }

  /** @see AgentVoiceQueue.drainVoiceQueue */
  private drainVoiceQueue(
    workspaceId: string,
    opts?: { freshProcess?: boolean },
  ): QueuedVoiceRequest[] {
    return this.voice.drainVoiceQueue(workspaceId, opts);
  }

  // ── Comment queue — delegates to AgentCommentQueue (agent-comment-queue.ts)

  /** @see AgentCommentQueue.queueComment */
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
    return this.comments.queueComment(workspaceId, item);
  }

  /** @see AgentCommentQueue.listQueuedComments */
  listQueuedComments(workspaceId: string): QueuedComment[] {
    return this.comments.listQueuedComments(workspaceId);
  }

  /** @see AgentCommentQueue.writeCommentQueue — used by `mergeAgent` to
   *  re-key a backlog to a surviving id; every other write to this queue
   *  stays inside `AgentCommentQueue` itself. */
  private writeCommentQueue(workspaceId: string, queue: QueuedComment[]): void {
    this.comments.writeCommentQueue(workspaceId, queue);
  }

  /** @see AgentCommentQueue.markCommentEmitted */
  markCommentEmitted(workspaceId: string, id: string): boolean {
    return this.comments.markCommentEmitted(workspaceId, id);
  }

  /** @see AgentCommentQueue.clearCommentEmitted */
  clearCommentEmitted(workspaceId: string, id: string): boolean {
    return this.comments.clearCommentEmitted(workspaceId, id);
  }

  /** @see AgentCommentQueue.ackComment */
  ackComment(workspaceId: string, id: string): boolean {
    return this.comments.ackComment(workspaceId, id);
  }

  /** @see AgentCommentQueue.takeDeliverableComments */
  private takeDeliverableComments(
    workspaceId: string,
    agentId: string,
    opts?: { freshProcess?: boolean },
  ): QueuedComment[] {
    return this.comments.takeDeliverableComments(workspaceId, agentId, opts);
  }

  /**
   * Record a heartbeat. A plain heartbeat proves only that the process is
   * alive; `toolCallAt` lets the runtime report when it last did WORK — the
   * two clocks are deliberately separate (§4: a session at its usage limit
   * heartbeats normally for hours). `toolCallAt` is monotonic and clamped to
   * now: it can neither backdate nor forward-date activity.
   */
  heartbeat(workspaceId: string, agentId: string, opts?: { toolCallAt?: number }): HeartbeatResult {
    const attachment = this.p.state(workspaceId)?.attachments.get(agentId);
    if (!attachment) return { ok: false, error: 'not-found' };
    const now = Date.now();
    attachment.lastHeartbeat = now;
    if (opts?.toolCallAt !== undefined) {
      const claimed = Math.min(opts.toolCallAt, now);
      if (claimed > attachment.lastToolCallAt) attachment.lastToolCallAt = claimed;
    }
    this.p.saveAttachments(workspaceId);
    this.p.emit({
      type: 'agent.heartbeat',
      workspaceId,
      agentId,
      attachment: publicAttachment(attachment, now, this.p.thresholds),
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
    const attachment = this.p.state(workspaceId)?.attachments.get(agentId);
    if (!attachment) return false;
    const observed = Math.min(at ?? Date.now(), Date.now());
    if (observed <= attachment.lastToolCallAt) return true;
    attachment.lastToolCallAt = observed;
    this.p.saveAttachments(workspaceId);
    return true;
  }

  /** Remove an attachment. Emits agent.detached once; a second detach has
   *  nothing left to announce. */
  detachAgent(workspaceId: string, agentId: string): boolean {
    const state = this.p.state(workspaceId);
    const attachment = state?.attachments.get(agentId);
    if (!state || !attachment) return false;
    const now = Date.now();
    state.attachments.delete(agentId);
    this.p.saveAttachments(workspaceId);
    this.p.emit({
      type: 'agent.detached',
      workspaceId,
      agentId,
      attachment: publicAttachment(attachment, now, this.p.thresholds),
      ts: now,
    });
    return true;
  }

  /** Full records + derived state — the OWNER surface (endpoint included).
   *  Visitors get `listPublicAttachments` instead. */
  listAttachments(workspaceId: string): DescribedAttachment[] {
    const state = this.p.state(workspaceId);
    if (!state) return [];
    const now = Date.now();
    return Array.from(state.attachments.values())
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((att) => {
        const s = attachmentState(att, now, this.p.thresholds);
        return { ...att, state: s, stateLabel: attachmentStateLabel(s) };
      });
  }

  /** The visitor-redacted read: same list, endpoint stripped. */
  listPublicAttachments(workspaceId: string): PublicAttachment[] {
    const state = this.p.state(workspaceId);
    if (!state) return [];
    const now = Date.now();
    return Array.from(state.attachments.values())
      .sort((a, b) => a.agentId.localeCompare(b.agentId))
      .map((att) => publicAttachment(att, now, this.p.thresholds));
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
    if (att.agentId && this.p.agentStreamProbe(workspaceId, att.agentId)) return true;
    const freshMs = this.p.thresholds.observedWorkFreshMs ?? OBSERVED_LIVE_MS;
    if (Date.now() - this.lastObserved(att) >= freshMs) return false;
    // Asked last and separately: the clock says the agent was here recently,
    // this says somebody is on the wire to receive what we are about to send.
    return this.p.deliveryProbe(workspaceId);
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
    const state = this.p.state(workspaceId);
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
    const state = this.p.state(workspaceId);
    const leadAgentId = state?.workspace.leadAgentId;
    if (!state || leadAgentId === undefined) return false;
    const att = state.attachments.get(leadAgentId);
    if (!att) return false;
    // Same observed clock as `hasLiveAttachment` — fixing one and not the
    // other would leave board-wide requests queueing while ordinary ones flow.
    return this.isDeliverable(workspaceId, att);
  }

  /**
   * Is this board's lead seat held by somebody who is still there?
   *
   * WHAT IT IS KEYED ON, because the choice is the whole design. The socket
   * first: an open stream is positive evidence of a live process and it
   * outranks every clock, so a lead that spent 19 minutes grepping is live
   * and stays live. Only once the stream is gone does the clock get a vote,
   * and then at `LEAD_SEAT_STALE_MS` rather than the delivery gate's window.
   *
   * It is deliberately NOT keyed on how long the board has been quiet.
   * Elapsed silence was measured at 40% false positives against provably
   * active sessions, and it cannot tell a busy lead from an exited one —
   * which is the single distinction this whole read exists to make.
   *
   * A seat held by an id that never attached (`known-agent`, a hand-set
   * lead) is stale too, and with no `lastObservedAt`: nothing was ever
   * observed, so there is no moment to report and no reason to believe
   * anybody is listening.
   */
  leadSeatHealth(workspaceId: string, now = Date.now()): LeadSeatHealth {
    const state = this.p.state(workspaceId);
    const leadAgentId = state?.workspace.leadAgentId;
    // An empty seat is not stale — it is empty, which every surface already
    // says loudly. Reporting it as stale would bury the one new signal in a
    // state people have been reading correctly all along.
    if (!state || leadAgentId === undefined) return { live: false, stale: false };
    const att = state.attachments.get(leadAgentId);
    if (att && this.isDeliverable(workspaceId, att)) {
      return { leadAgentId, live: true, stale: false, lastObservedAt: this.lastObserved(att) };
    }
    // The stream is what makes a quiet lead safe, so ask it on its own rather
    // than inheriting `isDeliverable`'s answer: that predicate also returns
    // false for a lead whose stream is open when the BOARD has no delivery
    // channel, and a board-wide outage is not evidence about this agent.
    if (this.p.agentStreamProbe(workspaceId, leadAgentId)) {
      return {
        leadAgentId,
        live: true,
        stale: false,
        ...(att ? { lastObservedAt: this.lastObserved(att) } : {}),
      };
    }
    // No record at all: report it, never act on it. A board created with a
    // lead named in advance sits here for the seconds before that session
    // attaches, and treating the gap as death let the next arrival take a seat
    // its owner was walking towards.
    if (!att) {
      return {
        leadAgentId,
        live: false,
        stale: false,
        unattached: true,
        notice:
          `The lead seat is held by ${leadAgentId}, which this board has no attachment ` +
          'record for — it has never been observed here, or its record was detached. ' +
          'Nothing is draining what queues for it. If that session is not coming, hand ' +
          'the seat to one that is.',
      };
    }
    const lastObservedAt = this.lastObserved(att);
    const staleForMs = Math.max(0, now - lastObservedAt);
    // Off the wire, but not for long enough to conclude anything. This is the
    // reconnect blip, and calling it stale here is how a working lead loses
    // its seat to the next session that attaches.
    const staleAfterMs = this.p.thresholds.leadSeatStaleMs ?? LEAD_SEAT_STALE_MS;
    if (staleForMs < staleAfterMs) {
      return { leadAgentId, live: false, stale: false, lastObservedAt };
    }
    return {
      leadAgentId,
      live: false,
      stale: true,
      lastObservedAt,
      staleForMs,
      notice:
        `The lead seat is held by ${leadAgentId}, which is off the wire and was last ` +
        `observed ${describeGap(staleForMs)} ago. Every lead-addressed delivery on this ` +
        'board — comments, review answers, stall nudges — is waiting on a session that ' +
        'is not there.',
    };
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
    const state = this.p.state(workspaceId);
    if (!state) return false;
    const att = state.attachments.get(agentId);
    if (!att) return false;
    return this.isDeliverable(workspaceId, att);
  }

  /** Open decision tasks that gate open tasks via `after` edges, rolled into
   *  the §3.3 one-liner: "2 open decisions gating 3 tasks". */
  private gatingSummary(workspaceId: string): GatingSummary {
    const state = this.p.state(workspaceId);
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
}
