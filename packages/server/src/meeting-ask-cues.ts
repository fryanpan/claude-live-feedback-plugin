/**
 * Now, later, or neither — which of the two spoken conventions a line used.
 *
 * THE CONVENTION (Bryan, 2026-09-02 huddle). Two phrasings, and the assistant
 * stops guessing between them:
 *
 * - **"Claude, can you <verb> …"** — an ask for NOW. Act on it in the
 *   meeting: the answer lands on the notes doc while the meeting is still
 *   running.
 * - **"create a task …"** (or "make a task", "file a ticket", "add a
 *   ticket") — an ask for LATER. Capture it as a task, verbatim, and do not
 *   start on it.
 * - **Anything else is a note.** Speech that used neither phrasing is
 *   recorded and nothing more — not a task, not an action, however much it
 *   sounds like a request.
 *
 * THE WAKE WORD IS PART OF THE NOW CUE, NOT DECORATION. The convention is
 * literally *"Claude, can you"*: a bare "can you" is how people talk to each
 * other, and a meeting is full of it. Measured against the first version of
 * this file, which took any clause opening with can/could/would you: "Bob,
 * can you pass me the water", "Can you believe they shipped that on a
 * Friday", "Would you rather ship late or ship broken", "Sorry, could you
 * repeat that" and "He asked, can you fix it by Friday" were all read as asks
 * to the assistant. So the wake word must sit immediately before the modal,
 * and the transcriber's near-misses for it — "cloud", "clod", "claud" — count,
 * because a convention that fails on a mis-hearing is a convention people stop
 * trusting.
 *
 * THE LATER CUE IS AN IMPERATIVE CLAUSE OPENING, and two things follow from
 * that. The verb must start the clause, so "we can add tasks to the sprint
 * later" and "nobody filed a ticket for it last week" are not asks. And the
 * noun must END the ask's object rather than modify a longer one, so "add a
 * ticket TYPE for design work" and "make a to-do LIST after this" are not
 * asks either: what follows the noun has to be the end of the clause or a
 * word that starts the object ("for", "about", "on"), never another noun.
 *
 * LATER BEATS NOW. "Claude, can you create a task for that" carries both
 * cues, and it is a request to file a row rather than to do the work — the
 * artefact the speaker named is what they asked for.
 *
 * THE FAMILIES ARE DATA, AND THEY ARE THE ONES HE NAMED. The tables below
 * carry the three now-cue modals and cross-produce the four later-cue phrases.
 * Nothing here invents a fifth way to say it: a convention only works while
 * both sides can state it, and this file IS the statement.
 *
 * Pure text in, a verdict out: no turns, no board, no clock. The guard that
 * asks it which LINE of a tick licensed which ask is `cueLineFor` in
 * `meeting-capture-guards.ts`.
 */

/** Which convention a line used. */
export type AskCue = 'now' | 'later';

/** The modal half of the now cue — "can you", "could you", "would you". It is
 *  only a cue with the wake word in front of it. */
export const NOW_MODALS = ['can', 'could', 'would'] as const;

/**
 * The wake word, and the three mis-hearings of it that turn up in real
 * transcripts. Anything further from it would start matching ordinary
 * speech — "cloud" is already a word this project says out loud, and it
 * earns its place only because it must be followed by "can/could/would you".
 */
export const WAKE_WORDS = ['claude', 'claud', 'clod', 'cloud'] as const;

/** Greetings that may precede the wake word. */
const WAKE_GREETINGS = ['hey', 'hi', 'ok', 'okay'] as const;

/** The verb half of the later cue — "**create** a task". */
const LATER_VERBS = ['create', 'make', 'file', 'add'] as const;

/** The artefact half — "create a **task**". */
const LATER_NOUNS_ONE = ['task', 'ticket', 'todo', 'to-do', 'to do'] as const;

/**
 * The same nouns said of several things, which is a different ask: "file
 * tickets for the next few things I mention" is one sentence asking for
 * however many rows follow it. See {@link laterCueIsPlural}.
 */
const LATER_NOUNS_MANY = ['tasks', 'tickets', 'todos', 'to-dos'] as const;

const LATER_NOUNS = [...LATER_NOUNS_ONE, ...LATER_NOUNS_MANY] as const;

/** What may sit between the verb and the noun. "make **that a** task" is the
 *  same ask as "make a task", and transcription drops the article outright
 *  ("create task for the retry loop"), so none to two of these are skipped. */
const LATER_DETERMINERS = [
  'a',
  'an',
  'the',
  'that',
  'this',
  'it',
  'one',
  'another',
  'some',
  'new',
] as const;

/**
 * What may follow the noun. The ask's object starts here, or the clause
 * ends here — what may NOT follow is another noun, which is the difference
 * between "add a ticket for design work" and "add a ticket TYPE for design
 * work". The second is a sentence about the board's schema and files nothing.
 */
const LATER_TAILS = [
  'for',
  'about',
  'on',
  'to',
  'so',
  'and',
  'then',
  'please',
  'in',
  'with',
  're',
  'regarding',
  'covering',
  'when',
  'if',
  'because',
  'saying',
  'titled',
  'called',
] as const;

/** The four phrases Bryan named, for the prompt and for anyone reading the
 *  convention back. The matcher accepts these and the variants above. */
export const LATER_CUE_EXAMPLES = [
  'create a task',
  'make a task',
  'file a ticket',
  'add a ticket',
] as const;

/** The three now-cue phrases, wake word implied. Same purpose. */
export const NOW_CUE_EXAMPLES = ['can you', 'could you', 'would you'] as const;

/**
 * Words that may open a clause without changing what it asks: the noises
 * people start sentences with, and the framings a request gets wrapped in.
 * Stripped repeatedly from the FRONT, never from anywhere else — "we should
 * file a ticket" is an ask and "I do not think we should file a ticket" is
 * not, and only the first of those starts with a lead-in.
 *
 * The line this list draws, and it is the whole reason it is short: a modal
 * of OBLIGATION ("we should", "we need to") wraps a request, and a modal of
 * CAPABILITY ("we can", "we could") describes what is possible. "We can add
 * tasks to the sprint later" is a fact about the sprint, so "we can" is not
 * here and must not be added.
 *
 * "can you" IS here, and only for the later cue: "can you make tickets for
 * those two" asks for tickets whether or not the speaker said the wake word,
 * because the artefact they named is unambiguous. It is stripped before the
 * later test and never counted as a now cue on its own.
 */
const LEAD_INS = [
  'so',
  'um',
  'uh',
  'erm',
  'er',
  'ah',
  'well',
  'ok',
  'okay',
  'alright',
  'right',
  'yeah',
  'yep',
  'and',
  'then',
  'also',
  'actually',
  'just',
  'now',
  'please',
  'hey',
  'hi',
  "let's",
  'lets',
  'let us',
  'we should',
  'we need to',
  'i need to',
  'i want to',
  "i'd like to",
  'i would like to',
  'can you',
  'could you',
  'would you',
  ...WAKE_WORDS,
] as const;

function escape(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function alternation(words: readonly string[]): string {
  // Longest first, so "we need to" is not consumed as "we" would leave it.
  return [...words]
    .sort((a, b) => b.length - a.length)
    .map(escape)
    .join('|');
}

/** Punctuation the transcriber may drop between any two of these parts. */
const GAP = "[\\s,.!?;:'\\-–—]*";

const LEAD_IN_RE = new RegExp(`^(?:${alternation(LEAD_INS)})\\b${GAP}`);

/**
 * The now cue, anywhere in a line: the wake word (optionally greeted), then
 * whatever punctuation the transcriber chose, then the modal and "you".
 * Global, because a line may carry more than one and only the ones NOT
 * followed by a later cue count as asks for now.
 */
const NOW_RE = new RegExp(
  `\\b(?:(?:${alternation(WAKE_GREETINGS)})\\s+)?(?:${alternation(WAKE_WORDS)})\\b` +
    `${GAP}(?:${alternation(NOW_MODALS)})\\s+you\\b`,
  'g',
);

function laterRe(nouns: readonly string[]): RegExp {
  return new RegExp(
    `^(?:${alternation(LATER_VERBS)})\\s+(?:(?:${alternation(LATER_DETERMINERS)})\\s+){0,2}` +
      `(?:${alternation(nouns)})\\b` +
      `(?=\\s*$|\\s*[.,;:!?…–—-]|\\s+(?:${alternation(LATER_TAILS)})\\b)`,
  );
}

const LATER_RE = laterRe(LATER_NOUNS);
const LATER_MANY_RE = laterRe(LATER_NOUNS_MANY);

/** Enough passes to clear a realistic pile-up ("so, yeah, ok, please, file a
 *  ticket…") without letting a pathological line spin. */
const MAX_LEAD_INS = 5;

function normalize(text: string): string {
  return text.toLowerCase().replace(/[‘’ʼ]/g, "'").replace(/\s+/g, ' ').trim();
}

/** Trim whatever punctuation a clause opens with, so the lead-in and cue
 *  tests see the first real word. */
function trimOpening(text: string): string {
  return text.replace(/^[^a-z0-9']+/, '');
}

function stripLeadIns(text: string): string {
  let s = trimOpening(text);
  for (let i = 0; i < MAX_LEAD_INS; i++) {
    const next = trimOpening(s.replace(LEAD_IN_RE, ''));
    if (next === s) break;
    s = next;
  }
  return s;
}

/**
 * Where one clause ends. The later cue has to OPEN a clause, and speech
 * strings clauses together with commas as readily as with full stops, so a
 * comma ends one here. (The now cue is not split this way — its wake word and
 * its modal are usually separated by exactly the comma that would split
 * them.)
 */
function clausesIn(text: string): string[] {
  return text
    .split(/[.!?;:,\n]+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/** Did any clause open with the later cue? */
function hasLaterCue(normalized: string): boolean {
  return clausesIn(normalized).some((clause) => LATER_RE.test(stripLeadIns(clause)));
}

/**
 * Both verdicts for one line of speech.
 *
 * A now cue whose own remainder opens the later cue is NOT counted as an ask
 * for now: "Claude, can you create a task for that" asks for a row, and
 * reading it as both would let it license an in-meeting action as well.
 */
export function askCuesIn(text: string): { now: boolean; later: boolean } {
  const normalized = normalize(text);
  const later = hasLaterCue(normalized);
  let now = false;
  NOW_RE.lastIndex = 0;
  for (let m = NOW_RE.exec(normalized); m !== null; m = NOW_RE.exec(normalized)) {
    const rest = stripLeadIns(normalized.slice(m.index + m[0].length));
    if (!LATER_RE.test(rest)) {
      now = true;
      break;
    }
  }
  return { now, later };
}

/**
 * Did the speaker ask for MORE THAN ONE artefact?
 *
 * "File tickets for the next few things I mention" is one sentence that asks
 * for however many rows follow it, and it was measured doing exactly that
 * across a tick boundary. A plural later cue is therefore a STANDING one: it
 * licenses every request the pass finds rather than being spent on the first.
 * A singular "create a task for the retry loop" is spent on the retry loop,
 * and must not also file the tunnel and the sidebar the room mentioned next.
 */
export function laterCueIsPlural(text: string): boolean {
  return clausesIn(normalize(text)).some((clause) => LATER_MANY_RE.test(stripLeadIns(clause)));
}

/** Did this line use the given convention? */
export function hasAskCue(text: string, cue: AskCue): boolean {
  return askCuesIn(text)[cue];
}

/** Which convention a line used, when it used exactly one — later winning
 *  when it carries both. Undefined is the ordinary answer for meeting talk. */
export function askCueOf(text: string): AskCue | undefined {
  const cues = askCuesIn(text);
  if (cues.later) return 'later';
  return cues.now ? 'now' : undefined;
}
