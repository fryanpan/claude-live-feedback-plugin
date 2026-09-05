/**
 * The wake path for an ask that lives only in a task note.
 *
 * `keep-moving-notes.test.ts` proves the row is BUCKETED as an unfiled ask.
 * This file proves the two things that decide whether anybody ever hears
 * about it, and both were the actual failure on 2026-09-04:
 *
 *  - **The gate's clock.** Posting a note bumps the row's `updatedAt`, so an
 *    agent restating "waiting on Bryan" every turn holds `sinceActivityMs` at
 *    zero forever. If the unfiled clock read that alone, a row could carry an
 *    unfiled ask for a day and never cross the twenty-minute window.
 *  - **The nudger's memory.** The three rows in the incident were already
 *    remembered under `in-progress`, and a remembered row is not news. A
 *    bucket change is — which is exactly what this fix produces, and what
 *    makes the lead hear about a row it was already told was merely quiet.
 *
 * Fixtures are synthetic and follow the incident's shapes; the repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { NoteAskClassifier } from '../src/note-ask.ts';
import { type EvaluateStallsInput, evaluateStalls } from '../src/stall-gate.ts';
import { STALL_EVENT, StallNudger, type StallSnapshot } from '../src/stall-nudge.ts';

const MIN = 60_000;
const now = 5_000 * MIN;
const QUIET = 20 * MIN;

const WAITING_NOTE =
  'Waiting on Bryan: the four factual corrections sit in the doc as accept/reject suggestions, and the voice items above are his to make. Nothing for the agent to do.';
const PROGRESS_NOTE = 'All three adversarial-review breaks verified real and fixed.';

function input(
  notes: Array<{ ts: number; text: string }>,
  over: Partial<EvaluateStallsInput> = {},
): EvaluateStallsInput {
  const newest = notes.reduce((max, n) => Math.max(max, n.ts), 0);
  return {
    tasks: [
      {
        id: 't-arm',
        title: 'Land the A56 standard arm',
        status: 'in-progress',
        goal: 'g1',
        createdAt: now - 300 * MIN,
        transitions: [{ ts: now - 300 * MIN, to: 'in-progress' }],
        ownerKind: 'agent',
        // What `appendNote` really does: the note's own clock AND the row's
        // `updatedAt`, which is what reaches the gate as an activity tick.
        updatedAt: newest,
        notes: notes.map((n) => ({ ...n, kind: 'turn', agent: 'Beacon Bot' })),
      },
    ],
    events: [{ taskId: 't-arm', ts: newest }],
    reviewItems: [],
    bands: { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) },
    now,
    quietMs: QUIET,
    noteAsk: new NoteAskClassifier({ personNames: ['Bryan'] }),
    ...over,
  };
}

describe('evaluateStalls — an unfiled ask found in a note', () => {
  it('negative control: without the seam the row is merely stalled, which is what the lead was already told', () => {
    const verdict = evaluateStalls(
      input([{ ts: now - 40 * MIN, text: WAITING_NOTE }], { noteAsk: undefined }),
    );
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.stalled.map((r) => r.bucket)).toEqual(['in-progress']);
  });

  it('names the row on the unfiled list, and not on the stalled one', () => {
    const verdict = evaluateStalls(input([{ ts: now - 40 * MIN, text: WAITING_NOTE }]));
    expect(verdict.stalled).toHaveLength(0);
    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-arm']);
    expect(verdict.unfiled[0]?.bucket).toBe('blocked-on-owner-unfiled');
  });

  it('a fresh ask keeps its grace window — the lead may be filing it right now', () => {
    const verdict = evaluateStalls(input([{ ts: now - 2 * MIN, text: WAITING_NOTE }]));
    expect(verdict.unfiled).toHaveLength(0);
    expect(verdict.stalled).toHaveLength(0);
  });

  it('restating the ask every turn no longer holds the clock at zero', () => {
    // Every note is the same ask; the newest landed two minutes ago, so the
    // row's ordinary silence is two minutes and the old rule would never have
    // named it.
    const verdict = evaluateStalls(
      input([
        { ts: now - 90 * MIN, text: WAITING_NOTE },
        { ts: now - 45 * MIN, text: WAITING_NOTE },
        { ts: now - 2 * MIN, text: WAITING_NOTE },
      ]),
    );
    expect(verdict.unfiled.map((r) => r.id)).toEqual(['t-arm']);
    // The reported quiet time stays honest about what it measures: the row
    // was touched two minutes ago. What crossed the gate is the ask's age.
    expect(verdict.unfiled[0]?.quietMs).toBe(2 * MIN);
  });

  it('…and the grace window still applies to a run that only just began', () => {
    // The same shape as the test above — a two-minute-old note — but the run
    // starts there, so this is a young ask and not an old one being restated.
    const verdict = evaluateStalls(
      input([
        { ts: now - 90 * MIN, text: PROGRESS_NOTE },
        { ts: now - 2 * MIN, text: WAITING_NOTE },
      ]),
    );
    expect(verdict.unfiled).toHaveLength(0);
  });
});

/** The nudger half: a board whose only change is the row's bucket. */
function nudgerHarness(boards: () => StallSnapshot[]) {
  const sent: Array<{ agentId: string; frame: { unfiled?: ReadonlyArray<{ id: string }> } }> = [];
  let clock = now;
  const nudger = new StallNudger({
    now: () => clock,
    snapshot: boards,
    canReach: () => true,
    attachedAgents: () => ['agent-lead'],
    send: (_workspaceId, agentId, frame) => {
      sent.push({ agentId, frame });
      return 1;
    },
    sendToFiler: () => 1,
    report: () => {},
  });
  return {
    sent,
    nudger,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function snapshot(over: Partial<StallSnapshot>): StallSnapshot {
  return {
    workspaceId: 'w-atlas',
    leadAgentId: 'agent-lead',
    retired: false,
    stalled: [],
    unfiled: [],
    considered: 6,
    undetermined: [],
    ...over,
  };
}

describe('StallNudger — the same row coming back as an unfiled ask', () => {
  it('wakes the lead again, because the bucket changed even though the row did not', () => {
    const row = { id: 't-arm', title: 'Land the A56 standard arm', quietMs: 40 * MIN };
    let phase: 'stalled' | 'unfiled' = 'stalled';
    const { sent, nudger, advance } = nudgerHarness(() =>
      phase === 'stalled'
        ? [snapshot({ stalled: [{ ...row, bucket: 'in-progress' }] })]
        : [snapshot({ unfiled: [{ ...row, bucket: 'blocked-on-owner-unfiled' }] })],
    );

    // Told once, as a quiet row.
    nudger.tick();
    expect(sent).toHaveLength(1);
    // …and not told again while nothing about it changes. Without this the
    // second wake below would prove nothing.
    advance(5 * MIN);
    nudger.tick();
    expect(sent).toHaveLength(1);

    // Now the note is read for what it says, and the row is an unfiled ask.
    phase = 'unfiled';
    advance(5 * MIN);
    nudger.tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.frame.unfiled?.map((r) => r.id)).toEqual(['t-arm']);
  });
});

describe('the stall event name is unchanged', () => {
  it('an unfiled-from-note wake rides the same frame every lead already reads', () => {
    const { sent, nudger } = nudgerHarness(() => [
      snapshot({
        unfiled: [
          {
            id: 't-arm',
            title: 'Land the A56 standard arm',
            bucket: 'blocked-on-owner-unfiled',
            quietMs: 40 * MIN,
          },
        ],
      }),
    ]);
    nudger.tick();
    expect((sent[0]?.frame as { event?: string }).event).toBe(STALL_EVENT);
  });
});
