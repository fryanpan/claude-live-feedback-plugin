/**
 * Unit tests for the workspace goal field + the triage hook (plan §3.4).
 *
 * Triage EXECUTES in the attached agent, never in the server — the server
 * only EMITS triage requests. Two consequences under test here:
 *
 *  - A task created without an explicit goal lands at the bottom of Backlog,
 *    and its triage-pending marker is stamped ONLY at the moment a request
 *    is actually emitted to a live attachment (the grounded-pending rule:
 *    never promise work that isn't queued). No attachment → no marker.
 *  - Editing the workspace goal emits `workspace.goal_updated` and a
 *    re-triage request covering OPEN tasks only; with no live attachment
 *    the re-triage honestly does not happen.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHORES_GOAL_ID,
  type Task,
  TaskStore,
  type TaskStoreEvent,
  type TriageRequest,
  tasksSidecarPath,
} from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('workspace goal + triage hook', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-triage-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('setWorkspaceGoal', () => {
    it('updates the goal, bumps goalUpdatedAt, and reports changed', () => {
      const ws = store.createWorkspace('blog', 'Old goal.');
      const before = ws.goalUpdatedAt;
      const res = store.setWorkspaceGoal(ws.id, 'Ship the launch post.', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(true);
      expect(res.workspace.goal).toBe('Ship the launch post.');
      expect(res.workspace.goalUpdatedAt).toBeGreaterThanOrEqual(before);
      expect(store.getWorkspace(ws.id)?.goal).toBe('Ship the launch post.');
    });

    it('refuses an unknown workspace', () => {
      const res = store.setWorkspaceGoal('w-nope', 'anything', { actor: PERSON });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('workspace-not-found');
    });

    it('emits workspace.goal_updated with old goal, new goal, and classified actor', () => {
      const ws = store.createWorkspace('blog', 'Old goal.');
      const events: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => events.push(e));
      store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
      off();
      expect(events).toHaveLength(1);
      const e = events[0];
      // Narrow the union — the assertion is the same, the throw carries it.
      if (e?.type !== 'workspace.goal_updated') {
        throw new Error(`expected workspace.goal_updated, got ${e?.type}`);
      }
      expect(e.workspaceId).toBe(ws.id);
      expect(e.oldGoal).toBe('Old goal.');
      expect(e.newGoal).toBe('New goal.');
      expect(e.actor.id).toBe('known-bryan');
      // classifyActor draws the person/agent line — same line as transitions.
      expect(e.actor.kind).toBe('person');
    });

    it('an unsubscribed listener stops receiving events', () => {
      const ws = store.createWorkspace('blog', 'Old goal.');
      const events: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => events.push(e));
      store.setWorkspaceGoal(ws.id, 'First edit.', { actor: PERSON });
      expect(events).toHaveLength(1); // positive control: the listener works
      off();
      store.setWorkspaceGoal(ws.id, 'Second edit.', { actor: PERSON });
      expect(events).toHaveLength(1);
    });

    it('a no-change edit is a no-op: no event, no re-triage, changed=false', () => {
      const ws = store.createWorkspace('blog', 'Same goal.');
      const events: TaskStoreEvent[] = [];
      const requests: TriageRequest[] = [];
      store.onEvent((e) => events.push(e));
      store.setTriageDelivery((req) => {
        requests.push(req);
        return true;
      });
      const res = store.setWorkspaceGoal(ws.id, 'Same goal.', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(false);
      expect(res.retriage.requested).toBe(false);
      expect(events).toHaveLength(0);
      expect(requests).toHaveLength(0);
    });

    it('a goal edit emits one re-triage request covering OPEN tasks only', () => {
      const ws = store.createWorkspace('blog', 'Old goal.');
      const open1 = create(ws.id, 'draft the outline');
      const open2 = create(ws.id, 'collect screenshots');
      const done = create(ws.id, 'pick the topic');
      store.transition(done.id, 'done', { actor: AGENT });

      const requests: TriageRequest[] = [];
      store.setTriageDelivery((req) => {
        requests.push(req);
        return true;
      });
      const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.retriage.requested).toBe(true);
      expect(res.retriage.taskIds.sort()).toEqual([open1.id, open2.id].sort());

      expect(requests).toHaveLength(1);
      const req = requests[0];
      if (!req || req.kind !== 'goal-retriage') throw new Error('expected goal-retriage');
      expect(req.workspaceId).toBe(ws.id);
      expect(req.oldGoal).toBe('Old goal.');
      expect(req.newGoal).toBe('New goal.');
      expect(req.taskIds.sort()).toEqual([open1.id, open2.id].sort());
      expect(req.taskIds).not.toContain(done.id);
      expect(req.actor.kind).toBe('person');
    });

    it('with no live attachment the re-triage honestly does not happen', () => {
      // Positive control for the delivery path is the test above — this one
      // proves the ABSENCE is the no-delivery case, not a broken emitter.
      const ws = store.createWorkspace('blog', 'Old goal.');
      create(ws.id, 'draft the outline');
      const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.retriage.requested).toBe(false);
      // The open tasks are still reported so a caller can say what was NOT
      // re-triaged.
      expect(res.retriage.taskIds).toHaveLength(1);
    });

    it('the goal edit still lands even when the delivery reports no live attachment', () => {
      const ws = store.createWorkspace('blog', 'Old goal.');
      store.setTriageDelivery(() => false);
      const res = store.setWorkspaceGoal(ws.id, 'New goal.', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(true);
      expect(res.retriage.requested).toBe(false);
      expect(store.getWorkspace(ws.id)?.goal).toBe('New goal.');
    });
  });

  describe('createTask triage hook', () => {
    it('an omitted goal lands the task at the bottom of Backlog and emits a triage request; the marker is stamped because the request reached a live attachment', () => {
      const ws = store.createWorkspace('blog', 'Ship the launch post.');
      const placed = create(ws.id, 'already placed', { goal: CHORES_GOAL_ID });

      const requests: TriageRequest[] = [];
      store.setTriageDelivery((req) => {
        requests.push(req);
        return true;
      });
      const res = store.createTask(ws.id, { title: 'figure out og-images' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.goal).toBe(CHORES_GOAL_ID);
      // Bottom of Backlog: below the task that was already there.
      expect(res.task.order).toBeGreaterThan(placed.order);
      expect(res.task.triagePendingTs).toBeGreaterThan(0);

      expect(requests).toHaveLength(1);
      const req = requests[0];
      if (!req || req.kind !== 'task') throw new Error('expected task triage request');
      expect(req.workspaceId).toBe(ws.id);
      expect(req.taskId).toBe(res.task.id);
      // The request carries the goal text the agent triages against.
      expect(req.goal).toBe('Ship the launch post.');
    });

    it('no attachment → no marker; the task simply sits in Backlog', () => {
      // The positive control (marker IS stamped when delivery succeeds) is
      // the test above.
      const ws = store.createWorkspace('blog', 'Ship the launch post.');
      const res = store.createTask(ws.id, { title: 'figure out og-images' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.goal).toBe(CHORES_GOAL_ID);
      expect(res.task.triagePendingTs).toBeUndefined();
    });

    it('a delivery that reports no live attachment stamps no marker', () => {
      const ws = store.createWorkspace('blog');
      store.setTriageDelivery(() => false);
      const res = store.createTask(ws.id, { title: 'untriaged' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.triagePendingTs).toBeUndefined();
    });

    it('a delivery that throws neither breaks task creation nor stamps the marker', () => {
      const ws = store.createWorkspace('blog');
      store.setTriageDelivery(() => {
        throw new Error('attachment channel wedged');
      });
      const res = store.createTask(ws.id, { title: 'untriaged' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.triagePendingTs).toBeUndefined();
    });

    it('an EXPLICIT goal is a placement, not a triage candidate — no request emitted', () => {
      const ws = store.createWorkspace('blog');
      const requests: TriageRequest[] = [];
      store.setTriageDelivery((req) => {
        requests.push(req);
        return true;
      });
      const res = store.createTask(ws.id, { title: 'explicitly chores', goal: CHORES_GOAL_ID });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.triagePendingTs).toBeUndefined();
      // No PLACEMENT ask goes out. A `task-review` delivery is expected —
      // every attributed placed create routes to the lead for a shape pass
      // (see task-shape-review.test.ts) — so filter by kind rather than
      // asserting an empty wire.
      expect(requests.filter((r) => r.kind === 'task')).toHaveLength(0);
    });

    it('the marker persists to the sidecar but is cleared on hydrate — a restart kills the emitted request, so the promise must not outlive it', () => {
      const ws = store.createWorkspace('blog');
      store.setTriageDelivery(() => true);
      const res = store.createTask(ws.id, { title: 'pending at crash time' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      store.flush();

      // Positive control: the stamp really reached disk.
      const raw = JSON.parse(readFileSync(tasksSidecarPath(dataDir, ws.id), 'utf8')) as {
        tasks: Task[];
      };
      const onDisk = raw.tasks.find((t) => t.id === res.task.id);
      expect(onDisk?.triagePendingTs).toBeGreaterThan(0);

      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reloaded.getTask(res.task.id)?.triagePendingTs).toBeUndefined();
      } finally {
        reloaded.stop();
      }
    });
  });

  describe('listUntriaged', () => {
    it('returns open Backlog tasks that no triage has placed, and nothing else', () => {
      const ws = store.createWorkspace('blog');
      const untriaged = create(ws.id, 'sweep me');
      const doneTask = create(ws.id, 'already finished');
      store.transition(doneTask.id, 'done', { actor: AGENT });

      const ids = store.listUntriaged(ws.id).map((t) => t.id);
      expect(ids).toContain(untriaged.id); // positive control
      expect(ids).not.toContain(doneTask.id);
      expect(store.listUntriaged('w-nope')).toEqual([]);
    });
  });

  function create(wsId: string, title: string, opts: { goal?: string } = {}): Task {
    const res = store.createTask(wsId, { title, ...opts });
    if (!res.ok) throw new Error(`createTask failed: ${res.error}`);
    return res.task;
  }
});
