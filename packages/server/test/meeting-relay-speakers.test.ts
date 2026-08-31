/**
 * The room's size reaches the ENGINE, or the cap is decoration.
 *
 * The URL builder's own tests prove `max_speakers` lands on the address when
 * it is given one. This is the other half: a `speakers` on the start frame
 * becomes a `maxSpeakers` on the engine open, a conversation that named no
 * number still gets the default cap rather than none, and a solo capture asks
 * for no cap at all — the case where a wrong answer costs money every meeting.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROOM_SPEAKERS, MAX_ROOM_SPEAKERS } from '@feedback/core';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';

/** An engine that records what it was opened with and nothing else. */
function recordingEngine(): { engine: TranscriptionEngine; opens: TranscriptionOpenOpts[] } {
  const opens: TranscriptionOpenOpts[] = [];
  const session: TranscriptionSession = { send: () => {}, close: () => Promise.resolve() };
  return {
    opens,
    engine: {
      name: 'recording',
      open(opts) {
        opens.push(opts);
        return Promise.resolve(session);
      },
    },
  };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the room size on the way to the engine', () => {
  let dataDir: string;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-speakers-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** One meeting, started with the given start-frame fields. */
  async function open(
    docId: string,
    start: Record<string, unknown>,
  ): Promise<TranscriptionOpenOpts> {
    const { engine, opens } = recordingEngine();
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engine,
      notes: null,
      broadcast: () => {},
    });
    const ws: MeetingClient = { data: { docId }, send: () => {} };
    relay.onOpen(ws);
    relay.onText(
      ws,
      JSON.stringify({ type: 'start', sampleRate: 16000, encoding: 'pcm_s16le', ...start }),
    );
    await settle();
    relay.onText(ws, JSON.stringify({ type: 'stop' }));
    await settle();
    const opened = opens[0];
    if (!opened) throw new Error('the engine was never opened');
    return opened;
  }

  it('caps at the number the room said', async () => {
    const opts = await open('room-3', { mode: 'conversation', speakers: 3 });
    expect(opts.detectSpeakers).toBe(true);
    expect(opts.maxSpeakers).toBe(3);
  });

  it('caps a conversation that named no number, rather than leaving it unbounded', async () => {
    // The whole bug: an uncapped diarizer on one shared microphone answers a
    // change of posture with a new letter.
    const opts = await open('room-default', { mode: 'conversation' });
    expect(opts.maxSpeakers).toBe(DEFAULT_ROOM_SPEAKERS);
  });

  it('clamps a silly number instead of refusing the meeting', async () => {
    const opts = await open('room-many', { mode: 'conversation', speakers: 99 });
    expect(opts.maxSpeakers).toBe(MAX_ROOM_SPEAKERS);
  });

  it('asks for neither labels nor a cap on a solo capture, whatever the frame says', async () => {
    const opts = await open('room-solo', { speakers: 4 });
    expect(opts.detectSpeakers).toBe(false);
    expect(opts.maxSpeakers).toBeUndefined();
  });
});
