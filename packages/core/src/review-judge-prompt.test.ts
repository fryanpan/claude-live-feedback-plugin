import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_ITEM_CRITERIA,
  REVIEW_JUDGE_REASON_MAX,
  buildReviewJudgePrompt,
  parseReviewJudgeResponse,
} from './review-judge-prompt.ts';

/** All fixtures are synthetic. */

describe('buildReviewJudgePrompt', () => {
  it('puts the criteria verbatim in the system turn and the item as labelled fields', () => {
    const { system, user } = buildReviewJudgePrompt('Headline must be a question.', {
      headline: 'Which cache size?',
      detail: 'A full pass reads the index once.',
      options: [
        { id: 'o-1', label: 'Keep it', detail: 'costs 2GB' },
        { id: 'o-2', label: 'Halve it' },
      ],
    });
    expect(system).toContain('Headline must be a question.');
    expect(system).toContain('"ok"');
    expect(user).toContain('Headline: Which cache size?');
    expect(user).toContain('Detail: A full pass reads the index once.');
    expect(user).toContain('- Keep it — costs 2GB');
    expect(user).toContain('- Halve it — (no cost given)');
  });

  it('says when there is no detail rather than leaving the field out', () => {
    const { user } = buildReviewJudgePrompt(DEFAULT_REVIEW_ITEM_CRITERIA, { headline: 'x' });
    expect(user).toContain('Detail: (none)');
    expect(user).not.toContain('Options:');
  });

  it('the default criteria name the five things the gate is for', () => {
    for (const word of ['headline', 'stakes', 'cost', 'inline', 'acronym']) {
      expect(DEFAULT_REVIEW_ITEM_CRITERIA.toLowerCase()).toContain(word);
    }
  });
});

describe('parseReviewJudgeResponse', () => {
  it('reads a bare JSON verdict', () => {
    expect(parseReviewJudgeResponse('{"ok": false, "reason": "Headline is a ticket id."}')).toEqual(
      {
        ok: false,
        reason: 'Headline is a ticket id.',
      },
    );
  });

  it('reads a verdict wrapped in prose or a code fence', () => {
    const text = 'Sure.\n```json\n{"ok": true, "reason": "Clear stakes."}\n```';
    expect(parseReviewJudgeResponse(text)).toEqual({ ok: true, reason: 'Clear stakes.' });
  });

  it('is null — a pass-through, never a hold — when the reply is not a verdict', () => {
    expect(parseReviewJudgeResponse('I cannot judge this.')).toBeNull();
    expect(parseReviewJudgeResponse('{"reason": "no ok field"}')).toBeNull();
    expect(parseReviewJudgeResponse('{"ok": "false"}')).toBeNull();
    expect(parseReviewJudgeResponse('{broken')).toBeNull();
  });

  it('clips a runaway reason and collapses its whitespace', () => {
    const long = 'a '.repeat(400);
    const out = parseReviewJudgeResponse(JSON.stringify({ ok: false, reason: long }));
    expect(out?.reason.length).toBeLessThanOrEqual(REVIEW_JUDGE_REASON_MAX);
    expect(out?.reason).not.toContain('  ');
  });
});
