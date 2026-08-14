/**
 * Is this body decision-SHAPED?
 *
 * `needs: 'decision'` has existed for a while and the field it hangs off —
 * `body` — has always been markdown. What was missing is any notion of what
 * belongs in it. An agent writes a status note ("Round 5 delivered: 133
 * candidates ranked… still open, still #3 on the status page"), the field is
 * technically populated, every check passes, and the person asked to decide
 * opens a progress report. That is the reported bug: *"we're missing enough
 * context at the top of a question to help me figure out how to make the
 * decision"* — not a missing field, not a display problem, the wrong content.
 *
 * The target shape is four parts: the question in one line, what's at stake in
 * two or three, the options with their consequences, then what's blocked until
 * it's answered.
 *
 * Only the FIRST is enforced. A gate that demanded all four would make filing
 * a quick decision a chore, and the predictable response to a chore is to file
 * the decision as an action instead — which loses more than a thin body does.
 * So the floor is: the body has to ask something. "Blue or green?" gets in.
 * The progress report does not, because it never asks. The other three come
 * back as `gaps` on a SUCCESSFUL create, where they read as a nudge rather
 * than a refusal.
 *
 * Every heuristic here is one-directional in the same way: it can only fail to
 * notice a part that is present (a false gap, i.e. noise on a good body), never
 * claim a part that is absent. A gap is advice; only `question` refuses.
 */

export type DecisionShapeGap = 'question' | 'stakes' | 'options' | 'blocked';

export interface DecisionShapeCheck {
  /** The hard floor: a non-blank body that asks something. */
  ok: boolean;
  /** Every part of the shape this body doesn't visibly have. */
  gaps: DecisionShapeGap[];
}

/** The candidate-answer shape the check reads. Deliberately structural —
 *  `decision-shape.ts` must not import the store, which imports it. */
export interface DecisionOptionLike {
  label: string;
  detail?: string;
}

/** Two, because a "choice" of one is a statement. */
const MIN_OPTIONS = 2;

/**
 * Enough prose that something beyond the question was written down. Measured
 * over the body MINUS its question line so a long, rambling question can't
 * pass for context.
 */
const MIN_STAKES_CHARS = 100;

/** A markdown list item — `- x`, `* x`, `1. x` — anywhere in the body. */
const LIST_ITEM = /^\s{0,3}([-*+]|\d+[.)])\s+\S/;

/** Words people actually use for "this is holding something up". */
const BLOCKED_PHRASES =
  /\b(block(s|ed|ing|er)?|unblocks?|waiting on|held up|can't (start|ship|proceed|move)|until (this|it|you|we) )/i;

function lines(body: string): string[] {
  return body.split('\n');
}

export function checkDecisionShape(
  body: string | undefined,
  options?: ReadonlyArray<DecisionOptionLike>,
): DecisionShapeCheck {
  const text = (body ?? '').trim();
  const gaps: DecisionShapeGap[] = [];

  // ── question ────────────────────────────────────────────────────────────
  // A question mark, anywhere. Not "the first line ends in ?": a decision
  // often opens with one framing sentence and asks on the second, and a rule
  // that pushed authors to reorder their own prose to satisfy a parser would
  // be teaching the wrong lesson.
  const questionLine = text.length === 0 ? undefined : lines(text).find((l) => l.includes('?'));
  if (questionLine === undefined) gaps.push('question');

  // ── stakes ──────────────────────────────────────────────────────────────
  const rest = questionLine === undefined ? text : text.replace(questionLine, '');
  if (rest.trim().length < MIN_STAKES_CHARS) gaps.push('stakes');

  // ── options ─────────────────────────────────────────────────────────────
  const listed = lines(text).filter((l) => LIST_ITEM.test(l)).length;
  if ((options?.length ?? 0) < MIN_OPTIONS && listed < MIN_OPTIONS) gaps.push('options');

  // ── blocked ─────────────────────────────────────────────────────────────
  if (!BLOCKED_PHRASES.test(text)) gaps.push('blocked');

  // Only the question gap refuses; the rest travel back with a created task.
  return { ok: !gaps.includes('question'), gaps };
}

/**
 * The refusal, written to land verbatim in an agent's context the way the
 * transition gate's messages do — it has to say what to write, not just that
 * something is wrong, because the caller that hit it is usually a model that
 * will retry immediately from this text alone.
 */
export function decisionShapeMessage(check: DecisionShapeCheck): string {
  return [
    "A decision task needs a decision-shaped body, and this one does not ask a question — so whoever opens it has nothing to decide from. Don't file the progress report; file the decision.",
    'Shape: the question in one line, what is at stake in two or three, the options with what each one costs, then what is blocked until it is answered.',
    check.gaps.length > 0 ? `Missing: ${check.gaps.join(', ')}.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
