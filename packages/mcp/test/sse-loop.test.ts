/**
 * The reconnecting SSE loop, driven without a socket.
 *
 * Three things in here have each been a bug and none of them could be
 * asserted while the loop sat in `mcp.ts`, a file that starts an MCP server on
 * import: the `open` flag that tells a live subscription from a registered
 * intention, the `Last-Event-ID` the loop presents so a fast reconnect does
 * not resume with a hole, and the dedup window it drops on every reconnect
 * because a restarted server counts every room's `seq` from zero again.
 *
 * `createSseLoops` takes `fetch`, the frame handler, the dedup reset, the
 * backoff and the connect cap's timers as arguments, so every one of those is
 * a fake here. No socket, no real clock, no fixed sleep.
 */
import { describe, expect, it } from 'vitest';
import { type Watcher, createSseLoops } from '../src/sse-loop.ts';

const LABEL = 'doc-1';
const PATH = '/events/doc-1';

/** One 200 response whose body is `text`, as an SSE stream. */
function sse(text: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(stream, { status });
}

type Attempt = { url: string; init: RequestInit | undefined };

/**
 * Drives the loop against a scripted list of responses. When the script runs
 * out the abort signal fires, which is how the loop is asked to stop.
 */
function harness(
  script: Array<() => Response | Promise<Response>>,
  opts: { sleep?: (abort: () => void) => Promise<void>; log?: (...a: unknown[]) => void } = {},
) {
  const controller = new AbortController();
  const watcher: Watcher = { controller, docId: LABEL, open: false };
  const watchers = new Map<string, Watcher>([[LABEL, watcher]]);
  const attempts: Attempt[] = [];
  const delivered: string[] = [];
  let resets = 0;
  let next = 0;
  const abort = () => controller.abort();
  const loops = createSseLoops({
    watchers,
    resolveBaseUrl: () => 'http://stub',
    fetch: async (url, init) => {
      attempts.push({ url, init });
      const step = script[next++];
      if (!step) {
        abort();
        throw new Error('script exhausted');
      }
      return step();
    },
    handleFrame: async (raw) => {
      delivered.push(raw);
    },
    resetDedup: () => {
      resets += 1;
    },
    log: opts.log ?? (() => {}),
    sleep: opts.sleep
      ? () => (opts.sleep as (a: () => void) => Promise<void>)(abort)
      : async () => {},
    timers: { set: () => 0, clear: () => {} },
  });
  return {
    loops,
    controller,
    watcher,
    watchers,
    attempts,
    delivered,
    resets: () => resets,
  };
}

describe('a connected stream delivers its frames and reports itself open', () => {
  it('hands each complete frame to the handler and reports the connect open', async () => {
    const h = harness([
      () => sse('event: thread.replied\ndata: {"docId":"d"}\n\nevent: x\ndata: 1\n\n'),
    ]);
    const outcomes: boolean[] = [];
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal, (open) => outcomes.push(open));
    expect(h.delivered).toEqual([
      'event: thread.replied\ndata: {"docId":"d"}',
      'event: x\ndata: 1',
    ]);
    expect(outcomes).toEqual([true]);
    expect(h.attempts[0]?.url).toBe('http://stub/events/doc-1');
  });

  it('leaves a partial frame in the buffer until its blank line arrives', async () => {
    const h = harness([
      () => {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            const enc = new TextEncoder();
            c.enqueue(enc.encode('event: thread.replied\nda'));
            c.enqueue(enc.encode('ta: {"docId":"d"}\n\n'));
            c.close();
          },
        });
        return new Response(stream, { status: 200 });
      },
    ]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.delivered).toEqual(['event: thread.replied\ndata: {"docId":"d"}']);
  });

  it('clears the open flag when the stream ends', async () => {
    const h = harness([() => sse('')]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.watcher.open).toBe(false);
  });
});

describe('a refused connect is reported as not open, not merely as registered', () => {
  it('answers the first-attempt callback with false on a non-200', async () => {
    const h = harness([() => sse('', 503)]);
    const outcomes: boolean[] = [];
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal, (open) => outcomes.push(open));
    expect(outcomes).toEqual([false]);
    expect(h.watcher.open).toBe(false);
    expect(h.delivered).toEqual([]);
  });

  it('answers false when the connect throws', async () => {
    const h = harness([
      () => {
        throw new Error('ECONNREFUSED');
      },
    ]);
    const outcomes: boolean[] = [];
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal, (open) => outcomes.push(open));
    expect(outcomes).toEqual([false]);
  });

  it('settles the first-attempt callback exactly once across reconnects', async () => {
    const h = harness([() => sse('', 503), () => sse('')]);
    const outcomes: boolean[] = [];
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal, (open) => outcomes.push(open));
    expect(outcomes).toEqual([false]);
    expect(h.attempts).toHaveLength(3);
  });
});

describe('a reconnect resumes where the last DELIVERED frame left off', () => {
  it('presents the id of the last delivered frame', async () => {
    const h = harness([() => sse('id: 7\nevent: thread.replied\ndata: {}\n\n')]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.attempts[0]?.init?.headers).toBeUndefined();
    expect(h.attempts[1]?.init?.headers).toEqual({ 'Last-Event-ID': '7' });
  });

  it('presents nothing when a frame carried no id', async () => {
    const h = harness([() => sse('event: thread.replied\ndata: {}\n\n')]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.attempts[1]?.init?.headers).toBeUndefined();
  });

  it('drops the held id after a replay gap — the server cannot replay from it', async () => {
    const h = harness([
      () => sse('id: 7\nevent: thread.replied\ndata: {}\n\nid: 8\nevent: replay.gap\ndata: {}\n\n'),
    ]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.attempts[1]?.init?.headers).toBeUndefined();
  });
});

describe('the dedup window is dropped whenever a restart could have reset seq', () => {
  it('resets on every reconnect', async () => {
    const h = harness([() => sse(''), () => sse('')]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    // Two scripted connects plus the exhausting third, each followed by a
    // reset before the loop goes round again.
    expect(h.resets()).toBe(2);
  });

  it('resets on a delivered replay gap, before any reconnect', async () => {
    const h = harness([() => sse('event: replay.gap\ndata: {}\n\n')]);
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    // One from the gap, one from the reconnect after the stream ended.
    expect(h.resets()).toBe(2);
  });
});

describe('an aborted watcher stops the loop', () => {
  it('makes no request at all when the signal is already aborted', async () => {
    const h = harness([() => sse('')]);
    h.controller.abort();
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.attempts).toEqual([]);
    expect(h.watcher.open).toBe(false);
  });

  it('stops in the backoff without reconnecting', async () => {
    const h = harness([() => sse('')], { sleep: async (abort) => abort() });
    await h.loops.runSseLoop(LABEL, PATH, h.controller.signal);
    expect(h.attempts).toHaveLength(1);
  });
});

describe('startSseLoop answers whether the stream is actually open', () => {
  it('resolves true once the first connect succeeds', async () => {
    const h = harness([() => sse('')], { sleep: async (abort) => abort() });
    await expect(h.loops.startSseLoop(LABEL, PATH, h.controller)).resolves.toBe(true);
  });

  it('resolves false on a refused connect', async () => {
    const h = harness([() => sse('', 500)], { sleep: async (abort) => abort() });
    await expect(h.loops.startSseLoop(LABEL, PATH, h.controller)).resolves.toBe(false);
  });

  it('resolves false when the cap expires with the connect still in flight', async () => {
    const controller = new AbortController();
    const watchers = new Map<string, Watcher>([[LABEL, { controller, docId: LABEL, open: false }]]);
    let expire: (() => void) | undefined;
    let cleared = 0;
    const loops = createSseLoops({
      watchers,
      resolveBaseUrl: () => 'http://stub',
      // Never settles: the wedged connect the cap exists for.
      fetch: () => new Promise<Response>(() => {}),
      handleFrame: async () => {},
      resetDedup: () => {},
      log: () => {},
      sleep: async () => {},
      timers: {
        set: (fn) => {
          expire = fn;
          return 1;
        },
        clear: () => {
          cleared += 1;
        },
      },
    });
    const answer = loops.startSseLoop(LABEL, PATH, controller);
    expect(expire).toBeTypeOf('function');
    (expire as () => void)();
    await expect(answer).resolves.toBe(false);
    expect(cleared).toBe(0);
  });

  it('forgets a watcher whose loop crashed outright', async () => {
    // A throw from outside the connect's own try/catch — the class of failure
    // that would otherwise leave a dead key in the registry answering
    // `subscribed: true` forever.
    const h = harness([() => sse('', 500)], {
      sleep: async () => {
        throw new Error('backoff exploded');
      },
    });
    await expect(h.loops.startSseLoop(LABEL, PATH, h.controller)).resolves.toBe(false);
    // The crash handler runs after the answer has already settled, so yield
    // until the map reflects it rather than guessing a delay.
    for (let i = 0; i < 100 && h.watchers.has(LABEL); i++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(h.watchers.has(LABEL)).toBe(false);
  });
});
