/**
 * The quality gate: every published limit, the check that enforces them, and
 * the advice a passing-but-thin payload gets back.
 *
 * One rule shapes all of it, and it is a rule about what a refusal COSTS. A
 * refusal is paid by the person whose ask never got filed, so only the
 * structural problems refuse — the ones where the row cannot be built at all.
 * Everything else is advice returned on a SUCCESSFUL create. Bouncing a
 * filing to shave two words off a row was measured six times in one day,
 * each at the moment an agent was routing an ask to the queue instead of to
 * chat.
 *
 * The limits are exported rather than inlined so a card can render a counter
 * that cannot disagree with the gate — a second copy of a limit is how the
 * card ends up showing something the API swore it had refused.
 */
import { isPlainObject, normalizeReviewType } from './review-item-wire.ts';
import { wordCount } from './word-count.ts';

/**
 * Every limit in one place, exported so a card can show a counter that
 * cannot disagree with the gate.
 *
 * The unit mix is a rule, not an accident: **characters for the one-line row
 * field, words for bodies.** A row field's budget tracks RENDERED WIDTH — how
 * much fits one line on a phone — and width is a property of characters. A
 * body's budget tracks READING EFFORT, which is a property of words; the card
 * wraps, so width never enters into it.
 *
 * `why` (90) and `lookFor` (90) were removed with the fields themselves on
 * 2026-08-25. A published budget for a field that no longer exists is a rule
 * an author can still read and still obey.
 */
export const REVIEW_LIMITS = {
  /**
   * ~1 line at 430px/16px, where a line runs about 50 characters.
   *
   * ADVISORY since 2026-08-22, for the same reason the body targets became
   * advisory a day earlier: a budget here is a statement about RENDERED WIDTH,
   * and over-running it wraps the row. Refusing instead turned a rendering
   * imperfection into a failed filing — measured over one 24-hour window, six
   * honest asks were bounced over a 90-character row budget, each at the
   * moment an agent was routing an ask to the queue instead of to chat, and
   * each costing a retry to shave two words. A wrapped row is worse than a
   * tight one and far better than an ask that never got filed.
   */
  headline: 70,
  /**
   * The one one-line length that still refuses — the sanity ceiling for the
   * row field, the counterpart of `detailMaxWords` for a body. Well past
   * anything a model overshoots a 70-character budget by (the measured
   * over-runs sat at 92–102), so it bounces a paragraph pasted into a row and
   * nothing else. Shared by the option `label`, which is a row field wearing
   * a button.
   */
  lineMaxChars: 500,
  /**
   * Words of body, by shape — Bryan's numbers, verbatim, as the TARGET an
   * author should aim for. ADVISORY since 2026-08-21: exceeding a target no
   * longer refuses. It used to (a 400), and a real ask often carries three or
   * four verified facts before the question makes sense — so the full context
   * went into the thread body and a compressed copy into `detail`, the two
   * said different things, and the card (what Bryan acts from) was the weaker
   * one. The bug was never that 150 is small; it is that exceeding it pushed
   * content somewhere the card does not show.
   */
  detailTargetWords: { decision: 50, review: 150 },
  /**
   * The one detail length that still refuses — a sanity ceiling an honest ask
   * cannot reach (13x the review target), there to bounce a pasted document
   * or a runaway generation, never to compress a real question's context.
   */
  detailMaxWords: 2000,
  /** Advisory, like the row budgets above — a fourth word wraps a button, it
   *  does not break one. Refusing four-word labels was half the measured
   *  bounces this rule set produced. */
  optionLabelWords: 3,
  /** A 1–3 word label still has to fit a full-width button at 430px. */
  optionLabelChars: 28,
  optionDetailWords: 50,
  minOptions: 2,
  maxOptions: 6,
} as const;

/**
 * Something worth telling the author about a payload that WAS filed.
 *
 * Three families, and keeping them distinct is what makes the advice usable:
 * a bare field name means the field is ABSENT ("write one"), a `…Length` gap
 * means the field is there and runs long ("it will wrap"), and the two
 * `…Linkless` gaps mean the body is there but what it points at is not. Told
 * the same way, an author who wrote a 100-character headline would be advised
 * to write one.
 *
 * The two reachability gaps are the same defect caught from opposite sides.
 * `detailLinkless` reads the COMMENT the item rode in on: links exist, they
 * are in the wrong place. `lookAskLinkless` reads the ASK itself: it sends
 * the reader somewhere and no link exists anywhere. Only one is ever raised —
 * see `checkReviewPayload` — because they would otherwise say nearly the same
 * sentence twice, and the comment-borne one is the more actionable of the two.
 */
export type ReviewGap =
  | 'detail'
  | 'detailLinkless'
  | 'lookAskLinkless'
  | 'headlineLength'
  | 'optionLabelLength'
  | 'optionDetailLength';

export interface ReviewCheck {
  /** No refusal-grade problem. `errors` is empty exactly when this is true. */
  ok: boolean;
  /** Refusals, each phrased to tell a retrying model what to write instead. */
  errors: string[];
  /** Present-but-thin. Advice on a SUCCESSFUL create, never a refusal. */
  gaps: ReviewGap[];
}

/**
 * Does this text give a reader somewhere to go?
 *
 * Two forms, because those are the two an agent writes: an inline markdown
 * link, which is the house style for a workspace path, and a bare absolute
 * URL. A bare relative path deliberately does NOT count — nothing renders it
 * as a link, so a reader cannot act on it either.
 */
function hasLink(s: string): boolean {
  return /\[[^\]]*\]\([^)\s]+\)/.test(s) || /https?:\/\/\S/.test(s);
}

/**
 * Verbs of PERCEIVING. Deliberately a small closed class — this is the set of
 * things you can ask someone to do to an artifact without changing it — and
 * it is extended only with another verb of the same kind, never with the
 * nouns of whatever artifact is in fashion (`mockup`, `PR`, `staging`).
 * Matching artifact nouns is the over-fit: the vocabulary is open-ended, it
 * dates immediately, and it fires on asks that merely MENTION the thing.
 */
const PERCEIVE_VERBS =
  'look|read|review|check|see|watch|open|try|visit|browse|inspect|compare|test';

/**
 * Is this ask telling the READER to go and perceive something?
 *
 * Two constraints do the work, and both are about precision rather than
 * coverage — the cost asymmetry runs the other way from most checks. A false
 * positive spends one sentence in a tool result. A false NEGATIVE is Bryan
 * hunting for a link, which is the whole reason this exists. But advice that
 * fires on asks with nothing to link is worse than either: it trains agents
 * to skim past the channel, and then the true positives stop landing too.
 * So this is tuned to be quiet and right, not thorough.
 *
 * 1. The verb is in its BASE form. "Read the draft" is a directive; "I read
 *    the draft", "reviewed", "checking" are reports about work already done,
 *    and a report is the commonest way one of these words appears in a
 *    detail that needs no link at all. `\b` after the stem does this for
 *    free: "looked", "reviews" and "checking" have no boundary there.
 *
 * 2. The verb sits where a request sits — opening a sentence, a line or a
 *    bullet, or following an explicit request marker ("please", "can you",
 *    "take a"). A verb buried mid-clause is almost always narration.
 *
 * 3. It TAKES AN OBJECT: the next word introduces one, being a determiner, a
 *    pronoun, a possessive or a preposition. Position alone is not enough,
 *    because every word in the list above is also a noun or an adjective and
 *    card titles are written as noun phrases — "Open question: what should we
 *    call it?", "Review complete", "Test results" all opened with a listed
 *    word and all were advised to add a link to an artifact that does not
 *    exist (codex review). A noun use is followed by another noun; a
 *    directive is followed by the thing it directs you at.
 *
 * What it deliberately misses: an ask that implies a target without naming
 * the act ("thoughts on the new nav?"). Catching those means guessing, and
 * guessing fires on every open question — the "what should we call it?"
 * family, which is complete with nothing to link. A decision whose options
 * are described in full carries no directive either, and is silent here by
 * construction rather than by a special case.
 */
function asksReaderToLook(s: string): boolean {
  const opener = String.raw`^|[.!?;:)\]]\s+|\n\s*(?:[-*>]\s*)?`;
  const marker = String.raw`\b(?:please|kindly)\s+|\b(?:can|could|would|will)\s+you\s+(?:please\s+)?|\byou\s+(?:can|should|could|might|may)\s+|\b(?:take|have)\s+a\s+`;
  // What an object of the directive starts with: a determiner, a pronoun, a
  // possessive ("Bryan's draft"), or a preposition. Anything else after the
  // verb and the word was a noun.
  const object = String.raw`at|the|a|an|this|that|these|those|it|them|my|our|your|its|his|her|their|through|over|into|whether|both|each|either|[\w-]+'s`;
  return new RegExp(`(?:${opener}|${marker})(?:${PERCEIVE_VERBS})\\s+(?:${object})\\b`, 'i').test(
    s,
  );
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
 * - **Refused**: a missing `headline`, a line break inside it, a `decision`
 *   with fewer than two options, and anything past a sanity ceiling
 *   (`lineMaxChars` for the row field, `detailMaxWords` for a body). These are
 *   structural: the row cannot be built at all without them, and a ceiling is
 *   only ever reached by a pasted document. Note it refuses rather than
 *   truncating — clipping a headline is precisely how the title went back to
 *   being a sentence cut in half, and the author would never learn.
 * - **Advised**: a missing `detail`, and any LENGTH over a budget. Both make
 *   the card thinner or wider than it wants to be; neither makes it
 *   unreadable. Demanding another field for a two-word question is the chore
 *   that gets routed around, and so is bouncing a filing to shave two words
 *   off a row line — measured, six times in one day. So is a `detail` that
 *   carries no link while the comment beside it does: the ask is filed and
 *   answerable, it is only the reader's route to the work that is missing.
 *
 * `context.text` is the comment the declaration rode in on, when there was
 * one. It is the only reason this function can tell a self-contained card
 * from one whose links stayed behind in the comment; a ticket-borne item
 * passes none and is judged on the payload alone.
 *
 * As of 2026-08-25 there is exactly ONE required field, because there is
 * exactly one field the row is made of. A payload still carrying the retired
 * `why` / `lookFor` passes untouched: unknown keys were never refused, and an
 * unrestarted caller must not get a 400 from a rule it cannot know about.
 * Their text is not discarded either — `readReviewPayload` folds it into the
 * body on the way to storage.
 *
 * Every check is one-directional in the same sense as `checkDecisionShape`:
 * counting words can undercount a field somebody wrote well (a false gap, i.e.
 * noise on a good payload), never pass a field that is absent.
 */
export function checkReviewPayload(input: unknown, context?: { text?: string }): ReviewCheck {
  const errors: string[] = [];
  const gaps: ReviewGap[] = [];
  const fail = (msg: string) => errors.push(msg);

  if (!isPlainObject(input)) {
    return { ok: false, errors: ['review must be an object.'], gaps: [] };
  }
  const p = input;

  const shape = normalizeReviewType(p.review_type ?? p.shape);
  if (shape === undefined) {
    fail(
      "review.review_type must be 'decision' (a choice between named options) or 'question' (read this and tell me what you think). The legacy spellings — field 'shape', value 'review' — are accepted too.",
    );
  }

  const headline = p.headline;
  if (headline === undefined || (typeof headline === 'string' && headline.trim() === '')) {
    fail(
      `review.headline is required — one line saying what needs review, at most ${REVIEW_LIMITS.headline} characters. It is the row title; write it as a ticket title, not as the first sentence of a status note.`,
    );
  } else if (typeof headline !== 'string') {
    fail('review.headline must be a string.');
  } else {
    // A newline is a second line by definition, and the headline is one line.
    // Refusing here is what keeps the card's clamp from being the thing that
    // enforces it.
    if (/[\r\n]/.test(headline)) {
      fail('review.headline must be a single line — it contains a line break.');
    }
    // Length ADVISES up to the sanity ceiling. The budget describes how much
    // fits one line on a phone, and over-running it wraps the row — a
    // rendering imperfection, which refusing turned into a failed filing.
    const n = headline.trim().length;
    if (n > REVIEW_LIMITS.lineMaxChars) {
      fail(
        `review.headline is ${n} characters; past ${REVIEW_LIMITS.lineMaxChars} it is a paragraph, not a row. Put the context in review.detail — the card renders all of it — and leave one line here.`,
      );
    } else if (n > REVIEW_LIMITS.headline) {
      gaps.push('headlineLength');
    }
  }

  const detail = p.detail;
  if (detail === undefined || (typeof detail === 'string' && detail.trim() === '')) {
    gaps.push('detail');
  } else if (typeof detail !== 'string') {
    fail('review.detail must be a markdown string.');
  } else {
    // Length only refuses at the sanity ceiling. The shape targets in
    // REVIEW_LIMITS.detailTargetWords are advice the tool description gives,
    // not a gate: refusing at the target made authors split the ask — full
    // context in the thread, a compressed copy here — and the card showed the
    // weaker half. The card renders everything, so the honest move is to
    // accept the detail the author actually has.
    const n = wordCount(detail);
    if (n > REVIEW_LIMITS.detailMaxWords) {
      fail(
        `review.detail is ${n} words; past ${REVIEW_LIMITS.detailMaxWords} it is a document, not a card. Keep the ask's real context here — the card renders all of it — and link out to anything book-length instead of pasting it.`,
      );
    }
    // Links that stayed in the comment. Only ever advised against a comment
    // that HAS some: an ask with nothing to point at is complete without one,
    // and advising every linkless detail would be noise on most of them.
    if (context?.text !== undefined && hasLink(context.text) && !hasLink(detail)) {
      gaps.push('detailLinkless');
    }
  }

  // The same reachability question asked of the ASK rather than of the
  // comment. `detailLinkless` needs a comment to compare against, so the
  // ticket-borne doors — add_review_item, create_tasks — passed nothing and
  // were judged on the payload alone, which meant they were never judged on
  // this at all (Bryan, 2026-08-21: an item asked him to go and look and the
  // card carried no link, so he had to hunt for it).
  //
  // Read across the headline AND the detail, in both directions: an ask can
  // be a look-ask in its one line, and a link anywhere in the payload is
  // somewhere to go. Never raised alongside `detailLinkless` — that one has
  // already said the more actionable half, and two sentences about one
  // missing link read as a scolding.
  const askText = `${typeof headline === 'string' ? headline : ''}\n${
    typeof detail === 'string' ? detail : ''
  }`;
  if (!gaps.includes('detailLinkless') && asksReaderToLook(askText) && !hasLink(askText)) {
    gaps.push('lookAskLinkless');
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
      } else if (label.trim().length > REVIEW_LIMITS.lineMaxChars) {
        // The label's own sanity ceiling; a button cannot hold a paragraph.
        fail(
          `review.options[${i}].label is ${label.trim().length} characters; past ${REVIEW_LIMITS.lineMaxChars} it is not a button face. Put the reasoning in the option's detail.`,
        );
      } else if (
        wordCount(label) > REVIEW_LIMITS.optionLabelWords ||
        label.trim().length > REVIEW_LIMITS.optionLabelChars
      ) {
        // Advisory for the same reason the row budgets are: a fourth word
        // wraps a button, it does not break one.
        gaps.push('optionLabelLength');
      }
      const d = raw.detail;
      if (d !== undefined) {
        if (typeof d !== 'string') {
          fail(`review.options[${i}].detail must be a markdown string.`);
        } else if (wordCount(d) > REVIEW_LIMITS.detailMaxWords) {
          fail(
            `review.options[${i}].detail is ${wordCount(d)} words; past ${REVIEW_LIMITS.detailMaxWords} it is a document, not a note under a button.`,
          );
        } else if (wordCount(d) > REVIEW_LIMITS.optionDetailWords) {
          gaps.push('optionDetailLength');
        }
      }
    });
  }

  if (shape === 'decision' && (options?.length ?? 0) < REVIEW_LIMITS.minOptions) {
    fail(
      `a 'decision' needs at least ${REVIEW_LIMITS.minOptions} options — a choice of one is a statement. If there is nothing to choose between, this is a 'review'.`,
    );
  }

  // Deduped: six over-long option labels are one thing to say, not six.
  return { ok: errors.length === 0, errors, gaps: [...new Set(gaps)] };
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
    'A review item is a row on a phone: one line saying what needs review, then the body. Post it as an ordinary comment instead if it is a status note — status notes are welcome and no longer enter the review queue.',
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
  const thin: string[] = [];
  if (gaps.includes('detail')) {
    thin.push(
      'review.detail is missing — the markdown body under the header. Without it the card is a headline and two options with nothing behind them.',
    );
  }

  // The length half. Phrased as what it costs on the screen rather than as a
  // rule that was broken: these lengths FILED, and an author who reads this as
  // a refusal retries and files the ask twice.
  const long: string[] = [];
  if (gaps.includes('headlineLength')) {
    long.push(
      `review.headline runs past ${REVIEW_LIMITS.headline} characters, so it wraps instead of holding its line on a phone.`,
    );
  }
  if (gaps.includes('optionLabelLength')) {
    long.push(
      `An option label runs past ${REVIEW_LIMITS.optionLabelWords} words or ${REVIEW_LIMITS.optionLabelChars} characters, so the button wraps — the reasoning belongs in that option's detail.`,
    );
  }
  if (gaps.includes('optionDetailLength')) {
    long.push(
      `An option's detail runs past ${REVIEW_LIMITS.optionDetailWords} words; it sits under a button, so a reader skims it rather than reads it.`,
    );
  }

  // The reachability half. A card can be complete prose and still be a
  // dead end: Bryan, 2026-08-27, on an item whose diff and draft were links
  // in the comment — "Why wasn't the question content with links in the
  // review item, and i had to scroll down to the bottom of comments?"
  const unreachable: string[] = [];
  if (gaps.includes('detailLinkless')) {
    unreachable.push(
      'The comment carries links and review.detail carries none. The reader acts from the Home card, which renders the detail — not the comment under it — so every link they need belongs in review.detail as an inline markdown link.',
    );
  }
  if (gaps.includes('lookAskLinkless')) {
    unreachable.push(
      'This asks the reader to go and look at something, and nothing in the payload says where. The reader acts from the Home card, which renders the headline and review.detail and nothing else — so the thing you are asking them to look at belongs in review.detail as an inline markdown link.',
    );
  }

  return [
    ...(thin.length > 0 ? ['Filed. It will be thinner than it needs to be:', ...thin] : []),
    ...(long.length > 0 ? ['Filed. Some of it will not fit where it renders:', ...long] : []),
    ...(unreachable.length > 0
      ? ['Filed. Some of it cannot be reached from the card:', ...unreachable]
      : []),
  ].join(' ');
}
