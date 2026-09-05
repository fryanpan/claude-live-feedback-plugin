/**
 * How long a finished sentence waits before it is in the notes — SPLIT into
 * the two waits that make it up, because they have different fixes.
 *
 *   endpoint lag  = the speaker stops → the engine emits the settled turn.
 *                   Paid inside the vendor's endpoint detector. Measured on
 *                   the real wire by `scripts/endpoint-latency-check.ts`; fed
 *                   in here as `--endpoint-lag`, because this harness has no
 *                   engine in it.
 *   compose lag   = settled turn → the note carrying it reaches the sink.
 *                   Paid by the notes clocks (quiet threshold and cadence
 *                   ceiling) and measured here, on a virtual clock.
 *   total         = the two together, which is the wait a person actually
 *                   feels and the only one worth quoting on its own.
 *
 * Splitting them is the point. The totals moved by tuning an endpoint
 * detector and by moving the notes clocks look identical in a single column,
 * and only one of those is on the table at any given moment — the clocks are
 * held at 4s quiet / 15s cadence deliberately (Bryan, 2026-09-04), so a
 * number that cannot say which half it came from cannot say whether the work
 * that was allowed to happen did anything.
 *
 * THE ENDPOINT LAG IS NOT MERELY ADDED ON. A turn that settles later also
 * starts the quiet timer later, so it can push the whole tick past a cadence
 * boundary. That is why it is modelled inside the script — the settled frame
 * is delivered to `beginNotesSession` at `speech end + endpoint lag` — rather
 * than added to the answer afterwards.
 *
 * It runs the same script under two endpoint lags, so the columns are a
 * before/after of an endpointing change with the notes clocks held still:
 *
 *   bun run scripts/notes-latency-check.ts [--minutes 3] [--json]
 *   bun run scripts/notes-latency-check.ts --endpoint-lag 485 --endpoint-lag-after 211
 *
 * WHY A VIRTUAL CLOCK RATHER THAN A REAL MEETING. A real meeting cannot be
 * replayed identically, so a before/after taken from two of them measures the
 * conversation as much as the code. Here the frame times are the script's, so
 * the two runs differ in one thing only.
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
  /**
   * On a settled frame, when the speaker actually stopped. The frame itself
   * arrives one endpoint lag later; the difference is what this script
   * exists to keep apart.
   */
  speechEndAt?: number;
}

/**
 * The two endpoint lags the columns are built from, both measured on the real
 * Soniox wire by `scripts/endpoint-latency-check.ts --fixture trailing`
 * (15 turns per setting, word recall 100% for both):
 *
 *   BEFORE — the vendor default the adapter used to leave alone.
 *   AFTER  — `endpoint_latency_adjustment_level: 2`, now sent on every
 *            session (`DEFAULT_ENDPOINT_LATENCY_ADJUSTMENT`).
 *
 * Medians, not p90: the p90 barely moved (503ms → 508ms), so quoting the tail
 * here would claim an improvement the wire did not show.
 */
const ENDPOINT_LAG_BEFORE_MS = 485;
const ENDPOINT_LAG_AFTER_MS = 211;

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
function buildScript(durationMs: number, pauseAtMs: number, endpointLagMs: number): ScriptFrame[] {
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
    // The speaker stops HERE; the settled frame lands one endpoint lag later.
    // The next speaker does not wait for it — a breath after the mouth
    // closes, not after the engine agrees — so a long enough lag delivers a
    // settled turn in the middle of the next person's partials, which is
    // exactly what it does in a real meeting.
    frames.push({
      at: at + endpointLagMs,
      speechEndAt: at,
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
  // The lag reorders the stream, so the driver's "advance to this time" loop
  // needs it back in the order a socket would have delivered it.
  return frames.sort((a, b) => a.at - b.at);
}

interface RunResult {
  label: string;
  sentences: number;
  notesWritten: number;
  /** Endpoint lag this run was driven with — an input, restated. */
  endpointLagMs: number;
  /** Settled turn → note written. What the notes clocks cost. */
  composeMs: number[];
  /** Speaker stopped → note written. What a person actually waits. */
  totalMs: number[];
}

async function run(
  label: string,
  script: ScriptFrame[],
  cadenceMs: number,
  endpointLagMs: number,
): Promise<RunResult> {
  const clock = new VirtualClock();
  const settledAt = new Map<number, number>();
  const spokeAt = new Map<number, number>();
  const composeMs: number[] = [];
  const totalMs: number[] = [];
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
          if (settled !== undefined) composeMs.push(clock.now - settled);
          const spoke = spokeAt.get(t.turn);
          if (spoke !== undefined) totalMs.push(clock.now - spoke);
        }
      },
    },
    { docId: 'doc-latency', meetingId: 'm-latency' },
  );

  for (const { at, frame, speechEndAt } of script) {
    await clock.advanceTo(at);
    if (frame.final) {
      settledAt.set(frame.turn, at);
      if (speechEndAt !== undefined) spokeAt.set(frame.turn, speechEndAt);
    }
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

  return { label, sentences: settledAt.size, notesWritten, endpointLagMs, composeMs, totalMs };
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

function summarize(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    measured: sorted.length,
    medianMs: Math.round(quantile(sorted, 0.5)),
    p90Ms: Math.round(quantile(sorted, 0.9)),
    maxMs: Math.round(sorted[sorted.length - 1] ?? Number.NaN),
  };
}

function stats(result: RunResult) {
  return {
    label: result.label,
    sentences: result.sentences,
    notesWritten: result.notesWritten,
    endpointLagMs: result.endpointLagMs,
    compose: summarize(result.composeMs),
    total: summarize(result.totalMs),
  };
}

/** `--flag value` pairs; a flag naming no number keeps its default. */
function numArg(args: readonly string[], flag: string, fallback: number): number {
  const at = args.indexOf(flag);
  if (at < 0) return fallback;
  const value = Number(args[at + 1]);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`${flag} must be a non-negative number of milliseconds`);
    process.exit(2);
  }
  return value;
}

const args = process.argv.slice(2);
const minutes = numArg(args, '--minutes', 3);
if (minutes <= 0) {
  console.error('--minutes must be a positive number');
  process.exit(2);
}
const lagBefore = numArg(args, '--endpoint-lag', ENDPOINT_LAG_BEFORE_MS);
const lagAfter = numArg(args, '--endpoint-lag-after', ENDPOINT_LAG_AFTER_MS);
// The notes clocks are NOT the subject here and default to the shipped ones.
// The ceiling stays overridable because turning it off is how this script
// originally showed what adding it bought.
const cadenceMs = args.includes('--cadence-off')
  ? Number.POSITIVE_INFINITY
  : numArg(args, '--cadence', DEFAULT_NOTES_CADENCE_MS);
const asJson = args.includes('--json');

const durationMs = minutes * 60_000;

const before = stats(
  await run(
    `endpoint ${lagBefore}ms (before)`,
    buildScript(durationMs, durationMs / 2, lagBefore),
    cadenceMs,
    lagBefore,
  ),
);
const after = stats(
  await run(
    `endpoint ${lagAfter}ms (after)`,
    buildScript(durationMs, durationMs / 2, lagAfter),
    cadenceMs,
    lagAfter,
  ),
);

if (asJson) {
  console.log(
    JSON.stringify({ minutes, quietMs: DEFAULT_NOTES_QUIET_MS, cadenceMs, before, after }, null, 2),
  );
} else {
  const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  console.log(`Scripted meeting: ${minutes} min, ${before.sentences} settled sentences,`);
  console.log(
    `notes clocks held at quiet ${secs(DEFAULT_NOTES_QUIET_MS)} / cadence ${
      Number.isFinite(cadenceMs) ? secs(cadenceMs) : 'off'
    }, one real pause mid-meeting.`,
  );
  console.log('\n  run                        notes  endpoint   settled→note        speech→note');
  console.log(
    '                                                p50     p90      p50     p90     max',
  );
  for (const row of [before, after]) {
    console.log(
      `  ${row.label.padEnd(24)} ${String(row.notesWritten).padStart(5)}  ${secs(
        row.endpointLagMs,
      ).padStart(7)}  ${secs(row.compose.medianMs).padStart(7)} ${secs(row.compose.p90Ms).padStart(
        7,
      )}  ${secs(row.total.medianMs).padStart(7)} ${secs(row.total.p90Ms).padStart(7)} ${secs(
        row.total.maxMs,
      ).padStart(7)}`,
    );
  }
  const won = before.total.medianMs - after.total.medianMs;
  console.log(
    `\nEndpoint lag is ${((after.endpointLagMs / after.total.medianMs) * 100).toFixed(
      0,
    )}% of the wait after the change (${(
      (before.endpointLagMs / before.total.medianMs) * 100
    ).toFixed(0)}% before); the median speech→note wait moved by ${won}ms.`,
  );
}
