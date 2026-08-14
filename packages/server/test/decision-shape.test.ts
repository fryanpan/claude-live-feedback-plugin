import { describe, expect, it } from 'bun:test';
import { checkDecisionShape, decisionShapeMessage } from '../src/decision-shape.ts';

/**
 * The gate for `needs: 'decision'` bodies. The real failure it exists to
 * catch is a PROGRESS REPORT filed as a decision: the field is populated, the
 * check passes, and the person asked to decide has nothing to decide from.
 *
 * The floor is deliberately one rule — the body has to ASK something — so
 * filing a quick decision stays a one-liner. Everything else is reported as a
 * gap on a successful create, not refused.
 */
describe('checkDecisionShape', () => {
  it('refuses a body that is missing, blank, or whitespace', () => {
    for (const body of [undefined, '', '   \n\t  ']) {
      const res = checkDecisionShape(body);
      expect(res.ok).toBe(false);
      expect(res.gaps).toContain('question');
    }
  });

  it('refuses the real-world progress report that started this', () => {
    // Verbatim shape of an open decision that shipped with no question in it.
    const res = checkDecisionShape(
      'Round 5 delivered: 133 candidates ranked, and the shortlist collapses to two veins. Still open, still #3 on the status page.',
    );
    expect(res.ok).toBe(false);
    expect(res.gaps).toContain('question');
  });

  it('accepts a one-line question — filing a quick decision is not a chore', () => {
    const res = checkDecisionShape('Ship the badge in blue or green?');
    expect(res.ok).toBe(true);
  });

  it('reports the advisory gaps on a bare question', () => {
    const res = checkDecisionShape('Blue or green?');
    expect(res.ok).toBe(true);
    expect([...res.gaps].sort()).toEqual(['blocked', 'options', 'stakes']);
  });

  it('reports NO gaps on a fully decision-shaped body', () => {
    const body = [
      'Do we ship the walkthrough behind a flag, or on by default?',
      '',
      'The batch view is the only way to clear six decisions in one sitting, and it',
      'has never been used by anyone but us. A flag buys a week of confidence and',
      'costs a second code path that nobody will remember to delete.',
      '',
      '- **On by default** — the fix lands where it is needed; a bug is visible at once.',
      '- **Behind a flag** — safe, and the flag outlives its usefulness.',
      '',
      'Blocked until this is answered: the board strip and the mobile pass.',
    ].join('\n');
    const res = checkDecisionShape(body);
    expect(res.ok).toBe(true);
    expect(res.gaps).toEqual([]);
  });

  it('counts supplied options as the options half, without a list in the prose', () => {
    const body = [
      'Peal or Deckle?',
      '',
      'Round 5 ranked 133 candidates and the shortlist collapsed to two veins. The',
      'name goes on the plugin, the marketplace entry and the docs, so it is a',
      'one-way door once peers install it.',
      '',
      'Blocked until answered: the public README and the marketplace listing.',
    ].join('\n');
    expect(checkDecisionShape(body).gaps).toEqual(['options']);
    expect(
      checkDecisionShape(body, [
        { label: 'Peal', detail: 'ensemble' },
        { label: 'Deckle', detail: 'object' },
      ]).gaps,
    ).toEqual([]);
  });

  it('does not count ONE option as options — a closed set of one is not a choice', () => {
    const body = 'Peal or Deckle?\n\nBlocked until answered: the README.';
    expect(checkDecisionShape(body, [{ label: 'Peal' }]).gaps).toContain('options');
  });

  it('names the shape in the refusal, so the message lands in an agent context', () => {
    const msg = decisionShapeMessage(checkDecisionShape('a status note with no ask'));
    expect(msg).toContain('question');
    expect(msg.length).toBeGreaterThan(40);
  });
});
