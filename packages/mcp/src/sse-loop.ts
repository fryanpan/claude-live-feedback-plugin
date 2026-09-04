/**
 * The reconnecting SSE loop, one per watched key.
 *
 * Lifted out of `mcp.ts` unchanged. Everything it touches outside its own
 * arguments is passed in — the watcher registry it keeps `open` on, the base
 * URL, `fetch`, the frame handler, the dedup's reset, the log sink, the
 * backoff and the connect cap's timer — so a test can drive a whole
 * connect / read / drop / reconnect cycle without a socket and without
 * waiting on a real clock.
 *
 * Two things in here are load-bearing and were previously unassertable. The
 * `open` flag on the watcher record is what tells a live subscription from a
 * registered intention, and it used to be conflated with the map's `has`, so
 * a tool could answer `subscribed: true` from inside a backoff. And the
 * cursor is committed only after a frame is DELIVERED — see sse-cursor.ts for
 * the loss that advancing it first caused.
 */
import { RECONNECT_BASE_MS, RECONNECT_CAP_MS, reconnectDelayMs } from './backoff.ts';
import { type SseCursor, deliverThenCommit } from './sse-cursor.ts';

/** How long `startSseLoop` waits for a first connect outcome before
 *  answering `false`, so a wedged connect never stalls a tool call. */
const DEFAULT_CONNECT_CAP_MS = 3_000;

/**
 * Statuses that mean "this key is not there", as opposed to "the server
 * hiccuped".
 *
 * A deleted doc answers 404 forever, and the old loop redialled it every 1.5s
 * for the life of the process. On 2026-09-04 a peer measured
 * `net.inet.tcp.pcbcount` climbing ~2,000/hour for 79 hours — 1,233 to
 * 162,169 — while enumerable sockets stayed under 700, until `socket()`
 * failed host-wide. That is a protocol control block per attempt, never
 * reclaimed because the non-ok response's body was neither read nor
 * cancelled, at exactly the rate one flapping watcher produces.
 */
const ABSENT_STATUSES = new Set([403, 404, 410]);

/** The retry ceiling for an absent key. Far longer than the transient cap:
 *  nothing about a deleted doc is going to change in thirty seconds, and the
 *  only cost of waiting is how fast a re-created doc is picked up. */
export const ABSENT_RETRY_CAP_MS = 60_000;

/**
 * Consecutive absent answers before the loop stops.
 *
 * Not one: the auto-watch fires BEFORE the tool that creates the doc, so a
 * 404 on the first attempt is normal and a key dropped on it would never
 * connect at all. Five consecutive, each behind a growing window, is minutes
 * of a server insisting the key is gone.
 */
export const ABSENT_DROP_AFTER = 5;

export interface Watcher {
  controller: AbortController;
  docId: string;
  /**
   * Whether this watcher's stream is CURRENTLY connected — not whether a
   * watcher object exists.
   *
   * The two used to be conflated, and that is how a tool could answer
   * `subscribed: true` while its loop sat in backoff after a refused connect.
   * The loop maintains this; a caller that needs to tell a live subscription
   * from a registered intention reads it rather than the map's `has`.
   */
  open: boolean;
  /**
   * Why this watcher has no stream, when the loop gave up rather than merely
   * dropped.
   *
   * Set when a key is dropped for answering absent (404/410/403) too many
   * times running, and cleared the moment a connect succeeds. `open: false`
   * on its own cannot tell "reconnecting" from "stopped trying", and the
   * difference is the whole reason a silent session is diagnosable:
   * `list_watched_docs` reports this string.
   */
  inactiveReason?: string;
}

/** The timer pair the connect cap uses. Injectable so a test can expire it
 *  without waiting three seconds. */
export interface LoopTimers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export interface SseLoopDeps {
  /** The live watcher registry. The loop maintains each record's `open`. */
  watchers: Map<string, Watcher>;
  /** Where the feedback server is, resolved per connect attempt. */
  resolveBaseUrl: () => string;
  /** Narrower than `typeof fetch` on purpose: the loop only ever calls it
   *  with a URL string and an init, and the wide type drags in `preconnect`,
   *  which no fake would ever supply. */
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  /** What one delivered frame does; see frame-handler.ts. */
  handleFrame: (raw: string) => Promise<void>;
  /** Drop the dedup window — on a reconnect and on a delivered replay gap. */
  resetDedup: () => void;
  log: (...args: unknown[]) => void;
  /** The reconnect backoff. Injectable so a test does not wait 1.5s. */
  sleep: (ms: number) => Promise<void>;
  timers: LoopTimers;
  /** Injectable so a test can pin the backoff's jitter draw. */
  random?: () => number;
  connectCapMs?: number;
}

export interface SseLoops {
  runSseLoop(
    label: string,
    path: string,
    signal: AbortSignal,
    onFirstAttempt?: (open: boolean) => void,
  ): Promise<void>;
  startSseLoop(label: string, path: string, controller: AbortController): Promise<boolean>;
}

/** Bind the loops to one process's dependencies. */
export function createSseLoops(deps: SseLoopDeps): SseLoops {
  return {
    runSseLoop: (label, path, signal, onFirstAttempt) =>
      runSseLoop(deps, label, path, signal, onFirstAttempt),
    startSseLoop: (label, path, controller) => startSseLoop(deps, label, path, controller),
  };
}

async function runSseLoop(
  deps: SseLoopDeps,
  label: string,
  path: string,
  signal: AbortSignal,
  onFirstAttempt?: (open: boolean) => void,
): Promise<void> {
  // Tight reconnect loop — the server sends keepalive comments every
  // ~15s, so an abrupt close is almost always a transient network blip.
  //
  // `onFirstAttempt` fires once, after the first connect attempt has an
  // outcome, and is HANDED that outcome: `true` only when headers came back
  // 200 with a body, so the stream is live from here. It is
  // what lets `watch_doc` return only once the stream is actually open, so a
  // reply posted the moment the tool answers is not lost in the gap between
  // "watcher registered" and "connection established". Not "on first
  // success": the auto-watch fires BEFORE the tool that creates the doc, so a
  // 404 on the first attempt is normal there and must not hold the tool call.
  let first = onFirstAttempt;
  const settleFirst = (open: boolean) => {
    if (!first) return;
    const f = first;
    first = undefined;
    f(open);
  };
  // The watcher record is the durable answer to "is this stream up right
  // now", read by anything that must not claim a subscription it does not
  // have. `settleFirst` only ever fires once; this keeps tracking.
  const setOpen = (open: boolean) => {
    const w = deps.watchers.get(label);
    if (!w) return;
    w.open = open;
    // A connect that worked retires whatever the last failure was called.
    if (open) w.inactiveReason = undefined;
  };
  /** Stop retrying this key, and leave behind a readable reason. The record
   *  stays in the map so `unwatch_doc` still cleans it up and
   *  `list_watched_docs` can say why nothing is arriving; only the loop ends.
   *  A later server-side change to the watch set re-wires it. */
  const dropKey = (reason: string) => {
    const w = deps.watchers.get(label);
    if (w) {
      w.open = false;
      w.inactiveReason = reason;
    }
    deps.log(`[claude-workspaces-mcp] ${label}: ${reason}`);
  };
  // The wire id of the last frame this loop DELIVERED, presented back on
  // every reconnect. This loop is a hand-rolled fetch stream, not a native
  // EventSource, so nothing sends `Last-Event-ID` for us — without this line
  // the 1.5s retry below reconnects fast and resumes WITH A HOLE: everything
  // broadcast inside the gap used to be lost permanently. Delivered, not
  // seen: the cursor advances only after `handleFrame` resolves (see
  // sse-cursor.ts for the loss that committing it early caused).
  const cursor: SseCursor = { lastEventId: undefined };
  /** Consecutive failed attempts, reset on every successful connect — the
   *  input to the jittered backoff below. */
  let attempt = 0;
  /** Consecutive absent answers, reset by any other outcome. */
  let absent = 0;
  while (!signal.aborted) {
    try {
      const res = await deps.fetch(`${deps.resolveBaseUrl()}${path}`, {
        signal,
        ...(cursor.lastEventId ? { headers: { 'Last-Event-ID': cursor.lastEventId } } : {}),
      });
      const live = res.ok && res.body !== null;
      setOpen(live);
      settleFirst(live);
      if (!live) {
        // RELEASE THE BODY BEFORE THROWING. An un-consumed, un-cancelled
        // response body holds its connection open on the platform side, and
        // a loop that threw past this line leaked one protocol control block
        // per attempt — the 79-hour, 162k-PCB climb that ended in a host-wide
        // `socket()` failure. Nothing here reads the body, so cancelling is
        // the whole of the obligation.
        await releaseBody(res);
        if (ABSENT_STATUSES.has(res.status)) {
          absent += 1;
          if (absent >= ABSENT_DROP_AFTER) {
            dropKey(
              `server answered ${res.status} ${absent} times running — stopped watching this key`,
            );
            return;
          }
        } else {
          absent = 0;
        }
        throw new Error(`sse ${path} → ${res.status}`);
      }
      attempt = 0;
      absent = 0;
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      const decoder = new TextDecoder();
      let buf = '';
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // Split on blank-line boundaries per SSE framing.
          let sep = buf.indexOf('\n\n');
          while (sep >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            // Deliver, THEN advance the cursor — a frame whose delivery threw
            // must be re-presented on reconnect, not skipped past. On a
            // delivered gap the cursor drops (the held id points at nothing
            // the server can replay) and the dedup window drops with it, since
            // after a refetch-worthy gap every held key may collide with a
            // genuinely new event.
            await deliverThenCommit(frame, deps.handleFrame, cursor, deps.resetDedup);
            sep = buf.indexOf('\n\n');
          }
        }
      } finally {
        // Every exit — abort, throw, clean end — gives the reader back. A
        // released lock is what lets the platform reclaim the connection;
        // leaving one held is the same leak the non-ok branch above fixes,
        // arrived at from the other direction.
        await releaseReader(reader);
      }
    } catch (err) {
      setOpen(false);
      settleFirst(false);
      if (signal.aborted) return;
      deps.log(`[claude-workspaces-mcp] ${label} sse error, retrying:`, err);
    }
    // A clean end-of-stream lands here too, and it is just as much "not
    // connected" as a throw is.
    setOpen(false);
    // Backoff before reconnect — GROWING and FULLY JITTERED. It used to be a
    // flat 1.5s, which is how one server restart became twenty: every session
    // redialled every key at the same instant, and the herd is what kept the
    // box from coming back. See backoff.ts.
    attempt += 1;
    // An absent key backs off to a much longer ceiling than a transient
    // failure does. Nothing about a deleted doc changes inside thirty
    // seconds, and the only thing a longer wait costs is how quickly a
    // re-created doc is noticed — against a redial rate that took a machine
    // out.
    const cap = absent > 0 ? ABSENT_RETRY_CAP_MS : RECONNECT_CAP_MS;
    await deps.sleep(reconnectDelayMs(attempt, deps.random, RECONNECT_BASE_MS, cap));
    // A reconnect is what a server restart looks like from in here, and a
    // restart rebuilt every room with `seq` back at 0 — so every key the
    // dedup is holding can now collide with a genuinely NEW event and
    // silently swallow it. Drop the window: the cost is at most a duplicate
    // of something in flight, and the cost of keeping it is a comment nobody
    // ever hears about. (A current server also stamps a unique `eid`, which
    // makes this belt-and-braces; the fallback key is what an un-restarted
    // box still sends.)
    deps.resetDedup();
  }
  setOpen(false);
  settleFirst(false);
}

/**
 * Start an SSE loop and resolve once its first connect attempt has an outcome
 * — capped so a wedged connect never stalls a tool call. The loop itself keeps
 * running for the life of the watcher.
 *
 * Resolves to whether the stream is actually OPEN. `false` covers all three
 * ways it can fail to be: a throw, a non-200, and the 3s cap expiring with the
 * connect still in flight. A caller that reports a subscription to an agent
 * must branch on this rather than on the call having returned — "it returned"
 * was the old signal, and it is true in every one of those cases.
 */
function startSseLoop(
  deps: SseLoopDeps,
  label: string,
  path: string,
  controller: AbortController,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const cap = deps.timers.set(() => resolve(false), deps.connectCapMs ?? DEFAULT_CONNECT_CAP_MS);
    void runSseLoop(deps, label, path, controller.signal, (open) => {
      deps.timers.clear(cap);
      resolve(open);
    }).catch((err) => {
      deps.log(`[claude-workspaces-mcp] watcher ${label} crashed:`, err);
      deps.watchers.delete(label);
      deps.timers.clear(cap);
      resolve(false);
    });
  });
}

/** Give a response body back to the platform without reading it. Safe on a
 *  null body and on one already disturbed. */
export async function releaseBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // Already cancelled, errored or locked elsewhere — nothing left to hold.
  }
}

/** Cancel and release a reader, whichever state it is in. */
export async function releaseReader(reader: {
  cancel(): Promise<void>;
  releaseLock(): void;
}): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    // Stream already closed or errored; the lock still has to go back.
  }
  try {
    reader.releaseLock();
  } catch {
    // Some implementations release as part of cancel.
  }
}

/**
 * The watches whose loop GAVE UP, with the reason.
 *
 * `open: false` cannot tell "reconnecting" from "stopped trying", and a doc
 * deleted out from under a watch is where the difference bites: the key stays
 * in the watch set and nothing will ever arrive on it again. Reported by
 * `list_watched_docs` so that is readable without the child's stderr.
 */
export function inactiveWatches(
  // `unknown` values on purpose: the docs tool holds this map as a
  // `ReadonlyMap<string, unknown>` so it need not import the watcher type,
  // and this reads one optional field off records it does not own.
  watchers: ReadonlyMap<string, unknown>,
): Array<{ key: string; reason: string }> {
  const out: Array<{ key: string; reason: string }> = [];
  for (const [key, w] of watchers) {
    const reason = (w as Watcher | undefined)?.inactiveReason;
    if (typeof reason === 'string') out.push({ key, reason });
  }
  return out;
}
