/**
 * The seam a meeting's words arrive through, and the deterministic engine the
 * tests speak to.
 *
 * WHY THE ENGINE IS A PARAMETER AND NEVER A DEFAULT. A streaming speech model
 * is a paid service on a socket that stays open for the length of a meeting.
 * The same seam rule the summarizer earned the hard way applies here with a
 * larger bill attached: `createServer` must be constructible without anything
 * that can reach the network, or every server a test spins up starts opening
 * billed sessions. Only `bin.ts` builds a real engine.
 *
 * WHY A TURN IS THE UNIT. Every streaming model of this shape emits the WHOLE
 * turn as currently understood rather than a delta, and revises it in place
 * until it settles — that is how a mis-heard word gets corrected after it is
 * already on screen. The seam preserves that shape instead of flattening it
 * to appended text, because flattening it is unrecoverable: once "sink" has
 * been concatenated onto the transcript, nothing downstream can turn it back
 * into "sync".
 */

/** One live connection to a transcription engine. */
export interface TranscriptionSession {
  /** Feed one chunk of PCM16LE mono audio. */
  send(audio: Uint8Array): void;
  /** Stop; resolves once the engine has flushed any final turn. */
  close(): Promise<void>;
}

/**
 * One turn of speech as the seam reports it. `text` is the whole turn, not a
 * delta: a later report with the same `turn` replaces the earlier one.
 */
export interface EngineTurn {
  turn: number;
  text: string;
  final: boolean;
  /**
   * The engine's own label for who said this turn — `"A"`, `"B"` — when
   * diarization gave one. Absent while the engine is still deciding (a turn
   * under about a second of audio) and on engines without the feature. It
   * is an identity WITHIN one session, never across meetings: the person
   * names a label once per meeting, and that map lives with the meeting.
   */
  speaker?: string;
  /**
   * Audio offset, in milliseconds of the engine's own stream, of the END of
   * the last word in `text`. The instant being measured when this frame's
   * latency is priced — see `meeting-timing.ts` for why an offset rather
   * than the word itself is the correlation key. Absent on an engine that
   * reports no word timings (the mock).
   */
  audioEndMs?: number;
  /**
   * Server clock when this frame arrived from the engine. Recorded by the
   * adapter rather than by the relay because the relay sees it only after
   * whatever the adapter did with it, and the vendor leg is the biggest
   * number in the budget — it must not absorb our own mapping cost.
   */
  engineMs?: number;
}

export interface TranscriptionOpenOpts {
  sampleRate: number;
  onTurn: (turn: EngineTurn) => void;
  onError: (message: string) => void;
}

export interface TranscriptionEngine {
  readonly name: string;
  open(opts: TranscriptionOpenOpts): Promise<TranscriptionSession>;
}

/**
 * One scripted turn for the mock engine: the words it reveals, and what the
 * turn settles to once the engine stops revising it.
 */
export interface MockScriptTurn {
  /** Revealed one word per audio chunk, the way a live engine grows a turn. */
  words: string[];
  /**
   * What the turn settles to. Differing from the words is the POINT — it is
   * the only way a test sees a word that is already on screen get rewritten,
   * which is the behaviour the whole turn-shaped contract exists to carry.
   * Defaults to the words joined by spaces.
   */
  settled?: string;
  /** The label every frame of this turn carries, as a diarizing engine would. */
  speaker?: string;
}

/**
 * The default script. "sink" → "sync" is a real in-place correction and the
 * punctuation appears with it, which is what a formatted final looks like on
 * every engine of this class.
 */
export const DEFAULT_MOCK_SCRIPT: readonly MockScriptTurn[] = [
  {
    words: ['so', 'the', 'sink', 'is', 'the', 'bottleneck'],
    settled: 'So the sync is the bottleneck.',
  },
  {
    words: ['lets', 'measure', 'it', 'before', 'we', 'rewrite', 'anything'],
    settled: "Let's measure it before we rewrite anything.",
  },
];

/**
 * A transcription engine with no network, no timers and no randomness: it
 * advances exactly one step per audio chunk it is handed.
 *
 * Driven by the chunks rather than by a clock so a test asserts a sequence
 * instead of waiting for one. A timer-driven mock would make every test that
 * touches a meeting either slow or flaky, and the thing under test here — a
 * partial being replaced in place — is precisely the thing a race hides.
 */
export function createMockTranscriptionEngine(
  script: readonly MockScriptTurn[] = DEFAULT_MOCK_SCRIPT,
): TranscriptionEngine {
  return {
    name: 'mock',
    open(opts: TranscriptionOpenOpts): Promise<TranscriptionSession> {
      let index = 0;
      let revealed = 0;
      let closed = false;

      const settle = (): void => {
        const turn = script[index];
        if (!turn) return;
        const whole = revealed >= turn.words.length;
        const text = whole
          ? (turn.settled ?? turn.words.join(' '))
          : turn.words.slice(0, revealed).join(' ');
        opts.onTurn({ turn: index, text, final: true, ...speakerOf(turn) });
        index++;
        revealed = 0;
      };
      const speakerOf = (turn: MockScriptTurn): { speaker?: string } =>
        turn.speaker !== undefined ? { speaker: turn.speaker } : {};

      return Promise.resolve({
        send(): void {
          if (closed) return;
          const turn = script[index];
          if (!turn) return;
          if (revealed < turn.words.length) {
            revealed++;
            opts.onTurn({
              turn: index,
              text: turn.words.slice(0, revealed).join(' '),
              final: false,
              ...speakerOf(turn),
            });
            return;
          }
          settle();
        },
        close(): Promise<void> {
          if (closed) return Promise.resolve();
          closed = true;
          // A meeting stopped mid-sentence still has to leave the words that
          // were actually said in the transcript. Dropping the open turn on
          // close would silently lose whatever was being said when the human
          // pressed stop, which is the sentence most likely to matter.
          if (revealed > 0) settle();
          return Promise.resolve();
        },
      });
    },
  };
}
