/**
 * What the transcript is asked to become, and what comes back.
 *
 * One call carries six intents, so this file is mostly standing text: each
 * `*_PROMPT_RULE` is the description of one intent, exported separately so
 * `scripts/intent-prompt-cost.ts` can price an intent by removing exactly the
 * lines it added. An intent's cost is a measurement, not an estimate — see
 * `meeting-task-capture.ts` for the decision that put them all in one call.
 *
 * Both halves are pure and free of the network: building the prompt and
 * reading the reply are the behaviour worth pinning in a test, and the guards
 * every parsed row must clear live next door in
 * `meeting-capture-guards.ts`.
 */

import {
  captureWindow,
  cueSpokenOnTick,
  normalizedTitle,
  overlapWindow,
  phraseSpokenOnTick,
  speakerOnTick,
  tickMentionsCandidate,
} from './meeting-capture-guards.ts';
import {
  CORRECTION_PHRASE_MAX,
  correctionPhraseUsable,
  correctionSpokenOnTick,
} from './meeting-notes-correction.ts';
import type { NotesTurn } from './meeting-notes.ts';
import type {
  CapturedItem,
  TaskCaptureCandidate,
  TaskCaptureInput,
} from './meeting-task-capture.ts';
import { clipToWordBoundary } from './task-title.ts';

/** Longest title a captured request may carry — the board's own title cap.
 *  Exported for the research title, which is the same cap on a longer name. */
export const TITLE_MAX = 80;

/** Longest review question carried into a thread — a question, not a
 *  speech; the thread's own text says where it was heard. */
const QUESTION_MAX = 240;

/** Longest lookup query the resolver is asked to work with. Not a title —
 *  it is a spoken phrase, and past the first few words it stops narrowing
 *  and starts adding words the fuzzy matcher has to discount. */
const QUERY_MAX = 120;

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
  'A RESEARCH ask when a speaker uses the NOW cue to have something FOUND',
  'OUT before it can be decided or built — "can you look into why it does',
  'that", "could you find out what it would take", "Claude, can you research',
  'X". They will rarely say the word "research". Wondering aloud is not an',
  'ask; somebody has to want it done. "topic": what to look into, in the',
  'words spoken; "question": what it should answer, omitted if unsaid.',
  'Prefer "request" when they asked for the WORK rather than for findings.',
] as const;

/**
 * What a review ask sounds like — the Review float's press, spoken. The
 * shape is "somebody should look at this / answer this", addressed to the
 * agent or the team rather than to the room; the load-bearing line is the
 * one separating it from a question the room is answering for itself.
 */
export const REVIEW_PROMPT_RULE = [
  'A REVIEW ask when a speaker uses the NOW cue to have the agent or the',
  'team LOOK AT the notes or ANSWER a question they cannot settle in the',
  'room — "can you ask the team whether we still need the tunnel", "could',
  'you check these notes". "question": what to ask, in the words spoken. A',
  'question the room goes on to answer itself is not an ask.',
] as const;

/**
 * What a lookup sounds like. The "keep any when" clause earns its tokens:
 * an earlier meeting has no title of its own, so the time phrase is often
 * the only part of the ask that identifies anything (`meeting-lookup.ts`).
 */
export const LOOKUP_PROMPT_RULE = [
  'A LOOKUP when a speaker uses the NOW cue to have material that ALREADY',
  'EXISTS brought in — "can you pull up last week\'s notes", "could you link',
  'the design doc for that". "query": what they asked for in their own',
  'words, KEEPING any "when" they said ("last week", "Tuesday").',
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

/**
 * The convention that decides now from later, and — the half that costs the
 * tokens and earns them — that speech using NEITHER phrasing asks for
 * nothing. Bryan, 2026-09-02 huddle; the phrases themselves are data in
 * `meeting-ask-cues.ts`, where the guard that enforces the same rule reads
 * them.
 *
 * The prompt and the guard must agree or the pass gets worse, not better: a
 * model told to catch "go look into that" would keep returning asks the
 * guard then throws away, spending output tokens on items that can never
 * land. So the examples in every ask rule above were rewritten to carry a
 * cue, rather than leaving the guard to clean up after them.
 *
 * References and corrections are carved out on purpose. Neither is an ask —
 * one names work the board already tracks, the other fixes a note already
 * written — so neither has anything to be for now or for later.
 */
export const ASK_CUE_PROMPT_RULE = [
  'TWO CUES DECIDE NOW FROM LATER. NOW: "can you", "could you", "would you",',
  'often after "Claude," — a research, lookup or review ask, acted on during',
  'the meeting. LATER: "create a task", "make a task", "file a ticket", "add',
  'a ticket" — a request, captured and not started. An ask carrying both',
  '("can you create a task") is LATER. Speech with NEITHER cue asks for',
  'nothing: no request, no research, no lookup, no review, however much it',
  'sounds like one. References and corrections are not asks and need no cue.',
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
    'You listen to a live working meeting and extract six things: task',
    'REQUESTS, task REFERENCES, RESEARCH asks, LOOKUP asks, CORRECTIONS and',
    'REVIEW asks. Answer with JSON only, this shape:',
    '{"items":[{"kind":"request","title":"...","actionable":true|false,',
    '           "requester":"who asked, omitted if unclear"}',
    '         |{"kind":"reference","match":<candidate number>}',
    '         |{"kind":"research","topic":"...","question":"...",',
    '           "requester":"who asked, omitted if unclear"}',
    '         |{"kind":"lookup","query":"..."}',
    '         |{"kind":"correction","wrong":"...","right":"..."}',
    '         |{"kind":"review","question":"...",',
    '           "requester":"who asked, omitted if unclear"}]}',
    '',
    ...ASK_CUE_PROMPT_RULE,
    '',
    'A REQUEST only when a speaker explicitly asks, in the LATER cue, for a',
    'task to be filed — "create a task", "make that a task", "file a ticket",',
    '"add a ticket". Discussing a problem, complaining about a bug, or',
    'agreeing something is broken is NOT a request. Title: short, specific,',
    'in the words spoken.',
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
    ...REVIEW_PROMPT_RULE,
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
 * out-of-range matches, references the transcript cannot vouch for, and asks
 * the speaker never cued are dropped row by row, never letting one bad row
 * cost the good ones.
 *
 * A dropped ask is not a lost one. The speech it was found in still reaches
 * the notes composer, which writes it into the doc as it writes everything
 * else — which is exactly what "captured as a note, not a task and not an
 * action" means here.
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

  // The two spoken conventions, read once off the same lines the model saw.
  // This is the guard half of the contract the prompt states: whatever the
  // model returns, an ask the speech did not cue is DOWNGRADED TO A NOTE —
  // dropped here, so the tick's words reach the notes composer as ordinary
  // speech and nothing files, starts or is addressed to anybody. A request
  // needs the later cue; the three intents that act during the meeting need
  // the now cue. References and corrections are not asks and are not gated.
  const cued = {
    now: cueSpokenOnTick(window, 'now'),
    later: cueSpokenOnTick(window, 'later'),
  };

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
      // "create a task …" is what asks for a row. Without it the speech is a
      // note, even when the model heard a perfectly good piece of work in it.
      if (!cued.later) continue;
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
      // Acting during the meeting takes the now cue — see {@link cued}.
      if (!cued.now) continue;
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
      // Acting during the meeting takes the now cue — see {@link cued}.
      if (!cued.now) continue;
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
    } else if (row.kind === 'review') {
      // Acting during the meeting takes the now cue — see {@link cued}.
      if (!cued.now) continue;
      if (typeof row.question !== 'string') continue;
      const question = row.question.trim().slice(0, QUESTION_MAX);
      if (question.length === 0) continue;
      // Same vouching as research: a question nobody asked is not an ask,
      // and this one files a thread a person will be paged about.
      if (!phraseSpokenOnTick(window, question)) continue;
      const key = `review:${normalizedTitle(question)}`;
      if (seenTitles.has(key)) continue;
      seenTitles.add(key);
      const requester =
        typeof row.requester === 'string' ? speakerOnTick(window, row.requester) : undefined;
      out.push({
        kind: 'review',
        question,
        ...(requester !== undefined ? { requester } : {}),
      });
    }
  }
  return out;
}
