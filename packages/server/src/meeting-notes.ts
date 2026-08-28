/**
 * Pause-driven meeting notes: the quiet detector, the composer seam, and the
 * per-meeting session that joins them.
 *
 * WHY A PAUSE IS THE UNIT. Notes composed per turn would interrupt a thought
 * mid-argument; notes composed at the end would arrive after the meeting they
 * were for. A pause in speech is the moment a human note-taker writes, so the
 * detector watches the transcript stream — EVERY frame, partials included,
 * because a partial is speech in progress and therefore evidence there is no
 * pause — and fires only when the stream has been quiet for the threshold.
 *
 * WHY THE COMPOSER IS A SEAM WITH NO DEFAULT. The real composer is an LLM
 * call; same rule as `transcribe.ts` and the summarizer — `createServer` must
 * be constructible without anything that can reach the network. Only the
 * caller that starts the real server wires a real composer; tests wire the
 *
 * deterministic stub below.
 *
 * WHY THE COMPOSER RETURNS THE WHOLE NOTES, NOT A DELTA. Same shape as the
 * turn-shaped engine contract: notes are REVISED as a meeting develops — a
 * decision gets overturned ten minutes after it was noted — and a delta-only
 * contract could never take anything back. The input carries `previous` so a
 * composer that merely appends can, and one that restructures may.
 *
 * NOTHING HERE RIDES SSE. A tick per pause is word-rate-adjacent; ticks and
 * composed notes go to the injected `onNotes` sink only, and the stage that
 * writes them into the doc decides delivery (the CRDT, not the event hub).
 */

import type { EngineTurn } from './transcribe.ts';

/** One settled turn as a tick's delta carries it. */
export interface NotesTurn {
  turn: number;
  text: string;
}

/** Why a tick fired: the speaker went quiet, or the meeting ended. */
export type NotesTickReason = 'pause' | 'end';

/** One "notes moment": the new settled words since the previous tick. */
export interface NotesTick {
  /** 1-based, per meeting. */
  tick: number;
  reason: NotesTickReason;
  /** Settled turns since the previous tick, in the order they settled. */
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

export interface PauseTickerOpts {
  /** How long the transcript stream must be quiet before a tick fires. */
  quietMs: number;
  onTick: (tick: NotesTick) => void;
  schedule?: TickScheduler;
}

export interface PauseTicker {
  /** Every transcript frame, partials included — a partial defers the tick. */
  onTurn(turn: EngineTurn): void;
  /** The meeting ended: flush any tail delta as a final `end` tick. */
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
  let timer: unknown = null;
  let ticks = 0;
  let ended = false;

  const disarm = (): void => {
    if (timer !== null) {
      schedule.clear(timer);
      timer = null;
    }
  };

  const fire = (reason: NotesTickReason): void => {
    // Quiet with nothing new said is just quiet, not an empty tick.
    if (pending.length === 0) return;
    const turns = pending;
    pending = [];
    ticks++;
    opts.onTick({ tick: ticks, reason, turns });
  };

  return {
    onTurn(turn: EngineTurn): void {
      if (ended) return;
      if (turn.final && !seen.has(turn.turn)) {
        seen.add(turn.turn);
        pending.push({ turn: turn.turn, text: turn.text });
      }
      // Any frame is speech: replace whatever countdown was running.
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
      fire('end');
    },
  };
}

/**
 * What the composer may know about the project the meeting belongs to, so
 * the notes are informed rather than generic. Filled in by the stage that
 * builds the real composer; the shape exists now so the seam carries it.
 */
export interface NotesProjectContext {
  /** Root of the repo the meeting's doc belongs to. */
  repoRoot?: string;
  /** Docs worth reading before summarizing this project's meetings. */
  docPaths?: readonly string[];
  /** The workspace whose board names the work being discussed. */
  workspaceId?: string;
  /** The meeting doc's own title — the closest thing to a meeting subject. */
  docTitle?: string;
  /** Open board task titles — the names of the work under discussion, so the
   *  composer can hear "the balloons ticket" and know what that is. */
  taskTitles?: readonly string[];
}

export interface NotesComposeInput {
  docId: string;
  meetingId: string;
  tick: NotesTick;
  /** The notes as previously composed; null on a meeting's first tick. */
  previous: string | null;
  context?: NotesProjectContext;
}

export interface NotesComposer {
  readonly name: string;
  /** Returns the WHOLE notes markdown as it should now read — not a delta. */
  compose(input: NotesComposeInput): Promise<string>;
}

/**
 * The deterministic composer the tests speak to: no network, no randomness —
 * previous notes plus one bullet per new settled turn. Its determinism is
 * asserted, because a stub that drifted would make every pipeline test
 * assert luck.
 */
export function createStubNotesComposer(): NotesComposer {
  return {
    name: 'stub',
    compose(input: NotesComposeInput): Promise<string> {
      const head = input.previous ?? '## Notes';
      const bullets = input.tick.turns.map((t) => `- ${t.text}`).join('\n');
      return Promise.resolve(bullets ? `${head}\n${bullets}` : head);
    },
  };
}

/** One composed revision of a meeting's notes, as handed to the sink. */
export interface NotesUpdate {
  docId: string;
  meetingId: string;
  /** The tick as composed — includes any words carried from a failed tick. */
  tick: NotesTick;
  notes: string;
}

export interface MeetingNotesDeps {
  composer: NotesComposer;
  /** Quiet threshold; defaults to {@link DEFAULT_NOTES_QUIET_MS}. */
  quietMs?: number;
  schedule?: TickScheduler;
  context?: NotesProjectContext;
  /**
   * Resolve the context for THIS meeting's doc, read once at session start —
   * the doc title and board tasks vary per doc, while these deps are wired
   * once per server. Wins over the static `context` when both are present.
   */
  resolveContext?: (docId: string) => NotesProjectContext | undefined;
  /** Where composed notes go. The doc-writing stage plugs in here. */
  onNotes: (update: NotesUpdate) => void;
  onError?: (message: string) => void;
}

/**
 * What a CALLER hands `createServer`: the same deps, except the notes sink is
 * optional because the server supplies the real one — the write into the
 * meeting doc itself (see `meeting-notes-doc.ts`). A caller-supplied
 * `onNotes` observes in addition to that write, never instead of it.
 */
export type MeetingNotesOptions = Omit<MeetingNotesDeps, 'onNotes'> & {
  onNotes?: (update: NotesUpdate) => void;
};

export interface MeetingNotesSession {
  onTurn(turn: EngineTurn): void;
  /** Flush the tail delta and wait for every compose in flight. */
  end(): Promise<void>;
}

/**
 * One meeting's notes pipeline: pause ticks in, composed notes out.
 *
 * Composes are SERIALIZED on one promise chain — the composer sees ticks in
 * order and each sees the notes the one before it produced. A failed compose
 * does not lose its words: they are carried into the next tick's input, and
 * a failure with no next tick gets one retry at `end()`. Words a composer
 * never manages to compose are still in the transcript file — the notes are
 * a view, the transcript is the record.
 */
export function beginNotesSession(
  deps: MeetingNotesDeps,
  ids: { docId: string; meetingId: string },
): MeetingNotesSession {
  const context = deps.resolveContext?.(ids.docId) ?? deps.context;
  let previous: string | null = null;
  let carry: NotesTurn[] = [];
  let lastTickNo = 0;
  let chain: Promise<void> = Promise.resolve();

  const composeTick = (tick: NotesTick): void => {
    lastTickNo = Math.max(lastTickNo, tick.tick);
    chain = chain.then(async () => {
      const turns = [...carry, ...tick.turns];
      carry = [];
      if (turns.length === 0) return;
      const input: NotesComposeInput = {
        docId: ids.docId,
        meetingId: ids.meetingId,
        tick: { ...tick, turns },
        previous,
        ...(context ? { context } : {}),
      };
      try {
        const notes = await deps.composer.compose(input);
        previous = notes;
        deps.onNotes({ docId: ids.docId, meetingId: ids.meetingId, tick: input.tick, notes });
      } catch (err) {
        carry = [...turns, ...carry];
        deps.onError?.(err instanceof Error ? err.message : 'notes composer failed');
      }
    });
  };

  const ticker = createPauseTicker({
    quietMs: deps.quietMs ?? DEFAULT_NOTES_QUIET_MS,
    ...(deps.schedule ? { schedule: deps.schedule } : {}),
    onTick: composeTick,
  });

  return {
    onTurn: (turn) => ticker.onTurn(turn),
    async end(): Promise<void> {
      ticker.end();
      await chain;
      if (carry.length > 0) {
        // The last compose before the end failed and nothing after it could
        // retry. One more attempt; if this one fails too the words stay in
        // the transcript record and the notes go without them.
        composeTick({ tick: lastTickNo + 1, reason: 'end', turns: [] });
        await chain;
      }
    },
  };
}
