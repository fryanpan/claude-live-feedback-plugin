/**
 * Replay a meeting's retained audio through the same engine seam the live
 * path uses, and write the result beside the original raw transcript.
 *
 * The point is a controlled experiment: the original transcript was made by
 * one engine on one day; this re-runs the same bytes through an engine of
 * your choosing and writes `<docname>-raw-transcript-replay-<timestamp>.md`
 * in the same segment/bullet grammar, so the two files diff line for line.
 * Nothing here touches the live record — the original transcript, audio and
 * `meeting.json` are read, never written.
 *
 * The audio is raw PCM16LE (`meeting-raw.ts`), fed to `TranscriptionSession.send`
 * in chunks the size the browser sends, so the engine sees what it saw live.
 * `realtime` paces the chunks at the audio's own rate — some streaming
 * engines want that; the mock does not care, and a test must never wait on
 * a wall clock.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  type MeetingJson,
  type MeetingJsonSegment,
  type MeetingSource,
  formatRawSegment,
} from '../packages/server/src/meeting-raw.ts';
import type { TranscriptTurn } from '../packages/server/src/meetings.ts';
import type { EngineTurn, TranscriptionEngine } from '../packages/server/src/transcribe.ts';

export const USAGE = `usage: bun run meeting:replay <meeting folder | segment-N-<stream>.pcm> --engine <name> [options]

  --engine <name>     mock | soniox | assemblyai | assemblyai-pro (required)
  --segment <N>       only this segment (default: every segment with audio)
  --mode <m>          solo | conversation — whether to ask the engine for
                      speaker labels (default: what the original asked for)
  --realtime          pace the audio at its own rate rather than as fast as
                      the engine accepts it
  --chunk-ms <ms>     audio per send (default 20, what the browser sends)

Writes <docname>-raw-transcript-replay-<timestamp>.md next to the original.
A live engine bills for the audio's length; the mock bills nothing.`;

export class UsageError extends Error {}

export interface ReplayArgs {
  target: string;
  engine: string;
  segment?: number;
  mode?: 'solo' | 'conversation';
  realtime: boolean;
  chunkMs: number;
}

export function parseArgs(argv: readonly string[]): ReplayArgs {
  let target: string | undefined;
  let engine: string | undefined;
  let segment: number | undefined;
  let mode: ReplayArgs['mode'];
  let realtime = false;
  let chunkMs = 20;
  const next = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--engine') engine = next(a, i++);
    else if (a === '--segment') {
      segment = Number(next(a, i++));
      if (!Number.isInteger(segment) || segment < 1)
        throw new UsageError('--segment must be a positive integer');
    } else if (a === '--mode') {
      const m = next(a, i++);
      if (m !== 'solo' && m !== 'conversation')
        throw new UsageError('--mode is solo or conversation');
      mode = m;
    } else if (a === '--realtime') realtime = true;
    else if (a === '--chunk-ms') {
      chunkMs = Number(next(a, i++));
      if (!Number.isFinite(chunkMs) || chunkMs <= 0)
        throw new UsageError('--chunk-ms must be positive');
    } else if (a === '--help' || a === '-h') throw new UsageError(USAGE);
    else if (a.startsWith('--')) throw new UsageError(`unknown flag ${a}`);
    else if (target === undefined) target = a;
    else throw new UsageError(`unexpected argument ${a}`);
  }
  if (!target) throw new UsageError('a meeting folder or audio file is required');
  if (!engine) throw new UsageError('--engine is required');
  return {
    target,
    engine,
    realtime,
    chunkMs,
    ...(segment !== undefined ? { segment } : {}),
    ...(mode ? { mode } : {}),
  };
}

/** One audio file to replay, with what the original knew about it. */
export interface ReplayInput {
  segment: number;
  stream: string;
  path: string;
  sampleRate: number;
  /** The original segment's start, so replay bullets can carry its clock. */
  startedAt: number;
  mode: string;
  source: MeetingSource;
  participant?: string;
}

export interface ReplayTarget {
  dir: string;
  docId: string;
  docName: string;
  inputs: ReplayInput[];
}

const AUDIO_RX = /^segment-(\d+)-(.+)\.pcm$/;

/**
 * What to replay: a meeting folder (every segment with audio, or one with
 * `--segment`), or a single `.pcm` inside one. `meeting.json` supplies the
 * sample rate, mode and clock; a folder without one falls back to 16 kHz
 * and the file's own mtime, which is the most a bare audio file can say.
 */
export function resolveReplayTarget(pathArg: string, segment?: number): ReplayTarget {
  if (!existsSync(pathArg)) throw new UsageError(`${pathArg} does not exist`);
  const isFile = statSync(pathArg).isFile();
  const dir = isFile ? dirname(pathArg) : pathArg;
  const jsonPath = join(dir, 'meeting.json');
  const json: MeetingJson | null = existsSync(jsonPath)
    ? (JSON.parse(readFileSync(jsonPath, 'utf8')) as MeetingJson)
    : null;
  const docId = json?.docId ?? basename(dir);
  const docName = json?.docName ?? docId;
  const byN = new Map<number, MeetingJsonSegment>();
  for (const s of json?.segments ?? []) byN.set(s.n, s);

  const files = isFile
    ? [basename(pathArg)]
    : readdirSync(dir)
        .filter((f) => AUDIO_RX.test(f))
        .sort();
  const inputs: ReplayInput[] = [];
  for (const file of files) {
    const m = AUDIO_RX.exec(file);
    if (!m) throw new UsageError(`${file} is not a segment-N-<stream>.pcm file`);
    const n = Number(m[1]);
    if (segment !== undefined && n !== segment) continue;
    const seg = byN.get(n);
    const audio = seg?.audio.find((a) => a.file === file);
    inputs.push({
      segment: n,
      stream: m[2] as string,
      path: join(dir, file),
      sampleRate: audio?.sampleRate ?? 16_000,
      startedAt: seg?.startedAt ?? statSync(join(dir, file)).mtimeMs,
      mode: seg?.mode ?? 'solo',
      source: seg?.source ?? 'mic',
      ...(seg?.participant !== undefined ? { participant: seg.participant } : {}),
    });
  }
  if (inputs.length === 0) {
    throw new UsageError(
      segment !== undefined
        ? `no audio for segment ${segment} in ${dir}`
        : `no segment-N-<stream>.pcm audio in ${dir}`,
    );
  }
  return { dir, docId, docName, inputs };
}

export interface ReplayRunOpts {
  engine: TranscriptionEngine;
  detectSpeakers: boolean;
  chunkMs: number;
  realtime: boolean;
  /** The clock a bullet gets when the engine reports no audio offset. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Drive one audio file through the engine and return its settled turns —
 * the same folding the live record does: a later final for the same turn
 * replaces the earlier one in place.
 */
export async function replayAudio(
  input: ReplayInput,
  opts: ReplayRunOpts,
): Promise<{ turns: TranscriptTurn[]; chunks: number; bytes: number }> {
  const pcm = readFileSync(input.path);
  const bytesPerMs = (input.sampleRate * 2) / 1000;
  const chunkBytes = Math.max(2, Math.round(bytesPerMs * opts.chunkMs) & ~1);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const turns: TranscriptTurn[] = [];
  const byTurn = new Map<number, TranscriptTurn>();
  const errors: string[] = [];
  const onTurn = (t: EngineTurn): void => {
    if (!t.final) return;
    const ts = t.audioEndMs !== undefined ? input.startedAt + t.audioEndMs : now();
    const turn: TranscriptTurn = {
      turn: t.turn,
      text: t.text,
      ts,
      ...(t.speaker !== undefined ? { speaker: t.speaker } : {}),
    };
    const prior = byTurn.get(t.turn);
    const at = prior ? turns.indexOf(prior) : -1;
    if (at >= 0) turns[at] = turn;
    else turns.push(turn);
    byTurn.set(t.turn, turn);
  };
  const session = await opts.engine.open({
    sampleRate: input.sampleRate,
    detectSpeakers: opts.detectSpeakers,
    onTurn,
    onError: (message) => errors.push(message),
  });
  let chunks = 0;
  for (let off = 0; off < pcm.byteLength; off += chunkBytes) {
    const chunk = new Uint8Array(
      pcm.buffer,
      pcm.byteOffset + off,
      Math.min(chunkBytes, pcm.byteLength - off),
    );
    session.send(chunk);
    chunks++;
    if (opts.realtime) await sleep(opts.chunkMs);
  }
  await session.close();
  if (errors.length > 0) throw new Error(`engine reported: ${errors.join('; ')}`);
  return { turns, chunks, bytes: pcm.byteLength };
}

/** `<docname>-raw-transcript-replay-<YYYYMMDDTHHMMSSZ>.md`, beside the original. */
export function replayTranscriptPath(dir: string, docName: string, at: number): string {
  const stamp = new Date(at)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return join(dir, `${docName}-raw-transcript-replay-${stamp}.md`);
}

export interface ReplayResult {
  outPath: string;
  segments: number;
  turns: number;
  chunks: number;
}

/** The whole run: resolve, replay each input, write one file. */
export async function runReplay(args: {
  target: ReplayTarget;
  engine: TranscriptionEngine;
  mode?: 'solo' | 'conversation';
  chunkMs: number;
  realtime: boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}): Promise<ReplayResult> {
  const now = args.now ?? Date.now;
  const startedRun = now();
  const log = args.log ?? (() => {});
  const { target, engine } = args;
  let body = '';
  let totalTurns = 0;
  let totalChunks = 0;
  for (const input of target.inputs) {
    const detectSpeakers = (args.mode ?? input.mode) === 'conversation';
    log(
      `segment ${input.segment} (${input.stream}): ${basename(input.path)} → ${engine.name}${detectSpeakers ? ', speaker labels' : ''}`,
    );
    const { turns, chunks, bytes } = await replayAudio(input, {
      engine,
      detectSpeakers,
      chunkMs: args.chunkMs,
      realtime: args.realtime,
      ...(args.now ? { now: args.now } : {}),
      ...(args.sleep ? { sleep: args.sleep } : {}),
    });
    log(`  ${chunks} chunks, ${bytes} bytes → ${turns.length} settled turn(s)`);
    body += formatRawSegment({
      n: input.segment,
      startedAt: input.startedAt,
      endedAt: now(),
      engine: engine.name,
      mode: detectSpeakers ? 'conversation' : 'solo',
      source: input.source,
      audio: [
        {
          stream: input.stream,
          file: basename(input.path),
          codec: 'pcm_s16le',
          sampleRate: input.sampleRate,
          channels: 1,
          bytes,
        },
      ],
      turns,
      names: {},
      ...(input.participant !== undefined ? { participant: input.participant } : {}),
    });
    totalTurns += turns.length;
    totalChunks += chunks;
  }
  const outPath = replayTranscriptPath(target.dir, target.docName, startedRun);
  const preamble = [
    `# Replay transcript — ${target.docName}`,
    '',
    `Doc: ${target.docId} · Engine: ${engine.name} · Replayed: ${new Date(startedRun).toISOString()}`,
    '',
    'The retained audio of each segment below, re-run through the engine named',
    `above. Compare against ${target.docName}-raw-transcript.md in this folder;`,
    'bullet clocks are the original segment start plus the audio offset where',
    'the engine reports one, and the replay wall clock where it does not.',
    '',
  ].join('\n');
  writeFileSync(outPath, `${preamble}${body}`);
  return { outPath, segments: target.inputs.length, turns: totalTurns, chunks: totalChunks };
}
