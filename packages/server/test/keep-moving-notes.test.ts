/**
 * A task's own notes are movement. The stall clock reads the workspace event
 * stream, and `task.noted` is deliberately kept OFF that stream (one frame per
 * turn would wake every attached agent) — so before this, a builder that
 * reported every turn on its row still read as silent. The clock now reads
 * the row's newest note directly, whatever its kind.
 *
 * Positive control: a row quiet by events with a note two minutes ago is not
 * stalled. Negative control: the SAME row with no notes is — so the first
 * assertion cannot pass vacuously.
 *
 * Fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { type TaskRow, classifyOpenTasks } from '../src/keep-moving.ts';
import { NoteAskClassifier } from '../src/note-ask.ts';

const MIN = 60_000;
const now = 1_000 * MIN;
const STALL = 30 * MIN;
const bands = { dispatchable: new Set(['g1']), ownerBand: new Set(['decisions']) };

function quietRow(over: Partial<TaskRow> = {}): TaskRow {
  return {
    id: 't-1',
    title: 'Index the archive',
    status: 'in-progress',
    goal: 'g1',
    createdAt: now - 200 * MIN,
    transitions: [{ ts: now - 200 * MIN, to: 'in-progress' }],
    ownerKind: 'agent',
    ...over,
  };
}

describe('classifyOpenTasks — a note on the row is activity', () => {
  it('negative control: with no notes, a row quiet past the window is stalled', () => {
    const [row] = classifyOpenTasks([quietRow()], [], [], now, STALL, bands);
    expect(row?.bucket).toBe('in-progress');
    expect(row?.stalled).toBe(true);
    expect(row?.sinceActivityMs).toBe(200 * MIN);
  });

  it('a note two minutes ago keeps the same row off the stalled list, and moves its clock', () => {
    const noted = quietRow({
      notes: [
        { ts: now - 150 * MIN, kind: 'turn', text: 'Read the scout digest', agent: 'Beacon Bot' },
        { ts: now - 2 * MIN, kind: 'status', text: 'PR open, CI running', agent: 'Beacon Bot' },
      ],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands);
    expect(row?.stalled).toBe(false);
    expect(row?.sinceActivityMs).toBe(2 * MIN);
  });

  it('every kind counts, and the newest wins whatever the append order', () => {
    for (const kind of ['turn', 'denial', 'status'] as const) {
      const noted = quietRow({
        notes: [
          { ts: now - MIN, kind, text: 'latest', agent: 'Beacon Bot' },
          { ts: now - 100 * MIN, kind, text: 'older', agent: 'Beacon Bot' },
        ],
      });
      const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands);
      expect(row?.stalled, kind).toBe(false);
      expect(row?.sinceActivityMs, kind).toBe(MIN);
    }
  });

  it('a stale note does not rescue a row an event touched more recently, nor vice versa', () => {
    const noted = quietRow({
      notes: [{ ts: now - 100 * MIN, kind: 'turn', text: 'old', agent: 'Beacon Bot' }],
    });
    const [byEvent] = classifyOpenTasks(
      [noted],
      [{ taskId: 't-1', ts: now - 5 * MIN }],
      [],
      now,
      STALL,
      bands,
    );
    expect(byEvent?.sinceActivityMs).toBe(5 * MIN);
    const [byNote] = classifyOpenTasks([noted], [], [], now, STALL, bands);
    expect(byNote?.sinceActivityMs).toBe(100 * MIN);
    expect(byNote?.stalled).toBe(true);
  });
});

/**
 * …and a note that says the agent is WAITING ON A PERSON is the opposite of
 * movement: it is an ask that exists nowhere the person reads. Three rows sat
 * that way for hours on 2026-09-04 while the loop called them ordinary
 * in-progress work, because the note both hid the ask and reset the clock.
 *
 * Every assertion below is paired with the same row read WITHOUT the seam, so
 * none of them can pass because the row was already going to be unfiled.
 *
 * Fixture texts follow the incident's shapes; the vocabulary table itself is
 * `note-ask.test.ts`.
 */
const WAITING_NOTE =
  'Waiting on Bryan: the four factual corrections sit in the doc as accept/reject suggestions, and the voice items above are his to make. Nothing for the agent to do.';
const PARKED_NOTE =
  "A56 std arm is parked on Bryan's (a) build-only / (b) rebuild with the install intent and rerun / (c) harness fix";
const PROGRESS_NOTE = 'All three adversarial-review breaks verified real and fixed.';

/** The prefilter alone — no judge, which is the state a box with no summary
 *  key runs in, and the one this classification must work in. */
function seam(): NoteAskClassifier {
  return new NoteAskClassifier({ personNames: ['Bryan'] });
}

describe('classifyOpenTasks — a note that says the agent is waiting on a person', () => {
  it('negative control: without the seam the same row is ordinary in-progress work', () => {
    const noted = quietRow({
      notes: [{ ts: now - 40 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' }],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands);
    expect(row?.bucket).toBe('in-progress');
    expect(row?.unfiledAsk).toBe(false);
    expect(row?.askedInNoteAt).toBeUndefined();
  });

  it('with the seam, the row is an unfiled ask dated to the note', () => {
    const noted = quietRow({
      notes: [{ ts: now - 40 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' }],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands, undefined, seam());
    expect(row?.bucket).toBe('blocked-on-owner-unfiled');
    expect(row?.unfiledAsk).toBe(true);
    expect(row?.askedInNoteAt).toBe(now - 40 * MIN);
    // The note is still activity — the row is not silent, it is waiting.
    expect(row?.sinceActivityMs).toBe(40 * MIN);
    expect(row?.stalled).toBe(false);
  });

  it('a FILED ask beats the note: a pending review item is the protocol working', () => {
    const noted = quietRow({
      notes: [{ ts: now - 40 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' }],
    });
    const [row] = classifyOpenTasks(
      [noted],
      [],
      [{ taskId: 't-1', askedAt: now - 30 * MIN }],
      now,
      STALL,
      bands,
      undefined,
      seam(),
    );
    expect(row?.bucket).toBe('blocked-on-owner');
    expect(row?.unfiledAsk).toBe(false);
    expect(row?.askedInNoteAt).toBeUndefined();
  });

  it('the NEWEST note decides: a progress note after the ask means the agent moved on', () => {
    const noted = quietRow({
      notes: [
        { ts: now - 40 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' },
        { ts: now - 5 * MIN, kind: 'turn', text: PROGRESS_NOTE, agent: 'Beacon Bot' },
      ],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands, undefined, seam());
    expect(row?.bucket).toBe('in-progress');
    expect(row?.askedInNoteAt).toBeUndefined();
  });

  it('restating the ask does not re-date it — the run is walked back to where it began', () => {
    const noted = quietRow({
      notes: [
        { ts: now - 90 * MIN, kind: 'turn', text: PARKED_NOTE, agent: 'Beacon Bot' },
        { ts: now - 50 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' },
        { ts: now - 2 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' },
      ],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands, undefined, seam());
    expect(row?.askedInNoteAt).toBe(now - 90 * MIN);
    // …and the ordinary activity clock still reads the newest note, so the
    // two numbers stay different things (stall-gate.ts takes the longer).
    expect(row?.sinceActivityMs).toBe(2 * MIN);
  });

  it('a progress note BREAKS the run, so the ask is dated from after it', () => {
    const noted = quietRow({
      notes: [
        { ts: now - 90 * MIN, kind: 'turn', text: PARKED_NOTE, agent: 'Beacon Bot' },
        { ts: now - 60 * MIN, kind: 'turn', text: PROGRESS_NOTE, agent: 'Beacon Bot' },
        { ts: now - 30 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' },
      ],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands, undefined, seam());
    expect(row?.askedInNoteAt).toBe(now - 30 * MIN);
  });

  it('notes are read newest-BY-CLOCK, not newest-appended', () => {
    const noted = quietRow({
      notes: [
        { ts: now - 3 * MIN, kind: 'turn', text: PROGRESS_NOTE, agent: 'Beacon Bot' },
        { ts: now - 45 * MIN, kind: 'turn', text: WAITING_NOTE, agent: 'Beacon Bot' },
      ],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands, undefined, seam());
    expect(row?.bucket).toBe('in-progress');
  });

  it('a row a person already owns is unfiled whatever its notes say', () => {
    const noted = quietRow({
      ownerKind: 'person',
      notes: [{ ts: now - 40 * MIN, kind: 'turn', text: PROGRESS_NOTE, agent: 'Beacon Bot' }],
    });
    const [row] = classifyOpenTasks([noted], [], [], now, STALL, bands, undefined, seam());
    expect(row?.bucket).toBe('blocked-on-owner-unfiled');
    expect(row?.askedInNoteAt).toBeUndefined();
  });
});
