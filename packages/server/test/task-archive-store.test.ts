/**
 * `TaskArchiveStore` driven directly, per testing-standards rule 4.
 *
 * The project-wide rule this module states is "never hard delete — soft
 * delete", so the cases here are about the properties that make an archive
 * safe to reach for: it is field writes and nothing else, it is idempotent,
 * the band's cascade is exact in both directions, and it frees a dependant
 * on exactly the same terms a close does.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { TaskArchiveStore } from '../src/task-archive.ts';
import { FakeStore, PERSON, WS, makeGoalRow, makeTask } from './task-verb-harness.ts';

function store(): { archive: TaskArchiveStore; fake: FakeStore } {
  const fake = new FakeStore();
  const archive = new TaskArchiveStore({
    state: (id) => fake.state(id),
    getTask: (id) => fake.getTask(id),
    getGoalRow: (id) => fake.getGoalRow(id),
    scheduleSave: (id) => fake.scheduleSave(id),
    emit: (e) => fake.emit(e),
  });
  return { archive, fake };
}

describe('TaskArchiveStore.archiveTask', () => {
  it('stamps the three fields and leaves the row resolvable', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 't-1', title: 'A row' }));

    const res = archive.archiveTask('t-1', { actor: PERSON, reason: '  duplicate  ' });

    expect(res).toMatchObject({ ok: true, changed: true });
    const task = fake.getTask('t-1');
    expect(task?.archivedAt).toBeGreaterThan(0);
    expect(task?.archivedBy).toBe('Bryan');
    expect(task?.archiveReason).toBe('duplicate');
    expect(task?.title).toBe('A row');
    expect(fake.saved).toEqual([WS]);
    expect(fake.eventsOfType('task.archived')[0]).toMatchObject({ taskId: 't-1' });
  });

  it('caps a long reason rather than storing an essay on the chip', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    archive.archiveTask('t-1', { actor: PERSON, reason: 'x'.repeat(400) });

    expect(fake.getTask('t-1')?.archiveReason).toHaveLength(200);
  });

  it('drops an empty reason instead of rendering a blank chip title', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    archive.archiveTask('t-1', { actor: PERSON, reason: '   ' });

    expect(fake.getTask('t-1')?.archiveReason).toBeUndefined();
  });

  it('is idempotent: a re-send writes no second trail line', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    archive.archiveTask('t-1', { actor: PERSON, reason: 'first' });
    const again = archive.archiveTask('t-1', { actor: PERSON, reason: 'second' });

    expect(again).toMatchObject({ ok: true, changed: false });
    expect(fake.getTask('t-1')?.archiveReason).toBe('first');
    expect(fake.eventsOfType('task.archived')).toHaveLength(1);
  });

  it('frees whatever the row was gating, on the same terms a close does', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 'dep' }));
    fake.addTask(makeTask({ id: 'freed', after: ['dep'] }));

    archive.archiveTask('dep', { actor: PERSON });

    expect(fake.eventsOfType('task.unblocked')[0]).toMatchObject({
      taskId: 'freed',
      clearedBy: 'dep',
    });
  });

  it('announces nothing when the archived row was already done', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 'dep', status: 'done' }));
    fake.addTask(makeTask({ id: 'held', after: ['dep'] }));

    archive.archiveTask('dep', { actor: PERSON });

    expect(fake.eventsOfType('task.unblocked')).toEqual([]);
  });

  it('restores by clearing exactly what it wrote', () => {
    const { archive, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));
    archive.archiveTask('t-1', { actor: PERSON, reason: 'later' });

    const res = archive.unarchiveTask('t-1', { actor: PERSON });

    expect(res).toMatchObject({ ok: true, changed: true });
    const task = fake.getTask('t-1');
    expect(task?.archivedAt).toBeUndefined();
    expect(task?.archivedBy).toBeUndefined();
    expect(task?.archiveReason).toBeUndefined();
    expect(fake.eventsOfType('task.restored')[0]).toMatchObject({ reason: 'later' });
    expect(archive.unarchiveTask('t-1', { actor: PERSON })).toMatchObject({ changed: false });
  });

  it('refuses an unknown row on both verbs', () => {
    const { archive } = store();
    expect(archive.archiveTask('nope', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(archive.unarchiveTask('nope', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });
});

describe('TaskArchiveStore goal cascade', () => {
  function band(): { archive: TaskArchiveStore; fake: FakeStore } {
    const { archive, fake } = store();
    fake.addGoalRow(makeGoalRow({ id: 'g-1', title: 'First goal' }));
    fake.addTask(makeTask({ id: 't-b', goal: 'g-1', order: 2 }));
    fake.addTask(makeTask({ id: 't-a', goal: 'g-1', order: 1 }));
    fake.addTask(makeTask({ id: 't-own', goal: 'g-1', order: 3, archivedAt: 5 }));
    fake.addTask(makeTask({ id: 't-elsewhere', goal: 'g-2', order: 1 }));
    return { archive, fake };
  }

  it('predicts the blast radius in board order, off-board rows excluded', () => {
    const { archive } = band();
    expect(archive.goalCascade('g-1')).toEqual({ taskIds: ['t-a', 't-b'] });
    expect(archive.goalCascade('nope')).toEqual({ taskIds: [] });
  });

  it('archives the band and its rows as one batch', () => {
    const { archive, fake } = band();

    const res = archive.archiveGoal('g-1', { actor: PERSON, reason: 'shipped' });

    expect(res).toMatchObject({ ok: true, changed: true, taskIds: ['t-a', 't-b'] });
    expect(fake.getGoalRow('g-1')?.archivedAt).toBeGreaterThan(0);
    expect(fake.getTask('t-a')?.archivedWithGoal).toBe('g-1');
    expect(fake.getTask('t-elsewhere')?.archivedAt).toBeUndefined();

    const archived = fake.eventsOfType('task.archived') as Array<Record<string, unknown>>;
    expect(archived).toHaveLength(3);
    expect(archived[0]).toMatchObject({ kind: 'goal', cascadeTasks: 2 });
    const batchId = archived[0]?.batchId;
    expect(typeof batchId).toBe('string');
    expect(archived.slice(1).every((e) => e.partOf === batchId)).toBe(true);
  });

  it('restores exactly the rows the archive took, and no others', () => {
    const { archive, fake } = band();
    archive.archiveGoal('g-1', { actor: PERSON, reason: 'shipped' });

    const res = archive.unarchiveGoal('g-1', { actor: PERSON });

    expect(res).toMatchObject({ ok: true, changed: true });
    expect((res as { taskIds: string[] }).taskIds.sort()).toEqual(['t-a', 't-b']);
    expect(fake.getTask('t-a')?.archivedAt).toBeUndefined();
    expect(fake.getTask('t-a')?.archivedWithGoal).toBeUndefined();
    // Archived on its own before the band went — it stays where it was put.
    expect(fake.getTask('t-own')?.archivedAt).toBe(5);
  });

  it('leaves a row somebody restored by hand out of the next band restore', () => {
    const { archive } = band();
    archive.archiveGoal('g-1', { actor: PERSON });
    archive.unarchiveTask('t-a', { actor: PERSON });

    const res = archive.unarchiveGoal('g-1', { actor: PERSON });

    expect((res as { taskIds: string[] }).taskIds).toEqual(['t-b']);
  });

  it('is idempotent on both band verbs and refuses an unknown band', () => {
    const { archive } = band();
    archive.archiveGoal('g-1', { actor: PERSON });

    expect(archive.archiveGoal('g-1', { actor: PERSON })).toMatchObject({ changed: false });
    archive.unarchiveGoal('g-1', { actor: PERSON });
    expect(archive.unarchiveGoal('g-1', { actor: PERSON })).toMatchObject({ changed: false });
    expect(archive.archiveGoal('nope', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
  });
});
