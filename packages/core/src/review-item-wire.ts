/**
 * Reading a stored review item back out of the CRDT.
 *
 * Everything here is defensive on purpose, and deliberately LOOSER than the
 * gate that let the value in. This state is synced to every peer, no peer's
 * write is authoritative, and a malformed object that reaches a renderer is
 * a crash on a page that never touched the doc. `checkReviewPayload` guards
 * the door; these functions only guard against a shape that would throw, so
 * an item written before a limit changed still renders rather than
 * vanishing.
 *
 * It is also where retired spellings are recovered — the `why` / `lookFor`
 * fold, and the `question` / `review` mapping — because a read is the one
 * step every stored payload passes through on its way to a reader.
 *
 * The types come from `review-item-types.ts`, which emits nothing: this
 * module is a leaf at runtime, and `review-item.ts` re-exports both it and
 * the contract.
 */
import type {
  ReviewAnswerUndone,
  ReviewInfoRequest,
  ReviewItemAnswer,
  ReviewItemJudgement,
  ReviewItemRange,
  ReviewItemRevision,
  ReviewJudgeVerdictKind,
  ReviewOption,
  ReviewPayload,
  ReviewShape,
  TaskReviewItem,
} from './review-item-types.ts';

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const JUDGE_VERDICTS: ReadonlySet<string> = new Set(['ok', 'held', 'unavailable', 'pending']);

/**
 * The one mapping between the agent-facing vocabulary and the stored one.
 *
 * Bryan renamed the field to `review_type` and the open-ended kind to
 * `"question"` (2026-08-21) so the value stops colliding with "review item",
 * the general term. The stored spelling stays `shape: 'review'` — ~168
 * persisted docs and every pre-rename bundle already say it, and a stored
 * vocabulary migration would rewrite records for no reader's benefit. So:
 * new spellings are accepted at every door and normalized here; old spellings
 * are accepted forever for the callers nobody can restart.
 */
export function normalizeReviewType(value: unknown): ReviewShape | undefined {
  if (value === 'decision') return 'decision';
  if (value === 'review' || value === 'question') return 'review';
  return undefined;
}

/**
 * Legacy authored text, folded into one body — `why`, then `lookFor`, then
 * `detail`, blank-line separated, empty parts omitted.
 *
 * This WAS the card's composition step: the payload carried three authored
 * fields and every surface joined them here so none could render a part the
 * others dropped. Now that the payload carries one, the join has one job left,
 * and it is a migration rather than a layout: text an OLD caller sends and
 * text already sitting in a `.ydoc` arrives under the retired names, and both
 * have to come out as words the reader sees. `readReviewPayload` is the only
 * caller — one funnel, so a folded read and a folded write cannot disagree.
 *
 * The order is the order the card used to render them in, so a stored item
 * reads today exactly as it read yesterday.
 */
function foldLegacyBody(why: unknown, lookFor: unknown, detail: unknown): string | undefined {
  const body = [why, lookFor, detail]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part !== '')
    .join('\n\n');
  return body === '' ? undefined : body;
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
 *
 * It is also where the retired `why` / `lookFor` are RECOVERED. Both paths run
 * through here — the write path normalizes an incoming payload with it before
 * storing, every read path runs it on the way out — so folding their text into
 * `detail` here answers the two obligations the removal created with one
 * mechanism: an old bundle's write keeps every word its author typed, and the
 * thousands of payloads already in `.ydoc` state keep rendering in full
 * without anything rewriting stored docs. A reader cannot tell which field a
 * paragraph came from, which is the point — they are one body now.
 */
/**
 * The superseded-wording list, read back defensively.
 *
 * Shared by `readReviewPayload` and `readTaskReviewItem` because the two
 * surfaces keep the SAME record in the same type — a doc-thread item on its
 * payload, a ticket-borne one on its wrapper — and two parsers for one shape
 * is how they would drift. Absent rather than empty when nothing parses, like
 * every other optional list here.
 */
function readRevisions(value: unknown): ReviewItemRevision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const revs: ReviewItemRevision[] = [];
  for (const raw of value) {
    if (!isPlainObject(raw)) continue;
    // The previous headline IS the record — a row without one preserves
    // nothing, so it is the only field that can drop a row.
    if (typeof raw.headline !== 'string') continue;
    const rev: ReviewItemRevision = {
      at: num(raw.at, 0),
      by: str(raw.by, ''),
      headline: raw.headline,
    };
    if (typeof raw.detail === 'string') rev.detail = raw.detail;
    const options = readReviewPayload({ headline: raw.headline, options: raw.options })?.options;
    if (options) rev.options = options;
    if (typeof raw.threadId === 'string' && raw.threadId !== '') rev.threadId = raw.threadId;
    const span = readSpan(raw.revisedRange);
    if (span) rev.revisedRange = span;
    revs.push(rev);
  }
  return revs.length > 0 ? revs : undefined;
}

export function readReviewPayload(value: unknown): ReviewPayload | undefined {
  if (!isPlainObject(value)) return undefined;
  const shape = normalizeReviewType(value.review_type ?? value.shape);
  if (shape === undefined) return undefined;
  const headline = value.headline;
  if (typeof headline !== 'string' || headline.trim() === '') return undefined;

  const out: ReviewPayload = { shape, headline };
  const detail = foldLegacyBody(value.why, value.lookFor, value.detail);
  if (detail !== undefined) out.detail = detail;
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

  // Defensively, like the answer stamps above: `withdrawnAt` is what makes an
  // item read as retracted, so a junk-typed value must not retire a live ask —
  // nor revive a retracted one, which would put words the asker took back
  // back in front of the reader.
  if (typeof value.withdrawnAt === 'number' && Number.isFinite(value.withdrawnAt)) {
    out.withdrawnAt = value.withdrawnAt;
  }
  if (typeof value.withdrawnBy === 'string') out.withdrawnBy = value.withdrawnBy;
  if (typeof value.withdrawnReason === 'string') out.withdrawnReason = value.withdrawnReason;

  const payloadRevisions = readRevisions(value.revisions);
  if (payloadRevisions) out.revisions = payloadRevisions;

  // The gate's verdict, restored from storage. Read defensively like every
  // stamp above — an unreadable verdict reads as "never judged", which is a
  // PASS, matching the rule that a judge failure never blocks (`judge` is
  // absent on every item filed before the gate existed).
  //
  // This reader is also the CRDT's, so it accepts a verdict from disk. The
  // door an agent's own payload arrives through is `reviewFromBody` in the
  // server, and that one deletes `judge` before it gets here: without that,
  // filing with `judge: {verdict: 'ok'}` would clear the gate in one key.
  const payloadJudge = readJudgement(value.judge);
  if (payloadJudge) out.judge = payloadJudge;

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
      const req: ReviewInfoRequest = { text: raw.text, by: str(raw.by, ''), ts: num(raw.ts, 0) };
      if (typeof raw.threadId === 'string' && raw.threadId !== '') req.threadId = raw.threadId;
      const range = readRange(raw.range);
      if (range) req.range = range;
      reqs.push(req);
    }
    if (reqs.length > 0) out.infoRequests = reqs;
  }

  const revisions = readRevisions(value.revisions);
  if (revisions) out.revisions = revisions;

  // A verdict that cannot be read is dropped, and the row kept: the safe
  // direction is the pass-through, since a hold nobody can explain is an item
  // that vanished from the queue with no reason on the card.
  const judge = readJudgement(value.judge);
  if (judge) out.judge = judge;
  return out;
}

function readJudgement(value: unknown): ReviewItemJudgement | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.verdict !== 'string' || !JUDGE_VERDICTS.has(value.verdict)) return undefined;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined;
  return {
    at: value.at,
    verdict: value.verdict as ReviewJudgeVerdictKind,
    reason: str(value.reason, ''),
  };
}

function readSpan(value: unknown): { start: number; end: number } | undefined {
  if (!isPlainObject(value)) return undefined;
  const { start, end } = value;
  if (typeof start !== 'number' || typeof end !== 'number') return undefined;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
    return undefined;
  }
  return { start, end };
}

function readRange(value: unknown): ReviewItemRange | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.text !== 'string' || value.text === '') return undefined;
  const span = readSpan({ start: value.start, end: value.end });
  return span ? { text: value.text, ...span } : { text: value.text };
}
