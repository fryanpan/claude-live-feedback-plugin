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

import { speakerDisplayName } from '@feedback/core';
import type { EngineTurn } from './transcribe.ts';

/** One settled turn as a tick's delta carries it. */
export interface NotesTurn {
  turn: number;
  text: string;
  /**
   * Who said it. Out of the ticker this is the engine's label (`"A"`); by
   * the time a composer sees it the session has turned it into what the
   * person calls that voice — their name, or "Speaker A" until named.
   */
  speaker?: string;
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
      if (turn.final) {
        if (seen.has(turn.turn)) {
          // A settled turn arriving AGAIN is the engine's end-of-session
          // speaker pass changing its mind. One still waiting to compose
          // takes the new label; one that already went out in a tick keeps
          // what it was composed with — those words are in the doc, and the
          // revision has nowhere left to land.
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
          }
        } else {
          seen.add(turn.turn);
          pending.push({
            turn: turn.turn,
            text: turn.text,
            ...(turn.speaker !== undefined ? { speaker: turn.speaker } : {}),
          });
        }
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

/** A board task captured from this tick's speech — found or freshly filed —
 *  offered to the composer as a markdown link it may weave into the notes.
 *  Shaped here because this seam carries it; the capture pipeline that
 *  produces them lives in `meeting-task-capture.ts`. */
export interface NoteTaskLink {
  title: string;
  url: string;
  status: string;
}

export interface NotesComposeInput {
  docId: string;
  meetingId: string;
  tick: NotesTick;
  /**
   * The notes as they CURRENTLY READ — the live section including anything a
   * person typed into it, not merely what this composer last returned. A
   * composer that saw only its own output would keep re-proposing the words
   * a person has already fixed. Null on a meeting's first tick.
   */
  previous: string | null;
  /**
   * The lines of `previous` a PERSON wrote. They are theirs: reproduce them
   * verbatim. Returning a changed version of one is read as a proposal and
   * lands as a suggestion on their line, never as a rewrite of it.
   */
  humanNotes?: readonly string[];
  context?: NotesProjectContext;
  /** Tasks captured from THIS tick's speech. Absent when capture is off,
   *  found nothing, or failed — the notes compose either way. */
  taskLinks?: readonly NoteTaskLink[];
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
      const bullets = input.tick.turns
        .map((t) => `- ${t.speaker ? `${t.speaker}: ` : ''}${t.text}`)
        .join('\n');
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
  /**
   * The notes section's items as the compose READ them. Anything in the doc
   * that is not in this list arrived while the compose was in flight, so
   * these notes were written without knowing about it — the sink withholds
   * changes to those rather than landing older words on a newer edit.
   * Absent when the sink was composed without a doc to read.
   */
  basedOn?: readonly string[];
}

/** The notes section as it currently stands, read fresh for each compose. */
export interface NotesSectionState {
  /** Heading plus body, the accepted state. */
  markdown: string;
  /** Every item, in reading order. */
  items: readonly string[];
  /** The subset the agent did not write. */
  human: readonly string[];
}

/**
 * "Every place the notes say `from`, they should say `to`" — a rename
 * reaching notes already written.
 *
 * A SEPARATE SINK FROM `onNotes` ON PURPOSE. An update carries whole notes
 * this module composed and replaces the section with them; a relabel carries
 * two words and asks for those two words. Sent down the update path it would
 * have to re-send a whole section built from `previous`, discarding anything
 * the human typed into it since the last tick.
 */
export interface NotesRelabel {
  docId: string;
  meetingId: string;
  /** The display name as already written — "Speaker B". */
  from: string;
  /** What that voice is called now. */
  to: string;
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
  /**
   * The task-capture pass, run per tick BEFORE the compose so the links it
   * returns can ride the same compose input. Its failure costs the tick its
   * links, never its notes — capture is an enhancement on the same terms as
   * context. Sees the tick's settled turns, carried words included.
   */
  captureTasks?: (input: {
    docId: string;
    meetingId: string;
    turns: readonly NotesTurn[];
  }) => Promise<NoteTaskLink[]>;
  /**
   * Read the doc's notes section at the START of each compose, so the
   * composer sees what the person has written rather than only what it last
   * returned. Absent in tests that wire no doc; then the composer's own last
   * output is `previous`, as it always was.
   */
  readSection?: (input: { docId: string; meetingId: string }) => NotesSectionState | null;
  /** Where composed notes go. The doc-writing stage plugs in here. */
  onNotes: (update: NotesUpdate) => void;
  /**
   * Where a rename of a voice already written about goes. Optional: a
   * session with no sink for it still renames the voices in its own
   * `previous`, so nothing composed AFTER the rename disagrees with the
   * strip; only the words already in the doc go unrevised.
   */
  onRelabel?: (relabel: NotesRelabel) => void;
  onError?: (message: string) => void;
}

/**
 * What a CALLER hands `createServer`: the same deps, except the notes sink is
 * optional because the server supplies the real one — the write into the
 * meeting doc itself (see `meeting-notes-doc.ts`). A caller-supplied
 * `onNotes` observes in addition to that write, never instead of it.
 *
 * `taskExtractor` is the capture analogue of `composer`: the caller supplies
 * the LLM seam and the server assembles the board access around it
 * (`withServerNotesSinks`), the way it already supplies the doc sink. A
 * caller-supplied `captureTasks` wins over that assembly.
 */
export type MeetingNotesOptions = Omit<MeetingNotesDeps, 'onNotes'> & {
  onNotes?: (update: NotesUpdate) => void;
  taskExtractor?: import('./meeting-task-capture.ts').TaskCaptureExtractor | null;
};

export interface MeetingNotesSession {
  onTurn(turn: EngineTurn): void;
  /**
   * "Label `speaker` is `name`" — backwards as well as forwards.
   *
   * Words still waiting on a tick pick the name up when that tick composes.
   * Notes ALREADY composed are rewritten: the name replaces the placeholder
   * in this session's memory of what it wrote, and a `NotesRelabel` goes to
   * the sink so the same two words change in the doc. The owner's call
   * (2026-08-29) is that a meeting must not read as "Speaker B" above the
   * rename and by name below it.
   *
   * The rewrite is QUEUED BEHIND whatever is composing, so a rename that
   * lands mid-compose corrects that compose's output rather than being
   * overwritten by it.
   */
  nameSpeaker(speaker: string, name: string): void;
  /** Flush the tail delta and wait for every compose in flight. */
  end(): Promise<void>;
}

/**
 * True when `ch` would make text adjacent to a match part of a longer word.
 *
 * Exported because the rename rewrites the same token in two places — this
 * module's memory of the notes, and the doc itself — and a boundary rule the
 * two disagreed about would leave one of them stale. Engine labels are single
 * letters, so "Speaker A" is a prefix of "Speaker AB".
 */
export function extendsWord(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

/**
 * Replace every whole-token occurrence of `from` with `to`. A plain scan, not
 * a RegExp: a speaker's name is arbitrary text a person typed, and escaping
 * it for a pattern is a bug waiting for the first name with a dot in it.
 */
export function replaceWholeToken(text: string, from: string, to: string): string {
  if (!from || from === to) return text;
  let out = '';
  let i = 0;
  while (true) {
    const at = text.indexOf(from, i);
    if (at < 0) break;
    const boundary = !extendsWord(text[at - 1]) && !extendsWord(text[at + from.length]);
    out += text.slice(i, at) + (boundary ? to : from);
    i = at + from.length;
  }
  return out + text.slice(i);
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
  /** Raw engine labels, never display names — a carried turn is re-mapped
   *  on its next attempt, and mapping a name a second time would wrap it. */
  let carry: NotesTurn[] = [];
  let lastTickNo = 0;
  let chain: Promise<void> = Promise.resolve();
  const names: Record<string, string> = {};
  /**
   * Every engine label this meeting has carried. Kept so a rename can ask
   * whether the name it is replacing belongs to more than one voice — the
   * `names` map alone would miss a voice that is still unnamed and whose
   * "Speaker B" someone has just typed as another voice's name.
   */
  const seen = new Set<string>();
  const withNames = (turn: NotesTurn): NotesTurn =>
    turn.speaker === undefined
      ? turn
      : { ...turn, speaker: speakerDisplayName(turn.speaker, names) };

  const composeTick = (tick: NotesTick): void => {
    lastTickNo = Math.max(lastTickNo, tick.tick);
    chain = chain.then(async () => {
      const raw = [...carry, ...tick.turns];
      carry = [];
      if (raw.length === 0) return;
      const turns = raw.map(withNames);
      let taskLinks: NoteTaskLink[] = [];
      if (deps.captureTasks) {
        try {
          taskLinks = await deps.captureTasks({
            docId: ids.docId,
            meetingId: ids.meetingId,
            turns,
          });
        } catch (err) {
          // Unlike a failed compose, nothing is carried: the words still
          // compose below, and the transcript remains the durable record a
          // later capture could be rebuilt from.
          deps.onError?.(err instanceof Error ? err.message : 'task capture failed');
        }
      }
      // Read INSIDE the chain, immediately before composing: the compose is
      // the thing that must not be written from stale text, and the chain is
      // what serializes it against the previous tick's write.
      let live: NotesSectionState | null = null;
      try {
        live = deps.readSection?.({ docId: ids.docId, meetingId: ids.meetingId }) ?? null;
      } catch (err) {
        // The section is an input to a better compose, never a dependency of
        // one — same rule as context and capture.
        deps.onError?.(err instanceof Error ? err.message : 'notes section read failed');
      }
      const input: NotesComposeInput = {
        docId: ids.docId,
        meetingId: ids.meetingId,
        tick: { ...tick, turns },
        // The FIRST tick of a session composes from scratch, even on a doc
        // whose notes section still holds the last meeting's — handing that
        // in would make every meeting a continuation of the one before it.
        // From the second tick on, `previous` is what the doc actually says,
        // which is how a person's edits reach the composer at all.
        previous: previous === null ? null : (live?.markdown ?? previous),
        // Gated with `previous` for the same reason: on tick one the human
        // lines in the section are the LAST meeting's, or an agenda written
        // before this one, and telling a from-scratch compose to reproduce
        // them verbatim would copy them into these notes.
        ...(previous !== null && live && live.human.length > 0 ? { humanNotes: live.human } : {}),
        ...(context ? { context } : {}),
        ...(taskLinks.length > 0 ? { taskLinks } : {}),
      };
      try {
        const notes = await deps.composer.compose(input);
        previous = notes;
        deps.onNotes({
          docId: ids.docId,
          meetingId: ids.meetingId,
          tick: input.tick,
          notes,
          ...(live ? { basedOn: live.items } : {}),
        });
      } catch (err) {
        carry = [...raw, ...carry];
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
    onTurn: (turn) => {
      if (turn.speaker !== undefined) seen.add(turn.speaker);
      ticker.onTurn(turn);
    },
    nameSpeaker(speaker, name) {
      // Read the OLD display name before the map moves — that is the string
      // the composer actually wrote, whether it was "Speaker B" or an
      // earlier name being corrected.
      const from = speakerDisplayName(speaker, names);
      names[speaker] = name;
      const to = speakerDisplayName(speaker, names);
      if (from === to) return;
      // Two voices can be called the same thing — two people named Alex, or
      // a slip. Then "Alex" in the notes does not say WHICH of them, and
      // renaming one would silently reattribute the other's words. The
      // forward mapping still holds (this voice's later turns compose under
      // the new name); only the retroactive rewrite is refused, because the
      // text it would have to match is not evidence of who said it.
      const ambiguous = [...seen, ...Object.keys(names)].some(
        (label) => label !== speaker && speakerDisplayName(label, names) === from,
      );
      if (ambiguous) {
        deps.onError?.(
          `notes: "${from}" is more than one voice, so notes already written were left as they are`,
        );
        return;
      }
      // On the chain, behind any compose in flight: that compose is still
      // going to return notes written with the old name (it read `previous`
      // before the rename), and the rewrite has to land after it, not under
      // it. Every later tick then sees a `previous` that already reads
      // correctly, so the name never comes back.
      chain = chain.then(() => {
        if (previous !== null) previous = replaceWholeToken(previous, from, to);
        deps.onRelabel?.({ docId: ids.docId, meetingId: ids.meetingId, from, to });
      });
    },
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
