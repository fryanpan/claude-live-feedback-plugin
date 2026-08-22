/**
 * Hold a channel notification until no tool call is in flight.
 *
 * A `notifications/claude/channel` frame is only useful if the SESSION reads
 * it. The frames that demonstrably arrive — comment events, `agent.attached` —
 * are written by SSE loops between requests. The restore notice was written
 * from inside the `tools/call` cycle instead: `ensureWatchesRestored` is kicked
 * off at `oninitialized`, and the first tool call awaits that same in-flight
 * promise, so the notice landed between a tool-call request and its response.
 * Measured 2026-08-20 on a respawned peer with 26 watches: the restore was
 * reported inside the `list_watched_docs` RESULT and the frame was never seen.
 *
 * This is the smallest thing that moves such an emit back onto the path the
 * arriving frames use. It is not a queue for everything — only for emits whose
 * producer happens to run inside a request, which is the restore path.
 *
 * Ordering is FIFO and preserved across the wait, so a caller that queues a
 * backlog delivery and then a summary line still gets them in that order. A
 * throwing emit is swallowed rather than allowed to strand the ones behind it:
 * these are best-effort notices, and one failed write must not cost the rest.
 */
export interface DeferredEmitter {
  /** Queue `fn` to run once no tool call is in flight. Never throws. Its
   *  resolved value is discarded — callers queue side effects, not results. */
  emitOutsideToolCall(fn: () => Promise<unknown>): void;
  /** Mark a tool call as started. Call the returned function when it ends —
   *  from a `finally`, so a throwing handler still releases the queue. */
  beginToolCall(): () => void;
  /** How many emits are still waiting. For tests and diagnostics. */
  pending(): number;
}

/**
 * @param schedule how to defer to a later macrotask. The default is
 * `setTimeout(fn, 0)`, which matters: the SDK writes a tool call's response
 * from the microtask that follows the handler's promise, so a macrotask is
 * what puts the notification strictly after the response rather than racing
 * it. Injectable so tests can drive the clock.
 */
export function createDeferredEmitter(
  schedule: (fn: () => void) => void = (fn) => {
    setTimeout(fn, 0);
  },
): DeferredEmitter {
  const queue: Array<() => Promise<unknown>> = [];
  let inFlight = 0;
  let scheduled = false;
  let draining = false;

  const scheduleFlush = () => {
    if (scheduled || queue.length === 0) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      void drain();
    });
  };

  const drain = async (): Promise<void> => {
    // A tool call that started while the flush was pending puts the queue back
    // on hold; `beginToolCall`'s release re-schedules it.
    if (draining || inFlight > 0) return;
    draining = true;
    try {
      while (queue.length > 0 && inFlight === 0) {
        const fn = queue.shift();
        if (!fn) break;
        try {
          await fn();
        } catch {
          // Best effort by construction — see the header.
        }
      }
    } finally {
      draining = false;
    }
  };

  return {
    emitOutsideToolCall(fn) {
      queue.push(fn);
      if (inFlight === 0) scheduleFlush();
    },
    beginToolCall() {
      inFlight++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        inFlight--;
        if (inFlight === 0) scheduleFlush();
      };
    },
    pending: () => queue.length,
  };
}
