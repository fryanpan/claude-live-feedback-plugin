/**
 * Does a ROOM diarize — and do the browser's microphone processors help or
 * hurt when it tries?
 *
 * `diarize-check.ts` answers the first question in the easiest possible room:
 * two synthetic voices, clean, taking strict turns, no overlap and no
 * distance. This script is for the hard one. It scores a run against the
 * script that was actually read, prints the scoring settings beside every
 * number (see `room-labels-score.ts` for why a number without them is not a
 * number), and compares runs recorded under different microphone settings.
 *
 * THREE WAYS IN, in order of how much they prove:
 *
 *   bun run scripts/room-labels-check.ts --doc <docId> \
 *       --truth <script.txt> --setting ec1-ns1-agc1 --data-dir <path>
 *
 *     Scores a meeting THAT ALREADY HAPPENED, from the append-only record.
 *     No key, no cost, no audio needed — which matters, because this server
 *     keeps no audio (`meetings.ts`: "the audio is gone"). This is the path
 *     for a real two-person room: record the same short script several times
 *     with `?mic=ec1-ns0-agc0` and friends on the doc address, then score
 *     each meeting and pass its setting in so the report can name it.
 *
 *   bun run scripts/room-labels-check.ts --audio room.wav --truth script.txt
 *
 *     Sends an audio file through the real engine and scores what comes back.
 *     Needs a key and opens a metered session. Any format ffmpeg can read;
 *     it is converted to the meeting's own 16 kHz mono PCM first.
 *
 *   bun run scripts/room-labels-check.ts --synthetic
 *
 *     Builds a two-voice fixture with macOS `say` and ffmpeg — two voices at
 *     different distances in a reverberant room, with overlap — and runs the
 *     `--audio` path on it. SYNTHETIC. Two TTS voices are more separable than
 *     two people, so a pass here is a floor, not a measurement of a room.
 *
 * WHY THE SETTINGS CANNOT BE VARIED FROM ONE RECORDING. Echo cancellation,
 * noise suppression and gain control are applied by the browser BEFORE the
 * audio exists as a file. Nothing downstream can remove them, so comparing
 * them honestly needs one recording per combination, made through the app.
 * `--emulate` exists for the other direction — it ADDS an approximation of
 * noise suppression or gain control to a clean recording with ffmpeg filters
 * — and it is an approximation of the effect, not the browser's own APM.
 * Every line it produces is marked EMULATED.
 *
 * The key resolves the way the server's does (env, then Keychain) and is
 * never printed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEETING_SAMPLE_RATE } from '../packages/core/src/meeting.ts';
import {
  listMeetings,
  meetingTranscriptPath,
  readTranscript,
} from '../packages/server/src/meetings.ts';
import { createAssemblyAiEngine } from '../packages/server/src/transcribe-assemblyai.ts';
import { createMockTranscriptionEngine } from '../packages/server/src/transcribe.ts';
import {
  DEFAULT_SCORING,
  type ScoredTurn,
  type TruthUtterance,
  formatScore,
  scoreDiarization,
} from './room-labels-score.ts';

/**
 * The script the synthetic room reads, and the truth it is scored against.
 *
 * Fictional people. Lines are long enough to be attributed — a turn under
 * about a second of audio comes back as a placeholder label — and they
 * disagree with each other, because a diarizer's easiest case is two people
 * saying different KINDS of thing and the room's real case is not that.
 */
export const SYNTHETIC_SCRIPT: ReadonlyArray<{ voice: string; speaker: string; line: string }> = [
  {
    voice: 'Alex',
    speaker: 'Rowan',
    line: 'The import is holding everything up, and I think it is the sync step.',
  },
  {
    voice: 'Samantha',
    speaker: 'Devi',
    line: 'I am not sure it is the sync step at all. Can we measure it first?',
  },
  {
    voice: 'Alex',
    speaker: 'Rowan',
    line: 'We can measure it, but I would rather not spend another week on this.',
  },
  {
    voice: 'Samantha',
    speaker: 'Devi',
    line: 'A week is cheaper than rewriting the thing twice, which is what happened last time.',
  },
  {
    voice: 'Alex',
    speaker: 'Rowan',
    line: 'Fine. I will get numbers together by Thursday and we can decide then.',
  },
  {
    voice: 'Samantha',
    speaker: 'Devi',
    line: 'Thursday works for me. Send them round before the meeting if you can.',
  },
];

function run(cmd: string, args: string[]): void {
  const proc = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (proc.status !== 0) {
    throw new Error(`${cmd} failed: ${proc.stderr?.toString('utf8').trim() ?? proc.status}`);
  }
}

function has(cmd: string): boolean {
  return spawnSync('which', [cmd], { stdio: 'ignore' }).status === 0;
}

/** Raw PCM16 at the meeting's rate, out of anything ffmpeg can read. */
export function toMeetingPcm(input: string, dir: string): Uint8Array {
  const out = join(dir, 'meeting.raw');
  run('ffmpeg', [
    '-y',
    '-i',
    input,
    '-ac',
    '1',
    '-ar',
    String(MEETING_SAMPLE_RATE),
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    out,
  ]);
  return new Uint8Array(readFileSync(out));
}

/**
 * A two-voice room, built rather than recorded.
 *
 * Each line is spoken by a macOS voice, then placed in a room: the far talker
 * is attenuated and low-passed (distance eats the top end before it eats the
 * level), both get the same reverb tail so they share an acoustic, and the
 * turns overlap slightly, because two people in a room interrupt each other
 * and strict alternation is the case diarization never fails.
 *
 * SYNTHETIC. It is a harder fixture than `diarize-check.ts` uses and still an
 * easier one than a room: TTS voices have stable pitch, no head movement, and
 * no second microphone path.
 */
export function synthesizeRoom(dir: string): { file: string; seconds: number } {
  const parts: Array<{ file: string; seconds: number }> = [];
  SYNTHETIC_SCRIPT.forEach((turn, i) => {
    const aiff = join(dir, `line-${i}.aiff`);
    const wav = join(dir, `line-${i}.wav`);
    run('say', ['-v', turn.voice, '-o', aiff, turn.line]);
    // The far talker: 6 dB down and rolled off at 3.4 kHz, because distance
    // eats the top of the spectrum before it eats the level. The near one
    // keeps its own, so the pair differ the way two seats at a table do.
    const far = i % 2 === 1;
    run('ffmpeg', [
      '-y',
      '-i',
      aiff,
      '-af',
      far ? 'volume=0.5,lowpass=f=3400' : 'volume=1.0',
      '-ar',
      String(MEETING_SAMPLE_RATE),
      '-ac',
      '1',
      wav,
    ]);
    parts.push({ file: wav, seconds: durationOf(wav) });
  });

  // Place each line on its own delayed track and mix them, rather than
  // concatenating: real turns overlap at the seam, and strict alternation
  // with a gap between every line is the case diarization never fails.
  const OVERLAP_MS = 150;
  let atMs = 0;
  const delays: number[] = [];
  for (const part of parts) {
    delays.push(Math.max(0, atMs));
    atMs += Math.round(part.seconds * 1000) - OVERLAP_MS;
  }
  const out = join(dir, 'room.wav');
  const chain = `${parts
    .map((_, i) => `[${i}:a]adelay=${delays[i]}|${delays[i]}[d${i}];`)
    .join('')}${parts.map((_, i) => `[d${i}]`).join('')}amix=inputs=${
    parts.length
  }:normalize=0[dry];[dry]aecho=0.8:0.85:35|55|90:0.35|0.25|0.15,highpass=f=90[wet]`;
  run('ffmpeg', [
    '-y',
    ...parts.flatMap((p) => ['-i', p.file]),
    '-filter_complex',
    chain,
    '-map',
    '[wet]',
    '-ar',
    String(MEETING_SAMPLE_RATE),
    '-ac',
    '1',
    out,
  ]);
  return { file: out, seconds: durationOf(out) };
}

/** Seconds of audio in a file, from ffprobe. */
function durationOf(file: string): number {
  const probe = spawnSync('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  return Number(probe.stdout?.toString('utf8').trim() ?? '0');
}

/** An ffmpeg approximation of one processor, for `--emulate`. */
const EMULATIONS: Record<string, string> = {
  // Spectral denoise — the same JOB as the browser's noise suppression, not
  // the same algorithm.
  ns: 'afftdn=nf=-25',
  // Dynamic normalisation — continuous gain riding, which is what AGC does to
  // the loudness difference a diarizer leans on.
  agc: 'dynaudnorm=f=150:g=15',
};

/** Apply an emulation chain to a file, returning the new file. */
export function emulate(input: string, keys: readonly string[], dir: string): string {
  const chain = keys.map((k) => EMULATIONS[k]).filter(Boolean);
  if (chain.length === 0) return input;
  const out = join(dir, `emulated-${keys.join('-')}.wav`);
  run('ffmpeg', [
    '-y',
    '-i',
    input,
    '-af',
    chain.join(','),
    '-ar',
    String(MEETING_SAMPLE_RATE),
    '-ac',
    '1',
    out,
  ]);
  return out;
}

/**
 * The script as read, out of a text file: one `Name: line` per line.
 *
 * Blank lines and `#` comments are skipped, so the file can be the thing
 * somebody actually read off a screen.
 */
export function parseTruth(text: string): TruthUtterance[] {
  const out: TruthUtterance[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const at = line.indexOf(':');
    if (at <= 0) continue;
    out.push({ speaker: line.slice(0, at).trim(), text: line.slice(at + 1).trim() });
  }
  return out;
}

/**
 * Speak audio through an engine, paced at real time, and settle.
 *
 * `mock` runs the whole path — framing, pacing, settling, scoring, report —
 * with no key, no network and no bill, against a scripted engine that returns
 * the fixture's own lines. It proves the HARNESS works and measures nothing
 * about diarization: the mock hears no audio. Use it to see the report render
 * before spending on a session, never as a result.
 */
async function transcribe(
  audio: Uint8Array,
  maxSpeakers: number,
  mock?: readonly TruthUtterance[],
): Promise<ScoredTurn[]> {
  const engine = mock
    ? createMockTranscriptionEngine(
        mock.map((line) => ({ words: line.text.split(' '), speaker: line.speaker })),
      )
    : createAssemblyAiEngine();
  if (!engine) {
    throw new Error(
      'No AssemblyAI key. Set ASSEMBLYAI_API_KEY, or add the assemblyai-api-key\n' +
        'Keychain entry, then run this again. Nothing was sent.',
    );
  }
  const settled = new Map<number, ScoredTurn>();
  const session = await engine.open({
    sampleRate: MEETING_SAMPLE_RATE,
    detectSpeakers: true,
    maxSpeakers,
    onTurn: (t) => {
      if (t.final)
        settled.set(t.turn, {
          turn: t.turn,
          text: t.text,
          ...(t.speaker ? { speaker: t.speaker } : {}),
        });
    },
    onError: (m) => console.error(`engine: ${m}`),
  });
  // Billed on wall-clock seconds, and the turn detector is built for speech
  // arriving as it is spoken: pacing is not politeness, it is the contract.
  // The mock advances one step per chunk instead of on a clock, so it needs
  // no wait — and waiting would make a harness check take as long as a
  // meeting.
  const frameBytes = (MEETING_SAMPLE_RATE / 10) * 2;
  for (let i = 0; i < audio.length; i += frameBytes) {
    session.send(audio.subarray(i, Math.min(i + frameBytes, audio.length)));
    if (!mock) await new Promise((r) => setTimeout(r, 100));
  }
  await session.close();
  return [...settled.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
}

/** `--flag value` pairs and bare `--flag`s, in the order they were given. */
export function parseArgs(argv: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let key: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith('--')) {
      key = arg.slice(2);
      if (!out.has(key)) out.set(key, []);
    } else if (key) {
      out.get(key)?.push(arg);
    }
  }
  return out;
}

/**
 * Where the meetings are, unless told otherwise: this checkout's own `data`,
 * which is what `bin.ts` defaults to. A worktree has its OWN empty one, so
 * scoring a meeting recorded against prod means passing `--data-dir` — and
 * the resolved path is printed either way, because a wrong directory
 * otherwise reads as "that meeting has no turns".
 */
function defaultDataDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'data');
}

const USAGE = `room-labels-check — score speaker labels against the script that was read

  --doc <docId>                   score a meeting already in the record
  --meeting <meetingId>           which one (default: the most recent)
  --audio <file>                  send a file through the real engine (costs)
  --synthetic                     build a two-voice fixture and use --audio on it
  --truth <file>                  the script, "Name: line" per line (required
                                  except with --synthetic, which knows its own)
  --setting <label>               what the recording was made under, e.g. ec1-ns0-agc0
  --emulate <ns|agc>...           ADD an approximation of a processor first
  --mock                          run the whole path against the mock engine:
                                  no key, no bill, and no measurement
  --speakers <n>                  the cap to ask the engine for (default 2)
  --data-dir <path>               where the meetings live (default ./data)
`;

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.has('help') || args.size === 0) {
    console.log(USAGE);
    return args.size === 0 ? 1 : 0;
  }
  const setting = args.get('setting')?.[0] ?? 'unstated';
  const maxSpeakers = Number(args.get('speakers')?.[0] ?? '2');

  if (args.has('meeting') || args.has('doc')) {
    const truthFile = args.get('truth')?.[0];
    if (!truthFile) {
      console.error('Scoring a recorded meeting needs the --truth script that was read.');
      return 1;
    }
    const dataDir = args.get('data-dir')?.[0] ?? defaultDataDir();
    const docId = args.get('doc')?.[0];
    if (!docId) {
      console.error('--doc <docId> says which doc the meeting was recorded over.');
      return 1;
    }
    const known = listMeetings(dataDir, docId);
    // Latest by default: the run just made is the one being scored, and
    // making somebody copy an id out of a filename to score it is friction
    // in the middle of a measurement.
    const meetingId = args.get('meeting')?.[0] ?? known[known.length - 1]?.meetingId;
    if (!meetingId) {
      console.error(`No meetings for ${docId} under ${dataDir}. Is --data-dir right?`);
      return 1;
    }
    const path = meetingTranscriptPath(dataDir, docId, meetingId);
    if (!existsSync(path)) {
      console.error(`No transcript at ${path}.`);
      return 1;
    }
    const record = known.find((m) => m.meetingId === meetingId);
    const turns = readTranscript(dataDir, docId, meetingId);
    const score = scoreDiarization(turns, parseTruth(readFileSync(truthFile, 'utf8')));
    console.log(`\nRecorded meeting ${meetingId}`);
    console.log(`  data dir: ${dataDir}`);
    console.log(`  capture mode: ${record?.mode ?? 'unknown'}`);
    console.log(`  microphone settings: ${setting}\n`);
    console.log(formatScore(docId, score));
    return score.speakersInvented > 0 ? 1 : 0;
  }

  const dir = mkdtempSync(join(tmpdir(), 'room-labels-'));
  try {
    let audioFile: string;
    let truth: TruthUtterance[];
    let synthetic = false;
    if (args.has('synthetic')) {
      if (!has('say') || !has('ffmpeg')) {
        console.error('--synthetic needs macOS `say` and ffmpeg on PATH.');
        return 1;
      }
      const built = synthesizeRoom(dir);
      audioFile = built.file;
      truth = SYNTHETIC_SCRIPT.map((t) => ({ speaker: t.speaker, text: t.line }));
      synthetic = true;
      console.log(`Built a ${built.seconds.toFixed(1)}s synthetic two-voice room.`);
    } else {
      const file = args.get('audio')?.[0];
      const truthFile = args.get('truth')?.[0];
      if (!file || !truthFile) {
        console.error('--audio needs both the file and the --truth script.');
        return 1;
      }
      audioFile = file;
      truth = parseTruth(readFileSync(truthFile, 'utf8'));
    }

    const emulations = args.get('emulate') ?? [];
    const used = emulations.length > 0 ? emulate(audioFile, emulations, dir) : audioFile;
    const pcm = toMeetingPcm(used, dir);
    const seconds = pcm.length / 2 / MEETING_SAMPLE_RATE;
    console.log(
      args.has('mock')
        ? `Running ${seconds.toFixed(1)}s through the MOCK engine — harness only, no measurement.`
        : `Speaking ${seconds.toFixed(1)}s through the real engine with max_speakers=${maxSpeakers}…`,
    );
    const mocked = args.has('mock') ? truth : undefined;
    const turns = await transcribe(pcm, maxSpeakers, mocked);
    for (const t of turns) console.log(`  ${t.speaker ?? '(unattributed)'}  ${t.text}`);
    const score = scoreDiarization(turns, truth, DEFAULT_SCORING);
    const flags = [
      args.has('mock') ? 'MOCK ENGINE — proves the harness, measures nothing' : null,
      synthetic ? 'SYNTHETIC FIXTURE — two TTS voices, not a room' : null,
      emulations.length > 0 ? `EMULATED: ${emulations.join(', ')} (ffmpeg, not the browser)` : null,
      `microphone settings: ${setting}`,
    ].filter(Boolean);
    console.log(`\n${flags.join('\n')}\n`);
    console.log(formatScore(audioFile, score));
    return score.speakersInvented > 0 || score.speakersPredicted < score.speakersTruth ? 1 : 0;
  } finally {
    // Only the scratch directory goes; anything the caller passed in is theirs.
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
