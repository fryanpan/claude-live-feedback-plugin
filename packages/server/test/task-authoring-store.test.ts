/**
 * `TaskAuthoringStore` driven directly, per testing-standards rule 4 —
 * creating a row and writing its words.
 *
 * The cases centre on the two choke points this family exists to keep
 * single: `applyTitle`, which every door into a title converges on, and the
 * body snapshot, where a row's original words are preserved exactly once.
 * Both are reachable only through the verbs, so they are driven that way.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import { TaskAuthoringStore } from '../src/task-authoring.ts';
import { AGENT, FakeStore, PERSON, WS, makeTask, makeWorkspace } from './task-verb-harness.ts';

function store(fake = new FakeStore()): { authoring: TaskAuthoringStore; fake: FakeStore } {
  const authoring = new TaskAuthoringStore({
    state: (id) => fake.state(id),
    getTask: (id) => fake.getTask(id),
    goalIdExists: (ws, goalId) => fake.goalIdExists(ws, goalId),
    rosterIdFor: (name) => fake.rosterIdFor(name),
    docRevisionFor: (docId) => fake.docRevisionFor(docId),
    registerTask: (taskId, wsId) => fake.registerTask(taskId, wsId),
    scheduleSave: (id) => fake.scheduleSave(id),
    emit: (e) => fake.emit(e),
  });
  return { authoring, fake };
}

describe('TaskAuthoringStore.createTask', () => {
  it('files the row, indexes it, and announces it', () => {
    const { authoring, fake } = store();
    fake.rosterIds.set('Builder', 'a-builder');

    const res = authoring.createTask(WS, {
      title: 'Do the thing',
      goal: 'g-1',
      assignee: 'Builder',
      actor: PERSON,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.title).toBe('Do the thing');
    expect(res.task.assigneeId).toBe('a-builder');
    expect(res.task.createdBy).toBe('Bryan');
    expect(res.placement).toEqual({ placed: true });
    expect(fake.state(WS)?.tasks.get(res.task.id)).toBe(res.task);
    expect(fake.index.get(res.task.id)).toBe(WS);
    expect(fake.eventsOfType('task.created')).toHaveLength(1);
  });

  it('lands an agent-filed row in triage and a person-filed row in todo', () => {
    const { authoring } = store();

    const byAgent = authoring.createTask(WS, { title: 'A', goal: 'g-1', actor: AGENT });
    const byPerson = authoring.createTask(WS, { title: 'B', goal: 'g-1', actor: PERSON });

    expect(byAgent.ok && byAgent.task.status).toBe('triage');
    expect(byPerson.ok && byPerson.task.status).toBe('todo');
  });

  it('holds a plan draft in triage whoever filed it', () => {
    const { authoring } = store();

    const res = authoring.createTask(WS, {
      title: 'Draft',
      goal: 'g-1',
      actor: PERSON,
      planHold: { docId: 'd-1' },
    });

    expect(res.ok && res.task.status).toBe('triage');
  });

  it('records that an omitted goal still needs placing', () => {
    const { authoring, fake } = store(
      new FakeStore(makeWorkspace({ goals: [{ id: 'g-1', title: 'First goal' }] })),
    );

    const res = authoring.createTask(WS, { title: 'Unplaced', actor: PERSON });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.placement).toEqual({ placed: false });
    expect(res.task.unplacedSince).toBeGreaterThan(0);
    expect(fake.state(WS)?.tasks.get(res.task.id)?.goal).toBe('chores');
  });

  it('refuses a retired board before it complains about anything else', () => {
    const { authoring } = store(
      new FakeStore(makeWorkspace({ retiredAt: 1, retiredReason: 'moved to the new board' })),
    );

    const res = authoring.createTask(WS, { title: 'A', goal: 'nonsense', actor: PERSON });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('workspace-retired');
    expect(res.message).toContain('moved to the new board');
  });

  it('refuses an unknown board, an unknown goal and a dangling after edge', () => {
    const { authoring } = store();

    expect(authoring.createTask('ws-nope', { title: 'A', actor: PERSON })).toEqual({
      ok: false,
      error: 'workspace-not-found',
    });
    expect(authoring.createTask(WS, { title: 'A', goal: 'g-9', actor: PERSON })).toEqual({
      ok: false,
      error: 'unknown-goal',
    });
    expect(
      authoring.createTask(WS, { title: 'A', goal: 'g-1', after: ['ghost'], actor: PERSON }),
    ).toEqual({ ok: false, error: 'unknown-after' });
  });

  it('de-duplicates after edges and requires enforce to name one of them', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 'dep' }));

    const res = authoring.createTask(WS, {
      title: 'A',
      goal: 'g-1',
      after: ['dep', 'dep'],
      actor: PERSON,
    });
    expect(res.ok && res.task.after).toEqual(['dep']);

    expect(
      authoring.createTask(WS, {
        title: 'B',
        goal: 'g-1',
        after: ['dep'],
        afterEnforce: ['other'],
        actor: PERSON,
      }),
    ).toEqual({ ok: false, error: 'unknown-after-enforce' });
  });

  it('refuses options outside a decision, and a decision with no question', () => {
    const { authoring } = store();

    expect(
      authoring.createTask(WS, {
        title: 'A',
        goal: 'g-1',
        options: [{ label: 'yes' }],
        actor: PERSON,
      }),
    ).toEqual({ ok: false, error: 'options-need-decision' });

    const noBody = authoring.createTask(WS, {
      title: 'Which way?',
      goal: 'g-1',
      needs: 'decision',
      actor: PERSON,
    });
    expect(noBody.ok).toBe(false);
    if (noBody.ok) return;
    expect(noBody.error).toBe('decision-body-required');
  });

  it('mints an id for every option label and trims it', () => {
    const { authoring } = store();

    const res = authoring.createTask(WS, {
      title: 'Which way?',
      goal: 'g-1',
      needs: 'decision',
      body: 'Do we go left or right, and why does it matter for the release?',
      options: [{ label: '  left  ' }, { label: 'right', detail: 'slower' }],
      actor: PERSON,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.task.options?.map((o) => o.label)).toEqual(['left', 'right']);
    expect(new Set(res.task.options?.map((o) => o.id)).size).toBe(2);
  });

  it('stamps the origin doc revision the reader settled on', () => {
    const { authoring, fake } = store();
    fake.docRevisions.set('d-1', 12);

    const res = authoring.createTask(WS, {
      title: 'From a plan',
      goal: 'g-1',
      origin: { kind: 'doc', docId: 'd-1' },
      actor: PERSON,
    });

    expect(res.ok && res.task.originDocRevision).toBe(12);
  });
});

describe('TaskAuthoringStore title and body writes', () => {
  it('renames, stamps the naming marks, and carries both ends in the event', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 't-1', title: 'Old name' }));

    const res = authoring.renameTask('t-1', 'New name', { actor: PERSON, reason: 'clearer' });

    expect(res).toMatchObject({ ok: true, changed: true });
    const task = fake.getTask('t-1');
    expect(task?.title).toBe('New name');
    expect(task?.titleWrittenAt).toBeGreaterThan(0);
    expect(fake.eventsOfType('task.retitled')[0]).toMatchObject({
      titleFrom: 'Old name',
      titleTo: 'New name',
      reason: 'clearer',
    });
  });

  it('treats a same-text rename as a no-op, unless the row was never named', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 'named', title: 'Same' }));
    fake.addTask(makeTask({ id: 'unnamed', title: 'Untitled task', untitled: true }));

    expect(authoring.renameTask('named', 'Same', { actor: PERSON })).toMatchObject({
      changed: false,
    });
    expect(authoring.renameTask('unnamed', 'Untitled task', { actor: PERSON })).toMatchObject({
      changed: true,
    });
    // The flag cleared, so the rename box is usable again — but the title
    // itself did not move, so there is nothing to retitle in the feed.
    expect(fake.getTask('unnamed')?.untitled).toBeUndefined();
    expect(fake.eventsOfType('task.retitled')).toEqual([]);
  });

  it('records a body edit, and retitles in the same act when asked', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 't-1', title: 'Fragment' }));

    expect(authoring.noteBodyEdited('t-1', { actor: PERSON, title: '  Shaped  ' })).toBe(true);

    const task = fake.getTask('t-1');
    expect(task?.title).toBe('Shaped');
    expect(task?.bodyWrittenAt).toBeGreaterThan(0);
    expect(fake.eventsOfType('task.body_edited')[0]).toMatchObject({
      titleFrom: 'Fragment',
      titleTo: 'Shaped',
    });
  });

  it('leaves the title alone when the body edit names none', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 't-1', title: 'Kept' }));

    authoring.noteBodyEdited('t-1', { actor: PERSON });

    expect(fake.getTask('t-1')?.title).toBe('Kept');
    expect(fake.eventsOfType('task.body_edited')[0]).not.toHaveProperty('titleFrom');
  });

  it('preserves the row original words exactly once, on the first real rewrite', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 't-1', body: 'what they actually said', updatedAt: 1_000 }));

    authoring.updateBodySnapshot('t-1', 'a tidy restatement');
    authoring.updateBodySnapshot('t-1', 'a second restatement');

    const task = fake.getTask('t-1');
    expect(task?.quote).toBe('what they actually said');
    expect(task?.body).toBe('a second restatement');
    // Body typing is content activity; the live doc room announces it.
    expect(task?.updatedAt).toBe(1_000);
    expect(fake.events).toEqual([]);
  });

  it('preserves nothing on a no-op flush, and falls back to the title with no body', () => {
    const { authoring, fake } = store();
    fake.addTask(makeTask({ id: 'seeded', body: 'same' }));
    fake.addTask(makeTask({ id: 'bodyless', title: 'Just a title' }));

    authoring.updateBodySnapshot('seeded', 'same');
    authoring.updateBodySnapshot('bodyless', 'now it has a body');

    expect(fake.getTask('seeded')?.quote).toBeUndefined();
    expect(fake.getTask('bodyless')?.quote).toBe('Just a title');
  });

  it('clears the stale flag and re-stamps the revision it was flagged against', () => {
    const { authoring, fake } = store();
    fake.addTask(
      makeTask({
        id: 't-1',
        body: 'old',
        originDocRevision: 1,
        possiblyStale: { docRevision: 9, ts: 5 },
      }),
    );

    authoring.updateBodySnapshot('t-1', 'reconciled');

    const task = fake.getTask('t-1');
    expect(task?.possiblyStale).toBeUndefined();
    expect(task?.originDocRevision).toBe(9);
  });

  it('reports an unknown row on every word-writing verb', () => {
    const { authoring } = store();
    expect(authoring.renameTask('nope', 'X', { actor: PERSON })).toEqual({
      ok: false,
      error: 'not-found',
    });
    expect(authoring.noteBodyEdited('nope', { actor: PERSON })).toBe(false);
    expect(authoring.updateBodySnapshot('nope', 'x')).toBe(false);
  });
});
