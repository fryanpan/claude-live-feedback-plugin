/**
 * Does the ENGINE actually separate two voices? Run this to find out.
 *
 * Every automated test of speaker labels in this repo drives the mock
 * engine. That proves the plumbing — label on the wire, in the record, in
 * the notes, and the rename that rewrites them — and it cannot prove the one
 * thing only AssemblyAI can do, which is hear two people and say which is
 * which. This script closes that gap, and is separate from the test suite
 * for the reason `createServer` builds no engine: nothing that merely runs
 * the tests may open a metered session.
 *
 *   bun run scripts/diarize-check.ts
 *
 * It needs `ASSEMBLYAI_API_KEY` in the environment or the `assemblyai-api-key`
 * Keychain entry — the same resolution order the server uses. Without one it
 * says so and exits 1 rather than pretending. The key is never printed.
 *
 * COST: a streaming session is billed on the seconds the socket is open, not
 * on the audio sent, so this costs about the length of the script it speaks —
 * measured at 14.1s, which at $0.27/hr with speaker labels is $0.001. See
 * docs/architecture/meeting-assistant.md for the rates it comes from.
 *
 * The two voices are macOS `say` voices, which is a real two-speaker signal
 * through the real engine but an easier one than two people on a laptop mic:
 * synthetic voices are cleanly separated and never talk over each other.
 * Read a pass here as "the engine diarizes and the adapter maps it", not as
 * a measurement of accuracy in a room.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MEETING_SAMPLE_RATE } from '../packages/core/src/meeting.ts';
import { createAssemblyAiEngine } from '../packages/server/src/transcribe-assemblyai.ts';

/** Two voices, alternating, each saying enough to be attributed — turns
 *  under about a second of audio come back as a placeholder label. */
const SCRIPT: ReadonlyArray<{ voice: string; line: string }> = [
  { voice: 'Alex', line: 'So the sync step is what is holding the whole import up, I think.' },
  {
    voice: 'Samantha',
    line: 'Let us measure it before we rewrite anything, because I am not sure.',
  },
  { voice: 'Alex', line: 'That is fair. I will get numbers together by Thursday afternoon.' },
  { voice: 'Samantha', line: 'Good. Then we can decide whether it is worth the rewrite at all.' },
];

function run(cmd: string, args: string[]): void {
  const proc = spawnSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (proc.status !== 0) {
    throw new Error(`${cmd} failed: ${proc.stderr?.toString('utf8').trim() ?? proc.status}`);
  }
}

/**
 * Speak the script into one raw PCM16 mono stream at the meeting's rate —
 * exactly what the browser sends, so the engine sees nothing special.
 *
 * Exported, and `main` runs only when this file IS the entry point, so the
 * half of this script that needs no key and no network can be run on its own
 * by anyone checking the audio is real before spending on a session.
 */
export function synthesize(dir: string): Uint8Array {
  const parts: Uint8Array[] = [];
  SCRIPT.forEach((turn, i) => {
    const aiff = join(dir, `turn-${i}.aiff`);
    const raw = join(dir, `turn-${i}.raw`);
    run('say', ['-v', turn.voice, '-o', aiff, turn.line]);
    // No --data-format here: afconvert on macOS 15 rejects it outright, and
    // -d already says LEI16. Found by running this, not by reading man.
    run('afconvert', [aiff, raw, '-f', 'caff', '-d', `LEI16@${MEETING_SAMPLE_RATE}`, '-c', '1']);
    // afconvert writes a CAF container. Locate the audio chunk rather than
    // assuming a fixed header: 12 bytes of chunk header ('data' + an int64
    // size) then 4 bytes of mEditCount before the samples begin.
    const buf = readFileSync(raw);
    const at = buf.indexOf(Buffer.from('data', 'ascii'));
    if (at < 0) throw new Error('no data chunk in the converted audio');
    parts.push(new Uint8Array(buf.subarray(at + 16)));
  });
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function main(): Promise<number> {
  const engine = createAssemblyAiEngine();
  if (!engine) {
    console.error(
      'No AssemblyAI key. Set ASSEMBLYAI_API_KEY, or add the assemblyai-api-key\n' +
        'Keychain entry, then run this again. Nothing was sent.',
    );
    return 1;
  }

  const dir = mkdtempSync(join(tmpdir(), 'diarize-'));
  let audio: Uint8Array;
  try {
    audio = synthesize(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const seconds = audio.length / 2 / MEETING_SAMPLE_RATE;
  console.log(`Speaking ${seconds.toFixed(1)}s of two-voice audio through the real engine…\n`);

  const settled = new Map<number, { text: string; speaker?: string }>();
  const session = await engine.open({
    sampleRate: MEETING_SAMPLE_RATE,
    onTurn: (t) => {
      if (t.final)
        settled.set(t.turn, { text: t.text, ...(t.speaker ? { speaker: t.speaker } : {}) });
    },
    onError: (m) => console.error(`engine: ${m}`),
  });

  // Paced at real time: the session is billed on wall-clock seconds and the
  // engine's turn detection is built for speech arriving as it is spoken.
  const FRAME = MEETING_SAMPLE_RATE / 10; // 100ms of samples
  for (let i = 0; i < audio.length; i += FRAME * 2) {
    session.send(audio.subarray(i, Math.min(i + FRAME * 2, audio.length)));
    await new Promise((r) => setTimeout(r, 100));
  }
  await session.close();

  const turns = [...settled.entries()].sort((a, b) => a[0] - b[0]).map(([, v]) => v);
  for (const t of turns) console.log(`  ${t.speaker ?? '(unlabelled)'}  ${t.text}`);

  const voices = new Set(turns.map((t) => t.speaker).filter(Boolean));
  console.log(
    `\n${turns.length} settled turns, ${voices.size} distinct speaker(s): ${[...voices].join(', ') || 'none'}`,
  );
  if (voices.size >= 2) {
    console.log('PASS — the engine separated the voices and the adapter carried the labels.');
    return 0;
  }
  console.log('FAIL — expected at least two distinct speaker labels.');
  return 1;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
