/**
 * ONE SSE stream per agent, carrying every key that agent watches.
 *
 * WHY THIS EXISTS. The MCP child opened one TCP socket per watched key —
 * `/events/<docId>` for each doc and `/events/workspace/<id>` for each board.
 * A lead session with 214 watches held 214 sockets, and on 2026-09-04 the
 * fleet reached 332 client sockets against this server (plus ~387 server-side
 * ends) and exhausted the kernel's socket memory. `netstat -m` recorded
 * "requests for memory denied"; the supervisor's connect-only bind probe then
 * failed, read the failure as "alive but unbound", and restarted the server —
 * whereupon every client reconnected every key at once on a fixed 1.5s
 * backoff and did it again. Twenty restarts in a day, and a reboot brought
 * the count back inside fifteen minutes because the watch set is persisted.
 *
 * So the fan-out moves to the server. One stream, N channels, each frame
 * tagged with the watch key it arrived on.
 *
 * WHAT IS PRESERVED, DELIBERATELY:
 *
 *  - **Replay is still per key.** The reconnecting client presents a per-key
 *    cursor (see mux-cursor.ts) and each key is answered on its own:
 *    a proven tail, or a `replay.gap` naming THAT key. Collapsing the gap
 *    signal across keys would tell a session to refetch everything because
 *    one channel aged out, or — far worse — let one channel's clean catch-up
 *    vouch for another's hole.
 *  - **`agentId` is registered on board channels only.** A doc stream opened
 *    by the MCP child has always been anonymous, and `agentsOn` / `sendToAgent`
 *    / the lead-presence monitor all read that registration. Naming the agent
 *    on every doc channel would silently widen every delivery decision that
 *    asks "is that agent reachable", which is a different change from this
 *    one. The agent id IS passed to `replayAfter` on every channel, because
 *    filtering a catch-up to what this subscriber may see is not the same
 *    question as who is registered.
 *  - **The old per-key routes keep working.** Nothing here replaces them;
 *    clients on the previous bundle stay live through the rollout.
 *
 * WHAT IS NEW: the channel set is re-read when the agent's watch set changes,
 * so `watch_doc` / `unwatch_doc` reach the stream without a reconnect. That
 * is the property that keeps this from trading a socket storm for a
 * reconnect storm.
 */
import { SSE_KEEPALIVE_MS, type SseHub } from './sse.ts';

/** What one watch key resolves to on the wire. `ws:<id>` keys broadcast on
 *  the `ws~<id>` channel; a doc key is its own canonical id. */
export function channelForWatchKey(key: string, canonicalDocId: (id: string) => string): string {
  return key.startsWith('ws:') ? `ws~${key.slice('ws:'.length)}` : canonicalDocId(key);
}

/** A board key names an agent-addressable channel; a doc key does not. See
 *  the module comment for why only the former carries the agent id. */
function registersAgentId(key: string): boolean {
  return key.startsWith('ws:');
}

export interface AgentMuxStreamOptions {
  hub: SseHub;
  /** The agent this stream belongs to — its identity on board channels and
   *  the filter its replay is scoped by. */
  agentId: string;
  /** The agent's live watch set, read fresh on open and on every change. */
  keys: () => string[];
  /** Watch key → broadcast channel. */
  channelFor: (key: string) => string;
  /** Per-key positions from `Last-Event-ID`, or undefined for a fresh
   *  subscription. */
  cursors?: Map<string, string> | undefined;
  /** Subscribe to watch-set changes for this agent; returns an unsubscribe.
   *  Omitted in tests that do not exercise the live-update path. */
  onWatchSetChanged?: (cb: () => void) => () => void;
  /** Injectable so a test does not hold a 15s interval open. */
  keepaliveMs?: number;
}

/**
 * Open the multiplexed stream. The Response's body stays open for the life of
 * the subscription, exactly like `openSseStream`.
 */
export function openAgentMuxStream(opts: AgentMuxStreamOptions): Response {
  const { hub, agentId, keys, channelFor } = opts;
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  /** watch key → the hub disposer for its registration. */
  const subscribed = new Map<string, () => void>();
  let unsubscribeWatchSet: (() => void) | null = null;
  let keepalive: ReturnType<typeof setInterval> | null = null;

  /** Write one frame. `watchKey` is stamped into the payload so the client
   *  can tell which of its N subscriptions a frame arrived on — that tag is
   *  what makes a single socket equivalent to N. */
  const emit = (watchKey: string, event: string, data: unknown, id?: string): void => {
    if (!controller) return;
    const payload =
      data !== null && typeof data === 'object'
        ? { ...(data as Record<string, unknown>), watchKey }
        : { event, watchKey };
    const idLine = id ? `id: ${id}\n` : '';
    controller.enqueue(
      encoder.encode(`${idLine}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`),
    );
  };

  /** The per-channel sink the hub writes through. One object per key, so the
   *  tag is decided at registration rather than guessed at write time. */
  const sinkFor = (watchKey: string) => ({
    write: (event: string, data: unknown, id?: string) => emit(watchKey, event, data, id),
    close: () => {
      try {
        controller?.close();
      } catch {
        // Already gone; the disposers below are the bookkeeping either way.
      }
    },
  });

  /**
   * Bring the registrations in line with the agent's current watch set.
   *
   * Called on open and on every change to the set. Only the DIFFERENCE moves:
   * a key that is still watched keeps the registration it has, so a
   * `watch_doc` on a session holding two hundred keys does not churn two
   * hundred sinks — and, more importantly, cannot drop a frame in the gap
   * between a remove and a re-add.
   */
  const sync = (): void => {
    const want = new Set(keys());
    for (const [key, dispose] of subscribed) {
      if (want.has(key)) continue;
      dispose();
      subscribed.delete(key);
    }
    for (const key of want) {
      if (subscribed.has(key)) continue;
      subscribed.set(
        key,
        hub.add(
          channelFor(key),
          sinkFor(key),
          undefined,
          registersAgentId(key) ? agentId : undefined,
          undefined,
        ),
      );
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      // Flush headers through any proxy before anything else, exactly as the
      // per-key stream does.
      c.enqueue(encoder.encode(':ok\n\n'));
      sync();
      // Catch-up, BETWEEN registration and the first live write, and
      // synchronous for the same reason `openSseStream` gives: nothing can be
      // broadcast between `hub.add` above and the replay below, so the
      // replayed tail and the live feed meet with neither a hole nor a
      // duplicate.
      const cursors = opts.cursors;
      if (cursors && cursors.size > 0) {
        for (const key of subscribed.keys()) {
          const lastId = cursors.get(key);
          if (lastId === undefined) continue;
          const replay = hub.replayAfter(channelFor(key), lastId, agentId);
          if (replay.ok) {
            for (const e of replay.events) emit(key, e.payload.event, e.payload, e.id);
          } else {
            // Per key, and NAMING the key. No `id:` line — the frame is
            // synthetic per connection, and an id here could be presented
            // back and mistaken for coverage.
            emit(key, 'replay.gap', {
              event: 'replay.gap',
              docId: key.startsWith('ws:') ? key.slice('ws:'.length) : key,
              watchKey: key,
              lastEventId: lastId,
              action: 'refetch',
              reason:
                'last-event-id is older than the replay buffer (or from a previous server epoch); ' +
                'events may have been missed on this key — refetch state instead of trusting the stream',
            });
          }
        }
      }
      // A watch/unwatch reaches this stream without a reconnect. Without it
      // every `watch_doc` would cost a hang-up and a fresh connect, which is
      // the socket storm this route exists to end wearing a different hat.
      unsubscribeWatchSet = opts.onWatchSetChanged?.(() => sync()) ?? null;
      keepalive = setInterval(() => {
        try {
          c.enqueue(encoder.encode(':ka\n\n'));
        } catch {
          if (keepalive) clearInterval(keepalive);
        }
      }, opts.keepaliveMs ?? SSE_KEEPALIVE_MS);
    },
    cancel() {
      controller = null;
      for (const dispose of subscribed.values()) dispose();
      subscribed.clear();
      unsubscribeWatchSet?.();
      unsubscribeWatchSet = null;
      if (keepalive) clearInterval(keepalive);
      keepalive = null;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
