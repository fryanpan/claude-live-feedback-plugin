/**
 * Keep this session's attachments live while it is working.
 *
 * WHY THIS EXISTS. Attaching is not a state, it is a claim that lapses unless
 * the server keeps SEEING this session: `hasLiveAttachment` /
 * `hasLiveLeadAttachment` ask whether observed work — `max(lastHeartbeat,
 * lastToolCallAt)` — is inside the observed window AND a channel is open, and
 * every lead-addressed delivery is gated on them. The server only observes
 * what reaches IT, so an agent editing files, thinking, or working a
 * different board is invisible here however busy it is. The one thing that
 * refreshed the claim was an agent remembering to call the `heartbeat` tool,
 * and nothing in this process ever did it automatically. So the documented
 * happy path — "declare yourself lead at session start and you are done" —
 * let a working agent lapse on every board it was not actively touching, at
 * which point Bryan's next goal edit queues with no channel emit and the
 * session hears exactly the silence this ticket is about.
 *
 * It also keeps the DISPLAYED state honest, which is a separate and shorter
 * clock: the active/away label a person reads on the board is heartbeat-only,
 * so without this a plainly working agent renders as away long before any
 * delivery is actually at risk.
 *
 * WHY PIGGYBACK ON TOOL CALLS rather than a timer. The heartbeat means "this
 * agent is alive AND working" — the route stamps `lastToolCallAt` from it,
 * and a fresh heartbeat with an old tool call is what renders as "process up,
 * agent unresponsive". A timer would keep asserting liveness through a wedged
 * session and destroy exactly that distinction. A tool call is the honest
 * signal, it is frequent (an agent doing anything makes many), and it costs
 * one small POST per board per interval.
 *
 * This module is the decision half only — which boards are due — so it can be
 * tested against a clock. The sending lives in mcp.ts.
 */

/** Well inside the SHORTER of the server's two windows — the heartbeat one
 *  behind the displayed active/away label — so two consecutive misses still
 *  leave the attachment both live and shown as active. Sizing against the
 *  longer delivery window instead would keep deliveries working while the
 *  board quietly rendered a working agent as away. */
const DEFAULT_INTERVAL_MS = 120_000;

export interface AttachmentKeepalive {
  /** Record that this session attached to a board (attach_agent, declaring
   *  itself lead, or the re-attach on restore). Idempotent. */
  mark(workspaceId: string): void;
  /** Boards whose heartbeat is due now, marked as sent. Empty when nothing is
   *  due — the common case, which is what keeps this cheap. */
  due(): string[];
  /** Boards this session holds an attachment on, in mark order. */
  boards(): string[];
}

export function createAttachmentKeepalive(opts?: {
  intervalMs?: number;
  now?: () => number;
}): AttachmentKeepalive {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;
  const now = opts?.now ?? Date.now;
  /** workspaceId → when this session last proved liveness on it. */
  const lastSent = new Map<string, number>();

  return {
    mark(workspaceId: string): void {
      // An attach IS a heartbeat server-side (`lastHeartbeat: now`), so the
      // clock starts here rather than firing a redundant POST immediately.
      lastSent.set(workspaceId, now());
    },
    due(): string[] {
      const t = now();
      const out: string[] = [];
      for (const [workspaceId, at] of lastSent) {
        if (t - at < intervalMs) continue;
        lastSent.set(workspaceId, t);
        out.push(workspaceId);
      }
      return out;
    },
    boards: () => [...lastSent.keys()],
  };
}
