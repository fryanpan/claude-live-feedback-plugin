import { describe, expect, it } from 'vitest';
import { MEETING_SAMPLE_RATE } from '../packages/core/src/meeting.ts';
import { createEchoEngine, probe } from './word-latency-check.ts';

/**
 * The probe's correlation plumbing, against the engine that answers every
 * frame instantly. What this guards: a probe whose ledger and word offsets
 * disagree would either yield NO samples (and a real run would print
 * percentiles over nothing) or price the legs against the wrong frame (and a
 * real run would report a latency the vendor never spent). The echo engine
 * names the exact offset it received, so every leg must come back ~0 — the
 * same positive control `--mock` runs before a metered session is opened.
 */
describe('probe', () => {
  it('correlates every echoed word to its own frame, legs ~0', async () => {
    const audio = new Uint8Array(MEETING_SAMPLE_RATE * 2); // one second
    const result = await probe(createEchoEngine(), audio, 50, false);
    // One Turn per frame: 1000ms / 50ms.
    expect(result.samples.length).toBe(20);
    for (const s of result.samples) {
      expect(s.capture).toBeCloseTo(0, 5);
      expect(s.vendor).toBeLessThan(5);
    }
  });

  it('prices a word mid-frame against the frame that carries its end', async () => {
    // An engine that reports each frame's MIDPOINT: capture must price the
    // half-frame still owed when the frame closed, not zero — the case that
    // catches a ledger read off by one frame.
    const frameMs = 50;
    const bytesPerMs = (MEETING_SAMPLE_RATE * 2) / 1000;
    const midpointEngine = {
      name: 'midpoint',
      open: (opts: Parameters<ReturnType<typeof createEchoEngine>['open']>[0]) => {
        let bytes = 0;
        return Promise.resolve({
          send(chunk: Uint8Array): void {
            bytes += chunk.length;
            opts.onTurn({
              turn: 0,
              text: 'x',
              final: false,
              audioEndMs: bytes / bytesPerMs - frameMs / 2,
              engineMs: Date.now(),
            });
          },
          close: () => Promise.resolve(),
        });
      },
    };
    const audio = new Uint8Array(MEETING_SAMPLE_RATE * 2);
    const result = await probe(midpointEngine, audio, frameMs, false);
    expect(result.samples.length).toBe(20);
    for (const s of result.samples) expect(s.capture).toBeCloseTo(frameMs / 2, 5);
  });

  it('counts a re-emitted word endpoint once, not per revision', async () => {
    // The real engine re-emits a turn on every revision and a formatted
    // final repeats the unformatted one's endpoint; a probe that sampled
    // every callback would weight the percentiles by revision cadence.
    const bytesPerMs = (MEETING_SAMPLE_RATE * 2) / 1000;
    const revisingEngine = {
      name: 'revising',
      open: (opts: Parameters<ReturnType<typeof createEchoEngine>['open']>[0]) => {
        let bytes = 0;
        return Promise.resolve({
          send(chunk: Uint8Array): void {
            bytes += chunk.length;
            const audioEndMs = bytes / bytesPerMs;
            opts.onTurn({ turn: 0, text: 'x', final: false, audioEndMs, engineMs: Date.now() });
            opts.onTurn({ turn: 0, text: 'X.', final: true, audioEndMs, engineMs: Date.now() });
          },
          close: () => Promise.resolve(),
        });
      },
    };
    const audio = new Uint8Array(MEETING_SAMPLE_RATE * 2);
    const result = await probe(revisingEngine, audio, 50, false);
    expect(result.samples.length).toBe(20);
  });
});
