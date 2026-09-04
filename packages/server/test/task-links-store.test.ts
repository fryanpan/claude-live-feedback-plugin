/**
 * `TaskLinksStore` driven directly, per testing-standards rule 4 — the
 * `after` edges the gate reads and the cross-references the board draws.
 *
 * The cases are the refusals and the sweeps: an edge that would close a
 * ring, a malformed stored ref that must not take down every doc-open, and
 * the two walks over every workspace's rows (`flagStaleFromDocEdit`,
 * `releasePlanHolds`) whose contract is what they SKIP.
 *
 * All fixtures are synthetic. The repo is public.
 */
import { describe, expect, it } from 'bun:test';
import type { Ref } from '@feedback/core/task-wire';
import { TaskLinksStore } from '../src/task-links.ts';
import { AGENT, FakeStore, PERSON, WS, makeGoalRow, makeTask } from './task-verb-harness.ts';

function store(): { links: TaskLinksStore; fake: FakeStore } {
  const fake = new FakeStore();
  const links = new TaskLinksStore({
    state: (id) => fake.state(id),
    states: () => fake.statesIter(),
    getTask: (id) => fake.getTask(id),
    getGoalRow: (id) => fake.getGoalRow(id),
    scheduleSave: (id) => fake.scheduleSave(id),
    transition: (taskId, to, opts) => fake.transition(taskId, to, opts),
  });
  return { links, fake };
}

const DOC: Ref = { kind: 'doc', docId: 'd-1' };

describe('TaskLinksStore.setDependencies', () => {
  it('replaces the edge set so an edge can be removed', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'a' }));
    fake.addTask(makeTask({ id: 'b' }));
    fake.addTask(makeTask({ id: 't-1', after: ['a', 'b'], afterEnforce: ['a'] }));

    const res = links.setDependencies('t-1', { after: ['b'] }, { actor: PERSON });

    expect(res).toMatchObject({ ok: true, changed: true });
    expect(fake.getTask('t-1')?.after).toEqual(['b']);
    expect(fake.getTask('t-1')?.afterEnforce).toBeUndefined();
    // No store event: §3.6's table has no row for a dependency edit.
    expect(fake.events).toEqual([]);
  });

  it('de-duplicates the incoming edges', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'a' }));
    fake.addTask(makeTask({ id: 't-1' }));

    links.setDependencies('t-1', { after: ['a', 'a'] }, { actor: PERSON });

    expect(fake.getTask('t-1')?.after).toEqual(['a']);
  });

  it('refuses a self-edge, an unknown blocker and an enforce that is not an edge', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'a' }));
    fake.addTask(makeTask({ id: 't-1' }));

    expect(links.setDependencies('t-1', { after: ['t-1'] }, { actor: PERSON })).toEqual({
      ok: false,
      error: 'self-dependency',
    });
    expect(links.setDependencies('t-1', { after: ['ghost'] }, { actor: PERSON })).toEqual({
      ok: false,
      error: 'unknown-after',
    });
    expect(
      links.setDependencies('t-1', { after: ['a'], afterEnforce: ['ghost'] }, { actor: PERSON }),
    ).toEqual({ ok: false, error: 'unknown-after-enforce' });
  });

  it('refuses an edge that would close a ring, and names the ring', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'a', title: 'A', after: ['b'] }));
    fake.addTask(makeTask({ id: 'b', title: 'B', after: ['c'] }));
    fake.addTask(makeTask({ id: 'c', title: 'C' }));

    const res = links.setDependencies('c', { after: ['a'] }, { actor: PERSON });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe('cycle');
    expect((res as { cycle: string[] }).cycle).toEqual(['c', 'a', 'b', 'c']);
    expect((res as { message: string }).message).toContain("'C' waiting on 'A'");
  });

  it('reports an unchanged edge set without writing', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'a' }));
    fake.addTask(makeTask({ id: 't-1', after: ['a'], updatedAt: 1_000 }));

    expect(links.setDependencies('t-1', { after: ['a'] }, { actor: PERSON })).toMatchObject({
      changed: false,
    });
    expect(fake.getTask('t-1')?.updatedAt).toBe(1_000);
    expect(fake.saved).toEqual([]);
  });
});

describe('TaskLinksStore cross-references', () => {
  it('links idempotently and refuses a bad ref or a self-ref', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 't-1' }));

    expect(links.linkRef('t-1', DOC)).toMatchObject({ changed: true });
    expect(links.linkRef('t-1', { kind: 'doc', docId: 'd-1' })).toMatchObject({ changed: false });
    expect(links.linkRef('t-1', { kind: 'url', url: 'javascript:alert(1)' } as Ref)).toEqual({
      ok: false,
      error: 'bad-ref',
    });
    expect(links.linkRef('t-1', { kind: 'task', taskId: 't-1' })).toEqual({
      ok: false,
      error: 'self-ref',
    });
    expect(fake.getTask('t-1')?.links).toHaveLength(1);
  });

  it('unlinks by identity and treats a missing ref as already done', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 't-1', links: [DOC] }));

    expect(links.unlinkRef('t-1', { kind: 'doc', docId: 'd-1' })).toMatchObject({ changed: true });
    expect(links.unlinkRef('t-1', DOC)).toMatchObject({ changed: false });
    expect(fake.getTask('t-1')?.links).toEqual([]);
  });

  it('links a goal row on the same contract', () => {
    const { links, fake } = store();
    fake.addGoalRow(makeGoalRow({ id: 'g-1' }));

    expect(links.linkGoalRef('g-1', DOC)).toMatchObject({ changed: true });
    expect(links.linkGoalRef('g-1', DOC)).toMatchObject({ changed: false });
    expect(links.linkGoalRef('g-1', { kind: 'task', taskId: 'g-1' })).toEqual({
      ok: false,
      error: 'self-ref',
    });
    expect(fake.getGoalRow('g-1')?.links).toHaveLength(1);
  });

  it('finds backlinks through links and through a promotion origin', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'via-links', createdAt: 2, links: [DOC] }));
    fake.addTask(makeTask({ id: 'via-origin', createdAt: 1, origin: DOC }));
    fake.addTask(makeTask({ id: 'unrelated', createdAt: 3 }));

    expect(links.backlinksFor(DOC).map((t) => t.id)).toEqual(['via-origin', 'via-links']);
  });

  it('surfaces a doc through its own threads, and a thread only exactly', () => {
    const { links, fake } = store();
    const thread: Ref = { kind: 'thread', docId: 'd-1', threadId: 'th-1' };
    fake.addTask(makeTask({ id: 'from-thread', origin: thread }));
    fake.addTask(makeTask({ id: 'from-doc', links: [DOC] }));

    expect(
      links
        .tasksReferencingDoc('d-1')
        .map((t) => t.id)
        .sort(),
    ).toEqual(['from-doc', 'from-thread']);
    expect(links.tasksReferencingThread('d-1', 'th-1').map((t) => t.id)).toEqual(['from-thread']);
    expect(links.tasksReferencingThread('d-1', 'th-2')).toEqual([]);
  });

  it('walks past a malformed stored ref instead of throwing', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'junk', origin: null as unknown as Ref }));
    fake.addTask(makeTask({ id: 'good', links: [DOC] }));

    expect(links.tasksReferencingDoc('d-1').map((t) => t.id)).toEqual(['good']);
  });
});

describe('TaskLinksStore doc sweeps', () => {
  it('flags only open rows stamped at an older revision of that doc', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'stale', origin: DOC, originDocRevision: 1 }));
    fake.addTask(makeTask({ id: 'current', origin: DOC, originDocRevision: 7 }));
    fake.addTask(makeTask({ id: 'unstamped', origin: DOC }));
    fake.addTask(makeTask({ id: 'done', origin: DOC, originDocRevision: 1, status: 'done' }));
    fake.addTask(makeTask({ id: 'gone', origin: DOC, originDocRevision: 1, archivedAt: 4 }));
    fake.addTask(
      makeTask({ id: 'other-doc', origin: { kind: 'doc', docId: 'd-2' }, originDocRevision: 1 }),
    );

    const touched = links.flagStaleFromDocEdit(['d-1'], 7);

    expect([...touched]).toEqual([WS]);
    expect(fake.getTask('stale')?.possiblyStale?.docRevision).toBe(7);
    for (const id of ['current', 'unstamped', 'done', 'gone', 'other-doc']) {
      expect(fake.getTask(id)?.possiblyStale).toBeUndefined();
    }
  });

  it('does not re-flag a row already flagged at the same revision', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'stale', origin: DOC, originDocRevision: 1 }));

    links.flagStaleFromDocEdit(['d-1'], 7);
    const first = fake.saved.length;
    links.flagStaleFromDocEdit(['d-1'], 7);

    expect(fake.saved.length).toBe(first);
  });

  it('releases held drafts through the status gate and clears every hold', () => {
    const { links, fake } = store();
    fake.addTask(makeTask({ id: 'held', status: 'triage', planHold: { docId: 'd-1' } }));
    fake.addTask(makeTask({ id: 'moved-on', status: 'in-progress', planHold: { docId: 'd-1' } }));
    fake.addTask(
      makeTask({ id: 'gone', status: 'triage', planHold: { docId: 'd-1' }, archivedAt: 2 }),
    );
    fake.addTask(makeTask({ id: 'other-plan', status: 'triage', planHold: { docId: 'd-9' } }));

    const res = links.releasePlanHolds(['d-1'], AGENT);

    expect(res.released).toEqual(['held']);
    expect([...res.workspaceIds]).toEqual([WS]);
    expect(fake.transitioned).toEqual([{ taskId: 'held', to: 'todo' }]);
    for (const id of ['held', 'moved-on', 'gone']) {
      expect(fake.getTask(id)?.planHold).toBeUndefined();
    }
    expect(fake.getTask('other-plan')?.planHold).toEqual({ docId: 'd-9' });
  });
});
