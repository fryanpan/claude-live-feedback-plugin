/**
 * word-latency-check — price the two legs the audio FRAME SIZE can move,
 * per candidate size, against the real engine.
 *
 * The live measurement (the instrument ticket) priced the whole pipeline on a
 * real conversation: p50 290ms / p95 594ms, of which the vendor leg is 235ms
 * and everything we own is 55ms. The one knob on our side that touches the
 * biggest legs is `MEETING_FRAME_SAMPLES` — how much audio a frame holds
 * before it is sent. A word waits for its frame to close (the `capture` leg,
 * on average half a frame) and the engine cannot begin until the frame
 * arrives, so AssemblyAI's own guidance is 50ms frames for latency-sensitive
 * callers (chunks may be 50–1000ms; bigger chunks add latency).
 *
 * This script answers "what does a frame size actually buy" without a
 * microphone: a fixed speech recording is streamed at real-time pace once per
 * candidate size, through the same adapter and the same `AudioChunkLedger`
 * arithmetic the live measurement uses, and the report prints p50/p95 for
 * `capture` (audio arithmetic, exact) and `vendor` (send of the frame that
 * carried the word's end → the Turn naming it). The legs this knob cannot
 * move — network, render, paint — are not measured here; the live 55ms stands
 * for them.
 *
 * Usage:
 *   bun run scripts/word-latency-check.ts --mock            # harness control, no key
 *   bun run scripts/word-latency-check.ts [--frame-ms 100,50] [--audio file]
 *
 * With no --audio, a ~60s solo think-aloud is synthesized with macOS `say` —
 * one near-field voice, which is the situation the ticket is about. Each real
 * run opens a metered session (~a minute of streaming per frame size); the
 * key resolves the way the server's does (env, then Keychain) and is never
 * printed.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AudioChunkLedger, percentile } from '../packages/core/src/meeting-timing.ts';
import { MEETING_SAMPLE_RATE } from '../packages/core/src/meeting.ts';
import { createAssemblyAiEngine } from '../packages/server/src/transcribe-assemblyai.ts';
import type { TranscriptionEngine } from '../packages/server/src/transcribe.ts';
import { parseArgs, toMeetingPcm } from './room-labels-check.ts';

const BYTES_PER_MS = (MEETING_SAMPLE_RATE * 2) / 1000;

/** One word-sighting: the two legs a frame size can move. */
export interface ProbeSample {
  /** Audio still owed when the word's frame closed — the framing wait. */
  capture: number;
  /** Frame handed to the engine → the Turn carrying the word arrived. */
  vendor: number;
  final: boolean;
}

interface ProbeResult {
  frameMs: number;
  samples: ProbeSample[];
  transcriptChars: number;
}

/**
 * Stream `audio` through `engine` in `frameMs` frames at real-time pace.
 *
 * Pacing runs against absolute deadlines (start + n·frameMs), not a sleep per
 * frame: a per-frame sleep accumulates timer overhead and by the end of a
 * minute is feeding the engine measurably slower than real time, which is a
 * different experiment. `pace: false` is for the plumbing test only — a
 * latency number from an unpaced run is not a number.
 */
export async function probe(
  engine: TranscriptionEngine,
  audio: Uint8Array,
  frameMs: number,
  pace = true,
): Promise<ProbeResult> {
  const samples: ProbeSample[] = [];
  const ledger = new AudioChunkLedger(MEETING_SAMPLE_RATE);
  let transcriptChars = 0;
  const session = await engine.open({
    sampleRate: MEETING_SAMPLE_RATE,
    detectSpeakers: false,
    onTurn: (t) => {
      transcriptChars = Math.max(transcriptChars, t.text.length);
      if (t.audioEndMs === undefined || t.engineMs === undefined) return;
      const mark = ledger.chunkAt(t.audioEndMs);
      if (!mark) return;
      samples.push({
        capture: mark.audioEndMs - t.audioEndMs,
        vendor: t.engineMs - mark.fwdMs,
        final: t.final,
      });
    },
    onError: (m) => console.error(`engine: ${m}`),
  });
  const frameBytes = 2 * Math.round((frameMs * BYTES_PER_MS) / 2);
  const startedAt = Date.now();
  for (let i = 0, at = 0; at < audio.length; i++, at += frameBytes) {
    const due = startedAt + i * frameMs;
    const wait = due - Date.now();
    if (pace && wait > 0) await new Promise((r) => setTimeout(r, wait));
    const now = Date.now();
    // Record BEFORE forwarding, for the reason the ledger documents: an
    // engine may answer inside the very send that fed it.
    ledger.record(Math.min(frameBytes, audio.length - at), now, now);
    session.send(audio.subarray(at, Math.min(at + frameBytes, audio.length)));
  }
  await session.close();
  return { frameMs, samples, transcriptChars };
}

/**
 * The harness control: an engine that answers every frame instantly, naming
 * the exact audio offset it has received. The probe run on it must produce
 * samples with capture ≈ 0 and vendor ≈ 0 — a run that produces none, or
 * nonzero legs, means the correlation plumbing is broken, and a zero from the
 * real engine could not be trusted either.
 */
export function createEchoEngine(): TranscriptionEngine {
  return {
    name: 'echo',
    open: (opts) => {
      let bytes = 0;
      return Promise.resolve({
        send(audio: Uint8Array): void {
          bytes += audio.length;
          opts.onTurn({
            turn: 0,
            text: 'x'.repeat(Math.round(bytes / 1000)),
            final: false,
            audioEndMs: bytes / BYTES_PER_MS,
            engineMs: Date.now(),
          });
        },
        close: () => Promise.resolve(),
      });
    },
  };
}

/** A solo think-aloud, synthesized: one voice, continuous prose, ~60s. */
const THINK_ALOUD = [
  'Okay so the latency budget is the thing I keep coming back to.',
  'The vendor leg is the biggest number and we cannot tune their model,',
  'but the frame size is ours, and every word waits for its frame to close',
  'before anything downstream can even begin. Half a frame on average.',
  'So if I halve the frame, the wait halves, and the tail should move',
  'by about the same amount, unless the engine charges per message somehow.',
  'The render and paint legs are already small, single digit milliseconds,',
  'so there is no point optimizing those before the big ones.',
  'What I actually want to know is whether the ninety fifth percentile',
  'lands under half a second on a real session, measured, not projected.',
  'Let me talk through the failure modes. The socket could batch writes.',
  'The engine could quantize its answers to its own internal clock.',
  'Or the network could just be noisy at the tail, in which case',
  'no amount of framing changes the worst case, only the median.',
  'Either way the measurement will say, and the measurement is cheap.',
].join(' ');

function synthesize(dir: string): Uint8Array {
  const aiff = join(dir, 'think-aloud.aiff');
  const said = spawnSync('say', ['-o', aiff, THINK_ALOUD], { stdio: 'inherit' });
  if (said.status !== 0) throw new Error('say failed');
  return toMeetingPcm(aiff, dir);
}

function report(result: ProbeResult): void {
  const { frameMs, samples } = result;
  const stat = (values: number[]): string => {
    const f = (p: number) => `${Math.round(percentile(values, p))}ms`;
    return `p50 ${f(50)}  p95 ${f(95)}  max ${f(100)}`;
  };
  console.log(`\n== ${frameMs}ms frames — ${samples.length} word sightings ==`);
  if (samples.length === 0) {
    console.log('   NO SAMPLES — the run proves nothing; see the control.');
    return;
  }
  const legs: Array<[string, (s: ProbeSample) => number]> = [
    ['capture', (s) => s.capture],
    ['vendor', (s) => s.vendor],
    ['capture+vendor', (s) => s.capture + s.vendor],
  ];
  for (const [name, pick] of legs) {
    console.log(`   ${name.padEnd(15)} ${stat(samples.map(pick))}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const frameSizes = (args.get('frame-ms')?.[0] ?? '100,50')
    .split(',')
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 50 && n <= 1000);
  if (frameSizes.length === 0) throw new Error('--frame-ms needs values in 50..1000');

  const mock = args.has('mock');
  const dir = mkdtempSync(join(tmpdir(), 'word-latency-'));
  try {
    const audioArg = args.get('audio')?.[0];
    const audio = mock
      ? new Uint8Array(MEETING_SAMPLE_RATE * 2 * 5)
      : audioArg
        ? toMeetingPcm(audioArg, dir)
        : synthesize(dir);
    const seconds = audio.length / (MEETING_SAMPLE_RATE * 2);
    console.log(`audio: ${seconds.toFixed(1)}s${mock ? ' of silence (mock)' : ''}`);

    const engine = mock ? createEchoEngine() : createAssemblyAiEngine();
    if (!engine) {
      throw new Error(
        'No AssemblyAI key. Set ASSEMBLYAI_API_KEY, or add the assemblyai-api-key\n' +
          'Keychain entry, then run this again. Nothing was sent.',
      );
    }
    for (const frameMs of frameSizes) {
      const result = await probe(engine, audio, frameMs);
      report(result);
      if (mock) {
        const bad = result.samples.filter((s) => s.capture > 1 || s.vendor > 5);
        const verdict =
          result.samples.length > 0 && bad.length === 0
            ? 'CONTROL PASS — plumbing correlates frames to words'
            : `CONTROL FAIL — ${result.samples.length} samples, ${bad.length} with nonzero legs`;
        console.log(`   ${verdict}`);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
