/**
 * The dependency-state gate: which rows a wake may name, and — the half that
 * is easy to leave out — which rows it could not read at all.
 *
 * The elapsed-time threshold this replaces was measured against real work and
 * could not be tuned into usefulness: on two boards the MEDIAN gap between
 * task-activity events was ~15 minutes, so 72–84% of intervals that ended in
 * done/review/blocked contained a 20-minute silence, and 40% of minutes an
 * agent was provably typing through read as dead. The clock was never the
 * question. Whether the row is HELD is.
 *
 * Most of what is asserted here is therefore silence, and the one test that
 * is not — `a genuinely stalled row still fires` — is what keeps the rest
 * honest. A gate that suppressed everything would pass every other case in
 * this file.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type GateRow, type ReadyGateProbes, evaluateReadyWork } from '../src/ready-gate.ts';

/** An unheld, agent-owned, ready row — the thing a wake exists to name. */
function row(over: Partial<GateRow> = {}): GateRow {
  return {
    id: 't-1',
    title: 'Rank results by recency',
    status: 'todo',
    ready: true,
    inGoalBand: true,
    goalInTriage: false,
    ...over,
  };
}

/** Probes over a world where nothing is held and everything is readable. */
function probes(over: Partial<ReadyGateProbes> = {}): ReadyGateProbes {
  return {
    ownerKind: () => 'agent',
    reviewState: () => ({ open: 0, unreadable: 0 }),
    ...over,
  };
}

describe('the gate keys on dependency state, not on the clock', () => {
  it('names a genuinely stalled row — ready, agent-owned, nothing blocking it', () => {
    // THE POSITIVE CONTROL for this whole file. Every other test asserts that
    // some row is withheld, and a gate that withheld every row would pass all
    // of them. This is the one that fails if the gate over-suppresses.
    const verdict = evaluateReadyWork([row()], probes());

    expect(verdict.ready).toEqual([{ id: 't-1', title: 'Rank results by recency' }]);
    expect(verdict.considered).toBe(1);
    expect(verdict.held).toEqual({});
    expect(verdict.undetermined).toEqual([]);
  });

  it('withholds a row owned by a person — an agent wake unblocks nothing there', () => {
    const verdict = evaluateReadyWork([row()], probes({ ownerKind: () => 'person' }));

    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ 'awaiting-person': 1 });
    // Counted, not dropped: the denominator is what tells a reader that the
    // empty ready list is a board full of held rows rather than an empty one.
    expect(verdict.considered).toBe(1);
  });

  it('withholds a row with an unanswered decision on it', () => {
    // `needs: 'decision'` reaches this gate as an OPEN REVIEW ITEM — the store
    // derives a row from the legacy decision fields at read time, so one probe
    // answers both spellings and they cannot drift apart.
    const verdict = evaluateReadyWork(
      [row()],
      probes({ reviewState: () => ({ open: 1, unreadable: 0 }) }),
    );

    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ 'awaiting-answer': 1 });
  });

  it('withholds a row held by an open enforced dependency', () => {
    const verdict = evaluateReadyWork([row({ ready: false })], probes());

    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ blocked: 1 });
  });

  it('never sees a deliberately-deferred row at all', () => {
    // Parking used to be a hold reason here. It is now a move to `triage`
    // plus a comment, and `buildQueue` — the list this gate is handed — does
    // not list triage rows. So a deferred row is absent from `considered`
    // rather than counted and withheld, and the gate has one fewer state to
    // be wrong about.
    const verdict = evaluateReadyWork([row({ status: 'triage' })], probes());
    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ claimed: 1 });

    // Positive control: the same row in the state a real queue hands over IS
    // ready, so the assertion above is about triage and not about `row()`.
    expect(evaluateReadyWork([row()], probes()).ready).toHaveLength(1);
  });

  it('withholds a claimed row and one owned by nobody at all', () => {
    const verdict = evaluateReadyWork(
      [row({ id: 't-a', status: 'in-progress' }), row({ id: 't-b' })],
      probes({ ownerKind: (id) => (id === 't-b' ? 'unknown' : 'agent') }),
    );

    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ claimed: 1, unowned: 1 });
    expect(verdict.considered).toBe(2);
  });

  it('holds every row for its own reason, and still names the one that is free', () => {
    const verdict = evaluateReadyWork(
      [
        row({ id: 't-person' }),
        row({ id: 't-claimed', status: 'in-progress' }),
        row({ id: 't-open', title: 'Cache the facet counts' }),
      ],
      probes({
        ownerKind: (id) => (id === 't-person' ? 'person' : 'agent'),
        reviewState: () => ({ open: 0, unreadable: 0 }),
      }),
    );

    expect(verdict.ready).toEqual([{ id: 't-open', title: 'Cache the facet counts' }]);
    expect(verdict.considered).toBe(3);
    expect(verdict.held).toEqual({ 'awaiting-person': 1, claimed: 1 });
  });
});

describe('a row it could not read is not a row it found healthy', () => {
  it('withholds a row whose stored review items do not parse, and says so', () => {
    // The trap this exists for: `listReviewItems` drops a corrupted row rather
    // than throwing, so "this ticket has no open question" and "this ticket's
    // questions are unreadable" produced the SAME answer — and the second one
    // silently read as the first. A row nobody can evaluate must not be
    // nudged AND must not be counted healthy.
    const verdict = evaluateReadyWork(
      [row()],
      probes({ reviewState: () => ({ open: 0, unreadable: 2 }) }),
    );

    expect(verdict.ready).toEqual([]);
    // Not in `held`: a hold is a state the gate READ. This is the absence of a
    // reading, and folding it into the healthy pile is the whole failure mode.
    expect(verdict.held).toEqual({});
    expect(verdict.undetermined).toEqual([{ id: 't-1', reason: 'review-items-unreadable' }]);
  });

  it('withholds a row whose owner kind cannot be resolved at all', () => {
    const verdict = evaluateReadyWork(
      [row()],
      probes({
        ownerKind: () => {
          throw new Error('roster unavailable');
        },
      }),
    );

    expect(verdict.ready).toEqual([]);
    expect(verdict.undetermined).toEqual([{ id: 't-1', reason: 'owner-kind-unreadable' }]);
  });

  it('withholds a row whose review state cannot be read at all', () => {
    const verdict = evaluateReadyWork(
      [row()],
      probes({
        reviewState: () => {
          throw new Error('store closed mid-read');
        },
      }),
    );

    expect(verdict.ready).toEqual([]);
    expect(verdict.undetermined).toEqual([{ id: 't-1', reason: 'review-items-unreadable' }]);
  });

  it('keeps naming the rows it CAN read while one of them is unreadable', () => {
    // The positive control for the clause above. "One row is unreadable" must
    // not become "this board reports nothing" — that trades a silent wrong
    // answer for a silent absent one.
    const verdict = evaluateReadyWork(
      [row({ id: 't-bad' }), row({ id: 't-good', title: 'Cache the facet counts' })],
      probes({
        reviewState: (id) =>
          id === 't-bad' ? { open: 0, unreadable: 1 } : { open: 0, unreadable: 0 },
      }),
    );

    expect(verdict.ready).toEqual([{ id: 't-good', title: 'Cache the facet counts' }]);
    expect(verdict.considered).toBe(2);
    expect(verdict.undetermined).toHaveLength(1);
  });

  it('reports a confident hold ahead of an unreadable field on the same row', () => {
    // An out-of-band row whose reviews are corrupt is BACKLOG. The gate read
    // a state that settles the question on its own, so reporting it as
    // unevaluable would manufacture an alarm about a row nobody was going to
    // be woken for.
    const verdict = evaluateReadyWork(
      [row({ inGoalBand: false })],
      probes({ reviewState: () => ({ open: 0, unreadable: 1 }) }),
    );

    expect(verdict.held).toEqual({ backlog: 1 });
    expect(verdict.undetermined).toEqual([]);
  });
});

describe('the verdict states its own denominator', () => {
  it('answers an empty board with zero considered rather than with silence', () => {
    const verdict = evaluateReadyWork([], probes());

    expect(verdict.ready).toEqual([]);
    expect(verdict.considered).toBe(0);
    expect(verdict.held).toEqual({});
    expect(verdict.undetermined).toEqual([]);
  });

  it('keeps the board’s own priority order in the ready list', () => {
    const verdict = evaluateReadyWork(
      [row({ id: 't-first' }), row({ id: 't-second' }), row({ id: 't-third' })],
      probes(),
    );

    expect(verdict.ready.map((r) => r.id)).toEqual(['t-first', 't-second', 't-third']);
  });
});

describe('the backlog band is never dispatched, so it is never a reason to wake', () => {
  // Bryan, 2026-08-22: "above all else go in priority order" — rows whose
  // goal is not on the workspace's ranked goal list (the reserved `chores`
  // id first of all) are formal backlog and are not auto-dispatched. A wake
  // that counts them says "39 ready" over a board whose dispatchable set is
  // zero — measured three times in one hour on a real board.
  it('withholds a backlog row and names the reason', () => {
    const verdict = evaluateReadyWork([row({ inGoalBand: false })], probes());

    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ backlog: 1 });
    expect(verdict.considered).toBe(1);
  });

  it('still names the goal-band row standing next to a wall of backlog', () => {
    // The positive control for this describe: a gate that held everything
    // out-of-band AND in-band would pass the two tests above.
    const verdict = evaluateReadyWork(
      [
        row({ id: 't-b1', inGoalBand: false }),
        row({ id: 't-b2', inGoalBand: false }),
        row({ id: 't-g', title: 'Ship the fix' }),
      ],
      probes(),
    );

    expect(verdict.ready).toEqual([{ id: 't-g', title: 'Ship the fix' }]);
    expect(verdict.held).toEqual({ backlog: 2 });
  });
});

describe('a band still in triage is not dispatched either', () => {
  // The sibling of backlog, one step in: the row IS in a ranked band, but
  // nobody has agreed the band is work yet. Held rather than dropped, so the
  // pass can report it — Bryan asked for these to read as "goal in triage"
  // rather than as a failure, and a row missing from the queue reads as
  // neither.
  it('withholds the row and names the reason', () => {
    const verdict = evaluateReadyWork([row({ goalInTriage: true })], probes());

    expect(verdict.ready).toEqual([]);
    expect(verdict.held).toEqual({ 'goal-triage': 1 });
    // Still counted. "One row held because its band is unagreed" and "nothing
    // on this board" must not reach a reader as the same sentence.
    expect(verdict.considered).toBe(1);
  });

  it('still names a row in an agreed band standing next to one that is not', () => {
    // The positive control: a gate that held every row on a board with any
    // triage band would pass both tests above.
    const verdict = evaluateReadyWork(
      [
        row({ id: 't-t1', goalInTriage: true }),
        row({ id: 't-t2', goalInTriage: true }),
        row({ id: 't-g', title: 'Ship the fix' }),
      ],
      probes(),
    );

    expect(verdict.ready).toEqual([{ id: 't-g', title: 'Ship the fix' }]);
    expect(verdict.held).toEqual({ 'goal-triage': 2 });
  });

  it('reports an out-of-band row as backlog, not goal-triage', () => {
    // The two band verdicts are mutually exclusive, and `backlog` is checked
    // first. A row outside every band has no band to be in triage, so a flag
    // set on it must not change the answer.
    const verdict = evaluateReadyWork([row({ inGoalBand: false, goalInTriage: true })], probes());

    expect(verdict.held).toEqual({ backlog: 1 });
  });
});
