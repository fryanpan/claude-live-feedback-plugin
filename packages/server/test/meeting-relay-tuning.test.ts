/**
 * Advanced Options on the way through the relay.
 *
 * The adapters' own tests prove a tuning bag lands on a URL or config frame.
 * This is the routing above them: a `tuning` field on the start frame is
 * sanitized against the engine that actually runs and decides the speaker
 * cap (present = the tuning owns it, absent = the legacy fallback), and a
 * mid-meeting `tune` frame reaches `session.update` with only the keys the
 * engine can change live — answered with exactly that list, so the strip can
 * say "applied" about the right knobs and "next recording" about the rest.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_ROOM_SPEAKERS } from '@feedback/core';
import { type MeetingClient, MeetingRelay } from '../src/meeting-protocol.ts';
import { MeetingStore } from '../src/meetings.ts';
import type {
  TranscriptionEngine,
  TranscriptionOpenOpts,
  TranscriptionSession,
} from '../src/transcribe.ts';

/**
 * An engine that records opens and updates. Named after a REAL engine —
 * sanitizing happens against the running engine's spec, so a made-up name
 * would drop every key and the tests would assert on an empty bag.
 */
function recordingEngine(name: string, withUpdate = true) {
  const opens: TranscriptionOpenOpts[] = [];
  const updates: Array<Record<string, unknown>> = [];
  const session: TranscriptionSession = {
    send: () => {},
    close: () => Promise.resolve(),
    ...(withUpdate
      ? {
          update: (tuning: Record<string, unknown>) => {
            updates.push(tuning);
          },
        }
      : {}),
  };
  const engine: TranscriptionEngine = {
    name,
    open(opts) {
      opens.push(opts);
      return Promise.resolve(session);
    },
  };
  return { engine, opens, updates };
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('tuning through the relay', () => {
  let dataDir: string;
  let docSeq = 0;
  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cw-meeting-tuning-'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** One live meeting against a recording engine; caller drives frames. */
  function boot(engineName: string, withUpdate = true) {
    const rec = recordingEngine(engineName, withUpdate);
    const relay = new MeetingRelay({
      store: new MeetingStore(dataDir),
      engines: [rec.engine],
      notes: null,
      broadcast: () => {},
    });
    const received: Array<Record<string, unknown>> = [];
    const ws: MeetingClient = {
      data: { docId: `tune-${docSeq++}` },
      send: (text: string) => {
        received.push(JSON.parse(text) as Record<string, unknown>);
      },
    };
    relay.onOpen(ws);
    const frame = (msg: Record<string, unknown>) => relay.onText(ws, JSON.stringify(msg));
    return { relay, ws, frame, received, ...rec };
  }

  async function start(engineName: string, startExtra: Record<string, unknown>, withUpdate = true) {
    const h = boot(engineName, withUpdate);
    h.frame({
      type: 'start',
      sampleRate: 16000,
      encoding: 'pcm_s16le',
      engine: engineName,
      ...startExtra,
    });
    await settle();
    return h;
  }

  it('opens the engine with the sanitized tuning, clamped into range', async () => {
    const h = await start('assemblyai', {
      mode: 'conversation',
      tuning: {
        end_of_turn_confidence_threshold: 7, // clamped to 1
        min_turn_silence: 250,
        not_a_knob: 'dropped',
      },
    });
    expect(h.opens[0]?.tuning).toEqual({
      end_of_turn_confidence_threshold: 1,
      min_turn_silence: 250,
    });
  });

  it('lets a tuning-aware conversation run uncapped by omission', async () => {
    // The panel's default is uncapped — the engine's own default. Presence
    // of the tuning field is what says "the panel owns the cap now"; the old
    // fallback would quietly re-cap at 2 what the person left open.
    const h = await start('assemblyai', { mode: 'conversation', speakers: 3, tuning: {} });
    expect(h.opens[0]?.detectSpeakers).toBe(true);
    expect(h.opens[0]?.maxSpeakers).toBeUndefined();
    // Empty means "nothing changed", and nothing is what the adapter gets.
    expect(h.opens[0]?.tuning).toBeUndefined();
  });

  it('caps at the number the tuning named', async () => {
    const h = await start('assemblyai', {
      mode: 'conversation',
      tuning: { max_speakers: 4 },
    });
    expect(h.opens[0]?.maxSpeakers).toBe(4);
  });

  it('still caps a legacy start that sent no tuning field at all', async () => {
    const h = await start('assemblyai', { mode: 'conversation' });
    expect(h.opens[0]?.maxSpeakers).toBe(DEFAULT_ROOM_SPEAKERS);
  });

  it('applies a live tune to the session and answers with what was applied', async () => {
    const h = await start('assemblyai', { mode: 'conversation' });
    h.frame({
      type: 'tune',
      settings: {
        vad_threshold: 0.8,
        max_speakers: 5, // real knob, but never live
        nonsense: true, // not a knob at all
      },
    });
    await settle();
    expect(h.updates).toEqual([{ vad_threshold: 0.8 }]);
    const tuned = h.received.find((m) => m.type === 'tuned');
    expect(tuned?.applied).toEqual(['vad_threshold']);
  });

  it('answers an engine that cannot update with an empty applied list', async () => {
    // Soniox has no mid-session update: same panel, honest answer — nothing
    // applied, everything waits for the next recording.
    const h = await start('soniox', { mode: 'conversation' }, false);
    h.frame({ type: 'tune', settings: { endpoint_sensitivity: 0.5 } });
    await settle();
    const tuned = h.received.find((m) => m.type === 'tuned');
    expect(tuned?.applied).toEqual([]);
  });

  it('answers a tune with no meeting running the same way', async () => {
    const h = boot('assemblyai');
    h.frame({ type: 'tune', settings: { vad_threshold: 0.8 } });
    await settle();
    expect(h.updates).toEqual([]);
    const tuned = h.received.find((m) => m.type === 'tuned');
    expect(tuned?.applied).toEqual([]);
  });
});
