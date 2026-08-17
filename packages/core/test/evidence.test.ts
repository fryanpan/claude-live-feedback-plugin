/**
 * The one spelling of "does this move have proof".
 *
 * Every case here is stated as a POSITIVE control followed by its absence —
 * the predicate is asked to see proof that IS there before it is trusted to
 * report proof that isn't.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveEvidence,
  evidenceSuperseded,
  hasEvidence,
  isForwardTransition,
  transitionUnproven,
} from '../src/evidence.ts';

describe('hasEvidence', () => {
  it('sees a commit and a threadRef, and refuses the shapes that claim nothing', () => {
    // Positive controls first.
    expect(hasEvidence({ commit: '621f371' })).toBe(true);
    expect(hasEvidence({ threadRef: { kind: 'thread', docId: 'd1', threadId: 't1' } })).toBe(true);
    // …then the absences, which are only meaningful because of them.
    expect(hasEvidence(undefined)).toBe(false);
    expect(hasEvidence({})).toBe(false);
    expect(hasEvidence({ commit: '' })).toBe(false);
    expect(hasEvidence({ commit: '   ' })).toBe(false);
  });
});

describe('isForwardTransition', () => {
  it('is about in-progress and done only — undoing work never owed proof', () => {
    expect(isForwardTransition('in-progress')).toBe(true);
    expect(isForwardTransition('done')).toBe(true);
    expect(isForwardTransition('todo')).toBe(false);
  });
});

describe('transitionUnproven', () => {
  it('flags a forward move with nothing attached, and not a move back to todo', () => {
    expect(transitionUnproven({ to: 'done' })).toBe(true);
    expect(transitionUnproven({ to: 'in-progress' })).toBe(true);
    expect(transitionUnproven({ to: 'todo' })).toBe(false);
  });

  it('clears once an amendment supplies the evidence the row never carried', () => {
    const row = { to: 'done' };
    expect(transitionUnproven(row)).toBe(true); // positive control
    expect(transitionUnproven({ ...row, amendments: [{ evidence: { commit: '621f371' } }] })).toBe(
      false,
    );
  });

  it('is not cleared by an amendment that claims nothing', () => {
    // The blank-answer failure, at the predicate: an amendment carrying an
    // empty evidence object must not count as proof.
    expect(transitionUnproven({ to: 'done', amendments: [{ evidence: {} }] })).toBe(true);
    expect(transitionUnproven({ to: 'done', amendments: [{}] })).toBe(true);
  });
});

describe('evidenceSuperseded', () => {
  it('marks the wrong-sha case, which the unproven flag can never see', () => {
    const wrong = { to: 'done', evidence: { commit: 'b2ba21e' } };
    // The flag says "proven" both before and after the correction — which is
    // exactly why a second predicate has to exist.
    expect(transitionUnproven(wrong)).toBe(false);
    expect(evidenceSuperseded(wrong)).toBe(false);
    const corrected = { ...wrong, amendments: [{ evidence: { commit: '621f371' } }] };
    expect(transitionUnproven(corrected)).toBe(false);
    expect(evidenceSuperseded(corrected)).toBe(true);
  });

  it('is false for a row that never claimed anything — filling a gap is not a correction', () => {
    expect(
      evidenceSuperseded({ to: 'done', amendments: [{ evidence: { commit: 'abc1234' } }] }),
    ).toBe(false);
  });
});

describe('effectiveEvidence', () => {
  it('is the newest amendment that claims something, else the row itself', () => {
    expect(effectiveEvidence({ to: 'done', evidence: { commit: 'aaa' } })).toEqual({
      commit: 'aaa',
    });
    expect(
      effectiveEvidence({
        to: 'done',
        evidence: { commit: 'aaa' },
        amendments: [{ evidence: { commit: 'bbb' } }, { evidence: { commit: 'ccc' } }],
      }),
    ).toEqual({ commit: 'ccc' });
    expect(effectiveEvidence({ to: 'done' })).toBeUndefined();
  });
});
