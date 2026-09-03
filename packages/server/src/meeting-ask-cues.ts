/**
 * Now, later, or neither — which of the two spoken conventions an utterance
 * used.
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
 *   sounds like a request. This is the half that makes the convention worth
 *   having: without it the assistant is back to guessing, and a guess is
 *   either a dropped ask or work started prematurely.
 *
 * LATER BEATS NOW. "Claude, can you create a task for that" carries both
 * cues, and it is a request to file a row rather than to do the work — the
 * artefact the speaker named is what they asked for.
 *
 * THE FAMILIES ARE DATA, AND THEY ARE THE ONES HE NAMED. The tables below
 * cross-produce the four later-cue phrases (four verbs by three nouns) and
 * carry the three now-cue phrases exactly. Nothing here invents a fifth way
 * to say it: a convention only works while both sides can state it, and this
 * file IS the statement.
 *
 * TOLERANT OF TRANSCRIPTION, NOT OF INVENTION. Speech recognition gives
 * inconsistent punctuation, filler words and speaker prefixes, so an
 * utterance is split generously (commas and colons end one, not just full
 * stops), and a short list of lead-ins — the wake word, discourse fillers,
 * polite framings — is stripped before the cue is looked for. What is NOT
 * loosened is the cue itself.
 *
 * Pure text in, a verdict out: no turns, no board, no clock. The guard that
 * applies it to a tick's speech is `cueSpokenOnTick` in
 * `meeting-capture-guards.ts`.
 */

/** Which convention an utterance used. */
export type AskCue = 'now' | 'later';

/** Asked of the assistant, for the meeting it is said in. */
export const NOW_CUES = ['can you', 'could you', 'would you'] as const;

/** The verb half of the later cue — "**create** a task". */
const LATER_VERBS = ['create', 'make', 'file', 'add'] as const;

/** The artefact half — "create a **task**". Plurals included because one ask
 *  often covers several things ("file tickets for those"). */
const LATER_NOUNS = [
  'task',
  'tasks',
  'ticket',
  'tickets',
  'todo',
  'todos',
  'to-do',
  'to do',
] as const;

/** What may sit between the verb and the noun. "make **that a** task" is the
 *  same ask as "make a task", so up to two of these are skipped. */
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

/** The four phrases Bryan named, for the prompt and for anyone reading the
 *  convention back. The matcher below accepts these and their tolerated
 *  variants; this is what it is FOR. */
export const LATER_CUE_EXAMPLES = [
  'create a task',
  'make a task',
  'file a ticket',
  'add a ticket',
] as const;

/**
 * Words that may open an utterance without changing what it asks: the wake
 * word, the noises people start sentences with, and the framings a request
 * gets wrapped in. Stripped repeatedly from the front, never from anywhere
 * else — "we should file a ticket" is the ask, "I don't think we should file
 * a ticket" is not, and only the first of those starts with a lead-in.
 *
 * "can we" is here and "can you" deliberately is not: the second is the
 * now-cue itself, and stripping it would erase the very thing being detected.
 */
const LEAD_INS = [
  'hey',
  'hi',
  'ok',
  'okay',
  'so',
  'um',
  'uh',
  'erm',
  'er',
  'ah',
  'well',
  'alright',
  'right',
  'yeah',
  'yep',
  'yes',
  'and',
  'but',
  'then',
  'also',
  'actually',
  'just',
  'please',
  'now',
  'look',
  'listen',
  'maybe',
  'i think',
  'i mean',
  "let's",
  'lets',
  'let us',
  'we should',
  'we need to',
  'we could',
  'we can',
  'i need to',
  'i want to',
  "i'd like to",
  'i would like to',
  'somebody',
  'someone',
  'can we',
  'could we',
  'should we',
  "why don't we",
  'why dont we',
] as const;

/** The wake word, on its own or after a greeting. Optional everywhere. */
const WAKE_WORD = 'claude';

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

const LEAD_IN_RE = new RegExp(`^(?:${alternation(LEAD_INS)})\\b['\\s,-]*`);
const WAKE_RE = new RegExp(`^${escape(WAKE_WORD)}\\b['\\s,-]*`);
const NOW_RE = new RegExp(`^(?:${alternation(NOW_CUES)})\\b`);
const LATER_RE = new RegExp(
  `^(?:${alternation(LATER_VERBS)})\\s+(?:(?:${alternation(LATER_DETERMINERS)})\\s+){0,2}` +
    `(?:${alternation(LATER_NOUNS)})\\b`,
);

/** Enough passes to clear a realistic pile-up ("so, yeah, ok, can you…")
 *  without letting a pathological line spin. */
const MAX_LEAD_INS = 4;

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9']+/, '')
    .trim();
}

/** Strip lead-ins and the wake word from the front, in any order they were
 *  said: "hey Claude, so, can you…" and "so hey Claude can you…" both reduce
 *  to the cue. */
function stripLeadIns(text: string): string {
  let s = text;
  for (let i = 0; i < MAX_LEAD_INS; i++) {
    const before = s;
    s = s.replace(LEAD_IN_RE, '');
    s = s.replace(WAKE_RE, '');
    // Whatever punctuation the lead-in was followed by — an em dash after
    // the wake word is as ordinary as a comma, and transcription picks
    // between them on its own.
    s = s.replace(/^[^a-z0-9']+/, '');
    if (s === before) break;
  }
  return s;
}

/**
 * Which cue this one utterance opened with, if either.
 *
 * The later check runs first and again on what follows a now-cue, which is
 * how "can you create a task for that" comes out as `later`: the speaker
 * named the artefact, so the artefact is what they asked for.
 */
export function askCueOfUtterance(utterance: string): AskCue | undefined {
  const opening = stripLeadIns(normalize(utterance));
  if (LATER_RE.test(opening)) return 'later';
  const now = opening.match(NOW_RE);
  if (!now) return undefined;
  const rest = stripLeadIns(normalize(opening.slice(now[0].length)));
  return LATER_RE.test(rest) ? 'later' : 'now';
}

/**
 * Where one utterance ends. Commas and colons count, not only full stops:
 * transcription punctuates unevenly, a speaker prefix ends in a colon, and
 * "yeah, that is rough, can you look at the retry path" is one line carrying
 * an ask that opens two clauses in. Splitting generously costs a false
 * positive the model still has to agree with; splitting on full stops alone
 * costs the ask itself.
 */
function utterancesIn(text: string): string[] {
  return text
    .split(/[.!?;:,\n]+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);
}

/**
 * Both verdicts for a passage of speech: a passage can carry an ask for now
 * and an ask for later, so this answers each separately rather than picking
 * one. Callers hand it a whole tick, joined so that each spoken line begins
 * its own utterance.
 */
export function askCuesIn(text: string): { now: boolean; later: boolean } {
  const out = { now: false, later: false };
  for (const utterance of utterancesIn(text)) {
    const cue = askCueOfUtterance(utterance);
    if (cue === 'now') out.now = true;
    else if (cue === 'later') out.later = true;
    if (out.now && out.later) break;
  }
  return out;
}

/** Did this passage use the given convention anywhere in it? */
export function hasAskCue(text: string, cue: AskCue): boolean {
  return askCuesIn(text)[cue];
}
