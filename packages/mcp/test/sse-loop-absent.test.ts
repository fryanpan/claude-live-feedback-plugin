/**
 * What a watcher does when the server keeps saying the key is not there —
 * the half of the 2026-09-04 outage that was still leaking after the socket
 * count came down.
 *
 * A peer measured `net.inet.tcp.pcbcount` climbing about 2,000 an hour for 79
 * hours, 1,233 to 162,169, while enumerable sockets never passed 700, until
 * `socket()` failed for every process on the box. Nothing was holding a
 * visible socket: the loop was throwing past a non-ok response whose body it
 * never read or cancelled, once every 1.5 seconds, for the life of the
 * process. An un-released body is a protocol control block the platform
 * cannot reclaim, and 1.5s forever is exactly 2,400 an hour.
 *
 * So three properties, each of which was false before:
 *
 *  - **Every non-ok response has its body released before the throw.**
 *  - **The reader goes back on every exit of the read loop** — done, throw or
 *    abort — because a held lock is the same leak from the other side.
 *  - **An absent key is not redialled forever.** It backs off through a
 *    growing, fully jittered window with a much longer ceiling than a
 *    transient failure gets, and after five consecutive absent answers the
 *    loop stops and leaves a reason a tool can show.
 *
 * Everything is injected: no socket, no real clock, no sampled randomness.
 */
import { describe, expect, it } from 'vitest';
import { RECONNECT_CAP_MS } from '../src/backoff.ts';
import {
  ABSENT_DROP_AFTER,
  ABSENT_RETRY_CAP_MS,
  type Watcher,
  createSseLoops,
  inactiveWatches,
} from '../src/sse-loop.ts';

const LABEL = 'doc-gone';
const PATH = '/events/doc-gone';

/** A response whose body records the moment it is cancelled. */
function bodied(status: number, text = ''): { res: Response; cancelled: () => boolean } {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      if (text) c.enqueue(new TextEncoder().encode(text));
    },
    cancel() {
      cancelled = true;
    },
  });
  return { res: new Response(stream, { status }), cancelled: () => cancelled };
}

/** A 200 whose body ends cleanly after `text`. */
function closing(text: string): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(stream, { status: 200 });
}

/** A 200 whose body errors mid-read. */
function erroring(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.error(new Error('connection reset'));
    },
  });
  return new Response(stream, { status: 200 });
}

function harness(script: Array<() => Response>, onFrame?: (raw: string) => void) {
  const controller = new AbortController();
  const watcher: Watcher = { controller, docId: LABEL, open: false };
  const watchers = new Map<string, Watcher>([[LABEL, watcher]]);
  const sleeps: number[] = [];
  const logged: string[] = [];
  let calls = 0;
  const loops = createSseLoops({
    watchers,
    resolveBaseUrl: () => 'http://stub',
    fetch: async () => {
      const step = script[calls++];
      if (!step) {
        controller.abort();
        throw new Error('script exhausted');
      }
      return step();
    },
    handleFrame: async (raw) => {
      onFrame?.(raw);
    },
    resetDedup: () => {},
    log: (...a) => logged.push(a.map(String).join(' ')),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    // Full jitter with a pinned draw: every window's midpoint, so a delay
    // names its window and nothing here is flaky.
    random: () => 0.5,
    timers: { set: () => 0, clear: () => {} },
  });
  return {
    loops,
    controller,
    watcher,
    sleeps,
    logged,
    calls: () => calls,
  };
}

describe('a key the server says is gone', () => {
  it('cancels the body on EVERY attempt and stops after five in a row', async () => {
    const bodies = Array.from({ length: 10 }, () => bodied(404));
    const h = harness(bodies.map((b) => () => b.res));

    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);

    // Five attempts, then the loop returned — not a sixth, and not the
    // forever-at-1.5s that took the machine out.
    expect(h.calls()).toBe(ABSENT_DROP_AFTER);
    expect(bodies.slice(0, ABSENT_DROP_AFTER).every((b) => b.cancelled())).toBe(true);
    // Four waits, not five: the fifth answer drops the key instead.
    expect(h.sleeps).toHaveLength(ABSENT_DROP_AFTER - 1);
  });

  it('backs off through a growing window rather than redialling at a fixed 1.5s', async () => {
    const h = harness(Array.from({ length: 10 }, () => () => bodied(404).res));
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    // Halves of 1500, 3000, 6000, 12000 — the pinned draw through the growing
    // window. A constant is what made one restart into twenty, and what made
    // one deleted doc into 162,000 control blocks.
    expect(h.sleeps).toEqual([750, 1500, 3000, 6000]);
  });

  it('leaves the watcher closed, with a reason a tool can show', async () => {
    const h = harness(Array.from({ length: 10 }, () => () => bodied(410).res));
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.watcher.open).toBe(false);
    expect(h.watcher.inactiveReason).toContain('410');
    // Said once, not once per attempt.
    const drops = h.logged.filter((l) => l.includes('stopped watching'));
    expect(drops).toHaveLength(1);
  });

  it('treats 403 the same way, and a 500 not at all', async () => {
    const forbidden = harness(Array.from({ length: 10 }, () => () => bodied(403).res));
    await forbidden.loops.runSseLoop(LABEL, PATH, forbidden.controller.signal);
    expect(forbidden.calls()).toBe(ABSENT_DROP_AFTER);

    // A 5xx is the server having a bad minute, not the key being gone: the
    // loop keeps trying until the script runs out and aborts it.
    const flaky = harness(Array.from({ length: 8 }, () => () => bodied(503).res));
    await flaky.loops.runSseLoop(LABEL, PATH, flaky.controller.signal);
    expect(flaky.calls()).toBeGreaterThan(ABSENT_DROP_AFTER);
    expect(flaky.watcher.inactiveReason).toBeUndefined();
  });

  it('one success clears the count, so an intermittent 404 never drops the key', async () => {
    const script: Array<() => Response> = [
      () => bodied(404).res,
      () => bodied(404).res,
      () => bodied(404).res,
      () => bodied(404).res,
      () => closing('event: ping\ndata: {}\n\n'),
      () => bodied(404).res,
      () => bodied(404).res,
    ];
    const h = harness(script);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    // Ran past the script — never dropped.
    expect(h.calls()).toBeGreaterThan(script.length);
    expect(h.watcher.inactiveReason).toBeUndefined();
  });
});

describe('the absent backoff has its own, longer ceiling', () => {
  it('is at least a minute, and longer than the transient one', () => {
    expect(ABSENT_RETRY_CAP_MS).toBeGreaterThanOrEqual(60_000);
    expect(ABSENT_RETRY_CAP_MS).toBeGreaterThan(RECONNECT_CAP_MS);
  });

  it('is the ceiling the loop actually applies when a server flaps', async () => {
    // 404, 404, 500, repeating: the absent run never reaches five, so the key
    // is never dropped and the attempt count climbs past both caps. The
    // absent waits then rise above the transient ceiling, which they cannot
    // do unless the longer cap is genuinely wired in.
    const pattern = [404, 404, 500];
    const h = harness(
      Array.from({ length: 9 }, (_, i) => () => bodied(pattern[i % 3] as number).res),
    );
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);

    // Attempt 6 is a transient failure: half of a window clamped to 30s.
    expect(h.sleeps[5]).toBe(RECONNECT_CAP_MS / 2);
    // Attempts 7 and 8 are absent ones, and their window is clamped to 60s —
    // under the transient cap they would have been 15,000 as well.
    expect(h.sleeps[6]).toBe(ABSENT_RETRY_CAP_MS / 2);
    expect(h.sleeps[7]).toBe(ABSENT_RETRY_CAP_MS / 2);
    expect(h.sleeps[6]).toBeGreaterThan(RECONNECT_CAP_MS / 2);
  });
});

describe('the reader goes back on every exit', () => {
  it('unlocks the body when the stream ends cleanly', async () => {
    const res = closing('event: ping\ndata: {}\n\n');
    const h = harness([() => res]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    // A lock left held is a connection the platform cannot reclaim — the same
    // leak the non-ok branch fixes, arrived at from the reading side.
    expect(res.body?.locked).toBe(false);
  });

  it('unlocks the body when the stream errors mid-read', async () => {
    const res = erroring();
    const h = harness([() => res]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(res.body?.locked).toBe(false);
  });

  it('unlocks the body when the watcher is aborted mid-stream', async () => {
    // A body that never ends, aborted from inside the frame handler — the
    // shape a live `unwatch_doc` has. Aborting before the first fetch instead
    // would prove nothing: the loop would never open a body to leave locked.
    let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        c.enqueue(new TextEncoder().encode('event: ping\ndata: {}\n\n'));
      },
    });
    const res = new Response(stream, { status: 200 });
    const aborters: Array<() => void> = [];
    const h = harness([() => res], () => {
      for (const abort of aborters) abort();
    });
    aborters.push(() => h.controller.abort());
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    // The connection was genuinely opened and read before the abort.
    expect(h.calls()).toBe(1);
    expect(res.body?.locked).toBe(false);
    expect(ctl).not.toBeNull();
  });
});

describe('inactiveWatches — what list_watched_docs reports', () => {
  const rec = (docId: string, over: Partial<Watcher> = {}): Watcher => ({
    controller: new AbortController(),
    docId,
    open: false,
    ...over,
  });

  it('names only the watches that stopped trying, with their reason', () => {
    const watchers = new Map<string, Watcher>([
      ['live', rec('live', { open: true })],
      // Closed but still retrying: not inactive, and reporting it as such
      // would turn every blip into a false "gave up".
      ['blipping', rec('blipping')],
      ['gone', rec('gone', { inactiveReason: 'server answered 404 5 times running' })],
    ]);
    expect(inactiveWatches(watchers)).toEqual([
      { key: 'gone', reason: 'server answered 404 5 times running' },
    ]);
  });

  it('is empty when every watch is still being retried', () => {
    const watchers = new Map<string, Watcher>([
      ['a', rec('a')],
      ['b', rec('b', { open: true })],
    ]);
    expect(inactiveWatches(watchers)).toEqual([]);
  });

  it('reports the reason a dropped key actually leaves behind', async () => {
    // Driven through the loop rather than hand-set, so the string the tool
    // shows is the string the loop writes.
    const h = harness(Array.from({ length: 8 }, () => () => bodied(404).res));
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    const reported = inactiveWatches(new Map([[LABEL, h.watcher]]));
    expect(reported).toHaveLength(1);
    expect(reported[0]?.reason).toBe(h.watcher.inactiveReason);
  });
});
