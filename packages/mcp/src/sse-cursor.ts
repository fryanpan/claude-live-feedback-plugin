/**
 * The reconnect cursor of one hand-rolled SSE loop: the wire id this session
 * will present as `Last-Event-ID` on its next reconnect.
 *
 * Split out of `runSseLoop` for one reason — the ORDER in which a frame is
 * delivered and the cursor is advanced is load-bearing, and buried inline it
 * shipped wrong once: the cursor was advanced BEFORE `handleFrame` ran, so a
 * frame whose delivery threw (a transient EPIPE writing the MCP notification,
 * say) was already "seen" as far as the next reconnect was concerned. The
 * server would faithfully replay everything AFTER that id — and the one frame
 * whose processing actually failed sat at the id itself, never replayed,
 * silently gone. That is precisely the failure class the replay branch exists
 * to close, reintroduced one line lower.
 *
 * So: deliver first, commit after. A frame that fails to deliver leaves the
 * cursor where it was; the loop's catch reconnects presenting the OLD id, the
 * server replays from there, and the failed frame is retried rather than
 * skipped. (The loop drops its dedup window on every reconnect, so the retry
 * is forwarded, not swallowed.) The same ordering protects the `replay.gap`
 * handling: clearing the cursor only after the gap notice actually reached
 * the agent means a notice that failed to send is re-answered by the server
 * on the next reconnect instead of evaporating.
 */

export type SseCursor = { lastEventId: string | undefined };

export type FrameMeta = { id?: string; event?: string };

/** The `id:` line and event name of one raw SSE frame — what the reconnect
 *  logic needs before the frame is parsed as JSON. */
export function frameMeta(raw: string): FrameMeta {
  const meta: FrameMeta = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('id:')) meta.id = line.slice(3).trim();
    else if (line.startsWith('event:')) meta.event = line.slice(6).trim();
  }
  return meta;
}

/**
 * Deliver one frame, THEN commit its effect on the cursor — never the other
 * way around (see the module comment for the loss that ordering caused).
 *
 * On a delivered `replay.gap` the cursor is cleared — presenting the stale id
 * again would just buy another gap notice — and `onGap` runs so the caller
 * can drop its dedup window (after a refetch-worthy gap every held key may
 * collide with a genuinely new event). A throw from `deliver` propagates with
 * the cursor untouched.
 */
export async function deliverThenCommit(
  frame: string,
  deliver: (frame: string) => Promise<void>,
  cursor: SseCursor,
  onGap: () => void,
): Promise<void> {
  await deliver(frame);
  const meta = frameMeta(frame);
  if (meta.event === 'replay.gap') {
    cursor.lastEventId = undefined;
    onGap();
  } else if (meta.id !== undefined) {
    cursor.lastEventId = meta.id;
  }
}
