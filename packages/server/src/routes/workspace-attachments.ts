/**
 * Which agents are attached to a board, their heartbeats, and the receipts that clear their queues.
 *
 * Lifted verbatim out of `createServer`'s request closure; the handlers
 * read their collaborators off `WorkspaceRoutesContext` instead of the scope.
 */
import { attachNotes } from '../attach-notes.ts';
import { clientReleaseStatus } from '../client-release.ts';
import {
  agentsBehind,
  checkableAttachments,
  readReleasedPluginVersion,
} from '../plugin-release.ts';
import { isAttachmentRuntime } from '../tasks.ts';
import type { WorkspaceRouteRequest, WorkspaceRoutesContext } from './workspace-routes-context.ts';

/** Answers the routes below, or `undefined` when the path is none of them. */
export async function handleWorkspaceAttachments(
  ctx: WorkspaceRoutesContext,
  rq: WorkspaceRouteRequest,
): Promise<Response | undefined> {
  const { taskStore, sse, agentWatches, clientReleaseRootDir, j, safeJson, watchKeyExists } = ctx;
  const { req, pathname, visitor } = rq;
  // --- REST: agent attachments (§4) ---
  // AgentAttachment records live OUTSIDE every ydoc; this REST surface
  // is their only read path. `endpoint` is host-machine-describing, so
  // a share visitor's read is redacted (the private-meta pattern) and
  // the mutations are owner-only outright — a visitor attaching an
  // agent or forging a heartbeat is never legitimate.
  const wsAgentsMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/attachments$/);
  if (wsAgentsMatch && req.method === 'GET') {
    const workspaceId = decodeURIComponent(wsAgentsMatch[1] ?? '');
    if (!taskStore.getWorkspace(workspaceId)) {
      return j(404, { error: 'workspace not found' });
    }
    const attachments = visitor
      ? taskStore.listPublicAttachments(workspaceId)
      : taskStore.listAttachments(workspaceId);
    // Drift rides the same read the board already makes, so nobody has
    // to run a command to discover that a merge never reached them.
    // A plugin version is workspace-visible, not host-describing —
    // it says which tools an agent here can use, so a visitor sees it
    // for the same reason they see who is attached.
    const released = readReleasedPluginVersion();
    // The other half of "what is running where": the plugin drift above
    // is about the agents, this is about the browser the reader is
    // holding. A failed client build keeps the previous release live and
    // used to say so only on stderr, so the split widened in silence.
    //
    // Owner-only: `lastError` is a build error off this machine's disk
    // (absolute paths), and which release is live is a fact about the
    // host's deploy rather than workspace content — the same line the
    // `endpoint` redaction draws.
    const clientRelease =
      clientReleaseRootDir && !visitor ? clientReleaseStatus(clientReleaseRootDir) : null;
    return j(200, {
      workspaceId,
      attachments,
      // Who owns this board's asks, and whether they are there. It rides
      // this read rather than the projected workspace info because seat
      // health CHANGES WITH TIME and nothing else: a lead that stops
      // answering writes no board event, so a value projected into the
      // doc would still say "fine" hours later. The presence strip
      // repaints off this list already.
      seat: taskStore.leadSeatHealth(workspaceId),
      ...(clientRelease ? { clientRelease } : {}),
      pluginRelease: {
        version: released,
        behind: agentsBehind(released, attachments).map((a) => ({
          agentId: a.agentId,
          ...(a.pluginVersion !== undefined ? { pluginVersion: a.pluginVersion } : {}),
        })),
        // How many sessions the `behind` list was computed OVER. It
        // ships beside the list because the list alone cannot be read:
        // empty means "none of the ones checked", and for this board
        // that has normally been one session — its own. Without the
        // denominator the surface renders participation as clearance.
        checked: checkableAttachments(attachments).length,
      },
    });
  }
  if (wsAgentsMatch && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const workspaceId = decodeURIComponent(wsAgentsMatch[1] ?? '');
    const body = await safeJson(req);
    const agentId = body?.agentId;
    if (typeof agentId !== 'string' || agentId.trim().length === 0) {
      return j(400, { error: 'agentId required' });
    }
    const runtime = body?.runtime;
    if (!isAttachmentRuntime(runtime)) {
      return j(400, { error: 'runtime must be claude-code-local | managed-agent | webhook' });
    }
    const res = taskStore.attachAgent(workspaceId, {
      agentId: agentId.trim(),
      // The display name the session runs under. Absent from older
      // bundles, which attach under their id.
      ...(typeof body?.agentName === 'string' && body.agentName.trim().length > 0
        ? { agentName: body.agentName.trim() }
        : {}),
      runtime,
      capabilities: Array.isArray(body?.capabilities)
        ? (body.capabilities as unknown[]).filter((c): c is string => typeof c === 'string')
        : undefined,
      endpoint: typeof body?.endpoint === 'string' ? body.endpoint : undefined,
      // The bundle this session is running. Absent from every peer
      // older than the release that added it — which is the signal,
      // not a gap to paper over with a default.
      pluginVersion:
        typeof body?.pluginVersion === 'string' && body.pluginVersion.trim().length > 0
          ? body.pluginVersion.trim()
          : undefined,
      // Per-process nonce (see AgentAttachment.processId): same nonce
      // means a live process re-attaching, so the drains respect the
      // ack grace; absent (an older bundle) keeps bypass-always.
      processId:
        typeof body?.processId === 'string' && body.processId.trim().length > 0
          ? body.processId.trim()
          : undefined,
    });
    if (!res.ok) {
      // 409: the id is real but no longer the one to use — the body
      // names the survivor, and a 400 would read as a malformed request.
      const status =
        res.error === 'workspace-not-found' ? 404 : res.error === 'merged-away' ? 409 : 400;
      return j(status, res);
    }
    // What this session is subscribed to, counted here because watches
    // live outside the task store. A session that respawned under a new
    // name comes up with none, and an empty list reads exactly like a
    // session that simply has not subscribed yet — which is why the
    // count ships with the seat rather than on its own. Together they
    // are the two halves of "a rename took me off this board".
    const watching = agentWatches.list(res.attachment.agentId, watchKeyExists).watches.length;
    return j(200, { ...res, watching, notes: attachNotes(res, watching) });
  }
  const wsAgentHeartbeatMatch = pathname.match(
    /^\/api\/workspaces\/([^/]+)\/attachments\/([^/]+)\/heartbeat$/,
  );
  if (wsAgentHeartbeatMatch && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const workspaceId = decodeURIComponent(wsAgentHeartbeatMatch[1] ?? '');
    const agentId = decodeURIComponent(wsAgentHeartbeatMatch[2] ?? '');
    const body = await safeJson(req);
    const res = taskStore.heartbeat(workspaceId, agentId, {
      // Forwarded, not re-derived: the runtime knows when it last did
      // work; the route's job is only to not drop the field.
      toolCallAt: typeof body?.toolCallAt === 'number' ? Number(body.toolCallAt) : undefined,
    });
    if (!res.ok) return j(404, res);
    // Parked comments ride the observation, as ADDRESSED frames — the
    // response body would not do (the keepalive that carries most
    // heartbeats discards it), and a broadcast would bill every peer
    // for a message that names one of them. Each frame replays the
    // original payload plus this row's id; the receiving MCP's ack is
    // what clears it.
    //
    // `sendToAgent` returning 0 is a REAL answer — the agent holds no
    // stream (its keepalive still lands as plain HTTP while its SSE
    // reconnect fails) — and the hand-over above already stamped the
    // row emitted. Left stamped, the row waits out a full grace window
    // per heartbeat while never actually going anywhere: an
    // SSE-or-nothing loop wearing delivery bookkeeping. Same lesson as
    // setTriageDelivery above ("0 is a real answer"): roll the mark
    // back, so the NEXT heartbeat is a fresh attempt rather than a
    // grace-window wait. Rows the route cannot even frame (no replay
    // payload) are rolled back for the same reason — nothing was sent.
    for (const q of res.queuedComments ?? []) {
      let sent = 0;
      const original =
        q.payload && typeof q.payload === 'object'
          ? (q.payload as Record<string, unknown>)
          : undefined;
      if (original && typeof original.event === 'string') {
        const frame: Record<string, unknown> & { event: string } = {
          ...original,
          event: original.event,
          workspaceId,
          commentQueueId: q.id,
        };
        sent = sse.sendToAgent(`ws~${workspaceId}`, agentId, frame);
      }
      if (sent === 0) taskStore.clearCommentEmitted(workspaceId, q.id);
    }
    return j(200, res);
  }
  // The receipt that clears a queued comment — mirror of the voice ack
  // below, with the same idempotency: a replayed receipt for a row
  // already cleared answers 200 with cleared:false rather than an
  // error.
  const wsCommentAckMatch = pathname.match(
    /^\/api\/workspaces\/([^/]+)\/comment-queue\/([^/]+)\/ack$/,
  );
  if (wsCommentAckMatch && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const workspaceId = decodeURIComponent(wsCommentAckMatch[1] ?? '');
    const entryId = decodeURIComponent(wsCommentAckMatch[2] ?? '');
    const cleared = taskStore.ackComment(workspaceId, entryId);
    return j(200, { ok: true, cleared });
  }
  // The receipt that makes a live voice delivery durable. The server
  // knows what it wrote to a socket and nothing more, so a row stays on
  // the queue until the receiving process says it has it. Idempotent: a
  // replayed receipt for a row already cleared answers 200 with
  // cleared:false rather than an error, because a retrying client
  // should not have to distinguish "gone because I acked it" from
  // "gone because someone else drained it".
  const wsVoiceAckMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/voice-queue\/([^/]+)\/ack$/);
  if (wsVoiceAckMatch && req.method === 'POST') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const workspaceId = decodeURIComponent(wsVoiceAckMatch[1] ?? '');
    const entryId = decodeURIComponent(wsVoiceAckMatch[2] ?? '');
    const cleared = taskStore.ackVoiceRequest(workspaceId, entryId);
    return j(200, { ok: true, cleared });
  }
  const wsAgentDetachMatch = pathname.match(/^\/api\/workspaces\/([^/]+)\/attachments\/([^/]+)$/);
  if (wsAgentDetachMatch && req.method === 'DELETE') {
    if (visitor) return j(403, { error: 'not available to share visitors' });
    const workspaceId = decodeURIComponent(wsAgentDetachMatch[1] ?? '');
    const agentId = decodeURIComponent(wsAgentDetachMatch[2] ?? '');
    if (!taskStore.detachAgent(workspaceId, agentId)) {
      return j(404, { error: 'attachment not found' });
    }
    return j(200, { ok: true });
  }
  return undefined;
}
