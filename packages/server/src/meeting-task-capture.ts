/**
 * Tasks captured from meeting speech: hear "we should file a ticket for
 * that" and the board grows the ticket; hear "we already track that" and the
 * notes link the row that tracks it.
 *
 * WHY THE GUARDS OUTNUMBER THE FEATURE. Everything here feeds links into the
 * composed meeting notes, and a wrong link is worse than no link — it puts
 * the board's authority behind a connection nobody made. So the model's
 * answer is never trusted on its own: a reference must name a candidate the
 * transcript actually mentioned (`tickMentionsCandidate`), a request that
 * duplicates a tracked task becomes a reference to it instead of a twin row
 * (`requestMatchesCandidate`), and anything malformed is dropped in silence.
 * The transcript file remains the durable record either way; a capture pass
 * that misses is a missed convenience, not lost data.
 *
 * SAME CONSENT SEAM AS THE NOTES COMPOSER. The transcript text leaves the
 * machine on this call exactly as it does on the compose call, so the key is
 * the same dedicated one (`resolveKeyFrom`), a generic ANTHROPIC_API_KEY is
 * not honoured, and no key means capture stays off — a settled state the
 * caller logs, not an error.
 *
 * "GO DO IT" IS DELIBERATELY THE BOARD'S OWN PATH. An actionable request is
 * placed in the chores band, transitioned to `todo`, and the lead is woken
 * through the ready-nudge channel — this module never claims `in-progress`
 * itself. The chip in the notes shows live status, so it flips only when the
 * lead's dispatch actually happens, and it stays honest if that never does.
 *
 * THE FILE IS NAMED FOR ITS FIRST TWO INTENTS AND NOW CARRIES FIVE. Requests
 * and references were the whole of it; research and lookup asks arrived in
 * the same reply rather than in calls of their own, because a tick's prompt
 * is ~95% shared context and what scales with intents is how many times that
 * context is re-sent (decisions.md, 2026-08-30: "One call per tick carries
 * every intent"). An intent added here costs ~58 input tokens; the same
 * intent as its own always-on pass costs seven to twenty-seven times that.
 * So: one call, one items array, a `kind` per intent, and rows that parse
 * independently so one malformed intent never costs the others.
 *
 * THE TWO NEW INTENTS ARE NOT SYMMETRICAL, AND THE ASYMMETRY IS THE POINT.
 * A LOOKUP only reads — a wrong one is a link nobody wanted, dropped by the
 * same guards the reference path uses. A RESEARCH ask SPENDS: an agent goes
 * away and burns tokens on a report. So a research ask never acts on speech
 * alone. It files a row at `triage` carrying a decision review item, and an
 * open review item already holds a row off dispatch (`ready-gate.ts`,
 * `awaiting-answer`) — the confirmation is enforced by the board rather than
 * promised by a prompt.
 *
 * THE FIFTH INTENT DOES NOT BELONG TO THIS FILE'S SUBJECT AT ALL, AND RIDES
 * HERE ANYWAY. A CORRECTION — "no, I said Thursday" — touches no board row;
 * it fixes a note. It is extracted here for the one reason the decision gives:
 * what a tick pays for is re-sending its context, so an intent that shares the
 * transcript already in the prompt is nearly free, and the same intent as its
 * own pass would pay for the whole prompt again to answer "nothing" on most
 * ticks. So the pass extracts it, checks the half a transcript can vouch for,
 * and hands it on untouched (`CaptureLinks.corrections`) to the module that
 * can finish the job: the notes are in the doc, not here.
 */

import type { TaskReviewItem } from '@feedback/core';
import { readRenamedEnv } from '@feedback/core/env-names';
import {
  type LookupDoc,
  docLookupUrl,
  lookupWhen,
  parseRecency,
  resolveLookup,
} from './meeting-lookup.ts';
import {
  CORRECTION_PHRASE_MAX,
  correctionPhraseUsable,
  correctionSpokenOnTick,
} from './meeting-notes-correction.ts';
import type { NoteDocLink, NoteTaskLink, NotesTurn, SpokenCorrection } from './meeting-notes.ts';
import { readKeychainPassword } from './share/keychain.ts';
import { resolveKeyFrom } from './summarize.ts';
import { clipToWordBoundary } from './task-title.ts';
import {
  type AddReviewItemResult,
  CHORES_GOAL_ID,
  type CreateTaskOpts,
  type Task,
  type TaskStatus,
} from './tasks.ts';

/** One open (or recently closed) board row, as the extractor may see it. */
export interface TaskCaptureCandidate {
  id: string;
  title: string;
  status: TaskStatus;
}

/** A new task the speech explicitly asked for. */
export interface CapturedRequest {
  kind: 'request';
  title: string;
  /** Clear and doable as spoken — the store may set it moving. */
  actionable: boolean;
  /**
   * The voice that asked, as the transcript spells it — a name the person
   * gave that label, or the bare "Speaker B" of one nobody has named. Absent
   * when the speech carried no labels, or when the model named a voice this
   * tick never heard (see {@link speakerOnTick}).
   */
  requester?: string;
}

/** Speech that referred to work the board already tracks. */
export interface CapturedReference {
  kind: 'reference';
  taskId: string;
}

/**
 * Speech that asked for something to be FOUND OUT rather than built — "go
 * look into that", "dig into why it does that", "find out what it would take".
 *
 * Never acted on as heard. It becomes a row plus a decision item asking
 * whether to spend the pass, because the failure modes are not the same size:
 * a wrong task is a row to delete, a wrong research spawn is tokens spent on
 * a report nobody wanted.
 */
export interface CapturedResearch {
  kind: 'research';
  /** What to look into, in the words spoken. */
  topic: string;
  /** What the research should answer, when the speech said. */
  question?: string;
  /** The voice that asked — same law as {@link CapturedRequest.requester}. */
  requester?: string;
}

/**
 * Speech that asked for existing material to be brought in — "pull up last
 * week's notes", "link the design doc for that". What it points at is
 * resolved in `meeting-lookup.ts`; all this carries is what was asked for.
 */
export interface CapturedLookup {
  kind: 'lookup';
  /** What was asked for, in the words spoken, INCLUDING any "when" — the
   *  time phrase is often the only part that identifies a past meeting. */
  query: string;
}

/**
 * Speech that FIXES a note already written — "no, I said Thursday", "that
 * was sixty, not sixteen".
 *
 * The odd one out among the intents: every other one adds something to the
 * board or the notes, and this one changes something that is already there.
 * So it is the only intent whose guard cannot be finished here — the mistaken
 * words are vouched by the DOC, not by the transcript, and that resolution
 * happens in `meeting-notes-correction.ts` where the notes actually are. What
 * this module owes it is the other half: the corrected words must have been
 * SAID (`correctionSpokenOnTick`), so a model that invents a correction
 * nobody spoke never reaches the doc at all.
 */
export interface CapturedCorrection {
  kind: 'correction';
  /** The mistaken words, as the notes would spell them. */
  wrong: string;
  /** What they should say instead, in the words just spoken. */
  right: string;
}

export type CapturedItem =
  | CapturedRequest
  | CapturedReference
  | CapturedResearch
  | CapturedLookup
  | CapturedCorrection;

export interface TaskCaptureInput {
  turns: readonly NotesTurn[];
  /**
   * The previous tick's speech, already read on that pass. Only its tail is
   * used, and it is marked in the prompt as already read — see
   * {@link overlapWindow} for why an ask straddling a tick boundary needs it.
   */
  priorTurns?: readonly NotesTurn[];
  candidates: readonly TaskCaptureCandidate[];
  docTitle?: string;
}

export interface TaskCaptureExtractor {
  readonly name: string;
  /** Items already parsed and guard-checked; empty is the ordinary answer. */
  extract(input: TaskCaptureInput): Promise<CapturedItem[]>;
}

/**
 * Who the captured rows belong to. An agent identity on the
 * `PARK_MIGRATION_ACTOR` pattern: no human filed the row, and the owner gate
 * refuses the bare generic word — a named agent is what "the meeting
 * assistant filed this" looks like in the audit trail.
 */
export const MEETING_CAPTURE_ACTOR = {
  id: 'agent-meeting-assistant',
  name: 'Meeting Assistant',
  kind: 'agent',
} as const;

/** Longest title a captured request may carry — the board's own title cap. */
const TITLE_MAX = 80;

/** Longest lookup query the resolver is asked to work with. Not a title —
 *  it is a spoken phrase, and past the first few words it stops narrowing
 *  and starts adding words the fuzzy matcher has to discount. */
const QUERY_MAX = 120;

/** How many board rows the extractor prompt may carry, mirroring the notes
 *  context cap: enough to match against, few enough that a thousand-row
 *  board cannot flood the prompt. */
export const MAX_CAPTURE_CANDIDATES = 40;

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
  return sharedWordCount(significantWords(title), significantWords(candidateTitle)) >= 2;
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

/** The board deep link `parseWorkspaceLink` reads back as `kind: 'task'` —
 *  root-relative, so it survives being read under any host the server has. */
export function taskCaptureUrl(workspaceId: string, taskId: string): string {
  return `/workspaces/${encodeURIComponent(workspaceId)}?task=${encodeURIComponent(taskId)}`;
}

/**
 * The overlap's whole contract, in the fewest tokens that carry it: what the
 * earlier lines are for, in both directions, and the rule that stops last
 * pass's items being filed a second time. Standing text — it costs its tokens
 * on every tick, overlap or not, which is why it is this short and why
 * `scripts/capture-overlap-cost.ts` measures it separately.
 */
/**
 * What research sounds like, and what separates it from the request intent
 * sitting beside it in the same reply. Exported, like the overlap rule, so
 * `scripts/intent-prompt-cost.ts` can price this intent by removing exactly
 * the text it added — an intent's cost is a measurement here, not an
 * estimate.
 *
 * "They will rarely say the word research" is the load-bearing line: the ask
 * this exists to catch is "go look into that", and a prompt that leaned on
 * the word would catch only the asks that needed no help.
 */
export const RESEARCH_PROMPT_RULE = [
  'A RESEARCH ask when a speaker wants something FOUND OUT before it can be',
  'decided or built — "go look into that", "dig into why it does that",',
  '"find out what it would take". They will rarely say the word "research".',
  'Wondering aloud is not an ask; somebody has to want it done. "topic":',
  'what to look into, in the words spoken; "question": what it should',
  'answer, omitted if unsaid. Prefer "request" when they asked for the WORK',
  'rather than for findings.',
] as const;

/**
 * What a lookup sounds like. The "keep any when" clause earns its tokens:
 * an earlier meeting has no title of its own, so the time phrase is often
 * the only part of the ask that identifies anything (`meeting-lookup.ts`).
 */
export const LOOKUP_PROMPT_RULE = [
  'A LOOKUP when a speaker asks for material that ALREADY EXISTS to be',
  'brought in — "pull up last week\'s notes", "link the design doc for',
  'that", "what did we decide on Tuesday". "query": what they asked for in',
  'their own words, KEEPING any "when" they said ("last week", "Tuesday").',
] as const;

/**
 * What a correction sounds like, and — the load-bearing half — what
 * separates it from somebody simply saying something new.
 *
 * "Changing their mind is not a correction" earns its tokens: a meeting is
 * full of "actually, let's do Thursday", which OVERTURNS a note rather than
 * fixing it, and the composer already handles that by revising the notes it
 * writes. A correction is narrower: the note is WRONG, and two words of it
 * are wrong. Asking for the mistaken words verbatim is what makes it
 * resolvable — a paraphrase matches no note and is dropped.
 */
export const CORRECTION_PROMPT_RULE = [
  'A CORRECTION when a speaker fixes something the notes ALREADY SAY, rather',
  'than saying anything new — "no, I said Thursday", "that was Priya, not',
  'me", "sixty, not sixteen". "wrong": the mistaken words as the notes would',
  'have them, quoted, not paraphrased; "right": what they should say, in the',
  'words just spoken. Both short — a few words, never a sentence. Somebody',
  'CHANGING THEIR MIND ("actually, let\'s do Thursday") is new speech, not a',
  'correction. Omit the item unless both halves are clear.',
] as const;

export const OVERLAP_PROMPT_RULE = [
  '"Earlier speech" was read last pass: use it to resolve what a new line',
  'points at, or to finish a request it began. Every item must draw part of',
  'itself from the new lines.',
] as const;

/**
 * Prompt building is pure and exported, same reason as the notes composer's:
 * what the transcript is asked to become is behaviour worth pinning without
 * a network in the test.
 */
export function buildTaskCapturePrompt(input: TaskCaptureInput): { system: string; user: string } {
  const system = [
    'You listen to a live working meeting and extract five things: task',
    'REQUESTS, task REFERENCES, RESEARCH asks, LOOKUP asks and CORRECTIONS.',
    'Answer with JSON only, this shape:',
    '{"items":[{"kind":"request","title":"...","actionable":true|false,',
    '           "requester":"who asked, omitted if unclear"}',
    '         |{"kind":"reference","match":<candidate number>}',
    '         |{"kind":"research","topic":"...","question":"...",',
    '           "requester":"who asked, omitted if unclear"}',
    '         |{"kind":"lookup","query":"..."}',
    '         |{"kind":"correction","wrong":"...","right":"..."}]}',
    '',
    'A REQUEST only when a speaker explicitly asks for work to be tracked or',
    'filed — "file a ticket", "let\'s track that", "add it to the board",',
    '"can you create a task". Discussing a problem, complaining about a bug,',
    'or agreeing something is broken is NOT a request. Title: short,',
    'specific, in the words spoken.',
    'Mark a request "actionable": true only when it is clear enough to start',
    'without asking anything back — what to do and where — and nobody said',
    'to wait. When in doubt, false.',
    '',
    'Transcript lines may be prefixed with who said them. Set "requester" to',
    'that speaker, copied exactly as the line spells it — including a label',
    'like "Speaker B", which is a voice nobody has named yet. Omit',
    '"requester" when the lines carry no speaker or you are unsure who asked;',
    'never guess, and never name anyone the lines do not.',
    '',
    'A REFERENCE only when the speech clearly refers to work in the numbered',
    'candidate list; "match" is that number. Never guess: no confident match',
    'means no item.',
    '',
    ...RESEARCH_PROMPT_RULE,
    '',
    ...LOOKUP_PROMPT_RULE,
    '',
    ...CORRECTION_PROMPT_RULE,
    '',
    ...OVERLAP_PROMPT_RULE,
    '',
    'An empty items array is the normal answer for most speech.',
  ].join('\n');

  const parts: string[] = [];
  if (input.docTitle) parts.push(`Meeting doc: ${input.docTitle}`);
  if (input.candidates.length > 0) {
    parts.push(
      `Board tasks (candidates for "reference"):\n${input.candidates
        .map((c, i) => `${i}. ${c.title}`)
        .join('\n')}`,
    );
  }
  const line = (t: NotesTurn): string => `- ${t.speaker ? `${t.speaker}: ` : ''}${t.text}`;
  const earlier = overlapWindow(input.priorTurns, input.turns);
  if (earlier.length > 0) {
    parts.push(`Earlier speech (already read):\n${earlier.map(line).join('\n')}`);
  }
  parts.push(`New speech since the last update:\n${input.turns.map(line).join('\n')}`);
  return { system, user: parts.join('\n\n') };
}

/**
 * A model reply → guarded items. Strict by construction: malformed rows,
 * out-of-range matches, and references the transcript cannot vouch for are
 * dropped row by row, never letting one bad row cost the good ones.
 */
export function parseTaskCaptureReply(
  raw: string,
  candidates: readonly TaskCaptureCandidate[],
  turns: readonly NotesTurn[],
  priorTurns?: readonly NotesTurn[],
): CapturedItem[] {
  // Vouch against exactly the lines the model was shown — see captureWindow.
  const window = captureWindow(turns, priorTurns);
  let text = raw.trim();
  const fenced = text.match(/^```[a-zA-Z]*\n([\s\S]*?)\n?```$/);
  if (fenced?.[1] !== undefined) text = fenced[1].trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];

  const out: CapturedItem[] = [];
  const seenTasks = new Set<string>();
  const seenTitles = new Set<string>();
  for (const entry of items) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as Record<string, unknown>;
    if (row.kind === 'reference') {
      if (typeof row.match !== 'number' || !Number.isInteger(row.match)) continue;
      const candidate = row.match >= 0 ? candidates[row.match] : undefined;
      if (!candidate) continue;
      // The transcript must vouch for the match — see tickMentionsCandidate.
      if (!tickMentionsCandidate(window, candidate.title)) continue;
      if (seenTasks.has(candidate.id)) continue;
      seenTasks.add(candidate.id);
      out.push({ kind: 'reference', taskId: candidate.id });
    } else if (row.kind === 'request') {
      if (typeof row.title !== 'string' || row.title.trim().length === 0) continue;
      const title = clipToWordBoundary(row.title.trim(), TITLE_MAX);
      const key = title.toLowerCase();
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      const requester =
        typeof row.requester === 'string' ? speakerOnTick(window, row.requester) : undefined;
      out.push({
        kind: 'request',
        title,
        actionable: row.actionable === true,
        ...(requester !== undefined ? { requester } : {}),
      });
    } else if (row.kind === 'research') {
      if (typeof row.topic !== 'string') continue;
      const topic = clipToWordBoundary(row.topic.trim(), TITLE_MAX);
      if (topic.length === 0) continue;
      // The words have to have been said — see phraseSpokenOnTick. This is
      // the guard that stands between a mishearing and a research pass.
      if (!phraseSpokenOnTick(window, topic)) continue;
      const key = `research:${topic.toLowerCase()}`;
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      const question =
        typeof row.question === 'string' && row.question.trim().length > 0
          ? row.question.trim()
          : undefined;
      const requester =
        typeof row.requester === 'string' ? speakerOnTick(window, row.requester) : undefined;
      out.push({
        kind: 'research',
        topic,
        ...(question !== undefined ? { question } : {}),
        ...(requester !== undefined ? { requester } : {}),
      });
    } else if (row.kind === 'lookup') {
      if (typeof row.query !== 'string') continue;
      const query = row.query.trim().slice(0, QUERY_MAX);
      if (query.length === 0) continue;
      // Same vouching as research: a query nobody spoke points at nothing
      // anyone asked for, whatever it happens to match on the board.
      if (!phraseSpokenOnTick(window, query)) continue;
      const key = `lookup:${query.toLowerCase()}`;
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      out.push({ kind: 'lookup', query });
    } else if (row.kind === 'correction') {
      if (typeof row.wrong !== 'string' || typeof row.right !== 'string') continue;
      const wrong = row.wrong.trim();
      const right = row.right.trim();
      // Long enough to identify a note, short enough to be a correction
      // rather than a rewrite of one. Same floor the doc side applies, asked
      // here so a hopeless pair never reaches it.
      if (!correctionPhraseUsable(wrong)) continue;
      if (right.length === 0 || right.length > CORRECTION_PHRASE_MAX) continue;
      if (wrong.toLowerCase() === right.toLowerCase()) continue;
      // The corrected words must have been SAID. The MISTAKEN words are
      // deliberately not checked against the transcript: the tick that
      // carried the mishearing is usually outside this window by the time
      // anybody corrects it, and the notes vouch for them far better than a
      // transcript could — see `correctNotesSection`.
      if (!correctionSpokenOnTick(window, right)) continue;
      const key = `correction:${wrong.toLowerCase()}=>${right.toLowerCase()}`;
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      out.push({ kind: 'correction', wrong, right });
    }
  }
  return out;
}

/** The slice of the task store the capture pipeline writes through. The real
 *  `TaskStore` satisfies it structurally; the tests hand in a recorder. */
export interface TaskCaptureBoard {
  listTasks(workspaceId: string): Array<{
    id: string;
    title: string;
    status: TaskStatus;
    kind?: 'task' | 'goal';
  }>;
  createTask(
    workspaceId: string,
    opts: CreateTaskOpts,
  ): { ok: true; task: { id: string } } | { ok: false; error: string };
  transition(
    taskId: string,
    to: TaskStatus,
    opts: { actor: { id: string; name: string; kind?: string }; note?: string },
  ): { ok: boolean };
  /**
   * Required, not optional, and that is deliberate: a board that could not
   * file the confirmation would file research rows with nothing gating
   * them. There is no wiring in which the ask is skipped.
   */
  addReviewItem(
    taskId: string,
    review: unknown,
    opts: { actor: { id: string; name: string; kind?: string } },
  ): AddReviewItemResult;
}

/**
 * Where a lookup ask looks, beyond the board rows this pass has already
 * read. Docs and their past meetings live behind `rooms` and the meeting
 * store, which this module has no business knowing about.
 */
export interface TaskCaptureLookup {
  /**
   * The board's docs and when each last carried a meeting. The meeting's own
   * doc is excluded by the implementation — "pull up the last meeting" means
   * the one before this one, and the notes being written are already here.
   */
  docs(workspaceId: string, exceptDocId: string): LookupDoc[];
}

/** What one tick's pass hands back: rows it touched, material it was asked to
 *  bring in, and fixes to notes already written. All three empty is the
 *  ordinary answer. The first two are links the composer may weave in; the
 *  third goes to the doc directly, because the note it changes is there and
 *  not in anything the composer is about to write. */
export interface CaptureLinks {
  tasks: NoteTaskLink[];
  docs: NoteDocLink[];
  corrections: SpokenCorrection[];
}

export interface RunTaskCaptureDeps {
  board: TaskCaptureBoard;
  extractor: TaskCaptureExtractor;
  /** Where a lookup ask resolves. Absent, lookups are extracted and dropped
   *  — the same shape as capture being off: a missed convenience. */
  lookup?: TaskCaptureLookup;
  /** The lead wake — the ready-nudge channel. Fired only for a request the
   *  extractor judged actionable, after its row is `todo`. */
  onTaskReady?: (wake: { workspaceId: string; taskId: string; title: string }) => void;
  /**
   * A filed confirmation. `addReviewItem` emits no store event (by design),
   * so the caller owes the item two things this module cannot reach: a
   * re-projection of the board room, and the announce that puts it on the
   * reader's queue. Same contract `proposeAllowRule` honours in server.ts.
   */
  onReviewFiled?: (filed: { task: Task; item: TaskReviewItem }) => void;
  /** Tests: the clock a recency phrase is read against. */
  now?: () => number;
  onError?: (message: string) => void;
}

export interface RunTaskCaptureInput {
  workspaceId: string;
  docId: string;
  docTitle?: string;
  turns: readonly NotesTurn[];
  /** The previous tick's speech, for the boundary — see {@link overlapWindow}. */
  priorTurns?: readonly NotesTurn[];
}

/**
 * One pause's capture pass: extract, find-or-create, optionally set moving,
 * and return the links the notes composer may weave in. Never throws — a
 * capture pass that fails costs its links, not the meeting's notes.
 */
export async function runTaskCapture(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
): Promise<CaptureLinks> {
  const none: CaptureLinks = { tasks: [], docs: [], corrections: [] };
  let candidates: TaskCaptureCandidate[];
  try {
    // Done rows stay in: "the tunnel fix from last week is done" is a
    // reference, and its chip honestly says so.
    candidates = deps.board
      .listTasks(input.workspaceId)
      .filter((t) => t.kind !== 'goal')
      .slice(0, MAX_CAPTURE_CANDIDATES)
      .map((t) => ({ id: t.id, title: t.title, status: t.status }));
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'task capture: board read failed');
    return none;
  }

  let items: CapturedItem[];
  try {
    items = await deps.extractor.extract({
      turns: input.turns,
      candidates,
      ...(input.priorTurns !== undefined ? { priorTurns: input.priorTurns } : {}),
      ...(input.docTitle !== undefined ? { docTitle: input.docTitle } : {}),
    });
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'task capture failed');
    return none;
  }

  const byId = new Map(candidates.map((c) => [c.id, c]));
  const links: NoteTaskLink[] = [];
  const docLinks: NoteDocLink[] = [];
  const corrections: SpokenCorrection[] = [];
  const linked = new Set<string>();
  const linkedDocs = new Set<string>();
  const pushCandidate = (c: TaskCaptureCandidate): void => {
    if (linked.has(c.id)) return;
    linked.add(c.id);
    links.push({ title: c.title, url: taskCaptureUrl(input.workspaceId, c.id), status: c.status });
  };
  /** A row this pass just made, which the candidate list predates. */
  const pushMade = (id: string, title: string, status: TaskStatus): void => {
    if (linked.has(id)) return;
    linked.add(id);
    links.push({ title, url: taskCaptureUrl(input.workspaceId, id), status });
    candidates.push({ id, title, status });
  };

  for (const item of items) {
    if (item.kind === 'reference') {
      const candidate = byId.get(item.taskId);
      if (candidate) pushCandidate(candidate);
      continue;
    }
    if (item.kind === 'correction') {
      // Nothing to find or create: a correction touches no board row. It is
      // carried out of here untouched, and resolves against the notes doc —
      // the only place that can say which note it is about, or whether it is
      // about anybody's note at all.
      corrections.push({ wrong: item.wrong, right: item.right });
      continue;
    }
    if (item.kind === 'lookup') {
      handleLookup(deps, input, item, candidates, pushCandidate, docLinks, linkedDocs);
      continue;
    }
    if (item.kind === 'research') {
      // Asked for twice, or already tracked: link the row rather than file a
      // second confirmation of the same pass. Same threshold and the same
      // reasoning as a duplicated request.
      const tracked = candidates.find(
        (c) => c.status !== 'done' && requestMatchesCandidate(item.topic, c.title),
      );
      if (tracked) {
        pushCandidate(tracked);
        continue;
      }
      const filed = fileResearchAsk(deps, input, item);
      if (filed) pushMade(filed.taskId, filed.title, 'triage');
      continue;
    }
    // Find before create: a request that names tracked OPEN work links the
    // existing row. Done rows are exempt — asking again for finished work is
    // a new task (a regression), not a reference.
    const existing = candidates.find(
      (c) => c.status !== 'done' && requestMatchesCandidate(item.title, c.title),
    );
    if (existing) {
      pushCandidate(existing);
      continue;
    }
    const actionable = item.actionable;
    const created = deps.board.createTask(input.workspaceId, {
      title: item.title,
      body: [
        `Filed live from the meeting${input.docTitle ? ` "${input.docTitle}"` : ''} by the`,
        "meeting assistant — the doc's transcript is the source record.",
        // Who asked is the half of "who said what" a task can still answer a
        // week later, once the strip is gone. Only ever a voice the tick
        // carried, so this line names a real speaker or nothing at all.
        ...(item.requester ? [`Asked for by ${item.requester}.`] : []),
      ].join(' '),
      assignee: MEETING_CAPTURE_ACTOR.name,
      assigneeKind: 'agent',
      // The doc is where the words live; the origin ref is what lets the
      // task answer "where did this come from".
      origin: { kind: 'doc', docId: input.docId },
      // Actionable work gets a real (re-rankable) band so dispatch can reach
      // it; anything else goes through triage like other agent-filed rows.
      ...(actionable ? { goal: CHORES_GOAL_ID } : {}),
      actor: MEETING_CAPTURE_ACTOR,
    });
    if (!created.ok) {
      deps.onError?.(`task capture: create refused (${created.error})`);
      continue;
    }
    let status: TaskStatus = 'triage';
    if (actionable) {
      const moved = deps.board.transition(created.task.id, 'todo', {
        actor: MEETING_CAPTURE_ACTOR,
        note: 'Asked for in the meeting and clear enough to start; queued for dispatch.',
      });
      if (moved.ok) {
        status = 'todo';
        deps.onTaskReady?.({
          workspaceId: input.workspaceId,
          taskId: created.task.id,
          title: item.title,
        });
      }
    }
    pushMade(created.task.id, item.title, status);
  }
  return { tasks: links, docs: docLinks, corrections };
}

/**
 * A research ask becomes a row at `triage` plus a decision item asking
 * whether to spend the pass. Two things gate it, and neither is a promise a
 * prompt makes:
 *
 * - **The row is never set moving.** It stays at `triage` — no transition to
 *   `todo`, which is the status dispatch works — so it goes through triage
 *   like every other unvetted agent-filed row. (It still lands in the chores
 *   band: `createTask` defaults `goal` when a caller names none. The band is
 *   not what holds it; the status is. An earlier version of this comment
 *   claimed otherwise and the store disagreed.)
 * - **An open review item holds it further.** `ready-gate.ts` reports
 *   `awaiting-answer` for a row carrying an unanswered item, so even after
 *   somebody triages it, it is held until the ask is answered.
 *
 * The item filing can fail — a board that refuses the payload, a store
 * error. That costs the row its card, not its safety: the row is still at
 * `triage` and still unmoved, which is where an unconfirmed research ask
 * belongs. The failure is reported, never swallowed.
 */
function fileResearchAsk(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
  item: CapturedResearch,
): { taskId: string; title: string } | null {
  const title = clipToWordBoundary(`Research: ${item.topic}`, TITLE_MAX);
  const created = deps.board.createTask(input.workspaceId, {
    title,
    body: [
      `Heard live in the meeting${input.docTitle ? ` "${input.docTitle}"` : ''} by the meeting`,
      "assistant — the doc's transcript is the source record.",
      ...(item.question ? [`The question asked: ${item.question}`] : []),
      ...(item.requester ? [`Asked for by ${item.requester}.`] : []),
      "Nobody called this research out loud; it is the assistant's reading of the ask,",
      'so it waits on the review item below before anything is spent on it.',
    ].join(' '),
    assignee: MEETING_CAPTURE_ACTOR.name,
    assigneeKind: 'agent',
    // No band asked for, the same as an unactionable request: placing it is
    // a person's call at triage. The store fills in `chores` regardless.
    origin: { kind: 'doc', docId: input.docId },
    actor: MEETING_CAPTURE_ACTOR,
  });
  if (!created.ok) {
    deps.onError?.(`research capture: create refused (${created.error})`);
    return null;
  }
  const taskId = created.task.id;
  const url = taskCaptureUrl(input.workspaceId, taskId);
  const filed = deps.board.addReviewItem(
    taskId,
    {
      review_type: 'decision',
      headline: `Look into ${clipToWordBoundary(item.topic, 52)}?`,
      detail: [
        `Heard in the meeting${input.docTitle ? ` "${input.docTitle}"` : ''}:`,
        item.question ? `${item.question}` : `somebody wanted ${item.topic} looked into`,
        item.requester ? `(${item.requester} asked).` : '.',
        'Nobody said the word "research" — this is the meeting assistant reading an ask',
        'out of the conversation, which is exactly the kind of reading worth a glance',
        'before an agent spends a pass on it.',
        `The row is [${title}](${url}), sitting in triage and going nowhere until you answer.`,
      ].join(' '),
      options: [
        {
          id: 'go-ahead',
          label: 'Go ahead',
          detail:
            'Releases the row for triage; an agent then does the reading and reports back on the ticket.',
        },
        {
          id: 'not-now',
          label: 'Not now',
          detail:
            'Nothing is spent. The row stays in triage, where you can archive it if the assistant misheard.',
        },
      ],
    },
    { actor: MEETING_CAPTURE_ACTOR },
  );
  if (!filed.ok) {
    deps.onError?.(`research capture: confirmation refused (${filed.error})`);
    return { taskId, title };
  }
  deps.onReviewFiled?.({ task: filed.task, item: filed.item });
  return { taskId, title };
}

/**
 * A lookup ask becomes a link, or nothing. The resolution is
 * `meeting-lookup.ts`'s; what happens here is only the routing: a doc
 * becomes a doc link the composer may cite, and a board row goes down the
 * path board rows already take, so a lookup and a reference to the same row
 * cannot produce two links to it.
 */
function handleLookup(
  deps: RunTaskCaptureDeps,
  input: RunTaskCaptureInput,
  item: CapturedLookup,
  candidates: readonly TaskCaptureCandidate[],
  pushCandidate: (c: TaskCaptureCandidate) => void,
  docLinks: NoteDocLink[],
  linkedDocs: Set<string>,
): void {
  if (!deps.lookup) return;
  const now = deps.now?.() ?? Date.now();
  let docs: LookupDoc[];
  try {
    docs = deps.lookup.docs(input.workspaceId, input.docId);
  } catch (err) {
    deps.onError?.(err instanceof Error ? err.message : 'lookup: doc read failed');
    return;
  }
  const hit = resolveLookup(item.query, { docs, tasks: candidates }, now);
  if (!hit) return;
  if (hit.kind === 'task') {
    const candidate = candidates.find((c) => c.id === hit.taskId);
    if (candidate) pushCandidate(candidate);
    return;
  }
  if (linkedDocs.has(hit.docId)) return;
  linkedDocs.add(hit.docId);
  const when = lookupWhen(hit, parseRecency(item.query, now));
  docLinks.push({
    title: hit.title,
    url: docLookupUrl(input.workspaceId, hit.docId),
    ...(when !== undefined ? { when } : {}),
  });
}

const API_URL = 'https://api.anthropic.com/v1/messages';
const CAPTURE_MODEL = 'claude-haiku-4-5-20251001';
/** The reply is a short JSON list, never notes-sized. */
const MAX_TOKENS = 1_000;
const TIMEOUT_MS = 30_000;

export interface HaikuTaskCaptureOpts {
  /** Tests: a key (or `null` for the explicit no-key state) without Keychain. */
  apiKey?: string | null;
  /** Tests: the HTTP seam. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Printed once per process — the transcript leaving the machine is never
 *  the silent case, same rule as the notes composer. */
let announcedOn = false;

/**
 * The real extractor, or `null` when the operator has not opted in (no
 * dedicated key) or has opted out (`CW_MEETING_TASKS=0`). Failure throws and
 * never logs the key; `runTaskCapture` turns the throw into a skipped pass.
 */
export function createHaikuTaskCaptureExtractor(
  opts: HaikuTaskCaptureOpts = {},
): TaskCaptureExtractor | null {
  if (readRenamedEnv(process.env, 'CW_MEETING_TASKS') === '0') return null;
  const key = resolveKeyFrom(opts.apiKey, readKeychainPassword);
  if (!key) return null;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    name: 'haiku',
    async extract(input: TaskCaptureInput): Promise<CapturedItem[]> {
      if (!announcedOn) {
        announcedOn = true;
        console.log(
          '[meeting-tasks] live task capture ON: meeting transcript text is ' +
            'sent to api.anthropic.com. Turn off with CW_MEETING_TASKS=0.',
        );
      }
      const { system, user } = buildTaskCapturePrompt(input);
      const ctl = new AbortController();
      const timeout = setTimeout(() => ctl.abort(), TIMEOUT_MS);
      try {
        const res = await fetchImpl(API_URL, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
          body: JSON.stringify({
            model: CAPTURE_MODEL,
            max_tokens: MAX_TOKENS,
            system,
            messages: [{ role: 'user', content: user }],
          }),
          signal: ctl.signal,
        });
        // The status is safe to surface; the key never is.
        if (!res.ok) throw new Error(`task capture HTTP ${res.status}`);
        const body = (await res.json()) as { content?: Array<{ text?: string }> };
        const text = body.content?.map((b) => b.text ?? '').join('') ?? '';
        return parseTaskCaptureReply(text, input.candidates, input.turns, input.priorTurns);
      } finally {
        clearTimeout(timeout);
      }
    },
  };
}
