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
import { TASK_REVIEW_SKILL } from './triage-line.ts';

export interface DeclareLeadDeps {
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** `open` — the SSE stream is actually live, so events reach this session
   *  now. `persisted` — the server recorded the watch under this agent's
   *  identity, so a respawn re-wires it. They fail independently and the
   *  response must not collapse them into one cheerful literal. */
  watchWorkspace: (workspaceId: string) => Promise<{ open: boolean; persisted: boolean }>;
  /** This session's identity — the agent a bare declaration names. */
  self: { id: string; name: string; kind?: string };
  runtime: string;
  /** The bundle this session actually loaded, so the board can say who is behind. */
  pluginVersion: string;
  /** This PROCESS's attach nonce (mcp.ts PROCESS_ID). Sent so the server can
   *  tell a live process re-declaring from a fresh one — a same-process
   *  re-attach must not bypass the comment queue's ack grace window and
   *  re-hand rows whose frames are already in flight to this session. */
  processId: string;
}

/** The half of the attach response that is a BACKLOG rather than a receipt. */
interface AttachResponse {
  attachment?: { agentId?: string };
  gating?: unknown;
  untriaged?: string[];
  queuedVoice?: Array<{ transcript: string; ts: number }>;
  /** Comments addressed to this agent that its stream never carried. Handed
   *  over but NOT drained — the server holds each row until the receipt this
   *  module sends, so a crash between attach and response re-offers them. */
  queuedComments?: Array<{
    id: string;
    docId: string;
    threadId?: string;
    event: string;
    author?: { id?: string; name?: string };
    text: string;
    ts: number;
  }>;
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
  args: { workspaceId: string; leadAgentId?: string; takeover?: boolean },
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
  let subscription = { open: false, persisted: false };
  if (declaring) {
    // 1. ATTACH FIRST. The attachment record is what hasLiveAttachment /
    //    hasLiveLeadAttachment read, and it is what drains a queue that built
    //    up while the seat was empty. Doing it after the seat change would
    //    leave setLeadAgent re-delivering to a lead the server cannot see.
    attached = (await deps.http('POST', `${path}/attachments`, {
      agentId: deps.self.id,
      runtime: deps.runtime,
      pluginVersion: deps.pluginVersion,
      processId: deps.processId,
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
    //
    //    The ordering NARROWS the loss it cannot fully prevent, and saying so
    //    matters: `startSseLoop` resolves on the first attempt's OUTCOME (a
    //    throw and a non-200 both count) and on a 3s cap, so this can return
    //    with the loop still in backoff. That is why the result is kept and
    //    reported rather than assumed — `subscribed: false` on the response
    //    is the difference between a caller that can retry and one that
    //    believes a promise nobody kept.
    subscription = await deps.watchWorkspace(workspaceId);
  }

  // 3. TAKE THE SEAT.
  const res = (await deps.http('PUT', `${path}/lead`, {
    leadAgentId,
    author: deps.self,
    ...(args.takeover === true ? { takeover: true } : {}),
  })) as {
    changed: boolean;
    workspace?: { leadAgentId?: string };
    previousLeadAgentId?: string;
    declined?: string;
  };

  const settledLead = res.workspace?.leadAgentId ?? leadAgentId;
  const seat = {
    workspaceId,
    changed: res.changed,
    leadAgentId: settledLead,
    ...(res.previousLeadAgentId !== undefined
      ? { previousLeadAgentId: res.previousLeadAgentId }
      : {}),
    ...(res.declined !== undefined ? { declined: res.declined } : {}),
  };
  // Naming SOMEBODY ELSE is a pure handover and stays exactly what it was: no
  // attachment, no watch, no backlog. Forging an attachment for an absent
  // agent would make the board report a live lead that is not there, and the
  // voice notes it "delivers" would reach nobody — worse than queuing them,
  // because a queue is at least honest about not having been read.
  if (!declaring) return seat;

  const a = attached ?? {};
  // The parked comments are in this process's hands once this response goes
  // back — send the receipt per row, same contract as attach_agent's own
  // handler. A failed ack costs one redelivery after the grace window.
  for (const q of a.queuedComments ?? []) {
    if (typeof q?.id !== 'string') continue;
    try {
      await deps.http('POST', `${path}/comment-queue/${encodeURIComponent(q.id)}/ack`, {});
    } catch {
      // Left on the queue on purpose.
    }
  }
  // Two independent failures, reported separately because their remedies
  // differ: an unopened stream is retryable now, an unpersisted watch is a
  // missing `CW_AGENT_NAME` (or a server that refused) and will bite at the
  // next respawn instead of today.
  const warnings: string[] = [];
  if (!subscription.open) {
    warnings.push(
      'the event stream did not confirm it was open before the seat changed, so anything the ' +
        'server delivered in that window may not have arrived — call list_watched_docs to check ' +
        'coverage, and re-run this if it still looks wrong',
    );
  }
  if (!subscription.persisted) {
    warnings.push(
      'this subscription was NOT persisted against an agent identity, so it will not come back ' +
        'after a respawn — set CW_AGENT_NAME in the launch environment',
    );
  }
  return {
    ...seat,
    // The answer to "am I subscribed?", which an agent otherwise cannot get
    // from the inside — the whole reason the silent-queue incident lasted.
    // Read off what the watch actually reported, never asserted: a receipt
    // for work that did not happen is the same lie this tool exists to end.
    subscribed: subscription.open,
    subscriptionPersisted: subscription.persisted,
    ...(warnings.length > 0 ? { subscriptionWarning: warnings.join('; ') } : {}),
    // From the SEAT as the server settled it, not from the attach response.
    // `attachAgent` claims an EMPTY seat only, so on a takeover it answers
    // `lead: false` — which used to ship next to `leadAgentId: <me>` in the
    // same payload, and `lead` is the field the skills teach an agent to
    // branch on for "is the goal-edit re-triage addressed to me".
    lead: settledLead === deps.self.id,
    ...(res.declined === 'lead-held'
      ? {
          note:
            `${settledLead} already leads this board and is live, so the seat was left alone — ` +
            'you are attached and subscribed, and everything on the board still reaches you. ' +
            'Coordinate with them; pass takeover: true only if you mean to take the seat.',
        }
      : {}),
    gating: a.gating,
    untriaged: a.untriaged ?? [],
    // Everything below is DRAINED by the attach above: nothing will offer it
    // again, so it has to ride this response. Same field names and same skill
    // contracts attach_agent uses — an agent that arrives through this door
    // must not be told less than one arriving through the other.
    queuedVoice: a.queuedVoice ?? [],
    // Comments addressed to you that arrived while no stream was up. This
    // response is their delivery (receipts already sent) — read each and act
    // on it where it lives.
    queuedComments: (a.queuedComments ?? []).map((q) => ({
      docId: q.docId,
      ...(q.threadId !== undefined ? { threadId: q.threadId } : {}),
      event: q.event,
      ...(q.author !== undefined ? { author: q.author } : {}),
      text: q.text,
      ts: q.ts,
    })),
    ...(a.pendingRetriage ? { pendingRetriage: a.pendingRetriage } : {}),
    ...(a.pendingBucketReview ? { pendingBucketReview: a.pendingBucketReview } : {}),
    ...(a.taskReviews !== undefined && a.taskReviews.length > 0
      ? { taskReviews: a.taskReviews, taskReviewContract: TASK_REVIEW_SKILL }
      : {}),
  };
}
