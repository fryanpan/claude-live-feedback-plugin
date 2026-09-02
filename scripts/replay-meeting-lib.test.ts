/**
 * The replay path through the mock engine: the same seam the live relay
 * drives, over a fixture that is a byte pattern rather than anyone's voice.
 * A real engine is never opened here — that is a billed session — so what
 * this pins is the plumbing: resolving a folder, chunking the file, folding
 * the turns, and the file that lands beside the original.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_MOCK_SCRIPT,
  createMockTranscriptionEngine,
} from '../packages/server/src/transcribe.ts';
import {
  UsageError,
  parseArgs,
  replayAudio,
  replayTranscriptPath,
  resolveReplayTarget,
  runReplay,
} from './replay-meeting-lib.ts';

const CHUNK_BYTES = 640; // 20 ms at 16 kHz PCM16

describe('parseArgs', () => {
  it('needs a target and an engine, and reads the options', () => {
    expect(
      parseArgs(['/m', '--engine', 'mock', '--segment', '2', '--realtime', '--mode', 'solo']),
    ).toEqual({
      target: '/m',
      engine: 'mock',
      segment: 2,
      mode: 'solo',
      realtime: true,
      chunkMs: 20,
    });
    expect(() => parseArgs(['/m'])).toThrow(UsageError);
    expect(() => parseArgs(['--engine', 'mock'])).toThrow(UsageError);
    expect(() => parseArgs(['/m', '--engine', 'mock', '--segment', 'x'])).toThrow(UsageError);
  });
});

describe('replaying a meeting folder', () => {
  let dir: string;
  const startedAt = Date.UTC(2026, 8, 2, 10, 0, 0);

  beforeAll(() => {
    dir = join(mkdtempSync(join(tmpdir(), 'cw-replay-')), 'meetings', 'plan-q3');
    mkdirSync(dir, { recursive: true });
    // Twenty chunks of a byte pattern: enough sends for both mock turns to settle.
    const pcm = new Uint8Array(CHUNK_BYTES * 20);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i & 0xff;
    writeFileSync(join(dir, 'segment-1-mic.pcm'), pcm);
    writeFileSync(
      join(dir, 'meeting.json'),
      JSON.stringify({
        docId: 'plan-q3',
        docName: 'q3-plan',
        transcript: 'q3-plan-raw-transcript.md',
        path: '/repo/docs/product/plans/q3-plan.md',
        updatedAt: startedAt,
        segments: [
          {
            n: 1,
            meetingId: 'm-plan-q3-1',
            startedAt,
            endedAt: startedAt + 60_000,
            engine: 'soniox',
            mode: 'solo',
            source: 'mic',
            participant: 'Devi Raman',
            audio: [
              {
                stream: 'mic',
                file: 'segment-1-mic.pcm',
                codec: 'pcm_s16le',
                sampleRate: 16_000,
                channels: 1,
                bytes: pcm.length,
              },
            ],
          },
          // A segment that kept no audio (the server never heard any) is skipped, not an error.
          {
            n: 2,
            meetingId: 'm-plan-q3-2',
            startedAt: startedAt + 3_600_000,
            endedAt: null,
            engine: 'soniox',
            mode: 'solo',
            source: 'mic',
            audio: [],
          },
        ],
      }),
    );
  });
  afterAll(() => {
    rmSync(join(dir, '..', '..'), { recursive: true, force: true });
  });

  it('resolves the folder to its audio, carrying the original clock, mode and participant', () => {
    const target = resolveReplayTarget(dir);
    expect(target.docName).toBe('q3-plan');
    expect(target.inputs).toHaveLength(1);
    expect(target.inputs[0]).toMatchObject({
      segment: 1,
      stream: 'mic',
      sampleRate: 16_000,
      startedAt,
      mode: 'solo',
      participant: 'Devi Raman',
    });
    // A single file resolves the same way, through the folder's meeting.json.
    expect(resolveReplayTarget(join(dir, 'segment-1-mic.pcm')).inputs[0]?.startedAt).toBe(
      startedAt,
    );
    expect(() => resolveReplayTarget(dir, 2)).toThrow(/no audio for segment 2/);
  });

  it('feeds the file in browser-sized chunks and folds the engine turns', async () => {
    const target = resolveReplayTarget(dir);
    const input = target.inputs[0];
    if (!input) throw new Error('no input');
    const { turns, chunks } = await replayAudio(input, {
      engine: createMockTranscriptionEngine(),
      detectSpeakers: false,
      chunkMs: 20,
      realtime: false,
      now: () => startedAt + 5_000,
    });
    expect(chunks).toBe(20);
    expect(turns.map((t) => t.text)).toEqual(DEFAULT_MOCK_SCRIPT.map((t) => t.settled));
  });

  it('writes a -replay-<timestamp> transcript beside the original, in the same grammar', async () => {
    const at = Date.UTC(2026, 8, 3, 8, 30, 15, 250);
    const result = await runReplay({
      target: resolveReplayTarget(dir),
      engine: createMockTranscriptionEngine(),
      chunkMs: 20,
      realtime: false,
      now: () => at,
    });
    expect(basename(result.outPath)).toBe('q3-plan-raw-transcript-replay-20260903T083015Z.md');
    expect(result.outPath).toBe(replayTranscriptPath(dir, 'q3-plan', at));
    expect(result).toMatchObject({ segments: 1, turns: 2, chunks: 20 });
    expect(existsSync(result.outPath)).toBe(true);
    const md = readFileSync(result.outPath, 'utf8');
    expect(md).toContain('# Replay transcript — q3-plan');
    expect(md).toContain('## Segment 1 — 2026-09-02T10:00:00.000Z');
    expect(md).toContain('Engine: mock');
    expect(md).toContain('Audio: segment-1-mic.pcm (pcm_s16le, 16000 Hz, mono)');
    // The mock reports no audio offsets, so bullets carry the replay clock;
    // the unlabelled turns go to the person the original recorded.
    expect(md).toContain('- [08:30:15Z] Devi Raman: So the sync is the bottleneck.');
    expect(md).toContain("- [08:30:15Z] Devi Raman: Let's measure it before we rewrite anything.");
    // The original is untouched by a replay: nothing else appeared in the folder.
    expect(existsSync(join(dir, 'q3-plan-raw-transcript.md'))).toBe(false);
  });

  it('a folder with audio but no meeting.json still replays, at 16 kHz and Speaker 1', async () => {
    const bare = join(dir, '..', 'bare');
    mkdirSync(bare, { recursive: true });
    // Seven sends: exactly enough for the first mock turn to settle and none
    // of the second to begin, so close() has nothing to flush.
    writeFileSync(join(bare, 'segment-1-mic.pcm'), new Uint8Array(CHUNK_BYTES * 7));
    const target = resolveReplayTarget(bare);
    expect(target.docName).toBe('bare');
    expect(target.inputs[0]?.sampleRate).toBe(16_000);
    const result = await runReplay({
      target,
      engine: createMockTranscriptionEngine(),
      chunkMs: 20,
      realtime: false,
      now: () => Date.UTC(2026, 8, 3),
    });
    const md = readFileSync(result.outPath, 'utf8');
    expect(md).toContain('] Speaker 1: So the sync is the bottleneck.');
    expect(result.turns).toBe(1);
  });
});
