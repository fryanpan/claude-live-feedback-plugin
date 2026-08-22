import { newEventId } from './event-id.ts';

/**
 * Anything broadcast over SSE: thread/suggestion webhook payloads and the
 * hub task events. The hub only needs the event name here — the whole
 * object is serialized as the data line either way.
 */
type SsePayload = { event: string };

/**
 * Bounded per-channel replay buffer, so a reconnect presenting
 * `Last-Event-ID` gets the events it missed instead of a silent hole.
 *
 * WHY THESE NUMBERS. The gaps this exists to cover are seconds to a couple
 * of minutes: the MCP child retries on a 1.5s loop, a native EventSource
 * every ~3s, a wifi switch or tunnel blip is under a minute, and the ticket's
 * promise is "within 15s of the network coming back". TEN MINUTES of age is
 * that with a wide margin (a slept iPad that wakes inside it still catches
 * up); anything longer is a session that should refetch state anyway, which
 * is exactly what the `replay.gap` signal tells it to do. TWO HUNDRED events
 * bounds the memory side, with one honest caveat: thread events embed the
 * WHOLE current thread (`fireEvent` in rooms.ts sends `thread.comments` in
 * full, not a delta), so a buffered event is ~1-2KB for a short thread but
 * scales with the thread's size at the time it fired — a hot thread with
 * tens of long replies can push a saturated channel's buffer to several MB
 * rather than the few hundred KB the small-thread math suggests. That is
 * exactly the channel most likely to be mid-conversation during a blip, so
 * the count and age caps — not the per-event size — are the real bound:
 * worst case remains bounded per channel and drops to nothing within ten
 * minutes of the channel going quiet (the sweep below). Channels only hold
 * a buffer once something is sent on them. Overflowing either bound is
 * SAFE, not lossy-silent: an id that fell out of the buffer answers with
 * `replay.gap`, never with a partial replay pretending to be a whole one.
 */
export const REPLAY_MAX_EVENTS = 200;
export const REPLAY_MAX_AGE_MS = 10 * 60_000;

/** `toAgent` marks an addressed frame (`sendToAgent`): buffered alongside
 *  broadcasts in the same id namespace, but replayed ONLY to the stream that
 *  names that agent — everyone else's catch-up filters it out, exactly as
 *  their live feed never carried it. */
type BufferedEvent = { id: string; at: number; payload: SsePayload; toAgent?: string };

/**
 * The keepalive period and the socket idle timeout are ONE decision, so they
 * live next to each other. `SSE_KEEPALIVE_MS` must stay comfortably under
 * `HTTP_IDLE_TIMEOUT_SEC * 1000`, and `sse-keepalive.test.ts` asserts exactly
 * that — separating them is what broke this.
 *
 * Measured 2026-08-19 on Bun 1.3.10: `curl -N` on `/events/workspace/<id>`
 * ended after 9.7s having received the 5-byte `:ok` preamble and nothing else,
 * when asked to hold for 40. The keepalive comment was already here, on a
 * 20_000ms period; `Bun.serve` carried no `idleTimeout` at all and Bun's
 * default is 10 seconds. **The guard's period was longer than the timeout it
 * was guarding**, so the connection idled out before the keepalive could ever
 * write, on every stream, forever.
 *
 * The damage was not the reconnect. `EventSource` reconnects by itself, so
 * every open tab looked healthy while reopening its stream six times a minute
 * — and with no `Last-Event-ID` replay on this server, everything broadcast
 * inside those gaps was lost permanently.
 *
 * Both numbers are deliberately defensive rather than minimal. 15s of
 * keepalive also sits under the 30-60s idle timeouts common in proxies, so a
 * tunnel in front of this server cannot reintroduce the same failure; and
 * 120s of idle timeout means a missed keepalive costs nothing. Bun caps
 * `idleTimeout` at 255 and throws above it, which the test also pins.
 */
export const SSE_KEEPALIVE_MS = 15_000;
export const HTTP_IDLE_TIMEOUT_SEC = 120;

type Sink = {
  /** `id` becomes the SSE `id:` line. Broadcast AND addressed frames carry
   *  one — both live in the replay buffer, so both ids are safe to present
   *  back. The synthetic per-connection `replay.gap` does not: per the SSE
   *  spec a frame without an id field leaves the client's lastEventId
   *  untouched, and a gap id presented back would read as coverage. */
  write: (event: string, data: unknown, id?: string) => void;
  close: () => void;
};

export class SseHub {
  /**
   * docId → (sink → who opened it).
   *
   * `shareId` is what makes revocation reach this layer. An SSE stream has
   * the same shape of problem as a websocket — authorized once at open, then
   * long-lived — so pulling a visitor's access has to hang up their stream as
   * well, or they keep receiving every new comment on a review they can no
   * longer load. Owner streams carry no shareId and are never swept.
   *
   * `agentId` is present only on the workspace stream an agent's MCP child
   * opens for itself, and it is what lets `agentsOn` answer "is THAT agent
   * reachable" rather than merely "is anybody subscribed". A browser tab sets
   * it on nothing, so a tab can never make an absent agent look present —
   * which is the property that allows this signal to widen a delivery
   * decision where a bare subscriber count may only narrow one.
   */
  private byDoc = new Map<string, Map<Sink, { shareId?: string; agentId?: string }>>();

  /** channel → recent frames (broadcast + addressed), oldest first. Bounded by REPLAY_MAX_EVENTS
   *  and REPLAY_MAX_AGE_MS (see the constants above for why those numbers).
   *  Appended on EVERY broadcast — including when the channel has zero
   *  subscribers, because "zero subscribers" is precisely what a disconnect
   *  looks like from here, and the whole point is to hold those events for
   *  the reconnect. */
  private replay = new Map<string, BufferedEvent[]>();
  private lastSweepAt = 0;

  /**
   * channel → the wire id of the NEWEST event ever broadcast on it, as far as
   * this server knows: everything this process has sent, seeded at boot with
   * what the previous clean shutdown recorded (`sse-marks.ts`).
   *
   * Deliberately NOT pruned alongside the buffer, because it answers the
   * question the buffer cannot once its contents age out — "is this cursor at
   * the end of the channel, or behind it?". One string per channel, held for
   * the life of the process; the buffer is where the bytes are.
   *
   * This is the fix for a whole class of VACUOUS gap notices. `replayAfter`
   * used to have one way to say no, and used it for the case where the answer
   * is provably yes: a subscriber holding the last id a quiet channel ever
   * carried missed nothing, whether the buffer aged out under it or the server
   * restarted without that channel being touched. Field-measured 2026-08-21 as
   * waves of `replay.gap` across a session's whole watch set after every
   * deploy, each followed by a refetch that found nothing.
   */
  private lastEver = new Map<string, string>();

  /** `now` is injectable so the age-bound behaviour can be tested without
   *  sleeping ten minutes. Production passes nothing. */
  constructor(private now: () => number = Date.now) {}

  /**
   * Seed the channel marks from a previous process's clean shutdown.
   *
   * Only fills channels this process has not itself broadcast on — a live mark
   * is always newer than a recovered one, and letting a recovered id win would
   * move the channel's notion of "newest" backwards, which is the direction
   * that turns a real gap into silence.
   */
  restoreMarks(marks: Record<string, string>): void {
    for (const [channel, id] of Object.entries(marks)) {
      if (!this.lastEver.has(channel)) this.lastEver.set(channel, id);
    }
  }

  /** The channel marks, for the shutdown that hands them to the next boot. */
  marks(): Record<string, string> {
    return Object.fromEntries(this.lastEver);
  }

  add(docId: string, sink: Sink, shareId?: string, agentId?: string): () => void {
    let set = this.byDoc.get(docId);
    if (!set) {
      set = new Map();
      this.byDoc.set(docId, set);
    }
    set.set(sink, {
      ...(shareId !== undefined ? { shareId } : {}),
      ...(agentId !== undefined ? { agentId } : {}),
    });
    return () => this.remove(docId, sink);
  }

  remove(docId: string, sink: Sink): void {
    const set = this.byDoc.get(docId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.byDoc.delete(docId);
  }

  /**
   * `forSink` lets ONE broadcast say something extra to a specific
   * subscriber: called per sink with who opened it, its return replaces the
   * payload for that sink alone (undefined keeps the base payload). What
   * needs it is delivery bookkeeping — the comment queue stamps each
   * addressed agent's own row id onto ITS copy of the frame, so the receipt
   * can name exactly one row, while a browser tab (no agentId) gets the
   * plain event. It must not change the event name.
   *
   * The REPLAY buffer holds the base payload, never a per-sink one: a row id
   * belongs to the one live stream it was minted for, so replaying it to a
   * reconnecting subscriber would hand somebody else's receipt out. A
   * replayed comment frame therefore carries no row id and draws no ack —
   * the row simply stays queued and is re-offered after the grace window,
   * which is the durable path doing exactly its job.
   */
  broadcast(
    docId: string,
    payload: SsePayload,
    forSink?: (who: { shareId?: string; agentId?: string }) => SsePayload | undefined,
  ): void {
    // Reuse the broadcast's own `eid` (rooms.ts stamps one per fan-out, so
    // both channels of one broadcast carry the SAME wire id) and mint one for
    // the direct broadcasts that carry none (task/triage frames), keeping a
    // single monotonic id namespace per process. `newEventId`'s counter is
    // process-global, so per channel the ids are strictly increasing.
    const maybeEid = (payload as { eid?: unknown }).eid;
    const id = typeof maybeEid === 'string' && maybeEid.length > 0 ? maybeEid : newEventId();
    this.buffer(docId, id, payload);
    const set = this.byDoc.get(docId);
    if (!set) return;
    for (const [sink, who] of set) {
      try {
        const p = forSink?.(who) ?? payload;
        sink.write(p.event, p, id);
      } catch (err) {
        console.error('[sse] write failed:', err);
      }
    }
  }

  private buffer(docId: string, id: string, payload: SsePayload, toAgent?: string): void {
    let buf = this.replay.get(docId);
    if (!buf) {
      buf = [];
      this.replay.set(docId, buf);
    }
    buf.push({ id, at: this.now(), payload, ...(toAgent !== undefined ? { toAgent } : {}) });
    // Outside the buffer and outside its pruning: this is what lets a cursor
    // at the end of a quiet channel still be recognised as up to date.
    this.lastEver.set(docId, id);
    this.prune(docId);
    // Idle channels never get touched by their own appends, so a cheap
    // global sweep rides along at most once a minute — it is what keeps a
    // channel that went quiet from holding its last 200 events forever.
    const now = this.now();
    if (now - this.lastSweepAt > 60_000) {
      this.lastSweepAt = now;
      for (const key of this.replay.keys()) this.prune(key);
    }
  }

  private prune(docId: string): void {
    const buf = this.replay.get(docId);
    if (!buf) return;
    const cutoff = this.now() - REPLAY_MAX_AGE_MS;
    let drop = Math.max(0, buf.length - REPLAY_MAX_EVENTS);
    while (drop < buf.length && (buf[drop] as BufferedEvent).at < cutoff) drop += 1;
    if (drop > 0) buf.splice(0, drop);
    if (buf.length === 0) this.replay.delete(docId);
  }

  /**
   * The events after `lastId` on this channel — or an explicit refusal.
   *
   * `ok: false` covers every case where completeness cannot be PROVEN: the id
   * was evicted by the count bound, the id is from a previous server epoch
   * whose tail this server has no record of, the channel is one it has never
   * heard of. The caller turns that into a `replay.gap` event, because a
   * partial replay that looks complete is the exact failure this branch exists
   * to end — the client must be told to refetch instead.
   *
   * The one case that is NOT a gap despite missing the buffer: a cursor naming
   * the newest event a channel ever carried. Nothing came after it, so nothing
   * was missed — the buffer holding it merely aged out under a quiet channel,
   * or this process restarted and recovered the channel's mark without yet
   * broadcasting on it. That reading used to fall into `ok: false`, and it is
   * where the field's vacuous-gap waves came from: most of a watch set is
   * quiet most of the time, so most reconnects hit exactly this branch. Note
   * the narrowing is symmetric — an id that is not the newest is still a gap,
   * including the id one event behind it (`lastEver` moves the moment anything
   * is broadcast).
   *
   * `agentId` is the reconnecting stream's own identity (absent for browser
   * tabs and share visitors). It filters the tail to what THIS subscriber's
   * live feed would have carried: every broadcast, plus addressed frames
   * whose addressee it is. A frame addressed to someone else is invisible
   * here for the same reason it was invisible live — replay reproduces a
   * stream, not the channel's whole ledger. The presented `lastId` may
   * itself be an addressed frame's id (the recipient's cursor legitimately
   * advances on it); lookup runs over the full buffer so that anchors
   * cleanly.
   */
  replayAfter(
    docId: string,
    lastId: string,
    agentId?: string,
  ): { ok: true; events: BufferedEvent[] } | { ok: false } {
    this.prune(docId);
    const buf = this.replay.get(docId);
    if (buf) {
      const idx = buf.findIndex((e) => e.id === lastId);
      if (idx >= 0) {
        return {
          ok: true,
          events: buf
            .slice(idx + 1)
            .filter((e) => e.toAgent === undefined || e.toAgent === agentId),
        };
      }
    }
    // Not in the buffer. Nothing to replay is not the same as nothing
    // provable — see the doc comment: a cursor at the end of the channel is a
    // clean, empty catch-up rather than a gap.
    if (this.lastEver.get(docId) === lastId) return { ok: true, events: [] };
    return { ok: false };
  }

  /** Wire id of the newest buffered event on a channel, if any. */
  lastIdOn(docId: string): string | undefined {
    const buf = this.replay.get(docId);
    return buf?.[buf.length - 1]?.id;
  }

  /** The buffered events on a channel (oldest first). Test surface. */
  eventsOn(docId: string): readonly BufferedEvent[] {
    return this.replay.get(docId) ?? [];
  }

  count(docId: string): number {
    return this.byDoc.get(docId)?.size ?? 0;
  }

  /**
   * Which agents are holding a stream open on this channel right now.
   *
   * Distinct from `count` in the way that matters: this is an identity, so a
   * caller can ask about the agent it actually means to reach. Anonymous
   * streams — every browser tab — contribute nothing.
   */
  agentsOn(docId: string): Set<string> {
    const out = new Set<string>();
    for (const who of this.byDoc.get(docId)?.values() ?? []) {
      if (who.agentId) out.add(who.agentId);
    }
    return out;
  }

  /**
   * Write to the streams ONE named agent is holding on this channel.
   *
   * The counterpart to `broadcast`, and the difference is who pays for an
   * addressed message. A lead-addressed request went out on the workspace
   * channel with the addressing done at the RECEIVER, in prose — "Act only if
   * that is you". That is a guard an agent can obey by reading a sentence and
   * a browser tab cannot obey at all, so Bryan renamed one of his own rows and
   * the board turned around and asked him to review his own edit (2026-08-21).
   * It also billed every other attached agent a full turn to read the message
   * and conclude it was not theirs — a cost that scales with how many peers
   * joined the board rather than with how much work there is.
   *
   * A tab contributes no `agentId` and a share visitor is refused one, so
   * addressing here excludes every browser by construction rather than by a
   * rule somebody has to keep applying.
   *
   * Returns how many sinks it reached — 0 means the agent is not holding a
   * stream, which is a real answer the caller must handle (the request queues
   * for their next attach) and NOT the same as "delivered".
   *
   * Addressed frames are BUFFERED like broadcasts — same id namespace, tagged
   * with the addressee so `replayAfter` shows them only to that agent's own
   * reconnect. Without this the replay machinery was blind to exactly the
   * frames with one accountable recipient: a socket that died without the
   * server noticing yet doesn't throw on `enqueue`, so `sent > 0` reported a
   * delivery that landed nowhere, the caller marked the request delivered
   * (not queued for next attach), and the lead's 1.5s reconnect came back
   * clean — no frame, no gap, a healthy-looking stream missing the one
   * message addressing exists to guarantee. Buffered even at `sent = 0`,
   * for the same reason `broadcast` buffers at zero subscribers; the callers'
   * durable next-attach queue can overlap with a replay, and that duplicate
   * is the accepted cost — a repeat ask is annoying, a silent loss is the
   * failure this file exists to end.
   */
  sendToAgent(docId: string, agentId: string, payload: SsePayload): number {
    const maybeEid = (payload as { eid?: unknown }).eid;
    const id = typeof maybeEid === 'string' && maybeEid.length > 0 ? maybeEid : newEventId();
    this.buffer(docId, id, payload, agentId);
    const set = this.byDoc.get(docId);
    if (!set) return 0;
    let sent = 0;
    for (const [sink, who] of set) {
      if (who.agentId !== agentId) continue;
      try {
        sink.write(payload.event, payload, id);
        sent += 1;
      } catch (err) {
        console.error('[sse] addressed write failed:', err);
      }
    }
    return sent;
  }

  /** Close every stream a given share opened. Returns how many. */
  closeForShare(shareId: string): number {
    let closed = 0;
    for (const [docId, set] of this.byDoc) {
      for (const [sink, who] of set) {
        if (who.shareId !== shareId) continue;
        try {
          sink.close();
        } catch {
          // Already gone; the remove below is the bookkeeping either way.
        }
        this.remove(docId, sink);
        closed += 1;
      }
    }
    return closed;
  }

  /** Close streams whose authorizing share is no longer live (revoked or
   *  expired). Returns the shareIds swept. */
  closeForDeadShares(isLive: (shareId: string) => boolean): string[] {
    const dead = new Set<string>();
    for (const set of this.byDoc.values()) {
      for (const who of set.values()) {
        if (who.shareId && !isLive(who.shareId)) dead.add(who.shareId);
      }
    }
    for (const id of dead) this.closeForShare(id);
    return Array.from(dead);
  }
}

/** Produce a ReadableStream that emits SSE lines, and register with the hub.
 *  `shareId` tags the stream with the share that authorized it so revocation
 *  and expiry can hang it up. `transform` rewrites each payload before it is
 *  serialized — how a share visitor's stream gets the redacted view of an
 *  event every other subscriber receives raw. It must not change the event
 *  name.
 *
 *  `lastEventId` is the id the reconnecting client last saw (the
 *  `Last-Event-ID` header a native EventSource sends by itself, or the
 *  `lastEventId` query param for hand-rolled consumers). When the buffer can
 *  prove completeness the missed events are written first, in order, each
 *  with its id — and only then does the live feed continue. When it cannot
 *  (evicted, previous epoch, unknown), the stream opens with a single
 *  `replay.gap` event instead: an explicit "refetch your state", never a
 *  partial replay wearing a whole one's face. Replayed payloads go through
 *  `transform` exactly like live ones, so a share visitor's catch-up is as
 *  redacted as their live view. */
export function openSseStream(
  hub: SseHub,
  docId: string,
  shareId?: string,
  transform?: (payload: SsePayload & Record<string, unknown>) => SsePayload,
  agentId?: string,
  lastEventId?: string,
): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  let remove: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      const sink = {
        write: (event: string, data: unknown, id?: string) => {
          if (!controller) return;
          const payload = transform
            ? transform(data as SsePayload & Record<string, unknown>)
            : data;
          const idLine = id ? `id: ${id}\n` : '';
          const body = `${idLine}event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
          controller.enqueue(encoder.encode(body));
        },
        close: () => {
          try {
            controller?.close();
          } catch {}
        },
      };
      // initial comment so proxies flush headers
      c.enqueue(encoder.encode(':ok\n\n'));
      remove = hub.add(docId, sink, shareId, agentId);
      // Catch-up, BETWEEN registration and the first live write. Everything
      // in start() runs synchronously on one event loop, so no broadcast can
      // land between `hub.add` above and this replay — the replayed tail and
      // the live feed meet with neither a hole nor a duplicate.
      if (lastEventId) {
        // The stream's own agentId scopes the replay: an agent's catch-up
        // includes the frames addressed to it, everyone else's excludes them
        // — the same visibility the live feed enforces.
        const replay = hub.replayAfter(docId, lastEventId, agentId);
        if (replay.ok) {
          for (const e of replay.events) sink.write(e.payload.event, e.payload, e.id);
        } else {
          // No id: deliberately — this frame is synthetic per-connection, and
          // an id here could be presented back and mistaken for coverage.
          sink.write('replay.gap', {
            event: 'replay.gap',
            docId,
            lastEventId,
            action: 'refetch',
            reason:
              'last-event-id is older than the replay buffer (or from a previous server epoch); events may have been missed — refetch state instead of trusting the stream',
          });
        }
      }
      // periodic keepalive
      const keepalive = setInterval(() => {
        try {
          c.enqueue(encoder.encode(':ka\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, SSE_KEEPALIVE_MS);
      // attach cleanup on cancel
      (c as unknown as { _keepalive?: ReturnType<typeof setInterval> })._keepalive = keepalive;
    },
    cancel() {
      remove?.();
      const ka = (this as unknown as { _keepalive?: ReturnType<typeof setInterval> })._keepalive;
      if (ka) clearInterval(ka);
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
