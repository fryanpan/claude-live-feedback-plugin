/**
 * Does a task note say the agent is WAITING ON A PERSON?
 *
 * The keep-moving protocol's first rule is that no ask to a person exists
 * only in prose: it is a review item on their queue or it is nothing. The
 * stall loop enforced that for rows the board could SEE were waiting — an
 * owner-kind of `person`, a row under the owner's own band — and for nothing
 * else. An agent-owned row whose end-of-turn note said "Waiting on Bryan: the
 * four factual corrections sit in the doc…" read as an ordinary in-progress
 * row, and its note reset the very clock that would have named it. Three rows
 * waited hours that way (2026-09-04) while the lead was told only that they
 * were quiet, which it had already been told.
 *
 * So the note itself is read. Two stages, in this order:
 *
 *  1. **A deterministic prefilter** — `noteReadsAsWaitingOnPerson` below. It
 *     costs nothing, it runs on every tick, and it is what decides when there
 *     is no judge configured.
 *  2. **A Haiku confirmation of a prefilter HIT**, cached per note, run in the
 *     background by `NoteAskClassifier`. It can only ever say "no, that was
 *     not an ask" — a prefilter miss is never sent anywhere, so the judge
 *     narrows the finding and never widens it.
 *
 * The failure policy is the review gate's, for the same reason
 * (`decisions.md`, 2026-08-29): no key, an error, a timeout or an unparseable
 * reply leaves the PREFILTER'S verdict standing. This is a nudge toward
 * filing the ask, never a door that closes when the API does.
 *
 * **The known bias, stated rather than hidden:** the release vocabulary wins
 * over the waiting vocabulary, so a note that is still waiting while it
 * mentions an answer ("Waiting on Bryan — I answered his question") reads as
 * released and is never sent to the judge. That direction is deliberate. A
 * false wake costs a lead session's whole turn (~800k tokens, see
 * docs/architecture/stall-detection.md), and a missed one still reaches the
 * lead through the ordinary stall clock a window later.
 *
 * Nothing here reaches the network. The Haiku half is `note-ask-judge.ts`,
 * the same split as `review-judge-prompt.ts` / `review-judge.ts`.
 */

/** One note as this module reads it — the two fields the cache key needs. */
export interface NoteAskNote {
  ts: number;
  text?: string;
}

/**
 * Phrases that mean the writer has stopped and is expecting somebody else to
 * move. Substrings rather than a regex alternation with word boundaries on
 * both ends, because most of them END on a word the note continues past
 * ("parked on Bryan's", "for your read").
 */
const WAITING_PHRASES: readonly string[] = [
  'waiting on',
  'waiting for',
  'waits on',
  'wait on',
  'parked on',
  'parked pending',
  'parked until',
  'blocked on',
  'blocked by',
  'blocked until',
  'awaiting',
  'needs a decision',
  'needs a call',
  'needs an answer',
  'needs a read',
  'needs a review',
  'needs sign-off',
  'needs signoff',
  'needs approval',
  'needs input',
  'needs your',
  'needs his',
  'needs her',
  'needs their',
  'his call',
  'her call',
  'their call',
  'your call',
  'his to make',
  'hers to make',
  'theirs to make',
  'yours to make',
  'over to you',
  'back to you',
  'up to you',
  'for your',
  'pending your',
  'pending a decision',
  'pending review',
  'nothing for the agent to do',
];

/**
 * Who the waiting is ON. A waiting phrase alone is not enough — "blocked on
 * the migration" and "awaiting CI" are both work, not asks — so a PERSON has
 * to appear too.
 *
 * The generic half is pronouns and words for a human; a board's actual person
 * names arrive as `personNames`, because hard-coding one person's name into
 * product code in a public repo is not a rule, it is a leak.
 */
const GENERIC_PERSON =
  /\b(?:you|your|yours|yourself|his|him|her|hers|their|theirs|them|a person|the owner|a human|the human)\b/i;

/**
 * A note that OPENS by denying the state. The whole vocabulary above appears
 * inside such a note by construction — "Not waiting on a person: Bryan
 * answered" contains "waiting on" — so the opening is checked first, and it
 * is anchored: the denial has to be what the note is about, not a clause
 * somewhere in the middle of it.
 *
 * The leading class swallows the bullets, quotes and numbering an end-of-turn
 * message arrives wrapped in.
 */
const RELEASE_OPENING = /^[\s\-*>#•\d.)\]]*not\s+(?:waiting|stalled|blocked|parked|held|stuck)\b/i;

/**
 * A release said anywhere in the note. `answered` carries lookbehinds for the
 * three ways English negates it a word earlier; "unanswered" needs none,
 * because the `\b` cannot match inside it.
 */
const RELEASE_PHRASES =
  /\bno longer (?:waiting|blocked|parked|stuck)\b|\bnothing to wait on\b|\bunblocked\b|(?<!\bnot\s)(?<!\bnever\s)(?<!\byet\s)(?<!n['’]t\s)\banswered\b/i;

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The prefilter. TRUE when the note reads as "the agent is waiting on a
 * person to act".
 *
 * `personNames` are the board's own people — see `GENERIC_PERSON` for why
 * they are a parameter. Names are matched whole and case-insensitively, so
 * `Bryan` matches "Bryan's" and not "Bryanson".
 */
export function noteReadsAsWaitingOnPerson(
  text: string | undefined,
  personNames: readonly string[] = [],
): boolean {
  const raw = (text ?? '').trim();
  if (raw === '') return false;
  if (RELEASE_OPENING.test(raw)) return false;
  if (RELEASE_PHRASES.test(raw)) return false;
  const lower = raw.toLowerCase();
  if (!WAITING_PHRASES.some((phrase) => lower.includes(phrase))) return false;
  if (GENERIC_PERSON.test(raw)) return true;
  return personNames.some((name) => {
    const trimmed = name.trim();
    if (trimmed === '') return false;
    return new RegExp(`\\b${escapeForRegex(trimmed)}\\b`, 'i').test(raw);
  });
}

/**
 * The confirming judge. `true` / `false` is an answer; `null` is "could not
 * judge" and leaves the prefilter's verdict standing — a thrown error is
 * treated identically, so an implementation may do either.
 */
export type NoteAskJudge = (text: string) => Promise<boolean | null>;

/** How long scheduling is paused after a judge failure. One quiet window is
 *  far too long and one tick is too short: a judge that is down stays down
 *  for minutes, and retrying it every 60s buys a log line per board per
 *  minute for nothing. */
export const NOTE_ASK_JUDGE_BACKOFF_MS = 60_000;

/** How many confirmations may be in flight at once, across every board. The
 *  first tick after a restart is the only moment this binds: every ask-note
 *  on every board is uncached at once. Past it, a note is judged once in its
 *  life and an unchanged board schedules nothing. */
export const NOTE_ASK_MAX_IN_FLIGHT = 4;

/** Verdicts kept. A board's notes are capped per row (`TASK_NOTES_STORE_CAP`)
 *  and a verdict is two bytes; this only has to stop a long-lived process
 *  from growing without bound. */
const VERDICT_CACHE_MAX = 2_000;

/** FNV-1a over the note's text. Not a security hash — it only has to make two
 *  different notes posted in the same millisecond different cache keys. */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface NoteAskClassifierOpts {
  /** Absent means prefilter only — the documented "no key" state. */
  judge?: NoteAskJudge;
  /** The board's people, for the prefilter's person test. */
  personNames?: readonly string[];
  /** Injected in tests. */
  clock?: () => number;
}

/**
 * The prefilter with a memory, and the thing the stall loop actually calls.
 *
 * `asks()` is SYNCHRONOUS, which is the constraint the whole design falls out
 * of: the classifier it feeds (`classifyOpenTasks`) is pure and the stall
 * snapshot under it is sync, and making either async to await a judge would
 * turn one HTTP call into a rewrite of the loop. So a confirmation runs in
 * the BACKGROUND and lands in the cache for the next tick.
 *
 * That is not a compromise on this particular clock. A row has to be quiet
 * for a whole window (20 minutes by default) before an unfiled finding can
 * wake anybody, while ticks run every 60s — so the first tick after the note
 * lands schedules the judgement, and the tick that could actually wake a lead
 * is nineteen minutes later, reading a cached verdict.
 */
export class NoteAskClassifier {
  private readonly verdicts = new Map<string, boolean>();
  private readonly inFlight = new Set<string>();
  /** Confirmations still running — `settle()`'s handle, and nothing else's. */
  private readonly pending: Array<Promise<unknown>> = [];
  private readonly judge: NoteAskJudge | undefined;
  private personNames: readonly string[];
  private readonly clock: () => number;
  private pausedUntil = 0;

  constructor(opts: NoteAskClassifierOpts = {}) {
    this.judge = opts.judge;
    this.personNames = opts.personNames ?? [];
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Does this note read as an unfiled ask?
   *
   * A prefilter MISS is final and costs nothing. A hit answers from the cache
   * when the judge has already ruled on this exact note, and otherwise stands
   * on the prefilter while a confirmation is scheduled.
   */
  asks(note: NoteAskNote): boolean {
    if (!noteReadsAsWaitingOnPerson(note.text, this.personNames)) return false;
    const key = this.keyOf(note);
    const cached = this.verdicts.get(key);
    if (cached !== undefined) return cached;
    this.schedule(key, note.text ?? '');
    return true;
  }

  /** The prefilter alone, with no cache read and no scheduling — for a note
   *  being examined only to DATE an ask already confirmed on a newer one. */
  prefilterOnly(note: NoteAskNote): boolean {
    return noteReadsAsWaitingOnPerson(note.text, this.personNames);
  }

  /**
   * Whose names count as a person in the prefilter. Replaced per board rather
   * than fixed at construction, because the CACHE is what has to outlive a
   * tick and the roster is what changes between boards. Safe to swap between
   * boards: a cached verdict is the JUDGE's, which never saw these names, and
   * the prefilter is recomputed on every call.
   */
  setPersonNames(names: readonly string[]): void {
    this.personNames = names;
  }

  /** Test surface: how many verdicts are remembered. */
  cachedCount(): number {
    return this.verdicts.size;
  }

  /** Test surface: waits out whatever confirmations are in flight. */
  async settle(): Promise<void> {
    while (this.pending.length > 0) {
      const batch = this.pending.splice(0, this.pending.length);
      await Promise.allSettled(batch);
    }
  }

  private keyOf(note: NoteAskNote): string {
    const text = note.text ?? '';
    return `${note.ts}:${text.length}:${hashText(text)}`;
  }

  private schedule(key: string, text: string): void {
    if (this.judge === undefined) return;
    if (this.inFlight.has(key)) return;
    if (this.inFlight.size >= NOTE_ASK_MAX_IN_FLIGHT) return;
    const now = this.clock();
    if (now < this.pausedUntil) return;
    this.inFlight.add(key);
    const run = Promise.resolve(this.judge(text))
      .then((verdict) => {
        // `null` is "could not judge" and caches nothing: the prefilter's
        // verdict stands this tick and the next, and the note is asked again
        // once the pause below has elapsed.
        if (verdict === null) {
          this.pausedUntil = this.clock() + NOTE_ASK_JUDGE_BACKOFF_MS;
          return;
        }
        this.remember(key, verdict);
      })
      .catch(() => {
        this.pausedUntil = this.clock() + NOTE_ASK_JUDGE_BACKOFF_MS;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.pending.push(run);
  }

  private remember(key: string, verdict: boolean): void {
    this.verdicts.set(key, verdict);
    if (this.verdicts.size <= VERDICT_CACHE_MAX) return;
    // Insertion order is arrival order; drop the oldest.
    const drop = this.verdicts.size - VERDICT_CACHE_MAX;
    let n = 0;
    for (const k of this.verdicts.keys()) {
      if (n >= drop) break;
      this.verdicts.delete(k);
      n += 1;
    }
  }
}
