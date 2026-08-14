/**
 * The store half of "Bryan can see everything waiting on him, in priority
 * order, in one place": decision OPTIONS, the decision-shaped body gate, the
 * "tell me more" path that is deliberately not an answer, and the dependency
 * edit that makes urgency derivable at all.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, type TaskStoreEvent } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

/** A body that clears the gate, so a test about something else isn't a test
 *  about the gate. */
const SHAPED = [
  'Do we ship the walkthrough on by default, or behind a flag?',
  '',
  'It is the only way to clear six decisions in one sitting, and nobody outside',
  'this workspace has used it yet. A flag buys confidence and costs a second',
  'code path nobody remembers to delete.',
  '',
  'Blocked until answered: the board strip and the mobile pass.',
].join('\n');

describe('decisions in the task store', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'decisions-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  // ── the decision-shaped body gate ────────────────────────────────────────

  describe('createTask gates a decision on a decision-shaped body', () => {
    it('refuses a decision whose body is a progress report', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'The name',
        assignee: 'human',
        needs: 'decision',
        body: 'Round 5 delivered: 133 candidates ranked. Still open, still #3 on the status page.',
      });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toBe('decision-body-required');
      expect(res.message).toContain('question');
    });

    it('refuses a decision with no body at all', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, { title: 'x', assignee: 'human', needs: 'decision' });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('decision-body-required');
    });

    it('lets a one-line question through, and reports the softer gaps', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Badge colour',
        assignee: 'human',
        needs: 'decision',
        body: 'Blue or green?',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.shapeGaps).toContain('stakes');
      expect(res.shapeGaps).not.toContain('question');
    });

    it('POSITIVE CONTROL: the same bodies on a non-decision task are never gated', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'The name',
        body: 'Round 5 delivered: 133 candidates ranked.',
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.shapeGaps).toBeUndefined();
    });

    it('reports no gaps at all on a fully shaped decision', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Walkthrough rollout',
        assignee: 'human',
        needs: 'decision',
        body: SHAPED,
        options: [{ label: 'On by default' }, { label: 'Behind a flag' }],
      });
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.shapeGaps).toEqual([]);
    });
  });

  // ── options ──────────────────────────────────────────────────────────────

  describe('options', () => {
    it('stores options with generated ids, preserving order and detail', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Walkthrough rollout',
        assignee: 'human',
        needs: 'decision',
        body: SHAPED,
        options: [
          { label: 'On by default', detail: 'lands where it is needed' },
          { label: 'Behind a flag' },
        ],
      });
      if (!res.ok) throw new Error('create failed');
      expect(res.task.options).toHaveLength(2);
      expect(res.task.options?.map((o) => o.label)).toEqual(['On by default', 'Behind a flag']);
      expect(res.task.options?.[0]?.detail).toBe('lands where it is needed');
      const ids = res.task.options?.map((o) => o.id) ?? [];
      expect(new Set(ids).size).toBe(2);
      for (const id of ids) expect(id.length).toBeGreaterThan(0);
    });

    it('refuses options on a task that is not a decision — a shortcut with no answer path', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Open the PR',
        options: [{ label: 'a' }, { label: 'b' }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('options-need-decision');
    });

    it('refuses a blank option label', () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'x',
        assignee: 'human',
        needs: 'decision',
        body: SHAPED,
        options: [{ label: 'ok' }, { label: '   ' }],
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('bad-option');
    });
  });

  // ── answering ────────────────────────────────────────────────────────────

  describe('answerDecision', () => {
    const seed = (options?: Array<{ label: string; detail?: string }>) => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Walkthrough rollout',
        assignee: 'human',
        needs: 'decision',
        body: SHAPED,
        ...(options ? { options } : {}),
      });
      if (!res.ok) throw new Error('create failed');
      return res.task;
    };

    it('still records free text verbatim, with no option involved', () => {
      const task = seed();
      const res = store.answerDecision(task.id, 'neither — ship it to me only', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.answer?.text).toBe('neither — ship it to me only');
      expect(res.task.answer?.optionId).toBeUndefined();
    });

    it('records a picked option as a verbatim answer AND keeps which one', () => {
      const task = seed([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const picked = task.options?.[1];
      if (!picked) throw new Error('no option');
      const res = store.answerDecision(task.id, picked.label, {
        actor: PERSON,
        optionId: picked.id,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.answer?.text).toBe('Behind a flag');
      expect(res.task.answer?.optionId).toBe(picked.id);
    });

    it('refuses an optionId the decision does not carry', () => {
      const task = seed([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const res = store.answerDecision(task.id, 'Behind a flag', {
        actor: PERSON,
        optionId: 'o-ghost',
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-option');
    });

    it('carries the picked option on the decision.answered event', () => {
      const task = seed([{ label: 'On by default' }, { label: 'Behind a flag' }]);
      const picked = task.options?.[0];
      if (!picked) throw new Error('no option');
      const seen: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => seen.push(e));
      store.answerDecision(task.id, picked.label, { actor: PERSON, optionId: picked.id });
      off();
      const ev = seen.find((e) => e.type === 'decision.answered');
      expect(ev).toBeDefined();
      if (ev?.type !== 'decision.answered') return;
      expect(ev.answer).toBe('On by default');
      expect(ev.optionId).toBe(picked.id);
    });
  });

  // ── "tell me more" is not an answer ──────────────────────────────────────

  describe('requestMoreInfo', () => {
    const seed = () => {
      const ws = store.createWorkspace('ws');
      const res = store.createTask(ws.id, {
        title: 'Walkthrough rollout',
        assignee: 'human',
        needs: 'decision',
        body: SHAPED,
      });
      if (!res.ok) throw new Error('create failed');
      return res.task;
    };

    it('records the question and leaves the decision UNANSWERED and open', () => {
      const task = seed();
      // Presence first: a decision with no answer is the state we're asserting
      // the request does not change.
      expect(store.getTask(task.id)?.answer).toBeUndefined();
      const res = store.requestMoreInfo(task.id, 'what breaks if we flag it?', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.infoRequests?.map((r) => r.text)).toEqual(['what breaks if we flag it?']);
      expect(res.task.infoRequests?.[0]?.by).toBe('Bryan');
      expect(res.task.answer).toBeUndefined();
      expect(res.task.status).toBe('todo');
    });

    it('emits decision.info_requested with the verbatim question', () => {
      const task = seed();
      const seen: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => seen.push(e));
      store.requestMoreInfo(task.id, 'what breaks if we flag it?', { actor: PERSON });
      off();
      const ev = seen.find((e) => e.type === 'decision.info_requested');
      expect(ev).toBeDefined();
      if (ev?.type !== 'decision.info_requested') return;
      expect(ev.question).toBe('what breaks if we flag it?');
      expect(ev.taskId).toBe(task.id);
    });

    it('appends rather than replaces', () => {
      const task = seed();
      store.requestMoreInfo(task.id, 'first', { actor: PERSON });
      store.requestMoreInfo(task.id, 'second', { actor: PERSON });
      expect(store.getTask(task.id)?.infoRequests?.map((r) => r.text)).toEqual(['first', 'second']);
    });

    it('refuses on a task that is not a decision', () => {
      const ws = store.createWorkspace('ws');
      const t = store.createTask(ws.id, { title: 'Open the PR' });
      if (!t.ok) throw new Error('create failed');
      const res = store.requestMoreInfo(t.task.id, 'why?', { actor: PERSON });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('not-a-decision');
    });
  });

  // ── dependency editing: the gap that made urgency underivable ────────────

  describe('setDependencies', () => {
    const seedPair = () => {
      const ws = store.createWorkspace('ws');
      const gate = store.createTask(ws.id, {
        title: 'Walkthrough rollout',
        assignee: 'human',
        needs: 'decision',
        body: SHAPED,
      });
      const work = store.createTask(ws.id, { title: 'Open the PR' });
      if (!gate.ok || !work.ok) throw new Error('create failed');
      return { ws, gate: gate.task, work: work.task };
    };

    it('adds an edge to an ALREADY-CREATED task', () => {
      const { gate, work } = seedPair();
      // Presence first: the edge genuinely does not exist yet, which is the
      // state every decision on the real board is in.
      expect(store.getTask(work.id)?.after).toEqual([]);
      const res = store.setDependencies(work.id, { after: [gate.id] }, { actor: AGENT });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.after).toEqual([gate.id]);
      expect(res.changed).toBe(true);
    });

    it('the new edge is LIVE at the transition gate when marked enforce', () => {
      const { gate, work } = seedPair();
      // Presence: unblocked before the edge exists.
      const before = store.transition(work.id, 'in-progress', { actor: AGENT });
      expect(before.ok).toBe(true);
      store.transition(work.id, 'todo', { actor: AGENT });

      store.setDependencies(
        work.id,
        { after: [gate.id], afterEnforce: [gate.id] },
        { actor: AGENT },
      );
      const after = store.transition(work.id, 'in-progress', { actor: AGENT });
      expect(after.ok).toBe(false);
      if (!after.ok) expect(after.error).toBe('blocked');
    });

    it('refuses an unknown dependency, a cross-workspace one, and itself', () => {
      const { gate, work } = seedPair();
      const other = store.createWorkspace('other');
      const foreign = store.createTask(other.id, { title: 'elsewhere' });
      if (!foreign.ok) throw new Error('create failed');

      expect(
        store.setDependencies(work.id, { after: ['t-ghost'] }, { actor: AGENT }),
      ).toMatchObject({ ok: false, error: 'unknown-after' });
      expect(
        store.setDependencies(work.id, { after: [foreign.task.id] }, { actor: AGENT }),
      ).toMatchObject({ ok: false, error: 'unknown-after' });
      expect(store.setDependencies(work.id, { after: [work.id] }, { actor: AGENT })).toMatchObject({
        ok: false,
        error: 'self-dependency',
      });
      // …and none of the refusals wrote anything.
      expect(store.getTask(work.id)?.after).toEqual([]);
      // Positive control: a real edge still lands.
      expect(store.setDependencies(work.id, { after: [gate.id] }, { actor: AGENT }).ok).toBe(true);
    });

    it('refuses an afterEnforce id that is not in after — the old widening trap', () => {
      const { gate, work } = seedPair();
      const res = store.setDependencies(
        work.id,
        { after: [], afterEnforce: [gate.id] },
        {
          actor: AGENT,
        },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error).toBe('unknown-after-enforce');
    });

    it('replaces the whole edge set, so an edge can be REMOVED', () => {
      const { gate, work } = seedPair();
      store.setDependencies(
        work.id,
        { after: [gate.id], afterEnforce: [gate.id] },
        {
          actor: AGENT,
        },
      );
      expect(store.getTask(work.id)?.after).toEqual([gate.id]);
      const res = store.setDependencies(work.id, { after: [] }, { actor: AGENT });
      expect(res.ok).toBe(true);
      expect(store.getTask(work.id)?.after).toEqual([]);
      expect(store.getTask(work.id)?.afterEnforce ?? []).toEqual([]);
    });

    it('reports changed:false for a no-op, so callers can skip a refresh', () => {
      const { gate, work } = seedPair();
      store.setDependencies(work.id, { after: [gate.id] }, { actor: AGENT });
      const again = store.setDependencies(work.id, { after: [gate.id] }, { actor: AGENT });
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.changed).toBe(false);
    });
  });
});
