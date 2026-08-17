/**
 * Attaching evidence to a transition that already happened.
 *
 * Two failures, both observed in the field, both repaired here:
 *
 *  - the `evidence` object was DROPPED on the caller's side, so the move
 *    landed `unproven` and the board shaded work that was in fact finished;
 *  - the evidence ARRIVED AND WAS WRONG — a commit sha written from memory
 *    that resolves to nothing — which reads as proof and is strictly worse.
 *
 * `same-status` was the only answer to both, so a finished task stayed
 * permanently mis-marked. The amend path appends a correction rather than
 * rewriting the row: the original keeps saying what it said, and the fix is a
 * new attributed, timestamped fact next to it.
 *
 * The wrong-sha case is asserted independently of the empty one on purpose —
 * a fix built for "fill in the missing evidence" would pass every test in the
 * first describe block and leave the more misleading failure in place.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public. Commit shas here are made up and resolve to
 * nothing anywhere, which is itself part of the point.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transitionUnproven } from '@feedback/core';
import { projectTask } from '../src/task-projection.ts';
import { type TaskEvidence, TaskStore, type TaskStoreEvent } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

/** The sha an agent wrote from memory, and the one it meant. */
const WRONG_SHA = 'b2ba21e';
const RIGHT_SHA = '621f371';

describe('amendEvidence', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'evidence-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  /** A task already moved to done, with whatever evidence the caller managed
   *  to send (none, by default — the dropped-field case). */
  function closedTask(evidence?: { commit?: string }) {
    const ws = store.createWorkspace('ws');
    const created = store.createTask(ws.id, { title: 'ship the thing' });
    if (!created.ok) throw new Error('create failed');
    const moved = store.transition(created.task.id, 'done', {
      actor: AGENT,
      ...(evidence ? { evidence } : {}),
    });
    if (!moved.ok) throw new Error('transition failed');
    return { ws, task: created.task, unproven: moved.unproven };
  }

  describe('the dropped-field case: a finished task marked unproven forever', () => {
    it('reproduces the wall — the same transition cannot be re-sent with the evidence', () => {
      const { task, unproven } = closedTask();
      expect(unproven).toBe(true); // positive control: the mark is really there
      const retry = store.transition(task.id, 'done', {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
      });
      expect(retry.ok).toBe(false);
      if (!retry.ok) expect(retry.error).toBe('same-status');
    });

    it('names the way out in the refusal, so an agent is not stranded on it', () => {
      const { task } = closedTask();
      const retry = store.transition(task.id, 'done', {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
      });
      expect(retry.ok).toBe(false);
      if (!retry.ok) expect(retry.message ?? '').toContain('amend');
    });

    it('attaches the evidence after the fact, attributed and timestamped', () => {
      const { task } = closedTask();
      const before = Date.now();
      const res = store.amendEvidence(task.id, {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
        note: 'the field was dropped on my side',
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.amendment.evidence).toEqual({ commit: RIGHT_SHA });
      expect(res.amendment.by).toEqual({ id: AGENT.id, name: AGENT.name, kind: 'agent' });
      expect(res.amendment.note).toBe('the field was dropped on my side');
      expect(res.amendment.ts).toBeGreaterThanOrEqual(before);
    });

    it('appends — the original row still says it went in with no proof', () => {
      const { task } = closedTask();
      store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      const row = store.getTask(task.id)?.transitions.at(-1);
      expect(row?.evidence).toBeUndefined();
      expect(row?.amendments?.length).toBe(1);
      // …and nothing else about the row moved.
      expect(row?.to).toBe('done');
      expect(row?.by.name).toBe(AGENT.name);
    });

    it('clears the unproven shading', () => {
      const { task } = closedTask();
      const rowBefore = store.getTask(task.id)?.transitions.at(-1);
      expect(rowBefore && transitionUnproven(rowBefore)).toBe(true); // positive control
      store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      const rowAfter = store.getTask(task.id)?.transitions.at(-1);
      expect(rowAfter && transitionUnproven(rowAfter)).toBe(false);
    });
  });

  describe('the wrong-sha case: evidence that arrived and was false', () => {
    it('amends a transition that ALREADY carries evidence rather than refusing it', () => {
      const { task, unproven } = closedTask({ commit: WRONG_SHA });
      // Nothing here is unproven — which is the whole problem. A fix built
      // only for the empty case has no reason to accept this call at all.
      expect(unproven).toBe(false);
      const res = store.amendEvidence(task.id, {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
        note: 'wrote the sha from memory; it resolves to nothing',
      });
      expect(res.ok).toBe(true);
    });

    it('records what it supersedes, so the false sha is marked rather than erased', () => {
      const { task } = closedTask({ commit: WRONG_SHA });
      const res = store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.amendment.supersedes).toEqual({ commit: WRONG_SHA });
      const row = store.getTask(task.id)?.transitions.at(-1);
      // The original claim is still on the record — that is what append means.
      expect(row?.evidence).toEqual({ commit: WRONG_SHA });
      expect(row?.amendments?.[0]?.evidence).toEqual({ commit: RIGHT_SHA });
    });

    it('leaves `supersedes` off when there was nothing to supersede', () => {
      const { task } = closedTask();
      const res = store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      // Filling a gap and correcting a false claim are different facts, and a
      // reader of the trail has to be able to tell them apart.
      expect(res.amendment.supersedes).toBeUndefined();
    });
  });

  describe('an amendment can never make the record worse', () => {
    it('refuses evidence that claims nothing', () => {
      const { task } = closedTask({ commit: WRONG_SHA });
      const claimsNothing = [
        {},
        { commit: '' },
        { commit: '   ' },
        // A ref of no recognised shape is not a ref. Typed loosely on purpose
        // — the route takes this off the wire, where nothing type-checks it.
        { threadRef: { kind: 'bogus' } as unknown as TaskEvidence['threadRef'] },
      ];
      for (const evidence of claimsNothing) {
        const res = store.amendEvidence(task.id, { actor: AGENT, evidence });
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.error).toBe('empty-evidence');
      }
      // Nothing was appended by any of them: a refused amend is a no-op.
      expect(store.getTask(task.id)?.transitions.at(-1)?.amendments).toBeUndefined();
      // Positive control on the same task — the door is open for real evidence.
      expect(
        store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } }).ok,
      ).toBe(true);
    });

    it('stacks corrections in order instead of replacing them', () => {
      const { task } = closedTask({ commit: WRONG_SHA });
      store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: 'aaaaaaa' } });
      store.amendEvidence(task.id, { actor: PERSON, evidence: { commit: RIGHT_SHA } });
      const amendments = store.getTask(task.id)?.transitions.at(-1)?.amendments ?? [];
      expect(amendments.map((a) => a.evidence.commit)).toEqual(['aaaaaaa', RIGHT_SHA]);
      // The second correction supersedes the FIRST correction, not the row's
      // original claim — otherwise the trail would say the wrong sha was
      // still standing when it was not.
      expect(amendments[1]?.supersedes).toEqual({ commit: 'aaaaaaa' });
      expect(amendments[1]?.by.kind).toBe('person');
    });
  });

  describe('addressing a transition', () => {
    it('defaults to the most recent one — the move you just made', () => {
      const ws = store.createWorkspace('ws');
      const created = store.createTask(ws.id, { title: 'two moves' });
      if (!created.ok) throw new Error('create failed');
      store.transition(created.task.id, 'in-progress', { actor: AGENT });
      store.transition(created.task.id, 'done', { actor: AGENT });
      store.amendEvidence(created.task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      const rows = store.getTask(created.task.id)?.transitions ?? [];
      expect(rows[0]?.amendments).toBeUndefined();
      expect(rows[1]?.amendments?.length).toBe(1);
    });

    it('takes an explicit transitionTs for an earlier row', async () => {
      const ws = store.createWorkspace('ws');
      const created = store.createTask(ws.id, { title: 'two moves' });
      if (!created.ok) throw new Error('create failed');
      store.transition(created.task.id, 'in-progress', { actor: AGENT });
      // Two moves inside one millisecond share a ts, and ts is the address —
      // so this fixture has to construct rows that are actually addressable
      // before it can test addressing them. Asserted below, not assumed.
      await new Promise((r) => setTimeout(r, 2));
      store.transition(created.task.id, 'done', { actor: AGENT });
      const rowsBefore = store.getTask(created.task.id)?.transitions ?? [];
      expect(rowsBefore[0]?.ts).not.toBe(rowsBefore[1]?.ts);
      const first = rowsBefore[0];
      if (!first) throw new Error('no transition');
      const res = store.amendEvidence(created.task.id, {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
        transitionTs: first.ts,
      });
      expect(res.ok).toBe(true);
      const rows = store.getTask(created.task.id)?.transitions ?? [];
      expect(rows[0]?.amendments?.length).toBe(1);
      expect(rows[1]?.amendments).toBeUndefined();
    });

    it('refuses an unknown task, an unknown ts, and a task that never moved', () => {
      const ghost = store.amendEvidence('t-ghost', {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
      });
      expect(ghost.ok).toBe(false);
      if (!ghost.ok) expect(ghost.error).toBe('not-found');

      const ws = store.createWorkspace('ws');
      const fresh = store.createTask(ws.id, { title: 'never moved' });
      if (!fresh.ok) throw new Error('create failed');
      const none = store.amendEvidence(fresh.task.id, {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
      });
      expect(none.ok).toBe(false);
      if (!none.ok) expect(none.error).toBe('no-transitions');

      const { task } = closedTask();
      const wrongTs = store.amendEvidence(task.id, {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
        transitionTs: 1,
      });
      expect(wrongTs.ok).toBe(false);
      if (!wrongTs.ok) expect(wrongTs.error).toBe('transition-not-found');
    });
  });

  describe('the rest of the system can see it', () => {
    it('emits task.evidence_amended with the correction and what it replaced', () => {
      const events: TaskStoreEvent[] = [];
      const off = store.onEvent((e) => events.push(e));
      const { task, ws } = closedTask({ commit: WRONG_SHA });
      store.amendEvidence(task.id, {
        actor: AGENT,
        evidence: { commit: RIGHT_SHA },
        note: 'resolves to nothing',
      });
      off();
      const row = events.find((e) => e.type === 'task.evidence_amended');
      expect(row).toBeDefined();
      if (!row || row.type !== 'task.evidence_amended') return;
      expect(row.taskId).toBe(task.id);
      expect(row.workspaceId).toBe(ws.id);
      expect(row.evidence).toEqual({ commit: RIGHT_SHA });
      expect(row.supersedes).toEqual({ commit: WRONG_SHA });
      expect(row.note).toBe('resolves to nothing');
      expect(row.actor.kind).toBe('agent');
      // The amender appears ONCE, as `actor` — the single field visitor
      // redaction knows how to strip ids from. A nested copy (an `amendment`
      // object carrying its own `by`) would ride the SSE feed unredacted, so
      // count the id rather than merely finding it.
      expect(JSON.stringify(row).split(AGENT.id).length - 1).toBe(1);
    });

    it('survives a reload — the correction is on disk, not only in memory', async () => {
      const { task } = closedTask({ commit: WRONG_SHA });
      store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      await new Promise((r) => setTimeout(r, 60));
      store.stop();
      const reloaded = new TaskStore({ dataDir, debounceMs: 5 });
      const row = reloaded.getTask(task.id)?.transitions.at(-1);
      expect(row?.evidence).toEqual({ commit: WRONG_SHA });
      expect(row?.amendments?.[0]?.evidence).toEqual({ commit: RIGHT_SHA });
      reloaded.stop();
    });

    it('reaches the board projection with display-only actors', () => {
      const { task } = closedTask();
      store.amendEvidence(task.id, { actor: AGENT, evidence: { commit: RIGHT_SHA } });
      const stored = store.getTask(task.id);
      if (!stored) throw new Error('gone');
      // The projection deliberately does NOT return a `Task` — actors are
      // display-only — so it is typed here as what a board reader sees.
      const projected = projectTask(stored) as unknown as {
        transitions: {
          amendments?: { by: { name: string; kind: string }; evidence: TaskEvidence }[];
        }[];
      };
      const row = projected.transitions.at(-1);
      // The board renders from this and nothing else — a correction the
      // projection drops is a correction no reviewer can ever see.
      expect(row?.amendments?.[0]?.evidence).toEqual({ commit: RIGHT_SHA });
      expect(row?.amendments?.[0]?.by).toEqual({ name: AGENT.name, kind: 'agent' });
      expect(JSON.stringify(projected)).not.toContain(AGENT.id);
    });
  });
});
