/**
 * Meeting notes on two clocks: the quiet detector, the cadence ceiling, the
 * composer seam, and the per-meeting session that joins them.
 *
 * WHY A PAUSE IS THE UNIT. Notes composed per turn would interrupt a thought
 * mid-argument; notes composed at the end would arrive after the meeting they
 * were for. A pause in speech is the moment a human note-taker writes, so the
 * detector watches the transcript stream — EVERY frame, partials included,
 * because a partial is speech in progress and therefore evidence there is no
 * pause — and fires only when the stream has been quiet for the threshold.
 *
 * WHY A PAUSE IS NOT THE ONLY UNIT (owner, 2026-08-30: "waits too long to
 * update notes"). Every frame REPLACES the quiet countdown, so a conversation
 * where nobody stops for the threshold never fires one — and the meeting that
 * most needs notes, the one where people are talking without a break, was
 * exactly the meeting that produced nothing until it ended. The cadence timer
 * is the ceiling on that: it starts when the first unwritten sentence settles
 * and is NOT reset by speech, so no finished sentence waits longer than
 * `cadenceMs` to reach the doc. The two clocks are additive and whichever
 * expires first fires the tick.
 *
 * WHY A CADENCE TICK CARRIES ONLY SETTLED TURNS. The words still in flight
 * are a partial, and this engine's partials are UNFORMATTED — no punctuation,
 * no sentence casing, which arrive only when the turn settles (see
 * `format_turns` in the architecture summary). So there is no such thing as a
 * finished sentence inside a partial to cut at: a settled turn IS the unit of
 * finished speech, and the turn being spoken waits for the next tick rather
 * than being written mid-clause.
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

import { normalizeSpeakerTags, renameSpeakerTags, speakerDisplayName } from '@feedback/core';
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
  /**
   * The engine's own label for that voice, kept beside the display name from
   * the moment the session maps one to the other.
   *
   * The name is what a reader recognises and the label is what survives
   * being renamed, so the notes need both: the tag the composer writes shows
   * the name and CARRIES the label (`[@Devi](speaker:B)`), which is what
   * lets a later rename find every mention of that voice without searching
   * for a string that two voices might share. Absent on the way out of the
   * ticker, where `speaker` IS the label.
   */
  speakerLabel?: string;
}

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
    // Quiet with nothing new said is just quiet, not an empty tick.
    if (pending.length === 0) return;
    const turns = pending;
    pending = [];
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

/**
 * Material this tick's speech asked to have pulled in — a doc, or the notes
 * of an earlier meeting — already found, and offered to the composer as a
 * link it may cite. Resolution lives in `meeting-lookup.ts`.
 */
export interface NoteDocLink {
  title: string;
  url: string;
  /** When the meeting behind it was, in the speaker's own frame ("last
   *  week") or as a date. Absent for a doc that carried no meeting: dating
   *  one would invent a meeting that never happened. */
  when?: string;
}

/**
 * "No, I said Thursday" — a correction of a note ALREADY WRITTEN, heard in
 * the speech rather than typed into the doc.
 *
 * Two phrases and nothing else, deliberately: the mistaken words as the notes
 * carry them, and what they should say instead. Which note it lands on is not
 * decided here — it is resolved against the doc, where the notes actually
 * are, by `meeting-notes-correction.ts`.
 */
export interface SpokenCorrection {
  /** The mistaken words, as a note would spell them. */
  wrong: string;
  /** What they should say, in the words just spoken. */
  right: string;
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
  /** Material THIS tick's speech asked to have pulled in, already resolved.
   *  Absent on the same terms as `taskLinks`, and for the same reason. */
  docLinks?: readonly NoteDocLink[];
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
  /**
   * The engine label being renamed. This is the precise half: every inline
   * speaker tag in the notes carries it in its href, so a rename keyed on it
   * reaches exactly that voice's mentions and no others.
   */
  label: string;
  /** The display name as already written — "Speaker B". */
  from: string;
  /** What that voice is called now. */
  to: string;
  /**
   * Whether prose that merely READS as `from` may be rewritten too.
   *
   * False when another voice answers to the same display name. A tagged
   * mention is unaffected either way — the label says which voice it is —
   * but the words "Alex" in a sentence do not, and rewriting them would
   * silently reattribute the other Alex. Notes composed before tags existed
   * are all untagged, which is why this path survives at all.
   */
  rewriteUntagged: boolean;
}

/**
 * A spoken correction on its way to the doc that holds the note it fixes.
 *
 * A SEPARATE SINK FROM `onNotes`, for the reason {@link NotesRelabel} is one:
 * an update carries whole notes and merges them; a correction carries two
 * phrases and asks for two phrases. Routed through the update path it would
 * have to re-send a section, which is exactly the cost this intent exists to
 * avoid.
 *
 * It answers, where a relabel does not: the session cannot tell whether the
 * phrase resolved to one note, to somebody's note, or to nothing at all —
 * only the doc knows — and the answer is what the session reports.
 */
export interface NotesCorrection extends SpokenCorrection {
  docId: string;
  meetingId: string;
}

/**
 * What the doc did with a correction. `revised` means an agent note now reads
 * differently; `suggested` means a person's note carries the phrase and the
 * change was proposed on it rather than made; `none` means the correction
 * resolved to nothing it could act on, which is the ordinary answer for a
 * phrase the notes do not carry.
 */
export type NotesCorrectionResult = 'revised' | 'suggested' | 'none';

export interface MeetingNotesDeps {
  composer: NotesComposer;
  /** Quiet threshold; defaults to {@link DEFAULT_NOTES_QUIET_MS}. */
  quietMs?: number;
  /**
   * Ceiling on how long a settled turn waits for a note while people keep
   * talking; defaults to {@link DEFAULT_NOTES_CADENCE_MS}. Pass `Infinity`
   * for pause-only behaviour — the latency harness uses that to measure the
   * two cadences against one script.
   */
  cadenceMs?: number;
  schedule?: TickScheduler;
  context?: NotesProjectContext;
  /**
   * Resolve the context for THIS meeting's doc, read once at session start —
   * the doc title and board tasks vary per doc, while these deps are wired
   * once per server. Wins over the static `context` when both are present.
   */
  resolveContext?: (docId: string) => NotesProjectContext | undefined;
  /**
   * The capture pass, run per tick BEFORE the compose so the links it
   * returns can ride the same compose input. Its failure costs the tick its
   * links, never its notes — capture is an enhancement on the same terms as
   * context. Sees the tick's settled turns, carried words included, plus the
   * previous tick's for the sake of asks that span the boundary.
   *
   * ONE seam for every intent, not one per intent: the pass behind it is one
   * LLM call carrying all four (decisions.md, 2026-08-30), and a second seam
   * here would be a standing invitation to make it a second call.
   */
  captureIntents?: (input: {
    docId: string;
    meetingId: string;
    turns: readonly NotesTurn[];
    /**
     * The turns the PREVIOUS tick's capture saw, so an ask that straddles the
     * boundary between them still files the right row. Marked as already read
     * downstream; the capture pass decides how much of it to use.
     */
    priorTurns: readonly NotesTurn[];
  }) => Promise<{
    tasks: readonly NoteTaskLink[];
    docs: readonly NoteDocLink[];
    /**
     * Corrections of notes already written, heard on this tick. Optional so
     * a caller wiring its own capture seam need not answer a question it
     * does not extract; absent reads as none.
     */
    corrections?: readonly SpokenCorrection[];
  }>;
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
  /**
   * Where a spoken correction of a note already written goes. Optional: a
   * session with no sink for it extracts corrections and drops them, which
   * is the same state as a session with no doc — there is nothing written to
   * correct.
   */
  onCorrection?: (correction: NotesCorrection) => NotesCorrectionResult;
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
 * caller-supplied `captureIntents` wins over that assembly.
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
  /**
   * The turns the last capture pass read, kept RAW for the same reason as
   * `carry`: a voice named since then must reach the next pass under its new
   * name, and a display name mapped twice would wrap ("Speaker Jordan").
   * One tick deep — the capture pass takes the tail it can afford.
   */
  let priorRaw: NotesTurn[] = [];
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
      : {
          ...turn,
          speaker: speakerDisplayName(turn.speaker, names),
          // The raw label rides along so the composer can TAG the mention
          // with it. Set here and nowhere else: this is the one place that
          // knows both halves of a voice's identity at once.
          speakerLabel: turn.speaker,
        };

  const composeTick = (tick: NotesTick): void => {
    lastTickNo = Math.max(lastTickNo, tick.tick);
    chain = chain.then(async () => {
      const raw = [...carry, ...tick.turns];
      carry = [];
      if (raw.length === 0) return;
      const turns = raw.map(withNames);
      let taskLinks: readonly NoteTaskLink[] = [];
      let docLinks: readonly NoteDocLink[] = [];
      // Read before the pass, written after it: this tick's words are the
      // NEXT tick's overlap, never their own.
      const priorTurns = priorRaw.map(withNames);
      priorRaw = raw;
      if (deps.captureIntents) {
        try {
          const captured = await deps.captureIntents({
            docId: ids.docId,
            meetingId: ids.meetingId,
            turns,
            priorTurns,
          });
          taskLinks = captured.tasks;
          docLinks = captured.docs;
          // BEFORE the section is read and BEFORE the compose, not after.
          // The note a correction fixes was written on an earlier tick and is
          // already in the doc, so correcting it first means this tick's
          // compose reads the corrected words as `previous` — and the merge
          // that follows never has to reconcile a note the composer echoed
          // back in its old wording.
          for (const correction of captured.corrections ?? []) {
            try {
              deps.onCorrection?.({
                docId: ids.docId,
                meetingId: ids.meetingId,
                wrong: correction.wrong,
                right: correction.right,
              });
            } catch (err) {
              // A correction that cannot reach the doc leaves a stale note,
              // which is a blemish; letting it reach the compose chain as a
              // rejection would cost the meeting its notes, which is not.
              deps.onError?.(err instanceof Error ? err.message : 'notes correction failed');
            }
          }
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
        ...(docLinks.length > 0 ? { docLinks } : {}),
      };
      try {
        const composed = await deps.composer.compose(input);
        // The deterministic gate on a model-made claim: a tag naming a voice
        // this meeting never carried is unwrapped to plain words, and a tag
        // naming a real one is re-rendered from the name map rather than
        // trusted to spell it. Same law the capture pass holds `requester`
        // to — an attribution must name something the transcript contained.
        const checked = normalizeSpeakerTags(composed, {
          names,
          known: seen,
          ...(input.humanNotes ? { protect: input.humanNotes } : {}),
        });
        if (checked.unknown.length > 0) {
          deps.onError?.(
            `notes: dropped speaker tag${checked.unknown.length > 1 ? 's' : ''} for ` +
              `${[...new Set(checked.unknown)].join(', ')} — no such voice in this meeting`,
          );
        }
        const notes = checked.markdown;
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
    cadenceMs: deps.cadenceMs ?? DEFAULT_NOTES_CADENCE_MS,
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
      // a slip. Then the WORDS "Alex" in the notes do not say which of them,
      // and rewriting them would silently reattribute the other's speech.
      // A TAGGED mention is not in that position: it carries the label, so
      // it renames whatever the display names collide to. So ambiguity no
      // longer refuses the retroactive rewrite — it narrows it to the
      // mentions that can prove which voice they are.
      const ambiguous = [...seen, ...Object.keys(names)].some(
        (label) => label !== speaker && speakerDisplayName(label, names) === from,
      );
      if (ambiguous) {
        deps.onError?.(
          `notes: "${from}" is more than one voice, so only tagged mentions of ` +
            `${speaker} were renamed`,
        );
      }
      // On the chain, behind any compose in flight: that compose is still
      // going to return notes written with the old name (it read `previous`
      // before the rename), and the rewrite has to land after it, not under
      // it. Every later tick then sees a `previous` that already reads
      // correctly, so the name never comes back.
      chain = chain.then(() => {
        if (previous !== null) {
          // Sweep, then retag — the same order the doc side uses, and for the
          // same reason: "Devi" → "Devi Raman" leaves the old name inside the
          // new one, so a sweep run after the retag would find it in the tag
          // it had just written and say the surname twice.
          if (!ambiguous) previous = replaceWholeToken(previous, from, to);
          previous = renameSpeakerTags(previous, speaker, names).markdown;
        }
        deps.onRelabel?.({
          docId: ids.docId,
          meetingId: ids.meetingId,
          label: speaker,
          from,
          to,
          rewriteUntagged: !ambiguous,
        });
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
