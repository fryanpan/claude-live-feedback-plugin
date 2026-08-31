/**
 * An SSE stream has to outlive the idle timeout that is watching it.
 *
 * Measured 2026-08-19 against this server on Bun 1.3.10: a plain
 * `curl -N` on `/events/workspace/<id>` ended after **9.7 seconds** having
 * received five bytes — the `:ok` preamble and nothing else. It was asked to
 * hold for forty.
 *
 * The cause was arithmetic, not logic. The keepalive comment existed and fired
 * on a 20s period; `Bun.serve` was configured with no `idleTimeout` at all, and
 * Bun's default is 10 seconds. The guard's period was longer than the timeout
 * it was guarding, so the connection always idled out first and the keepalive
 * never got to write anything.
 *
 * Why it stayed hidden, and why these tests are shaped the way they are:
 * `EventSource` reconnects silently, so six lossy windows a minute on every
 * open tab looked exactly like a healthy page. There is no `Last-Event-ID`
 * replay, so everything broadcast during those gaps was lost for good. A
 * regression here is invisible by construction — which is why the invariant is
 * asserted directly rather than only through behaviour.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type ServerHandle, createServer } from '../src/server.ts';
import { HTTP_IDLE_TIMEOUT_SEC, SSE_KEEPALIVE_MS } from '../src/sse.ts';

describe('the keepalive/idle-timeout invariant', () => {
  it('fires the keepalive well inside the idle timeout it guards', () => {
    // THE test. The shipped bug was 20_000 against a 10_000 default, and this
    // single comparison is the whole of it.
    expect(SSE_KEEPALIVE_MS).toBeLessThan(HTTP_IDLE_TIMEOUT_SEC * 1000);
    // With margin, so that ONE dropped or delayed keepalive is survivable
    // rather than fatal. A guard that only just fits is a guard that fails the
    // first time the event loop is busy.
    expect(SSE_KEEPALIVE_MS * 2).toBeLessThanOrEqual(HTTP_IDLE_TIMEOUT_SEC * 1000);
  });

  it('keeps the idle timeout inside the range Bun will accept', () => {
    // Bun caps `idleTimeout` at 255s and throws on a larger value — at boot,
    // which means a bad number here takes the whole server down rather than
    // degrading. Cheaper to fail in CI.
    expect(HTTP_IDLE_TIMEOUT_SEC).toBeGreaterThan(0);
    expect(HTTP_IDLE_TIMEOUT_SEC).toBeLessThanOrEqual(255);
  });
});

/**
 * The behavioural half. The invariant above is the one that would have caught
 * the bug; this one proves the invariant is actually wired to `Bun.serve`
 * rather than merely declared in a module nobody reads.
 */
describe('an idle SSE stream survives past the old death window', () => {
  let handle: ServerHandle | null = null;
  let dataDir = '';

  afterEach(async () => {
    await handle?.stop();
    handle = null;
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  /** Reads a stream in the background and records whether the server ended it. */
  function watch(res: Response) {
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const state = { closed: false, bytes: 0 };
    const pump = (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            state.closed = true;
            return;
          }
          state.bytes += value?.byteLength ?? 0;
        }
      } catch {
        // A torn-down stream is a close as far as the reader is concerned.
        state.closed = true;
      }
    })();
    return { state, pump, cancel: () => void reader.cancel().catch(() => {}) };
  }

  async function open() {
    dataDir = mkdtempSync(join(tmpdir(), 'sse-keepalive-'));
    handle = createServer({ dedicatedListener: true, port: 0, dataDir });
    const base = `http://localhost:${handle.port}`;
    const host = `localhost:${handle.port}`;
    const made = await fetch(`${base}/api/workspaces`, {
      method: 'POST',
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Idle Board' }),
    });
    const { workspace } = (await made.json()) as { workspace: { id: string } };
    const res = await fetch(`${base}/events/workspace/${workspace.id}`, {
      headers: { host, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(200);
    return watch(res);
  }

  it('is still open after 15s of silence — past the ~10s it used to die at', async () => {
    const w = await open();
    await new Promise((r) => setTimeout(r, 15_000));
    expect(w.state.closed).toBe(false);
    // It also actually received the preamble, so "not closed" is a live
    // stream rather than a response whose body never started.
    expect(w.state.bytes).toBeGreaterThan(0);
    w.cancel();
  }, 30_000);

  it('POSITIVE CONTROL: the same watcher does see an idle timeout kill a stream', async () => {
    // Without this, the assertion above passes just as happily against a
    // watcher that can never report a close — which is precisely the failure
    // mode this whole file exists to rule out.
    //
    // The control is a server configured the way the bug was: an idle
    // timeout shorter than anything that writes. So it proves the watcher
    // detects THE death under test, not merely some close. (`handle.stop()`
    // is no good here — Bun's graceful stop leaves live connections up, so
    // it reports nothing and would make this control a false negative.)
    const doomed = Bun.serve({
      port: 0,
      idleTimeout: 1,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode(':ok\n\n'));
              // …and then deliberately nothing, forever.
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    });
    try {
      const res = await fetch(`http://localhost:${doomed.port}/events`);
      const w = watch(res);
      await Promise.race([w.pump, new Promise((r) => setTimeout(r, 8_000))]);
      expect(w.state.closed).toBe(true);
    } finally {
      doomed.stop(true);
    }
  }, 20_000);
});
