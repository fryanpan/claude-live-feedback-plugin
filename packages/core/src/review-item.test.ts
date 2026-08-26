import { describe, expect, it } from 'vitest';
import {
  REVIEW_LIMITS,
  type ReviewPayload,
  type TaskReviewItem,
  answerFromReply,
  checkReviewPayload,
  isReviewItemOpen,
  pendingDeclaration,
  readReviewPayload,
  readTaskReviewItem,
  reviewAnswered,
  reviewFromDecisionTask,
  reviewGapAdvice,
  reviewPayloadMessage,
} from './review-item.ts';

/** All fixtures are synthetic — invented names, ids and copy throughout. */

function decision(over: Partial<ReviewPayload> = {}): unknown {
  return {
    shape: 'decision',
    headline: 'Should a resolved thread stay visible inline?',
    detail:
      'Threads resolve often and the list gets long, but a hidden reply is a reply nobody sees.',
    options: [
      { id: 'hide', label: 'Hide them', detail: 'Shortest list. A late reply is invisible.' },
      { id: 'dim', label: 'Keep dimmed', detail: 'Longer list, nothing disappears.' },
    ],
    ...over,
  };
}

function review(over: Partial<ReviewPayload> = {}): unknown {
  return {
    shape: 'review',
    headline: 'Read the new onboarding copy',
    detail: 'Three screens of copy. The second one is the one I am least sure about.',
    ...over,
  };
}

describe('checkReviewPayload — the happy path is pinned first', () => {
  // A positive control for every case below. Without it, a checker that
  // refused EVERYTHING would satisfy each individual refusal assertion.
  it('accepts a well-formed decision with no gaps', () => {
    const c = checkReviewPayload(decision());
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.gaps).toEqual([]);
  });

  it('accepts a well-formed review with no gaps', () => {
    const c = checkReviewPayload(review());
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.gaps).toEqual([]);
  });
});

describe('checkReviewPayload — what refuses', () => {
  it('refuses a missing headline', () => {
    const c = checkReviewPayload(decision({ headline: undefined }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('review.headline is required');
  });

  it('refuses a blank headline, not only an absent one', () => {
    expect(checkReviewPayload(decision({ headline: '   ' })).ok).toBe(false);
  });

  it('refuses a headline past the sanity ceiling — that is a pasted paragraph', () => {
    const c = checkReviewPayload(
      decision({ headline: 'x'.repeat(REVIEW_LIMITS.lineMaxChars + 1) }),
    );
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain(String(REVIEW_LIMITS.lineMaxChars));
  });

  it('accepts a one-line field exactly at the ceiling — the boundary is inclusive', () => {
    expect(
      checkReviewPayload(decision({ headline: 'x'.repeat(REVIEW_LIMITS.lineMaxChars) })).ok,
    ).toBe(true);
  });

  it('refuses a headline containing a line break', () => {
    const c = checkReviewPayload(decision({ headline: 'Two\nlines' }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('single line');
  });

  it('refuses a decision with fewer than two options', () => {
    const c = checkReviewPayload(decision({ options: [{ id: 'a', label: 'Only one' }] }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('at least 2 options');
  });

  it('refuses options on a review — that shape is answered in the reader’s words', () => {
    const c = checkReviewPayload(review({ options: [{ id: 'a', label: 'Yes' }] }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain("belong to a 'decision'");
  });

  it('refuses an option label past the sanity ceiling', () => {
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'a', label: 'x'.repeat(REVIEW_LIMITS.lineMaxChars + 1) },
          { id: 'b', label: 'Keep them' },
        ],
      }),
    );
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain(String(REVIEW_LIMITS.lineMaxChars));
  });

  it('refuses duplicate option ids', () => {
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'same', label: 'One' },
          { id: 'same', label: 'Two' },
        ],
      }),
    );
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('used twice');
  });

  // The old shape budgets (50 words for a decision, 150 for a review) REFUSED,
  // which pushed the real context into the thread body while the card kept a
  // compressed copy that said something else — the exact split this module
  // exists to prevent. The targets are advisory now; only a length no card
  // could ever be — the sanity ceiling — refuses. These pin the acceptance
  // side, well past both old budgets, for both shapes.
  it('accepts a detail past the old shape targets — length advice never refuses', () => {
    const long = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ');
    expect(checkReviewPayload(decision({ detail: long })).ok).toBe(true);
    expect(checkReviewPayload(review({ detail: long })).ok).toBe(true);
  });

  it('refuses only a detail past the sanity ceiling, for either shape', () => {
    const absurd = Array.from({ length: REVIEW_LIMITS.detailMaxWords + 1 }, (_, i) => `w${i}`).join(
      ' ',
    );
    for (const payload of [decision({ detail: absurd }), review({ detail: absurd })]) {
      const c = checkReviewPayload(payload);
      expect(c.ok).toBe(false);
      expect(c.errors.join(' ')).toContain(String(REVIEW_LIMITS.detailMaxWords));
    }
    const atCeiling = Array.from({ length: REVIEW_LIMITS.detailMaxWords }, (_, i) => `w${i}`).join(
      ' ',
    );
    expect(checkReviewPayload(review({ detail: atCeiling })).ok).toBe(true);
  });

  it('refuses an unknown shape', () => {
    expect(checkReviewPayload(decision({ shape: 'links' as never })).ok).toBe(false);
  });

  it('refuses a non-object', () => {
    for (const v of [null, undefined, 'a string', 42, ['array']]) {
      expect(checkReviewPayload(v).ok).toBe(false);
    }
  });
});

describe('checkReviewPayload — what only advises', () => {
  it('accepts a review with no detail and reports it as a gap', () => {
    const c = checkReviewPayload(review({ detail: undefined }));
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('detail');
  });
});

// The row budgets used to REFUSE, and in one measured 24-hour window that
// bounced six honest filings running 92–102 characters against a 90-character
// budget — each one at the moment an agent was routing an ask to the queue
// instead of to chat, and each one costing a retry to shave two words. A
// budget is a rendering fact, not a correctness one: the row wraps, which is
// worse than a tight line and far better than the ask never being filed. So
// they advise, exactly as the detail target has since #299.
describe('checkReviewPayload — a length over a row budget advises, it does not refuse', () => {
  it('files an over-long headline and reports the gap', () => {
    const c = checkReviewPayload(decision({ headline: 'x'.repeat(REVIEW_LIMITS.headline + 1) }));
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('headlineLength');
  });

  it('files a four-word option label — the reported shape of the refusal', () => {
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'a', label: 'Hide the resolved threads' },
          { id: 'b', label: 'Keep them' },
        ],
      }),
    );
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('optionLabelLength');
  });

  it('files an option label over the button width', () => {
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'a', label: 'x'.repeat(REVIEW_LIMITS.optionLabelChars + 1) },
          { id: 'b', label: 'Keep them' },
        ],
      }),
    );
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('optionLabelLength');
  });

  it('files an option detail past its word budget', () => {
    const long = Array.from(
      { length: REVIEW_LIMITS.optionDetailWords + 10 },
      (_, i) => `w${i}`,
    ).join(' ');
    const c = checkReviewPayload(
      decision({
        options: [
          { id: 'a', label: 'Hide them', detail: long },
          { id: 'b', label: 'Keep them' },
        ],
      }),
    );
    expect(c.ok).toBe(true);
    expect(c.gaps).toContain('optionDetailLength');
  });

  it('still refuses the things that are not lengths at all', () => {
    // The positive control for the block above: loosening the budgets must not
    // have loosened the structural rules that share the same code path.
    const c = checkReviewPayload(
      decision({
        headline: 'x'.repeat(REVIEW_LIMITS.headline + 1),
        options: [{ id: 'a', label: 'Only one' }],
      }),
    );
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('at least 2 options');
  });
});

describe('reviewPayloadMessage', () => {
  it('quotes every refusal so a retrying model can act on the text alone', () => {
    const c = checkReviewPayload(decision({ headline: undefined, shape: 'links' as never }));
    const msg = reviewPayloadMessage(c);
    for (const e of c.errors) expect(msg).toContain(e);
    expect(c.errors.length).toBeGreaterThan(1);
  });
});

describe('reviewGapAdvice — the advice half, which nothing used to read', () => {
  it('says nothing at all about a complete payload', () => {
    // The positive control for every assertion below: the same helper DOES
    // speak when there is something to say, so an empty answer here is a
    // judgement about this payload rather than a helper that never fires.
    expect(reviewGapAdvice(checkReviewPayload(decision()).gaps)).toBeUndefined();
    expect(reviewGapAdvice(['detail'])).toBeDefined();
  });

  // Both directions, because either alone passes against a helper that names
  // one field unconditionally — mutation-tested: making the detail branch
  // unconditional survives the first of these and is killed by the second.
  it('names the missing body when the body is what is missing', () => {
    const advice = reviewGapAdvice(checkReviewPayload(review({ detail: undefined })).gaps);
    expect(advice).toContain('review.detail');
    expect(advice).not.toContain('review.headline');
  });

  it('says nothing about the body when the body is there', () => {
    const advice = reviewGapAdvice(checkReviewPayload(decision()).gaps);
    expect(advice).toBeUndefined();
  });

  it('names an over-long field, and says it FILED', () => {
    // The advice a length gap produces has one job the thin-field advice does
    // not: an author who reads it as a refusal retries a write that already
    // succeeded and files the ask twice.
    const advice = reviewGapAdvice(['headlineLength']) ?? '';
    expect(advice).toContain('review.headline');
    expect(advice).toContain('Filed.');
    expect(advice).not.toContain('cannot be filed');
    expect(advice).not.toContain('review.detail');
  });

  it('says both halves when a payload is thin AND over-long', () => {
    const advice = reviewGapAdvice(['detail', 'headlineLength']) ?? '';
    expect(advice).toContain('review.detail');
    expect(advice).toContain('review.headline');
  });

  it('reads as filed-but-thin, never as a refusal', () => {
    // The distinction the whole two-tier design rests on. If this text reads
    // like reviewPayloadMessage, an author retries a write that already
    // succeeded and files the item twice.
    const advice = reviewGapAdvice(['detail']) ?? '';
    expect(advice).toContain('Filed.');
    expect(advice).not.toContain('cannot be filed');
  });
});

describe('readReviewPayload — loose on the way out, so nothing already stored vanishes', () => {
  it('round-trips a full payload', () => {
    const p = decision() as ReviewPayload;
    expect(readReviewPayload(p)).toEqual(p);
  });

  it('reads a payload whose fields exceed today’s limits', () => {
    // The gate guards the door; the reader must not re-litigate it, or
    // tightening a limit would make already-filed items disappear from the
    // queue rather than merely stop new ones being written.
    const over = decision({ headline: 'x'.repeat(REVIEW_LIMITS.lineMaxChars + 50) });
    expect(checkReviewPayload(over).ok).toBe(false);
    expect(readReviewPayload(over)?.headline).toHaveLength(REVIEW_LIMITS.lineMaxChars + 50);
  });

  it('returns undefined for anything that is not a review payload', () => {
    for (const v of [null, undefined, 'x', 7, [], {}, { shape: 'decision' }]) {
      expect(readReviewPayload(v)).toBeUndefined();
    }
  });

  it('drops malformed options instead of throwing', () => {
    const p = readReviewPayload(
      decision({ options: [{ id: 'a', label: 'Keep' }, 'not an object', { id: 'b' }] as never }),
    );
    expect(p?.options).toEqual([{ id: 'a', label: 'Keep' }]);
  });

  it('drops the options key entirely when none survive', () => {
    expect(readReviewPayload(decision({ options: ['junk'] as never }))?.options).toBeUndefined();
  });

  it('carries answeredWith through', () => {
    expect(readReviewPayload(decision({ answeredWith: 'dim' }))?.answeredWith).toBe('dim');
  });

  it('carries answeredAt through, and refuses a stamp that is not a number', () => {
    expect(readReviewPayload(decision({ answeredAt: 1_700_000_000_000 }))?.answeredAt).toBe(
      1_700_000_000_000,
    );
    // A peer can sync anything into this map. A stamp that arrived as a string
    // or as NaN must not read as an answer — that would silently retire a
    // question — so it is dropped and the item stays on the queue.
    for (const junk of ['1700000000000', Number.NaN, null, {}]) {
      expect(
        readReviewPayload(decision({ answeredAt: junk as never }))?.answeredAt,
      ).toBeUndefined();
    }
  });

  it('carries the answer record — answeredBy and answerText — through', () => {
    // The record's face: "Answered by you: Move below" has to survive a
    // reload, so the words and the name live on the declaration itself.
    const p = readReviewPayload(
      decision({ answeredAt: 1_700_000_000_000, answeredBy: 'Jordan', answerText: 'Move below' }),
    );
    expect(p?.answeredBy).toBe('Jordan');
    expect(p?.answerText).toBe('Move below');
  });

  it('drops an answeredBy or answerText that is not a string', () => {
    for (const junk of [7, null, {}, ['Jordan']]) {
      const p = readReviewPayload(
        decision({ answeredBy: junk as never, answerText: junk as never }),
      );
      expect(p?.answeredBy).toBeUndefined();
      expect(p?.answerText).toBeUndefined();
    }
  });

  it('round-trips answerHistory, dropping malformed entries instead of throwing', () => {
    const kept = {
      answeredAt: 1_700_000_000_000,
      answeredBy: 'Jordan',
      answerText: 'Move below',
      answeredWith: 'dim',
      undoneAt: 1_700_000_100_000,
      undoneBy: 'Jordan',
    };
    const p = readReviewPayload(
      decision({
        answerHistory: [
          kept,
          'not an object',
          // No undoneAt: a history row IS an undo record; without the stamp
          // there is nothing it records.
          { answeredAt: 1, undoneBy: 'Jordan' },
          // undoneBy arrived as a number — a peer can sync anything here.
          { answeredAt: 1, undoneAt: 2, undoneBy: 7 },
        ] as never,
      }),
    );
    expect(p?.answerHistory).toEqual([kept]);
  });

  it('keeps a minimal history entry — the optional fields degrade, the record stays', () => {
    const p = readReviewPayload(
      decision({ answerHistory: [{ answeredAt: 1, undoneAt: 2, undoneBy: 'Jordan' }] as never }),
    );
    expect(p?.answerHistory).toEqual([{ answeredAt: 1, undoneAt: 2, undoneBy: 'Jordan' }]);
  });

  it('drops the answerHistory key entirely when none survive', () => {
    expect(
      readReviewPayload(decision({ answerHistory: ['junk'] as never }))?.answerHistory,
    ).toBeUndefined();
    expect(
      readReviewPayload(decision({ answerHistory: 'junk' as never }))?.answerHistory,
    ).toBeUndefined();
  });
});

/**
 * One predicate for "has a person answered this", because the queue and the
 * card must not each decide it — and because two stamps mean the same thing:
 * `answeredAt` on every answer since it existed, `answeredWith` alone on an
 * option tapped before it did.
 */
describe('reviewAnswered', () => {
  const payload = (over: Partial<ReviewPayload> = {}): ReviewPayload =>
    readReviewPayload(decision(over)) as ReviewPayload;

  it('is true for a typed answer, an option tap, and a legacy option tap', () => {
    expect(reviewAnswered(payload({ answeredAt: 1 }))).toBe(true);
    expect(reviewAnswered(payload({ answeredAt: 1, answeredWith: 'dim' }))).toBe(true);
    expect(reviewAnswered(payload({ answeredWith: 'dim' }))).toBe(true);
  });

  it('is false for an item nobody has answered', () => {
    expect(reviewAnswered(payload())).toBe(false);
  });
});

/** A legacy decision TASK, in the parallel spelling this module is absorbing.
 *  Server-minted option ids, verbatim title, `optionId` on the answer. */
function decisionTask(over: Record<string, unknown> = {}) {
  return {
    title: 'Which retention window for staged uploads?',
    body: 'Staging fills with abandoned uploads. Nothing prunes them today.',
    options: [
      { id: 'o-7f3a', label: 'Seven days', detail: 'Cheapest. Loses a slow reviewer.' },
      { id: 'o-91cc', label: 'Thirty days', detail: 'Covers a holiday. Costs storage.' },
    ],
    ...over,
  };
}

describe('reviewFromDecisionTask — one spelling, derived mechanically from the old one', () => {
  it('maps the title to the headline VERBATIM, never a clip of it', () => {
    const t = decisionTask();
    const p = reviewFromDecisionTask(t);
    expect(p.shape).toBe('decision');
    expect(p.headline).toBe(t.title);
  });

  it('maps the body to detail verbatim and the options 1:1 with their minted ids', () => {
    const t = decisionTask();
    const p = reviewFromDecisionTask(t);
    expect(p.detail).toBe(t.body);
    expect(p.options).toEqual(t.options);
    // Option identity is the task's, not re-minted here: an answer already
    // recorded against `o-7f3a` has to keep pointing at the same candidate.
    expect(p.options?.map((o) => o.id)).toEqual(['o-7f3a', 'o-91cc']);
  });

  it('carries a recorded answer’s optionId across as answeredWith', () => {
    const p = reviewFromDecisionTask(
      decisionTask({ answer: { text: 'Thirty days', by: 'Reviewer', ts: 1, optionId: 'o-91cc' } }),
    );
    expect(p.answeredWith).toBe('o-91cc');
  });

  it('leaves answeredWith absent for a typed answer, which is not a lesser answer', () => {
    const p = reviewFromDecisionTask(
      decisionTask({ answer: { text: 'Neither — prune on read.', by: 'Reviewer', ts: 1 } }),
    );
    expect(p.answeredWith).toBeUndefined();
  });

  // This derivation invents NOTHING. It used to have to fabricate one thing —
  // a `why` of '', because the payload required a second line and no legacy
  // decision task ever authored one — and that hole closed when the field did.
  // The output is now a payload the writer's own gate accepts.
  it('invents no field the task never had', () => {
    const p = reviewFromDecisionTask(decisionTask());
    expect(checkReviewPayload(p).ok).toBe(true);
    expect(readReviewPayload(p)).toEqual(p);
  });

  it('does not re-litigate the body sanity ceiling a legacy task never had', () => {
    const long = Array.from({ length: REVIEW_LIMITS.detailMaxWords + 40 }, (_, i) => `w${i}`).join(
      ' ',
    );
    const p = reviewFromDecisionTask(decisionTask({ body: long }));
    expect(p.detail).toBe(long);
    expect(readReviewPayload(p)?.detail).toBe(long);
  });

  it('still derives a readable payload from a task with no options and no body', () => {
    const p = reviewFromDecisionTask({ title: 'Ship it this week?' });
    expect(p.detail).toBeUndefined();
    expect(p.options).toBeUndefined();
    expect(readReviewPayload(p)).toEqual(p);
  });
});

describe('TaskReviewItem — a ticket HAS review items, 0..n, rather than IS one', () => {
  function item(over: Record<string, unknown> = {}): unknown {
    return {
      id: 'ri-4b2e',
      review: decision(),
      createdAt: 1700000000000,
      createdBy: 'Scheduler Agent',
      ...over,
    };
  }

  it('reads a well-formed row back whole', () => {
    // Positive control for every drop assertion below: this reader DOES
    // return rows, so an undefined further down is a judgement about that
    // row rather than a reader that never returns anything.
    const read = readTaskReviewItem(item());
    expect(read?.id).toBe('ri-4b2e');
    expect(read?.review.headline).toBe((decision() as ReviewPayload).headline);
    expect(read?.createdBy).toBe('Scheduler Agent');
  });

  it('drops a row with a non-string id, returning undefined rather than throwing', () => {
    expect(() => readTaskReviewItem(item({ id: 42 }))).not.toThrow();
    expect(readTaskReviewItem(item({ id: 42 }))).toBeUndefined();
    expect(readTaskReviewItem(item({ id: '   ' }))).toBeUndefined();
  });

  it('drops a row whose review is unreadable, since there is nothing left to show', () => {
    expect(readTaskReviewItem(item({ review: { shape: 'decision' } }))).toBeUndefined();
    expect(readTaskReviewItem(item({ review: undefined }))).toBeUndefined();
  });

  it('returns undefined for anything that is not a row at all', () => {
    for (const v of [null, undefined, 'x', 7, [], {}]) {
      expect(readTaskReviewItem(v)).toBeUndefined();
    }
  });

  it('reads an answer and its provenance, and drops one with no words', () => {
    const answered = readTaskReviewItem(
      item({ answer: { text: 'Keep dimmed', by: 'Reviewer', ts: 12, answeredWith: 'dim' } }),
    );
    expect(answered?.answer).toEqual({
      text: 'Keep dimmed',
      by: 'Reviewer',
      ts: 12,
      answeredWith: 'dim',
    });
    expect(readTaskReviewItem(item({ answer: { by: 'Reviewer' } }))?.answer).toBeUndefined();
  });

  /**
   * Answering twice is legal — a person changes their mind, or a retry lands —
   * but the words already recorded are USER CONTENT, and this project does not
   * hard-delete user content. So a superseded answer moves to `priorAnswers`
   * rather than being overwritten out of existence, oldest first.
   */
  it('reads superseded answers back, oldest first, and drops only the wordless ones', () => {
    const read = readTaskReviewItem(
      item({
        answer: { text: 'Keep memory', by: 'Reviewer', ts: 30 },
        priorAnswers: [
          { text: 'Keep disk', by: 'Reviewer', ts: 10, answeredWith: 'dim' },
          { by: 'Reviewer', ts: 20 },
          'not an object',
        ],
      }),
    );
    expect(read?.priorAnswers).toEqual([
      { text: 'Keep disk', by: 'Reviewer', ts: 10, answeredWith: 'dim' },
    ]);
    // Absent rather than empty while there are none — the same rule the rest
    // of this row follows, so a reader can ask one question.
    expect(readTaskReviewItem(item())?.priorAnswers).toBeUndefined();
    expect(readTaskReviewItem(item({ priorAnswers: ['junk'] }))?.priorAnswers).toBeUndefined();
  });

  it('keeps readable info requests and drops only the malformed ones', () => {
    const read = readTaskReviewItem(
      item({
        infoRequests: [
          { text: 'What does the slow reviewer actually do?', by: 'Reviewer', ts: 5 },
          'not an object',
          { by: 'Reviewer', ts: 6 },
        ],
      }),
    );
    expect(read?.infoRequests).toEqual([
      { text: 'What does the slow reviewer actually do?', by: 'Reviewer', ts: 5 },
    ]);
    expect(readTaskReviewItem(item({ infoRequests: ['junk'] }))?.infoRequests).toBeUndefined();
  });
});

describe('isReviewItemOpen — several can be open on one ticket at once', () => {
  const base: TaskReviewItem = {
    id: 'ri-1',
    review: decision() as ReviewPayload,
    createdAt: 1,
    createdBy: 'Scheduler Agent',
  };

  it('is open until it is answered, and an info request does not answer it', () => {
    expect(isReviewItemOpen(base)).toBe(true);
    expect(
      isReviewItemOpen({
        ...base,
        infoRequests: [{ text: 'Say more?', by: 'Reviewer', ts: 2 }],
      }),
    ).toBe(true);
  });

  it('is closed once an answer is recorded', () => {
    expect(isReviewItemOpen({ ...base, answer: { text: 'Keep dimmed', by: 'R', ts: 3 } })).toBe(
      false,
    );
  });

  it('counts several open items on one ticket', () => {
    const items: TaskReviewItem[] = [
      base,
      { ...base, id: 'ri-2' },
      { ...base, id: 'ri-3', answer: { text: 'Hide them', by: 'R', ts: 4 } },
    ];
    expect(items.filter(isReviewItemOpen).map((i) => i.id)).toEqual(['ri-1', 'ri-2']);
  });
});

describe('the writer’s gate is exactly as strict as it was', () => {
  // Positive controls for the whole commit: adding a derivation path that
  // bypasses checkReviewPayload must not have loosened checkReviewPayload.
  it('still refuses a decision with no headline', () => {
    const c = checkReviewPayload({ shape: 'decision', detail: 'x' });
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('review.headline is required');
  });

  it('still refuses a one-option decision', () => {
    const c = checkReviewPayload(decision({ options: [{ id: 'a', label: 'Only one' }] }));
    expect(c.ok).toBe(false);
    expect(c.errors.join(' ')).toContain('at least 2 options');
  });

  it('still only ADVISES about a missing detail', () => {
    const c = checkReviewPayload(decision({ detail: undefined }));
    expect(c.ok).toBe(true);
    expect(c.errors).toEqual([]);
    expect(c.gaps).toContain('detail');
  });
});

/**
 * The doc surface's answer target.
 *
 * A person meets a review item three ways — on Home, on the task, and in the
 * doc thread that carries it — and until now only the first two could answer
 * one. The doc panel posted every reply to `/comments`, so a thread could
 * render the declaration, take his words, and leave the item in the queue
 * exactly as it was. Four declared items on `board-review-2026-08-19` have a
 * human reply each and zero `answeredAt` stamps.
 *
 * `/answer` needs to be told WHICH comment it is answering, so the predicate
 * that picks it is the whole of the doc surface's new logic.
 */
describe('pendingDeclaration', () => {
  const ask = (over: Partial<ReviewPayload> = {}): ReviewPayload => ({
    shape: 'review',
    headline: 'Read the stall rota before Thursday',
    ...over,
  });
  const open = (comments: Array<{ id: string; ts: number; review?: ReviewPayload }>) => ({
    status: 'open' as const,
    comments,
  });

  it('is null when nothing in the thread declared anything', () => {
    expect(
      pendingDeclaration(
        open([
          { id: 'c1', ts: 1 },
          { id: 'c2', ts: 2 },
        ]),
      ),
    ).toBeNull();
  });

  it('names the declaring comment when one is unanswered', () => {
    expect(
      pendingDeclaration(
        open([
          { id: 'c1', ts: 1, review: ask() },
          { id: 'c2', ts: 2 },
        ]),
      )?.id,
    ).toBe('c1');
  });

  it('is null once that item has been answered', () => {
    const answered = ask({ answeredAt: 1_700_000_000_000 });
    expect(pendingDeclaration(open([{ id: 'c1', ts: 1, review: answered }]))).toBeNull();
  });

  it('reads an option tapped before answeredAt existed as answered too', () => {
    const tapped = ask({ shape: 'decision', answeredWith: 'goal' });
    expect(pendingDeclaration(open([{ id: 'c1', ts: 1, review: tapped }]))).toBeNull();
  });

  it('takes the LATEST unanswered ask, not the first', () => {
    expect(
      pendingDeclaration(
        open([
          { id: 'c1', ts: 1, review: ask({ answeredAt: 1 }) },
          { id: 'c2', ts: 2, review: ask({ headline: 'And now the feed order' }) },
          { id: 'c3', ts: 3 },
        ]),
      )?.id,
    ).toBe('c2');
  });

  // The rule the doc panel used to disagree with Home about: the NEWEST
  // declaration decides, and only it. An agent that asks again has moved on
  // from what it asked before, so an older unanswered payload buried under a
  // newer answered one is history — Home stopped offering it, and a doc
  // panel that still rendered an Answer composer for it was stamping a
  // comment no queue was showing.
  it('an answered newer declaration retires the whole thread, buried asks included', () => {
    expect(
      pendingDeclaration(
        open([
          { id: 'c1', ts: 1, review: ask() },
          { id: 'c2', ts: 2, review: ask({ answeredAt: 2 }) },
        ]),
      ),
    ).toBeNull();
  });

  it('a non-open thread has nothing pending, whatever its comments say', () => {
    expect(
      pendingDeclaration({
        status: 'resolved',
        comments: [{ id: 'c1', ts: 1, review: ask() }],
      }),
    ).toBeNull();
  });

  it('orders by ts, not by array position — CRDT merge order is not a clock', () => {
    expect(
      pendingDeclaration(
        open([
          // Array order says the answered one is newest; the clock disagrees.
          { id: 'c-late-answered', ts: 5, review: ask({ answeredAt: 6 }) },
          { id: 'c-later-still', ts: 9, review: ask({ headline: 'Newer by clock' }) },
        ]),
      )?.id,
    ).toBe('c-later-still');
    const reversed = [
      { id: 'c-answered-new', ts: 8, review: ask({ answeredAt: 9 }) },
      { id: 'c-unanswered-old', ts: 2, review: ask() },
    ];
    expect(pendingDeclaration(open(reversed))).toBeNull();
  });

  it('tolerates a thread with no comments array at all', () => {
    expect(pendingDeclaration({ status: 'open' })).toBeNull();
  });
});

// Bryan, twice, on the card's shape: *"I asked to get rid of this. It imposes
// a structure that's too rigid and leaves not enough room to manouevwd. Title
// and detail is enough."* So `why` and `lookFor` are gone from the payload —
// not made optional, not renamed. Two things have to survive their removal,
// and both are about words somebody already wrote:
//
//  - an OLD BUNDLE still sends them. This is the shared server's REST surface
//    and a session that has not restarted keeps calling it, so the write must
//    succeed rather than 400 — and must not drop the text on the floor.
//  - thousands of payloads are already STORED with them populated. A read that
//    ignored them would silently shorten every card written before today.
//
// One mechanism answers both, which is why there is no separate migration:
// `readReviewPayload` is the single funnel — the write path runs it before
// storing, every read path runs it on the way out — and it folds the legacy
// text into `detail`, in the order the card used to render it.
describe('why / lookFor are gone from the payload, and their words are not', () => {
  const legacy = {
    shape: 'decision',
    headline: 'Should a resolved thread stay visible inline?',
    why: 'Blocks the inline-comments branch.',
    lookFor: 'Whether hiding it loses the audit trail.',
    detail: 'Threads resolve often and the list gets long.',
    options: [
      { id: 'hide', label: 'Hide them' },
      { id: 'dim', label: 'Keep dimmed' },
    ],
  };

  it('accepts a payload that still carries both — an unrestarted caller is not refused', () => {
    const c = checkReviewPayload(legacy);
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
  });

  it('no longer refuses a payload with no why at all', () => {
    const c = checkReviewPayload({
      shape: 'review',
      headline: 'Read the new onboarding copy',
      detail: 'Three screens of copy.',
    });
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    // The positive control: the same call still refuses what it always did, so
    // an empty `errors` here is a judgement about this payload rather than a
    // checker that stopped checking.
    expect(checkReviewPayload({ shape: 'review', detail: 'x' }).ok).toBe(false);
  });

  it('folds both legacy fields into detail, in the order the card rendered them', () => {
    const p = readReviewPayload(legacy);
    expect(p).toBeDefined();
    expect(p?.detail).toBe(
      'Blocks the inline-comments branch.\n\nWhether hiding it loses the audit trail.\n\nThreads resolve often and the list gets long.',
    );
    // Gone from the shape, not merely absent from the type.
    expect(Object.hasOwn(p as object, 'why')).toBe(false);
    expect(Object.hasOwn(p as object, 'lookFor')).toBe(false);
  });

  it('folds a legacy field even when there is no detail to fold it into', () => {
    expect(
      readReviewPayload({ shape: 'review', headline: 'H', why: 'The rota goes out Thursday.' })
        ?.detail,
    ).toBe('The rota goes out Thursday.');
  });

  it('leaves a modern payload exactly as written', () => {
    expect(
      readReviewPayload({ shape: 'review', headline: 'H', detail: 'Just the body.' })?.detail,
    ).toBe('Just the body.');
  });

  it('reads a stored payload whose why is empty or absent', () => {
    // `reviewFromDecisionTask` has always produced `why: ''`, and ~168 stored
    // docs carry it. An empty legacy field contributes no paragraph, and its
    // emptiness must not drop the item.
    expect(
      readReviewPayload({ shape: 'decision', headline: 'H', why: '', detail: 'B' })?.detail,
    ).toBe('B');
    expect(readReviewPayload({ shape: 'decision', headline: 'H' })).toBeDefined();
  });

  it('drops the advice that nagged for a lookFor', () => {
    // A title and a detail is now a COMPLETE payload — nothing left to nag
    // about. The old checker reported a `lookFor` gap on exactly this input.
    const c = checkReviewPayload({ shape: 'review', headline: 'H', detail: 'B' });
    expect(c.gaps).toEqual([]);
    expect(reviewGapAdvice(c.gaps)).toBeUndefined();
    // Still says the one thing it has left to say.
    expect(reviewGapAdvice(['detail'])).toContain('review.detail');
  });

  it('stops publishing budgets for fields that no longer exist', () => {
    expect(Object.hasOwn(REVIEW_LIMITS, 'why')).toBe(false);
    expect(Object.hasOwn(REVIEW_LIMITS, 'lookFor')).toBe(false);
  });

  it('derives a legacy decision task without inventing a why', () => {
    const p = reviewFromDecisionTask({ title: 'Pick a rota', body: 'Two people are free.' });
    expect(p.headline).toBe('Pick a rota');
    expect(p.detail).toBe('Two people are free.');
    expect(Object.hasOwn(p, 'why')).toBe(false);
  });
});

/**
 * Whether a plain reply counts as the answer.
 *
 * Measured over this project's stored docs before this existed: 152
 * comment-borne declarations, 123 answered, and 12 unanswered ones with a
 * person's reply directly underneath. Four of the twelve offered no options —
 * those are the ones this reads as answers. The other eight are prose under a
 * decision, and they stay unanswered on purpose: a rule that guessed which
 * option prose meant is the one that once let small talk retire a decision.
 */
describe('answerFromReply', () => {
  const question: ReviewPayload = { shape: 'review', headline: 'Does the copy read right?' };
  const decisionWithOptions: ReviewPayload = {
    shape: 'decision',
    headline: 'Where should the banner live?',
    options: [
      { id: 'above', label: 'Keep above' },
      { id: 'below', label: 'Move below' },
    ],
  };

  it('reads prose as the answer when nothing was offered', () => {
    expect(answerFromReply(question, 'Cut the second sentence.')).toEqual({});
  });

  it('picks the option whose label was typed, trimmed and case-folded', () => {
    expect(answerFromReply(decisionWithOptions, '  move below ')).toEqual({ optionId: 'below' });
  });

  it('answers nothing when prose lands on a decision', () => {
    // A question asked back reads exactly like this, which is why the words
    // are left as a comment rather than turned into a pick.
    expect(answerFromReply(decisionWithOptions, 'Why is it above the fold at all?')).toBeNull();
  });

  it('answers nothing on empty words', () => {
    expect(answerFromReply(question, '   ')).toBeNull();
  });

  it('reads prose as the answer on a decision that offered no options', () => {
    // Keyed on what was OFFERED, not on the authored shape: with no options
    // there is no vocabulary to type back, so prose is the only answer it
    // could ever receive.
    expect(
      answerFromReply({ shape: 'decision', headline: 'Which way?' }, 'The second one'),
    ).toEqual({});
  });
});
