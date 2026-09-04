/**
 * "Is somebody already planning this?" — the matcher behind `find_related_work`.
 *
 * A plan request arrives as a sentence ("write me a plan for the meeting
 * notes UX"). The board usually already holds the answer in part: a goal band
 * about that outcome, a plan doc somebody wrote last week, the huddle notes
 * the request came out of. An agent that does not look first files a bare
 * duplicate goal beside the real one, which is the incident this module
 * exists for (2026-09-02: planning ignored work already on the board, and the
 * goal it created had no description and no link to the notes).
 *
 * What this file is: the pure half. Given the request text and a flat list of
 * candidates the server assembled, it scores each one, writes a one-line
 * reason, and answers the few that clear a threshold. No I/O, no LLM call —
 * deliberately. The question "which rows should a human be asked about" does
 * not need a model to answer, and a matcher that costs a token budget is a
 * matcher agents skip. Cheap token overlap plus the board's own link graph
 * gets the candidate set small enough for a person to read in one glance,
 * which is all the step is for: the DECISION stays with the human.
 *
 * Two signals, and they are weighted very differently on purpose:
 *
 *   • TITLE overlap, by Dice coefficient. Both sides are short, so a
 *     symmetric measure is right — a two-word title that matches two of the
 *     request's words is a strong signal, and normalizing by only one side
 *     would either flatter a long title or bury a short one.
 *
 *   • BODY overlap, by COVERAGE of the request. A goal's prose runs to
 *     paragraphs and a plan doc to pages, so Dice against a body is near zero
 *     for everything and ranks nothing. What a reader actually means by "that
 *     doc is about this" is that the doc mentions most of what they asked
 *     about, which is |request ∩ body| / |request|.
 *
 * And one relation: a LINK. A goal that already points at the doc the request
 * came from is related whether or not its words match, so a link is a flat
 * bonus rather than a multiplier — it can carry a candidate over the
 * threshold by itself, which is exactly the "link-only match" case.
 *
 * Scores are advisory. Nothing here decides anything; the caller shows the
 * list to a person and asks.
 */

/**
 * How the two text signals and the link relation combine.
 *
 * Title is weighted over body because a title is somebody's summary of the
 * work and a body is everything they happened to write down — a request that
 * matches a title matches the outcome, and one that matches only scattered
 * body words often matches a passing mention.
 */
export const TITLE_WEIGHT = 0.7;
export const BODY_WEIGHT = 0.3;
/**
 * A link's flat contribution. Above `DEFAULT_THRESHOLD` on purpose: a goal
 * that links the doc the request came out of is worth surfacing even when its
 * title shares no word with the ask, because the person who wrote the link
 * already said the two belong together.
 */
export const LINK_BONUS = 0.35;

/** Below this, a candidate is noise and is dropped rather than ranked last. */
export const DEFAULT_THRESHOLD = 0.25;

/** How many matches a caller sees unless it asks for fewer. Five is what
 *  fits in a review item a person reads on a phone. */
export const DEFAULT_LIMIT = 5;

/** Terms shorter than this carry no topic. */
const MIN_TERM_LENGTH = 3;

/** At most this many shared terms are named in a reason line. */
const MAX_REASON_TERMS = 4;

/**
 * Words that appear in every board's prose and so distinguish nothing.
 *
 * Deliberately small and hand-picked rather than a general English stopword
 * list: the risk here runs one way. Dropping a word that mattered ("plan"
 * itself, say, in a request about the planning flow) loses a real match
 * silently, while keeping a common word costs a little precision that the
 * threshold absorbs. So this holds only words whose presence in a task title
 * genuinely says nothing about its subject.
 */
const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'over',
  'under',
  'about',
  'have',
  'has',
  'had',
  'was',
  'were',
  'been',
  'are',
  'not',
  'but',
  'can',
  'will',
  'would',
  'should',
  'could',
  'their',
  'they',
  'them',
  'its',
  'our',
  'you',
  'your',
  'his',
  'her',
  'when',
  'what',
  'which',
  'who',
  'how',
  'why',
  'where',
  'there',
  'here',
  'then',
  'than',
  'some',
  'any',
  'all',
  'one',
  'two',
  'get',
  'got',
  'make',
  'made',
  'use',
  'used',
  'need',
  'needs',
  'want',
  'wants',
  'please',
  'just',
  'also',
  'more',
  'most',
  'much',
  'very',
  'out',
  'off',
  'per',
  'via',
  'let',
  'lets',
  'like',
  'now',
  'new',
  'old',
  'yet',
]);

/**
 * A candidate the caller assembled: a goal band, or a doc on the board.
 *
 * The server decides what goes in this list (which docs read as plans, which
 * ones a goal links). This module only ranks what it is given, so a change in
 * that policy never needs a change in the scoring.
 */
export interface RelatedWorkCandidate {
  kind: 'goal' | 'doc';
  /** Goal id, or doc id. */
  id: string;
  title: string;
  /** The goal's prose, or the doc's markdown. Absent is fine — a candidate
   *  with no body is scored on its title alone rather than penalized. */
  body?: string;
  /** For a doc, the file it is bound to. Scored as text too: a path like
   *  `docs/product/plans/meeting-notes-ux-plan.md` names the subject. */
  path?: string;
  /**
   * Set when the board's own link graph already ties this candidate to the
   * request's context — a goal whose `links` name a doc the requester cited,
   * or a doc a goal points at. The caller decides what counts; this module
   * only pays the bonus.
   */
  linked?: boolean;
  /** What the link IS, in the requester's words, for the reason line —
   *  "linked from the goal Live meetings", say. */
  linkNote?: string;
  /** Where a reader opens it. Passed through untouched. */
  url?: string;
}

/** One ranked candidate, with the sentence a person reads. */
export interface RelatedWorkMatch {
  kind: 'goal' | 'doc';
  id: string;
  title: string;
  /** 0–1, rounded to three places so a wire payload is readable. */
  score: number;
  /** One line saying WHY this came back — the terms it shares, or the link. */
  reason: string;
  /** The shared terms, so a caller can render them without re-deriving. */
  matchedTerms: string[];
  linked: boolean;
  url?: string;
}

export interface ScoreRelatedWorkOptions {
  /** Below this, drop. Defaults to `DEFAULT_THRESHOLD`. */
  threshold?: number;
  /** How many to keep. Defaults to `DEFAULT_LIMIT`. */
  limit?: number;
}

/**
 * Words a title or a path uses when it is a plan rather than a note.
 *
 * Broad on purpose — a spec, a design doc and a proposal are all things a new
 * plan would either extend or replace, and asking about one too many is a
 * cheaper mistake than missing the doc that already covers the request.
 */
const PLAN_WORDS = new Set([
  'plan',
  'planning',
  'roadmap',
  'spec',
  'specification',
  'design',
  'proposal',
  'rfc',
  'strategy',
  'brief',
]);

/**
 * Split text into scoreable terms: lowercase, punctuation gone, stopwords and
 * one- and two-letter words dropped, trailing plural `s` stripped.
 *
 * The plural strip is the whole of the normalization, and it earns its place:
 * "meeting notes" against a goal called "Meeting note capture" is the exact
 * near-miss this step is for. It is applied to both sides, so the words it
 * mangles ("process" → "proces") still match each other — a stemmer's job
 * here is consistency, not correctness.
 */
export function relatedWorkTerms(text: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(raw)) continue;
    const term = raw.length > MIN_TERM_LENGTH && raw.endsWith('s') ? raw.slice(0, -1) : raw;
    if (term.length < MIN_TERM_LENGTH) continue;
    if (STOPWORDS.has(term)) continue;
    out.add(term);
  }
  return out;
}

/**
 * Whether a doc's title or path reads as a plan.
 *
 * Path segments are checked term by term, so `docs/product/plans/x.md` hits
 * on `plans` without a substring match that would also fire on "explanation".
 */
export function readsAsPlan(doc: { title?: string; path?: string }): boolean {
  for (const term of relatedWorkTerms(`${doc.title ?? ''} ${doc.path ?? ''}`)) {
    if (PLAN_WORDS.has(term)) return true;
  }
  return false;
}

function intersect(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const term of a) if (b.has(term)) shared.push(term);
  return shared;
}

/** 2|A∩B| / (|A|+|B|) — 1 for identical sets, 0 for disjoint ones. */
function dice(a: Set<string>, b: Set<string>, sharedCount: number): number {
  const total = a.size + b.size;
  return total === 0 ? 0 : (2 * sharedCount) / total;
}

function listTerms(terms: string[]): string {
  const shown = terms.slice(0, MAX_REASON_TERMS);
  const rest = terms.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * Rank candidates against a request, keeping only what clears the threshold.
 *
 * Answers `[]` — not a best-effort top row — when nothing clears it. That
 * empty answer is load-bearing: it is what tells the caller to plan from
 * scratch instead of asking a question with no real options in it.
 */
export function scoreRelatedWork(
  requestText: string,
  candidates: RelatedWorkCandidate[],
  opts: ScoreRelatedWorkOptions = {},
): RelatedWorkMatch[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const request = relatedWorkTerms(requestText);
  const matches: RelatedWorkMatch[] = [];

  for (const candidate of candidates) {
    // The path is scored with the title rather than with the body: it is a
    // naming of the doc, not a mention inside it.
    const titleTerms = relatedWorkTerms(`${candidate.title} ${candidate.path ?? ''}`);
    const bodyTerms = relatedWorkTerms(candidate.body);
    const titleShared = intersect(request, titleTerms);
    const bodyShared = intersect(request, bodyTerms);
    const titleScore = dice(request, titleTerms, titleShared.length);
    const bodyScore = request.size === 0 ? 0 : bodyShared.length / request.size;
    const linked = candidate.linked === true;
    const score = Math.min(
      1,
      TITLE_WEIGHT * titleScore + BODY_WEIGHT * bodyScore + (linked ? LINK_BONUS : 0),
    );
    if (score < threshold) continue;

    // Reason parts, in the order a reader wants them: the strongest signal
    // first. Every part names actual evidence — no part is ever a restatement
    // of the score, because a number is not a reason.
    const parts: string[] = [];
    if (titleShared.length > 0) parts.push(`title shares ${listTerms(titleShared)}`);
    // Body terms the title already carried are not new evidence.
    const bodyOnly = bodyShared.filter((t) => !titleTerms.has(t));
    if (bodyOnly.length > 0) parts.push(`body mentions ${listTerms(bodyOnly)}`);
    if (linked) parts.push(candidate.linkNote ?? 'already linked to this work');
    const noun = candidate.kind === 'goal' ? 'Goal' : 'Doc';
    matches.push({
      kind: candidate.kind,
      id: candidate.id,
      title: candidate.title,
      score: Math.round(score * 1000) / 1000,
      reason: parts.length > 0 ? `${noun}: ${parts.join('; ')}` : `${noun}: related`,
      matchedTerms: [...new Set([...titleShared, ...bodyOnly])],
      linked,
      ...(candidate.url !== undefined ? { url: candidate.url } : {}),
    });
  }

  // Highest first; goals before docs at equal score because a goal is where
  // the plan would land, and id last so the order is total and a test can
  // assert it.
  matches.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.kind !== b.kind) return a.kind === 'goal' ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return matches.slice(0, limit);
}
