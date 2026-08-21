/**
 * Anything broadcast over SSE: thread/suggestion webhook payloads and the
 * hub task events. The hub only needs the event name here — the whole
 * object is serialized as the data line either way.
 */
type SsePayload = { event: string };

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
  write: (event: string, data: unknown) => void;
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
   */
  broadcast(
    docId: string,
    payload: SsePayload,
    forSink?: (who: { shareId?: string; agentId?: string }) => SsePayload | undefined,
  ): void {
    const set = this.byDoc.get(docId);
    if (!set) return;
    for (const [sink, who] of set) {
      try {
        const p = forSink?.(who) ?? payload;
        sink.write(p.event, p);
      } catch (err) {
        console.error('[sse] write failed:', err);
      }
    }
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
   */
  sendToAgent(docId: string, agentId: string, payload: SsePayload): number {
    const set = this.byDoc.get(docId);
    if (!set) return 0;
    let sent = 0;
    for (const [sink, who] of set) {
      if (who.agentId !== agentId) continue;
      try {
        sink.write(payload.event, payload);
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
 *  name. */
export function openSseStream(
  hub: SseHub,
  docId: string,
  shareId?: string,
  transform?: (payload: SsePayload & Record<string, unknown>) => SsePayload,
  agentId?: string,
): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  let remove: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      const sink = {
        write: (event: string, data: unknown) => {
          if (!controller) return;
          const payload = transform
            ? transform(data as SsePayload & Record<string, unknown>)
            : data;
          const body = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
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
