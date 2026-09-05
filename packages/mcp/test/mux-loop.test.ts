/**
 * The session's ONE event stream, driven without a socket.
 *
 * `sse-loop.test.ts` proves the per-key loop; this proves the thing that
 * replaced it. What has to hold, and why each one is here:
 *
 *  - **One connection, whatever the watch count.** The outage was 214 sockets
 *    from one session and 332 from the fleet, which exhausted the kernel's
 *    socket memory.
 *  - **A per-key cursor on reconnect.** N keys have N positions and a single
 *    id cannot carry them; the header the loop presents is the contract with
 *    `packages/server/src/sse-mux.ts`.
 *  - **Deliver, then commit — per key.** A frame whose delivery threw must be
 *    re-presented, so the cursor for ITS key stays put while the others move.
 *  - **A gap clears one key's position, not the whole cursor.** Otherwise one
 *    aged-out channel costs a session its place on every other one.
 *  - **A 404 is a rollout state, not a retry loop.** The plugin cache and the
 *    server deploy move independently.
 *
 * Every dependency is injected, so nothing here opens a socket, samples
 * `Math.random`, or waits on a real clock.
 */
import { describe, expect, it } from 'vitest';
import {
  MUX_CURSOR_MAX_KEYS,
  createMuxLoop,
  deliverThenCommitMux,
  frameWatchKey,
  muxPath,
} from '../src/mux-loop.ts';
import type { Watcher } from '../src/sse-loop.ts';

const AGENT = 'agent-mira';

/** One 200 response whose body is `text`, as an SSE stream that then ends. */
function sse(text: string, status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
  return new Response(stream, { status });
}

/** A connection that stays up until the test closes it — what a healthy
 *  stream looks like, as opposed to the scripted one-shot bodies above. */
function sseHeld(): { res: Response; close: () => void } {
  let ctl: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      ctl = c;
      c.enqueue(new TextEncoder().encode(':ok\n\n'));
    },
  });
  return {
    res: new Response(stream, { status: 200 }),
    close: () => {
      try {
        ctl?.close();
      } catch {
        // Already closed; the assertions do not depend on which side won.
      }
    },
  };
}

/** One multiplexed frame, as the server writes it. */
function frame(key: string, event: string, id?: string): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${event}\ndata: ${JSON.stringify({ event, watchKey: key })}\n\n`;
}

type Attempt = { url: string; headers: Record<string, string> | undefined };

function harness(
  script: Array<() => Response | Promise<Response>>,
  opts: {
    keys?: string[];
    handleFrame?: (raw: string) => Promise<void>;
    authHeaders?: () => Promise<Record<string, string>>;
  } = {},
) {
  const watchers = new Map<string, Watcher>();
  for (const key of opts.keys ?? ['doc-a']) {
    watchers.set(key, { controller: new AbortController(), docId: key, open: false });
  }
  const attempts: Attempt[] = [];
  const delivered: string[] = [];
  const logged: unknown[][] = [];
  const sleeps: number[] = [];
  let resets = 0;
  let next = 0;
  let forgotten = 0;
  let stopAfterScript: (() => void) | null = null;
  const loop = createMuxLoop({
    watchers,
    agentId: AGENT,
    resolveBaseUrl: () => 'http://stub',
    fetch: async (url, init) => {
      attempts.push({
        url,
        headers: init?.headers as Record<string, string> | undefined,
      });
      const step = script[next++];
      if (!step) {
        stopAfterScript?.();
        throw new Error('script exhausted');
      }
      return step();
    },
    handleFrame: async (raw) => {
      delivered.push(raw);
      await opts.handleFrame?.(raw);
    },
    resetDedup: () => {
      resets += 1;
    },
    log: (...args) => logged.push(args),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    // Full jitter with a pinned draw: every window's midpoint, so the delays
    // are readable and nothing samples a real random.
    random: () => 0.5,
    timers: { set: () => 0, clear: () => {} },
    ...(opts.authHeaders ? { authHeaders: opts.authHeaders } : {}),
    forgetToken: () => {
      forgotten += 1;
    },
  });
  stopAfterScript = () => loop.stop();
  return {
    loop,
    watchers,
    attempts,
    delivered,
    logged,
    sleeps,
    resets: () => resets,
    forgotten: () => forgotten,
  };
}

/** Let the loop's own awaits run. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('one loop carries every key', () => {
  it('opens exactly one connection however many watches exist', async () => {
    const h = harness([() => sse(':ok\n\n')], {
      keys: ['doc-a', 'doc-b', 'ws:w1', 'doc-c'],
    });
    await h.loop.ensureOpen();
    // Called once per watch, as the registry does.
    await h.loop.ensureOpen();
    await h.loop.ensureOpen();
    await h.loop.ensureOpen();
    expect(h.attempts).toHaveLength(1);
    expect(h.loop.loopCount()).toBe(1);
    expect(h.attempts[0]?.url).toBe(`http://stub${muxPath(AGENT)}`);
    h.loop.stop();
  });

  it('mirrors the one connection onto every watcher record', async () => {
    const held = sseHeld();
    const h = harness([() => held.res], { keys: ['doc-a', 'doc-b'] });
    await h.loop.ensureOpen();
    expect([...h.watchers.values()].map((w) => w.open)).toEqual([true, true]);
    h.loop.stop();
    // A stopped stream is not a subscription, and every record says so — a
    // record left reading `open: true` is a session claiming a subscription
    // it does not have, which is what the flag exists to prevent.
    expect([...h.watchers.values()].every((w) => w.open === false)).toBe(true);
    held.close();
  });

  it('reports a refused connect as not open rather than as a running loop', async () => {
    const h = harness([() => sse('', 500)]);
    await expect(h.loop.ensureOpen()).resolves.toBe(false);
    expect(h.watchers.get('doc-a')?.open).toBe(false);
    h.loop.stop();
  });

  it('percent-encodes an agent id that would otherwise break the path', () => {
    expect(muxPath('agent/one two')).toBe('/events/agent/agent%2Fone%20two');
  });
});

describe('the reconnect presents a per-key cursor', () => {
  it('sends no cursor on a first connect and the delivered positions after a drop', async () => {
    const h = harness([
      () => sse(`${frame('doc-a', 'thread.created', 'boot1:4')}${frame('doc-b', 'x', 'boot1:5')}`),
      () => sse(':ok\n\n'),
    ]);
    await h.loop.ensureOpen();
    await settle();
    await settle();

    // Named rather than asserting the whole header bag is absent: the
    // connect now always carries one (the agent bearer rides in it), and
    // what this case is about is that a FRESH subscription asks for no
    // replay.
    expect(h.attempts[0]?.headers?.['Last-Event-ID']).toBeUndefined();
    // Most-recently-advanced first, so a budget cut drops the quiet key.
    expect(h.attempts[1]?.headers?.['Last-Event-ID']).toBe('mux1:doc-b=boot1:5,doc-a=boot1:4');
    h.loop.stop();
  });

  it('backs off with growing jitter and drops the dedup window on reconnect', async () => {
    const h = harness([() => sse(':ok\n\n'), () => sse(':ok\n\n'), () => sse(':ok\n\n')]);
    await h.loop.ensureOpen();
    await settle();
    await settle();
    await settle();
    // Half of 1500, then half of 3000 — the pinned draw through the growing
    // window. A constant 1500 is what made one restart into twenty.
    expect(h.sleeps.slice(0, 2)).toEqual([750, 1500]);
    expect(h.resets()).toBeGreaterThan(0);
    h.loop.stop();
  });
});

describe('no response body is left un-released', () => {
  /** A response whose body records the moment it is cancelled. */
  function bodied(status: number): { res: Response; cancelled: () => boolean } {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {},
      cancel() {
        cancelled = true;
      },
    });
    return { res: new Response(stream, { status }), cancelled: () => cancelled };
  }

  it('cancels the body of a non-ok response before throwing', async () => {
    // An un-consumed, un-cancelled body is a protocol control block the
    // platform cannot reclaim. A retrying loop that skips this leaks one per
    // attempt; see sse-loop.ts for the 162,000 that measured.
    const b = bodied(500);
    const h = harness([() => b.res]);
    await expect(h.loop.ensureOpen()).resolves.toBe(false);
    expect(b.cancelled()).toBe(true);
    h.loop.stop();
  });

  it('cancels the body of the 404 that ends the loop', async () => {
    const b = bodied(404);
    const h = harness([() => b.res]);
    await expect(h.loop.ensureOpen()).resolves.toBe(false);
    expect(h.loop.unsupported()).toBe(true);
    expect(b.cancelled()).toBe(true);
  });

  it('gives the reader back when a live stream ends', async () => {
    const held = sseHeld();
    const h = harness([() => held.res]);
    await h.loop.ensureOpen();
    held.close();
    await settle();
    await settle();
    // A lock left held is the same leak reached from the reading side.
    expect(held.res.body?.locked).toBe(false);
    h.loop.stop();
  });
});

describe('a server that predates the route is a rollout state, not a retry loop', () => {
  it('stops on a 404, says so once, and reports itself unsupported', async () => {
    const h = harness([() => new Response('not found', { status: 404 })]);
    await expect(h.loop.ensureOpen()).resolves.toBe(false);
    expect(h.loop.unsupported()).toBe(true);
    expect(h.loop.loopCount()).toBe(0);
    // One attempt, not a loop against a route that will never exist.
    expect(h.attempts).toHaveLength(1);
    expect(JSON.stringify(h.logged)).toContain('one stream per watch');
    // And it stays refused, so the registry's fallback is permanent for this
    // process rather than re-decided per watch.
    await expect(h.loop.ensureOpen()).resolves.toBe(false);
    expect(h.attempts).toHaveLength(1);
  });
});

describe('frameWatchKey reads the tag the server stamped', () => {
  it('finds the key on a tagged frame', () => {
    expect(frameWatchKey(frame('ws:w1', 'task.updated', 'boot1:2'))).toBe('ws:w1');
  });

  it('answers undefined for an untagged or unparsable frame', () => {
    expect(frameWatchKey('event: ping\ndata: {"event":"ping"}')).toBeUndefined();
    expect(frameWatchKey('event: ping\ndata: not json')).toBeUndefined();
    expect(frameWatchKey(':ka')).toBeUndefined();
  });
});

describe('deliver, then commit — per key', () => {
  it('advances only the key the frame arrived on', async () => {
    const cursors = new Map([['doc-b', 'boot1:1']]);
    await deliverThenCommitMux(
      frame('doc-a', 'thread.created', 'boot1:9'),
      async () => {},
      cursors,
      () => {},
    );
    expect([...cursors]).toEqual([
      ['doc-b', 'boot1:1'],
      ['doc-a', 'boot1:9'],
    ]);
  });

  it('leaves the cursor untouched when delivery throws, so the frame is replayed', async () => {
    const cursors = new Map([['doc-a', 'boot1:3']]);
    await expect(
      deliverThenCommitMux(
        frame('doc-a', 'thread.created', 'boot1:4'),
        async () => {
          throw new Error('EPIPE writing the notification');
        },
        cursors,
        () => {},
      ),
    ).rejects.toThrow('EPIPE');
    // Still at 3: the reconnect re-presents it and the server replays the
    // frame whose delivery failed, rather than skipping past it.
    expect(cursors.get('doc-a')).toBe('boot1:3');
  });

  it('a gap clears ONE key and leaves every other position standing', async () => {
    const cursors = new Map([
      ['doc-a', 'boot1:3'],
      ['doc-b', 'boot1:7'],
    ]);
    let gaps = 0;
    await deliverThenCommitMux(
      frame('doc-a', 'replay.gap'),
      async () => {},
      cursors,
      () => {
        gaps += 1;
      },
    );
    expect(cursors.has('doc-a')).toBe(false);
    expect(cursors.get('doc-b')).toBe('boot1:7');
    // The dedup window is process-wide, so it drops on any gap.
    expect(gaps).toBe(1);
  });

  it('moves a re-advanced key to the end, keeping the map in advance order', async () => {
    const cursors = new Map([
      ['doc-a', 'boot1:1'],
      ['doc-b', 'boot1:2'],
    ]);
    await deliverThenCommitMux(
      frame('doc-a', 'thread.reply', 'boot1:8'),
      async () => {},
      cursors,
      () => {},
    );
    expect([...cursors.keys()]).toEqual(['doc-b', 'doc-a']);
  });
});

describe('a position is not held forever', () => {
  it("drops one key's position on request and leaves the rest", async () => {
    const h = harness([() => sse(`${frame('doc-a', 'x', 'b:1')}${frame('doc-b', 'x', 'b:2')}`)], {
      keys: ['doc-a', 'doc-b'],
    });
    await h.loop.ensureOpen();
    await settle();
    expect(h.loop.cursorCount()).toBe(2);
    h.loop.dropCursor('doc-a');
    expect(h.loop.cursorCount()).toBe(1);
    // Dropping a key that was never held is not an error — an unwatch of a
    // key that never received a frame takes this path.
    h.loop.dropCursor('never-seen');
    expect(h.loop.cursorCount()).toBe(1);
    h.loop.stop();
  });

  it('bounds the map, evicting the longest-quiet key first', async () => {
    const cursors = new Map<string, string>();
    for (let i = 0; i < MUX_CURSOR_MAX_KEYS + 20; i++) {
      await deliverThenCommitMux(
        frame(`doc-${i}`, 'thread.created', `b:${i}`),
        async () => {},
        cursors,
        () => {},
      );
    }
    expect(cursors.size).toBe(MUX_CURSOR_MAX_KEYS);
    // The first twenty are gone and the newest is held: eviction takes the
    // key the wire budget would have dropped anyway, not the busy one.
    expect(cursors.has('doc-0')).toBe(false);
    expect(cursors.has('doc-19')).toBe(false);
    expect(cursors.has('doc-20')).toBe(true);
    expect(cursors.get(`doc-${MUX_CURSOR_MAX_KEYS + 19}`)).toBe(`b:${MUX_CURSOR_MAX_KEYS + 19}`);
  });

  it('a key that keeps advancing survives the eviction of quiet ones', async () => {
    const cursors = new Map<string, string>();
    const advance = async (key: string, n: number) => {
      await deliverThenCommitMux(
        frame(key, 'thread.created', `b:${n}`),
        async () => {},
        cursors,
        () => {},
      );
    };
    await advance('busy', 0);
    for (let i = 0; i < MUX_CURSOR_MAX_KEYS; i++) {
      await advance(`quiet-${i}`, i);
      // The busy key speaks between every quiet one, so it is never the
      // oldest entry and never the one evicted.
      await advance('busy', i + 1);
    }
    expect(cursors.size).toBe(MUX_CURSOR_MAX_KEYS);
    expect(cursors.get('busy')).toBe(`b:${MUX_CURSOR_MAX_KEYS}`);
  });
});

describe('the stream proves which agent it is', () => {
  it('carries the agent bearer on the connect, alongside the cursor', async () => {
    const h = harness([() => sse(':ok\n\n')], {
      authHeaders: async () => ({ authorization: 'Bearer at1.agent-mira.macbytes' }),
    });
    await h.loop.ensureOpen();
    await settle();
    expect(h.attempts[0]?.headers?.authorization).toBe('Bearer at1.agent-mira.macbytes');
  });

  it('sends no authorization when no token could be had', async () => {
    // The deprecation window from this side: a client that cannot mint one
    // connects exactly as it did before the header existed.
    const h = harness([() => sse(':ok\n\n')], { authHeaders: async () => ({}) });
    await h.loop.ensureOpen();
    await settle();
    expect(h.attempts[0]?.headers?.authorization).toBeUndefined();
  });

  it('forgets a token the server refuses, so the redial mints a fresh one', async () => {
    // What a server-side key rotation looks like from here. Without the
    // drop the loop would redial the same dead value until the session ends.
    const h = harness([() => sse('', 403), () => sse(':ok\n\n')], {
      authHeaders: async () => ({ authorization: 'Bearer at1.agent-mira.stale' }),
    });
    await h.loop.ensureOpen();
    await settle();
    expect(h.forgotten()).toBe(1);
  });

  it('does not forget the token on an ordinary connect failure', async () => {
    // A 502 from a restarting server says nothing about the token. Dropping
    // it there would mint on every blip.
    const h = harness([() => sse('', 502), () => sse(':ok\n\n')], {
      authHeaders: async () => ({ authorization: 'Bearer at1.agent-mira.fine' }),
    });
    await h.loop.ensureOpen();
    await settle();
    expect(h.forgotten()).toBe(0);
  });
});
