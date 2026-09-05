/**
 * One stream per agent, N watched keys on it.
 *
 * The failure this closes: the MCP child opened a socket per watched key, a
 * lead session with 214 watches held 214 of them, and on 2026-09-04 the fleet
 * exhausted this machine's kernel socket memory — which the supervisor read
 * as an unbound server and "fixed" twenty times by restarting it.
 *
 * What these tests hold onto, beyond the socket count:
 *  - every frame is TAGGED with the key it arrived on, so one socket is
 *    actually equivalent to N;
 *  - replay stays PER KEY — a proven tail on one key and a gap notice naming
 *    another, in the same reconnect;
 *  - a watch added or removed reaches an OPEN stream, because a fix that
 *    needed a reconnect per watch would just be the storm in a hat;
 *  - the wire format the client encodes is the one the server decodes.
 *
 * All fixtures synthetic; no production server is touched.
 */
import { describe, expect, it } from 'bun:test';
import { formatMuxCursor } from '../../mcp/src/mux-cursor.ts';
import { isMuxCursor, parseMuxCursor } from '../src/mux-cursor.ts';
import { channelForWatchKey, openAgentMuxStream } from '../src/sse-mux.ts';
import { REPLAY_MAX_EVENTS, SseBus } from '../src/sse.ts';

type Frame = { event: string; id?: string; data: Record<string, unknown> };

/** Read whatever the stream has produced so far. The mux stream writes
 *  synchronously into its controller, so a single drain after each action is
 *  enough — there is no scheduler to wait on. */
function drain(res: Response): { frames: () => Frame[]; cancel: () => void } {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buf = '';
  let stopped = false;
  const pump = (async () => {
    while (!stopped) {
      const { done, value } = await reader.read();
      if (done) return;
      buf += decoder.decode(value, { stream: true });
      let sep = buf.indexOf('\n\n');
      while (sep >= 0) {
        const raw = buf.slice(0, sep);
        buf = buf.slice(sep + 2);
        sep = buf.indexOf('\n\n');
        if (raw.startsWith(':')) continue;
        const f: Frame = { event: 'message', data: {} };
        for (const line of raw.split('\n')) {
          if (line.startsWith('id:')) f.id = line.slice(3).trim();
          else if (line.startsWith('event:')) f.event = line.slice(6).trim();
          else if (line.startsWith('data:')) f.data = JSON.parse(line.slice(5).trim());
        }
        frames.push(f);
      }
    }
  })();
  return {
    frames: () => frames,
    cancel: () => {
      stopped = true;
      void reader.cancel();
      void pump;
    },
  };
}

/** Let the reader's microtasks run so everything already enqueued is parsed. */
const settle = () => new Promise((r) => setTimeout(r, 0));

const KEYS_AB = ['doc-a', 'doc-b'];

function openMux(
  bus: SseBus,
  opts: {
    keys: () => string[];
    cursors?: Map<string, string>;
    onWatchSetChanged?: (cb: () => void) => () => void;
  },
) {
  return openAgentMuxStream({
    bus,
    agentId: 'agent-mira',
    keys: opts.keys,
    channelFor: (key) => channelForWatchKey(key, (id) => id),
    ...(opts.cursors ? { cursors: opts.cursors } : {}),
    ...(opts.onWatchSetChanged ? { onWatchSetChanged: opts.onWatchSetChanged } : {}),
    // A 15s interval would keep the test process alive for 15s.
    keepaliveMs: 60_000,
  });
}

describe('agent mux stream', () => {
  it('carries two keys on one stream, each frame tagged with its key', async () => {
    const bus = new SseBus();
    const res = openMux(bus, { keys: () => [...KEYS_AB] });
    const out = drain(res);

    bus.broadcast('doc-a', { event: 'thread.created' });
    bus.broadcast('doc-b', { event: 'thread.reply' });
    await settle();

    const frames = out.frames();
    expect(frames.map((f) => f.event)).toEqual(['thread.created', 'thread.reply']);
    expect(frames.map((f) => f.data.watchKey)).toEqual(['doc-a', 'doc-b']);
    // One subscriber per channel — the whole point is that it is the SAME one.
    expect(bus.count('doc-a')).toBe(1);
    expect(bus.count('doc-b')).toBe(1);
    out.cancel();
  });

  it('resolves a ws: watch key onto the board channel and names the agent there', async () => {
    const bus = new SseBus();
    const res = openMux(bus, { keys: () => ['ws:w-board', 'doc-a'] });
    const out = drain(res);

    bus.broadcast('ws~w-board', { event: 'task.updated' });
    await settle();

    expect(out.frames()[0]?.data.watchKey).toBe('ws:w-board');
    // The board channel is where an agent is ADDRESSABLE, so the mux names
    // itself there — and stays anonymous on doc channels, exactly as the
    // per-key streams were.
    expect([...bus.agentsOn('ws~w-board')]).toEqual(['agent-mira']);
    expect([...bus.agentsOn('doc-a')]).toEqual([]);
    out.cancel();
  });

  it('replays per key: a proven tail on one, a gap naming the other', async () => {
    const bus = new SseBus();
    // doc-a: one event the client saw, then two it missed while disconnected.
    bus.broadcast('doc-a', { event: 'a.seen' });
    const seenA = bus.lastIdOn('doc-a') as string;
    bus.broadcast('doc-a', { event: 'a.missed.1' });
    bus.broadcast('doc-a', { event: 'a.missed.2' });
    // doc-b: the client's cursor is evicted by the count bound, so its tail
    // cannot be proven complete.
    bus.broadcast('doc-b', { event: 'b.old' });
    const evictedB = bus.lastIdOn('doc-b') as string;
    for (let i = 0; i < REPLAY_MAX_EVENTS + 1; i++) {
      bus.broadcast('doc-b', { event: 'b.filler' });
    }

    const res = openMux(bus, {
      keys: () => [...KEYS_AB],
      cursors: new Map([
        ['doc-a', seenA],
        ['doc-b', evictedB],
      ]),
    });
    const out = drain(res);
    await settle();

    const frames = out.frames();
    const onA = frames.filter((f) => f.data.watchKey === 'doc-a');
    const onB = frames.filter((f) => f.data.watchKey === 'doc-b');
    // doc-a's catch-up is complete and in order, and carries no gap.
    expect(onA.map((f) => f.event)).toEqual(['a.missed.1', 'a.missed.2']);
    // doc-b is told to refetch — and says which key it is talking about, so
    // one aged-out channel cannot make a session refetch everything.
    expect(onB.map((f) => f.event)).toEqual(['replay.gap']);
    expect(onB[0]?.data.watchKey).toBe('doc-b');
    // A gap frame carries no id: presented back it would read as coverage.
    expect(onB[0]?.id).toBeUndefined();
    out.cancel();
  });

  it('a key with no cursor gets no replay and no gap notice', async () => {
    const bus = new SseBus();
    bus.broadcast('doc-a', { event: 'a.one' });
    const seenA = bus.lastIdOn('doc-a') as string;
    bus.broadcast('doc-b', { event: 'b.before' });

    const res = openMux(bus, {
      keys: () => [...KEYS_AB],
      cursors: new Map([['doc-a', seenA]]),
    });
    const out = drain(res);
    await settle();

    // Exactly the semantics of a per-key stream that has never received a
    // frame: nothing replayed, and no gap claimed on its behalf.
    expect(out.frames()).toEqual([]);
    out.cancel();
  });

  it('picks up a watch added to the set without a reconnect', async () => {
    const bus = new SseBus();
    let keys = ['doc-a'];
    let fire: (() => void) | undefined;
    const res = openMux(bus, {
      keys: () => [...keys],
      onWatchSetChanged: (cb) => {
        fire = cb;
        return () => {
          fire = undefined;
        };
      },
    });
    const out = drain(res);

    bus.broadcast('doc-b', { event: 'b.before.watch' });
    await settle();
    expect(out.frames()).toEqual([]);

    keys = ['doc-a', 'doc-b'];
    fire?.();
    bus.broadcast('doc-b', { event: 'b.after.watch' });
    await settle();

    expect(out.frames().map((f) => f.event)).toEqual(['b.after.watch']);
    // The key that was already there kept its one registration — the sync
    // moves the difference, not the whole set.
    expect(bus.count('doc-a')).toBe(1);
    out.cancel();
  });

  it('drops a channel when its key leaves the set, and keeps the rest', async () => {
    const bus = new SseBus();
    let keys = [...KEYS_AB];
    let fire: (() => void) | undefined;
    const res = openMux(bus, {
      keys: () => [...keys],
      onWatchSetChanged: (cb) => {
        fire = cb;
        return () => {
          fire = undefined;
        };
      },
    });
    const out = drain(res);

    keys = ['doc-a'];
    fire?.();
    bus.broadcast('doc-b', { event: 'b.after.unwatch' });
    bus.broadcast('doc-a', { event: 'a.still.here' });
    await settle();

    expect(bus.count('doc-b')).toBe(0);
    expect(out.frames().map((f) => f.event)).toEqual(['a.still.here']);
    out.cancel();
  });

  it('unregisters every channel when the stream is cancelled', async () => {
    const bus = new SseBus();
    const res = openMux(bus, { keys: () => [...KEYS_AB] });
    const out = drain(res);
    await settle();
    expect(bus.count('doc-a')).toBe(1);

    out.cancel();
    await settle();

    expect(bus.count('doc-a')).toBe(0);
    expect(bus.count('doc-b')).toBe(0);
  });
});

describe('mux cursor wire format', () => {
  it('round-trips the client encoder through the server decoder', () => {
    // The two halves are duplicated on purpose (the MCP bundles standalone),
    // so this is the only thing holding them together.
    const cursors: Array<[string, string]> = [
      ['doc-a', 'a1b2c3d4:17'],
      ['ws:w-board', 'a1b2c3d4:19'],
    ];
    const { value, dropped } = formatMuxCursor(cursors);
    expect(dropped).toEqual([]);
    expect(isMuxCursor(value)).toBe(true);
    expect([...(parseMuxCursor(value) ?? [])]).toEqual(cursors);
  });

  it('drops the tail rather than the whole cursor when the budget is spent', () => {
    const { value, dropped } = formatMuxCursor(
      [
        ['hot', 'aaaaaaaa:9'],
        ['cold', 'aaaaaaaa:1'],
      ],
      'mux1:hot=aaaaaaaa:9'.length,
    );
    // The most recently active key keeps its position; the quiet one loses it
    // and is REPORTED, so the caller can drop its dedup window instead of
    // quietly believing it is covered.
    expect([...(parseMuxCursor(value) ?? [])]).toEqual([['hot', 'aaaaaaaa:9']]);
    expect(dropped).toEqual(['cold']);
  });

  it('reads a single-key value that is not a mux cursor as not-a-mux-cursor', () => {
    // A per-key stream's plain wire id must never be mistaken for one, or the
    // old routes would start answering with a key-tagged replay.
    expect(isMuxCursor('a1b2c3d4:17')).toBe(false);
    expect(parseMuxCursor('a1b2c3d4:17')).toBeUndefined();
    expect(parseMuxCursor(undefined)).toBeUndefined();
  });

  it('keeps the good pairs when one entry is malformed', () => {
    // Refusing the whole header would turn one bad entry into a fleet-wide
    // loss of position.
    expect([...(parseMuxCursor('mux1:doc-a=aaaaaaaa:3,garbage,doc-b=aaaaaaaa:4') ?? [])]).toEqual([
      ['doc-a', 'aaaaaaaa:3'],
      ['doc-b', 'aaaaaaaa:4'],
    ]);
  });
});
