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
