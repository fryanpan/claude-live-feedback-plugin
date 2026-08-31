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
   * Say it. Resolves `true` only when the browser reported the utterance
   * finished — anything else (no synthesis, an error, an utterance that never
   * came back) resolves `false`, which is the strip's cue to put the sentence
   * on screen for a person instead.
   */
  speak(text: string): Promise<boolean>;
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

  return {
    supported: () => synth !== null,
    prime(): void {
      if (!synth) return;
      try {
        // A space rather than an empty string: an empty utterance is dropped
        // without being queued by at least one engine, and a dropped
        // utterance unlocks nothing. Silent, so the tap makes no sound.
        const warm = makeUtterance(' ');
        warm.volume = 0;
        synth.speak(warm);
      } catch {
        // Priming is best-effort by construction. If it throws, `speak()`
        // will fail too and the fallback picks it up there, where there is
        // somewhere to report it.
      }
    },
    speak(text: string): Promise<boolean> {
      if (!synth) return Promise.resolve(false);
      const attempt = ++generation;
      return new Promise<boolean>((resolve) => {
        let done = false;
        let cancelTimer: (() => void) | null = null;
        const settle = (ok: boolean): void => {
          if (done) return;
          done = true;
          cancelTimer?.();
          // A late event from an utterance this call has already replaced
          // resolves nothing: the newer announcement owns the answer.
          resolve(attempt === generation ? ok : false);
        };
        try {
          const utterance = makeUtterance(text);
          utterance.onend = () => settle(true);
          utterance.onerror = () => settle(false);
          // Anything already queued is a stale announcement; this one is the
          // meeting that is actually starting.
          synth.cancel();
          synth.speak(utterance);
          cancelTimer = timer(() => settle(false), SPEECH_TIMEOUT_MS);
        } catch {
          settle(false);
        }
      });
    },
    cancel(): void {
      generation += 1;
      try {
        synth?.cancel();
      } catch {
        // Cancelling a queue that is already gone is not a failure.
      }
    },
  };
}
