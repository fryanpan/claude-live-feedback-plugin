import type { WebhookPayload } from '@feedback/core';

export interface WebhookDispatcher {
  send(url: string, payload: WebhookPayload): Promise<void>;
}

export interface WebhookLogEntry {
  ts: number;
  url: string;
  status: number;
  ok: boolean;
  event: string;
  docId: string;
  error?: string;
}

export interface WebhookDispatcherOptions {
  /** Injected fetch so tests can substitute their own. */
  fetchImpl?: typeof fetch;
  /** Maximum retries for 5xx responses. */
  retries?: number;
  /** Called with every attempted delivery (success or fail). */
  onLog?: (entry: WebhookLogEntry) => void;
  /** Timeout in ms for each attempt. */
  timeoutMs?: number;
}

export function createWebhookDispatcher(opts: WebhookDispatcherOptions = {}): WebhookDispatcher {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 5000;
  return {
    async send(url, payload) {
      let attempt = 0;
      while (attempt <= retries) {
        attempt++;
        const ac = new AbortController();
        const to = setTimeout(() => ac.abort(), timeoutMs);
        try {
          const res = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: ac.signal,
          });
          clearTimeout(to);
          opts.onLog?.({
            ts: Date.now(),
            url,
            status: res.status,
            ok: res.ok,
            event: payload.event,
            docId: payload.docId,
          });
          if (res.ok) return;
          if (res.status < 500) return; // don't retry 4xx
        } catch (err) {
          clearTimeout(to);
          opts.onLog?.({
            ts: Date.now(),
            url,
            status: 0,
            ok: false,
            event: payload.event,
            docId: payload.docId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
        if (attempt <= retries) {
          await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
        }
      }
    },
  };
}
