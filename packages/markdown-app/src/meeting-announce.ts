/**
 * Saying the recording announcement out loud, from the browser.
 *
 * WHY THIS IS ITS OWN FILE. Speech synthesis is the one part of the
 * announcement that can fail in ways nobody watching the strip would guess:
 * a browser with no `speechSynthesis` at all, an iPad that will not speak
 * until a finger has touched the page, an engine that accepts an utterance
 * and then never fires an event for it. Each of those has to end as "a person
 * reads the sentence instead" rather than as a room that was never told, and
 * that decision is easier to test as a function than as a branch inside the
 * strip.
 *
 * THE GESTURE, AND WHY THERE IS A PRIME STEP. On iOS Safari — Bryan's main
 * device — `speak()` is ignored unless it is reached from inside a user
 * gesture's own task. The announcement cannot be spoken there: it has to land
 * in the CAPTURED audio, so the microphone must already be open, and opening
 * it means awaiting `getUserMedia`, by which point the gesture is spent. So
 * the tap primes instead — one silent utterance, synchronously, which is what
 * unlocks the queue — and the real sentence is spoken later, after the mic is
 * live. Priming is the same trick an AudioContext needs and for the same
 * reason.
 *
 * MUTE IS NOT THE SAME FAILURE AS THE OTHERS. Reported from a real iPad,
 * 2026-08-30: the Board's "Record a conversation" button navigates to the doc
 * and the strip starts the mic without a press, so nothing ever primes and the
 * queue is still locked when the sentence is handed to it. WebKit does not
 * refuse that — it accepts the utterance and simply never begins it. Told
 * apart from every other failure (`mute` rather than `failed`) because it is
 * the only one a tap can still fix, and because waiting out the twelve-second
 * end timeout to discover it leaves a room standing in silence.
 *
 * AND THE QUEUE IS NOT CLEARED ON THE WAY IN. `cancel()` immediately before
 * `speak()` is a known way to lose an utterance on Safari, and on the path
 * that matters — an auto-started meeting, nothing queued — the cancel was
 * clearing nothing. It now runs only when an earlier announcement is actually
 * still in progress, which is the case it was written for.
 *
 * NOTHING HERE CHOOSES A VOICE. `getVoices()` is asynchronous on first call in
 * several browsers and empty until it resolves, so picking one means either
 * waiting (delaying the announcement past the start of the conversation) or
 * racing it. The default voice is the one the device's owner already chose.
 */

/** The slice of `speechSynthesis` this module uses. */
export interface SpeechSynthesisLike {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

/**
 * How long an utterance gets to report itself finished before the fallback
 * runs.
 *
 * There IS a browser bug behind this number rather than mere caution:
 * `speak()` can accept an utterance and fire neither `end` nor `error` — most
 * reliably on a page that has just been restored, and on Safari after a
 * `cancel()`. A promise that waits forever on that event would leave the
 * strip claiming an announcement is in progress for the length of the
 * meeting. Twelve seconds is several times the sentence's own length at any
 * speaking rate, so a slow voice is never cut off by it.
 */
export const SPEECH_TIMEOUT_MS = 12_000;

/**
 * How long an utterance gets to BEGIN before it is treated as one the browser
 * is never going to say.
 *
 * A locked iOS queue gives no event at all, so the only evidence that speech
 * is not happening is that none has started — and the room is waiting through
 * every second of it. Long enough that a voice which has to load first is not
 * cut off (measured in the hundreds of milliseconds, worst case around one
 * second on a cold Safari), short enough that the fallback is on screen while
 * the meeting is still starting rather than a quarter of a minute into it.
 */
export const SPEECH_START_TIMEOUT_MS = 2_500;

/**
 * What became of the sentence.
 *
 * `mute` is the one worth its own name: the utterance was accepted and never
 * began, which is what an un-primed iOS queue looks like from here and the
 * only outcome a tap can still turn into speech. Everything else — no engine,
 * a throw, an error event, an utterance that started and never finished — is
 * `failed`, and the sentence goes on screen for a person instead.
 */
export type SpeechOutcome = 'spoke' | 'mute' | 'failed';

export interface AnnouncerDeps {
  /** Defaults to `window.speechSynthesis`, or null where there is none. */
  synth?: SpeechSynthesisLike | null;
  /** Defaults to `new SpeechSynthesisUtterance(text)`. */
  utterance?: (text: string) => SpeechSynthesisUtterance;
  /** Defaults to `setTimeout`; returns a canceller. */
  timer?: (fn: () => void, ms: number) => () => void;
}

export interface Announcer {
  /** Whether anything here can speak at all. */
  supported(): boolean;
  /**
   * Unlock the speech queue from inside a user gesture. Safe to call more
   * than once and free to call where it is not needed — a browser that never
   * required a gesture simply speaks a silent utterance.
   */
  prime(): void;
  /**
   * Whether a gesture has already been spent on the unlock. The strip asks
   * before offering a tap: a queue nothing has primed is one a tap can still
   * unlock, and a queue that was primed and stayed silent is a dead end that
   * must not be dressed up as a button.
   */
  primed(): boolean;
  /**
   * Say it. `spoke` only when the browser reported the utterance finished;
   * `mute` when it never began, which a tap may still fix; `failed` for
   * everything else. Both of the latter are the strip's cue to put the
   * sentence on screen for a person.
   */
  speak(text: string): Promise<SpeechOutcome>;
  /** Stop anything in progress. A meeting stopped mid-sentence says no more. */
  cancel(): void;
}

function defaultSynth(): SpeechSynthesisLike | null {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesisLike }).speechSynthesis;
  // `SpeechSynthesisUtterance` and `speechSynthesis` ship together, but the
  // constructor is what actually gets used below, so both are checked here
  // rather than throwing later inside the promise.
  const Utterance = (globalThis as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
  return synth && typeof Utterance === 'function' ? synth : null;
}

function defaultUtterance(text: string): SpeechSynthesisUtterance {
  return new SpeechSynthesisUtterance(text);
}

function defaultTimer(fn: () => void, ms: number): () => void {
  const id = setTimeout(fn, ms);
  return () => clearTimeout(id);
}

/**
 * The announcer the strip uses.
 *
 * Everything it touches is injectable because none of it exists in a test
 * environment and all of it is the part worth checking: that a missing engine
 * is a `false` and not a throw, that an utterance which never answers still
 * resolves, and that a second `speak()` cancels the first rather than queuing
 * behind it.
 */
export function createAnnouncer(deps: AnnouncerDeps = {}): Announcer {
  const synth = deps.synth === undefined ? defaultSynth() : deps.synth;
  const makeUtterance = deps.utterance ?? defaultUtterance;
  const timer = deps.timer ?? defaultTimer;

  /**
   * Which `speak()` call owns the queue. A stop, or a second start, must not
   * let an earlier utterance's late `end` event resolve as though the current
   * announcement had finished.
   */
  let generation = 0;

  /**
   * Which `speak()` still has an utterance the engine might be working on, or
   * 0 for a quiet queue. The pre-emptive `cancel()` is spent only on this —
   * see the note at the top about losing an utterance to a cancel that had
   * nothing to clear.
   */
  let pendingAttempt = 0;

  /** Set once a prime actually reached the engine. A prime that threw
   *  unlocked nothing, so it may not claim to have. */
  let hasPrimed = false;

  return {
    supported: () => synth !== null,
    primed: () => hasPrimed,
    prime(): void {
      if (!synth) return;
      try {
        // A space rather than an empty string: an empty utterance is dropped
        // without being queued by at least one engine, and a dropped
        // utterance unlocks nothing. Silent, so the tap makes no sound.
        const warm = makeUtterance(' ');
        warm.volume = 0;
        synth.speak(warm);
        hasPrimed = true;
      } catch {
        // Priming is best-effort by construction. If it throws, `speak()`
        // will fail too and the fallback picks it up there, where there is
        // somewhere to report it.
      }
    },
    speak(text: string): Promise<SpeechOutcome> {
      if (!synth) return Promise.resolve('failed');
      const attempt = ++generation;
      return new Promise<SpeechOutcome>((resolve) => {
        let done = false;
        let cancelEnd: (() => void) | null = null;
        let cancelStart: (() => void) | null = null;
        /** Take it out of the queue, whatever state the engine left it in. */
        const clear = (): void => {
          try {
            synth.cancel();
          } catch {
            // Then it was never going to speak anyway.
          }
        };
        const settle = (outcome: SpeechOutcome): void => {
          if (done) return;
          done = true;
          cancelEnd?.();
          cancelStart?.();
          if (pendingAttempt === attempt) pendingAttempt = 0;
          // A late event from an utterance this call has already replaced
          // resolves nothing: the newer announcement owns the answer.
          resolve(attempt === generation ? outcome : 'failed');
        };
        try {
          const utterance = makeUtterance(text);
          // The engine opening its mouth, which is the whole of what the
          // start timeout is watching for.
          utterance.onstart = () => {
            cancelStart?.();
            cancelStart = null;
          };
          utterance.onend = () => settle('spoke');
          utterance.onerror = () => settle('failed');
          // Only a stale announcement still in progress is worth clearing;
          // a cancel with nothing to cancel can cost this utterance instead.
          if (pendingAttempt !== 0) clear();
          pendingAttempt = attempt;
          synth.speak(utterance);
          cancelStart = timer(() => {
            // Accepted and never begun: the queue is locked, and nothing is
            // going to unlock it on its own. Cleared first so a tap that
            // primes later cannot set this one going over the sentence a
            // person has by then been asked to read.
            clear();
            settle('mute');
          }, SPEECH_START_TIMEOUT_MS);
          cancelEnd = timer(() => {
            // Take it out of the queue before answering. The timeout means
            // the engine never said what happened — not that it did nothing,
            // and an utterance still sitting in the queue can start speaking
            // after the strip has already put the sentence on screen for a
            // person. Two announcements over each other is worse than either.
            clear();
            settle('failed');
          }, SPEECH_TIMEOUT_MS);
        } catch {
          settle('failed');
        }
      });
    },
    cancel(): void {
      generation += 1;
      pendingAttempt = 0;
      try {
        synth?.cancel();
      } catch {
        // Cancelling a queue that is already gone is not a failure.
      }
    },
  };
}
