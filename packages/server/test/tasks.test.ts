/**
 * Unit tests for the hub task store (tasks.ts): workspace creation, doc
 * attachment, task creation defaults, the transition gate (dependency
 * blockers, per-edge enforce, evidence flagging), actor attribution via
 * classifyActor, and the debounced sidecar persistence at
 * `<dataDir>/workspaces/<id>.tasks.json`.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHORES_GOAL_ID, TaskStore, isValidRef, refKey, tasksSidecarPath } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const OUTSIDE_PERSON = { id: 'email:jordan1', name: 'Jordan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('TaskStore', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'tasks-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('createWorkspace', () => {
    it('mints a crypto-random unguessable id, never derived from the name', () => {
      const a = store.createWorkspace('search-revamp');
      const b = store.createWorkspace('search-revamp');
      expect(a.id).not.toBe(b.id);
      expect(a.id).not.toContain('search');
      expect(a.id.length).toBeGreaterThanOrEqual(10);
      expect(a.name).toBe('search-revamp');
      expect(a.goal).toBe('');
      expect(a.goals).toEqual([]);
      expect(a.docIds).toEqual([]);
    });

    it('stores the goal when given and stamps goalUpdatedAt', () => {
      const before = Date.now();
      const ws = store.createWorkspace('blog', 'Ship the launch post by Friday.');
      expect(ws.goal).toBe('Ship the launch post by Friday.');
      expect(ws.goalUpdatedAt).toBeGreaterThanOrEqual(before);
      expect(store.getWorkspace(ws.id)?.goal).toBe('Ship the launch post by Friday.');
    });

    it('lists created workspaces', () => {
      const a = store.createWorkspace('one');
      const b = store.createWorkspace('two');
      const ids = store.listWorkspaces().map((w) => w.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
    });
  });

  describe('attachDoc', () => {
    it('links a doc and dedupes repeat attaches', () => {
      const ws = store.createWorkspace('ws');
      expect(store.attachDoc(ws.id, 'plan-doc')).toEqual({ ok: true });
      expect(store.attachDoc(ws.id, 'plan-doc')).toEqual({ ok: true });
      expect(store.getWorkspace(ws.id)?.docIds).toEqual(['plan-doc']);
    });

    it('refuses an unknown workspace', () => {
      const res = store.attachDoc('w-nope', 'plan-doc');
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('workspace-not-found');
    });
  });

  describe('workspaceOfDoc (share-scope membership, §3.12 commit 8)', () => {
    it('resolves an attached doc to its hub workspace', () => {
      const ws = store.createWorkspace('ws');
      store.attachDoc(ws.id, 'plan-doc');
      expect(store.workspaceOfDoc('plan-doc')).toBe(ws.id);
    });

    it('resolves a task body room (task:<id>) to the task’s workspace', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, { title: 'Wire the store' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(store.workspaceOfDoc(`task:${res.task.id}`)).toBe(ws.id);
    });

    it('returns null for an unattached doc, an unknown task body, and the board room itself', () => {
      const ws = store.createWorkspace('ws');
      expect(store.workspaceOfDoc('loose-doc')).toBeNull();
      expect(store.workspaceOfDoc('task:t-ghost')).toBeNull();
      // The ws:<id> room is NOT a member doc — its share allowance is
      // explicit in host-guard, never a resolver side effect (the plan
      // states workspaceOf returns null for it; keep that true).
      expect(store.workspaceOfDoc(`ws:${ws.id}`)).toBeNull();
    });
  });

  describe('createTask', () => {
    it('defaults to Chores, agent assignee, todo status, and an audit-ready shape', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, { title: 'Wire the store' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      const t = res.task;
      expect(t.id.startsWith('t-')).toBe(true);
      expect(t.workspaceId).toBe(ws.id);
      expect(t.goal).toBe(CHORES_GOAL_ID);
      expect(t.assignee).toBe('agent');
      expect(t.status).toBe('todo');
      expect(t.after).toEqual([]);
      expect(t.links).toEqual([]);
      expect(t.transitions).toEqual([]);
      expect(t.order).toBe(1);
    });

    it('appends at the bottom of the goal: order increments per goal', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      const b = store.createTask(ws.id, { title: 'b' });
      if (!a.ok || !b.ok) throw new Error('create failed');
      expect(b.task.order).toBeGreaterThan(a.task.order);
    });

    it('accepts a fractional explicit order (insert between two tasks)', () => {
      const ws = store.createWorkspace('ws');
      store.createTask(ws.id, { title: 'a' });
      store.createTask(ws.id, { title: 'b' });
      const mid = store.createTask(ws.id, { title: 'between', order: 1.5 });
      if (!mid.ok) throw new Error('create failed');
      expect(mid.task.order).toBe(1.5);
    });

    it('carries the caller-supplied fields: quote, needs, links, origin, dueAt', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Pick the palette',
        assignee: 'human',
        needs: 'decision',
        quote: 'which of these two?',
        links: [{ kind: 'doc', docId: 'mockup-doc' }],
        origin: { kind: 'thread', docId: 'mockup-doc', threadId: 'th-1' },
        dueAt: 1770000000000,
        body: 'Which of the two attached palettes? The warmer one costs a contrast pass. Blocked until answered: the mockup.',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.quote).toBe('which of these two?');
      expect(res.task.needs).toBe('decision');
      expect(res.task.links).toEqual([{ kind: 'doc', docId: 'mockup-doc' }]);
      expect(res.task.origin).toEqual({ kind: 'thread', docId: 'mockup-doc', threadId: 'th-1' });
      expect(res.task.dueAt).toBe(1770000000000);
      expect(res.task.body).toContain('Which of the two attached palettes?');
    });

    it("rejects a goal id that isn't chores or in the goal list", () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, { title: 'x', goal: 'g-nope' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-goal');
    });

    it('rejects an `after` edge naming a task that does not exist', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, { title: 'x', after: ['t-ghost'] });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-after');
    });

    it('rejects an unknown workspace', () => {
      const res = store.createTask('w-nope', { title: 'x' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('workspace-not-found');
    });
  });

  describe('listTasks', () => {
    it('filters by status / assignee / needs / goal', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, {
        title: 'a',
        assignee: 'human',
        needs: 'decision',
        body: 'a or b? b costs a migration. Blocked until answered: the PR.',
      });
      store.createTask(ws.id, { title: 'b' });
      if (!a.ok) throw new Error('create failed');
      store.transition(a.task.id, 'in-progress', { actor: PERSON });

      expect(store.listTasks(ws.id)).toHaveLength(2);
      expect(store.listTasks(ws.id, { status: 'in-progress' }).map((t) => t.title)).toEqual(['a']);
      expect(store.listTasks(ws.id, { assignee: 'human' }).map((t) => t.title)).toEqual(['a']);
      expect(store.listTasks(ws.id, { needs: 'decision' }).map((t) => t.title)).toEqual(['a']);
      expect(store.listTasks(ws.id, { goal: CHORES_GOAL_ID })).toHaveLength(2);
    });
  });

  describe('transition gate', () => {
    it('records actor attribution: a person is a person, an agent is an agent', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      const b = store.createTask(ws.id, { title: 'b' });
      if (!a.ok || !b.ok) throw new Error('create failed');

      const r1 = store.transition(a.task.id, 'in-progress', { actor: PERSON });
      const r2 = store.transition(b.task.id, 'in-progress', { actor: AGENT });
      if (!r1.ok || !r2.ok) throw new Error('transition failed');
      expect(r1.task.transitions[0]?.by).toEqual({
        id: 'known-bryan',
        name: 'Bryan',
        kind: 'person',
      });
      expect(r2.task.transitions[0]?.by.kind).toBe('agent');
      // A collaborator acting as themselves is a person too.
      const r3 = store.transition(a.task.id, 'done', { actor: OUTSIDE_PERSON });
      if (!r3.ok) throw new Error('transition failed');
      expect(r3.task.transitions[1]?.by.kind).toBe('person');
    });

    it('appends an audit entry with from/to/ts/note and never rewrites earlier ones', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      if (!a.ok) throw new Error('create failed');
      store.transition(a.task.id, 'in-progress', { actor: AGENT, note: 'starting' });
      const r = store.transition(a.task.id, 'done', { actor: AGENT, note: 'landed' });
      if (!r.ok) throw new Error('transition failed');
      expect(r.task.transitions).toHaveLength(2);
      expect(r.task.transitions[0]).toMatchObject({
        from: 'todo',
        to: 'in-progress',
        note: 'starting',
      });
      expect(r.task.transitions[1]).toMatchObject({ from: 'in-progress', to: 'done' });
      expect(r.task.status).toBe('done');
      expect(r.task.transitions[1]?.ts).toBeGreaterThan(0);
    });

    it('stamps evidence and usage on the transition that carried them', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      if (!a.ok) throw new Error('create failed');
      const r = store.transition(a.task.id, 'done', {
        actor: AGENT,
        evidence: {
          commit: 'abc1234',
          threadRef: { kind: 'thread', docId: 'plan-doc', threadId: 'th-9' },
        },
        usage: { inputTokens: 1200, outputTokens: 300 },
      });
      if (!r.ok) throw new Error('transition failed');
      expect(r.task.transitions[0]?.evidence?.commit).toBe('abc1234');
      expect(r.task.transitions[0]?.evidence?.threadRef).toEqual({
        kind: 'thread',
        docId: 'plan-doc',
        threadId: 'th-9',
      });
      expect(r.task.transitions[0]?.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
      expect(r.unproven).toBe(false);
    });

    it('allows an evidence-less move to done but flags it (never blocks)', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      if (!a.ok) throw new Error('create failed');
      const r = store.transition(a.task.id, 'done', { actor: AGENT });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.unproven).toBe(true);
      expect(r.task.status).toBe('done');
    });

    it('a move back to todo is never flagged as unproven', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      if (!a.ok) throw new Error('create failed');
      store.transition(a.task.id, 'in-progress', { actor: AGENT });
      const r = store.transition(a.task.id, 'todo', { actor: AGENT });
      if (!r.ok) throw new Error('transition failed');
      expect(r.unproven).toBe(false);
    });

    it('returns open after-dependencies as blockers WITHOUT blocking (warn edge)', () => {
      const ws = store.createWorkspace('ws');
      const gate = store.createTask(ws.id, {
        title: 'your go',
        assignee: 'human',
        needs: 'decision',
        body: 'Your go — which of these two? Both land this week; the second costs a migration. Blocked until answered: the PR.',
      });
      if (!gate.ok) throw new Error('create failed');
      const work = store.createTask(ws.id, { title: 'Open the PR', after: [gate.task.id] });
      if (!work.ok) throw new Error('create failed');

      const r = store.transition(work.task.id, 'in-progress', { actor: AGENT });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.task.status).toBe('in-progress');
      expect(r.blockers).toHaveLength(1);
      expect(r.blockers[0]).toMatchObject({
        taskId: gate.task.id,
        title: 'your go',
        needs: 'decision',
        enforce: false,
      });
      expect(r.blockers[0]?.message).toContain(gate.task.id);
      expect(r.blockers[0]?.message).toContain('your go');
    });

    it('an enforce-marked edge refuses outright — and allows once the gate is done', () => {
      const ws = store.createWorkspace('ws');
      const gate = store.createTask(ws.id, {
        title: 'your go',
        assignee: 'human',
        needs: 'decision',
        body: 'Your go — which of these two? Both land this week; the second costs a migration. Blocked until answered: the PR.',
      });
      if (!gate.ok) throw new Error('create failed');
      const work = store.createTask(ws.id, {
        title: 'Open the PR',
        after: [gate.task.id],
        afterEnforce: [gate.task.id],
      });
      if (!work.ok) throw new Error('create failed');

      const refused = store.transition(work.task.id, 'in-progress', { actor: AGENT });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.error).toBe('blocked');
      expect(refused.blockers?.[0]?.enforce).toBe(true);
      // No audit entry, no status change on a refused transition.
      expect(store.getTask(work.task.id)?.status).toBe('todo');
      expect(store.getTask(work.task.id)?.transitions).toHaveLength(0);

      // Positive control: resolve the gating decision, and the same
      // transition goes through — proving the refusal was the edge, not a
      // store that can never transition.
      store.transition(gate.task.id, 'done', { actor: PERSON });
      const allowed = store.transition(work.task.id, 'in-progress', { actor: AGENT });
      expect(allowed.ok).toBe(true);
      if (allowed.ok) expect(allowed.blockers).toHaveLength(0);
    });

    it('going back to todo never consults the dependency gate', () => {
      const ws = store.createWorkspace('ws');
      const gate = store.createTask(ws.id, { title: 'gate' });
      if (!gate.ok) throw new Error('create failed');
      const work = store.createTask(ws.id, {
        title: 'work',
        after: [gate.task.id],
        afterEnforce: [gate.task.id],
      });
      if (!work.ok) throw new Error('create failed');
      // Force it forward first via the gate task, then bring it back.
      store.transition(gate.task.id, 'done', { actor: PERSON });
      store.transition(work.task.id, 'in-progress', { actor: AGENT });
      store.transition(gate.task.id, 'todo', { actor: PERSON }); // gate reopens
      const back = store.transition(work.task.id, 'todo', { actor: AGENT });
      expect(back.ok).toBe(true);
    });

    it('rejects a same-status transition and an unknown status', () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      if (!a.ok) throw new Error('create failed');
      const same = store.transition(a.task.id, 'todo', { actor: AGENT });
      expect(same.ok).toBe(false);
      if (!same.ok) expect(same.error).toBe('same-status');
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed input
      const bad = store.transition(a.task.id, 'held' as any, { actor: AGENT });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toBe('bad-status');
      const missing = store.transition('t-ghost', 'done', { actor: AGENT });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error).toBe('not-found');
    });
  });

  describe('sidecar persistence', () => {
    it('writes <dataDir>/workspaces/<id>.tasks.json on a debounce', async () => {
      const ws = store.createWorkspace('ws', 'The goal.');
      const path = tasksSidecarPath(dataDir, ws.id);
      // Debounced: the write has not landed synchronously…
      // (5ms debounce in this suite; poll briefly rather than assert timing.)
      await new Promise((r) => setTimeout(r, 50));
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      expect(parsed.workspace.id).toBe(ws.id);
      expect(parsed.workspace.goal).toBe('The goal.');
    });

    it('coalesces a burst of changes into one settled file', async () => {
      const ws = store.createWorkspace('ws');
      const a = store.createTask(ws.id, { title: 'a' });
      if (!a.ok) throw new Error('create failed');
      store.transition(a.task.id, 'in-progress', { actor: AGENT });
      store.flush();
      const parsed = JSON.parse(readFileSync(tasksSidecarPath(dataDir, ws.id), 'utf8'));
      expect(parsed.tasks).toHaveLength(1);
      expect(parsed.tasks[0].status).toBe('in-progress');
      expect(parsed.tasks[0].transitions).toHaveLength(1);
    });

    it('a fresh store hydrates workspaces, tasks, and the audit trail from disk', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship it.');
      const a = store.createTask(ws.id, { title: 'a', quote: 'do the thing' });
      if (!a.ok) throw new Error('create failed');
      store.transition(a.task.id, 'done', { actor: PERSON, evidence: { commit: 'abc1234' } });
      store.attachDoc(ws.id, 'plan-doc');
      store.flush();
      store.stop();

      const reborn = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        const w = reborn.getWorkspace(ws.id);
        expect(w?.name).toBe('search-revamp');
        expect(w?.goal).toBe('Ship it.');
        expect(w?.docIds).toEqual(['plan-doc']);
        const t = reborn.getTask(a.task.id);
        expect(t?.status).toBe('done');
        expect(t?.quote).toBe('do the thing');
        expect(t?.transitions[0]?.by.kind).toBe('person');
        expect(t?.transitions[0]?.evidence?.commit).toBe('abc1234');
      } finally {
        reborn.stop();
      }
    });

    it('an unparseable sidecar is skipped, not fatal', () => {
      const ws = store.createWorkspace('good');
      store.flush();
      store.stop();
      const badPath = tasksSidecarPath(dataDir, 'w-corrupt');
      require('node:fs').writeFileSync(badPath, '{nope');
      const reborn = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reborn.getWorkspace(ws.id)?.name).toBe('good');
        expect(reborn.getWorkspace('w-corrupt')).toBeUndefined();
      } finally {
        reborn.stop();
      }
    });
  });
});

describe('Ref: the url kind', () => {
  it('accepts http and https, and nothing else', () => {
    expect(isValidRef({ kind: 'url', url: 'https://example.com/a/pull/7' })).toBe(true);
    expect(isValidRef({ kind: 'url', url: 'http://example.com/dashboard' })).toBe(true);
    // A ref becomes an href in the hub's link chips, so the scheme is the
    // security boundary. `url` is the first kind that can carry one at all —
    // every other kind is an internal id.
    expect(isValidRef({ kind: 'url', url: 'javascript:alert(1)' })).toBe(false);
    expect(isValidRef({ kind: 'url', url: 'data:text/html,<script>x</script>' })).toBe(false);
    expect(isValidRef({ kind: 'url', url: 'file:///etc/passwd' })).toBe(false);
    // Case and whitespace must not be a way around the check.
    expect(isValidRef({ kind: 'url', url: 'JaVaScRiPt:alert(1)' })).toBe(false);
    expect(isValidRef({ kind: 'url', url: '  javascript:alert(1)' })).toBe(false);
    // Not a URL at all.
    expect(isValidRef({ kind: 'url', url: 'example.com' })).toBe(false);
    expect(isValidRef({ kind: 'url', url: '' })).toBe(false);
    expect(isValidRef({ kind: 'url' })).toBe(false);
  });

  it('keys identity on the URL string, so two tasks can share one link', () => {
    const pr = 'https://github.com/example-org/example-repo/pull/1669';
    expect(refKey({ kind: 'url', url: pr })).toBe(refKey({ kind: 'url', url: pr }));
    expect(refKey({ kind: 'url', url: pr })).not.toBe(refKey({ kind: 'url', url: pr + '/files' }));
    // Distinct from every other kind's keyspace.
    expect(refKey({ kind: 'url', url: 'x' })).not.toBe(refKey({ kind: 'doc', docId: 'x' }));
  });

  it('finds every task pointing at the same URL (the "three tasks touch this PR" question)', () => {
    // Own temp dir: this describe sits outside the suite that manages one.
    const dir = mkdtempSync(join(tmpdir(), 'feedback-urlref-'));
    const store = new TaskStore({ dataDir: dir, debounceMs: 5 });
    try {
      const ws = store.createWorkspace('outward');
      const pr = 'https://github.com/example-org/example-repo/pull/1669';
      const a = store.createTask(ws.id, {
        title: 'Land it',
        actor: AGENT,
        links: [{ kind: 'url', url: pr }],
      });
      const b = store.createTask(ws.id, {
        title: 'Review it',
        actor: AGENT,
        links: [{ kind: 'url', url: pr }],
      });
      // Positive control: a task with a DIFFERENT url must not come back, or
      // "both tasks found" would also pass for a matcher that matches all.
      store.createTask(ws.id, {
        title: 'Unrelated',
        actor: AGENT,
        links: [{ kind: 'url', url: 'https://example.com/other' }],
      });
      const found = store.backlinksFor({ kind: 'url', url: pr }).map((t) => t.id);
      if (!a.ok || !b.ok) throw new Error('fixture tasks were not created');
      expect(found.sort()).toEqual([a.task.id, b.task.id].sort());
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The route validates `origin` now, but it did not always, and what it let
  // through was WRITTEN TO DISK — so the malformed refs already out there
  // outlive the fix. `tasksMatching` spans every workspace and is on the
  // doc-open path, so one bad ref anywhere used to throw for everyone.
  it('survives a malformed ref that is already in the store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'feedback-badref-'));
    const store = new TaskStore({ dataDir: dir, debounceMs: 5 });
    try {
      const ws = store.createWorkspace('legacy');
      const pr = 'https://github.com/example-org/example-repo/pull/1669';
      const good = store.createTask(ws.id, {
        title: 'Reachable',
        actor: AGENT,
        links: [{ kind: 'url', url: pr }],
      });
      if (!good.ok) throw new Error('fixture task was not created');

      // Positive control: the query works before the junk lands, so a later
      // empty result can't be mistaken for "the query never worked".
      expect(store.backlinksFor({ kind: 'url', url: pr }).map((t) => t.id)).toEqual([good.task.id]);

      // Exactly the shapes the old cast admitted, planted the way a reload
      // from `<ws>.tasks.json` would produce them.
      const poisoned = store.createTask(ws.id, { title: 'Poisoned', actor: AGENT });
      if (!poisoned.ok) throw new Error('fixture task was not created');
      const stored = poisoned.task as { origin?: unknown; links: unknown[] };
      stored.origin = null;
      stored.links = [null, 'not-a-ref', { kind: 'nope' }];

      expect(() => store.backlinksFor({ kind: 'url', url: pr })).not.toThrow();
      expect(store.backlinksFor({ kind: 'url', url: pr }).map((t) => t.id)).toEqual([good.task.id]);
      expect(() => store.tasksReferencingDoc('any-doc')).not.toThrow();
    } finally {
      store.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
