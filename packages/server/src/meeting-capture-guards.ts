/**
 * Did the transcript vouch for it?
 *
 * Every guard the capture pass stands on, and the window they are asked
 * about. The model's answer is never trusted on its own — a reference must
 * name a candidate the speech actually mentioned, a research topic and a
 * lookup query must be phrases somebody said, a requester must be a voice the
 * lines carried, and an ask must have used one of the two spoken cues. See
 * `meeting-task-capture.ts` for why a wrong link costs more than a missing
 * one.
 *
 * These are pure functions over turns and strings: no board, no model, no
 * clock. That is what lets the thresholds be argued about in a unit test
 * rather than in a live meeting, which is where they were all set.
 */

import { type AskCue, hasAskCue } from './meeting-ask-cues.ts';
import type { NotesTurn } from './meeting-notes.ts';
import { clipToWordBoundary } from './task-title.ts';

/** Longest spoken line a row's body quotes — one sentence of talk, not a
 *  tick's worth; the transcript is the record for the rest. */
const QUOTE_MAX = 240;

/**
 * Words too common to prove two texts are about the same thing. Includes the
 * meta-vocabulary of asking for tickets — "file a ticket for that task"
 * shares those words with EVERY candidate row.
 */
const STOPWORDS = new Set([
  'about',
  'actually',
  'after',
  'again',
  'also',
  'been',
  'before',
  'board',
  'could',
  'demo',
  'does',
  'doing',
  'file',
  'fixed',
  'from',
  'going',
  'gonna',
  'have',
  'into',
  'just',
  'know',
  'like',
  'last',
  'made',
  'make',
  'makes',
  'more',
  'need',
  'needs',
  'next',
  'okay',
  'only',
  'other',
  'over',
  'pretty',
  'really',
  'right',
  'should',
  'small',
  'some',
  'still',
  'sure',
  'task',
  'that',
  'them',
  'then',
  'there',
  'they',
  'thing',
  'things',
  'think',
  'this',
  'ticket',
  'under',
  'very',
  'want',
  'wants',
  'week',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'will',
  'with',
  'would',
  'yeah',
  'your',
]);

function significantWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 4 && !STOPWORDS.has(raw)) out.add(raw);
  }
  return out;
}

function sharedWordCount(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n;
}

/**
 * WHY EACH PASS ALSO SEES THE END OF THE ONE BEFORE IT.
 *
 * A tick boundary falls wherever the room went quiet for four seconds, which
 * is nowhere near where an ask ends. Measured live, both halves of it: "…and
 * that is the real cost" / boundary / "can you file a ticket for that one?"
 * filed a row titled *"file a ticket for that one, a small spike would do"* —
 * the pass saw a pointer with nothing to point at; and "we should file
 * tickets for the next few things I mention" / boundary / the things
 * themselves lost the ask entirely, because the pass that heard the subjects
 * never heard the request.
 *
 * So the window reaches back, and the overlap is MARKED: the prompt says
 * those lines were already read, and that every item must draw part of itself
 * from the new ones. Marking is what keeps the same request from being filed
 * twice, and it is belt and braces with the board's own find-or-create — a
 * re-file matches the row the previous pass created and becomes a link to it
 * (`requestMatchesCandidate`).
 *
 * The TAIL, not the whole tick. What "that one" refers to is the speech
 * adjacent to the boundary, and carrying a whole tick would grow every
 * prompt by a whole tick's transcript for the sake of one sentence.
 */
export const OVERLAP_MAX_CHARS = 180;

/** …and a turn ceiling, so a burst of two-word turns cannot spend the budget
 *  on line prefixes. */
export const OVERLAP_MAX_TURNS = 6;

/**
 * Keep the END of an over-long line: the referent of a pointer is what was
 * said last, so the tail is the half worth paying for.
 *
 * The leading ellipsis is part of what the line costs, so the tail is one
 * character shorter than the budget — a turn with no spaces in it at all (a
 * URL, an unbroken ASR token) would otherwise return `max + 1` and quietly
 * break the bound the prompt cost is measured against. Raised by review.
 */
function clipToBudget(text: string, max: number): string {
  if (text.length <= max) return text;
  const tail = text.slice(text.length - (max - 1));
  const space = tail.indexOf(' ');
  return `…${space >= 0 ? tail.slice(space + 1) : tail}`;
}

/**
 * The slice of the previous tick this pass may see: its last turns, within
 * {@link OVERLAP_MAX_CHARS}, in spoken order.
 *
 * A turn the current tick already carries is never overlap — a tick whose
 * compose failed hands its turns to the next one, where they are new speech
 * again, and showing them in both halves would ask the model to read one
 * sentence as both already-noted and new.
 *
 * The last turn is always carried, clipped if it has to be: it is the one the
 * next sentence points at, and a window that drops it for being long is the
 * bug this exists to fix.
 */
export function overlapWindow(
  priorTurns: readonly NotesTurn[] | undefined,
  turns: readonly NotesTurn[],
): NotesTurn[] {
  if (!priorTurns || priorTurns.length === 0) return [];
  const inTick = new Set(turns.map((t) => t.turn));
  const usable = priorTurns.filter((t) => !inTick.has(t.turn));
  const out: NotesTurn[] = [];
  let budget = OVERLAP_MAX_CHARS;
  for (let i = usable.length - 1; i >= 0 && out.length < OVERLAP_MAX_TURNS; i--) {
    const turn = usable[i];
    if (!turn) continue;
    // The speaker prefix is part of what the line costs the prompt.
    const prefix = turn.speaker ? turn.speaker.length + 2 : 0;
    if (turn.text.length + prefix > budget) {
      // Only the newest line is worth clipping into what is left; anything
      // older simply does not fit.
      if (out.length === 0 && budget - prefix > 0) {
        out.push({ ...turn, text: clipToBudget(turn.text, budget - prefix) });
      }
      break;
    }
    const cost = turn.text.length + prefix;
    budget -= cost;
    out.push(turn);
  }
  return out.reverse();
}

/**
 * The speech a guard may be vouched for by: this tick's, plus the marked
 * overlap. The overlap is transcript the meeting really carried, so a
 * reference to something said just before the boundary is as real as one said
 * after it — and the guard must ask about exactly the lines the model saw, or
 * it would reject the very matches the overlap exists to enable.
 */
export function captureWindow(
  turns: readonly NotesTurn[],
  priorTurns?: readonly NotesTurn[],
): NotesTurn[] {
  return [...overlapWindow(priorTurns, turns), ...turns];
}

/**
 * Did the speech mention the candidate at all? One significant word in common
 * is the floor a model-claimed reference must clear — the model matches, this
 * proves the match came from the words rather than from the candidate list
 * itself. Callers hand it the whole {@link captureWindow}, marked overlap
 * included: those words were spoken, just one tick earlier.
 */
export function tickMentionsCandidate(turns: readonly NotesTurn[], title: string): boolean {
  const spoken = significantWords(turns.map((t) => t.text).join(' '));
  return sharedWordCount(spoken, significantWords(title)) >= 1;
}

/**
 * Is a requested task the same work as a tracked row? Two significant words,
 * not one: one shared word is a mention ("popover styling" vs the popover
 * anchor bug), two is the same subject twice. Errs toward creating a
 * near-duplicate over silently folding distinct work into the wrong row —
 * a duplicate is visible and mergeable, a mislink is neither.
 */
export function requestMatchesCandidate(title: string, candidateTitle: string): boolean {
  // Word for word the same title is the same row whatever its words weigh:
  // "count to ten" has one significant word to share, so the two-word rule
  // alone would file it twice when it is asked for twice — the repeated
  // mention that must not become a second card.
  if (normalizedTitle(title) === normalizedTitle(candidateTitle)) return true;
  return sharedWordCount(significantWords(title), significantWords(candidateTitle)) >= 2;
}

export function normalizedTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Which spoken line an ask came from — the row's quote, chosen here rather
 * than asked of the model, so what the body quotes was said. The new line
 * sharing the most significant words with the ask; the last new line when
 * none shares any (a deictic "make that a task" points at the line before
 * it, which is the marked overlap, so the pointer itself is what is quoted).
 */
export function spokenLineFor(turns: readonly NotesTurn[], phrase: string): string | undefined {
  const want = significantWords(phrase);
  let best: NotesTurn | undefined;
  let bestShared = 0;
  for (const turn of turns) {
    const shared = sharedWordCount(significantWords(turn.text), want);
    if (shared > bestShared) {
      best = turn;
      bestShared = shared;
    }
  }
  const line = best ?? turns[turns.length - 1];
  if (!line) return undefined;
  const text = line.speaker ? `${line.speaker}: ${line.text}` : line.text;
  return clipToWordBoundary(text, QUOTE_MAX);
}

/**
 * Was this phrase actually SPOKEN? The guard the two reading intents stand
 * on: a research topic and a lookup query are both supposed to be "in the
 * words spoken", so a model that answers with words the window never carried
 * has invented the ask, and an invented ask is dropped.
 *
 * Two significant words where the phrase has two — the
 * {@link requestMatchesCandidate} threshold, and for its reason: one word in
 * common is a coincidence between any two sentences about the same project.
 * A phrase with only one significant word to give must give it; one with
 * none at all ("pull that up", every word a stopword) can be vouched for by
 * nothing and is dropped rather than let through on an empty match.
 */
export function phraseSpokenOnTick(turns: readonly NotesTurn[], phrase: string): boolean {
  const want = significantWords(phrase);
  if (want.size === 0) return false;
  const spoken = significantWords(turns.map((t) => t.text).join(' '));
  return sharedWordCount(spoken, want) >= Math.min(2, want.size);
}

/**
 * The transcript must vouch for a requester the same way it vouches for a
 * reference: the model may only name a voice the window actually carried —
 * this tick's speech or the marked overlap, since a request that begins
 * before the boundary is asked for by whoever spoke there.
 * Compared case-insensitively and answered with the transcript's own
 * spelling, so a model that lowercases a name still attributes it, and one
 * that invents a person attributes nobody.
 */
export function speakerOnTick(turns: readonly NotesTurn[], claimed: string): string | undefined {
  const want = claimed.trim().toLowerCase();
  if (!want) return undefined;
  for (const turn of turns) {
    if (turn.speaker && turn.speaker.toLowerCase() === want) return turn.speaker;
  }
  return undefined;
}

/**
 * Did the speech use one of the two spoken conventions — "Claude, can you …"
 * for now, "create a task …" for later?
 *
 * The convention and its origin are in `meeting-ask-cues.ts`; what this adds
 * is the window it is asked about. THE WHOLE WINDOW, not the one line an ask
 * was quoted from: an ask straddles a tick boundary often enough that the
 * overlap exists for it, and the measured half of that — "…that is the real
 * cost" / boundary / "can you file a ticket for that one?" — puts the cue and
 * the subject in different turns. A guard reading the quote alone would
 * reject exactly the asks {@link overlapWindow} was built to rescue.
 *
 * Coarser than per-line, and safe in the direction that matters: a tick with
 * neither cue anywhere in it files nothing and acts on nothing, which is the
 * convention's own rule.
 *
 * Turns are joined on newlines so each spoken line opens its own utterance —
 * one line's last word must not run into the next line's first and read as a
 * cue neither of them said.
 */
export function cueSpokenOnTick(turns: readonly NotesTurn[], cue: AskCue): boolean {
  return hasAskCue(turns.map((t) => t.text).join('\n'), cue);
}
