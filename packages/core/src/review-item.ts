/**
 * A Review Item — the thing an agent DECLARES when it needs a person, as
 * opposed to the thing a server INFERS from prose.
 *
 * The queue this replaces asked "is the newest comment an agent's", which is
 * exactly what a finished exchange looks like: a person comments, an agent
 * fixes it, the agent replies "Done — shipped in #226", and nobody types
 * again. So the queue accumulated one permanent row per thing the agents got
 * RIGHT. Measured on this project's board 2026-08-18: 105 rows, 0 of them
 * decisions, 6 containing a question, 62 opening with a closing verb, and 93
 * of the 105 row TITLES clipped mid-sentence at the 200-character boundary
 * because the title was the agent's status note rather than anything written
 * to be a title.
 *
 * The detector is not the problem and a better one will not help — `asksPerson`
 * was carefully measured and its own header records the result (fires on 1 of
 * 86 real comments, misses 2 of 3 genuine questions). The problem is that the
 * agent knows perfectly well whether it is asking or reporting and has no way
 * to say so. This is that way.
 *
 * Pure and dependency-free on purpose: the MCP tool, the REST route and the
 * browser all check the same rule, and a second copy of a limit is how the
 * card ends up rendering something the API swore it had refused.
 */

/**
 * Two shapes, not three.
 *
 * Bryan named three — a structured decision; a brief review of a short piece
 * of text or mockup; a request to go review some links — and then said of the
 * last two: *"The last two are roughly the same thing."* He also gave them one
 * spec: a markdown summary under 150 words, inline links where needed, and one
 * open-ended markdown answer. So they differ in what the author puts in the
 * summary (an excerpt, or a link), not in anything this module, the API or the
 * card would do differently.
 *
 * Splitting them anyway would add a discriminator that changes no behaviour —
 * a second spelling of one value, which this codebase has already been bitten
 * by (see "A second spelling for the same value makes accidental duplicates
 * reachable" in docs/process/learnings.md). If a mockup later needs its own
 * embed, that is an additive field on `review`, not a third shape.
 */
export type ReviewShape = 'decision' | 'review';

export interface ReviewOption {
  /** Stable within the payload. Records WHICH candidate an answer came from;
   *  the answer itself is always the verbatim words, never the id. */
  id: string;
  /** Bold 1–3 words, per the spec. This is the button face. */
  label: string;
  /** Up to 50 words of markdown — what picking this one costs. */
  detail?: string;
}

/**
 * The payload an agent attaches to a comment.
 *
 * `headline` and `why` are the two-line header Bryan asked to be enforced —
 * "clear on what needs review, why it's important, and what to review for, all
 * in two lines or less on mobile screen". They are the queue row. `lookFor` is
 * the third thing he named and is advisory; see `checkReviewPayload` for why
 * the line between refused and advised falls there.
 */
export interface ReviewPayload {
  shape: ReviewShape;
  /** Line 1 of the row: what needs review. */
  headline: string;
  /** Line 2 of the row: why it matters / what is blocked. */
  why: string;
  /** What to review FOR. Shown on the opened card, not on the row. */
  lookFor?: string;
  /**
   * The body. Under 50 words for a `decision` (context before the options),
   * under 150 for a `review` (the markdown summary, inline links included).
   * One field because it plays one role; the budget is the shape's.
   */
  detail?: string;
  /** `decision` only, at least two — a "choice" of one is a statement. */
  options?: ReviewOption[];
  /**
   * The option id a person's answer came from, stamped when they answered by
   * tapping rather than typing. Provenance only: the answer is the reply, and
   * the reply carries the words. Absent on a typed answer, which is not a
   * lesser answer.
   */
  answeredWith?: string;
}

/** Every limit in one place, exported so a card can show a counter that
 *  cannot disagree with the gate. */
export const REVIEW_LIMITS = {
  /** ~1 line at 430px/16px, where a line runs about 50 characters. */
  headline: 70,
  why: 90,
  lookFor: 90,
  /** Words of body, by shape. Bryan's numbers, verbatim. */
  detailWords: { decision: 50, review: 150 },
  optionLabelWords: 3,
  /** A 1–3 word label still has to fit a full-width button at 430px. */
  optionLabelChars: 28,
  optionDetailWords: 50,
  minOptions: 2,
  maxOptions: 6,
} as const;

export type ReviewGap = 'lookFor' | 'detail';

export interface ReviewCheck {
  /** No refusal-grade problem. `errors` is empty exactly when this is true. */
  ok: boolean;
  /** Refusals, each phrased to tell a retrying model what to write instead. */
  errors: string[];
  /** Present-but-thin. Advice on a SUCCESSFUL create, never a refusal. */
  gaps: ReviewGap[];
}

function words(s: string): number {
  const t = s.trim();
  return t === '' ? 0 : t.split(/\s+/).length;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Is this payload shaped like something a person can act on from a phone?
 *
 * Two tiers, and the line between them is the one thing this module has to get
 * right. `decision-shape.ts` already learned it for decision task bodies: a
 * gate that demands everything makes filing a chore, and the predictable
 * response to a chore is to route around it — there, by filing the decision as
 * an action instead. So only what the ROW is made of refuses.
 *
 * - **Refused**: `headline`, `why`, every stated length, and a `decision` with
 *   fewer than two options. These are the reported bug. A missing or over-long
 *   headline is precisely how the title went back to being a clip of prose,
 *   and truncating it here would re-introduce the clipping under a different
 *   name — the row would still read as a sentence cut in half, and the author
 *   would never learn. Refusing with a message that says what to write is the
 *   only version that makes the next one better.
 * - **Advised**: a missing `lookFor` or `detail`. Both make the card thinner
 *   and neither makes it unreadable, and demanding a third and fourth field
 *   for a two-word question is the chore that gets routed around.
 *
 * Every check is one-directional in the same sense as `checkDecisionShape`:
 * counting words can undercount a field somebody wrote well (a false gap, i.e.
 * noise on a good payload), never pass a field that is absent.
 */
export function checkReviewPayload(input: unknown): ReviewCheck {
  const errors: string[] = [];
  const gaps: ReviewGap[] = [];
  const fail = (msg: string) => errors.push(msg);

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['review must be an object.'], gaps: [] };
  }
  const p = input;

  const shape = p.shape;
  if (shape !== 'decision' && shape !== 'review') {
    fail(
      "review.shape must be 'decision' (a choice between named options) or 'review' (read this and tell me what you think).",
    );
  }

  const line = (key: 'headline' | 'why' | 'lookFor', required: boolean) => {
    const v = p[key];
    if (v === undefined || (typeof v === 'string' && v.trim() === '')) {
      if (required) {
        fail(
          key === 'headline'
            ? `review.headline is required — one line saying what needs review, at most ${REVIEW_LIMITS.headline} characters. It is the row title; write it as a ticket title, not as the first sentence of a status note.`
            : `review.why is required — one line saying why it matters or what it blocks, at most ${REVIEW_LIMITS.why} characters.`,
        );
      } else {
        gaps.push('lookFor');
      }
      return;
    }
    if (typeof v !== 'string') {
      fail(`review.${key} must be a string.`);
      return;
    }
    // A newline is a second line by definition, and the whole rule is that the
    // header is two lines. Refusing here is what keeps the card's clamp from
    // being the thing that enforces it.
    if (/[\r\n]/.test(v)) fail(`review.${key} must be a single line — it contains a line break.`);
    const max = REVIEW_LIMITS[key];
    if (v.trim().length > max) {
      fail(
        `review.${key} is ${v.trim().length} characters; the limit is ${max} so it fits one line on a phone. Say less, don't abbreviate.`,
      );
    }
  };
  line('headline', true);
  line('why', true);
  line('lookFor', false);

  const detail = p.detail;
  if (detail === undefined || (typeof detail === 'string' && detail.trim() === '')) {
    gaps.push('detail');
  } else if (typeof detail !== 'string') {
    fail('review.detail must be a markdown string.');
  } else if (shape === 'decision' || shape === 'review') {
    const max = REVIEW_LIMITS.detailWords[shape];
    const n = words(detail);
    if (n > max) {
      fail(`review.detail is ${n} words; the limit for a '${shape}' item is ${max}.`);
    }
  }

  const options: unknown[] | undefined = Array.isArray(p.options) ? p.options : undefined;
  if (p.options !== undefined && !Array.isArray(p.options)) {
    fail('review.options must be an array.');
  } else if (options !== undefined) {
    if (shape === 'review' && options.length > 0) {
      fail(
        "review.options belong to a 'decision'. A 'review' item is answered in the person's own words.",
      );
    }
    if (options.length > REVIEW_LIMITS.maxOptions) {
      fail(
        `review.options has ${options.length} entries; at most ${REVIEW_LIMITS.maxOptions} fit a phone screen as full-width buttons.`,
      );
    }
    const seen = new Set<string>();
    options.forEach((raw, i) => {
      if (!isPlainObject(raw)) {
        fail(`review.options[${i}] must be an object with an id and a label.`);
        return;
      }
      const id = raw.id;
      if (typeof id !== 'string' || id.trim() === '') {
        fail(`review.options[${i}].id is required — a short stable id, unique within this item.`);
      } else if (seen.has(id)) {
        fail(`review.options[${i}].id '${id}' is used twice; option ids must be unique.`);
      } else {
        seen.add(id);
      }
      const label = raw.label;
      if (typeof label !== 'string' || label.trim() === '') {
        fail(
          `review.options[${i}].label is required — 1 to ${REVIEW_LIMITS.optionLabelWords} words.`,
        );
      } else {
        const n = words(label);
        if (n > REVIEW_LIMITS.optionLabelWords) {
          fail(
            `review.options[${i}].label is ${n} words ("${label.trim()}"); use at most ${REVIEW_LIMITS.optionLabelWords}. The reasoning goes in detail.`,
          );
        }
        if (label.trim().length > REVIEW_LIMITS.optionLabelChars) {
          fail(
            `review.options[${i}].label is ${label.trim().length} characters; the limit is ${REVIEW_LIMITS.optionLabelChars} so it fits a button at 430px.`,
          );
        }
      }
      const d = raw.detail;
      if (d !== undefined) {
        if (typeof d !== 'string') {
          fail(`review.options[${i}].detail must be a markdown string.`);
        } else if (words(d) > REVIEW_LIMITS.optionDetailWords) {
          fail(
            `review.options[${i}].detail is ${words(d)} words; the limit is ${REVIEW_LIMITS.optionDetailWords}.`,
          );
        }
      }
    });
  }

  if (shape === 'decision' && (options?.length ?? 0) < REVIEW_LIMITS.minOptions) {
    fail(
      `a 'decision' needs at least ${REVIEW_LIMITS.minOptions} options — a choice of one is a statement. If there is nothing to choose between, this is a 'review'.`,
    );
  }

  return { ok: errors.length === 0, errors, gaps };
}

/**
 * The refusal as one string, written to land verbatim in an agent's context
 * the way `decisionShapeMessage` does — the caller that hit this is usually a
 * model that will retry from this text alone, so it has to say what to write
 * rather than only that something is wrong.
 */
export function reviewPayloadMessage(check: ReviewCheck): string {
  return [
    'This review item cannot be filed as written.',
    ...check.errors,
    'A review item is a row on a phone: one line saying what needs review, one line saying why, then the body. Post it as an ordinary comment instead if it is a status note — status notes are welcome and no longer enter the review queue.',
  ].join(' ');
}

/**
 * The advice half of the check, for a payload that WAS filed.
 *
 * `gaps` are computed on every successful write and were, in the first cut of
 * this feature, read by nobody — the call returned 200, the card came out
 * thinner than the author meant, and nothing connected the two. That is the
 * same shape as the refusal this module argues against: a defect the author
 * cannot see is a defect the author repeats. So the advice travels back on the
 * success response, phrased like the refusals are — what to write, not what
 * was wrong.
 *
 * Returns undefined when there is nothing to say, so a caller can spread it
 * and an ordinary well-formed item carries no extra field.
 */
export function reviewGapAdvice(gaps: ReviewGap[]): string | undefined {
  if (gaps.length === 0) return undefined;
  const parts: string[] = [];
  if (gaps.includes('lookFor')) {
    parts.push(
      "review.lookFor is missing — one line saying what to look at, so the card says what a useful answer would be about. Without it the reader gets the question and no idea what you're unsure of.",
    );
  }
  if (gaps.includes('detail')) {
    parts.push(
      'review.detail is missing — the markdown body under the header. Without it the card is a headline and two options with nothing behind them.',
    );
  }
  return ['Filed. It will be thinner than it needs to be:', ...parts].join(' ');
}

/**
 * A payload read back out of the CRDT, or undefined.
 *
 * Defensive for the reason `readStoredSummary` is: this value is synced to
 * every peer, no peer's write is authoritative, and a malformed object that
 * reaches a renderer is a crash on a page that never touched the doc (see "A
 * malformed anchor crashes a request that never touched the doc" in
 * learnings.md). Reading is deliberately LOOSER than writing — `checkReview
 * Payload` guards the door, this only guards against a shape that would throw,
 * so an item written before a limit changed still renders rather than
 * vanishing.
 */
export function readReviewPayload(value: unknown): ReviewPayload | undefined {
  if (!isPlainObject(value)) return undefined;
  const shape = value.shape;
  if (shape !== 'decision' && shape !== 'review') return undefined;
  const headline = value.headline;
  const why = value.why;
  if (typeof headline !== 'string' || headline.trim() === '') return undefined;
  if (typeof why !== 'string') return undefined;

  const out: ReviewPayload = { shape, headline, why };
  if (typeof value.lookFor === 'string' && value.lookFor.trim() !== '') out.lookFor = value.lookFor;
  if (typeof value.detail === 'string' && value.detail.trim() !== '') out.detail = value.detail;
  if (typeof value.answeredWith === 'string') out.answeredWith = value.answeredWith;

  if (Array.isArray(value.options)) {
    const options: ReviewOption[] = [];
    for (const raw of value.options) {
      if (!isPlainObject(raw)) continue;
      if (typeof raw.id !== 'string' || typeof raw.label !== 'string') continue;
      const o: ReviewOption = { id: raw.id, label: raw.label };
      if (typeof raw.detail === 'string') o.detail = raw.detail;
      options.push(o);
    }
    if (options.length > 0) out.options = options;
  }
  return out;
}
