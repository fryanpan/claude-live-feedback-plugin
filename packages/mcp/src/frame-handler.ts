/**
 * One raw SSE frame in, at most one channel message and one receipt out.
 *
 * Lifted out of `mcp.ts` unchanged so it can be driven directly: that file
 * starts an MCP server on import, which put the parse, the gap notice, the
 * kind gate, the dedup and the comment receipt out of reach of everything but
 * a spawned bundle.
 *
 * The ORDER here is the load-bearing part and the reason it is worth its own
 * module. The kind gate runs before the dedup, so a word-rate frame never
 * reaches the dedup window. The receipt runs after the forward attempt and
 * OUTSIDE the dedup gate, so a redelivered frame is still acknowledged while
 * being hidden from the session.
 */
import { isChannelEvent } from './channel-gate.ts';
import type { ChannelNotification } from './channel-messages.ts';

export interface FrameHandlerDeps {
  /** Where a rendered line goes — `server.notification` in the real process. */
  notify: (n: ChannelNotification) => Promise<void>;
  /** The doc/board renderer; see channel-messages.ts. */
  emitChannelMessage: (event: string, payload: unknown) => Promise<void>;
  /** The REST call to the feedback server; throws on a non-2xx. */
  http: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** The process-wide dedup — one message per event however many streams
   *  carried it. See frame-dedup.ts. */
  shouldForward: (event: string, payload: unknown) => boolean;
  /** Injectable so a test can assert a gap notice's `sent_at`. */
  now?: () => number;
}

function nowMs(deps: FrameHandlerDeps): number {
  return (deps.now ?? Date.now)();
}

/** Bind the handler to one process's dependencies. */
export function createFrameHandler(deps: FrameHandlerDeps): (raw: string) => Promise<void> {
  return (raw) => handleFrame(deps, raw);
}

async function handleFrame(deps: FrameHandlerDeps, raw: string): Promise<void> {
  // Only forward data frames — ignore keepalive ':ok' comments.
  const lines = raw.split('\n');
  let ev = 'message';
  const dataParts: string[] = [];
  for (const line of lines) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) ev = line.slice(6).trim();
    else if (line.startsWith('data:')) dataParts.push(line.slice(5).trimStart());
  }
  if (dataParts.length === 0) return;
  let payload: unknown;
  try {
    payload = JSON.parse(dataParts.join('\n'));
  } catch {
    return;
  }
  if (ev === 'replay.gap') {
    // An explicit hole: the server is saying it CANNOT replay what this
    // session missed while disconnected. Surface it as its own channel line —
    // the doc-shaped formatter below would render it as a garbled comment —
    // so the agent refetches (get_doc / list_threads / next_tasks) instead of
    // trusting the stream to have been complete. No receipt: a gap notice
    // carries no queue row, and acking one would claim delivery of the very
    // frames it is reporting as missing.
    const p = (payload ?? {}) as { docId?: string };
    await deps.notify({
      method: 'notifications/claude/channel',
      params: {
        source: 'claude-workspaces',
        sent_at: new Date(nowMs(deps)).toISOString(),
        content: `[replay.gap] events on ${p.docId ?? 'a watched channel'} may have been missed while this session was disconnected — refetch state (get_doc / list_threads / next_tasks) rather than assuming the stream was complete`,
        meta: { event: 'replay.gap', ...(p.docId ? { doc_id: p.docId } : {}) },
      },
    });
    return;
  }
  // The kind gate FIRST, then the dedup: a word-rate frame must never reach
  // the dedup's window, let alone the channel (channel-gate.ts).
  if (isChannelEvent(ev) && deps.shouldForward(ev, payload)) {
    await deps.emitChannelMessage(ev, payload);
  }
  // The receipt for a durable comment row, AFTER the forward attempt (same
  // ordering rationale as the voice ack below: an ack sent first would clear
  // the durable copy on the strength of an intent). Deliberately OUTSIDE the
  // dedup gate: a redelivered frame reuses the original event's eid — it IS
  // the same event — so dedup rightly hides the duplicate from the session,
  // but the receipt must still go back or the server re-offers the row after
  // every grace window, forever. "The frame is in this process's hands" is
  // exactly what the receipt asserts, forwarded or collapsed.
  await ackCommentRow(deps, payload);
}

/** POST the receipt for a frame that carries a durable comment-queue row id.
 *  Never throws: a failed ack leaves the row on the queue, so the cost is a
 *  redelivery after the grace window — late and duplicated beats silently
 *  dropped, and that asymmetry is why the receipt lives on this side. */
async function ackCommentRow(deps: FrameHandlerDeps, payload: unknown): Promise<void> {
  const p = payload as { commentQueueId?: unknown; workspaceId?: unknown };
  if (typeof p?.commentQueueId !== 'string' || typeof p?.workspaceId !== 'string') return;
  try {
    await deps.http(
      'POST',
      `/api/workspaces/${encodeURIComponent(p.workspaceId)}/comment-queue/${encodeURIComponent(p.commentQueueId)}/ack`,
      {},
    );
  } catch {
    // Left on the queue on purpose — see above.
  }
}
