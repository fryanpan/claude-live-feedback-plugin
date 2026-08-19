/**
 * `set_workspace_lead`, when you name YOURSELF, is a declaration rather than
 * a handover: attach, subscribe, take the seat, and carry off whatever was
 * waiting — one call, nothing owed afterwards.
 *
 * Why the tool grew this instead of a new one: the lead concept already
 * existed and already carried no subscription semantics, which is precisely
 * the gap. A peer can hold the seat, watch six docs by hand, and still miss
 * every voice note, because voice delivery asks whether the lead is ATTACHED
 * and a doc watch is not an attachment. Nothing reports that — a queue that
 * nobody is draining looks exactly like a queue nobody filled.
 *
 * Lives in its own module because mcp.ts ends in a top-level
 * `await server.connect(transport)` and exports nothing, so a test can only
 * read its source. Order and drained state are not things source-reading can
 * check.
 */
import { RETRIAGE_SKILL, TASK_REVIEW_SKILL } from './triage-line.ts';

export interface DeclareLeadDeps {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  watchWorkspace: (workspaceId: string) => Promise<boolean>;
  /** This session's identity — the agent a bare declaration names. */
  self: { id: string; name: string; kind?: string };
  runtime: string;
  /** The bundle this session actually loaded, so the board can say who is behind. */
  pluginVersion: string;
}

/** The half of the attach response that is a BACKLOG rather than a receipt. */
interface AttachResponse {
  attachment?: { agentId?: string };
  gating?: unknown;
  untriaged?: string[];
  queuedVoice?: Array<{ transcript: string; ts: number }>;
  lead?: boolean;
  pendingRetriage?: { batchId: string; oldGoal: string; newGoal: string; taskIds: string[] };
  pendingBucketReview?: {
    batchId: string;
    newBands: Array<{ id: string; title: string }>;
    taskIds: string[];
  };
  taskReviews?: Array<{ taskId: string; trigger: string; actor?: unknown; ts: number }>;
}

export async function declareWorkspaceLead(
  args: { workspaceId: string; leadAgentId?: string },
  deps: DeclareLeadDeps,
): Promise<Record<string, unknown>> {
  const { workspaceId } = args;
  const named = typeof args.leadAgentId === 'string' ? args.leadAgentId.trim() : '';
  // Omitted, or naming yourself: both are a declaration. Keeping the explicit
  // form on the same path is what lets the field become optional without any
  // caller changing meaning — old bundles keep sending their own id.
  const declaring = named.length === 0 || named === deps.self.id;
  const leadAgentId = declaring ? deps.self.id : named;
  const path = `/api/workspaces/${encodeURIComponent(workspaceId)}`;

  let attached: AttachResponse | undefined;
  if (declaring) {
    // 1. ATTACH FIRST. The attachment record is what hasLiveAttachment /
    //    hasLiveLeadAttachment read, and it is what drains a queue that built
    //    up while the seat was empty. Doing it after the seat change would
    //    leave setLeadAgent re-delivering to a lead the server cannot see.
    attached = (await deps.http('POST', `${path}/attachments`, {
      agentId: deps.self.id,
      runtime: deps.runtime,
      pluginVersion: deps.pluginVersion,
    })) as AttachResponse;

    // 2. SUBSCRIBE BEFORE THE SEAT CHANGE. setLeadAgent re-delivers a waiting
    //    re-triage / bucket review / task review to a live lead over the
    //    WORKSPACE CHANNEL, and CLEARS it on success. Subscribing afterwards
    //    would let that first delivery land on a stream nobody had opened yet
    //    — cleared server-side, never seen here, and no surface anywhere
    //    reporting the loss. That is this ticket's own bug, one layer down.
    //    The watch is persisted through the agent-watches machinery, so a
    //    respawn re-wires this single `ws:<id>` key and the board's docs come
    //    with it.
    await deps.watchWorkspace(workspaceId);
  }

  // 3. TAKE THE SEAT.
  const res = (await deps.http('PUT', `${path}/lead`, {
    leadAgentId,
    author: deps.self,
  })) as { changed: boolean; workspace?: { leadAgentId?: string } };

  const seat = {
    workspaceId,
    changed: res.changed,
    leadAgentId: res.workspace?.leadAgentId ?? leadAgentId,
  };
  // Naming SOMEBODY ELSE is a pure handover and stays exactly what it was: no
  // attachment, no watch, no backlog. Forging an attachment for an absent
  // agent would make the board report a live lead that is not there, and the
  // voice notes it "delivers" would reach nobody — worse than queuing them,
  // because a queue is at least honest about not having been read.
  if (!declaring) return seat;

  const a = attached ?? {};
  return {
    ...seat,
    // The answer to "am I subscribed?", which an agent otherwise cannot get
    // from the inside — the whole reason the silent-queue incident lasted.
    subscribed: true,
    lead: a.lead ?? false,
    gating: a.gating,
    untriaged: a.untriaged ?? [],
    // Everything below is DRAINED by the attach above: nothing will offer it
    // again, so it has to ride this response. Same field names and same skill
    // contracts attach_agent uses — an agent that arrives through this door
    // must not be told less than one arriving through the other.
    queuedVoice: a.queuedVoice ?? [],
    ...(a.pendingRetriage
      ? { pendingRetriage: { ...a.pendingRetriage, contract: RETRIAGE_SKILL } }
      : {}),
    ...(a.pendingBucketReview ? { pendingBucketReview: a.pendingBucketReview } : {}),
    ...(a.taskReviews !== undefined && a.taskReviews.length > 0
      ? { taskReviews: a.taskReviews, taskReviewContract: TASK_REVIEW_SKILL }
      : {}),
  };
}
