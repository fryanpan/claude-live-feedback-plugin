/**
 * The two-clock detector: when is a "notes moment"?
 *
 * A pause — no new turn activity for `DEFAULT_NOTES_QUIET_MS` — or the
 * cadence ceiling, whichever comes first. The ceiling is not reset by speech,
 * because the pause clock alone means a conversation where nobody stops for
 * four seconds produces nothing until it ends. Read
 * [meeting-assistant.md](../../../docs/architecture/meeting-assistant.md)
 * before changing either number: both were set against a measured run of
 * `scripts/notes-latency-check.ts`, and a tick is two model calls.
 *
 * It knows nothing about notes, docs or models — turns in, ticks out, and
 * every timer through an injectable seam so a test asserts a sequence rather
 * than waiting out real quiet.
 *
 * THE END TICK IS THE ONE THAT CARRIES UNSETTLED WORDS. Every other tick
 * takes settled turns only, because there is always a next tick for the
 * sentence still being spoken. At `end()` there is not: the meeting is over,
 * and a turn that never settled would otherwise be words nobody ever reads
 * in the notes. So the ticker keeps the latest partial of each turn it has
 * not seen settle, and hands them to the final tick marked `partial` — the
 * composer is told they are mid-sentence rather than being left to read
 * unformatted text as finished speech.
 */

import type { NotesTurn } from './meeting-notes.ts';
import type { EngineTurn } from './transcribe.ts';

/**
 * Why a tick fired: the speaker went quiet, the cadence ceiling was reached
 * while they kept talking, or the meeting ended.
 */
export type NotesTickReason = 'pause' | 'cadence' | 'end';

/** One "notes moment": the new settled words since the previous tick. */
export interface NotesTick {
  /** 1-based, per meeting. */
  tick: number;
  reason: NotesTickReason;
  /**
   * Settled turns since the previous tick, in the order they settled — plus,
   * on an `end` tick and only there, the turns that were still being spoken
   * when the meeting stopped, each flagged `partial` and ordered after the
   * settled ones by turn number.
   */
  turns: NotesTurn[];
}

/**
 * The timer seam. Injectable for the same reason the mock engine advances
 * per chunk: a test asserts a sequence, never waits out real quiet.
 */
export interface TickScheduler {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTickScheduler: TickScheduler = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Long enough that a breath between sentences is not a pause, short enough
 * that notes land while the topic is still the topic.
 */
export const DEFAULT_NOTES_QUIET_MS = 4_000;

/**
 * The longest a finished sentence may wait for a note, however continuously
 * people are talking. Long enough that a tick still covers a stretch of
 * conversation worth summarizing rather than one sentence at a time — and
 * short enough that the notes read as keeping up rather than catching up
 * (owner's number, 2026-08-30: "about 15 seconds").
 *
 * Unlike `DEFAULT_NOTES_QUIET_MS` this is a CEILING, not a threshold: quiet
 * still fires sooner whenever it comes.
 */
export const DEFAULT_NOTES_CADENCE_MS = 15_000;

export interface PauseTickerOpts {
  /** How long the transcript stream must be quiet before a tick fires. */
  quietMs: number;
  /**
   * The ceiling on how long a settled turn waits, measured from the moment
   * it settled rather than from the last frame. Omitted or non-finite means
   * no ceiling — pause ticks only, which is what every meeting did before
   * this clock existed.
   */
  cadenceMs?: number;
  onTick: (tick: NotesTick) => void;
  /**
   * A settled turn the engine has changed its mind about AFTER its words
   * already went out in a tick.
   *
   * The ticker itself can do nothing with one — its delta is gone — so it
   * hands it up. Words still WAITING on a tick are patched in place below
   * and never reach here: they compose under the new label on their own,
   * which is not a correction, just the right answer arriving in time.
   */
  onRevised?: (revision: { turn: number; speaker?: string }) => void;
  schedule?: TickScheduler;
}

export interface PauseTicker {
  /** Every transcript frame, partials included — a partial defers the tick. */
  onTurn(turn: EngineTurn): void;
  /**
   * The meeting ended: flush any tail delta as a final `end` tick, including
   * whatever was still being said. Nothing is scheduled afterwards, so this
   * is the last chance the words have.
   */
  end(): void;
}

export function createPauseTicker(opts: PauseTickerOpts): PauseTicker {
  const schedule = opts.schedule ?? realTickScheduler;
  /**
   * Turn numbers already in a delta. An engine that settles the same turn
   * twice (the formatted-final quirk, should an adapter ever leak it) must
   * not double the words in the notes.
   */
  const seen = new Set<number>();
  let pending: NotesTurn[] = [];
  /**
   * The latest partial of each turn that has NOT settled yet.
   *
   * Every ordinary tick ignores this — a partial is unformatted, and the
   * sentence has a next tick to settle into. `end()` is the exception: there
   * is no next tick, so the words being spoken when the meeting stopped come
   * out here or nowhere. Keyed by turn so a growing partial replaces its own
   * earlier draft rather than stacking three prefixes of one sentence.
   */
  const unsettled = new Map<number, NotesTurn>();
  let timer: unknown = null;
  /**
   * The cadence countdown. Held separately from `timer` because the two
   * clocks answer different questions — `timer` asks "has speech stopped?"
   * and restarts on every frame, `cadence` asks "how long has the oldest
   * unwritten sentence been waiting?" and must not.
   */
  let cadence: unknown = null;
  let ticks = 0;
  let ended = false;
  const cadenceMs = opts.cadenceMs;
  const hasCadence = cadenceMs !== undefined && Number.isFinite(cadenceMs) && cadenceMs > 0;

  const disarm = (): void => {
    if (timer !== null) {
      schedule.clear(timer);
      timer = null;
    }
  };

  const disarmCadence = (): void => {
    if (cadence !== null) {
      schedule.clear(cadence);
      cadence = null;
    }
  };

  const fire = (reason: NotesTickReason): void => {
    // The words still being spoken ride the FINAL tick and no other: they
    // are unformatted, and every earlier tick has a successor that will
    // carry them properly once they settle.
    const tail =
      reason === 'end'
        ? [...unsettled.values()]
            .sort((a, b) => a.turn - b.turn)
            .map((t): NotesTurn => ({ ...t, partial: true }))
        : [];
    // Quiet with nothing new said is just quiet, not an empty tick.
    if (pending.length === 0 && tail.length === 0) return;
    const turns = [...pending, ...tail];
    pending = [];
    // Only the END tick consumes them. A pause or cadence tick that dropped
    // them would throw away the sentence in progress on every quiet moment
    // of the meeting, so the one turn this exists to save would be gone long
    // before the stop that was supposed to save it.
    if (tail.length > 0) unsettled.clear();
    // Whatever fired, the wait it was measuring is over: the next ceiling
    // starts from the next sentence to settle, not from this one.
    disarmCadence();
    ticks++;
    opts.onTick({ tick: ticks, reason, turns });
  };

  return {
    onTurn(turn: EngineTurn): void {
      if (ended) return;
      if (turn.final) {
        // Whatever this turn last looked like mid-flight, the settled text
        // supersedes it — and a turn that settles is never a tail.
        unsettled.delete(turn.turn);
        if (seen.has(turn.turn)) {
          // A settled turn arriving AGAIN is the engine's end-of-session
          // speaker pass changing its mind. One still waiting to compose
          // simply takes the new label. One that already went out in a tick
          // is a CORRECTION to words in the doc: the ticker has no delta
          // left to change, so it is reported up to the session, which can
          // find the mentions those words produced.
          const at = pending.findIndex((t) => t.turn === turn.turn);
          const waiting = pending[at];
          // Rebuilt rather than patched: a revision can take the label away
          // as well as change it, and an absent `speaker` is what "nobody"
          // looks like everywhere else on this path.
          if (waiting) {
            pending[at] = {
              turn: waiting.turn,
              text: waiting.text,
              ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
            };
          } else {
            opts.onRevised?.({
              turn: turn.turn,
              ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
            });
          }
        } else {
          seen.add(turn.turn);
          pending.push({
            turn: turn.turn,
            text: turn.text,
            ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
          });
          // The FIRST unwritten sentence starts the ceiling and later ones
          // join the same wait. Re-arming per sentence would push the clock
          // out on every one, which is the pause timer's failure with a
          // longer number on it.
          if (hasCadence && cadence === null) {
            cadence = schedule.set(() => {
              cadence = null;
              fire('cadence');
            }, cadenceMs);
          }
        }
      } else if (turn.text.trim().length > 0 && !seen.has(turn.turn)) {
        // A partial of a turn nobody has seen settle. Held only so `end()`
        // has something to say about the sentence that was interrupted; an
        // empty one says nothing and a turn already settled has better text.
        unsettled.set(turn.turn, {
          turn: turn.turn,
          text: turn.text,
          ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
        });
      }
      // Any frame is speech: replace whatever countdown was running. Only
      // the quiet one — a partial says the sentences already settled have
      // been waiting LONGER, never less long.
      disarm();
      timer = schedule.set(() => {
        timer = null;
        fire('pause');
      }, opts.quietMs);
    },
    end(): void {
      if (ended) return;
      ended = true;
      disarm();
      disarmCadence();
      fire('end');
    },
  };
}
