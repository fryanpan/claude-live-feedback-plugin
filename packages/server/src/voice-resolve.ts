/**
 * The deterministic half of voice routing: everything the server can decide
 * about an utterance WITHOUT a model.
 *
 * Bryan, 2026-08-29: *"Asking to go to an item with only vaguely relevant
 * words has never worked (eg 'I want to go to the Akash review doc in
 * QB')."* The fast path handed the whole index to Haiku and accepted only an
 * EXACT id back, so a vague name either matched nothing or matched whatever
 * the model felt like. Title similarity is a thing this process can compute
 * itself, in microseconds, and — unlike the model — it can say HOW SURE it
 * is. That number is what lets the router ask "which one?" instead of
 * guessing: wrong-but-confident navigation is worse than asking.
 *
 * Everything here is pure and table-testable. The router (voice.ts) owns
 * what to do with the answers.
 */
import type { TaskStatus } from './tasks.ts';

// ── Tokens ──────────────────────────────────────────────────────────────────

/**
 * Words that carry no identity. Verbs of navigation and the words that name
 * a KIND of thing ("the akash review DOC") are stripped along with articles:
 * they tell us what the speaker wants to do, not which thing they mean.
 * `review` is deliberately NOT here — it is a real word in real titles
 * ("Review: Akash — …").
 */
const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'to',
  'of',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'my',
  'me',
  'i',
  'we',
  'it',
  'its',
  'is',
  'this',
  'that',
  'please',
  'go',
  'open',
  'show',
  'find',
  'take',
  'want',
  'up',
  'doc',
  'docs',
  'document',
  'task',
  'tasks',
  'ticket',
  'item',
  'page',
  'one',
  'thing',
]);

/** Lower-cased alphanumeric words, stop words removed. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !STOP_WORDS.has(w));
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** Dice coefficient over character trigrams — 1 is identical. */
function trigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return (2 * shared) / (ta.size + tb.size);
}

/** A prefix shorter than this is not evidence: "test" is the start of
 *  "testing" AND "testimonials", and a four-letter match once opened the
 *  wrong one. Five letters ("place" / "placeholders") is where a prefix
 *  starts to mean the word. */
const PREFIX_MIN = 5;

/**
 * Do two spoken words mean the same title word? Exact, or the shorter is a
 * prefix of the other and at least `PREFIX_MIN` letters ("placeholder" /
 * "placeholders"), or close enough in trigrams that a transcription slip in
 * a LONG word would explain it ("onbording" / "onboarding"). Short words get
 * no slip tolerance: at four or five letters, one changed letter is a
 * different word ("akash" / "akesh"), and the trigram test says so.
 */
export function wordsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const shorter = Math.min(a.length, b.length);
  if (shorter >= PREFIX_MIN && (a.startsWith(b) || b.startsWith(a))) return true;
  return shorter >= 4 && trigramSimilarity(a, b) >= 0.75;
}

/** The KIND of thing the speaker named, when they said so: "the mobile DOC"
 *  is a doc even when a task is called Mobile. `review` is not a kind word —
 *  it is a real word in real titles ("Review: Akash — …"). */
export function spokenKind(text: string): 'task' | 'doc' | undefined {
  const words = new Set(text.toLowerCase().split(/[^a-z]+/));
  const doc = ['doc', 'docs', 'document', 'page'].some((w) => words.has(w));
  const task = ['task', 'tasks', 'ticket'].some((w) => words.has(w));
  if (doc === task) return undefined;
  return doc ? 'doc' : 'task';
}

// ── Title resolution ────────────────────────────────────────────────────────

export interface TitleCandidate {
  id: string;
  kind: 'task' | 'doc';
  title: string;
}

export interface ScoredCandidate extends TitleCandidate {
  score: number;
}

export type TitleResolution =
  | { kind: 'hit'; match: ScoredCandidate }
  | { kind: 'ambiguous'; matches: [ScoredCandidate, ScoredCandidate] }
  | { kind: 'none'; top: ScoredCandidate[] };

/** Below this the best candidate is not a match at all. */
export const TITLE_FLOOR = 0.5;
/** Closer than this between first and second is a question, not an answer. */
export const TITLE_MARGIN = 0.15;

/**
 * Every candidate scored against the query, best first.
 *
 * Score = 0.6 × (how much of the QUERY the title accounts for) + 0.4 × (how
 * much of the TITLE the query accounts for). Query words are weighted by
 * rarity across the index, so "akash" (one title) outweighs "review" (many).
 * The title-coverage term prefers the title with the least left over — for
 * "results page", "Wire the results page" (0.8) over "Fold the plan into the
 * results page" (0.7) — but that gap is INSIDE `TITLE_MARGIN`, so the
 * resolver asks rather than picks; the term only decides when the titles
 * differ by more than one clause.
 *
 * A spoken kind word ("the mobile DOC") keeps only candidates of that kind,
 * provided there are any: the word is the speaker disambiguating, and it
 * used to be thrown away as a stop word.
 */
export function rankTitles(query: string, candidates: TitleCandidate[]): ScoredCandidate[] {
  const q = tokenize(query);
  if (q.length === 0 || candidates.length === 0) return [];
  const kind = spokenKind(query);
  const pool =
    kind && candidates.some((c) => c.kind === kind)
      ? candidates.filter((c) => c.kind === kind)
      : candidates;
  return rankPool(q, pool);
}

function rankPool(q: string[], candidates: TitleCandidate[]): ScoredCandidate[] {
  const titleTokens = candidates.map((c) => tokenize(c.title));
  const n = candidates.length;
  const df = new Map<string, number>();
  for (const word of q) {
    let count = 0;
    for (const tokens of titleTokens) if (tokens.some((t) => wordsMatch(word, t))) count++;
    df.set(word, count);
  }
  const weight = (word: string): number => Math.log(1 + n / Math.max(1, df.get(word) ?? 0));
  const totalWeight = q.reduce((sum, w) => sum + weight(w), 0);
  return candidates
    .map((c, i) => {
      const tokens = titleTokens[i] ?? [];
      if (tokens.length === 0) return { ...c, score: 0 };
      let matchedWeight = 0;
      const covered = new Set<number>();
      for (const word of q) {
        const at = tokens.findIndex((t, j) => !covered.has(j) && wordsMatch(word, t));
        if (at >= 0) {
          matchedWeight += weight(word);
          covered.add(at);
        }
      }
      const queryCoverage = totalWeight > 0 ? matchedWeight / totalWeight : 0;
      const titleCoverage = covered.size / tokens.length;
      return { ...c, score: 0.6 * queryCoverage + 0.4 * titleCoverage };
    })
    .sort((a, b) => b.score - a.score);
}

/** A hit, a question, or nothing — see `TITLE_FLOOR` / `TITLE_MARGIN`. */
export function resolveByTitle(query: string, candidates: TitleCandidate[]): TitleResolution {
  const ranked = rankTitles(query, candidates);
  const [best, second] = ranked;
  if (!best || best.score < TITLE_FLOOR) {
    return { kind: 'none', top: ranked.filter((c) => c.score > 0).slice(0, 6) };
  }
  if (second && second.score >= TITLE_FLOOR && best.score - second.score < TITLE_MARGIN) {
    return { kind: 'ambiguous', matches: [best, second] };
  }
  return { kind: 'hit', match: best };
}

// ── Intent detection ────────────────────────────────────────────────────────

/**
 * The openers that make an utterance "take me to …". Deliberately a closed
 * list, matched at the START of the sentence (after an optional "I want to"
 * / "can you" / "let's"): a navigation verb buried mid-sentence is more
 * often a change ("mark this done and open the notes") and those belong to
 * the agent.
 */
const NAV_OPENER =
  /^(?:(?:i(?:'d| would)? (?:want|like|need) to|can you|could you|please|let'?s|lets)\s+)?(?:go to|go into|take me to|bring me to|jump to|navigate to|switch to|open(?: up)?|show(?: me)?|find|pull up|bring up|look at|where is|where's)\s+(.+)$/i;

/**
 * A trailing "in <board>" names the workspace, which the request already
 * carries; it is not part of the item's name. Only a board the caller KNOWS
 * the name of is stripped: an unanchored "in <word>" once took " in flow"
 * off "open sign in flow" and left "sign" to tie with "Signals dashboard".
 */
function boardQualifier(boardNames: readonly string[]): RegExp | null {
  const names = boardNames.map((n) => n.trim()).filter((n) => n.length > 0);
  if (names.length === 0) return null;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(
    `\\s+(?:in|on)\\s+(?:the\\s+)?(?:${alt})(?:\\s+(?:board|workspace|hub))?\\s*$`,
    'i',
  );
}

/** The name of the thing a navigation ask names, or null when the utterance
 *  is not one. Quotes are dropped; a trailing "in <board>" is dropped when
 *  `boardNames` holds that board. */
export function navigationAsk(
  transcript: string,
  boardNames: readonly string[] = [],
): string | null {
  const s = transcript.trim().replace(/[.!?]+$/, '');
  const m = NAV_OPENER.exec(s);
  if (!m?.[1]) return null;
  let name = m[1]
    .replace(/["'“”‘’]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const qualifier = boardQualifier(boardNames);
  if (qualifier && tokenize(name).length > 1) name = name.replace(qualifier, '');
  name = name.trim();
  return name.length > 0 ? name : null;
}

const STATUS_PATTERNS: readonly RegExp[] = [
  /^(?:(?:a |the )?(?:brief|quick|short) )?status(?: (?:update|report|check|please))?$/,
  /^(?:give me |i want |can i get |can i have )(?:a |the )?(?:brief |quick |short )?(?:status|update)(?: update| report)?$/,
  /^(?:whats|what is|what's) the status(?: (?:here|now|of this|on this))?$/,
  /^where (?:are|do) we(?: (?:at|stand|now))?$/,
  /^how (?:are|is) (?:we|it|this|things) (?:doing|going)$/,
  /^catch me up$/,
  /^(?:whats|what's|what is) new$/,
];

/** "brief status", "status update", "where are we" — a READ of the board, not
 *  a change and not a lookup. Whole-utterance patterns, so "open the status
 *  doc" is still a lookup. */
export function statusAsk(transcript: string): boolean {
  const s = transcript
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/[^a-z' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return STATUS_PATTERNS.some((p) => p.test(s));
}

// ── Picking an option ───────────────────────────────────────────────────────

const ORDINAL_WORDS: Record<string, number> = {
  first: 0,
  '1st': 0,
  '1': 0,
  second: 1,
  '2nd': 1,
  '2': 1,
  two: 1,
  third: 2,
  '3rd': 2,
  '3': 2,
  three: 2,
  fourth: 3,
  '4th': 3,
  '4': 3,
  four: 3,
  fifth: 4,
  '5th': 4,
  '5': 4,
  five: 4,
  sixth: 5,
  '6th': 5,
  '6': 5,
  six: 5,
};

/** Words that surround a pick without naming it: "PICK THE second ONE",
 *  "GO TO THE second ONE" — the navigation openers are filler here too,
 *  because the pick may be answering a "which one?" about where to go. */
const PICK_FILLER = new Set([
  'pick',
  'choose',
  'select',
  'go',
  'to',
  'into',
  'open',
  'show',
  'me',
  'jump',
  'navigate',
  'switch',
  'bring',
  'with',
  'take',
  'the',
  'option',
  'number',
  'choice',
  'answer',
  'please',
  'i',
  'id',
  'ill',
  'want',
  'like',
  'lets',
  'let',
  'us',
  'do',
  'that',
  'this',
  'prefer',
  'say',
]);

/**
 * "the second one" → 1. Zero-based index into `count` options, or null when
 * the utterance is not an ordinal pick (a label, a sentence, an ordinal past
 * the end). "one" on its own is the first option; after an ordinal it is the
 * noun ("the second one").
 */
export function parseOrdinal(transcript: string, count: number): number | null {
  const words = transcript
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0 && !PICK_FILLER.has(w));
  if (words.length === 0 || words.length > 2) return null;
  const [head, tail] = words;
  if (!head) return null;
  if (tail !== undefined && tail !== 'one') return null;
  let index: number | undefined;
  if (head === 'last') index = count - 1;
  else if (head === 'one' && tail === undefined) index = 0;
  else index = ORDINAL_WORDS[head];
  if (index === undefined || index < 0 || index >= count) return null;
  return index;
}

/**
 * The label a pick names, when the words after the pick verb resolve to
 * exactly one option. "choose keep placeholders" → "Keep placeholders".
 * Ambiguous or unmatched → null; the router then tries the model, and the
 * model may only ever answer with the transcript's own words.
 */
export function pickByLabel<T extends { id: string; label: string }>(
  transcript: string,
  options: readonly T[],
): T | null {
  const spoken = transcript
    .toLowerCase()
    .replace(/[’']/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0)
    .filter((w, i, all) => !(PICK_FILLER.has(w) && i < all.length - 1 && !ORDINAL_WORDS[w]))
    .join(' ');
  if (spoken.length === 0) return null;
  const r = resolveByTitle(
    spoken,
    options.map((o) => ({ id: o.id, kind: 'task' as const, title: o.label })),
  );
  if (r.kind !== 'hit') return null;
  return options.find((o) => o.id === r.match.id) ?? null;
}

/**
 * "answer: yes but only for the auth task" → the words after the prefix.
 * Null when no prefix — the utterance is not, by itself, an answer.
 *
 * The prefix is a LABEL the speaker put on their words, so it is stripped
 * only where it reads as one: followed by punctuation ("answer: …"), by
 * "with" ("reply with …"), or by words that are plainly the answer. "reply
 * that we should wait" keeps its "reply that" — there the verb is part of
 * the sentence, and the sentence is what gets posted.
 */
export function answerBody(transcript: string): string | null {
  const m =
    /^(?:my answer is|the answer is|answer is|i answer|answer|reply|respond)(?:\s*[:,\-–—]\s*|\s+with\s+|\s+)(.+)$/i.exec(
      transcript.trim(),
    );
  if (!m?.[1]) return null;
  const punctuated = /^(?:[a-z ]+?)\s*[:,\-–—]/i.test(transcript.trim());
  const body = m[1].trim();
  // Bare "reply that …" / "answer to …" — the verb belongs to the sentence.
  if (
    !punctuated &&
    /^(?:that|to|on|about|is|was|it)\b/i.test(body) &&
    !/\bwith\s+/i.test(transcript.slice(0, transcript.length - body.length))
  ) {
    return null;
  }
  return body.length > 0 ? body : null;
}

// ── Status ──────────────────────────────────────────────────────────────────

/** The one number Bryan named: *"that should be able to show me a 100 word
 *  message."* The composer stays under it; the client's strip holds it. */
export const VOICE_STATUS_MAX_WORDS = 100;

/** A token that counts as a word: has a letter or digit in it. "—" and "→"
 *  are punctuation the composer puts between words, not words. ONE predicate
 *  for counting and for cutting — they once disagreed, and a brief that
 *  counted as 100 words could still be cut mid-sentence. */
const isWord = (token: string): boolean => /[a-z0-9]/i.test(token);

export function countWords(text: string): number {
  return text.split(/\s+/).filter(isWord).length;
}

/** Cut `text` to `max` words on a word boundary, marking the cut. Counted
 *  the way `countWords` counts, so a text it calls `max` words is not cut. */
export function capWords(text: string, max: number): string {
  const tokens = text.trim().split(/\s+/);
  let seen = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i] ?? '')) continue;
    seen++;
    if (seen === max && tokens.slice(i + 1).some(isWord)) {
      return `${tokens.slice(0, i + 1).join(' ')}…`;
    }
  }
  return text.trim();
}

export interface StatusTask {
  id: string;
  title: string;
  status: TaskStatus | string;
  assignee: string;
  needs?: string;
  doneAt?: number;
  lastMove?: { from: string; to: string; by: string; ts: number };
  links?: number;
}

export interface StatusQueueRow {
  title: string;
  ask: string;
  askedBy: string;
}

export interface StatusInput {
  workspaceName: string;
  tasks: StatusTask[];
  /** What is waiting on a person, board-wide. */
  queue: StatusQueueRow[];
  now: number;
  /** The task in view, when there is one — the summary is about IT first. */
  task?: StatusTask;
  /** The doc in view, when there is one. */
  doc?: { title: string; asks: StatusQueueRow[] };
}

/** "3h ago" — coarse on purpose; a status read aloud has no use for seconds. */
export function ago(ts: number, now: number): string {
  const min = Math.max(0, Math.round((now - ts) / 60_000));
  if (min < 2) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const STATUS_LABEL: Record<string, string> = {
  'in-progress': 'in progress',
  todo: 'to do',
  done: 'done',
  triage: 'in triage',
};

function quote(text: string, maxWords: number): string {
  return `“${capWords(text, maxWords)}”`;
}

function listTitles(items: Array<{ title: string }>, max: number): string {
  const shown = items.slice(0, max).map((t) => quote(t.title, 8));
  const rest = items.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * The brief, composed from the store — never from a model.
 *
 * Segments in priority order, each dropped whole from the tail until the
 * total fits; then a hard word cap as the last resort. The order is what a
 * person asking "where are we" wants first: the thing in view, what is in
 * progress, what is waiting on THEM, what just shipped.
 */
export function composeStatus(input: StatusInput): string {
  const { tasks, queue, now } = input;
  const segments: string[] = [];

  if (input.task) {
    const t = input.task;
    const parts = [`${quote(t.title, 12)} is ${STATUS_LABEL[t.status] ?? t.status}`];
    parts.push(t.assignee ? `with ${t.assignee}` : 'unassigned');
    if (t.needs) parts.push(`needs ${t.needs}`);
    segments.push(`${parts.join(', ')}.`);
    if (t.lastMove) {
      segments.push(
        `Last move: ${STATUS_LABEL[t.lastMove.from] ?? t.lastMove.from} → ${STATUS_LABEL[t.lastMove.to] ?? t.lastMove.to} by ${t.lastMove.by}, ${ago(t.lastMove.ts, now)}.`,
      );
    }
    const asks = queue.filter((q) => q.title === t.title);
    segments.push(
      asks.length > 0
        ? `Waiting on you: ${asks
            .slice(0, 2)
            .map((a) => quote(a.ask, 12))
            .join('; ')}.`
        : 'Nothing waiting on you here.',
    );
    if (t.links) segments.push(`${t.links} linked ${t.links === 1 ? 'doc' : 'docs'}.`);
  } else if (input.doc) {
    const d = input.doc;
    segments.push(
      d.asks.length > 0
        ? `${quote(d.title, 10)}: ${d.asks.length} waiting on you — ${d.asks
            .slice(0, 2)
            .map((a) => `${quote(a.ask, 12)} (${a.askedBy})`)
            .join('; ')}.`
        : `${quote(d.title, 10)}: nothing waiting on you.`,
    );
  }

  const open = tasks.filter((t) => t.status !== 'done');
  const inProgress = open.filter((t) => t.status === 'in-progress');
  const todo = open.filter((t) => t.status !== 'in-progress');
  const done = tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0));

  if (!input.task) {
    segments.push(
      `${input.workspaceName}: ${open.length} open — ${inProgress.length} in progress, ${todo.length} to do, ${done.length} done.`,
    );
  }
  if (inProgress.length > 0 && (!input.task || inProgress.some((t) => t.id !== input.task?.id))) {
    segments.push(`In progress: ${listTitles(inProgress, 3)}.`);
  }
  if (!input.task && !input.doc) {
    segments.push(
      queue.length > 0
        ? `Waiting on you: ${queue.length} — ${queue
            .slice(0, 2)
            .map((q) => `${quote(q.ask, 10)} on ${quote(q.title, 6)}`)
            .join('; ')}.`
        : 'Nothing waiting on you.',
    );
  }
  if (done.length > 0) {
    const newest = done[0];
    segments.push(
      `Done recently: ${listTitles(done, 3)}${newest?.doneAt ? ` (latest ${ago(newest.doneAt, now)})` : ''}.`,
    );
  }

  // Drop whole trailing segments until the cap holds — a sentence cut in half
  // is worse than a sentence left out. Always keep the first.
  let kept = segments.slice();
  while (kept.length > 1 && countWords(kept.join(' ')) > VOICE_STATUS_MAX_WORDS)
    kept = kept.slice(0, -1);
  return capWords(kept.join(' '), VOICE_STATUS_MAX_WORDS);
}
