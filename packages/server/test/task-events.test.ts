/**
 * Store-level events + the per-workspace events.jsonl audit log (plan §3.6).
 *
 * Two contracts under test:
 *
 *  - Every store mutation that changes accountable state emits exactly one
 *    typed event (task.created, task.transitioned, task.regrouped,
 *    decision.answered, workspace.goal_updated, workspace.goals_changed) —
 *    and refused mutations emit NOTHING, each such absence proven next to a
 *    presence (a negative test needs a positive control).
 *  - Every emitted event is appended to `<dataDir>/workspaces/<id>.events.jsonl`
 *    at the emit choke point, so the audit log can never disagree with what
 *    subscribers saw.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CHORES_GOAL_ID,
  type GoalListEntry,
  TaskStore,
  type TaskStoreEvent,
  type WorkspaceGoal,
  eventsLogPath,
} from '../src/tasks.ts';
import { type GoalIds, type SeedGoalSpec, seedGoals } from './goal-seed.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

/** The list as a caller submits it: no ids, because a caller cannot choose
 *  one. The board's rows — with the ids the server minted — come back from
 *  `created` / `getWorkspace`, and that is what the assertions compare. */
const GOAL_ENTRIES: GoalListEntry[] = [
  { title: '1. Ship the launch post', subgoals: [{ title: '1.1 QA pass' }] },
  { title: '2. Cut page weight' },
];
const GOAL_SPEC: SeedGoalSpec[] = [
  {
    key: 'launch',
    title: '1. Ship the launch post',
    subgoals: [{ key: 'qa', title: '1.1 QA pass' }],
  },
  { key: 'perf', title: '2. Cut page weight' },
];

function readAudit(dataDir: string, workspaceId: string): Array<Record<string, unknown>> {
  const path = eventsLogPath(dataDir, workspaceId);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('task store events + audit log', () => {
  let dataDir: string;
  let store: TaskStore;
  let events: TaskStoreEvent[];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'task-events-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
    events = [];
    store.onEvent((e) => events.push(e));
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('task.created', () => {
    it('createTask emits task.created carrying the task, goal, and assignee', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const res = store.createTask(ws.id, { title: 'Wire the index' });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(events).toHaveLength(1);
      const e = events[0];
      if (e?.type !== 'task.created') throw new Error(`expected task.created, got ${e?.type}`);
      expect(e.workspaceId).toBe(ws.id);
      expect(e.taskId).toBe(res.task.id);
      expect(e.task.title).toBe('Wire the index');
      expect(e.goal).toBe(CHORES_GOAL_ID);
      expect(e.assignee).toBe('agent');
    });

    it('a refused create (unknown goal) emits nothing', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const bad = store.createTask(ws.id, { title: 'Nope', goal: 'g-missing' });
      expect(bad.ok).toBe(false);
      expect(events).toHaveLength(0);
      // Positive control: the same listener sees a good create.
      const good = store.createTask(ws.id, { title: 'Yep' });
      expect(good.ok).toBe(true);
      expect(events).toHaveLength(1);
    });
  });

  describe('task.transitioned', () => {
    it('a transition emits the from/to, classified actor, evidence, and usage', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const created = store.createTask(ws.id, { title: 'Wire the index' });
      if (!created.ok) throw new Error('create failed');
      events.length = 0;
      const res = store.transition(created.task.id, 'done', {
        actor: AGENT,
        evidence: { commit: 'abc1234' },
        usage: { inputTokens: 1200, outputTokens: 300 },
      });
      expect(res.ok).toBe(true);
      expect(events).toHaveLength(1);
      const e = events[0];
      if (e?.type !== 'task.transitioned')
        throw new Error(`expected task.transitioned, got ${e?.type}`);
      expect(e.taskId).toBe(created.task.id);
      expect(e.from).toBe('todo');
      expect(e.to).toBe('done');
      expect(e.actor.kind).toBe('agent');
      expect(e.evidence?.commit).toBe('abc1234');
      expect(e.usage?.inputTokens).toBe(1200);
      expect(e.unproven).toBe(false);
    });

    it('a refused transition emits nothing (with a positive control)', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const gate = store.createTask(ws.id, {
        title: 'Your go?',
        assignee: 'human',
        needs: 'decision',
        body: 'Your go — which of these two? Both land this week; the second costs a migration. Blocked until answered: the PR.',
      });
      if (!gate.ok) throw new Error('create failed');
      const blocked = store.createTask(ws.id, {
        title: 'Open the PR',
        after: [gate.task.id],
        afterEnforce: [gate.task.id],
      });
      if (!blocked.ok) throw new Error('create failed');
      events.length = 0;
      const refused = store.transition(blocked.task.id, 'in-progress', { actor: AGENT });
      expect(refused.ok).toBe(false);
      expect(events).toHaveLength(0);
      // Positive control: the gating task itself transitions fine.
      const okRes = store.transition(gate.task.id, 'done', { actor: PERSON });
      expect(okRes.ok).toBe(true);
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('task.transitioned');
    });
  });

  describe('decision.answered', () => {
    it('records the verbatim answer and emits it with actor and links', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const created = store.createTask(ws.id, {
        title: 'Expand the budget?',
        assignee: 'human',
        needs: 'decision',
        body: 'Expand the budget, or cut the scope? Expanding costs $40/mo forever. Blocked until answered: the summaries rollout.',
        links: [{ kind: 'doc', docId: 'plan-doc' }],
      });
      if (!created.ok) throw new Error('create failed');
      events.length = 0;
      const res = store.answerDecision(created.task.id, 'Yes — cap it at $40.', { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.task.answer?.text).toBe('Yes — cap it at $40.');
      expect(res.task.answer?.by).toBe('Bryan');
      expect(events).toHaveLength(1);
      const e = events[0];
      if (e?.type !== 'decision.answered')
        throw new Error(`expected decision.answered, got ${e?.type}`);
      expect(e.answer).toBe('Yes — cap it at $40.');
      expect(e.actor.kind).toBe('person');
      // The decision task's links ride along — a ready-made propagation checklist.
      expect(e.links).toEqual([{ kind: 'doc', docId: 'plan-doc' }]);
    });

    it('refuses a non-decision task and an unknown task, emitting nothing', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const created = store.createTask(ws.id, { title: 'Plain task' });
      if (!created.ok) throw new Error('create failed');
      events.length = 0;
      const notDecision = store.answerDecision(created.task.id, 'answer', { actor: PERSON });
      expect(notDecision.ok).toBe(false);
      if (!notDecision.ok) expect(notDecision.error).toBe('not-a-decision');
      const missing = store.answerDecision('t-nope', 'answer', { actor: PERSON });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error).toBe('not-found');
      expect(events).toHaveLength(0);
    });
  });

  describe('setGoalList (workspace.goals_changed)', () => {
    /** Seed the file's two bands and hand back both the minted ids and the
     *  rows the board now holds — what the old `GOALS` constant was, minus
     *  the pretence that a test could choose the ids. */
    const seedBoard = (workspaceId: string): { G: GoalIds; goals: WorkspaceGoal[] } => ({
      G: seedGoals(store, workspaceId, GOAL_SPEC, PERSON),
      goals: store.getWorkspace(workspaceId)?.goals ?? [],
    });

    it('replaces the ordered list and emits old list, new list, actor, kind', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const res = store.setGoalList(ws.id, GOAL_ENTRIES, { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(true);
      // Every band is new, so every id came back in `created` — parent first,
      // then its subgoal, in submission order.
      expect(res.created.map((c) => c.title)).toEqual([
        '1. Ship the launch post',
        '1.1 QA pass',
        '2. Cut page weight',
      ]);
      const expected: WorkspaceGoal[] = [
        {
          id: res.created[0]?.id as string,
          title: '1. Ship the launch post',
          subgoals: [{ id: res.created[1]?.id as string, title: '1.1 QA pass' }],
        },
        { id: res.created[2]?.id as string, title: '2. Cut page weight' },
      ];
      expect(res.workspace.goals).toEqual(expected);
      expect(events).toHaveLength(1);
      const e = events[0];
      if (e?.type !== 'workspace.goals_changed')
        throw new Error(`expected goals_changed, got ${e?.type}`);
      expect(e.oldGoals).toEqual([]);
      expect(e.newGoals).toEqual(expected);
      expect(e.actor.kind).toBe('person');
      expect(e.kind).toBe('edit');
      // A task can now be created under the new goal id (subgoal too).
      const t = store.createTask(ws.id, { title: 'QA sweep', goal: res.created[1]?.id });
      expect(t.ok).toBe(true);
    });

    it('a pure reorder is kind=reorder; an identical list is changed=false with no event', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const { goals } = seedBoard(ws.id);
      events.length = 0;
      const reordered = [goals[1], goals[0]] as WorkspaceGoal[];
      const res = store.setGoalList(ws.id, reordered, { actor: PERSON });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.changed).toBe(true);
      expect(events).toHaveLength(1);
      const e = events[0];
      if (e?.type !== 'workspace.goals_changed') throw new Error('expected goals_changed');
      expect(e.kind).toBe('reorder');
      // Same list again → no-op, no event.
      events.length = 0;
      const same = store.setGoalList(ws.id, reordered, { actor: PERSON });
      expect(same.ok).toBe(true);
      if (same.ok) expect(same.changed).toBe(false);
      expect(events).toHaveLength(0);
    });

    it('moves OPEN tasks whose goal disappears to Backlog, batched under the goals_changed event; done stays put', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const { G, goals } = seedBoard(ws.id);
      const open = store.createTask(ws.id, { title: 'Trim the bundle', goal: G.perf });
      const closed = store.createTask(ws.id, { title: 'Old perf audit', goal: G.perf });
      if (!open.ok || !closed.ok) throw new Error('create failed');
      store.transition(closed.task.id, 'done', { actor: AGENT, evidence: { commit: 'fff0000' } });
      events.length = 0;
      const res = store.setGoalList(ws.id, [goals[0] as WorkspaceGoal], {
        actor: PERSON,
        drop: [G.perf],
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.movedToChores).toEqual([open.task.id]);
      // The open task moved to the bottom of Backlog; the done one kept its goal.
      expect(store.getTask(open.task.id)?.goal).toBe(CHORES_GOAL_ID);
      expect(store.getTask(closed.task.id)?.goal).toBe(G.perf);
      // One goals_changed event, then one member task.regrouped referencing it.
      expect(events.map((e) => e.type)).toEqual(['workspace.goals_changed', 'task.regrouped']);
      const parent = events[0];
      const member = events[1];
      if (parent?.type !== 'workspace.goals_changed' || member?.type !== 'task.regrouped') {
        throw new Error('wrong event shapes');
      }
      expect(parent.movedToChores).toEqual([open.task.id]);
      expect(member.taskId).toBe(open.task.id);
      expect(member.fromGoal).toBe(G.perf);
      expect(member.toGoal).toBe(CHORES_GOAL_ID);
      expect(member.partOf).toBe(parent.batchId);
    });

    it("refuses the reserved 'chores' id and duplicate ids", () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const reserved = store.setGoalList(ws.id, [{ id: CHORES_GOAL_ID, title: 'Backlog' }], {
        actor: PERSON,
      });
      expect(reserved.ok).toBe(false);
      if (!reserved.ok) expect(reserved.error).toBe('reserved-goal-id');
      const dup = store.setGoalList(
        ws.id,
        [
          { id: 'g-x', title: 'One' },
          { id: 'g-x', title: 'Two' },
        ],
        { actor: PERSON },
      );
      expect(dup.ok).toBe(false);
      if (!dup.ok) expect(dup.error).toBe('duplicate-goal-id');
      expect(events).toHaveLength(0);
    });
  });

  describe('events.jsonl audit log', () => {
    it('appends one line per emitted event, in order, matching what subscribers saw', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const created = store.createTask(ws.id, { title: 'Wire the index' });
      if (!created.ok) throw new Error('create failed');
      store.transition(created.task.id, 'in-progress', { actor: AGENT });
      store.setWorkspaceGoal(ws.id, 'Ship the search, fast.', { actor: PERSON });
      const lines = readAudit(dataDir, ws.id);
      // A goal edit with an open task to re-place writes TWO rows: the edit
      // itself, then the batched re-triage it asks for (the request rides
      // SSE only, so the row is the log's only record that it happened).
      expect(lines.map((l) => l.event)).toEqual([
        'task.created',
        'task.transitioned',
        'workspace.goal_updated',
        'workspace.retriaged',
      ]);
      // The audit line carries the same payload the subscriber saw.
      expect(lines[1]?.taskId).toBe(created.task.id);
      expect(lines[1]?.to).toBe('in-progress');
      expect(events).toHaveLength(4);
    });

    it('a refused mutation appends nothing (the creation lines are the positive control)', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      const created = store.createTask(ws.id, { title: 'Wire the index' });
      if (!created.ok) throw new Error('create failed');
      const before = readAudit(dataDir, ws.id);
      expect(before.length).toBe(1); // positive control: the log records events at all
      const refused = store.transition(created.task.id, 'todo', { actor: AGENT });
      expect(refused.ok).toBe(false); // same-status
      expect(readAudit(dataDir, ws.id).length).toBe(1);
    });

    it('the log is per-workspace and survives a store restart (append, not rewrite)', () => {
      const ws = store.createWorkspace('search-revamp', 'Ship the search.');
      store.createTask(ws.id, { title: 'First' });
      store.flush();
      const second = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        second.createTask(ws.id, { title: 'Second' });
        const lines = readAudit(dataDir, ws.id);
        expect(lines.map((l) => l.event)).toEqual(['task.created', 'task.created']);
      } finally {
        second.stop();
      }
    });
  });
});
