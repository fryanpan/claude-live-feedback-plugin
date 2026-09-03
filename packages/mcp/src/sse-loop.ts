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
import { type SseCursor, deliverThenCommit } from './sse-cursor.ts';

/** Backoff before a reconnect. The server sends keepalive comments every
 *  ~15s, so an abrupt close is almost always a transient blip. */
const RECONNECT_BACKOFF_MS = 1_500;

/** How long `startSseLoop` waits for a first connect outcome before
 *  answering `false`, so a wedged connect never stalls a tool call. */
const DEFAULT_CONNECT_CAP_MS = 3_000;

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
    if (w) w.open = open;
  };
  // The wire id of the last frame this loop DELIVERED, presented back on
  // every reconnect. This loop is a hand-rolled fetch stream, not a native
  // EventSource, so nothing sends `Last-Event-ID` for us — without this line
  // the 1.5s retry below reconnects fast and resumes WITH A HOLE: everything
  // broadcast inside the gap used to be lost permanently. Delivered, not
  // seen: the cursor advances only after `handleFrame` resolves (see
  // sse-cursor.ts for the loss that committing it early caused).
  const cursor: SseCursor = { lastEventId: undefined };
  while (!signal.aborted) {
    try {
      const res = await deps.fetch(`${deps.resolveBaseUrl()}${path}`, {
        signal,
        ...(cursor.lastEventId ? { headers: { 'Last-Event-ID': cursor.lastEventId } } : {}),
      });
      const live = res.ok && res.body !== null;
      setOpen(live);
      settleFirst(live);
      if (!res.ok || !res.body) throw new Error(`sse ${path} → ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
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
    } catch (err) {
      setOpen(false);
      settleFirst(false);
      if (signal.aborted) return;
      deps.log(`[claude-workspaces-mcp] ${label} sse error, retrying:`, err);
    }
    // A clean end-of-stream lands here too, and it is just as much "not
    // connected" as a throw is.
    setOpen(false);
    // Backoff before reconnect
    await deps.sleep(RECONNECT_BACKOFF_MS);
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
