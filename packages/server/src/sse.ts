/**
 * Anything broadcast over SSE: thread/suggestion webhook payloads and the
 * hub task events. The hub only needs the event name here — the whole
 * object is serialized as the data line either way.
 */
type SsePayload = { event: string };

type Sink = {
  write: (event: string, data: unknown) => void;
  close: () => void;
};

export class SseHub {
  /**
   * docId → (sink → the share that authorized it, if any).
   *
   * The shareId is what makes revocation reach this layer. An SSE stream has
   * the same shape of problem as a websocket — authorized once at open, then
   * long-lived — so pulling a visitor's access has to hang up their stream as
   * well, or they keep receiving every new comment on a review they can no
   * longer load. Owner streams carry no shareId and are never swept.
   */
  private byDoc = new Map<string, Map<Sink, string | undefined>>();

  add(docId: string, sink: Sink, shareId?: string): () => void {
    let set = this.byDoc.get(docId);
    if (!set) {
      set = new Map();
      this.byDoc.set(docId, set);
    }
    set.set(sink, shareId);
    return () => this.remove(docId, sink);
  }

  remove(docId: string, sink: Sink): void {
    const set = this.byDoc.get(docId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.byDoc.delete(docId);
  }

  broadcast(docId: string, payload: SsePayload): void {
    const set = this.byDoc.get(docId);
    if (!set) return;
    for (const sink of set.keys()) {
      try {
        sink.write(payload.event, payload);
      } catch (err) {
        console.error('[sse] write failed:', err);
      }
    }
  }

  count(docId: string): number {
    return this.byDoc.get(docId)?.size ?? 0;
  }

  /** Close every stream a given share opened. Returns how many. */
  closeForShare(shareId: string): number {
    let closed = 0;
    for (const [docId, set] of this.byDoc) {
      for (const [sink, id] of set) {
        if (id !== shareId) continue;
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
      for (const id of set.values()) {
        if (id && !isLive(id)) dead.add(id);
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
      remove = hub.add(docId, sink, shareId);
      // periodic keepalive
      const keepalive = setInterval(() => {
        try {
          c.enqueue(encoder.encode(':ka\n\n'));
        } catch {
          clearInterval(keepalive);
        }
      }, 20000);
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
