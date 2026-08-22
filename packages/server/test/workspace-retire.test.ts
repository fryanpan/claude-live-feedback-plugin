/**
 * Retiring, un-retiring and renaming a hub board — the store half.
 *
 * The incident this covers (2026-08-19): two boards carried the identical
 * name AND the identical lead agent, with different goal lists. An agent read
 * whichever one it asked for and lost a night's work. Nothing anywhere said
 * the pair existed, and the only removal verb was `deleteWorkspace`, which
 * `rmSync`s the sidecar — so the operator's workaround was to rewrite the
 * north star to a RETIRED banner, which stops nothing.
 *
 * The invariant every test here defends: retiring is REVERSIBLE and destroys
 * nothing. `retiredAt` is a field on the record the sidecar already
 * serializes wholesale — no file is moved, renamed or removed, so un-retiring
 * is a second write of the same field rather than a restore.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type TaskStoreEvent, isRetired } from '../src/tasks.ts';

const ACTOR = { id: 'agent-harbor-relay', name: 'Harbor Relay', kind: 'agent' };

describe('TaskStore retire / un-retire', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-retire-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('a fresh board is not retired', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    expect(isRetired(ws)).toBe(false);
    expect(ws.retiredAt).toBeUndefined();
  });

  it('retire stamps the record and emits workspace.retired_changed', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = store.setWorkspaceRetired(ws.id, true, {
      actor: ACTOR,
      reason: 'superseded by the September board',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.changed).toBe(true);
    expect(isRetired(res.workspace)).toBe(true);
    expect(res.workspace.retiredAt).toBeGreaterThan(0);
    expect(res.workspace.retiredReason).toBe('superseded by the September board');

    const emitted = events.filter((e) => e.type === 'workspace.retired_changed');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      workspaceId: ws.id,
      retired: true,
      reason: 'superseded by the September board',
      actor: { id: ACTOR.id, name: ACTOR.name },
    });
  });

  it('retiring an already-retired board changes nothing and emits nothing', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR });
    const firstAt = store.getWorkspace(ws.id)?.retiredAt;
    events.length = 0;

    const again = store.setWorkspaceRetired(ws.id, true, { actor: ACTOR });
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error('unreachable');
    expect(again.changed).toBe(false);
    expect(store.getWorkspace(ws.id)?.retiredAt).toBe(firstAt as number);
    expect(events.filter((e) => e.type === 'workspace.retired_changed')).toHaveLength(0);
  });

  it('un-retire clears the stamp and the reason', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR, reason: 'stale' });
    const res = store.setWorkspaceRetired(ws.id, false, { actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.changed).toBe(true);
    expect(isRetired(res.workspace)).toBe(false);
    expect(res.workspace.retiredAt).toBeUndefined();
    expect(res.workspace.retiredReason).toBeUndefined();
    expect(res.workspace.retiredBy).toBeUndefined();
  });

  it('refuses an unknown board', () => {
    expect(store.setWorkspaceRetired('w-nope', true, { actor: ACTOR })).toEqual({
      ok: false,
      error: 'workspace-not-found',
    });
  });

  /**
   * The constraint from the ticket, stated as a test: retire must NOT be
   * delete_workspace with a flag. Nothing is removed, so everything the board
   * held is still readable while it is retired.
   */
  it('keeps every task, goal and doc link through a retire / un-retire round trip', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setGoalList(ws.id, [{ title: 'Ship the relay' }], { actor: ACTOR });
    const goalId = store.getWorkspace(ws.id)?.goals[0]?.id ?? '';
    const made = store.createTask(ws.id, {
      title: 'Agent can drain the queue so that the relay keeps up',
      goal: goalId,
      actor: ACTOR,
    });
    expect(made.ok).toBe(true);
    store.attachDoc(ws.id, 'relay-design');

    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR });
    expect(store.listTasks(ws.id)).toHaveLength(1);
    expect(store.getWorkspace(ws.id)?.goals).toHaveLength(1);
    expect(store.getWorkspace(ws.id)?.docIds).toEqual(['relay-design']);

    store.setWorkspaceRetired(ws.id, false, { actor: ACTOR });
    expect(store.listTasks(ws.id)).toHaveLength(1);
    expect(store.getWorkspace(ws.id)?.goals).toHaveLength(1);
    expect(store.getWorkspace(ws.id)?.docIds).toEqual(['relay-design']);
  });

  it('survives a restart — the sidecar carries the retirement', async () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR, reason: 'superseded' });
    store.stop(); // flushes pending writes

    const reopened = new TaskStore({ dataDir, debounceMs: 5 });
    try {
      const hydrated = reopened.getWorkspace(ws.id);
      expect(hydrated).toBeDefined();
      expect(isRetired(hydrated!)).toBe(true);
      expect(hydrated?.retiredReason).toBe('superseded');
    } finally {
      reopened.stop();
    }
  });
});

describe('a retired board stops accepting new work', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-retire-work-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });
  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const newTask = (workspaceId: string) =>
    store.createTask(workspaceId, {
      title: 'Agent can file work so that the board is current',
      actor: ACTOR,
    });

  it('refuses createTask with a message that says what to do instead', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR, reason: 'superseded' });
    const res = newTask(ws.id);
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error).toBe('workspace-retired');
    expect(res.message?.toLowerCase()).toContain('retired');
    // The refusal has to be actionable in an agent's context: it names the
    // board and the way back, or the agent's only move is to give up.
    expect(res.message).toContain('superseded');
  });

  it('accepts work again after un-retiring — the refusal is a state, not a tombstone', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR });
    expect(newTask(ws.id).ok).toBe(false);
    store.setWorkspaceRetired(ws.id, false, { actor: ACTOR });
    expect(newTask(ws.id).ok).toBe(true);
  });

  /**
   * Existing work stays workable on purpose. Freezing transitions too would
   * strand whatever was in flight when somebody retired the board, and the
   * only exit would be un-retiring — which is exactly the ambiguity the
   * feature exists to remove.
   */
  it('still lets an existing task be transitioned', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const made = newTask(ws.id);
    if (!made.ok) throw new Error('setup failed');
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR });
    const moved = store.transition(made.task.id, 'in-progress', { actor: ACTOR });
    expect(moved.ok).toBe(true);
  });
});

describe('TaskStore renameWorkspace', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-rename-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });
  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('renames and emits workspace.renamed carrying the old name', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = store.renameWorkspace(ws.id, 'harbor-relay-september', { actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.changed).toBe(true);
    expect(res.workspace.name).toBe('harbor-relay-september');
    expect(store.getWorkspace(ws.id)?.name).toBe('harbor-relay-september');

    const emitted = events.filter((e) => e.type === 'workspace.renamed');
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      workspaceId: ws.id,
      oldName: 'harbor-relay',
      name: 'harbor-relay-september',
    });
  });

  it('trims, and reports an unchanged name without an event', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = store.renameWorkspace(ws.id, '  harbor-relay  ', { actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.changed).toBe(false);
    expect(events.filter((e) => e.type === 'workspace.renamed')).toHaveLength(0);
  });

  it('refuses an empty name and an unknown board', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const empty = store.renameWorkspace(ws.id, '   ', { actor: ACTOR });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('unreachable');
    expect(empty.error).toBe('empty-name');
    expect(store.getWorkspace(ws.id)?.name).toBe('harbor-relay');

    expect(store.renameWorkspace('w-nope', 'anything', { actor: ACTOR })).toMatchObject({
      ok: false,
      error: 'workspace-not-found',
    });
  });

  /** Renaming INTO a collision is allowed — the operator may be mid-cleanup —
   *  but it is never silent, because a duplicate name is the whole incident. */
  it('reports the live boards that now share the name', () => {
    const a = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const b = store.createWorkspace('september-board', { leadAgentId: ACTOR.id });
    const res = store.renameWorkspace(b.id, 'harbor-relay', { actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.sameName).toEqual([{ workspaceId: a.id, name: 'harbor-relay' }]);
  });

  it('does not count a retired board as a collision', () => {
    const a = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(a.id, true, { actor: ACTOR });
    const b = store.createWorkspace('september-board', { leadAgentId: ACTOR.id });
    const res = store.renameWorkspace(b.id, 'harbor-relay', { actor: ACTOR });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.sameName).toBeUndefined();
  });
});

describe('attach_agent warns about a retired board and a duplicate lead', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'ws-attach-warn-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });
  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const attach = (workspaceId: string, agentId = ACTOR.id) =>
    store.attachAgent(workspaceId, { agentId, runtime: 'claude-code-local' });

  it('tells an attaching agent the board is retired, and why', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(ws.id, true, { actor: ACTOR, reason: 'superseded by September' });
    const res = attach(ws.id);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.retired).toBeDefined();
    expect(res.retired?.reason).toBe('superseded by September');
    expect(res.retired?.since).toBeGreaterThan(0);
    expect(res.retired?.notice.toLowerCase()).toContain('retired');
  });

  it('says nothing about retirement on a live board', () => {
    const ws = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = attach(ws.id);
    if (!res.ok) throw new Error('unreachable');
    expect(res.retired).toBeUndefined();
  });

  /** The incident, reproduced: one agent, two live boards, one name. */
  it('names the other board when this agent leads two with the same name', () => {
    const stale = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const live = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = attach(live.id);
    if (!res.ok) throw new Error('unreachable');
    expect(res.leadNameConflicts).toBeDefined();
    expect(res.leadNameConflicts?.boards).toEqual([
      { workspaceId: stale.id, name: 'harbor-relay' },
    ]);
    expect(res.leadNameConflicts?.notice).toContain('harbor-relay');
  });

  it('matches names case- and whitespace-insensitively', () => {
    const stale = store.createWorkspace('  Harbor-Relay ', { leadAgentId: ACTOR.id });
    const live = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = attach(live.id);
    if (!res.ok) throw new Error('unreachable');
    expect(res.leadNameConflicts?.boards.map((b) => b.workspaceId)).toEqual([stale.id]);
  });

  /** Retiring one of the pair is the FIX, so it has to clear the warning —
   *  otherwise the operator does the right thing and is told nothing changed. */
  it('clears once the other board is retired', () => {
    const stale = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const live = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    store.setWorkspaceRetired(stale.id, true, { actor: ACTOR });
    const res = attach(live.id);
    if (!res.ok) throw new Error('unreachable');
    expect(res.leadNameConflicts).toBeUndefined();
  });

  it('ignores a same-named board led by somebody else', () => {
    store.createWorkspace('harbor-relay', { leadAgentId: 'agent-other-desk' });
    const live = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = attach(live.id);
    if (!res.ok) throw new Error('unreachable');
    expect(res.leadNameConflicts).toBeUndefined();
  });

  it('says nothing to a bystander that does not hold the seat', () => {
    store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const live = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = attach(live.id, 'agent-passing-through');
    if (!res.ok) throw new Error('unreachable');
    expect(res.leadNameConflicts).toBeUndefined();
  });

  it('differently-named boards led by one agent are not a conflict', () => {
    store.createWorkspace('september-board', { leadAgentId: ACTOR.id });
    const live = store.createWorkspace('harbor-relay', { leadAgentId: ACTOR.id });
    const res = attach(live.id);
    if (!res.ok) throw new Error('unreachable');
    expect(res.leadNameConflicts).toBeUndefined();
  });
});
