import type { WebhookPayload } from '@feedback/core';

type Sink = {
  write: (event: string, data: unknown) => void;
  close: () => void;
};

export class SseHub {
  private byDoc = new Map<string, Set<Sink>>();

  add(docId: string, sink: Sink): () => void {
    let set = this.byDoc.get(docId);
    if (!set) {
      set = new Set();
      this.byDoc.set(docId, set);
    }
    set.add(sink);
    return () => this.remove(docId, sink);
  }

  remove(docId: string, sink: Sink): void {
    const set = this.byDoc.get(docId);
    if (!set) return;
    set.delete(sink);
    if (set.size === 0) this.byDoc.delete(docId);
  }

  broadcast(docId: string, payload: WebhookPayload): void {
    const set = this.byDoc.get(docId);
    if (!set) return;
    for (const sink of set) {
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
}

/** Produce a ReadableStream that emits SSE lines, and register with the hub. */
export function openSseStream(hub: SseHub, docId: string): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const encoder = new TextEncoder();
  let remove: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      const sink = {
        write: (event: string, data: unknown) => {
          if (!controller) return;
          const body = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
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
      remove = hub.add(docId, sink);
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
