/**
 * How long to wait before the next reconnect — and why it is not a constant.
 *
 * The reconnect backoff used to be a bare `RECONNECT_BACKOFF_MS = 1_500` with
 * no growth and no jitter, on a client that opened one loop per watched key.
 * On 2026-09-04 that turned a single server restart into a self-sustaining
 * outage: every session's every key redialled 1.5 seconds after the drop,
 * simultaneously and forever, and the load of the herd is what kept the box
 * from coming back.
 *
 * Two properties fix that, and both are needed:
 *
 *  - **Growth**, so a server that is genuinely down is dialled less often the
 *    longer it stays down, instead of at a fixed rate forever.
 *  - **FULL jitter**, so the herd disperses. Half-jitter (`d/2 + rand(d/2)`)
 *    still concentrates every client into the back half of one window;
 *    `rand(0, d)` spreads them across the whole of it, which is the property
 *    that matters when the thing being protected is the server's ability to
 *    accept a connection at all.
 *
 * The cap is what bounds recovery latency: a session that has been backing
 * off for an hour still retries within 30 seconds of the server returning.
 */

/** First window. Matches the old fixed delay, so a single blip still
 *  reconnects about as fast as it used to. */
export const RECONNECT_BASE_MS = 1_500;

/** Longest window. A dead server is redialled at most twice a minute per
 *  session; a recovered one is found within this. */
export const RECONNECT_CAP_MS = 30_000;

/**
 * A jittered delay before reconnect attempt `attempt` (1-based).
 *
 * The window doubles per attempt up to `cap`, and the delay is drawn
 * uniformly from `[0, window)` — full jitter. `random` is injectable so a
 * test can pin the draw rather than sample it.
 */
export function reconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
  base: number = RECONNECT_BASE_MS,
  cap: number = RECONNECT_CAP_MS,
): number {
  const window = reconnectWindowMs(attempt, base, cap);
  // `Math.random()` is [0,1), so the delay never reaches the window itself.
  // Floor rather than round: a delay is a wait, and rounding up past the cap
  // would make the cap a lie by a millisecond.
  return Math.floor(Math.max(0, Math.min(1, random())) * window);
}

/** The ceiling attempt `attempt` draws from. Exported so a caller can log the
 *  window it is inside without re-deriving the schedule. */
export function reconnectWindowMs(
  attempt: number,
  base: number = RECONNECT_BASE_MS,
  cap: number = RECONNECT_CAP_MS,
): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return Math.min(base, cap);
  // 2 ** (attempt - 1) reaches Infinity long before it matters here; Math.min
  // still yields `cap`, so the exponent needs no guard of its own.
  return Math.min(cap, base * 2 ** (attempt - 1));
}
