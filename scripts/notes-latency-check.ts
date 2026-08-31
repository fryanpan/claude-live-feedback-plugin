/**
 * How long a finished sentence waits before it is in the notes.
 *
 * "The notes lag" is an impression; this prints a number instead. It drives a
 * SCRIPTED transcript through the real `beginNotesSession` on a virtual clock
 * — no microphone, no engine, no LLM, no wall-clock waiting — and measures,
 * per sentence, the gap between the turn settling and the note carrying it
 * reaching the sink.
 *
 * It runs the same script twice: once with the cadence ceiling off
 * (`cadenceMs: Infinity`), which is exactly how the composer behaved before
 * the ceiling existed, and once with the shipped default. The difference
 * between the two columns is the change's effect, measured on one input.
 *
 * WHY A VIRTUAL CLOCK RATHER THAN A REAL MEETING. A real meeting cannot be
 * replayed identically, so a before/after taken from two of them measures the
 * conversation as much as the code. Here the frame times are the script's, so
 * the two runs differ in one thing only.
 *
 *   bun run scripts/notes-latency-check.ts [--minutes 3] [--json]
 *
 * All speech in the script is synthetic. The repo is public.
 */

import {
  DEFAULT_NOTES_CADENCE_MS,
  DEFAULT_NOTES_QUIET_MS,
  type TickScheduler,
  beginNotesSession,
  createStubNotesComposer,
} from '../packages/server/src/meeting-notes.ts';
import type { EngineTurn } from '../packages/server/src/transcribe.ts';

/** Let the compose chain's microtasks settle without moving the clock. */
const drain = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A clock the driver advances by hand; timers fire by deadline, not by the
 *  order they were set. */
class VirtualClock implements TickScheduler {
  now = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private n = 0;

  set(fn: () => void, ms: number): unknown {
    this.n++;
    this.timers.set(this.n, { at: this.now + ms, fn });
    return this.n;
  }

  clear(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /**
   * Move to `at`, running every timer that comes due on the way — and
   * letting each one's compose chain finish BEFORE the clock moves past its
   * deadline. Without that await the notes a timer produced would be stamped
   * with whenever the next frame happened to arrive, which turned a 4s pause
   * tick into a measured 6.3s during a gap in speech: an artifact of the
   * harness, charged to the code under test.
   */
  async advanceTo(at: number): Promise<void> {
    while (true) {
      let dueHandle: number | null = null;
      let dueAt = Number.POSITIVE_INFINITY;
      for (const [handle, timer] of this.timers) {
        if (timer.at <= at && timer.at < dueAt) {
          dueAt = timer.at;
          dueHandle = handle;
        }
      }
      if (dueHandle === null) break;
      const timer = this.timers.get(dueHandle);
      this.timers.delete(dueHandle);
      this.now = dueAt;
      timer?.fn();
      await drain();
    }
    this.now = Math.max(this.now, at);
  }
}

/** One scripted frame: what the engine emits, and when. */
interface ScriptFrame {
  at: number;
  frame: EngineTurn;
}

const SENTENCES = [
  'The sync is the slowest thing on the page.',
  'We measured it at about four hundred milliseconds.',
  'Most of that is the parse, not the network.',
  'So caching the response would not help much.',
  'Agreed, the parse is where the time goes.',
  'Can we parse incrementally instead?',
  'That is a bigger change than it sounds.',
  'Then let us measure before we rewrite anything.',
  'I will put the numbers on the ticket today.',
  'One more thing about the notes latency.',
  'They only appear once somebody stops talking.',
  'Which in a busy meeting is basically never.',
];

/**
 * A meeting where people talk over each other's breaths: each turn runs ~6s
 * with partials throughout, and the next speaker starts ~300ms after the last
 * one settled — never the four seconds of quiet the pause tick waits for.
 * One genuine pause is scripted in the middle, so the "before" column is not
 * flattered by a script that made a pause tick impossible.
 */
function buildScript(durationMs: number, pauseAtMs: number): ScriptFrame[] {
  const TURN_MS = 6_000;
  const PARTIAL_EVERY_MS = 400;
  const BREATH_MS = 300;
  const REAL_PAUSE_MS = 6_000;
  const frames: ScriptFrame[] = [];
  let at = 0;
  let turn = 0;
  let pauseSpent = false;
  while (at < durationMs) {
    const text = SENTENCES[turn % SENTENCES.length] as string;
    const words = text.split(' ');
    // Partials: the unformatted, growing prefix this engine emits mid-turn.
    for (let i = PARTIAL_EVERY_MS; i < TURN_MS; i += PARTIAL_EVERY_MS) {
      const upto = Math.max(1, Math.round((words.length * i) / TURN_MS));
      frames.push({
        at: at + i,
        frame: {
          turn,
          text: words.slice(0, upto).join(' ').toLowerCase(),
          final: false,
          speaker: turn % 2 === 0 ? 'A' : 'B',
        },
      });
    }
    at += TURN_MS;
    frames.push({
      at,
      frame: { turn, text, final: true, speaker: turn % 2 === 0 ? 'A' : 'B' },
    });
    if (!pauseSpent && at >= pauseAtMs) {
      pauseSpent = true;
      at += REAL_PAUSE_MS;
    } else {
      at += BREATH_MS;
    }
    turn++;
  }
  return frames;
}

interface RunResult {
  label: string;
  sentences: number;
  notesWritten: number;
  latenciesMs: number[];
}

async function run(label: string, script: ScriptFrame[], cadenceMs: number): Promise<RunResult> {
  const clock = new VirtualClock();
  const settledAt = new Map<number, number>();
  const latenciesMs: number[] = [];
  let notesWritten = 0;

  const session = beginNotesSession(
    {
      composer: createStubNotesComposer(),
      quietMs: DEFAULT_NOTES_QUIET_MS,
      cadenceMs,
      schedule: clock,
      onNotes: (update) => {
        notesWritten++;
        for (const t of update.tick.turns) {
          const settled = settledAt.get(t.turn);
          if (settled !== undefined) latenciesMs.push(clock.now - settled);
        }
      },
    },
    { docId: 'doc-latency', meetingId: 'm-latency' },
  );

  for (const { at, frame } of script) {
    await clock.advanceTo(at);
    if (frame.final) settledAt.set(frame.turn, at);
    session.onTurn(frame);
    // The compose chain is a promise chain; a tick that fired at this instant
    // must reach the sink before the clock moves on, or its latency would be
    // charged to whenever the next frame happens to arrive.
    await drain();
  }
  // The meeting ends where the script ends: the tail flush is part of the
  // measurement, because under pause-only it is where most notes came from.
  const lastAt = script[script.length - 1]?.at ?? 0;
  await clock.advanceTo(lastAt);
  await session.end();
  await drain();

  return { label, sentences: settledAt.size, notesWritten, latenciesMs };
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (at - lo);
}

function stats(result: RunResult) {
  const sorted = [...result.latenciesMs].sort((a, b) => a - b);
  return {
    label: result.label,
    sentences: result.sentences,
    measured: sorted.length,
    notesWritten: result.notesWritten,
    medianMs: Math.round(quantile(sorted, 0.5)),
    p90Ms: Math.round(quantile(sorted, 0.9)),
    maxMs: Math.round(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

const args = process.argv.slice(2);
const minutesAt = args.indexOf('--minutes');
const minutes = minutesAt >= 0 ? Number(args[minutesAt + 1]) : 3;
if (!Number.isFinite(minutes) || minutes <= 0) {
  console.error('--minutes must be a positive number');
  process.exit(2);
}
const asJson = args.includes('--json');

const durationMs = minutes * 60_000;
const script = buildScript(durationMs, durationMs / 2);

const before = stats(await run('pause only (before)', script, Number.POSITIVE_INFINITY));
const after = stats(
  await run(`cadence ${DEFAULT_NOTES_CADENCE_MS}ms (after)`, script, DEFAULT_NOTES_CADENCE_MS),
);

if (asJson) {
  console.log(JSON.stringify({ minutes, quietMs: DEFAULT_NOTES_QUIET_MS, before, after }, null, 2));
} else {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  console.log(`Scripted meeting: ${minutes} min, ${before.sentences} settled sentences,`);
  console.log(`quiet threshold ${secs(DEFAULT_NOTES_QUIET_MS)}, one real pause mid-meeting.`);
  console.log('Sentence settled → note written:\n');
  console.log('  run                          notes   median      p90      max');
  for (const row of [before, after]) {
    console.log(
      `  ${row.label.padEnd(26)} ${String(row.notesWritten).padStart(5)}  ${secs(row.medianMs).padStart(7)}  ${secs(row.p90Ms).padStart(7)}  ${secs(row.maxMs).padStart(7)}`,
    );
  }
}
