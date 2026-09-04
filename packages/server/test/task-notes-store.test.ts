/**
 * `TaskNotesStore` driven directly, per testing-standards rule 4.
 *
 * The family's defining property is what it does NOT do: with the single
 * exception of `appendNote`, nothing here emits an event or bumps
 * `updatedAt`, because an observation ABOUT a ticket must not read as
 * progress ON it. That is the property these cases exist to hold — a
 * route-level test cannot see an `updatedAt` that stayed put.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { TASK_NOTES_STORE_CAP } from '@feedback/core/task-wire';
import { TaskNotesStore } from '../src/task-notes.ts';
import { FakeStore, WS, makeTask } from './task-verb-harness.ts';

function store(): { notes: TaskNotesStore; fake: FakeStore } {
  const fake = new FakeStore();
  const notes = new TaskNotesStore({
    getTask: (id) => fake.getTask(id),
    scheduleSave: (id) => fake.scheduleSave(id),
    emit: (e) => fake.emit(e),
  });
  return { notes, fake };
}

describe('TaskNotesStore.appendNote', () => {
  it('pins the note, moves the row clock, and announces it', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1', updatedAt: 1_000 }));

    const res = notes.appendNote('t-1', {
      kind: 'status',
      text: 'halfway',
      agent: 'Builder',
      ts: 2_000,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.notes?.map((n) => n.text)).toEqual(['halfway']);
    expect(res.task.updatedAt).toBeGreaterThan(1_000);
    expect(fake.saved).toEqual([WS]);
    expect(fake.eventsOfType('task.noted')).toHaveLength(1);
  });

  it('carries the session id only when one was given', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    notes.appendNote('t-1', { kind: 'status', text: 'a', agent: 'Builder', ts: 1 });
    notes.appendNote('t-1', {
      kind: 'status',
      text: 'b',
      agent: 'Builder',
      ts: 2,
      sessionId: 's-9',
    });

    const stored = fake.getTask('t-1')?.notes ?? [];
    expect('sessionId' in stored[0]).toBe(false);
    expect(stored[1]?.sessionId).toBe('s-9');
  });

  it('drops the OLDEST notes once the cap is reached', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    for (let i = 0; i < TASK_NOTES_STORE_CAP + 3; i++) {
      notes.appendNote('t-1', { kind: 'status', text: `n${i}`, agent: 'Builder', ts: i });
    }

    const kept = fake.getTask('t-1')?.notes ?? [];
    expect(kept).toHaveLength(TASK_NOTES_STORE_CAP);
    expect(kept[0]?.text).toBe('n3');
    expect(kept.at(-1)?.text).toBe(`n${TASK_NOTES_STORE_CAP + 2}`);
  });

  it('refuses an unknown row without touching the store', () => {
    const { notes, fake } = store();
    expect(notes.appendNote('nope', { kind: 'status', text: 'x', agent: 'A', ts: 1 })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(fake.saved).toEqual([]);
    expect(fake.events).toEqual([]);
  });
});

describe('TaskNotesStore quiet writes', () => {
  it('records an estimate whose provenance still matches the row words', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1', wordsRevision: 4, updatedAt: 1_000 }));

    const res = notes.recordEffortEstimate('t-1', {
      ok: true,
      forWordsRevision: 4,
      hours: 2,
    } as never);

    expect(res.ok).toBe(true);
    expect(fake.getTask('t-1')?.effortEstimate).toBeDefined();
    expect(fake.getTask('t-1')?.updatedAt).toBe(1_000);
    expect(fake.events).toEqual([]);
  });

  it('refuses an estimate that answers older words', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1', wordsRevision: 5 }));

    expect(
      notes.recordEffortEstimate('t-1', { ok: true, forWordsRevision: 4, hours: 2 } as never),
    ).toEqual({ ok: false, error: 'stale' });
    expect(fake.getTask('t-1')?.effortEstimate).toBeUndefined();
  });

  it('refuses an estimate carrying no revision at all', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1', wordsRevision: 5 }));

    expect(notes.recordEffortEstimate('t-1', { ok: true, hours: 2 } as never)).toEqual({
      ok: false,
      error: 'stale',
    });
  });

  it('keeps the latest artifact check and stays off both clocks', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1', updatedAt: 1_000 }));

    notes.recordArtifactCheck('t-1', { verdict: 'pass', links: [] } as never);
    notes.recordArtifactCheck('t-1', { verdict: 'fail', links: [] } as never);

    expect(fake.getTask('t-1')?.artifactCheck).toMatchObject({ verdict: 'fail' });
    expect(fake.getTask('t-1')?.updatedAt).toBe(1_000);
    expect(fake.events).toEqual([]);
  });

  it('folds reading sessions together and ignores an empty payload', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1', updatedAt: 1_000 }));

    notes.recordReadingTime('t-1', 30);
    notes.recordReadingTime('t-1', 12);
    notes.recordReadingTime('t-1', 0);
    notes.recordReadingTime('t-1', Number.NaN);

    expect(fake.getTask('t-1')?.readingTime).toMatchObject({
      totalSeconds: 42,
      sessionCount: 2,
    });
    expect(fake.getTask('t-1')?.updatedAt).toBe(1_000);
  });

  it('replaces the whole reading total on the reconciliation path', () => {
    const { notes, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));
    notes.recordReadingTime('t-1', 30);

    notes.setReadingTime('t-1', { totalSeconds: 500, sessionCount: 9, lastSessionAt: 7 });

    expect(fake.getTask('t-1')?.readingTime).toEqual({
      totalSeconds: 500,
      sessionCount: 9,
      lastSessionAt: 7,
    });
  });

  it('refuses every quiet write on an unknown row', () => {
    const { notes } = store();
    expect(notes.recordArtifactCheck('nope', { verdict: 'pass', links: [] } as never)).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(notes.recordReadingTime('nope', 5)).toEqual({ ok: false, error: 'not-found' });
    expect(
      notes.setReadingTime('nope', { totalSeconds: 1, sessionCount: 1, lastSessionAt: 1 }),
    ).toEqual({ ok: false, error: 'not-found' });
  });
});
