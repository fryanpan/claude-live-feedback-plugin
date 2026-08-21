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
  /**
   * When a person answered — stamped for EVERY answer, tapped or typed.
   *
   * This is what makes "answered" a fact about the item rather than a guess
   * about the conversation around it. The queue used to infer it from
   * adjacency ("a person spoke last"), which meant any remark in the thread
   * retired an unanswered question: the task panel's single composer derives
   * its destination as the newest comment's thread, so one line of "reading
   * this now" into a task an agent had just asked about deleted the card,
   * options and all, permanently and across a reload.
   *
   * `answeredWith` could not carry this on its own — it is absent on a typed
   * answer, and a typed answer is not a lesser answer. Both are read as
   * answered (see `reviewAnswered`), so an item answered by tapping before
   * this field existed stays answered.
   */
  answeredAt?: number;
  /**
   * Display name of who answered — the record's face. "Answered by you: …"
   * has to survive a reload, and the reply comment alone cannot carry it:
   * the reply is one comment among many, and nothing marks it as THE answer
   * once a follow-up lands under it. No actor ids in projected state, so
   * this is the name, same as every other `by` in this module.
   */
  answeredBy?: string;
  /** The verbatim words of the answer, duplicated from the reply comment so
   *  the record renders without re-deriving which reply was the answer. */
  answerText?: string;
  /**
   * Answers that were UNDONE (or displaced by a later answer), oldest first —
   * the soft-delete half of the stamps above, mirroring the task decision's
   * `answerHistory`. An undo moves the four answer fields here rather than
   * dropping them: the words are user content, and this project does not
   * hard-delete user content. Nothing reads this to decide anything —
   * `reviewAnswered` still reads only the live stamps — which is what keeps
   * the record cheap to keep.
   */
  answerHistory?: ReviewAnswerUndone[];
}

/** One undone answer: the stamps as they stood, plus who took them back and
 *  when. `answeredAt` is 0 for a legacy tap that predates the stamp. */
export interface ReviewAnswerUndone {
  answeredAt: number;
  answeredBy?: string;
  answerText?: string;
  answeredWith?: string;
  undoneAt: number;
  undoneBy: string;
}

/**
 * Has a person answered this item?
 *
 * One predicate, because the queue, the card and any future surface must not
 * each decide it — and because the two stamps mean the same thing arriving by
 * two routes: `answeredAt` on every answer since it existed, `answeredWith`
 * alone on an option tapped before it did.
 */
export function reviewAnswered(review: ReviewPayload): boolean {
  return review.answeredAt !== undefined || review.answeredWith !== undefined;
}

/**
 * The item's ONE body, as markdown: why, then lookFor, then detail, blank-line
 * separated, empty parts omitted.
 *
 * The card used to render these as labelled sub-sections ("What to review
 * for", a provenance block, a clamped why line), and the approved design
 * (review-flow-mock-v1) collapses all of it into a single markdown body under
 * the head row. Composed here rather than in each renderer because THREE
 * surfaces show the same item — Home's walkthrough, the task panel, the doc
 * thread — and a second copy of the join is how one of them ends up rendering
 * a part the others dropped. The stored payload keeps its three fields; this
 * is presentation, not schema.
 */
export function reviewItemBodyMarkdown(
  review: Pick<ReviewPayload, 'why' | 'lookFor' | 'detail'>,
): string {
  return [review.why, review.lookFor, review.detail]
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join('\n\n');
}

/**
 * Which comment in a thread is the one a person's next reply ANSWERS.
 *
 * Three surfaces show the same review item — Home, the task, and the doc
 * thread that carries it — and each of them has to name a `commentId` for
 * `/answer` to stamp. Home already picked one per item because its queue is
 * built one item at a time. The doc panel has a single reply box against a
 * whole conversation, so it needs this: the ask those words are about.
 *
 * Scanned from the END, because a later ask supersedes an earlier one, and
 * skipping answered ones on the way back means a follow-up that answered
 * nothing does not hide the question still waiting underneath it.
 *
 * `undefined` means "nothing here to answer" — an ordinary thread, or one
 * whose asks are all settled — and the caller posts a plain comment. That is
 * the honest fallback rather than a default target: inventing one would let a
 * remark stamp an answer nobody gave.
 */
export function pendingReviewCommentId(
  comments: ReadonlyArray<{ id: string; review?: ReviewPayload }>,
): string | undefined {
  for (let i = comments.length - 1; i >= 0; i -= 1) {
    const c = comments[i];
    if (!c?.review) continue;
    if (reviewAnswered(c.review)) continue;
    return c.id;
  }
  return undefined;
}

/** A question asked back AT a review item instead of answering it. The item
 *  stays open and stays counted — that is the whole point of it being its own
 *  thing rather than an answer carrying a flag. */
export interface ReviewInfoRequest {
  text: string;
  /** Display name. No actor ids in projected state. */
  by: string;
  ts: number;
}

/**
 * One review item ATTACHED to something — today a ticket.
 *
 * The cardinality is the change. A decision task used to BE a decision: one
 * `needs: 'decision'` flag and one embedded `options` array, so the ticket
 * title had to double as the question and a second open question had nowhere
 * to go. Bryan, 2026-08-18: *"For decisions, the ticket title is not the
 * decision. A decision is a part of a ticket, and there should be a decision
 * blurb above the options. And over time, there may be more than one decision
 * associated with a ticket. In fact, at any point in time there might be
 * multiple open decisions for a ticket."*
 *
 * So a ticket HAS review items, 0..n, several possibly open at once, and each
 * one carries its own blurb — `review.headline` and `review.why` — above its
 * own `review.options`. The row is the entity; the ticket is what it hangs on.
 *
 * `review` is the same `ReviewPayload` a comment-borne declaration carries, on
 * purpose: two spellings of one concept is what this replaces, and a second
 * copy of the limits is how a card renders something the API swore it refused.
 */
/**
 * The VERBATIM words of an answer, plus which option they came from.
 *
 * Named rather than inlined because a superseded answer is the SAME thing as
 * the current one — it stopped being current, it did not stop being an answer
 * somebody wrote — and two shapes for that would be free to disagree.
 */
export interface ReviewItemAnswer {
  text: string;
  /** Display name. No actor ids in projected state. */
  by: string;
  ts: number;
  /** WHICH option the words came from, when one was tapped. Provenance, never
   *  the answer itself, which is why a typed answer carries none. */
  answeredWith?: string;
}

export interface TaskReviewItem {
  /** Stable within the thing it hangs on. Minted by the writer. */
  id: string;
  /** The blurb and the options — the whole declaration, one spelling. */
  review: ReviewPayload;
  createdAt: number;
  /** Display name of whoever raised it. */
  createdBy: string;
  /**
   * The VERBATIM words of the answer. `answeredWith` records WHICH option the
   * words came from when one was tapped — provenance, never the answer itself,
   * which is why it is optional on an answer that was typed.
   *
   * Its presence is what closes the item; see `isReviewItemOpen`.
   */
  answer?: ReviewItemAnswer;
  /**
   * Answers this one SUPERSEDED, oldest first.
   *
   * Answering twice is legal — a person changes their mind, a retry lands, two
   * people reach for the same row — but the words already recorded are user
   * content, and this project does not hard-delete user content. Overwriting
   * `answer` in place is a destructive edit nothing anywhere reports; moving
   * the old one here makes the same act reversible. Absent while there are
   * none, like every other optional field on this row.
   */
  priorAnswers?: ReviewItemAnswer[];
  /** "Tell me more", in order. Absent rather than empty while there are none. */
  infoRequests?: ReviewInfoRequest[];
}

/**
 * Is this item still waiting on a person?
 *
 * Deliberately `answer === undefined` and nothing else. An info request is a
 * question asked back, not an answer, so an item with three of them is still
 * open — and a separate `status` field would be a second spelling of a fact
 * the answer already states, free to disagree with it.
 */
export function isReviewItemOpen(item: TaskReviewItem): boolean {
  return item.answer === undefined;
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
  // Read back defensively like the rest: a peer could sync anything here, and
  // an item whose answer stamp arrived as a string must not read as answered
  // by accident — nor as unanswered, which would put it back on the queue.
  if (typeof value.answeredAt === 'number' && Number.isFinite(value.answeredAt)) {
    out.answeredAt = value.answeredAt;
  }
  // The answer record's face. Loose like everything here: a junk-typed value
  // is dropped rather than thrown, and the item still reads as answered (or
  // not) from the stamps above — these two only decorate the record.
  if (typeof value.answeredBy === 'string') out.answeredBy = value.answeredBy;
  if (typeof value.answerText === 'string') out.answerText = value.answerText;

  if (Array.isArray(value.answerHistory)) {
    const history: ReviewAnswerUndone[] = [];
    for (const raw of value.answerHistory) {
      if (!isPlainObject(raw)) continue;
      // The undo stamps are what a history row IS — without them it records
      // nothing — so they are the only fields that can drop a row. The
      // answer-side fields degrade like they do on the live payload.
      if (typeof raw.undoneAt !== 'number' || !Number.isFinite(raw.undoneAt)) continue;
      if (typeof raw.undoneBy !== 'string') continue;
      if (typeof raw.answeredAt !== 'number' || !Number.isFinite(raw.answeredAt)) continue;
      const entry: ReviewAnswerUndone = {
        answeredAt: raw.answeredAt,
        undoneAt: raw.undoneAt,
        undoneBy: raw.undoneBy,
      };
      if (typeof raw.answeredBy === 'string') entry.answeredBy = raw.answeredBy;
      if (typeof raw.answerText === 'string') entry.answerText = raw.answerText;
      if (typeof raw.answeredWith === 'string') entry.answeredWith = raw.answeredWith;
      history.push(entry);
    }
    if (history.length > 0) out.answerHistory = history;
  }

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

/** A finite number, or the fallback. Metadata must not be able to drop a row:
 *  an item with an unreadable timestamp still has to render. */
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/**
 * A `TaskReviewItem` read back out of the CRDT, or undefined.
 *
 * Loose on the way out for the same reason `readReviewPayload` is, and with
 * the same line drawn in the same place: only what makes the row IDENTIFIABLE
 * can drop it. A row needs an id (something has to address an answer at it)
 * and a readable `review` (there is nothing to show without one). Everything
 * else degrades — a missing `createdBy` reads as unattributed rather than
 * making the item vanish from a queue somebody is waiting on.
 *
 * Never throws. This value is synced to every peer, no peer's write is
 * authoritative, and a malformed object reaching a renderer is a crash on a
 * page that never touched the doc.
 */
/** One answer record, read loosely. Shared by `answer` and `priorAnswers` so
 *  a superseded answer can never read differently from a current one. */
function readAnswer(value: unknown): ReviewItemAnswer | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.text !== 'string' || value.text.trim() === '') return undefined;
  const out: ReviewItemAnswer = { text: value.text, by: str(value.by, ''), ts: num(value.ts, 0) };
  if (typeof value.answeredWith === 'string') out.answeredWith = value.answeredWith;
  return out;
}

export function readTaskReviewItem(value: unknown): TaskReviewItem | undefined {
  if (!isPlainObject(value)) return undefined;
  const id = value.id;
  if (typeof id !== 'string' || id.trim() === '') return undefined;
  const review = readReviewPayload(value.review);
  if (!review) return undefined;

  const out: TaskReviewItem = {
    id,
    review,
    createdAt: num(value.createdAt, 0),
    createdBy: str(value.createdBy, ''),
  };

  // The words ARE the answer, so a record without them is not one — dropping
  // it leaves the item open, which is the safe direction: an item wrongly read
  // as answered disappears from the queue and nobody is told.
  const answer = readAnswer(value.answer);
  if (answer) out.answer = answer;

  if (Array.isArray(value.priorAnswers)) {
    const prior: ReviewItemAnswer[] = [];
    for (const raw of value.priorAnswers) {
      const read = readAnswer(raw);
      if (read) prior.push(read);
    }
    if (prior.length > 0) out.priorAnswers = prior;
  }

  if (Array.isArray(value.infoRequests)) {
    const reqs: ReviewInfoRequest[] = [];
    for (const raw of value.infoRequests) {
      if (!isPlainObject(raw)) continue;
      if (typeof raw.text !== 'string' || raw.text.trim() === '') continue;
      reqs.push({ text: raw.text, by: str(raw.by, ''), ts: num(raw.ts, 0) });
    }
    if (reqs.length > 0) out.infoRequests = reqs;
  }
  return out;
}

/**
 * The shape of a legacy decision TASK, structurally — the parallel spelling.
 *
 * Declared structurally rather than imported so this module stays free of the
 * server's task types: core is the lower layer, and both the browser and the
 * REST route derive the same value from it.
 */
export interface DecisionTaskLike {
  title: string;
  body?: string;
  options?: ReadonlyArray<{ id: string; label: string; detail?: string }>;
  answer?: { optionId?: string };
}

/**
 * The one legacy decision a task carried, expressed as a `ReviewPayload`.
 *
 * MECHANICAL, and every mapping in it is a copy rather than a judgement:
 *
 *  - `headline` is the task TITLE verbatim. A title is an authored string —
 *    somebody wrote it to be a title — so this is not the clip-prose-into-a-
 *    headline move `review-migration.ts` refuses to make. Nothing is generated.
 *  - `why` is `''`. No legacy decision task ever authored one, and there is
 *    nothing on the row to derive it from. Fabricating a sentence here would
 *    manufacture exactly the row shape this feature exists to delete, so the
 *    honest value is empty: `readReviewPayload` permits it (already-stored
 *    items must keep rendering) while `checkReviewPayload` still refuses it
 *    for new writes. That asymmetry is deliberate, not an oversight — the
 *    derivation is NOT routed through the writer's gate.
 *  - `detail` is the body verbatim, unbudgeted for the same reason: a limit
 *    invented after the fact cannot retroactively make stored content invalid.
 *  - `options` keep their SERVER-MINTED ids. `ReviewOption.id` only promises
 *    to be stable within the payload, which a minted id satisfies, and
 *    `answer.optionId` already points at these — re-minting would orphan every
 *    answer already recorded.
 *
 * Pure: no store, no clock, no I/O, nothing minted. Read-side migration, so a
 * caller can derive this on every read without ever rewriting stored data.
 */
export function reviewFromDecisionTask(task: DecisionTaskLike): ReviewPayload {
  const out: ReviewPayload = { shape: 'decision', headline: task.title, why: '' };
  if (typeof task.body === 'string' && task.body.trim() !== '') out.detail = task.body;
  if (task.options && task.options.length > 0) {
    out.options = task.options.map((o) => {
      const opt: ReviewOption = { id: o.id, label: o.label };
      if (o.detail !== undefined) opt.detail = o.detail;
      return opt;
    });
  }
  if (typeof task.answer?.optionId === 'string') out.answeredWith = task.answer.optionId;
  return out;
}
