/**
 * Does this description say who the work is for and what it buys them?
 *
 * The sibling of `task-title.ts`, one field over and with the same contract:
 * ADVISORY, never a refusal. Bryan expanded the title standard to cover
 * descriptions on 2026-08-17 (`task:t-hUyldnoHbj_c`, thread `xrdghi76c0bp`),
 * with the governing sentence stated in the same breath — the server *"can
 * detect that the ticket titles are not good, but can't necessarily fix
 * them. And should not gate the capture of information."* So every check
 * here returns a gap and nothing is ever turned away for one.
 *
 * **The scope of this module is deliberately small, and it is small because
 * the board was measured rather than imagined.** Over the 47 open rows on
 * 2026-08-17: zero empty bodies, zero bodies under 120 characters, a median
 * body of 2,374 characters, and 37 already opening with a proper user story.
 * Descriptions here are long and substantive; the deficiency is the OPENING,
 * which is the part a person scanning a board actually reads. So this asks
 * one question about the first paragraph and nothing about the rest. A rule
 * demanding more content would have been answering a problem the corpus does
 * not have.
 *
 * **The decision genre is READ, not sniffed.** A decision task states its
 * question rather than a story and is correct to; `needs: 'decision'` is a
 * declared field and `decision-shape.ts` already owns those bodies. Inferring
 * the genre from the prose instead measured 4 decision rows where the board
 * had 7, and flagged two of the misses as deficient.
 *
 * **Two rules were measured and rejected, which is worth recording so they
 * are not re-proposed.** A "states a done-when" gap fires on 8 otherwise
 * excellent rows, four of them decision tasks (which have a question rather
 * than an acceptance list) and one a 12,674-character body — it measures
 * heading vocabulary, not thoroughness. And a "body is too thin" gap has no
 * instances at all to catch.
 *
 * Every heuristic is ONE-DIRECTIONAL, in the same sense as the title module:
 * it can only fail to notice a story that IS there, never accuse a body that
 * has one. The failure mode is a missed nudge, never a description wrongly
 * called deficient — which is what makes an imperfect detector affordable,
 * because the cost of a miss is a gap nobody was shown and the cost of a
 * false accusation is a person learning to ignore the signal.
 */

/**
 * Personas the standard recognises. Bryan named three — Agent, Bryan,
 * Collaborator — and the rest are the synonyms the board actually uses.
 *
 * A name missing from this list produces a MISS (a real story reported as
 * `no-story`), never a false accusation, which is the direction this module
 * is allowed to fail in. Widen it when a real row is flagged wrongly.
 */
const PERSONAS = [
  'agent',
  'agents',
  'bryan',
  'collaborator',
  'collaborators',
  'peer',
  'peers',
  'reviewer',
  'reviewers',
  'human',
  'humans',
  'anyone',
  'everyone',
  'someone',
];

export type BodyGap = 'empty' | 'no-story';

/**
 * The first PARAGRAPH of a body — not the first line.
 *
 * A markdown paragraph is hard-wrapped across several source lines, so a
 * line-based read would truncate almost every real story mid-clause and
 * report `no-story` on a body that has one.
 *
 * Exported and shared rather than re-implemented: `bodyHead` in
 * `task-title.ts` needs the same paragraph and normalises it further. Two
 * hand-written extractors that must agree will drift, and this repo has
 * already paid for that once with a question-detector and its extractor
 * disagreeing about newlines.
 */
export function firstParagraph(body: string | undefined): string {
  const lines = (body ?? '').split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l.length > 0);
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l.length === 0);
  return lines.slice(start, end === -1 ? lines.length : end).join(' ');
}

/** Emphasis and code markers carry no meaning for these checks. */
function plain(text: string): string {
  return text
    .replace(/^#{1,6}\s*/, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Does this paragraph open with a persona, in the way the standard's grammar
 * opens with one?
 *
 * The persona is looked for at the HEAD of the paragraph rather than anywhere
 * in it, because "the queue should be ordered so that an agent sees it" is
 * prose about an agent, not a story told from one. But it is not required to
 * be the literal first word — "Agent reading a `decision.answered` event can
 * trust…" is a correct story, and requiring word-one/`can`-word-two rejected
 * it. That version was measured against a real board and had three times the
 * false-positive rate of this one.
 */
function opensWithPersona(paragraph: string): boolean {
  const first =
    paragraph
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z]/g, '') ?? '';
  if (PERSONAS.includes(first)) return true;
  // "An agent pushing to this repo can trust…" — one article, then a persona.
  if (first === 'a' || first === 'an' || first === 'the') {
    const second =
      paragraph
        .split(/\s+/)[1]
        ?.toLowerCase()
        .replace(/[^a-z]/g, '') ?? '';
    return PERSONAS.includes(second);
  }
  return false;
}

/**
 * The gaps a description's own text can reveal, with no other context.
 *
 * `empty` short-circuits: a body with no words has exactly one thing wrong
 * with it, and reporting a missing story as well would read as two problems
 * where there is one.
 */
export function bodyShapeGaps(body: string | undefined, needs?: 'action' | 'decision'): BodyGap[] {
  // A decision row is not a story and is correct not to be, so this defers
  // entirely rather than second-guessing `decision-shape.ts` — which already
  // owns that field, already REFUSES a decision body with no question in it,
  // and already returns its own advisory gaps. Two advisories composed beat a
  // third that re-derives one of them.
  //
  // Read from the DECLARED field, never sniffed from the prose. A first cut
  // inferred the genre from "opens with a bolded question" and was measured
  // against the live board: it excused 4 rows, and the board actually had 7.
  // The three it missed included two whose authors wrote the question as
  // plain prose and which were being flagged as deficient — the exact
  // expensive-direction failure a proxy for an available field produces.
  if (needs === 'decision') return [];
  const paragraph = plain(firstParagraph(body));
  if (paragraph.length === 0) return ['empty'];
  if (opensWithPersona(paragraph) && /\bso that\b/i.test(paragraph)) return [];
  return ['no-story'];
}

const GAP_TEXT: Record<BodyGap, string> = {
  empty: 'this task has no description at all',
  'no-story':
    'the description does not open with a user story — aim for "<Person> can <achieve goal X> so that <goal Y>", or state the question outright if this is a decision',
};

/**
 * One sentence a caller can act on without going and reading the standard.
 *
 * Every gap needs text here. A gap with none renders as its own slug, which
 * is the failure this repo already recorded when a new event reached the
 * activity feed as the literal string `task.body_edited` — nothing goes red,
 * the row just reads like a log line in a view built for people.
 */
export function bodyGapMessage(gaps: readonly BodyGap[]): string | undefined {
  if (gaps.length === 0) return undefined;
  const parts = gaps.map((g) => GAP_TEXT[g]);
  return `Description needs work: ${parts.join('; ')}.`;
}
