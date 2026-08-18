/**
 * Does this title say what the task will actually DO?
 *
 * Reported 2026-08-17: a board of thirty rows could not be prioritised,
 * because the rows named observations rather than work. *"A decision-answered
 * event promises a link checklist the task may not have"* states something
 * somebody noticed; scanning ten of those gives no sense of the plan. The
 * asked-for shape is the same user story a body owes, compressed to one line:
 *
 *     <Person> can <achieve goal X> by <describe action>
 *
 * e.g. *"Bryan can review across tasks faster with clearer task descriptions
 * and UX"*, *"Agents can revise goal priority with a tool to reorder goals"*.
 *
 * ADVISORY, not a refusal — deliberately, and it is the same argument
 * `decision-shape.ts` makes one field over. A hard block on a badly-shaped
 * title would make raw capture impossible, and capture is *designed* to
 * arrive rough and be shaped by triage: a dictated sentence lands with a
 * machine-clipped fragment for a title and its whole unedited utterance for a
 * body. Refusing that loses the thought entirely. So every check here returns
 * a gap, the gap rides the create/rename/rewrite response and the board row,
 * and nothing is ever turned away for it. The one hard floor is a title that
 * is blank, which the routes already refuse for their own reasons.
 *
 * Every heuristic is ONE-DIRECTIONAL in the same sense: it can only fail to
 * notice a part that is present — a persona phrased some way this doesn't
 * read, an action named without a means-marker — never claim a part that is
 * absent. So the failure mode is a missed nudge, never a title wrongly
 * accused. That asymmetry is what makes an imperfect detector affordable
 * here, exactly as it is for the review strip's question detector.
 */

/** Over this, a title stops being scannable across a board. Bryan's number. */
export const IDEAL_TITLE_CHARS = 70;
/** Over this it is not a title at all. Bryan's number. */
export const MAX_TITLE_CHARS = 100;

/**
 * How far into a title the standard's `can` may sit and still be the
 * standard's grammar rather than a coincidence of prose. "A commit that is
 * not a sha should not read as proof so nobody **can** trust it" has a `can`;
 * it does not have a persona clause.
 */
const PERSONA_WORD_WINDOW = 6;

/**
 * Fraction of a body's words that must have changed since the title was last
 * authored before the title is presumed to have stopped describing it.
 *
 * **Which way this is supposed to fail: toward noise.** Tripping when the
 * title was actually still fine costs a dashed "name?" badge and an entry in
 * `titleGaps` — nothing is refused, nothing is rewritten, and no capture is
 * lost. Staying silent when a body has genuinely moved on costs the thing
 * this whole module exists to prevent: a row whose name describes work
 * nobody is doing any more, sitting on a board somebody is trying to
 * prioritise from.
 *
 * So when tuning this, err LOW. A number that fires too often is a nuisance
 * a reader learns to dismiss on a specific row; a number that fires too
 * rarely is indistinguishable from the feature not being there. The known
 * misfire is an agent rewriting a body for reasons unrelated to what the
 * task IS — that is real, and it is the cheap direction.
 */
export const STALE_BODY_DRIFT = 0.3;

/**
 * Comments landing since anyone last named the row, past which the discussion
 * is presumed to have moved the task. One or two replies is the ordinary
 * back-and-forth of doing the work; three is a conversation, and a
 * conversation that redefined the task almost always did so before its third
 * turn. Wrong in the noisy direction by construction — it can only ask
 * somebody to re-read a title.
 */
export const STALE_DISCUSSION_COMMENTS = 3;

export type TitleGap =
  /** Nothing there at all. */
  | 'empty'
  /** Past `MAX_TITLE_CHARS`. */
  | 'too-long'
  /** Past `IDEAL_TITLE_CHARS` — still scannable, but not comfortably. */
  | 'over-ideal'
  /** Doesn't name WHO the work is for. */
  | 'no-persona'
  /** Doesn't say what will be BUILT — no means-clause after the persona. */
  | 'no-action'
  /** Ends mid-thought: an ellipsis, a dangling function word, a comma. */
  | 'clipped'
  /** The description has moved substantially since the title was written. */
  | 'stale-body'
  /** The discussion has moved on since the title was written. */
  | 'stale-discussion';

/**
 * Words a finished title does not end on. A title ending in one of these was
 * cut off — either by a character clip or by somebody stopping mid-sentence.
 * Function words only: no real title's last word is "the".
 */
const DANGLING_TAIL = new Set([
  'a',
  'an',
  'and',
  'as',
  'at',
  'but',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'on',
  'or',
  'so',
  'that',
  'the',
  'their',
  'then',
  'this',
  'to',
  'via',
  'when',
  'which',
  'with',
  'without',
]);

/**
 * The markers that introduce "…by doing what". `so` is here for the body
 * convention's `so that <goal>`, which names the goal rather than the means
 * but is the same promise: this title says more than an observation.
 */
const MEANS_MARKERS = ['by', 'with', 'via', 'using', 'so', 'through'];

/** The persona clause: `<up to PERSONA_WORD_WINDOW words> can <something>`. */
function personaClauseEnd(title: string): number | undefined {
  const words = title.split(/\s+/);
  for (let i = 1; i < Math.min(words.length, PERSONA_WORD_WINDOW + 1); i++) {
    if (/^can('t|not)?$/i.test(words[i] ?? '')) {
      // Something must follow the `can` — "Bryan can" alone promises nothing.
      if (i + 1 >= words.length) return undefined;
      return i;
    }
  }
  return undefined;
}

/**
 * Every way this title falls short of the standard. Order is stable so a
 * caller can render them without sorting, and so tests can assert equality
 * rather than set membership.
 */
export function titleShapeGaps(title: string): TitleGap[] {
  const trimmed = title.trim();
  if (trimmed.length === 0) return ['empty'];

  const gaps: TitleGap[] = [];
  if (trimmed.length > MAX_TITLE_CHARS) gaps.push('too-long');
  if (trimmed.length > IDEAL_TITLE_CHARS) gaps.push('over-ideal');

  const personaAt = personaClauseEnd(trimmed);
  if (personaAt === undefined) {
    gaps.push('no-persona');
  }
  // The means-clause must FOLLOW the persona clause, not merely appear
  // somewhere in the string. "With no warning a reviewer can lose the thread"
  // has a `with` and does not say what will be built; a whole-string
  // `includes` would pass it. When there is no persona clause at all there is
  // nothing for an action to hang off, so the whole string is searched — the
  // reading most likely to find an action that IS there.
  const words = trimmed.split(/\s+/);
  const searchFrom = personaAt === undefined ? 0 : personaAt + 1;
  const hasMeans = words
    .slice(searchFrom)
    .some((w) => MEANS_MARKERS.includes(w.toLowerCase().replace(/[^a-z]/g, '')));
  if (!hasMeans) gaps.push('no-action');

  if (isClipped(trimmed)) gaps.push('clipped');
  return gaps;
}

/** Does this title stop mid-thought? */
function isClipped(trimmed: string): boolean {
  if (/(…|\.\.\.)$/.test(trimmed)) return true;
  if (/[,;:([{\-–—/]$/.test(trimmed)) return true;
  const last = trimmed.split(/\s+/).pop() ?? '';
  return DANGLING_TAIL.has(last.toLowerCase().replace(/[^a-z']/g, ''));
}

/**
 * Shorten to `limit` characters WITHOUT cutting a word in half.
 *
 * `promote_to_task` used to build a title with `slice(0, 79) + '…'`, which is
 * where *"For tasks, I get dumped o…"* came from — the generator, not the
 * author. Clipping at a word boundary cannot make a title worse: the result
 * is a prefix of the same prefix.
 */
export function clipToWordBoundary(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  // Room for the ellipsis itself.
  const room = Math.max(1, limit - 1);
  const cut = trimmed.slice(0, room);
  const lastSpace = cut.lastIndexOf(' ');
  // A single word longer than the limit has no boundary to fall back to, and
  // returning it whole would defeat the cap — so the hard cut stands there.
  const kept = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
  return `${kept.replace(/[\s,;:.\-–—]+$/, '')}…`;
}

/**
 * The user story a title compresses: the body's first PARAGRAPH — everything
 * up to the first blank line — normalized so that re-emphasising a word is
 * not a rewrite.
 *
 * A paragraph rather than a line, and that is a correctness requirement
 * rather than a preference. A task body is written as hard-wrapped markdown
 * and stored that way at creation, but every later read of it comes back
 * through the prosemirror serializer, which emits each paragraph as ONE line.
 * So a first-LINE head recorded at creation stops matching the moment
 * anything touches the body, and every hard-wrapped task in the workspace
 * reports a stale title after its first trivial edit. Caught by the
 * "a trivial body edit does NOT trip it" control, which is exactly the case a
 * test suite without a negative control would have shipped.
 *
 * Capped, because this is stored per task and a first paragraph can run long.
 */
export function bodyHead(body: string | undefined): string {
  const lines = (body ?? '').split('\n').map((l) => l.trim());
  const start = lines.findIndex((l) => l.length > 0);
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && l.length === 0);
  const paragraph = lines.slice(start, end === -1 ? lines.length : end).join(' ');
  return paragraph
    .replace(/^#{1,6}\s*/, '')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

/** Content tokens, as a multiset. Case-folded; punctuation dropped. */
function wordBag(text: string | undefined): Map<string, number> {
  const bag = new Map<string, number>();
  for (const w of (text ?? '').toLowerCase().match(/[a-z0-9']+/g) ?? []) {
    bag.set(w, (bag.get(w) ?? 0) + 1);
  }
  return bag;
}

/**
 * What fraction of the body changed, in 0..1 — a multiset distance over
 * content words rather than a length comparison, so a same-length paraphrase
 * of the middle still registers. Symmetric, so it says the same thing about a
 * change and its revert.
 *
 * Measured over WORDS on purpose. The tempting cheap version — "the body
 * length moved by 30%" — is silent on exactly the edit that most often
 * redefines a task: a rewrite that keeps its size.
 */
export function bodyDrift(prev: string | undefined, next: string | undefined): number {
  const a = wordBag(prev);
  const b = wordBag(next);
  let sizeA = 0;
  for (const n of a.values()) sizeA += n;
  let sizeB = 0;
  for (const n of b.values()) sizeB += n;
  if (sizeA === 0 && sizeB === 0) return 0;
  let shared = 0;
  for (const [w, n] of a) shared += Math.min(n, b.get(w) ?? 0);
  return 1 - shared / Math.max(sizeA, sizeB);
}

/**
 * What a row needs to answer "is this title still the right title" — the
 * shape of the title itself, plus the two marks left behind when it was last
 * authored.
 */
export interface TitleFacts {
  title: string;
  /** The body as it stands NOW. */
  body?: string;
  /** `bodyHead` of the body at the moment the title was last authored.
   *  Absent on a row filed before the standard existed. */
  titleHead?: string;
  /** Accumulated `bodyDrift` since the title was last authored. */
  titleDrift?: number;
  /** Comments that landed since the title was last authored. */
  commentsSinceTitle?: number;
}

/**
 * Every gap a task's title currently has — shape, plus the two "the world
 * moved" triggers. DERIVED on read, never stored: a stored copy would be a
 * second spelling of the same fact with its own writers, which is how the
 * `bodyWrittenAt` guard came to be dead before it ran.
 *
 * The two staleness clauses are deliberately different questions, because
 * each is silent where the other speaks. Accumulated word drift catches a
 * paraphrase that keeps the body's length and its opening line; a changed
 * story line catches a redefinition small enough that total drift stays under
 * the threshold. Either alone leaves a whole class of rewrites unannounced.
 *
 * `titleHead === undefined` — a row filed before this existed — suppresses
 * only the head clause, never the drift clause. Drift starts accumulating
 * from that row's next body change either way, so a legacy row is not
 * permanently exempt; it is just not accused on the strength of a mark
 * nobody ever made.
 */
export function taskTitleGaps(facts: TitleFacts): TitleGap[] {
  const gaps = titleShapeGaps(facts.title);
  const drifted = (facts.titleDrift ?? 0) >= STALE_BODY_DRIFT;
  const headMoved = facts.titleHead !== undefined && bodyHead(facts.body) !== facts.titleHead;
  if (drifted || headMoved) gaps.push('stale-body');
  if ((facts.commentsSinceTitle ?? 0) >= STALE_DISCUSSION_COMMENTS) gaps.push('stale-discussion');
  return gaps;
}

const GAP_TEXT: Record<TitleGap, string> = {
  empty: 'the title is blank',
  'too-long': `the title is over ${MAX_TITLE_CHARS} characters`,
  'over-ideal': `the title is over ${IDEAL_TITLE_CHARS} characters, so it is hard to scan next to others`,
  'no-persona': 'the title does not say WHO this is for — start it "<Person> can …"',
  'no-action':
    'the title does not say what will be BUILT — add "… by <action>" or "… with <a tool>"',
  clipped: 'the title stops mid-thought, as though it were cut off',
  'stale-body': 'the description has changed substantially since this title was written',
  'stale-discussion': 'the discussion has moved on since this title was written',
};

/**
 * One sentence a caller can print. `undefined` for no gaps, so a caller can
 * spread it onto a response without a conditional and a clean title adds no
 * key at all.
 */
export function titleGapMessage(gaps: readonly TitleGap[]): string | undefined {
  if (gaps.length === 0) return undefined;
  return `Title standard — <Person> can <achieve goal X> by <describe action>, under ${IDEAL_TITLE_CHARS} characters: ${gaps
    .map((g) => GAP_TEXT[g])
    .join('; ')}.`;
}
