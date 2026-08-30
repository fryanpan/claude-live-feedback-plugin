/**
 * Shutdown waits for the meetings its own socket-close started.
 *
 * A server shutdown force-closes every connection (see
 * `server-stop-closes-sockets.test.ts` for why it has to), and Bun runs each
 * `close(ws)` handler synchronously inside that call. The relay's handler
 * cannot await — it is a callback — so it starts the teardown and returns,
 * and that teardown is where a meeting's last sentence is flushed out of the
 * engine and into the doc.
 *
 * The shutdown flushes the rooms immediately afterwards. If `dispose()` did
 * not wait for those teardowns, the flush would run first and the final notes
 * would be written into a room nothing will ever save again — lost silently,
 * on every meeting that was live when the server went down.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import type { TranscriptionEngine, TranscriptionSession } from '../src/transcribe.ts';

/** Give an awaited continuation a chance to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('meeting relay dispose', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-dispose-'));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not resolve until the teardown a socket close started has finished', async () => {
    // The engine's close is the flush that settles the turn in progress — the
    // meeting's last words. Held open here so the test can ask what dispose()
    // does while it is still out.
    let releaseClose!: () => void;
    const closing = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeCalled = false;
    const engine: TranscriptionEngine = {
      name: 'gated',
      open: (): Promise<TranscriptionSession> =>
        Promise.resolve({
          send: () => {},
          close: () => {
            closeCalled = true;
            return closing;
          },
        }),
    };

    const store = new MeetingStore(dataDir);
    const stopped: string[] = [];
    const relay = new MeetingRelay({
      store,
      engine,
      notes: null,
      broadcast: (_docId, payload) => {
        if (payload.event === 'meeting.stopped') stopped.push(String(payload.meetingId));
      },
    });

    const ws: MeetingClient = { data: { docId: 'dispose-doc' }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();

    // The shutdown: the socket is force-closed, then dispose runs.
    relay.onClose(ws);
    await settle();
    expect(closeCalled).toBe(true);

    let done = false;
    const disposing = relay.dispose().then(() => {
      done = true;
    });
    await settle();
    await settle();
    // The whole point: the flush is still out, so shutdown is still waiting.
    expect(done).toBe(false);
    expect(stopped).toEqual([]);

    releaseClose();
    await disposing;
    expect(done).toBe(true);
    // And it waited for the real end of the meeting, not merely for a tick.
    expect(stopped.length).toBe(1);
  });

  // Found by codex review: `stop()` on a connection still mid-handshake only
  // RECORDS the ask and returns, and the real flush runs later inside the
  // handshake's own continuation. Waiting on that `stop` alone sees a
  // connection that is already finished.
  it('waits for a socket closed while the engine handshake was still out', async () => {
    let openEngine!: (s: TranscriptionSession) => void;
    let closed = false;
    const engine: TranscriptionEngine = {
      name: 'slow-handshake',
      open: () =>
        new Promise<TranscriptionSession>((resolve) => {
          openEngine = resolve;
        }),
    };
    const store = new MeetingStore(dataDir);
    const stopped: string[] = [];
    const relay = new MeetingRelay({
      store,
      engine,
      notes: null,
      broadcast: (_docId, payload) => {
        if (payload.event === 'meeting.stopped') stopped.push(String(payload.meetingId));
      },
    });
    const ws: MeetingClient = { data: { docId: 'handshake-doc' }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();

    // The socket dies with the handshake still out.
    relay.onClose(ws);
    await settle();

    let done = false;
    const disposing = relay.dispose().then(() => {
      done = true;
    });
    await settle();
    await settle();
    expect(done).toBe(false);

    // The engine answers late; the deferred teardown runs now, and shutdown
    // must still be here to see it.
    openEngine({
      send: () => {},
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
    await disposing;
    expect(closed).toBe(true);
    expect(stopped.length).toBe(1);
  });

  it('goes anyway when a meeting will not finish — shutdown stays bounded', async () => {
    const engine: TranscriptionEngine = {
      name: 'wedged',
      // A handshake that never answers: SIGTERM cannot wait on it forever.
      open: () => new Promise<TranscriptionSession>(() => {}),
    };
    const store = new MeetingStore(dataDir);
    const relay = new MeetingRelay({ store, engine, notes: null, broadcast: () => {} });
    const ws: MeetingClient = { data: { docId: 'wedged-doc' }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();
    relay.onClose(ws);

    const startedAt = Date.now();
    await relay.dispose();
    const waited = Date.now() - startedAt;
    // Bounded, and it did wait rather than skipping the drain outright.
    expect(waited).toBeGreaterThanOrEqual(4_000);
    expect(waited).toBeLessThan(15_000);
    // The doc is claimable again even though the meeting never finished.
    expect(
      store.start({ docId: 'wedged-doc', engine: 'wedged', sampleRate: 16000 }),
    ).not.toBeNull();
  }, 20_000);

  it('still ends a meeting whose socket never produced a close', async () => {
    const engine: TranscriptionEngine = {
      name: 'plain',
      open: (): Promise<TranscriptionSession> =>
        Promise.resolve({ send: () => {}, close: () => Promise.resolve() }),
    };
    const store = new MeetingStore(dataDir);
    const relay = new MeetingRelay({ store, engine, notes: null, broadcast: () => {} });
    const ws: MeetingClient = { data: { docId: 'orphan-doc' }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    await settle();
    expect(store.start({ docId: 'orphan-doc', engine: 'plain', sampleRate: 16000 })).toBeNull();

    await relay.dispose();

    // The doc is claimable again: nothing is left marked as recording by a
    // connection that is gone.
    expect(store.start({ docId: 'orphan-doc', engine: 'plain', sampleRate: 16000 })).not.toBeNull();
  });
});
