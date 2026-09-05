/**
 * The requests the MCP child makes on ITS OWN clock, not because a tool call
 * asked for them.
 *
 * Several tests in this package spawn the bundle against a stub HTTP server,
 * record every request the stub sees, and then assert on the LAST one — the
 * verb the case just exercised. That reads as safe and is not. The child also
 * runs a multiplexed event stream (`/events/agent/<id>`, PR 678), and that
 * stream redials on a backoff of its own: measured against the stub at
 * roughly +0.4s, +1.3s, +4s and on. Each redial mints a fresh agent token
 * first, so one reconnect is TWO requests landing in whatever window they
 * land in. A heartbeat is worse still — `call-tool.ts` fires it and does not
 * await it, so it can land after the answer it was dispatched alongside.
 *
 * The failures that produced this file were both `seen.at(-n)` reading one of
 * those instead of the verb: on PR 680 `set_review_item_criteria` asserted a
 * path and got `/events/agent/<id>`, and on PR 701 a `request_more_info` case
 * asserted `at(-2)` was a GET and got the POST its own call had made, shoved
 * back a slot by a trailing token GET. Both passed locally and on rerun,
 * which is exactly how a timing race presents.
 *
 * So a recorder splits on this predicate: the foreground array holds what the
 * tool call did, the background array holds what the child was doing anyway.
 * Ordering inside the foreground array is then a property of the tool, and no
 * amount of stream timing can move it.
 *
 * NOT background, deliberately:
 *   - `POST /api/agents/<id>/watches` — the durable watch write. It is a verb
 *     tests assert on, and `call-tool.ts` awaits the auto-watch before the
 *     handler, so its position is fixed rather than raced.
 *   - every other REST route, which only happens because a handler asked.
 */

/** One recorded request, as thin as every recorder in this package makes it. */
export type BackgroundCandidate = { method: string; path: string };

const AGENT_TOKEN = /^\/api\/agents\/[^/]+\/token$/;
const AGENT_WATCHES = /^\/api\/agents\/[^/]+\/watches$/;
const HEARTBEAT = /^\/api\/workspaces\/[^/]+\/attachments\/[^/]+\/heartbeat$/;

/**
 * Whether this request is the child's own background traffic.
 *
 * Takes the path with or without a query string; recorders in this package
 * disagree about which they store.
 */
export function isBackgroundRequest(req: BackgroundCandidate): boolean {
  const path = req.path.split('?')[0] ?? req.path;
  // The one multiplexed stream, and the per-doc streams it replaced.
  if (path.startsWith('/events/')) return true;
  // Minted for the two routes above, so it redials with them.
  if (req.method === 'GET' && AGENT_TOKEN.test(path)) return true;
  // The watch RESTORE. The POST on the same route is a verb; see above.
  if (req.method === 'GET' && AGENT_WATCHES.test(path)) return true;
  // Fire-and-forget in `call-tool.ts`: it can land after the tool's answer.
  if (req.method === 'POST' && HEARTBEAT.test(path)) return true;
  return false;
}
