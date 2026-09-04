/**
 * `TaskLifecycleStore` driven directly, per testing-standards rule 4 — the
 * status gate and the two hand-over verbs, without a `TaskStore` under them.
 *
 * The properties here are the ones the gate's contract is stated against and
 * that a route test reaches only incidentally: an enforcing edge refuses
 * while an advisory one reports, a goal's children are ALWAYS advisory, a
 * re-assign is not progress, and `task.unblocked` fires for the transition
 * from waiting-on-something to waiting-on-nothing rather than for every
 * close.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { TaskLifecycleStore, openBlockers } from '../src/task-lifecycle.ts';
import { AGENT, FakeStore, PERSON, WS, makeGoalRow, makeTask } from './task-verb-harness.ts';

function store(): { lifecycle: TaskLifecycleStore; fake: FakeStore } {
  const fake = new FakeStore();
  const lifecycle = new TaskLifecycleStore({
    state: (id) => fake.state(id),
    getTask: (id) => fake.getTask(id),
    getGoalRow: (id) => fake.getGoalRow(id),
    rosterIdFor: (name) => fake.rosterIdFor(name),
    scheduleSave: (id) => fake.scheduleSave(id),
    emit: (e) => fake.emit(e),
  });
  return { lifecycle, fake };
}

describe('openBlockers', () => {
  it('reports open dependencies and skips the ones that cannot gate', () => {
    const fake = new FakeStore();
    fake.addTask(makeTask({ id: 'dep-open', title: 'Open dep' }));
    fake.addTask(makeTask({ id: 'dep-done', status: 'done' }));
    fake.addTask(makeTask({ id: 'dep-archived', archivedAt: 5 }));
    const held = fake.addTask(
      makeTask({ id: 't-1', after: ['dep-open', 'dep-done', 'dep-archived', 'dep-gone'] }),
    );

    const blockers = openBlockers({ getTask: (id) => fake.getTask(id) }, held);

    expect(blockers.map((b) => b.taskId)).toEqual(['dep-open']);
    expect(blockers[0]?.message).toBe("blocked by open task dep-open: 'Open dep'");
    expect(blockers[0]?.enforce).toBe(false);
  });

  it('marks the edges listed in afterEnforce', () => {
    const fake = new FakeStore();
    fake.addTask(makeTask({ id: 'dep', needs: 'decision', title: 'Your go' }));
    const held = fake.addTask(makeTask({ id: 't-1', after: ['dep'], afterEnforce: ['dep'] }));

    const [blocker] = openBlockers({ getTask: (id) => fake.getTask(id) }, held);

    expect(blocker?.enforce).toBe(true);
    expect(blocker?.message).toBe("blocked by open decision dep: 'Your go'");
  });
});

describe('TaskLifecycleStore.transition', () => {
  it('writes the trail entry, moves the row, and announces it', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1', status: 'todo' }));

    const res = lifecycle.transition('t-1', 'in-progress', { actor: PERSON, note: 'starting' });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.status).toBe('in-progress');
    expect(res.task.transitions).toHaveLength(1);
    expect(res.task.transitions[0]).toMatchObject({
      from: 'todo',
      to: 'in-progress',
      note: 'starting',
      by: { id: PERSON.id, kind: 'person' },
    });
    expect(fake.saved).toEqual([WS]);
    expect(fake.eventsOfType('task.transitioned')).toHaveLength(1);
  });

  it('refuses an unknown row, an unknown status and a no-op move', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1', status: 'todo' }));

    expect(lifecycle.transition('nope', 'done', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(lifecycle.transition('t-1', 'sideways' as never, { actor: PERSON })).toEqual({
      ok: false,
      error: 'bad-status',
    });
    const same = lifecycle.transition('t-1', 'todo', { actor: PERSON });
    expect(same.ok).toBe(false);
    if (same.ok) return;
    expect(same.error).toBe('same-status');
    expect(fake.events).toEqual([]);
  });

  it('refuses a forward move held by an enforcing edge, and allows an advisory one', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 'dep', title: 'Blocker' }));
    fake.addTask(makeTask({ id: 't-1', after: ['dep'], afterEnforce: ['dep'] }));
    fake.addTask(makeTask({ id: 't-2', after: ['dep'] }));

    const refused = lifecycle.transition('t-1', 'in-progress', { actor: AGENT });
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error).toBe('blocked');

    const allowed = lifecycle.transition('t-2', 'in-progress', { actor: AGENT });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    expect(allowed.blockers.map((b) => b.taskId)).toEqual(['dep']);
  });

  it('never consults dependencies on a backward move', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 'dep' }));
    fake.addTask(
      makeTask({
        id: 't-1',
        status: 'in-progress',
        after: ['dep'],
        afterEnforce: ['dep'],
      }),
    );

    expect(lifecycle.transition('t-1', 'todo', { actor: PERSON }).ok).toBe(true);
  });

  it('holds a plan draft in triage at every door', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1', status: 'triage', planHold: { docId: 'd-9' } }));

    const res = lifecycle.transition('t-1', 'todo', { actor: PERSON });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('plan-unapproved');
    expect(res.message).toContain('d-9');
  });

  it("reports a goal's open children without ever enforcing them", () => {
    const { lifecycle, fake } = store();
    fake.addGoalRow(makeGoalRow({ id: 'g-1' }));
    fake.addTask(makeTask({ id: 't-open', goal: 'g-1' }));
    fake.addTask(makeTask({ id: 't-done', goal: 'g-1', status: 'done' }));
    fake.addTask(makeTask({ id: 't-gone', goal: 'g-1', archivedAt: 3 }));

    const res = lifecycle.transition('g-1', 'done', { actor: PERSON });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.blockers.map((b) => b.taskId)).toEqual(['t-open']);
    expect(res.blockers.every((b) => b.enforce === false)).toBe(true);
    expect(fake.eventsOfType('task.transitioned')[0]).toMatchObject({ kind: 'goal' });
  });

  it('announces the dependants a close set free, and only those', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 'dep-a' }));
    fake.addTask(makeTask({ id: 'dep-b' }));
    fake.addTask(makeTask({ id: 'freed', after: ['dep-a'] }));
    fake.addTask(makeTask({ id: 'still-held', after: ['dep-a', 'dep-b'] }));
    fake.addTask(makeTask({ id: 'already-done', after: ['dep-a'], status: 'done' }));
    fake.addTask(makeTask({ id: 'archived', after: ['dep-a'], archivedAt: 4 }));

    lifecycle.transition('dep-a', 'done', { actor: PERSON });

    const unblocked = fake.eventsOfType('task.unblocked') as Array<{ taskId: string }>;
    expect(unblocked.map((e) => e.taskId)).toEqual(['freed']);
  });

  it('says nothing when the row was already off the open set', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 'dep', archivedAt: 9 }));
    fake.addTask(makeTask({ id: 'held', after: ['dep'] }));

    lifecycle.transition('dep', 'done', { actor: PERSON });

    expect(fake.eventsOfType('task.unblocked')).toEqual([]);
  });
});

describe('TaskLifecycleStore.setAssignee', () => {
  it('hands the row over without touching status', () => {
    const { lifecycle, fake } = store();
    fake.rosterIds.set('Reviewer', 'a-reviewer');
    fake.addTask(makeTask({ id: 't-1', assignee: 'Builder', status: 'in-progress' }));

    const res = lifecycle.setAssignee('t-1', 'Reviewer', { actor: PERSON });

    expect(res).toMatchObject({ ok: true, changed: true });
    const task = fake.getTask('t-1');
    expect(task?.assignee).toBe('Reviewer');
    expect(task?.assigneeId).toBe('a-reviewer');
    expect(task?.status).toBe('in-progress');
    expect(task?.transitions).toEqual([]);
    expect(fake.eventsOfType('task.assigned')[0]).toMatchObject({
      from: 'Builder',
      to: 'Reviewer',
    });
  });

  it('re-resolves the roster id rather than carrying the old one over', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1', assignee: 'Builder', assigneeId: 'a-builder' }));

    lifecycle.setAssignee('t-1', 'Nobody the roster knows', { actor: PERSON });

    expect(fake.getTask('t-1')?.assigneeId).toBeUndefined();
  });

  it('keeps a declared kind when the same owner is re-stated', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1', assignee: 'Bryan', assigneeKind: 'person' }));

    const res = lifecycle.setAssignee('t-1', 'Bryan', { actor: AGENT });

    expect(res).toMatchObject({ ok: true, changed: false });
    expect(fake.getTask('t-1')?.assigneeKind).toBe('person');
    expect(fake.events).toEqual([]);
  });

  it('treats a kind-only declaration on the same owner as a real change', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1', assignee: 'Bryan' }));

    const res = lifecycle.setAssignee('t-1', 'Bryan', { actor: AGENT, assigneeKind: 'person' });

    expect(res).toMatchObject({ ok: true, changed: true });
    expect(fake.getTask('t-1')?.assigneeKind).toBe('person');
  });
});

describe('TaskLifecycleStore.setDueAt and clearLegacyPark', () => {
  it('sets, clears, and stays silent on a repaint of the same date', () => {
    const { lifecycle, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    expect(lifecycle.setDueAt('t-1', 5_000, { actor: PERSON })).toMatchObject({ changed: true });
    expect(lifecycle.setDueAt('t-1', 5_000, { actor: PERSON })).toMatchObject({ changed: false });
    expect(lifecycle.setDueAt('t-1', null, { actor: PERSON })).toMatchObject({ changed: true });

    expect(fake.getTask('t-1')?.dueAt).toBeUndefined();
    expect(fake.eventsOfType('task.due_set')).toHaveLength(2);
  });

  it('reports exactly the legacy park fields it cleared, and nothing on a clean row', () => {
    const { lifecycle, fake } = store();
    fake.addTask(
      Object.assign(makeTask({ id: 't-parked' }), { parkedUntil: 99, parkedReason: 'waiting' }),
    );
    fake.addTask(makeTask({ id: 't-clean' }));

    expect(lifecycle.clearLegacyPark('t-parked')).toEqual({
      parkedUntil: 99,
      parkedReason: 'waiting',
    });
    expect(lifecycle.clearLegacyPark('t-parked')).toBeNull();
    expect(lifecycle.clearLegacyPark('t-clean')).toBeNull();
    expect(lifecycle.clearLegacyPark('nope')).toBeNull();
  });
});
