/**
 * A `start` retried on the same socket after `engine_unavailable` must begin
 * a CLEAN meeting. The wire contract keeps the socket open after
 * `unavailable`, so a conforming client may retry on the same connection —
 * and audio buffered during the FAILED handshake must not be replayed into
 * the new session, where it would transcribe the failed attempt's speech
 * into the new meeting's append-only transcript.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';

/** Lets a test hold the handshake open and decide how it ends. */
interface PendingOpen {
  opts: TranscriptionOpenOpts;
  resolve: (session: TranscriptionSession) => void;
  reject: (err: Error) => void;
}

function createHandshakeControlledEngine(): {
  engine: TranscriptionEngine;
  opens: PendingOpen[];
  received: Uint8Array[][];
} {
  const opens: PendingOpen[] = [];
  /** Audio each opened session was fed, one array per successful open. */
  const received: Uint8Array[][] = [];
  const engine: TranscriptionEngine = {
    name: 'handshake-controlled',
    open(opts: TranscriptionOpenOpts): Promise<TranscriptionSession> {
      return new Promise<TranscriptionSession>((resolvePromise, rejectPromise) => {
        opens.push({
          opts,
          resolve: () => {
            const chunks: Uint8Array[] = [];
            received.push(chunks);
            resolvePromise({
              send: (audio) => chunks.push(audio),
              close: () => Promise.resolve(),
            });
          },
          reject: rejectPromise,
        });
      });
    },
  };
  return { engine, opens, received };
}

function createClient(docId: string): { ws: MeetingClient; frames: { type: string }[] } {
  const frames: { type: string }[] = [];
  const ws: MeetingClient = {
    data: { docId },
    send(payload: string) {
      frames.push(JSON.parse(payload) as { type: string });
    },
  };
  return { ws, frames };
}

/** Give the awaited handshake continuation a chance to run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('meeting relay retry after a failed handshake', () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-relay-retry-'));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('does not replay the failed attempt audio into the next meeting', async () => {
    const { engine, opens, received } = createHandshakeControlledEngine();
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engine,
      broadcast: () => {},
    });
    const { ws, frames } = createClient('retry-doc');
    relay.onOpen(ws);

    // First attempt: audio arrives while the handshake is out, then the
    // engine refuses. The socket stays open, per the wire contract.
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    expect(opens.length).toBe(1);
    const staleChunk = new Uint8Array([1, 1, 1]);
    relay.onAudio(ws, staleChunk);
    opens[0]?.reject(new Error('engine down'));
    await settle();
    expect(frames.some((f) => f.type === 'unavailable')).toBe(true);

    // Second attempt on the SAME socket: this one opens fine.
    relay.onText(ws, JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le' }));
    expect(opens.length).toBe(2);
    const liveChunk = new Uint8Array([2, 2, 2]);
    relay.onAudio(ws, liveChunk);
    opens[1]?.resolve(undefined as never); // session built inside resolve()
    await settle();
    expect(frames.some((f) => f.type === 'ready')).toBe(true);

    // The new session hears the new meeting only — the failed attempt's
    // buffered audio is gone, not transcribed into this transcript.
    expect(received.length).toBe(1);
    expect(received[0]).toEqual([liveChunk]);

    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
  });
});
