/**
 * Where a goal row STARTS — the half of goal triage that is a default rather
 * than a gate.
 *
 * Two callers mint goal rows and they want opposite answers, so both are
 * pinned here:
 *
 *  - `setGoalList` mints `triage`. A goal somebody just added is a proposal;
 *    the band dispatches nothing until somebody agrees to it (Bryan,
 *    2026-08-25: "new goals start in triage").
 *  - the hydrate migration mints `todo`. Boards on disk that predate goal rows
 *    re-mint their whole list on the next read, and minting those `triage`
 *    would stop dispatch on every existing board at once.
 *
 * The second is the one worth a test you would not otherwise write: it is a
 * silent, fleet-wide regression that no unit test of `setGoalList` can see,
 * and its trigger is a deploy rather than a call.
 *
 * Nothing here uses `seedGoals` — that helper activates what it seeds, so it
 * is no witness to where a row started. These call the real paths.
 *
 * All fixtures are synthetic — invented names in the jordan@partner.example
 * register. The repo is public.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../src/tasks.ts';

const PERSON = { id: 'known-bryan', name: 'Bryan', kind: 'known' };
const AGENT = { id: 'agent-search-revamp', name: 'Search Revamp', kind: 'known' };

describe('where a goal row starts', () => {
  let dataDir: string;
  let store: TaskStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'goal-triage-default-'));
    store = new TaskStore({ dataDir, debounceMs: 5 });
  });

  afterEach(() => {
    store.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe('a goal somebody adds', () => {
    it('lands in triage, whoever adds it', () => {
      // Both actors, because the TASK default keys on person-vs-agent and
      // this one deliberately does not — a goal is a proposal either way.
      for (const actor of [PERSON, AGENT]) {
        const wsId = store.createWorkspace('board').id;
        const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor });
        expect(res.ok).toBe(true);
        if (!res.ok) return;
        const goalId = res.created[0]?.id as string;
        expect(store.getGoalRow(goalId)?.status).toBe('triage');
        // Started there — not moved there. An empty trail is what says so.
        expect(store.getGoalRow(goalId)?.transitions).toEqual([]);
      }
    });

    it('lands every band of a multi-goal list in triage', () => {
      const wsId = store.createWorkspace('board').id;
      const res = store.setGoalList(
        wsId,
        [{ title: 'Ship the ranker' }, { title: 'Index rebuild' }],
        { actor: PERSON },
      );
      if (!res.ok) throw new Error('goal list refused');
      // Both rows: one band that skipped the default would be a hole in the
      // same shape, and the mint runs per row rather than per call.
      expect(res.created.map((g) => store.getGoalRow(g.id)?.status)).toEqual(['triage', 'triage']);
    });

    it('leaves an EXISTING goal alone when the list is edited around it', () => {
      // The reconcile runs on every list write. A goal already agreed to must
      // not be sent back to triage because somebody added a sibling or
      // renamed a neighbour — that would make the band's status a function of
      // unrelated edits.
      const wsId = store.createWorkspace('board').id;
      const first = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: PERSON });
      if (!first.ok) throw new Error('goal list refused');
      const existing = first.created[0]?.id as string;
      expect(store.transition(existing, 'todo', { actor: PERSON }).ok).toBe(true);

      const second = store.setGoalList(
        wsId,
        [{ id: existing, title: 'Ship the ranker' }, { title: 'Fix the crawler' }] as Parameters<
          TaskStore['setGoalList']
        >[1],
        { actor: PERSON },
      );
      if (!second.ok) throw new Error(`goal list refused: ${second.error}`);
      expect(store.getGoalRow(existing)?.status).toBe('todo');
      // POSITIVE CONTROL: the row added in the SAME write did land in triage,
      // so "the existing one stayed todo" is not a mint that stopped firing.
      const added = second.created[0]?.id as string;
      expect(added).not.toBe(existing);
      expect(store.getGoalRow(added)?.status).toBe('triage');
    });

    it('survives a save/reload as triage', () => {
      // The status is minted in memory and written to the sidecar. If it did
      // not round-trip, a restart would quietly activate every pending band.
      const wsId = store.createWorkspace('board').id;
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: PERSON });
      if (!res.ok) throw new Error('goal list refused');
      const goalId = res.created[0]?.id as string;
      store.stop();

      const reopened = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        expect(reopened.getGoalRow(goalId)?.status).toBe('triage');
      } finally {
        reopened.stop();
      }
    });
  });

  describe('the hydrate migration, on a board that predates goal rows', () => {
    /**
     * Rewrite the sidecar the way a pre-goal-rows build left it: a goal LIST
     * on the workspace, and no `goalRows` array at all. That is the exact
     * on-disk shape the lazy migration exists for, and it is reachable no
     * other way — every in-process path mints rows as it goes.
     */
    function stripGoalRowsFromSidecar(): void {
      const files = readdirSync(dataDir, { recursive: true, encoding: 'utf8' }).filter((f) =>
        f.endsWith('.json'),
      );
      let rewritten = 0;
      for (const rel of files) {
        const path = join(dataDir, rel);
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
          workspace?: { goals?: unknown[] };
          goalRows?: unknown[];
        };
        if (!parsed.workspace?.goals?.length) continue;
        // Assigned rather than deleted: `JSON.stringify` drops an undefined
        // value, so the key is absent on disk either way.
        parsed.goalRows = undefined;
        writeFileSync(path, JSON.stringify(parsed));
        rewritten++;
      }
      // The probe has to be able to FIND the sidecar before its silence means
      // anything — a rename of the data layout would otherwise turn this
      // whole describe into a test that passes by reading nothing.
      if (rewritten !== 1) {
        throw new Error(`expected exactly one workspace sidecar with goals, rewrote ${rewritten}`);
      }
    }

    it('mints the existing bands ACTIVE, not triage', () => {
      const wsId = store.createWorkspace('board').id;
      const res = store.setGoalList(
        wsId,
        [{ title: 'Ship the ranker' }, { title: 'Fix the crawler' }],
        { actor: PERSON },
      );
      if (!res.ok) throw new Error('goal list refused');
      const ids = res.created.map((g) => g.id);
      store.stop();
      stripGoalRowsFromSidecar();

      const reopened = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        // Every band comes back workable. This is the fleet-wide regression
        // the mint parameter exists to prevent: had the migration inherited
        // the create default, one deploy would have halted dispatch on every
        // board that had ever declared a goal.
        expect(ids.map((id) => reopened.getGoalRow(id)?.status)).toEqual(['todo', 'todo']);
        // And they really were re-minted rather than read back — the strip
        // above is what this asserts, so a silently-failing strip cannot make
        // the test pass by leaving the original rows in place.
        expect(ids.map((id) => reopened.getGoalRow(id)?.transitions)).toEqual([[], []]);
      } finally {
        reopened.stop();
      }
    });

    it('still mints triage for a goal added AFTER the migration', () => {
      // POSITIVE CONTROL for the case above: the migration answers `todo`
      // without turning the create default off for the rest of the board's
      // life. Without this, a migration that hard-coded `todo` everywhere
      // would look identical.
      const wsId = store.createWorkspace('board').id;
      const res = store.setGoalList(wsId, [{ title: 'Ship the ranker' }], { actor: PERSON });
      if (!res.ok) throw new Error('goal list refused');
      store.stop();
      stripGoalRowsFromSidecar();

      const reopened = new TaskStore({ dataDir, debounceMs: 5 });
      try {
        const added = reopened.setGoalList(
          wsId,
          [
            { id: res.created[0]?.id as string, title: 'Ship the ranker' },
            { title: 'Fix the crawler' },
          ] as Parameters<TaskStore['setGoalList']>[1],
          { actor: PERSON },
        );
        if (!added.ok) throw new Error(`goal list refused: ${added.error}`);
        expect(reopened.getGoalRow(added.created[0]?.id as string)?.status).toBe('triage');
      } finally {
        reopened.stop();
      }
    });
  });
});
