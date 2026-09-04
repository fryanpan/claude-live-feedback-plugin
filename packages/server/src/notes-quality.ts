/**
 * Reading a set of notes the way a checker can: topics, bullets, and the
 * handful of questions about them that have a right answer.
 *
 * WHY THIS IS SOURCE AND NOT A SCRIPT. `bun run notes:eval` asks whether the
 * note-taker behaved — and most of that question needs a model to answer, but
 * some of it does not. "Is any bullet longer than twenty words", "did the same
 * topic get two headings", "is this decision missing the voice that made it",
 * "was a row the notes name left unlinked": those are decidable, and a
 * decidable check belongs somewhere it can be unit-tested rather than inside
 * the harness that consumes it. The eval calls these; so do the behaviour
 * tests, on notes no model wrote.
 *
 * EVERY CHECK RETURNS THE OFFENDERS, NEVER A SCORE. A pass rate is what the
 * eval computes from these; a list of the exact bullets that failed is what
 * somebody tuning the instructions actually needs, and a boolean throws it
 * away.
 */

/**
 * The bar for one bullet, from the row that asked for this behaviour: "no
 * bullet over 20 words". Exported because the number is a product decision
 * that the prompt states and the eval measures, and two copies of it would
 * eventually disagree.
 */
export const MAX_BULLET_WORDS = 20;

/** One topic in a set of notes: its heading, and the bullets under it. */
export interface NotesTopic {
  /** The heading text without its `#` marks. Empty for bullets written
   *  before any heading — a note-taker that wrote no topics at all. */
  heading: string;
  bullets: string[];
}

/**
 * Markdown reduced to the words a reader reads.
 *
 * Link syntax collapses to its LABEL — `[Retry loop wakes the sync](/…)` is
 * the four words of the title, not a URL. Counting the URL would make citing
 * a ticket cost a bullet its length budget, which would teach exactly the
 * wrong lesson.
 *
 * A SPEAKER TAG COLLAPSES TO NOTHING AT ALL. `[@Priya](speaker:A)` is
 * attribution the instructions require and promise is free of the twenty-word
 * budget, so charging for it here would fail a nineteen-word note for obeying
 * them.
 */
export function plainWords(markdown: string): string[] {
  const text = markdown
    // A SPEAKER TAG COSTS NOTHING, because the instructions promise it costs
    // nothing: "the speaker tag does not count towards the twenty". Counting
    // it here would fail a well-behaved nineteen-word note for carrying the
    // attribution the same instructions demand — and the first full eval run
    // did exactly that, reporting a 21-word failure on a bullet whose prose
    // was 19. A rule the writer is told is free must be free to the judge.
    .replace(/\[@[^\]]*\]\(speaker:[^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]/g, '')
    .replace(/^@/, '')
    .replace(/@(?=\w)/g, '');
  return text.split(/\s+/).filter((w) => /[a-zA-Z0-9]/.test(w));
}

/** How long a bullet reads, in words. */
export function bulletWords(bullet: string): number {
  return plainWords(bullet).length;
}

/**
 * A notes section split into its topics.
 *
 * Headings at ANY level become topics: the instructions ask for `###`, the
 * section's own `##` is stripped before this ever sees it, and a model that
 * writes `####` has still opened a topic. Judging the level rather than the
 * act would report a heading as "no topic at all".
 *
 * Nested bullets are flattened to the line they lead with. A sub-bullet is
 * still a bullet a reader reads, and the length bar applies to it.
 */
export function parseNotesTopics(markdown: string): NotesTopic[] {
  const topics: NotesTopic[] = [];
  let current: NotesTopic = { heading: '', bullets: [] };
  let fenced = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      if (current.heading || current.bullets.length > 0) topics.push(current);
      current = { heading: heading[1]!.trim(), bullets: [] };
      continue;
    }
    const bullet = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
    if (bullet && bullet[1]!.trim()) current.bullets.push(bullet[1]!.trim());
  }
  if (current.heading || current.bullets.length > 0) topics.push(current);
  return topics;
}

/** Every bullet in the notes, topics flattened away. */
export function allBullets(markdown: string): string[] {
  return parseNotesTopics(markdown).flatMap((t) => t.bullets);
}

/** The bullets that run past the bar, with their lengths. */
export function overlongBullets(
  markdown: string,
  max: number = MAX_BULLET_WORDS,
): Array<{ bullet: string; words: number }> {
  return allBullets(markdown)
    .map((bullet) => ({ bullet, words: bulletWords(bullet) }))
    .filter((b) => b.words > max);
}

/**
 * Headings that appear more than once — the same topic opened twice.
 *
 * Compared case-insensitively and on words alone, because "Export range" and
 * "Export Range:" are one topic to a reader and two strings to a computer,
 * and the failure this catches is the reader's.
 */
export function duplicateTopics(markdown: string): string[] {
  const seen = new Map<string, { heading: string; count: number }>();
  for (const topic of parseNotesTopics(markdown)) {
    if (!topic.heading) continue;
    const key = topic.heading
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim();
    const hit = seen.get(key);
    if (hit) hit.count++;
    else seen.set(key, { heading: topic.heading, count: 1 });
  }
  return [...seen.values()].filter((s) => s.count > 1).map((s) => s.heading);
}

/** A speaker tag as the notes carry it: `[@Name](speaker:LABEL)`. */
const SPEAKER_TAG = /\[@[^\]]+\]\(speaker:[^)]+\)/;

/**
 * Bullets that record a decision or an open question without saying whose.
 *
 * The two kinds are spotted by the words a note-taker uses to write them,
 * which is a heuristic and is allowed to be: a bullet this misses is one the
 * model judge still sees, and a bullet this catches wrongly is a bullet whose
 * speaker tag would have done no harm.
 */
const DECISION_WORDS =
  /\b(decid|agreed|agree to|will |we'll|going to|chose|choosing|settled on|owner|action|next step|takes? this|picking up)/i;
const QUESTION_WORDS =
  /\?|\b(open question|unresolved|unclear whether|asked whether|wants to know)\b/i;

export function decisionsWithoutSpeaker(markdown: string): string[] {
  return allBullets(markdown).filter(
    (b) => (DECISION_WORDS.test(b) || QUESTION_WORDS.test(b)) && !SPEAKER_TAG.test(b),
  );
}

/** Bullets carrying the marker the instructions ask for on a guess. */
export function unconfirmedBullets(markdown: string): string[] {
  return allBullets(markdown).filter((b) => /\(unconfirmed\)/i.test(b));
}

/**
 * Rows the notes NAME but do not link.
 *
 * The reference search already decided which of the board's titles this
 * meeting's speech contained; this asks the same question of what was
 * WRITTEN, and reports the ones whose title is in the prose with no link
 * around it. A row that reaches the notes as a link and again as bare words
 * later in the same bullet is not reported: the instructions ask for the
 * first mention only.
 */
export function unlinkedReferences(
  markdown: string,
  references: ReadonlyArray<{ title: string; url: string }>,
): string[] {
  const out: string[] = [];
  for (const reference of references) {
    if (markdown.includes(`](${reference.url})`)) continue;
    const spoken = reference.title.toLowerCase();
    if (markdown.toLowerCase().includes(spoken)) out.push(reference.title);
  }
  return out;
}

/**
 * Lines of the notes that are somebody's exact words rather than a note.
 *
 * A cheap, high-precision proxy for "this was not paraphrased": the bullet
 * repeats a run of the transcript verbatim. Eight words is long enough that
 * two people writing about the same thing do not collide by accident and
 * short enough to catch a bullet that copied one clause and trimmed the rest.
 * What it cannot see — a bullet that is transcript-shaped without being
 * word-for-word — is the model judge's half of the same question.
 */
export const VERBATIM_RUN_WORDS = 8;

export function verbatimBullets(
  markdown: string,
  transcript: string,
  run: number = VERBATIM_RUN_WORDS,
): string[] {
  const normalize = (text: string): string[] =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
  const source = normalize(transcript).join(' ');
  if (!source) return [];
  return allBullets(markdown).filter((bullet) => {
    const words = normalize(plainWords(bullet).join(' '));
    for (let i = 0; i + run <= words.length; i++) {
      if (source.includes(words.slice(i, i + run).join(' '))) return true;
    }
    return false;
  });
}
